/**
 * The playground's bench adapter: one completion run → bench/0 events
 * (~/working_dir/agent-lab-bench/SPEC.md), plus registration and delivery.
 *
 * Step boundaries: the pipeline runs inside ApiCompletionProvider as one call, so
 * the only interior time it reports is the adapter's HTTP round trip
 * (`detail.durationApiMs`). `model_call` spans exactly that; `prompt_build` is
 * the time before it and `extract` + `post_process` share the time after it, all
 * measured around the one call. The in-process steps take well under a
 * millisecond, so their bars are real but not individually timed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { GenerationDetail } from '../src/utils/trace';
import { totalInputTokens } from '../src/utils/trace';
import type { CheckResult } from '../src/test/quality/deterministic-checks';

export const APP_ID = 'bespoke-playground';

export type RunOutcome = 'ok' | 'empty' | 'aborted' | 'error';

export interface CostEstimate {
  usd: number;
  basis: string;
}

/** Everything one run produced, with wall-clock marks in epoch ms. */
export interface RunTrace {
  runId: string;
  sessionId: string;
  label: string;
  origin: 'web' | 'suite';
  /** Typing pause the editor waited out before sending (0 for an explicit trigger). */
  debounceMs: number;
  /** Server received the request (end of debounce). */
  startMs: number;
  /** Provider call returned. */
  endMs: number;
  /** Deterministic checks finished. */
  checkedMs: number;
  mode: 'prose' | 'code';
  presetId: string;
  detail?: GenerationDetail;
  finalText: string | null;
  outcome: RunOutcome;
  errorMessage?: string;
  checks: CheckResult[];
  cost?: CostEstimate;
  /** Request parameters as the adapter sent them (for the bench's Model I/O panel). */
  params?: Record<string, unknown>;
}

export interface BenchEvent {
  v: 'bench/0';
  session_id: string;
  run_id: string;
  seq: number;
  ts: number;
  node: string;
  event_type: string;
  step_id?: string;
  content_mode: 'full' | 'redacted';
  data: Record<string, unknown>;
}

type StepStatus = 'ok' | 'error' | 'skipped' | 'aborted';

/** Build the run's events in order. Content is sent in full: see README (local only). */
export function buildEvents(run: RunTrace): BenchEvent[] {
  const events: BenchEvent[] = [];
  const add = (node: string, event_type: string, tsMs: number, data: Record<string, unknown>) => {
    events.push({
      v: 'bench/0',
      session_id: run.sessionId,
      run_id: run.runId,
      seq: events.length,
      ts: tsMs / 1000,
      node,
      event_type,
      ...(node === '_run' ? {} : { step_id: `${run.runId}:${node}:1` }),
      content_mode: 'full',
      data,
    });
  };
  const step = (
    node: string,
    fromMs: number,
    toMs: number,
    status: StepStatus,
    extra: Record<string, unknown> = {},
    inner?: () => void,
  ) => {
    add(node, 'step_started', fromMs, {});
    inner?.();
    add(node, 'step_finished', toMs, {
      status,
      latency_ms: Math.max(0, Math.round(toMs - fromMs)),
      ...extra,
    });
  };

  const d = run.detail;
  const content = d?.content;
  const queuedMs = run.startMs - run.debounceMs;
  const apiMs = Math.min(d?.durationApiMs ?? run.endMs - run.startMs, run.endMs - run.startMs);
  // The HTTP call ends at endMs minus the in-process tail; place it last in the window.
  const modelEnd = run.endMs;
  const modelStart = modelEnd - apiMs;
  const reachedModel =
    d !== undefined && d.errorType !== 'circuit_open' && d.errorType !== 'backend_unavailable';

  add('_run', 'run_started', queuedMs, {
    label: run.label,
    origin: run.origin,
    input: `${run.mode} · ${run.presetId}`,
  });

  step('queue', queuedMs, run.startMs, 'ok', { timings: { debounce: run.debounceMs } });

  step('prompt_build', run.startMs, modelStart, 'ok', {
    output: content?.userMessage,
    ...(content?.prefill ? { prefill: content.prefill } : {}),
  });

  const modelStatus: StepStatus =
    run.outcome === 'aborted' ? 'aborted' : run.outcome === 'error' ? 'error' : 'ok';
  step(
    'model_call',
    modelStart,
    modelEnd,
    reachedModel ? modelStatus : 'skipped',
    { output: content?.rawOutput ?? null, timings: { model: Math.round(apiMs) } },
    () => {
      // Errors go in the Errors panel, including a request that was never sent
      // (open breaker, unusable preset), whose step is marked skipped.
      if (run.outcome === 'error') {
        add('model_call', 'error', modelEnd, {
          message: run.errorMessage ?? d?.errorType ?? 'error',
          type: d?.errorType,
        });
      }
      if (!d || !reachedModel) return;
      const llm: Record<string, unknown> = {
        model: d.responseModel ?? d.requestModel,
        provider: d.providerName,
        latency_ms: Math.round(apiMs),
      };
      const input = totalInputTokens(d);
      if (input !== undefined) llm.input_tokens = input;
      if (d.cacheReadTokens !== undefined) llm.cache_read_tokens = d.cacheReadTokens;
      if (d.cacheWriteTokens !== undefined) llm.cache_write_tokens = d.cacheWriteTokens;
      if (d.outputTokens !== undefined) llm.output_tokens = d.outputTokens;
      if (d.finishReason) llm.finish_reason = d.finishReason;
      if (d.costUsd !== undefined) {
        llm.cost_usd = d.costUsd;
        llm.cost_source = 'actual';
      } else if (run.cost) {
        llm.cost_usd = run.cost.usd;
        llm.cost_source = 'estimated';
        llm.cost_basis = run.cost.basis;
      }
      llm.stream = false;
      // Model I/O: exactly what the API received and returned (content is capture-gated upstream).
      if (content?.systemPrompt !== undefined) llm.system = content.systemPrompt;
      if (content?.userMessage !== undefined) {
        llm.messages = [
          { role: 'user', content: content.userMessage },
          ...(content.prefill ? [{ role: 'assistant', content: content.prefill }] : []),
        ];
      }
      if (content && 'rawOutput' in content) llm.output = content.rawOutput ?? null;
      if (run.params) llm.params = run.params;
      add('model_call', 'llm_call', modelEnd, llm);
    },
  );

  // extract + post_process share the in-process tail after the HTTP call.
  const tailMid = modelEnd;
  const gotRaw = typeof content?.rawOutput === 'string' && content.rawOutput.length > 0;
  const extracted = content?.extracted;
  const later: StepStatus = run.outcome === 'aborted' ? 'aborted' : 'skipped';
  step('extract', tailMid, tailMid, gotRaw ? 'ok' : later, { output: extracted ?? null });
  step('post_process', tailMid, run.endMs, gotRaw && extracted ? 'ok' : later, {
    output: run.finalText,
  });

  if (run.outcome !== 'aborted') {
    step(
      'checks',
      run.endMs,
      run.checkedMs,
      'ok',
      {
        passed: run.checks.filter((c) => c.pass).length,
        failed: run.checks.filter((c) => !c.pass).length,
      },
      () => {
        for (const c of run.checks) {
          add('checks', 'check_result', run.checkedMs, {
            name: c.id,
            passed: c.pass,
            detail: c.detail,
          });
        }
      },
    );
  }

  add('_run', 'run_finished', run.checkedMs, {
    status: run.outcome === 'error' ? 'error' : run.outcome === 'aborted' ? 'aborted' : 'ok',
    outcome: run.outcome,
    output: run.finalText,
    latency_ms: Math.round(run.checkedMs - queuedMs),
  });
  return events;
}

// ─── Delivery ─────────────────────────────────────────────────────────

export interface BenchClient {
  register(): Promise<boolean>;
  send(events: BenchEvent[]): void;
}

/**
 * Talks to a local bench. Never throws and never blocks a completion: a bench
 * that is down costs one log line (repeated at most once a minute).
 */
export function benchClient(baseUrl: string): BenchClient {
  let lastWarn = 0;
  const warn = (what: string, err: unknown) => {
    const now = Date.now();
    if (now - lastWarn < 60_000) return;
    lastWarn = now;
    console.warn(`[playground] bench ${what} failed (${baseUrl}): ${String(err)}`);
  };
  const topology = JSON.parse(readFileSync(join(__dirname, 'topology.json'), 'utf8'));
  let registered = false;

  const register = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${baseUrl}/apps/${APP_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topology, story: null }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      registered = true;
      return true;
    } catch (err) {
      warn('registration', err);
      return false;
    }
  };

  const send = (events: BenchEvent[]): void => {
    void (async () => {
      try {
        // A bench started after the playground has never seen the map.
        if (!registered && !(await register())) return;
        const res = await fetch(`${baseUrl}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(events),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { rejected?: Array<{ index: number; error: string }> };
        if (body.rejected?.length) {
          console.warn(
            `[playground] bench rejected ${body.rejected.length} event(s):`,
            body.rejected,
          );
        }
      } catch (err) {
        registered = false;
        warn('ingest', err);
      }
    })();
  };

  return { register, send };
}
