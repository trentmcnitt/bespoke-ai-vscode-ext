/**
 * Completion quality test runner — GENERATION ONLY.
 *
 * This generates completions for each scenario and saves them to disk.
 * It does NOT judge quality — that's done by Claude in-session after
 * the tests finish, using the validator prompt and saved outputs.
 *
 * Run: npm run test:quality
 *
 * After generation completes, the afterAll hook prints instructions
 * for Claude to begin Layer 2 (semantic quality) validation.
 *
 * Backend selection:
 *   TEST_BACKEND=api                       — use API backend (default: claude-code)
 *   TEST_API_PRESET=xai-grok-code          — API preset (default: anthropic-haiku)
 *
 * Model override (Claude Code backend only):
 *   TEST_MODEL=sonnet           — override model (preferred)
 *   QUALITY_TEST_MODEL=sonnet   — backward-compatible alias
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CompletionContext } from '../../types';
import { truncatePrefix, truncateSuffix } from '../../utils/truncation';
import {
  makeConfig,
  makeCapturingLogger,
  getTestModel,
  assertModelMatch,
  getTestBackendConfig,
  createTestProvider,
} from '../helpers';
import { TestScenario } from './judge';
import { CheckResult, summarizeChecks } from './deterministic-checks';
import {
  RunOutcome,
  attributeResult,
  attributeThrown,
  collectProvenance,
  detailSummary,
  writeCheckArtifacts,
} from './run-artifacts';
import { GenerationDetail, detailFromError } from '../../utils/trace';
import {
  proseScenarios,
  codeScenarios,
  edgeCaseScenarios,
  reusePrimingContexts,
  reuseQualityScenarios,
} from './scenarios';
import { regressionScenarios } from './regression-scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
  customInstructionScenarios,
} from './scenarios/index';

// ─── Backend selection ───────────────────────────────────────────────

const { backend, preset: apiPreset } = getTestBackendConfig();

let canRun = false;
let skipReason = '';

if (backend === 'api') {
  const info = await createTestProvider();
  if (info) {
    canRun = true;
    info.dispose();
  } else {
    skipReason = `API preset "${apiPreset}" not available (missing API key?)`;
  }
} else {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryFn = sdk.query ?? sdk.default?.query;
    canRun = typeof queryFn === 'function';
    if (!canRun) {
      skipReason = 'Agent SDK does not export query()';
    }
  } catch {
    canRun = false;
    skipReason = 'Agent SDK not available (npm install @anthropic-ai/claude-agent-sdk)';
  }
}

function makeCompletionConfig() {
  const config = makeConfig();
  if (backend === 'api') {
    config.backend = 'api';
    config.api = { preset: apiPreset, customPresets: [] };
  } else {
    config.claudeCode.model = getTestModel();
  }
  return config;
}

function getBackendLabel(): string {
  if (backend === 'api') return `api/${apiPreset}`;
  return `claude-code/${getTestModel()}`;
}

// ─── Output management ──────────────────────────────────────────────

const RESULTS_DIR = path.join(__dirname, '..', '..', '..', 'test-results');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backendSlug = getBackendLabel().replace(/\//g, '-');
const RUN_DIR = path.join(RESULTS_DIR, `quality-${timestamp}-${backendSlug}`);

interface GenerationResult {
  scenario: TestScenario;
  completion: string | null;
  rawResponse?: string;
  sentMessage?: string;
  durationMs: number;
  /**
   * Set when the provider threw, OR when it returned null because it swallowed
   * a failure (HTTP 429/529, timeout/abort, open breaker). A swallowed failure is
   * not a model output, so it must not be scored as an empty completion.
   */
  error?: string;
  /** Same classes as the trace outcome: ok / empty (model gave nothing usable) / error / aborted. */
  outcome: RunOutcome;
  /** Low-cardinality failure class (`429`, `529`, `circuit_open`, thrown error name). */
  errorType?: string;
  /** Model-side detail from the provider (tokens, finish reason). */
  detail?: GenerationDetail;
  /** Strategy extraction result, before post-processing (API backend). */
  extracted?: string | null;
  /** Deterministic Layer 1 checks (filled in by saveScenarioOutput). */
  checks?: CheckResult[];
}

const results: GenerationResult[] = [];

function saveScenarioOutput(result: GenerationResult): void {
  const scenarioDir = path.join(RUN_DIR, result.scenario.id);
  fs.mkdirSync(scenarioDir, { recursive: true });

  // Save the input context with raw and truncated sizes
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
        // Surfaced to Layer 2 so the judge knows what steer was applied.
        customInstructions: result.scenario.customInstructions ?? null,
      },
      null,
      2,
    ),
  );

  // Save requirements
  fs.writeFileSync(
    path.join(scenarioDir, 'requirements.json'),
    JSON.stringify(result.scenario.requirements, null, 2),
  );

  // Save completion output
  fs.writeFileSync(
    path.join(scenarioDir, 'completion.txt'),
    result.completion ?? '(null — provider returned no completion)',
  );

  // Save raw model output (before post-processing) when available
  if (result.rawResponse !== undefined) {
    fs.writeFileSync(path.join(scenarioDir, 'raw-response.txt'), result.rawResponse);
  }

  // Save the actual message sent to Claude Code
  if (result.sentMessage !== undefined) {
    fs.writeFileSync(path.join(scenarioDir, 'sent-message.txt'), result.sentMessage);
  }

  // Deterministic checks + the rendered join the Layer 2 judge reads.
  // Run on the truncated context — exactly what the model saw.
  result.checks = writeCheckArtifacts(scenarioDir, {
    mode: result.scenario.mode,
    prefix: truncated.prefix,
    suffix: truncated.suffix,
    completion: result.completion,
    rawResponse: result.rawResponse,
    providerError: result.error !== undefined,
    scenario: result.scenario,
  });

  // Save metadata
  fs.writeFileSync(
    path.join(scenarioDir, 'metadata.json'),
    JSON.stringify(
      {
        id: result.scenario.id,
        description: result.scenario.description,
        durationMs: result.durationMs,
        completionLength: result.completion?.length ?? 0,
        error: result.error ?? null,
        outcome: result.outcome,
        errorType: result.errorType ?? null,
        provider: detailSummary(result.detail),
        // Extraction result before post-processing; distinguishes "model echoed
        // the suffix and post-processing trimmed it all" from "nothing extracted".
        ...(result.extracted !== undefined ? { extracted: result.extracted } : {}),
        generatedAt: new Date().toISOString(),
        backend,
        preset: backend === 'api' ? apiPreset : null,
        model: getBackendLabel(),
      },
      null,
      2,
    ),
  );
}

// ─── Per-scenario isolated provider ─────────────────────────────────

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

async function generateWithFreshProvider(scenario: TestScenario): Promise<GenerationResult> {
  const { ClaudeCodeProvider } = await import('../../providers/claude-code');
  const config = makeCompletionConfig();
  config.customInstructions = scenario.customInstructions ?? '';
  const capturing = makeCapturingLogger();
  const cc = new ClaudeCodeProvider(config, capturing.logger, 1);
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
    await cc.activate(cwd);
    const ac = new AbortController();
    const res = await cc.getCompletionWithDetail(ctx, ac.signal);
    assertModelMatch(cc);
    const result: GenerationResult = {
      scenario,
      completion: res.text,
      rawResponse: capturing.getTrace('← raw'),
      sentMessage: capturing.getTrace('→ sent'),
      durationMs: Date.now() - start,
      detail: res.detail,
      ...attributeResult(res),
    };
    saveScenarioOutput(result);
    return result;
  } catch (err) {
    const result: GenerationResult = {
      scenario,
      completion: null,
      sentMessage: capturing.getTrace('→ sent'),
      durationMs: Date.now() - start,
      detail: detailFromError(err),
      ...attributeThrown(err),
    };
    saveScenarioOutput(result);
    return result;
  } finally {
    cc.dispose();
  }
}

async function generateWithFreshApiProvider(scenario: TestScenario): Promise<GenerationResult> {
  const { clearApiKeyCache } = await import('../../utils/api-key-store');
  const { ApiCompletionProvider } = await import('../../providers/api/api-provider');
  clearApiKeyCache();

  const capturing = makeCapturingLogger();
  const config = makeCompletionConfig();
  config.customInstructions = scenario.customInstructions ?? '';
  const provider = new ApiCompletionProvider(config, capturing.logger);

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
    const res = await provider.getCompletionWithDetail(ctx, AbortSignal.timeout(30_000), {
      captureContent: true,
    });
    const content = res.detail?.content;
    const result: GenerationResult = {
      scenario,
      completion: res.text,
      // From the detail rather than the log: the log line is only written for a
      // non-empty reply, so an empty reply used to leave no raw-response.txt.
      // null here means the adapter returned no text at all (see outcome).
      rawResponse: content?.rawOutput ?? undefined,
      sentMessage: content?.userMessage ?? capturing.getTrace('api → user'),
      durationMs: Date.now() - start,
      detail: res.detail,
      ...(content && 'extracted' in content ? { extracted: content.extracted ?? null } : {}),
      ...attributeResult(res),
    };
    saveScenarioOutput(result);
    return result;
  } catch (err) {
    const result: GenerationResult = {
      scenario,
      completion: null,
      sentMessage: capturing.getTrace('api → user'),
      durationMs: Date.now() - start,
      detail: detailFromError(err),
      ...attributeThrown(err),
    };
    saveScenarioOutput(result);
    return result;
  } finally {
    provider.dispose();
  }
}

function generateScenario(scenario: TestScenario): Promise<GenerationResult> {
  return backend === 'api'
    ? generateWithFreshApiProvider(scenario)
    : generateWithFreshProvider(scenario);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe.skipIf(!canRun)(`Completion Quality — Generation [${getBackendLabel()}]`, () => {
  // Ensure output directory exists before any concurrent test writes
  fs.mkdirSync(RUN_DIR, { recursive: true });

  afterAll(() => {
    if (results.length === 0) return;

    // Write summary
    const generated = results.filter((r) => r.completion !== null).length;
    const nulls = results.filter((r) => r.completion === null).length;
    // Why each null happened: `empty` is a model result; `error` / `aborted`
    // are failures the provider swallowed or threw — not measurements.
    const nullsByOutcome: Record<string, number> = {};
    const nullsByErrorType: Record<string, number> = {};
    for (const r of results) {
      if (r.completion !== null) continue;
      nullsByOutcome[r.outcome] = (nullsByOutcome[r.outcome] ?? 0) + 1;
      if (r.errorType) nullsByErrorType[r.errorType] = (nullsByErrorType[r.errorType] ?? 0) + 1;
    }
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    const checkCounts = summarizeChecks(results.map((r) => r.checks ?? []));
    const detFailed = results.filter((r) => (r.checks ?? []).some((c) => !c.pass)).length;

    const summary = {
      timestamp,
      backend,
      preset: backend === 'api' ? apiPreset : null,
      model: getBackendLabel(),
      provenance: collectProvenance({
        repoRoot: path.resolve(__dirname, '..', '..', '..'),
        backend,
        model: getBackendLabel(),
        preset: backend === 'api' ? apiPreset : null,
      }),
      // Layer 2 MUST set this to the judge's model id (see validator-prompt.md).
      judge: null as string | null,
      totalScenarios: results.length,
      generated,
      nullResults: nulls,
      nullsByOutcome,
      nullsByErrorType,
      totalDurationMs: totalMs,
      // Per check: how many scenarios it applied to, and how many failed.
      deterministicChecks: checkCounts,
      deterministicFailedScenarios: detFailed,
      scenarios: results.map((r) => ({
        id: r.scenario.id,
        mode: r.scenario.mode,
        hasCompletion: r.completion !== null,
        completionLength: r.completion?.length ?? 0,
        durationMs: r.durationMs,
        error: r.error ?? null,
        outcome: r.outcome,
        errorType: r.errorType ?? null,
        finishReason: r.detail?.finishReason ?? null,
        outputTokens: r.detail?.outputTokens ?? null,
        checksFailed: (r.checks ?? []).filter((c) => !c.pass).map((c) => c.id),
      })),
    };
    fs.writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

    // Create a 'latest' symlink
    const latestPath = path.join(RESULTS_DIR, 'latest');
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

    // ════════════════════════════════════════════════════════════════
    // LAYER 2 INSTRUCTIONS — Claude reads this in the session
    // ════════════════════════════════════════════════════════════════
    console.log('\n' + '='.repeat(70));
    console.log('  LAYER 1 COMPLETE — LAYER 2 VALIDATION REQUIRED');
    console.log('='.repeat(70));
    console.log(`\n  Backend:   ${backend}`);
    if (backend === 'api') console.log(`  Preset:    ${apiPreset}`);
    console.log(`  Model:     ${getBackendLabel()}`);
    console.log(`  Generated: ${generated}/${results.length} completions (${nulls} null)`);
    if (nulls > 0) {
      const byOutcome = Object.entries(nullsByOutcome).map(([k, v]) => `${k} ${v}`);
      const byType = Object.entries(nullsByErrorType).map(([k, v]) => `${k} ${v}`);
      console.log(
        `  Nulls by outcome: ${byOutcome.join(', ')}` +
          (byType.length ? ` — error types: ${byType.join(', ')}` : ''),
      );
    }
    console.log(`  Duration:  ${(totalMs / 1000).toFixed(1)}s total`);
    console.log(`  Det. checks: ${detFailed}/${results.length} scenarios failed at least one`);
    for (const [id, c] of Object.entries(checkCounts)) {
      if (c.applied > 0) console.log(`    ${id.padEnd(22)} ${c.failed}/${c.applied} failed`);
    }
    console.log(`  Output:    ${RUN_DIR}`);
    console.log('\n  Layer 1 (generation + structural checks) is just a sanity check.');
    console.log('  Layer 2 is the ACTUAL quality test.\n');
    console.log('  PROCEED WITH LAYER 2 VALIDATION:');
    console.log('  1. Read the validator prompt: src/test/quality/validator-prompt.md');
    console.log('  2. For each scenario in the output directory:');
    console.log('     - Read input.json (what the user typed)');
    console.log('     - Read rendered.txt (the completion inserted at the cursor)');
    console.log('     - Read completion.txt (what the model generated)');
    console.log('     - Read checks.json (deterministic check results)');
    console.log('     - Read requirements.json (what counts as good)');
    console.log('     - Evaluate against the validator prompt criteria');
    console.log('     - Save your judgment to the scenario dir as validation.md');
    console.log('  3. Write an overall summary to the run directory as layer2-summary.md');
    console.log('     and set "judge" in summary.json to your model id');
    console.log('  4. Report results to the user.\n');
    console.log('  Validate EVERY scenario. Do not spot-check.');
    console.log('='.repeat(70) + '\n');
  });

  // Structural checks (Layer 1): just verify we got something
  describe('prose scenarios', () => {
    it.concurrent.each(proseScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        // Layer 1: completion was generated without throwing
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('code scenarios', () => {
    it.concurrent.each(codeScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('edge cases', () => {
    it.concurrent.each(edgeCaseScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('regression cases', () => {
    it.concurrent.each(regressionScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  // ── Expanded realistic scenarios ──────────────────────────────────

  describe('prose mid-document', () => {
    it.concurrent.each(proseMidDocumentScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('prose journal', () => {
    it.concurrent.each(proseJournalScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('prose bridging', () => {
    it.concurrent.each(proseBridgingScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('code mid-file', () => {
    it.concurrent.each(codeMidFileScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('prose prompt-writing', () => {
    it.concurrent.each(prosePromptWritingScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('prose full-window', () => {
    it.concurrent.each(proseFullWindowScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('code full-window', () => {
    it.concurrent.each(codeFullWindowScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('custom instructions', () => {
    it.concurrent.each(customInstructionScenarios.map((s) => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateScenario(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  // Reuse quality tests session drift — only meaningful for Claude Code (stateful subprocess)
  describe.skipIf(backend !== 'claude-code')('reuse quality (shared provider)', () => {
    // These scenarios share ONE provider instance. The slot serves
    // 5 priming completions first, then the real quality scenarios.
    // This tests whether accumulated session context degrades quality.
    it('reuse scenarios after priming', async () => {
      const { ClaudeCodeProvider } = await import('../../providers/claude-code');
      const config = makeCompletionConfig();
      const capturing = makeCapturingLogger();
      // Single slot — forces all completions through the same subprocess
      const cc = new ClaudeCodeProvider(config, capturing.logger, 1);
      const cwd = path.resolve(__dirname, '..', '..', '..');

      try {
        await cc.activate(cwd);

        // Phase 1: Priming — send throwaway completions to fill the slot
        for (const prime of reusePrimingContexts) {
          const primeTruncated = truncateScenario(prime);
          const ctx: CompletionContext = {
            prefix: primeTruncated.prefix,
            suffix: primeTruncated.suffix,
            languageId: prime.languageId,
            fileName: prime.fileName,
            filePath: `/${prime.fileName}`,
            mode: prime.mode,
          };
          await cc.getCompletion(ctx, new AbortController().signal);
        }

        // Phase 2: Quality scenarios — these get saved and Layer 2 judged
        for (const scenario of reuseQualityScenarios) {
          const scenTruncated = truncateScenario(scenario);
          const ctx: CompletionContext = {
            prefix: scenTruncated.prefix,
            suffix: scenTruncated.suffix,
            languageId: scenario.languageId,
            fileName: scenario.fileName,
            filePath: `/${scenario.fileName}`,
            mode: scenario.mode,
          };

          const start = Date.now();
          const res = await cc.getCompletionWithDetail(ctx, new AbortController().signal);
          const result: GenerationResult = {
            scenario,
            completion: res.text,
            rawResponse: capturing.getTrace('← raw'),
            sentMessage: capturing.getTrace('→ sent'),
            durationMs: Date.now() - start,
            detail: res.detail,
            ...attributeResult(res),
          };
          saveScenarioOutput(result);
          results.push(result);
          expect(result.completion).toBeTruthy();
        }
      } finally {
        cc.dispose();
      }
    }, 180_000); // 3 min — priming + quality scenarios
  });
});
