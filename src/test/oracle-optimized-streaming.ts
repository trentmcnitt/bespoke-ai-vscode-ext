/**
 * Oracle optimized streaming benchmark — combines streaming input
 * (warm process) with optimized inference settings.
 *
 * Run: npx tsx src/test/oracle-optimized-streaming.ts [model]
 *
 * Based on findings:
 * - Streaming input eliminates ~5.5s spawn overhead on warm queries
 * - maxThinkingTokens=0 saves ~3.2s
 * - No tools saves ~0.5s
 * - Shorter prompt/schema saves more
 */

import * as path from 'path';
import * as fs from 'fs';
import { createMessageChannel } from '../utils/message-channel';

const CWD = path.resolve(__dirname, '../..');

// Compact system prompt — minimal tokens, clear schema
const SYSTEM_PROMPT = `Output ONLY valid JSON matching this schema. No other text, no markdown fences.

{"filePath":"<path>","language":"<lang>","imports":[{"module":"<path>","provides":"<desc>"}],"typeContext":[{"name":"<name>","signature":"<sig>"}],"patterns":["<pattern>"],"relatedSymbols":[{"name":"<name>","description":"<desc>","signature":"<sig>"}],"projectSummary":"<summary>"}

All arrays required (use [] if empty).`;

function buildPrompt(filePath: string, content: string): string {
  return `Analyze this TypeScript file. Extract imports, type signatures, patterns, and related symbols. Do NOT use any tools.

File: ${filePath}

\`\`\`typescript
${content}
\`\`\`

JSON only.`;
}

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Optimized Streaming Benchmark (model: ${model}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) { process.exit(1); }

  const channel = createMessageChannel();

  // Seed warmup before starting query
  channel.push('Respond: {"status":"ready"}');

  const overallStart = Date.now();
  const stream = queryFn({
    prompt: channel.iterable,
    options: {
      model,
      tools: [],              // No tools — all context is inline
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: SYSTEM_PROMPT,
      cwd: CWD,
      settingSources: [],
      maxThinkingTokens: 0,   // No thinking
      maxTurns: 50,
      persistSession: false,
    },
  });

  // Background consumer
  let resultResolve: ((v: { text: string; turns: number }) => void) | null = null;
  const consumer = (async () => {
    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          console.log(`  [init] ${Date.now() - overallStart}ms — tools=[${message.tools?.join(', ') || 'none'}]`);
        }
        if (message.type === 'result') {
          const text = message.subtype === 'success' ? (message.result ?? '') : '';
          const turns = message.num_turns ?? 0;
          if (resultResolve) {
            const r = resultResolve;
            resultResolve = null;
            r({ text, turns });
          }
        }
      }
    } catch (err: any) {
      console.log(`  [error] ${err.message}`);
    }
    if (resultResolve) {
      resultResolve({ text: '', turns: 0 });
    }
  })();

  function waitResult(): Promise<{ text: string; turns: number }> {
    return new Promise(r => { resultResolve = r; });
  }

  // Warmup
  console.log('1. Warmup (cold start)...');
  const warmupResult = await waitResult();
  const warmupMs = Date.now() - overallStart;
  console.log(`   ${warmupMs}ms (cold)\n`);

  // Analyze files
  const files = [
    'src/utils/cache.ts',
    'src/utils/post-process.ts',
    'src/mode-detector.ts',
    'src/utils/debouncer.ts',
    'src/utils/context-builder.ts',
    'src/prompt-builder.ts',
  ];

  interface Result {
    file: string;
    wallMs: number;
    chars: number;
    validJson: boolean;
    turns: number;
  }
  const results: Result[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const content = fs.readFileSync(path.join(CWD, file), 'utf-8');
    process.stdout.write(`${i + 2}. ${file}... `);

    const start = Date.now();
    const rp = waitResult();
    channel.push(buildPrompt(file, content));
    const result = await rp;
    const wallMs = Date.now() - start;

    let validJson = false;
    try {
      let cleaned = result.text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      }
      JSON.parse(cleaned);
      validJson = true;
    } catch { /* */ }

    results.push({ file, wallMs, chars: result.text.length, validJson, turns: result.turns });
    console.log(`${wallMs}ms | ${result.text.length} chars | JSON: ${validJson ? '✓' : '✗'}`);
  }

  channel.close();
  await consumer;

  // Summary
  const totalMs = Date.now() - overallStart;
  const validResults = results.filter(r => r.validJson);
  const avg = validResults.length > 0
    ? Math.round(validResults.reduce((s, r) => s + r.wallMs, 0) / validResults.length)
    : 0;
  const min = validResults.length > 0 ? Math.min(...validResults.map(r => r.wallMs)) : 0;
  const max = validResults.length > 0 ? Math.max(...validResults.map(r => r.wallMs)) : 0;

  console.log('\n=== Summary ===');
  console.log(`Model: ${model}`);
  console.log(`Settings: no tools, no thinking, minimal prompt`);
  console.log(`Cold start: ${warmupMs}ms`);
  console.log(`Warm analysis: avg=${avg}ms, min=${min}ms, max=${max}ms`);
  console.log(`Valid JSON: ${validResults.length}/${results.length}`);
  console.log(`Total session: ${totalMs}ms`);

  console.log('\nPer-file:');
  for (const r of results) {
    const f = r.file.padEnd(35);
    const w = String(r.wallMs).padStart(6);
    const j = r.validJson ? '✓' : '✗';
    console.log(`  ${f} ${w}ms  ${j}`);
  }

  console.log('\n=== DONE ===');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
