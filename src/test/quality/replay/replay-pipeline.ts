/**
 * Replay of the client-side completion pipeline (extraction + post-processing)
 * on a recorded raw model response. No model calls, no vscode, no secrets.
 *
 * Shared by build-replay-set.ts (which writes the fixture) and
 * src/test/unit/replay.test.ts (which asserts the current code still produces
 * the recorded output). Keep it free of vitest / helpers / preset imports.
 *
 * The glue here MIRRORS the providers and must be kept in sync with them:
 *  - CLI (tag-extraction): ClaudeCodeProvider.getCompletionWithDetail in
 *    src/providers/claude-code.ts — `if (!raw) null`, extractCompletion(raw),
 *    postProcessCompletion(extracted, prefix, suffix, mode).
 *  - API: ApiCompletionProvider.getCompletionWithDetail in
 *    src/providers/api/api-provider.ts — `if (!raw) null`,
 *    strategy.extractCompletion(raw), `if (!extracted) null`,
 *    postProcessCompletion(extracted, prefill ? undefined : prefix, suffix, mode).
 */
import { extractCompletion, getPromptStrategy } from '../../../providers/prompt-strategy';
import type { PromptStrategyId } from '../../../providers/prompt-strategy';
import { postProcessCompletion } from '../../../utils/post-process';
import type { CheckResult, CheckScenarioFlags } from '../deterministic-checks';

/**
 * The CLI harness records a null raw response as this string
 * (`traceBlock('← raw', raw ?? '(null)')`). Treat it as null on replay.
 */
export const CLI_NULL_RAW = '(null)';

export interface ReplayInput {
  /** 'claude-code' goes through the CLI glue, 'api' through the API glue. */
  backend: 'claude-code' | 'api';
  strategy: PromptStrategyId;
  /** API presets with `features.prefill` skip prefix-overlap trimming. */
  prefill: boolean;
  mode: 'prose' | 'code';
  prefix: string;
  suffix: string;
  /** Raw model response exactly as recorded in raw-response.txt. */
  raw: string;
}

export interface ReplayOutput {
  /** Strategy extraction result (null = extraction produced nothing / no raw). */
  extracted: string | null;
  /** What would become ghost text. null = no completion. */
  final: string | null;
}

export function replayPipeline(input: ReplayInput): ReplayOutput {
  if (input.backend === 'claude-code') {
    const raw = input.raw === CLI_NULL_RAW ? '' : input.raw;
    if (!raw) return { extracted: null, final: null };
    const extracted = extractCompletion(raw);
    return {
      extracted,
      final: postProcessCompletion(extracted, input.prefix, input.suffix, input.mode),
    };
  }
  if (!input.raw) return { extracted: null, final: null };
  const extracted = getPromptStrategy(input.strategy).extractCompletion(input.raw, input.prefix);
  if (!extracted) return { extracted, final: null };
  return {
    extracted,
    final: postProcessCompletion(
      extracted,
      input.prefill ? undefined : input.prefix,
      input.suffix,
      input.mode,
    ),
  };
}

/**
 * Machine-checkable "must not happen" annotations. Each is redundant with the
 * exact `expected_final` assertion on purpose: they still guard the case if
 * someone deliberately updates `expected_final`.
 */
export type MustAvoidKind =
  /** Final must not contain <COMPLETION>, </COMPLETION> or {{FILL_HERE}}. */
  | 'tag-leak'
  /** Final must not start with a chat preamble ("Here's…", "Sure", …). */
  | 'preamble'
  /** Final must not start with the prefix's current-line fragment (`value`). */
  | 'prefix-echo'
  /** Final (trimEnd) must not end with `value`, the suffix overlap that was trimmed. */
  | 'suffix-overlap'
  /** Final must be null, never a whitespace-only string. */
  | 'whitespace-final'
  /** The listed check must keep failing (the defect is in the raw output). */
  | 'check-stays-failing';

export interface MustAvoid {
  kind: MustAvoidKind;
  /** kind-specific operand: the trimmed text, or the check id. */
  value?: string;
  note: string;
}

export interface ReplayCase {
  /** `<run dir without "quality-">/<scenario id>` */
  id: string;
  source_run: string;
  scenario: string;
  model: string;
  backend: 'claude-code' | 'api';
  preset: string | null;
  strategy: PromptStrategyId;
  prefill: boolean;
  mode: 'prose' | 'code';
  languageId: string;
  /** Tail of the recorded (already truncated) prefix, cut at a line start. */
  prefix: string;
  /** Head of the recorded suffix, cut at a line end. */
  suffix: string;
  /** Characters of the recorded prefix / suffix dropped from this fixture. */
  prefix_omitted_chars: number;
  suffix_omitted_chars: number;
  raw: string;
  /** What the pipeline produced. Equals recorded_final unless drift is set. */
  expected_final: string | null;
  /** Present only when the recorded completion differs from expected_final. */
  recorded_final?: string | null;
  /** Why recorded_final differs (intentional pipeline change, with commit). */
  drift?: string;
  /** What this case exercises, e.g. ["suffix-trim", "check-fail:suffix-echo"]. */
  tags: string[];
  scenario_flags: CheckScenarioFlags;
  expected_checks: CheckResult[];
  must_avoid: MustAvoid[];
}

export interface ReplaySet {
  description: string;
  generated_by: string;
  cases: ReplayCase[];
}

/** Check input for a replayed case — mirrors saveScenarioOutput() in the harness. */
export function checkInputFor(c: ReplayCase, completion: string | null) {
  return {
    mode: c.mode,
    prefix: c.prefix,
    suffix: c.suffix,
    completion,
    rawResponse: c.raw,
    providerError: false,
    scenario: c.scenario_flags,
  };
}
