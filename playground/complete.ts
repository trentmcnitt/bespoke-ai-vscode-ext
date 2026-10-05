/**
 * One playground completion: the extension's real API-backend pipeline
 * (ApiCompletionProvider: prompt build, adapter, extraction, post-processing)
 * plus the eval suite's deterministic checks. Returns the ghost text and the
 * run's bench events. No HTTP server or bench delivery in here, so a serverless
 * handler can reuse it.
 *
 * Not reused from the extension: completion-provider.ts (debounce, cache, VS Code
 * types). The editor debounces client-side and there is no cache, so every
 * request reaches the model.
 */
import { randomBytes } from 'crypto';
import { ApiCompletionProvider } from '../src/providers/api/api-provider';
import { getPreset } from '../src/providers/api/presets';
import type { Preset } from '../src/providers/api/types';
import { detectMode } from '../src/mode-detector';
import { truncatePrefix, truncateSuffix } from '../src/utils/truncation';
import {
  detailFromError,
  errorTypeOf,
  genAiProviderName,
  nullResultOutcome,
} from '../src/utils/trace';
import type { CompletionWithDetail, GenerationDetail } from '../src/utils/trace';
import {
  runDeterministicChecks,
  type CheckScenarioFlags,
} from '../src/test/quality/deterministic-checks';
import { playgroundConfig, playgroundLogger } from './config';
import {
  buildEvents,
  HEAD_EVENTS,
  headEvents,
  type BenchEvent,
  type RunOutcome,
  type RunTrace,
} from './bench';
import { estimateCost } from './prices';

export interface CompleteRequest {
  presetId: string;
  /** Whole document before / after the cursor; truncated here like the extension does. */
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  sessionId: string;
  debounceMs: number;
  /** Label for the bench run (scenario id or file name). */
  label: string;
  /** Scenario flags for the checks (mid-word, length cap, ...), when a scenario is loaded. */
  checkFlags?: CheckScenarioFlags;
}

export interface CompleteResponse {
  runId: string;
  text: string | null;
  outcome: RunOutcome;
  errorType?: string;
  mode: 'prose' | 'code';
  model?: string;
  latencyMs: number;
  costUsd?: number;
  checks: Array<{ id: string; pass: boolean; detail: string }>;
}

const logger = playgroundLogger();
const providers = new Map<string, ApiCompletionProvider>();

/** One provider per preset, kept for the process (its adapter client and xAI conv id persist). */
function providerFor(presetId: string): ApiCompletionProvider {
  let p = providers.get(presetId);
  if (!p) {
    p = new ApiCompletionProvider(playgroundConfig(presetId), logger);
    providers.set(presetId, p);
  }
  return p;
}

/** Optional: receive the run's bench events as they happen instead of only at the end. */
export interface CompleteHooks {
  /**
   * Called with the run's first events (through model_call's step_started) the moment the request
   * goes to the model. The returned `streamed` says how many of `events` it was given.
   */
  onEvents?: (events: BenchEvent[]) => void;
}

export async function complete(
  req: CompleteRequest,
  signal: AbortSignal,
  hooks: CompleteHooks = {},
): Promise<{ response: CompleteResponse; events: BenchEvent[]; streamed: number }> {
  const preset = getPreset(req.presetId);
  if (!preset) throw new Error(`unknown preset ${req.presetId}`);
  const config = playgroundConfig(req.presetId);
  const mode = detectMode(req.languageId, config);
  const window = mode === 'code' ? config.code : config.prose;
  const prefix = truncatePrefix(req.prefix, window.contextChars);
  const suffix = truncateSuffix(req.suffix, window.suffixChars);

  const runId = `run-${randomBytes(6).toString('hex')}`;
  const startMs = Date.now();
  let sentMs: number | undefined;
  let streamed = 0;
  const fixed = {
    runId,
    sessionId: req.sessionId,
    label: req.label,
    origin: 'web' as const,
    debounceMs: req.debounceMs,
    startMs,
    mode,
    presetId: req.presetId,
    params: sentParams(preset),
  };
  const trace = (rest: Omit<RunTrace, keyof typeof fixed>): RunTrace => ({ ...fixed, ...rest });
  // The request went to the model: what led up to it is final, so it can be sent now.
  const onRequestSent = (detail: GenerationDetail) => {
    sentMs = Date.now();
    if (!hooks.onEvents) return;
    const head = headEvents(
      trace({
        sentMs,
        endMs: sentMs,
        checkedMs: sentMs,
        detail,
        finalText: null,
        outcome: 'ok',
        checks: [],
      }),
    );
    streamed = HEAD_EVENTS;
    hooks.onEvents(head);
  };
  let result: CompletionWithDetail;
  let errorMessage: string | undefined;
  let threw = false;
  try {
    result = await providerFor(req.presetId).getCompletionWithDetail(
      {
        prefix,
        suffix,
        languageId: req.languageId,
        fileName: req.fileName,
        filePath: req.fileName,
        mode,
      },
      signal,
      { captureContent: true, onRequestSent },
    );
  } catch (err) {
    threw = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    const detail: GenerationDetail = detailFromError(err) ?? {
      providerName: genAiProviderName(preset.provider),
      requestModel: preset.modelId,
    };
    detail.errorType ??= errorTypeOf(err);
    result = { text: null, detail };
  }
  const endMs = Date.now();

  const detail = result.detail;
  const outcome: RunOutcome = threw
    ? 'error'
    : result.text
      ? 'ok'
      : nullResultOutcome(detail, signal.aborted);

  const checks =
    outcome === 'aborted'
      ? []
      : runDeterministicChecks({
          mode,
          prefix,
          suffix,
          completion: result.text,
          rawResponse: detail?.content?.rawOutput ?? undefined,
          providerError: outcome === 'error',
          scenario: req.checkFlags,
        });
  const checkedMs = Date.now();
  const cost = estimateCost(preset.modelId, detail);

  const run = trace({
    sentMs,
    endMs,
    checkedMs,
    detail,
    finalText: result.text,
    outcome,
    errorMessage: errorMessage ?? detail?.errorMessage,
    checks,
    cost,
  });

  return {
    response: {
      runId,
      text: result.text,
      outcome,
      errorType: detail?.errorType,
      mode,
      model: detail?.responseModel ?? detail?.requestModel,
      latencyMs: endMs - startMs,
      costUsd: detail?.costUsd ?? cost?.usd,
      checks: checks.map((c) => ({ id: c.id, pass: c.pass, detail: c.detail })),
    },
    events: buildEvents(run),
    streamed,
  };
}

/** The sampling parameters the adapters send for a preset (see adapters/anthropic.ts, openai-compat.ts). */
function sentParams(preset: Preset): Record<string, unknown> {
  const params: Record<string, unknown> = { max_tokens: preset.maxTokens };
  if (preset.features?.sampling !== false) params.temperature = preset.temperature;
  if (preset.stopSequences?.length) params.stop = preset.stopSequences;
  if (preset.provider === 'anthropic' && preset.features?.thinkingOff) {
    params.thinking = { type: preset.features.thinkingOff };
  }
  return params;
}

export function disposeProviders(): void {
  for (const p of providers.values()) p.dispose();
  providers.clear();
}
