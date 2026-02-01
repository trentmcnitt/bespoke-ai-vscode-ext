import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCache } from '../../utils/cache';

describe('LRUCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic operations', () => {
    it('stores and retrieves values', () => {
      const cache = new LRUCache();
      cache.set('k1', 'hello');
      expect(cache.get('k1')).toBe('hello');
    });

    it('returns null for missing keys', () => {
      const cache = new LRUCache();
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('overwrites existing keys', () => {
      const cache = new LRUCache();
      cache.set('k1', 'first');
      cache.set('k1', 'second');
      expect(cache.get('k1')).toBe('second');
    });

    it('clears all entries', () => {
      const cache = new LRUCache();
      cache.set('a', '1');
      cache.set('b', '2');
      cache.clear();
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently used entry when maxSize reached', () => {
      const cache = new LRUCache(2);
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3'); // evicts 'a'
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBe('2');
      expect(cache.get('c')).toBe('3');
    });

    it('promotes entries on read access', () => {
      const cache = new LRUCache(2);
      cache.set('a', '1');
      cache.set('b', '2');
      cache.get('a'); // promote 'a', now 'b' is LRU
      cache.set('c', '3'); // evicts 'b'
      expect(cache.get('a')).toBe('1');
      expect(cache.get('b')).toBeNull();
      expect(cache.get('c')).toBe('3');
    });

    it('promotes entries on write access', () => {
      const cache = new LRUCache(2);
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('a', 'updated'); // promote 'a', now 'b' is LRU
      cache.set('c', '3'); // evicts 'b'
      expect(cache.get('a')).toBe('updated');
      expect(cache.get('b')).toBeNull();
    });
  });

  describe('TTL expiration', () => {
    it('returns value before TTL expires', () => {
      const cache = new LRUCache(50, 1000);
      cache.set('k', 'val');
      vi.advanceTimersByTime(999);
      expect(cache.get('k')).toBe('val');
    });

    it('expires entry after TTL', () => {
      const cache = new LRUCache(50, 1000);
      cache.set('k', 'val');
      vi.advanceTimersByTime(1001);
      expect(cache.get('k')).toBeNull();
    });

    it('each entry has its own TTL timestamp', () => {
      const cache = new LRUCache(50, 1000);
      cache.set('a', '1');
      vi.advanceTimersByTime(500);
      cache.set('b', '2');
      vi.advanceTimersByTime(501); // 'a' is 1001ms old, 'b' is 501ms old
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBe('2');
    });
  });

  describe('makeKey', () => {
    it('creates deterministic keys', () => {
      const k1 = LRUCache.makeKey('prose', 'hello', 'world');
      const k2 = LRUCache.makeKey('prose', 'hello', 'world');
      expect(k1).toBe(k2);
    });

    it('differentiates by mode', () => {
      const k1 = LRUCache.makeKey('prose', 'hello', 'world');
      const k2 = LRUCache.makeKey('code', 'hello', 'world');
      expect(k1).not.toBe(k2);
    });

    it('truncates long prefixes to last 500 chars', () => {
      const longPrefix = 'x'.repeat(1000);
      const key = LRUCache.makeKey('code', longPrefix, '');
      expect(key).toBe(`code|${'x'.repeat(500)}|`);
    });

    it('truncates long suffixes to first 200 chars', () => {
      const longSuffix = 'y'.repeat(500);
      const key = LRUCache.makeKey('prose', 'prefix', longSuffix);
      expect(key).toBe(`prose|prefix|${'y'.repeat(200)}`);
    });

    it('handles empty prefix and suffix', () => {
      const key = LRUCache.makeKey('prose', '', '');
      expect(key).toBe('prose||');
    });
  });
});
