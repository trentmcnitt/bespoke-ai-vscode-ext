interface CacheEntry {
  value: string;
  timestamp: number;
}

export class LRUCache {
  private map = new Map<string, CacheEntry>();

  constructor(
    private maxSize: number = 50,
    private ttlMs: number = 5 * 60 * 1000
  ) {}

  static makeKey(mode: string, prefix: string, suffix: string): string {
    return `${mode}|${prefix.slice(-500)}|${suffix.slice(0, 200)}`;
  }

  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) { return null; }

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    // Delete first to update insertion order
    this.map.delete(key);

    if (this.map.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }

    this.map.set(key, { value, timestamp: Date.now() });
  }

  clear(): void {
    this.map.clear();
  }
}
