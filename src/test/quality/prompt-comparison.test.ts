/**
 * Universal prompt comparison runner — A/B/N testing prompt variants against
 * the full scenario suite.
 *
 * Usage:
 *   # Compare two variants against all scenarios
 *   PROMPT_VARIANTS=current,prose-optimized npm run test:quality:compare
 *
 *   # Compare three variants, prose only
 *   PROMPT_VARIANTS=current,prose-optimized,minuet COMPARE_FILTER=prose npm run test:quality:compare
 *
 *   # Single variant (backward compatible with old PROMPT_VARIANT usage)
 *   PROMPT_VARIANT=prose-optimized npm run test:quality:compare
 *
 * Available variants: current, hole-filler, minimal-hole-filler,
 *   enhanced-hole-filler, minuet, prose-optimized, prose-v2
 *
 * Environment variables:
 *   PROMPT_VARIANTS   — Comma-separated list of variant IDs to compare
 *   PROMPT_VARIANT    — Single variant ID (backward compat, used if PROMPT_VARIANTS not set)
 *   COMPARE_FILTER    — Filter scenarios by mode: 'prose', 'code', or 'all' (default: 'all')
 *   TEST_MODEL        — Override the Claude Code model (e.g., TEST_MODEL=sonnet)
 *
 * Results are saved to test-results/compare-{timestamp}/{variant-id}/{scenario-id}/
 * with the same per-scenario structure as the standard quality tests, so Layer 2
 * evaluation works the same way.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionContext, ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { postProcessCompletion } from '../../utils/post-process';
import { truncatePrefix, truncateSuffix } from '../../utils/truncation';
import { SlotPool } from '../../providers/slot-pool';
import { makeConfig, makeCapturingLogger, getTestModel } from '../helpers';
import { TestScenario } from './judge';
import { proseScenarios, codeScenarios, edgeCaseScenarios } from './scenarios';
import { regressionScenarios } from './regression-scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
} from './scenarios/index';
import { getVariant, getAllVariantIds, PromptVariant } from './prompt-variants';

// ─── Scenario collection (shared with main runner) ──────────────────

const ALL_SCENARIOS: TestScenario[] = [
  ...proseScenarios,
  ...codeScenarios,
  ...edgeCaseScenarios,
  ...regressionScenarios,
  ...proseMidDocumentScenarios,
  ...proseJournalScenarios,
  ...proseBridgingScenarios,
  ...codeMidFileScenarios,
  ...prosePromptWritingScenarios,
  ...proseFullWindowScenarios,
  ...codeFullWindowScenarios,
];

// ─── Variant parsing ────────────────────────────────────────────────

const variantIds = (process.env.PROMPT_VARIANTS ?? process.env.PROMPT_VARIANT ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (variantIds.length === 0) {
  console.log('\n' + '='.repeat(70));
  console.log('  No variants specified. Set PROMPT_VARIANTS or PROMPT_VARIANT.');
  console.log('  Available variants: ' + getAllVariantIds().join(', '));
  console.log('\n  Examples:');
  console.log('    PROMPT_VARIANTS=current,prose-optimized npm run test:quality:compare');
  console.log('    PROMPT_VARIANT=current npm run test:quality:compare');
  console.log(
    '    PROMPT_VARIANTS=current,minuet COMPARE_FILTER=prose npm run test:quality:compare',
  );
  console.log('='.repeat(70) + '\n');
}

// Resolve variants, report unknown ones
const variants: PromptVariant[] = [];
const unknownIds: string[] = [];
for (const id of variantIds) {
  const v = getVariant(id);
  if (v) {
    variants.push(v);
  } else {
    unknownIds.push(id);
  }
}

if (unknownIds.length > 0) {
  console.log(
    `\n  Unknown variant(s): ${unknownIds.join(', ')}. Available: ${getAllVariantIds().join(', ')}\n`,
  );
}

const canSelectVariants = variants.length > 0;

// ─── Scenario filtering ─────────────────────────────────────────────

const filter = (process.env.COMPARE_FILTER ?? 'all').toLowerCase();
const scenarios = filter === 'all' ? ALL_SCENARIOS : ALL_SCENARIOS.filter((s) => s.mode === filter);

// ─── Backend availability ───────────────────────────────────────────

let canRun = false;

try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  canRun = typeof queryFn === 'function';
} catch {
  canRun = false;
}

// ─── Config helper ──────────────────────────────────────────────────

function makeCompletionConfig() {
  const config = makeConfig();
  config.claudeCode.model = getTestModel();
  return config;
}

function getModelName(): string {
  return `claude-code/${makeCompletionConfig().claudeCode.model}`;
}

// ─── Variant-aware provider ─────────────────────────────────────────

/**
 * A SlotPool subclass that uses a PromptVariant for its system prompt,
 * message building, and response extraction.
 */
class VariantProvider extends SlotPool {
  private config: ExtensionConfig;
  private variant: PromptVariant;
  lastSentMessage?: string;

  constructor(config: ExtensionConfig, logger: Logger, variant: PromptVariant) {
    super(logger, 1);
    this.config = config;
    this.variant = variant;
  }

  async activate(cwd?: string): Promise<void> {
    await this.loadSdk();
    if (!this.sdkAvailable) return;
    await this.initAllSlots();
  }

  async getCompletion(context: CompletionContext, _signal: AbortSignal): Promise<string | null> {
    if (!this.queryFn) return null;

    const slotIndex = await this.acquireSlot();
    if (slotIndex === null) return null;

    const slot = this.slots[slotIndex];
    const message = this.variant.buildMessage(
      context.prefix,
      context.suffix,
      context.mode,
      context.languageId,
    );
    this.lastSentMessage = message;

    if (!slot.channel || !slot.resultPromise) return null;
    slot.channel.push(message);

    const raw = await slot.resultPromise;
    this.logger.traceBlock('← raw', raw ?? '(null)');
    if (!raw) return null;

    // Use the variant's extraction logic
    const extracted = this.variant.extractCompletion(raw, context.prefix, context.suffix);
    if (!extracted) return null;

    // Apply shared post-processing (suffix overlap, etc.)
    return postProcessCompletion(extracted, undefined, context.suffix);
  }

  // --- SlotPool abstract methods ---

  protected getSystemPrompt(): string {
    return this.variant.systemPrompt;
  }

  protected getModel(): string {
    return this.config.claudeCode.model;
  }

  protected getMaxReuses(): number {
    return 8;
  }

  protected getPoolLabel(): string {
    return `Variant[${this.variant.id}]`;
  }

  protected buildWarmupMessage(): string {
    return this.variant.buildWarmupMessage();
  }

  protected validateWarmupResponse(raw: string): boolean {
    return this.variant.validateWarmup(raw);
  }
}

// ─── Truncation (reuse production infrastructure) ───────────────────

function truncateScenario(scenario: TestScenario): {
  prefix: string;
  suffix: string;
  prefixChars: number;
  suffixChars: number;
} {
  const config = makeCompletionConfig();
  const prefixChars =
    scenario.contextWindow?.prefixChars ??
    (scenario.mode === 'code' ? config.code.contextChars : config.prose.contextChars);
  const suffixChars =
    scenario.contextWindow?.suffixChars ??
    (scenario.mode === 'code' ? config.code.suffixChars : config.prose.suffixChars);
  return {
    prefix: truncatePrefix(scenario.prefix, prefixChars),
    suffix: truncateSuffix(scenario.suffix, suffixChars),
    prefixChars,
    suffixChars,
  };
}

// ─── Output management ──────────────────────────────────────────────

const RESULTS_DIR = path.join(__dirname, '..', '..', '..', 'test-results');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = path.join(RESULTS_DIR, `compare-${timestamp}`);

interface ComparisonResult {
  scenario: TestScenario;
  variantId: string;
  completion: string | null;
  rawResponse?: string;
  sentMessage?: string;
  durationMs: number;
  error?: string;
}

// Per-variant results for summary
const variantResults: Record<string, ComparisonResult[]> = {};

function saveResult(result: ComparisonResult, variant: PromptVariant): void {
  const scenarioDir = path.join(RUN_DIR, result.variantId, result.scenario.id);
  fs.mkdirSync(scenarioDir, { recursive: true });

  const truncated = truncateScenario(result.scenario);
  fs.writeFileSync(
    path.join(scenarioDir, 'input.json'),
    JSON.stringify(
      {
        mode: result.scenario.mode,
        languageId: result.scenario.languageId,
        fileName: result.scenario.fileName,
        prefix: truncated.prefix,
        suffix: truncated.suffix,
        rawPrefixLen: result.scenario.prefix.length,
        rawSuffixLen: result.scenario.suffix.length,
        truncatedPrefixLen: truncated.prefix.length,
        truncatedSuffixLen: truncated.suffix.length,
        prefixChars: truncated.prefixChars,
        suffixChars: truncated.suffixChars,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(scenarioDir, 'requirements.json'),
    JSON.stringify(result.scenario.requirements, null, 2),
  );

  fs.writeFileSync(
    path.join(scenarioDir, 'completion.txt'),
    result.completion ?? '(null — provider returned no completion)',
  );

  if (result.rawResponse !== undefined) {
    fs.writeFileSync(path.join(scenarioDir, 'raw-response.txt'), result.rawResponse);
  }

  if (result.sentMessage !== undefined) {
    fs.writeFileSync(path.join(scenarioDir, 'sent-message.txt'), result.sentMessage);
  }

  fs.writeFileSync(
    path.join(scenarioDir, 'metadata.json'),
    JSON.stringify(
      {
        id: result.scenario.id,
        description: result.scenario.description,
        durationMs: result.durationMs,
        completionLength: result.completion?.length ?? 0,
        error: result.error ?? null,
        generatedAt: new Date().toISOString(),
        variant: result.variantId,
        variantName: variant.name,
        model: getModelName(),
      },
      null,
      2,
    ),
  );
}

// ─── Per-scenario generation ────────────────────────────────────────

async function generateWithVariant(
  scenario: TestScenario,
  variant: PromptVariant,
): Promise<ComparisonResult> {
  const config = makeCompletionConfig();
  const capturing = makeCapturingLogger();
  const provider = new VariantProvider(config, capturing.logger, variant);
  const cwd = path.resolve(__dirname, '..', '..', '..');

  const truncated = truncateScenario(scenario);
  const ctx: CompletionContext = {
    prefix: truncated.prefix,
    suffix: truncated.suffix,
    languageId: scenario.languageId,
    fileName: scenario.fileName,
    filePath: `/${scenario.fileName}`,
    mode: scenario.mode,
  };

  const start = Date.now();
  try {
    await provider.activate(cwd);
    const ac = new AbortController();
    const completion = await provider.getCompletion(ctx, ac.signal);
    const result: ComparisonResult = {
      scenario,
      variantId: variant.id,
      completion,
      rawResponse: capturing.getTrace('← raw') ?? capturing.getTrace('warmup ← recv (slot 0)'),
      sentMessage: provider.lastSentMessage,
      durationMs: Date.now() - start,
    };
    saveResult(result, variant);
    return result;
  } catch (err) {
    const result: ComparisonResult = {
      scenario,
      variantId: variant.id,
      completion: null,
      sentMessage: provider.lastSentMessage,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
    saveResult(result, variant);
    return result;
  } finally {
    provider.dispose();
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

const shouldSkip = !canRun || !canSelectVariants;

describe.skipIf(shouldSkip)(
  `Prompt Comparison — ${variants.map((v) => v.id).join(' vs ') || 'no variants'} [${filter}]`,
  () => {
    fs.mkdirSync(RUN_DIR, { recursive: true });

    // Initialize per-variant result buckets
    for (const v of variants) {
      variantResults[v.id] = [];
    }

    afterAll(() => {
      const totalResults = Object.values(variantResults).flat();
      if (totalResults.length === 0) return;

      // Build per-variant summaries
      const variantSummaries: Record<
        string,
        { generated: number; nulls: number; errors: number; totalMs: number }
      > = {};
      for (const v of variants) {
        const vResults = variantResults[v.id];
        variantSummaries[v.id] = {
          generated: vResults.filter((r) => r.completion !== null).length,
          nulls: vResults.filter((r) => r.completion === null).length,
          errors: vResults.filter((r) => r.error !== undefined).length,
          totalMs: vResults.reduce((sum, r) => sum + r.durationMs, 0),
        };
      }

      const summary = {
        timestamp,
        model: getModelName(),
        filter,
        totalScenarios: scenarios.length,
        variants: variantSummaries,
        scenarios: scenarios.map((s) => {
          const perVariant: Record<string, { hasCompletion: boolean; durationMs: number }> = {};
          for (const v of variants) {
            const result = variantResults[v.id].find((r) => r.scenario.id === s.id);
            if (result) {
              perVariant[v.id] = {
                hasCompletion: result.completion !== null,
                durationMs: result.durationMs,
              };
            }
          }
          return { id: s.id, mode: s.mode, variants: perVariant };
        }),
      };
      fs.writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

      // Create symlinks for easy access
      const latestPath = path.join(RESULTS_DIR, 'latest-compare');
      try {
        fs.unlinkSync(latestPath);
      } catch {
        /* */
      }
      try {
        fs.symlinkSync(path.basename(RUN_DIR), latestPath);
      } catch {
        /* */
      }

      // Print comparison stats
      console.log('\n' + '='.repeat(70));
      console.log('  PROMPT COMPARISON COMPLETE');
      console.log('='.repeat(70));
      console.log(`\n  Model:     ${getModelName()}`);
      console.log(`  Filter:    ${filter}`);
      console.log(`  Scenarios: ${scenarios.length}`);
      console.log(`  Output:    ${RUN_DIR}`);
      console.log('');

      // Side-by-side variant stats
      const idWidth = Math.max(...variants.map((v) => v.id.length), 7);
      console.log(`  ${'Variant'.padEnd(idWidth)}  Generated  Nulls  Errors  Duration`);
      console.log(`  ${'─'.repeat(idWidth)}  ─────────  ─────  ──────  ────────`);
      for (const v of variants) {
        const s = variantSummaries[v.id];
        const genStr = `${s.generated}/${scenarios.length}`.padEnd(9);
        const nullStr = String(s.nulls).padEnd(5);
        const errStr = String(s.errors).padEnd(6);
        const durStr = `${(s.totalMs / 1000).toFixed(1)}s`;
        console.log(`  ${v.id.padEnd(idWidth)}  ${genStr}  ${nullStr}  ${errStr}  ${durStr}`);
      }

      console.log('\n  To evaluate, use Layer 2 validation on each variant subdirectory.');
      console.log('='.repeat(70) + '\n');
    });

    // One describe block per variant, running all scenarios concurrently within
    for (const variant of variants) {
      describe(`Variant: ${variant.id} (${variant.name})`, () => {
        it.concurrent.each(scenarios.map((s) => [s.id, s] as const))(
          '%s',
          async (_id, scenario) => {
            const result = await generateWithVariant(scenario, variant);
            variantResults[variant.id].push(result);
            expect(result.error).toBeUndefined();
          },
        );
      });
    }
  },
);
