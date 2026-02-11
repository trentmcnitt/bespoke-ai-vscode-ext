/**
 * Prompt comparison test runner — tests different prompt variants against
 * the same scenarios to compare completion quality.
 *
 * Usage:
 *   PROMPT_VARIANT=hole-filler npm run test:quality:compare
 *   PROMPT_VARIANT=current npm run test:quality:compare     # baseline
 *
 * Available variants: current, hole-filler, minimal-hole-filler,
 *   enhanced-hole-filler, minuet, prose-optimized
 *
 * Results are saved to test-results/compare-{variant}-{timestamp}/
 * with the same structure as the standard quality tests, so Layer 2
 * evaluation works the same way.
 *
 * Focuses on prose scenarios (our 70-80% use case) plus prose-related
 * edge cases and regressions.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionContext, ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { postProcessCompletion } from '../../utils/post-process';
import { SlotPool } from '../../providers/slot-pool';
import { makeConfig, makeCapturingLogger, getTestModel } from '../helpers';
import { TestScenario } from './judge';
import { proseScenarios, edgeCaseScenarios } from './scenarios';
import { regressionScenarios } from './regression-scenarios';
import { getVariant, getAllVariantIds, PromptVariant } from './prompt-variants';

// ─── Variant selection ───────────────────────────────────────────

const variantId = process.env.PROMPT_VARIANT;
if (!variantId) {
  console.log('\n' + '='.repeat(70));
  console.log('  PROMPT_VARIANT not set. Available variants:');
  console.log('  ' + getAllVariantIds().join(', '));
  console.log('  Example: PROMPT_VARIANT=hole-filler npm run test:quality:compare');
  console.log('='.repeat(70) + '\n');
}

const variant = variantId ? getVariant(variantId) : undefined;
const canSelectVariant = !!variant;
const variantSkipReason = !variantId
  ? 'PROMPT_VARIANT env var not set'
  : `Unknown variant "${variantId}". Available: ${getAllVariantIds().join(', ')}`;

// ─── Backend availability ────────────────────────────────────────

let canRun = false;
let skipReason = '';

try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  canRun = typeof queryFn === 'function';
  if (!canRun) {
    skipReason = 'Agent SDK does not export query()';
  }
} catch {
  canRun = false;
  skipReason = 'Agent SDK not available';
}

// ─── Variant-aware provider ──────────────────────────────────────

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

// ─── Scenario selection (prose-focused) ──────────────────────────

const proseEdgeCases = edgeCaseScenarios.filter((s) => s.mode === 'prose');
const proseRegressions = regressionScenarios.filter((s) => s.mode === 'prose');
const allProseScenarios = [...proseScenarios, ...proseEdgeCases, ...proseRegressions];

// ─── Output management ──────────────────────────────────────────

const RESULTS_DIR = path.join(__dirname, '..', '..', '..', 'test-results');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = path.join(RESULTS_DIR, `compare-${variantId ?? 'unknown'}-${timestamp}`);

interface ComparisonResult {
  scenario: TestScenario;
  completion: string | null;
  rawResponse?: string;
  sentMessage?: string;
  durationMs: number;
  error?: string;
}

const results: ComparisonResult[] = [];

function saveResult(result: ComparisonResult): void {
  const scenarioDir = path.join(RUN_DIR, result.scenario.id);
  fs.mkdirSync(scenarioDir, { recursive: true });

  fs.writeFileSync(
    path.join(scenarioDir, 'input.json'),
    JSON.stringify(
      {
        mode: result.scenario.mode,
        languageId: result.scenario.languageId,
        fileName: result.scenario.fileName,
        prefix: result.scenario.prefix,
        suffix: result.scenario.suffix,
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
        variant: variantId,
        variantName: variant?.name,
        model: `claude-code/${getTestModel()}`,
      },
      null,
      2,
    ),
  );
}

// ─── Per-scenario generation ─────────────────────────────────────

async function generateWithVariant(scenario: TestScenario): Promise<ComparisonResult> {
  const config = makeConfig();
  config.claudeCode.model = getTestModel();
  const capturing = makeCapturingLogger();
  const provider = new VariantProvider(config, capturing.logger, variant!);
  const cwd = path.resolve(__dirname, '..', '..', '..');

  const ctx: CompletionContext = {
    prefix: scenario.prefix,
    suffix: scenario.suffix,
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
      completion,
      rawResponse: capturing.getTrace('← raw') ?? capturing.getTrace('warmup ← recv (slot 0)'),
      sentMessage: provider.lastSentMessage,
      durationMs: Date.now() - start,
    };
    saveResult(result);
    return result;
  } catch (err) {
    const result: ComparisonResult = {
      scenario,
      completion: null,
      sentMessage: provider.lastSentMessage,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
    saveResult(result);
    return result;
  } finally {
    provider.dispose();
  }
}

// ─── Tests ───────────────────────────────────────────────────────

const shouldSkip = !canRun || !canSelectVariant;
const fullSkipReason = !canRun ? skipReason : variantSkipReason;

describe.skipIf(shouldSkip)(
  `Prompt Comparison — ${variantId ?? 'no variant'} [prose-focused]`,
  () => {
    fs.mkdirSync(RUN_DIR, { recursive: true });

    afterAll(() => {
      if (results.length === 0) return;

      const generated = results.filter((r) => r.completion !== null).length;
      const nulls = results.filter((r) => r.completion === null).length;
      const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

      const summary = {
        timestamp,
        variant: variantId,
        variantName: variant?.name,
        variantSource: variant?.source,
        model: `claude-code/${getTestModel()}`,
        totalScenarios: results.length,
        generated,
        nullResults: nulls,
        totalDurationMs: totalMs,
        scenarios: results.map((r) => ({
          id: r.scenario.id,
          mode: r.scenario.mode,
          hasCompletion: r.completion !== null,
          completionLength: r.completion?.length ?? 0,
          durationMs: r.durationMs,
          error: r.error ?? null,
        })),
      };
      fs.writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

      // Symlink for easy access
      const latestPath = path.join(RESULTS_DIR, `latest-compare-${variantId}`);
      try {
        fs.unlinkSync(latestPath);
      } catch {
        /* */
      }
      try {
        fs.symlinkSync(RUN_DIR, latestPath);
      } catch {
        /* */
      }

      console.log('\n' + '='.repeat(70));
      console.log(`  PROMPT COMPARISON — ${variant?.name}`);
      console.log('='.repeat(70));
      console.log(`\n  Variant:   ${variantId} (${variant?.name})`);
      console.log(`  Source:    ${variant?.source}`);
      console.log(`  Model:     claude-code/${getTestModel()}`);
      console.log(`  Generated: ${generated}/${results.length} (${nulls} null)`);
      console.log(`  Duration:  ${(totalMs / 1000).toFixed(1)}s total`);
      console.log(`  Output:    ${RUN_DIR}`);
      console.log('\n  To evaluate, use Layer 2 validation on the output directory.');
      console.log('='.repeat(70) + '\n');
    });

    describe('prose scenarios', () => {
      it.concurrent.each(allProseScenarios.map((s) => [s.id, s] as const))(
        '%s',
        async (_id, scenario) => {
          const result = await generateWithVariant(scenario);
          results.push(result);
          expect(result.error).toBeUndefined();
        },
      );
    });
  },
);
