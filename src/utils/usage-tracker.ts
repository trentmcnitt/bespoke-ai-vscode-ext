import { Backend } from '../types';

interface UsageEntry {
  time: number;
  backend: Backend;
  model: string;
}

/** Per million tokens pricing for Anthropic models. */
interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  'haiku-4-5': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'haiku-4.5': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  sonnet: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'opus-4.5': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
};

const DEFAULT_PRICING: ModelPricing = ANTHROPIC_PRICING['haiku-4-5'];

function getPricing(model: string): ModelPricing {
  const lower = model.toLowerCase();
  for (const [fragment, pricing] of Object.entries(ANTHROPIC_PRICING)) {
    if (lower.includes(fragment)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
}

export interface UsageSnapshot {
  totalToday: number;
  ratePerMinute: number;
  byBackend: Partial<Record<Backend, number>>;
  byModel: Record<string, number>;
  isBurst: boolean;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  errors: number;
  sessionStartTime: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  estimatedCostUsd: number;
}

export class UsageTracker {
  private entries: UsageEntry[] = [];
  private readonly rateWindowMs: number;
  private readonly burstThreshold: number;
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _errors = 0;
  private _tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private _costUsd = 0;
  readonly sessionStartTime: number;

  constructor(rateWindowMs = 5 * 60 * 1000, burstThreshold = 10) {
    this.rateWindowMs = rateWindowMs;
    this.burstThreshold = burstThreshold;
    this.sessionStartTime = Date.now();
  }

  record(backend: Backend, model: string): void {
    this.entries.push({ time: Date.now(), backend, model });
  }

  recordCacheHit(): void {
    this._cacheHits++;
  }

  recordCacheMiss(): void {
    this._cacheMisses++;
  }

  recordError(): void {
    this._errors++;
  }

  recordTokens(
    model: string,
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
  ): void {
    this._tokens.input += input;
    this._tokens.output += output;
    this._tokens.cacheRead += cacheRead;
    this._tokens.cacheWrite += cacheWrite;

    const pricing = getPricing(model);
    this._costUsd += (input / 1_000_000) * pricing.input;
    this._costUsd += (output / 1_000_000) * pricing.output;
    this._costUsd += (cacheRead / 1_000_000) * pricing.cacheRead;
    this._costUsd += (cacheWrite / 1_000_000) * pricing.cacheWrite;
  }

  getSnapshot(): UsageSnapshot {
    const now = Date.now();

    // Midnight today in local time
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const midnightMs = todayStart.getTime();

    const todayEntries = this.entries.filter((e) => e.time >= midnightMs);
    const windowStart = now - this.rateWindowMs;
    const windowEntries = this.entries.filter((e) => e.time >= windowStart);

    const windowMinutes = this.rateWindowMs / 60_000;
    const ratePerMinute = windowEntries.length / windowMinutes;

    const byBackend: Partial<Record<Backend, number>> = {};
    const byModel: Record<string, number> = {};
    for (const entry of todayEntries) {
      byBackend[entry.backend] = (byBackend[entry.backend] ?? 0) + 1;
      byModel[entry.model] = (byModel[entry.model] ?? 0) + 1;
    }

    const totalCacheLookups = this._cacheHits + this._cacheMisses;
    const cacheHitRate =
      totalCacheLookups > 0 ? Math.round((this._cacheHits / totalCacheLookups) * 100) : 0;

    // Prune entries older than midnight to bound memory
    this.entries = this.entries.filter((e) => e.time >= midnightMs);

    return {
      totalToday: todayEntries.length,
      ratePerMinute: Math.round(ratePerMinute * 10) / 10,
      byBackend,
      byModel,
      isBurst: ratePerMinute >= this.burstThreshold,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheHitRate,
      errors: this._errors,
      sessionStartTime: this.sessionStartTime,
      tokens: { ...this._tokens },
      estimatedCostUsd: Math.round(this._costUsd * 1000) / 1000,
    };
  }

  reset(): void {
    this.entries = [];
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._errors = 0;
    this._tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this._costUsd = 0;
  }
}
