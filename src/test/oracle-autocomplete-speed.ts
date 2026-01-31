/**
 * Ultra-fast autocomplete speed test — minimal prompt, streaming input,
 * no tools, no thinking. Measures the raw floor for Claude Code autocomplete.
 *
 * Run: npx tsx src/test/oracle-autocomplete-speed.ts [model]
 */

import * as path from 'path';
import { createMessageChannel } from '../utils/message-channel';

const CWD = path.resolve(__dirname, '../..');

// Absolute minimal system prompt
const SYSTEM_PROMPT_MINIMAL = 'Continue the code. Output only the continuation, no explanation.';

// Slightly more structured but still tiny
const SYSTEM_PROMPT_FIM = 'You are an inline code completion engine. Output ONLY the code that comes next. No markdown, no explanation, no commentary.';

// No system prompt at all
const SYSTEM_PROMPT_NONE = '';

// Sample code prefixes of different sizes
const PREFIXES = {
  tiny: `function add(a: number, b: number): number {
  return `,

  small: `import { readFileSync } from 'fs';
import * as path from 'path';

interface Config {
  name: string;
  value: number;
  enabled: boolean;
}

function loadConfig(filePath: string): Config {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name ?? 'default',
    value: `,

  medium: `import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 50, ttlMs: number = 300000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, {
      value,
      expiresAt: `,
};

interface TestCase {
  label: string;
  systemPrompt: string;
  prefix: string;
  maxTokens?: number;
}

async function runSession(
  queryFn: any,
  model: string,
  systemPrompt: string,
  cases: { label: string; prefix: string; maxTokens?: number }[],
): Promise<{ label: string; wallMs: number; outputLen: number; output: string }[]> {
  const channel = createMessageChannel();
  const results: { label: string; wallMs: number; outputLen: number; output: string }[] = [];

  // Seed warmup
  channel.push('hi');

  const overallStart = Date.now();
  const stream = queryFn({
    prompt: channel.iterable,
    options: {
      model,
      tools: [],
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: systemPrompt || undefined,
      cwd: CWD,
      settingSources: [],
      maxThinkingTokens: 0,
      maxTurns: 50,
      persistSession: false,
    },
  });

  // Result promise machinery
  let resultResolve: ((v: { text: string }) => void) | null = null;

  const consumer = (async () => {
    try {
      for await (const message of stream) {
        if (message.type === 'result') {
          const text = message.subtype === 'success' ? (message.result ?? '') : '';
          if (resultResolve) {
            const r = resultResolve;
            resultResolve = null;
            r({ text });
          }
        }
      }
    } catch (err: any) {
      console.log(`  [error] ${err.message}`);
    }
    if (resultResolve) {
      resultResolve({ text: '' });
    }
  })();

  function waitResult(): Promise<{ text: string }> {
    return new Promise(r => { resultResolve = r; });
  }

  // Warmup
  const warmupResult = await waitResult();
  const warmupMs = Date.now() - overallStart;
  console.log(`  warmup: ${warmupMs}ms (cold start)\n`);

  // Run cases
  for (const c of cases) {
    const start = Date.now();
    const rp = waitResult();
    channel.push(c.prefix);
    const result = await rp;
    const wallMs = Date.now() - start;

    const output = result.text.substring(0, 200);
    results.push({ label: c.label, wallMs, outputLen: result.text.length, output });
    console.log(`  ${c.label}: ${wallMs}ms | ${result.text.length} chars`);
    console.log(`    → ${output.replace(/\n/g, '\\n').substring(0, 100)}`);
  }

  channel.close();
  await consumer;
  return results;
}

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Ultra-Fast Autocomplete Speed Test (model: ${model}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) { console.log('No query()'); process.exit(1); }

  // Test 1: Minimal system prompt, varying prefix sizes
  console.log('--- Test 1: Minimal system prompt, varying prefix sizes ---');
  const test1 = await runSession(queryFn, model, SYSTEM_PROMPT_MINIMAL, [
    { label: 'tiny prefix (2 lines)', prefix: PREFIXES.tiny },
    { label: 'small prefix (15 lines)', prefix: PREFIXES.small },
    { label: 'medium prefix (55 lines)', prefix: PREFIXES.medium },
    // Repeat tiny to check consistency
    { label: 'tiny prefix (repeat)', prefix: PREFIXES.tiny },
    { label: 'tiny prefix (repeat 2)', prefix: PREFIXES.tiny },
  ]);

  // Test 2: No system prompt at all
  console.log('\n--- Test 2: No system prompt ---');
  const test2 = await runSession(queryFn, model, SYSTEM_PROMPT_NONE, [
    { label: 'tiny prefix', prefix: PREFIXES.tiny },
    { label: 'small prefix', prefix: PREFIXES.small },
    { label: 'medium prefix', prefix: PREFIXES.medium },
  ]);

  // Test 3: FIM-style prompt
  console.log('\n--- Test 3: FIM-style prompt ---');
  const test3 = await runSession(queryFn, model, SYSTEM_PROMPT_FIM, [
    { label: 'tiny prefix', prefix: PREFIXES.tiny },
    { label: 'small prefix', prefix: PREFIXES.small },
    { label: 'medium prefix', prefix: PREFIXES.medium },
  ]);

  // Summary
  console.log('\n=== Summary ===\n');
  console.log('Test                                  | Wall ms | Output chars');
  console.log('--------------------------------------|---------|-------------');
  const allResults = [
    ...test1.map(r => ({ ...r, test: 'minimal-sys' })),
    ...test2.map(r => ({ ...r, test: 'no-sys' })),
    ...test3.map(r => ({ ...r, test: 'fim-sys' })),
  ];
  for (const r of allResults) {
    const l = `${r.test}/${r.label}`.substring(0, 38).padEnd(38);
    const w = String(r.wallMs).padStart(7);
    const c = String(r.outputLen).padStart(12);
    console.log(`${l} | ${w} | ${c}`);
  }

  const warmTimes = allResults.map(r => r.wallMs);
  console.log(`\nMin: ${Math.min(...warmTimes)}ms`);
  console.log(`Max: ${Math.max(...warmTimes)}ms`);
  console.log(`Avg: ${Math.round(warmTimes.reduce((s, v) => s + v, 0) / warmTimes.length)}ms`);

  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
