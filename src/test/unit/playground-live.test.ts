import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../playground/complete', () => ({
  complete: vi.fn(async () => ({
    response: {
      runId: 'run-1',
      text: 'ghost',
      outcome: 'ok',
      mode: 'prose',
      latencyMs: 5,
      costUsd: 0.002,
      checks: [],
    },
    events: [{ v: 'bench/0' }],
  })),
}));
// Every live preset counts as keyed, so tests don't depend on the machine's API keys.
vi.mock('../../../src/providers/api/presets', async (orig) => ({
  ...(await orig<typeof import('../../../src/providers/api/presets')>()),
  isPresetAvailable: () => true,
}));

import {
  handleLive,
  issueSession,
  verifySession,
  liveConfigFromEnv,
  MemoryStore,
  UpstashStore,
  LIMITS,
  type LiveConfig,
  type LiveRequest,
} from '../../../playground/live';
import { complete } from '../../../playground/complete';

const SECRET = 'x'.repeat(40);

function cfg(overrides: Partial<LiveConfig> = {}): LiveConfig {
  return {
    enabled: true,
    sessionSecret: SECRET,
    allowNoTurnstile: true,
    dailyCapUsd: 5,
    ipSalt: SECRET,
    store: new MemoryStore(),
    ...overrides,
  };
}

function req(route: string, body: unknown = {}, extra: Partial<LiveRequest> = {}): LiveRequest {
  return {
    method: route === 'config' ? 'GET' : 'POST',
    route,
    body,
    ip: '203.0.113.7',
    headers: { 'x-live-session': issueSession(SECRET) },
    signal: new AbortController().signal,
    ...extra,
  };
}

const doc = { presetId: 'xai-grok', prefix: 'Dear team, ', suffix: '' };

beforeEach(() => vi.mocked(complete).mockClear());

describe('live sessions', () => {
  it('round-trips and rejects tampering and expiry', () => {
    const t = issueSession(SECRET, 1000);
    expect(verifySession(SECRET, t, 1001)).toBe(true);
    expect(verifySession(SECRET, t, 1000 + 3601)).toBe(false);
    expect(verifySession('y'.repeat(40), t, 1001)).toBe(false);
    const [payload, mac] = t.split('.');
    expect(verifySession(SECRET, `${payload}x.${mac}`, 1001)).toBe(false);
    expect(verifySession(SECRET, 'garbage', 1001)).toBe(false);
  });
});

describe('live config', () => {
  it('is off without the flag or a long enough secret', () => {
    expect(liveConfigFromEnv({}).enabled).toBe(false);
    expect(liveConfigFromEnv({ LIVE_ENABLED: '1', LIVE_SESSION_SECRET: 'short' }).enabled).toBe(
      false,
    );
    expect(liveConfigFromEnv({ LIVE_ENABLED: '1', LIVE_SESSION_SECRET: SECRET }).enabled).toBe(
      true,
    );
  });

  it('keeps live off when the daily cap is not a non-negative number', () => {
    const on = { LIVE_ENABLED: '1', LIVE_SESSION_SECRET: SECRET };
    for (const cap of ['$2', 'five', '-1', 'Infinity']) {
      const c = liveConfigFromEnv({ ...on, LIVE_DAILY_CAP_USD: cap });
      expect(c.enabled).toBe(false);
      expect(c.dailyCapUsd).toBe(0);
    }
    expect(liveConfigFromEnv({ ...on, LIVE_DAILY_CAP_USD: '2' })).toMatchObject({
      enabled: true,
      dailyCapUsd: 2,
    });
    expect(liveConfigFromEnv(on).dailyCapUsd).toBe(5);
  });

  it('uses Upstash under either env naming, else the in-memory store', () => {
    expect(liveConfigFromEnv({}).store).toBeInstanceOf(MemoryStore);
    expect(
      liveConfigFromEnv({ UPSTASH_REDIS_REST_URL: 'https://u', UPSTASH_REDIS_REST_TOKEN: 't' })
        .store,
    ).toBeInstanceOf(UpstashStore);
    expect(
      liveConfigFromEnv({ KV_REST_API_URL: 'https://u', KV_REST_API_TOKEN: 't' }).store,
    ).toBeInstanceOf(UpstashStore);
    // Half a pair is no store.
    expect(liveConfigFromEnv({ KV_REST_API_URL: 'https://u' }).store).toBeInstanceOf(MemoryStore);
  });

  it('needs Turnstile unless explicitly allowed without it', async () => {
    const out = await handleLive(cfg({ allowNoTurnstile: false }), req('config'));
    expect(out.body.enabled).toBe(false);
    const on = await handleLive(
      cfg({ allowNoTurnstile: false, turnstileSecret: 's', turnstileSiteKey: 'k' }),
      req('config'),
    );
    expect(on.body).toMatchObject({ enabled: true, turnstileSiteKey: 'k', limits: LIMITS });
  });

  it('offers only the small picker', async () => {
    const out = await handleLive(cfg(), req('config'));
    const ids = (out.body.presets as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual([
      'xai-grok',
      'anthropic-haiku',
      'openai-gpt-4.1-nano',
      'google-gemini-flash',
    ]);
    expect(out.body.defaultPreset).toBe('xai-grok');
  });
});

describe('live complete', () => {
  it('runs the pipeline and returns events and what is left', async () => {
    const out = await handleLive(cfg(), req('complete', doc));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ text: 'ghost', remaining: { hour: 99, day: 199 } });
    expect(out.body.events).toHaveLength(1);
  });

  it('refuses without a valid session', async () => {
    const out = await handleLive(
      cfg(),
      req('complete', doc, { headers: { 'x-live-session': 'nope' } }),
    );
    expect(out.status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a model outside the picker and oversized documents', async () => {
    expect(
      (await handleLive(cfg(), req('complete', { ...doc, presetId: 'anthropic-sonnet' }))).status,
    ).toBe(400);
    expect(
      (await handleLive(cfg(), req('complete', { ...doc, prefix: 'a'.repeat(20_001) }))).status,
    ).toBe(413);
    expect(complete).not.toHaveBeenCalled();
  });

  it(`allows ${LIMITS.perHour} an hour per visitor, then falls back to replay`, async () => {
    const c = cfg();
    for (let i = 0; i < LIMITS.perHour; i++) {
      expect((await handleLive(c, req('complete', doc))).status).toBe(200);
    }
    const over = await handleLive(c, req('complete', doc));
    expect(over.status).toBe(429);
    expect(over.body.fallback).toBe('replay');
    // Another visitor is unaffected.
    expect((await handleLive(c, req('complete', doc, { ip: '198.51.100.9' }))).status).toBe(200);
  });

  it(`caps a visitor at ${LIMITS.perDay} a day`, async () => {
    const store = new MemoryStore();
    const day = new Date().toISOString().slice(0, 10);
    const c = cfg({ store });
    // Find this visitor's day key by making one call, then fill it.
    await handleLive(c, req('complete', doc));
    const key = [...(store as unknown as { m: Map<string, unknown> }).m.keys()].find(
      (k) => k.startsWith('live:d:') && k.endsWith(day),
    )!;
    await store.incrByFloat(key, LIMITS.perDay - 1, 86_400);
    const out = await handleLive(c, req('complete', doc));
    expect(out.status).toBe(429);
    expect(String(out.body.error)).toContain(`${LIMITS.perDay} a day`);
  });

  it('stops everyone once the day’s spend reaches the cap, and counts spend', async () => {
    const store = new MemoryStore();
    const c = cfg({ store, dailyCapUsd: 0.005 });
    expect((await handleLive(c, req('complete', doc))).status).toBe(200);
    expect((await handleLive(c, req('complete', doc))).status).toBe(200);
    expect((await handleLive(c, req('complete', doc))).status).toBe(200); // 0.004 < 0.005
    const out = await handleLive(c, req('complete', doc, { ip: '198.51.100.9' }));
    expect(out.status).toBe(429);
    expect(out.body.fallback).toBe('replay');
  });

  it('never stores the raw IP', async () => {
    const store = new MemoryStore();
    await handleLive(cfg({ store }), req('complete', doc));
    const keys = [...(store as unknown as { m: Map<string, unknown> }).m.keys()];
    expect(keys.some((k) => k.includes('203.0.113.7'))).toBe(false);
  });
});

describe('UpstashStore', () => {
  it('sends INCR with a create-only TTL in one pipeline', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify([{ result: 3 }, { result: 1 }])),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const n = await new UpstashStore('https://u.example/', 'tok').incr('k', 60);
      expect(n).toBe(3);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://u.example/pipeline');
      expect(JSON.parse(String(init.body))).toEqual([
        ['INCR', 'k'],
        ['EXPIRE', 'k', 60, 'NX'],
      ]);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
