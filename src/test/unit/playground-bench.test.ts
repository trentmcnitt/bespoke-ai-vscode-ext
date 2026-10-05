import { describe, it, expect } from 'vitest';
import { buildEvents, headEvents, HEAD_EVENTS, type RunTrace } from '../../../playground/bench';

function run(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 'run-abc',
    sessionId: 'pg-1',
    label: 'code-ts-function-body',
    origin: 'web',
    debounceMs: 800,
    startMs: 1_000_000,
    endMs: 1_000_900,
    checkedMs: 1_000_901,
    mode: 'code',
    presetId: 'anthropic-haiku',
    detail: {
      providerName: 'anthropic',
      requestModel: 'claude-haiku-4-5-20251001',
      inputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 12,
      durationApiMs: 850,
      finishReason: 'end_turn',
      content: { userMessage: 'msg', rawOutput: 'raw', extracted: 'text' },
    },
    finalText: 'text',
    outcome: 'ok',
    checks: [{ id: 'non-empty', pass: true, detail: 'completion has content' }],
    cost: { usd: 0.001, basis: 'anthropic price table 2026-09-28' },
    ...overrides,
  };
}

const RUN_STATUSES = ['ok', 'error', 'aborted'];

describe('playground buildEvents', () => {
  it.each(['ok', 'empty', 'error', 'aborted'] as const)('%s: envelope invariants', (outcome) => {
    const events = buildEvents(run({ outcome, finalText: outcome === 'ok' ? 'text' : null }));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    for (const e of events) {
      expect(e.v).toBe('bench/0');
      expect(e.run_id).toBe('run-abc');
      expect(e.session_id).toBe('pg-1');
      if (e.event_type === 'run_started' || e.event_type === 'run_finished') {
        expect(e.node).toBe('_run');
        expect(e.step_id).toBeUndefined();
      } else {
        expect(e.node).not.toBe('_run');
        expect(e.step_id).toBe(`run-abc:${e.node}:1`);
      }
      if (e.event_type === 'step_finished') {
        expect(['ok', 'error', 'skipped', 'aborted']).toContain(e.data.status);
        expect(e.data.latency_ms).toBeGreaterThanOrEqual(0);
      }
    }
    // ts never goes backwards
    for (let i = 1; i < events.length; i++) {
      expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    }
    const finished = events[events.length - 1];
    expect(finished.event_type).toBe('run_finished');
    expect(RUN_STATUSES).toContain(finished.data.status);
    expect(finished.data.outcome).toBe(outcome);
  });

  it('llm_call input_tokens is the total including cache reads and writes', () => {
    const llm = buildEvents(run()).find((e) => e.event_type === 'llm_call')!;
    expect(llm.data.input_tokens).toBe(100 + 900 + 50);
    expect(llm.data.cache_read_tokens).toBe(900);
    expect(llm.data.cache_write_tokens).toBe(50);
    expect(llm.data.model).toBe('claude-haiku-4-5-20251001');
  });

  it('llm_call carries the model I/O as sent and returned', () => {
    const r = run({ params: { max_tokens: 200, temperature: 0.2 } });
    r.detail!.content = {
      systemPrompt: 'sys',
      userMessage: 'msg',
      prefill: '<COMPLETION>',
      rawOutput: 'raw',
      extracted: 'text',
    };
    const llm = buildEvents(r).find((e) => e.event_type === 'llm_call')!;
    expect(llm.data.system).toBe('sys');
    expect(llm.data.messages).toEqual([
      { role: 'user', content: 'msg' },
      { role: 'assistant', content: '<COMPLETION>' },
    ]);
    expect(llm.data.output).toBe('raw');
    expect(llm.data.params).toEqual({ max_tokens: 200, temperature: 0.2 });
  });

  it('estimated cost carries its source and basis', () => {
    const llm = buildEvents(run()).find((e) => e.event_type === 'llm_call')!;
    expect(llm.data).toMatchObject({
      cost_usd: 0.001,
      cost_source: 'estimated',
      cost_basis: 'anthropic price table 2026-09-28',
    });
  });

  it('a backend-reported cost is actual and wins over the estimate', () => {
    const r = run();
    r.detail!.costUsd = 0.002;
    const llm = buildEvents(r).find((e) => e.event_type === 'llm_call')!;
    expect(llm.data).toMatchObject({ cost_usd: 0.002, cost_source: 'actual' });
  });

  it('no cost_usd without a cost', () => {
    const llm = buildEvents(run({ cost: undefined })).find((e) => e.event_type === 'llm_call')!;
    expect(llm.data.cost_usd).toBeUndefined();
    expect(llm.data.cost_source).toBeUndefined();
  });

  it('model_call spans the reported API time, ending when the provider returned', () => {
    const events = buildEvents(run());
    const started = events.find((e) => e.node === 'model_call' && e.event_type === 'step_started')!;
    const finished = events.find(
      (e) => e.node === 'model_call' && e.event_type === 'step_finished',
    )!;
    expect(finished.ts * 1000).toBeCloseTo(1_000_900);
    expect((finished.ts - started.ts) * 1000).toBeCloseTo(850);
  });

  it('error: the model step fails with an error event, later steps are skipped', () => {
    const r = run({ outcome: 'error', finalText: null });
    r.detail!.errorType = '529';
    r.detail!.content = { userMessage: 'msg', rawOutput: null };
    const events = buildEvents(r);
    const status = (node: string) =>
      events.find((e) => e.node === node && e.event_type === 'step_finished')!.data.status;
    expect(status('model_call')).toBe('error');
    expect(events.some((e) => e.event_type === 'error' && e.data.type === '529')).toBe(true);
    expect(status('extract')).toBe('skipped');
    expect(status('post_process')).toBe('skipped');
  });

  it('a request never sent skips the model call and reports no llm_call', () => {
    const r = run({ outcome: 'error', finalText: null });
    r.detail = { providerName: 'anthropic', requestModel: 'x', errorType: 'circuit_open' };
    const events = buildEvents(r);
    expect(events.some((e) => e.event_type === 'llm_call')).toBe(false);
    expect(events.some((e) => e.event_type === 'error' && e.data.type === 'circuit_open')).toBe(
      true,
    );
  });

  it('aborted: no checks step', () => {
    const events = buildEvents(run({ outcome: 'aborted', finalText: null, checks: [] }));
    expect(events.some((e) => e.node === 'checks')).toBe(false);
  });

  it('checks become check_result events', () => {
    const events = buildEvents(run());
    const results = events.filter((e) => e.event_type === 'check_result');
    expect(results).toHaveLength(1);
    expect(results[0].data).toEqual({
      name: 'non-empty',
      passed: true,
      detail: 'completion has content',
    });
  });

  it('with a measured send, model_call runs from the send to the answer', () => {
    const events = buildEvents(run({ sentMs: 1_000_020 }));
    const at = (node: string, t: string) =>
      events.find((e) => e.node === node && e.event_type === t)!.ts * 1000;
    expect(at('prompt_build', 'step_finished')).toBeCloseTo(1_000_020);
    expect(at('model_call', 'step_started')).toBeCloseTo(1_000_020);
    expect(at('model_call', 'step_finished')).toBeCloseTo(1_000_900);
  });

  it('headEvents at the send are exactly the first events of the finished run', () => {
    // complete() sends these the moment the request goes out; the rest follow with the answer.
    const final = run({ sentMs: 1_000_020 });
    const atSend = run({
      sentMs: 1_000_020,
      endMs: 1_000_020,
      checkedMs: 1_000_020,
      finalText: null,
      checks: [],
      detail: { ...final.detail!, outputTokens: undefined, durationApiMs: undefined },
    });
    const head = headEvents(atSend);
    expect(head).toHaveLength(HEAD_EVENTS);
    expect(head).toEqual(buildEvents(final).slice(0, HEAD_EVENTS));
    expect(head.map((e) => `${e.node}:${e.event_type}`)).toEqual([
      '_run:run_started',
      'queue:step_started',
      'queue:step_finished',
      'prompt_build:step_started',
      'prompt_build:step_finished',
      'model_call:step_started',
    ]);
    expect(head[4].data.output).toBe('msg'); // the prompt, built before the send
  });
});
