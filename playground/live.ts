/**
 * Live mode for the public replay page: a visitor switches from replay to typing
 * themselves, and completions run through the real pipeline (complete.ts) behind
 * limits. Platform-neutral: `handleLive()` takes a plain request and returns a plain
 * response; server.ts (local) and serverless.ts (Vercel) adapt it.
 *
 * Protections (Trent, 2026-09-29):
 *   - a small fixed model picker (LIVE_PRESETS), keys server-side only;
 *   - per visitor 100 completions/hour and 200/day, keyed on a salted hash of the IP;
 *   - a global daily spend cap (estimated cost, prices.ts), LIVE_DAILY_CAP_USD, default $5;
 *   - Cloudflare Turnstile once per visit, then a signed session token (1 h);
 *   - request size caps; content is never logged.
 * When a limit is hit the response says so and the page falls back to replay.
 * The provider-side spend limit on the API key is the backstop for all of this.
 *
 * Env: LIVE_ENABLED=1, LIVE_SESSION_SECRET (required when enabled), TURNSTILE_SECRET_KEY +
 * TURNSTILE_SITE_KEY (required unless LIVE_ALLOW_NO_TURNSTILE=1, for local use),
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (else in-memory: local only),
 * LIVE_DAILY_CAP_USD, and the providers' API keys.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { getPreset, isPresetAvailable } from '../src/providers/api/presets';
import { complete } from './complete';
import { hasPrice } from './prices';

export const LIVE_PRESETS = [
  'xai-grok',
  'anthropic-haiku',
  'openai-gpt-4.1-nano',
  'google-gemini-flash',
];
export const LIVE_DEFAULT_PRESET = 'xai-grok';
export const LIMITS = { perHour: 100, perDay: 200 };
const SESSION_TTL_S = 3600;
/** Accepted document size; complete() then truncates to the extension's window. */
const MAX_DOC_CHARS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;

// ─── Storage ──────────────────────────────────────────────────────────

export interface LiveStore {
  /** Increment an integer counter, setting its TTL when it is created. Returns the new value. */
  incr(key: string, ttlS: number): Promise<number>;
  incrByFloat(key: string, by: number, ttlS: number): Promise<number>;
  getFloat(key: string): Promise<number>;
}

/** Per-process store: correct for one local server, wrong for serverless (instances don't share it). */
export class MemoryStore implements LiveStore {
  private m = new Map<string, { v: number; exp: number }>();
  private live(key: string) {
    const e = this.m.get(key);
    if (e && e.exp < Date.now()) this.m.delete(key);
    return this.m.get(key);
  }
  async incr(key: string, ttlS: number) {
    return this.incrByFloat(key, 1, ttlS);
  }
  async incrByFloat(key: string, by: number, ttlS: number) {
    const e = this.live(key) ?? { v: 0, exp: Date.now() + ttlS * 1000 };
    e.v += by;
    this.m.set(key, e);
    return e.v;
  }
  async getFloat(key: string) {
    return this.live(key)?.v ?? 0;
  }
}

/** Upstash Redis over its REST API (no client library). */
export class UpstashStore implements LiveStore {
  constructor(
    private url: string,
    private token: string,
  ) {}
  private async pipeline(cmds: Array<Array<string | number>>): Promise<unknown[]> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
    const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    const err = out.find((r) => r.error);
    if (err) throw new Error(`upstash: ${err.error}`);
    return out.map((r) => r.result);
  }
  async incr(key: string, ttlS: number) {
    const [v] = await this.pipeline([
      ['INCR', key],
      ['EXPIRE', key, ttlS, 'NX'],
    ]);
    return Number(v);
  }
  async incrByFloat(key: string, by: number, ttlS: number) {
    const [v] = await this.pipeline([
      ['INCRBYFLOAT', key, by],
      ['EXPIRE', key, ttlS, 'NX'],
    ]);
    return Number(v);
  }
  async getFloat(key: string) {
    const [v] = await this.pipeline([['GET', key]]);
    return v === null || v === undefined ? 0 : Number(v);
  }
}

// ─── Config ───────────────────────────────────────────────────────────

export interface LiveConfig {
  enabled: boolean;
  sessionSecret: string;
  turnstileSecret?: string;
  turnstileSiteKey?: string;
  allowNoTurnstile: boolean;
  dailyCapUsd: number;
  ipSalt: string;
  store: LiveStore;
}

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const secret = env.LIVE_SESSION_SECRET ?? '';
  const store =
    env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? new UpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN)
      : new MemoryStore();
  return {
    enabled: env.LIVE_ENABLED === '1' && secret.length >= 32,
    sessionSecret: secret,
    turnstileSecret: env.TURNSTILE_SECRET_KEY || undefined,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || undefined,
    allowNoTurnstile: env.LIVE_ALLOW_NO_TURNSTILE === '1',
    dailyCapUsd: Number(env.LIVE_DAILY_CAP_USD ?? 5),
    ipSalt: secret,
    store,
  };
}

// ─── Sessions (signed, stateless) ─────────────────────────────────────

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSession(secret: string, nowS = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(
    JSON.stringify({ id: randomBytes(9).toString('base64url'), exp: nowS + SESSION_TTL_S }),
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(
  secret: string,
  token: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return false;
  const want = Buffer.from(sign(secret, payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > nowS;
  } catch {
    return false;
  }
}

async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { success?: boolean };
    return body.success === true;
  } catch {
    return false;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────

export interface LiveRequest {
  method: string;
  /** Path after the live prefix: "config", "session" or "complete". */
  route: string;
  body: unknown;
  ip: string;
  headers: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface LiveResponse {
  status: number;
  body: Record<string, unknown>;
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour = (d = new Date()) => d.toISOString().slice(0, 13);

function presetList() {
  return LIVE_PRESETS.map((id) => getPreset(id))
    .filter((p): p is NonNullable<typeof p> => !!p && isPresetAvailable(p) && hasPrice(p.modelId))
    .map((p) => ({ id: p.id, name: p.displayName, model: p.modelId }));
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function handleLive(cfg: LiveConfig, req: LiveRequest): Promise<LiveResponse> {
  const turnstileOn = !!(cfg.turnstileSecret && cfg.turnstileSiteKey);
  const usable = cfg.enabled && (turnstileOn || cfg.allowNoTurnstile);

  if (req.method === 'GET' && req.route === 'config') {
    if (!usable) return { status: 200, body: { enabled: false } };
    return {
      status: 200,
      body: {
        enabled: true,
        turnstileSiteKey: turnstileOn ? cfg.turnstileSiteKey : null,
        presets: presetList(),
        defaultPreset: LIVE_DEFAULT_PRESET,
        limits: LIMITS,
      },
    };
  }
  if (!usable) return { status: 404, body: { error: 'live mode is off' } };
  if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (req.route === 'session') {
    if (turnstileOn) {
      const ok = await verifyTurnstile(cfg.turnstileSecret!, str(body.turnstileToken), req.ip);
      if (!ok) return { status: 403, body: { error: 'verification failed', fallback: 'replay' } };
    }
    return { status: 200, body: { session: issueSession(cfg.sessionSecret), ttlS: SESSION_TTL_S } };
  }

  if (req.route !== 'complete') return { status: 404, body: { error: 'not found' } };

  if (!verifySession(cfg.sessionSecret, req.headers['x-live-session'] ?? '')) {
    return { status: 401, body: { error: 'session expired', renew: true } };
  }
  const presetId = str(body.presetId);
  if (!presetList().some((p) => p.id === presetId)) {
    return { status: 400, body: { error: 'model not offered' } };
  }
  const prefix = str(body.prefix);
  const suffix = str(body.suffix);
  if (prefix.length > MAX_DOC_CHARS || suffix.length > MAX_DOC_CHARS) {
    return { status: 413, body: { error: 'document too large' } };
  }

  // Global spend first: when the day's budget is gone, nobody gets a live call.
  const spendKey = `live:spend:${utcDay()}`;
  const spent = await cfg.store.getFloat(spendKey);
  if (spent >= cfg.dailyCapUsd) {
    return {
      status: 429,
      body: { error: "Today's live budget is used up. Replays still work.", fallback: 'replay' },
    };
  }
  const who = createHash('sha256')
    .update(cfg.ipSalt)
    .update(req.ip)
    .digest('base64url')
    .slice(0, 22);
  const hour = await cfg.store.incr(`live:h:${who}:${utcHour()}`, 3600);
  const day = await cfg.store.incr(`live:d:${who}:${utcDay()}`, 86_400);
  if (hour > LIMITS.perHour || day > LIMITS.perDay) {
    const which = day > LIMITS.perDay ? `${LIMITS.perDay} a day` : `${LIMITS.perHour} an hour`;
    return {
      status: 429,
      body: { error: `Live limit reached (${which}). Replays still work.`, fallback: 'replay' },
    };
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const ac = new AbortController();
  const abort = () => ac.abort();
  req.signal.addEventListener('abort', abort);
  timeout.addEventListener('abort', abort);
  try {
    const { response, events } = await complete(
      {
        presetId,
        prefix,
        suffix,
        languageId: str(body.languageId) || 'markdown',
        fileName: str(body.fileName) || 'untitled.md',
        sessionId: str(body.sessionId) || 'live',
        debounceMs:
          typeof body.debounceMs === 'number' ? Math.min(Math.max(0, body.debounceMs), 5000) : 0,
        label: 'live',
      },
      ac.signal,
    );
    if (response.costUsd) await cfg.store.incrByFloat(spendKey, response.costUsd, 2 * 86_400);
    return {
      status: 200,
      body: {
        ...response,
        events,
        remaining: { hour: LIMITS.perHour - hour, day: LIMITS.perDay - day },
      },
    };
  } finally {
    req.signal.removeEventListener('abort', abort);
    timeout.removeEventListener('abort', abort);
  }
}
