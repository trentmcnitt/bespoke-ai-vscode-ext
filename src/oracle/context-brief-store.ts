import { ContextBrief } from './types';

interface StoredBrief {
  brief: ContextBrief;
  expiresAt: number;
}

export class ContextBriefStore {
  private store = new Map<string, StoredBrief>();

  constructor(private ttlMs: number) {}

  get(filePath: string): ContextBrief | null {
    const entry = this.store.get(filePath);
    if (!entry) { return null; }
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
