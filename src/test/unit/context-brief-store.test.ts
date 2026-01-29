import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextBriefStore } from '../../oracle/context-brief-store';
import { ContextBrief } from '../../oracle/types';

function makeBrief(overrides: Partial<ContextBrief> = {}): ContextBrief {
  return {
    filePath: '/test/file.ts',
    generatedAt: Date.now(),
    language: 'typescript',
    imports: [{ module: './utils', provides: 'helper functions' }],
    typeContext: [{ name: 'Foo', signature: 'interface Foo { bar: string }' }],
    patterns: ['camelCase naming'],
    relatedSymbols: [{ name: 'doStuff', description: 'does stuff', signature: '() => void' }],
    projectSummary: 'A test project',
    ...overrides,
  };
}

describe('ContextBriefStore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns null for unknown keys', () => {
    const store = new ContextBriefStore(60000);
    expect(store.get('/nonexistent')).toBeNull();
  });

  it('stores and retrieves a brief', () => {
    const store = new ContextBriefStore(60000);
    const brief = makeBrief();
    store.set('/test/file.ts', brief);
    expect(store.get('/test/file.ts')).toEqual(brief);
  });

  it('evicts expired entries on get', () => {
    const store = new ContextBriefStore(5000);
    store.set('/test/file.ts', makeBrief());

    // Still valid before TTL
    vi.advanceTimersByTime(4999);
    expect(store.get('/test/file.ts')).not.toBeNull();

    // Expired after TTL
    vi.advanceTimersByTime(2);
    expect(store.get('/test/file.ts')).toBeNull();
  });

  it('has() returns false for expired entries', () => {
    const store = new ContextBriefStore(1000);
    store.set('/test/file.ts', makeBrief());
    expect(store.has('/test/file.ts')).toBe(true);

    vi.advanceTimersByTime(1001);
    expect(store.has('/test/file.ts')).toBe(false);
  });

  it('delete removes an entry', () => {
    const store = new ContextBriefStore(60000);
    store.set('/test/file.ts', makeBrief());
    store.delete('/test/file.ts');
    expect(store.get('/test/file.ts')).toBeNull();
  });

  it('clear removes all entries', () => {
    const store = new ContextBriefStore(60000);
    store.set('/a.ts', makeBrief({ filePath: '/a.ts' }));
    store.set('/b.ts', makeBrief({ filePath: '/b.ts' }));
    store.clear();
    expect(store.get('/a.ts')).toBeNull();
    expect(store.get('/b.ts')).toBeNull();
  });

  it('updateTtl affects subsequent entries', () => {
    const store = new ContextBriefStore(10000);
    store.set('/old.ts', makeBrief({ filePath: '/old.ts' }));

    store.updateTtl(1000);
    store.set('/new.ts', makeBrief({ filePath: '/new.ts' }));

    // Old entry uses original TTL (10s)
    vi.advanceTimersByTime(1001);
    expect(store.get('/old.ts')).not.toBeNull();
    // New entry uses updated TTL (1s) — already expired
    expect(store.get('/new.ts')).toBeNull();
  });
});
