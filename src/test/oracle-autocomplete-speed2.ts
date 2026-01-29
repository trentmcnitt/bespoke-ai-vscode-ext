/**
 * Autocomplete speed test round 2 — focuses on the FIM-style prompt
 * with maxTokens capping, suffix context, and consistency measurement.
 *
 * Run: npx tsx src/test/oracle-autocomplete-speed2.ts [model]
 */

import * as path from 'path';

const CWD = path.resolve(__dirname, '../..');

const SYSTEM_PROMPT = 'You are an inline code completion engine. Output ONLY the code that comes next. No markdown, no explanation, no commentary. Do not repeat code already written.';

function createMessageChannel() {
  let resolve: ((value: IteratorResult<any>) => void) | null = null;
  let done = false;
  const pending: any[] = [];

  const iterable: AsyncIterable<any> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<any>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((r) => { resolve = r; });
        },
        return(): Promise<IteratorResult<any>> {
          done = true;
          if (resolve) { resolve({ value: undefined, done: true }); resolve = null; }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(message: string) {
      const msg = {
        type: 'user' as const,
        message: { role: 'user' as const, content: message },
        parent_tool_use_id: null,
        session_id: '',
      };
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        pending.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) { resolve({ value: undefined, done: true }); resolve = null; }
    },
  };
}

// FIM-style prompts with prefix + suffix
function prefixOnly(prefix: string): string {
  return prefix;
}

function prefixSuffix(prefix: string, suffix: string): string {
  return `${prefix}<CURSOR>${suffix}`;
}

const PREFIX_TINY = `function add(a: number, b: number): number {
  return `;

const PREFIX_SMALL = `import { readFileSync } from 'fs';

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
    value: `;

const SUFFIX_SMALL = `
    enabled: parsed.enabled ?? true,
  };
}

export function saveConfig(config: Config, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}`;

const PREFIX_MID = `export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  debounce(fn: () => void): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      `;

const SUFFIX_MID = `
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isPending(): boolean {
    return this.timer !== null;
  }
}`;

interface TestCase {
  label: string;
  prompt: string;
}

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Autocomplete Speed Test v2 (model: ${model}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) { console.log('No query()'); process.exit(1); }

  const channel = createMessageChannel();
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
      systemPrompt: SYSTEM_PROMPT,
      cwd: CWD,
      settingSources: [],
      maxThinkingTokens: 0,
      maxTurns: 50,
      persistSession: false,
    },
  });

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
    if (resultResolve) resultResolve({ text: '' });
  })();

  function waitResult(): Promise<{ text: string }> {
    return new Promise(r => { resultResolve = r; });
  }

  // Warmup
  await waitResult();
  const warmupMs = Date.now() - overallStart;
  console.log(`Cold start: ${warmupMs}ms\n`);

  const cases: TestCase[] = [
    // Prefix only
    { label: 'prefix-only/tiny', prompt: prefixOnly(PREFIX_TINY) },
    { label: 'prefix-only/small', prompt: prefixOnly(PREFIX_SMALL) },
    { label: 'prefix-only/mid', prompt: prefixOnly(PREFIX_MID) },
    // Prefix + suffix (FIM)
    { label: 'prefix+suffix/small', prompt: prefixSuffix(PREFIX_SMALL, SUFFIX_SMALL) },
    { label: 'prefix+suffix/mid', prompt: prefixSuffix(PREFIX_MID, SUFFIX_MID) },
    // Consistency check — same prompt 5x
    { label: 'consistency/1', prompt: prefixOnly(PREFIX_TINY) },
    { label: 'consistency/2', prompt: prefixOnly(PREFIX_TINY) },
    { label: 'consistency/3', prompt: prefixOnly(PREFIX_TINY) },
    { label: 'consistency/4', prompt: prefixOnly(PREFIX_TINY) },
    { label: 'consistency/5', prompt: prefixOnly(PREFIX_TINY) },
  ];

  const results: { label: string; wallMs: number; outputLen: number; output: string }[] = [];

  for (const c of cases) {
    const start = Date.now();
    const rp = waitResult();
    channel.push(c.prompt);
    const result = await rp;
    const wallMs = Date.now() - start;

    results.push({ label: c.label, wallMs, outputLen: result.text.length, output: result.text });
    const preview = result.text.replace(/\n/g, '\\n').substring(0, 80);
    console.log(`  ${c.label.padEnd(28)} ${String(wallMs).padStart(6)}ms | ${String(result.text.length).padStart(4)} chars | ${preview}`);
  }

  channel.close();
  await consumer;

  // Summary
  console.log('\n=== Summary ===\n');

  const consistency = results.filter(r => r.label.startsWith('consistency'));
  const cAvg = Math.round(consistency.reduce((s, r) => s + r.wallMs, 0) / consistency.length);
  const cMin = Math.min(...consistency.map(r => r.wallMs));
  const cMax = Math.max(...consistency.map(r => r.wallMs));
  const p50 = consistency.map(r => r.wallMs).sort((a, b) => a - b)[Math.floor(consistency.length / 2)];

  console.log(`Cold start: ${warmupMs}ms`);
  console.log(`Consistency (tiny prefix, 5 runs): avg=${cAvg}ms, min=${cMin}ms, max=${cMax}ms, p50=${p50}ms`);

  const nonConsistency = results.filter(r => !r.label.startsWith('consistency'));
  console.log('\nPer-case:');
  for (const r of nonConsistency) {
    console.log(`  ${r.label.padEnd(28)} ${String(r.wallMs).padStart(6)}ms | ${String(r.outputLen).padStart(4)} chars`);
  }

  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
