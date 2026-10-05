import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// The live page's request gate and bench-run assembly are plain browser JS; they export for Node too.
type Gate = {
  edited(): void;
  reset(): void;
  decide(k: string, explicit: boolean): 'reuse' | 'skip' | 'request';
  lastText(): string | null;
  sent(): void;
  answered(k: string, text: string | null): void;
};
type Ev = Record<string, any>;
type Run = { runId: string; sessionId: string; seq: number; lastTs: number; offset: number | null };
const LR = createRequire(__filename)('../../../playground/client/live-requests.js') as {
  key(presetId: string, prefix: string, suffix: string): string;
  createGate(): Gate;
  newRun(runId: string, sessionId: string): Run;
  own(run: Run, node: string, type: string, ts: number, data?: Record<string, unknown>): Ev;
  adopt(run: Run, events: Ev[], nowSec: number): Ev[];
  lines(buf: string): { lines: string[]; rest: string };
};

/** Drives the gate like replay.js does: each ask either reuses, skips, or makes a request. */
function page() {
  const gate = LR.createGate();
  const requests: string[] = [];
  const ask = (doc: string, cursor: number, explicit = false) => {
    const k = LR.key('xai-grok', doc.slice(0, cursor), doc.slice(cursor));
    const d = gate.decide(k, explicit);
    if (d === 'request') {
      gate.sent();
      requests.push(doc.slice(0, cursor) + '|');
      gate.answered(k, ' a ghost');
    }
    return d;
  };
  return { gate, ask, requests };
}

describe('live requests: only a real edit and a pause, or ⌥↵', () => {
  it("Trent's space bar: one space, one request, and nothing more while the ghost sits there", () => {
    const { gate, ask, requests } = page();
    gate.reset(); // entered live mode
    const doc = 'pulling in a bunch ';
    gate.edited(); // the space
    expect(ask(doc, doc.length)).toBe('request');
    // Monaco asks again on its own: the pointer resting on the ghost text (an explicit re-ask, the
    // second run in Trent's screenshot, debounce 0 ms), a re-render, an accept-flow trigger.
    expect(ask(doc, doc.length, true)).toBe('reuse');
    expect(ask(doc, doc.length)).toBe('reuse');
    expect(ask(doc, doc.length, true)).toBe('reuse');
    expect(requests).toEqual(['pulling in a bunch |']);
  });

  it('an automatic ask with no edit since the last request never goes out', () => {
    const { gate, ask, requests } = page();
    gate.reset();
    expect(ask('hello', 5)).toBe('skip'); // nothing typed yet
    gate.edited();
    expect(ask('hello', 5)).toBe('request');
    expect(ask('hello', 2)).toBe('skip'); // the cursor moved, nothing was typed
    expect(ask('hello', 2, true)).toBe('request'); // ⌥↵ there
    gate.edited();
    expect(ask('hello!', 6)).toBe('request');
    expect(requests).toHaveLength(3);
  });

  it('the same text, cursor and model reuses the answer; a different model asks', () => {
    const gate = LR.createGate();
    const k = LR.key('xai-grok', 'ab', 'c');
    gate.edited();
    expect(gate.decide(k, false)).toBe('request');
    gate.sent();
    gate.answered(k, 'X');
    expect(gate.decide(k, false)).toBe('reuse');
    expect(gate.lastText()).toBe('X');
    expect(gate.decide(LR.key('anthropic-haiku', 'ab', 'c'), true)).toBe('request');
    // Keys can't collide by moving text across the cursor.
    expect(LR.key('m', 'ab', 'c')).not.toBe(LR.key('m', 'a', 'bc'));
  });

  it('an empty answer is not kept: ⌥↵ at the same spot asks again', () => {
    const gate = LR.createGate();
    const k = LR.key('xai-grok', 'ab', '');
    gate.edited();
    gate.sent();
    gate.answered(k, null);
    expect(gate.decide(k, true)).toBe('request');
  });
});

describe("live runs: the server's events become the page's run", () => {
  const server = (base: number): Ev[] => {
    const e = (seq: number, node: string, t: string, ts: number, data: Ev = {}) => ({
      v: 'bench/0',
      session_id: 'live',
      run_id: 'run-srv',
      seq,
      ts,
      node,
      event_type: t,
      ...(node === '_run' ? {} : { step_id: `run-srv:${node}:1` }),
      content_mode: 'full',
      data,
    });
    return [
      e(0, '_run', 'run_started', base - 0.8, { label: 'live', input: 'prose · xai-grok' }),
      e(1, 'queue', 'step_started', base - 0.8),
      e(2, 'queue', 'step_finished', base),
      e(3, 'prompt_build', 'step_started', base),
      e(4, 'prompt_build', 'step_finished', base + 0.001, { output: 'the prompt' }),
      e(5, 'model_call', 'step_started', base + 0.001),
      e(6, 'model_call', 'step_finished', base + 1.201, { latency_ms: 1200 }),
      e(7, 'extract', 'step_started', base + 1.201),
      e(8, '_run', 'run_finished', base + 1.202, { status: 'ok' }),
    ];
  };

  it('streamed: the head lands when it arrived, the tail keeps the measured model time', () => {
    const run = LR.newRun('live-1', 'sess');
    const sent = [
      LR.own(run, '_run', 'run_started', 100),
      LR.own(run, 'queue', 'step_started', 100),
    ];
    sent.push(
      LR.own(run, 'queue', 'step_finished', 100.8),
      LR.own(run, 'prompt_build', 'step_started', 100.8),
    );
    // The server's clock is 37 s behind the page's.
    const ev = server(63.85);
    const head = LR.adopt(run, ev.slice(0, 6), 100.95);
    expect(head.map((e) => `${e.node}:${e.event_type}`)).toEqual([
      '_run:run_updated',
      'prompt_build:step_finished',
      'model_call:step_started',
    ]);
    expect(head[0].data).toEqual({ input: 'prose · xai-grok' });
    expect(head[2].ts).toBeCloseTo(100.95); // the newest event of the batch lands at its arrival
    const tail = LR.adopt(run, ev.slice(6), 102.2);
    expect(tail[0].ts - head[2].ts).toBeCloseTo(1.2); // the model call's real duration
    const all = [...sent, ...head, ...tail];
    expect(all.every((e) => e.run_id === 'live-1' && e.session_id === 'sess')).toBe(true);
    expect(all.filter((e) => e.step_id).every((e) => e.step_id.startsWith('live-1:'))).toBe(true);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    all.slice(1).forEach((e, i) => expect(e.ts).toBeGreaterThanOrEqual(all[i].ts));
  });

  it('buffered (a host that held the stream): everything is placed so the run ends at arrival', () => {
    const run = LR.newRun('live-2', 'sess');
    LR.own(run, '_run', 'run_started', 100);
    LR.own(run, 'prompt_build', 'step_started', 100.8);
    const out = LR.adopt(run, server(5000), 102.3);
    expect(out[out.length - 1].ts).toBeCloseTo(102.3);
    expect(out.every((e) => e.ts >= 100.8)).toBe(true);
  });

  it('splits NDJSON on whole lines and keeps a partial one', () => {
    expect(LR.lines('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(LR.lines('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], rest: '' });
  });
});
