import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'http';

// complete() streams its first events at the send (onEvents) and returns how many it streamed.
vi.mock('../../../playground/complete', () => ({
  complete: vi.fn(
    async (_req: unknown, _signal: unknown, hooks: { onEvents?: (e: unknown[]) => void }) => {
      hooks.onEvents?.([{ seq: 0 }, { seq: 1 }]);
      return {
        response: {
          runId: 'run-1',
          text: 'ghost',
          outcome: 'ok',
          mode: 'prose',
          latencyMs: 5,
          checks: [],
        },
        events: [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }],
        streamed: hooks.onEvents ? 2 : 0,
      };
    },
  ),
}));
vi.mock('../../../src/providers/api/presets', async (orig) => ({
  ...(await orig<typeof import('../../../src/providers/api/presets')>()),
  isPresetAvailable: () => true,
}));

import { handleLive, issueSession, MemoryStore, type LiveConfig } from '../../../playground/live';
import { liveResponder, wantsStream, NDJSON } from '../../../playground/live-stream';

const SECRET = 'x'.repeat(40);
const cfg: LiveConfig = {
  enabled: true,
  sessionSecret: SECRET,
  allowNoTurnstile: true,
  dailyCapUsd: 5,
  ipSalt: SECRET,
  store: new MemoryStore(),
};
const doc = { presetId: 'xai-grok', prefix: 'Dear team, ', suffix: '', stream: true };

/** A ServerResponse that records what was written, and when. */
function fakeRes() {
  const log: Array<[string, unknown]> = [];
  const res = {
    destroyed: false,
    writeHead: (status: number, headers: Record<string, string>) =>
      log.push(['head', { status, headers }]),
    write: (chunk: string) => log.push(['write', chunk]),
    end: (chunk: string) => log.push(['end', chunk]),
  };
  return { res: res as unknown as ServerResponse, log };
}

describe('streamed live completions', () => {
  it('only a complete request that asks for it streams', () => {
    expect(wantsStream('complete', { stream: true })).toBe(true);
    expect(wantsStream('complete', {})).toBe(false);
    expect(wantsStream('session', { stream: true })).toBe(false);
  });

  it('streams the first events at the send, then the response with only the rest', async () => {
    const { res, log } = fakeRes();
    const responder = liveResponder(res, true);
    const out = await handleLive(cfg, {
      method: 'POST',
      route: 'complete',
      body: doc,
      ip: '203.0.113.7',
      headers: { 'x-live-session': issueSession(SECRET) },
      signal: new AbortController().signal,
      onEvents: responder.onEvents,
    });
    expect(out.status).toBe(200);
    expect(out.body.events).toEqual([{ seq: 2 }, { seq: 3 }]);
    responder.finish(out.status, out.body);
    expect(log[0]).toEqual(['head', expect.objectContaining({ status: 200 })]);
    expect((log[0][1] as { headers: Record<string, string> }).headers['content-type']).toBe(NDJSON);
    expect(JSON.parse(log[1][1] as string)).toEqual({ events: [{ seq: 0 }, { seq: 1 }] });
    const last = JSON.parse(log[2][1] as string);
    expect(log[2][0]).toBe('end');
    expect(last.status).toBe(200);
    expect(last.body.text).toBe('ghost');
  });

  it('a request refused before the model gets plain JSON with its real status', () => {
    const { res, log } = fakeRes();
    liveResponder(res, true).finish(429, { error: 'limit', fallback: 'replay' });
    expect(log[0]).toEqual([
      'head',
      {
        status: 429,
        headers: expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
      },
    ]);
    expect(JSON.parse(log[1][1] as string)).toEqual({ error: 'limit', fallback: 'replay' });
  });

  it('without streaming, every event comes in the response', async () => {
    const out = await handleLive(cfg, {
      method: 'POST',
      route: 'complete',
      body: { ...doc, stream: false },
      ip: '203.0.113.8',
      headers: { 'x-live-session': issueSession(SECRET) },
      signal: new AbortController().signal,
    });
    expect(out.body.events).toHaveLength(4);
  });
});
