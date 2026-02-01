import { ContextBrief } from './types';

interface StoredBrief {
  brief: ContextBrief;
  expiresAt: number;
}

export class ContextBriefStore {
  private store = new Map<string, StoredBrief>();
  private maxSize: number;

  constructor(
    private ttlMs: number,
    maxSize = 100,
  ) {
    this.maxSize = maxSize;
  }

  get(filePath: string): ContextBrief | null {
    const entry = this.store.get(filePath);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(filePath);
      return null;
    }
    return entry.brief;
  }

  set(filePath: string, brief: ContextBrief): void {
    this.store.set(filePath, {
      brief,
      expiresAt: Date.now() + this.ttlMs,
    });

    // Evict oldest entry by generatedAt if over capacity
    if (this.store.size > this.maxSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this.store) {
        if (entry.brief.generatedAt < oldestTime) {
          oldestTime = entry.brief.generatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.store.delete(oldestKey);
      }
    }
  }

  delete(filePath: string): void {
    this.store.delete(filePath);
  }

  has(filePath: string): boolean {
    const brief = this.get(filePath); // triggers TTL eviction
    return brief !== null;
  }

  clear(): void {
    this.store.clear();
  }

  updateTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }
}
