interface UsageEntry {
  time: number;
  model: string;
}

export interface UsageSnapshot {
  totalToday: number;
  ratePerMinute: number;
  byModel: Record<string, number>;
  isBurst: boolean;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  errors: number;
  sessionStartTime: number;
  totalInputChars: number;
  totalOutputChars: number;
}

export class UsageTracker {
  private entries: UsageEntry[] = [];
  private readonly rateWindowMs: number;
  private readonly burstThreshold: number;
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _errors = 0;
  private _inputChars = 0;
  private _outputChars = 0;
  readonly sessionStartTime: number;

  constructor(rateWindowMs = 5 * 60 * 1000, burstThreshold = 10) {
    this.rateWindowMs = rateWindowMs;
    this.burstThreshold = burstThreshold;
    this.sessionStartTime = Date.now();
  }

  record(model: string, inputChars?: number, outputChars?: number): void {
    this.entries.push({ time: Date.now(), model });
    if (inputChars !== undefined) {
      this._inputChars += inputChars;
    }
    if (outputChars !== undefined) {
      this._outputChars += outputChars;
    }
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

    const byModel: Record<string, number> = {};
    for (const entry of todayEntries) {
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
      byModel,
      isBurst: ratePerMinute >= this.burstThreshold,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheHitRate,
      errors: this._errors,
      sessionStartTime: this.sessionStartTime,
      totalInputChars: this._inputChars,
      totalOutputChars: this._outputChars,
    };
  }

  reset(): void {
    this.entries = [];
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._errors = 0;
    this._inputChars = 0;
    this._outputChars = 0;
  }
}
