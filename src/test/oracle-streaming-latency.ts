/**
 * Oracle streaming input latency benchmark — tests whether keeping
 * one query() alive with AsyncIterable<SDKUserMessage> gives us
 * fast warm responses.
 *
 * Run: npx tsx src/test/oracle-streaming-latency.ts [model]
 *
 * Requires: `claude` CLI installed + `@anthropic-ai/claude-agent-sdk`
 */

import * as path from 'path';
import * as fs from 'fs';

const CWD = path.resolve(__dirname, '../..');

const SYSTEM_PROMPT = `You are a code analysis assistant that outputs structured JSON. You MUST output ONLY valid JSON with no other text, no markdown fences, no explanation.

Your output MUST match this EXACT schema:

{
  "filePath": "<the file path given>",
  "generatedAt": <Date.now() timestamp>,
  "language": "<language ID>",
  "imports": [{ "module": "<import path>", "provides": "<what it provides>" }],
  "typeContext": [{ "name": "<type name>", "signature": "<type signature>" }],
  "patterns": ["<observed coding pattern>"],
  "relatedSymbols": [{ "name": "<symbol name>", "description": "<what it does>", "signature": "<type signature>" }],
  "projectSummary": "<one-sentence project description>"
}

Rules:
- ALL arrays must be present (use empty arrays if nothing found)
- Output ONLY the JSON object, nothing else`;

const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

interface Timing {
  label: string;
  wallMs: number;
  turns: number;
  toolCalls: string[];
  chars: number;
  validJson: boolean;
}

function buildAnalysisPrompt(filePath: string, fileContent: string): string {
  return `Analyze this file for inline completion context. The file content is below — do NOT re-read it.
Only use tools to look up imported modules' type signatures (Read the specific files referenced in imports). Do not explore broadly — be targeted.
Limit yourself to at most 3 tool calls total.

File: ${filePath}
Language: typescript

\`\`\`typescript
${fileContent}
\`\`\`

Now output ONLY the ContextBrief JSON. No other text.`;
}

/**
 * Creates a controllable async iterable that yields SDKUserMessages
 * on demand. Call push() to send a message, close() to end the stream.
 */
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
          if (resolve) {
            resolve({ value: undefined, done: true });
            resolve = null;
          }
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
        message: {
          role: 'user' as const,
          content: message,
        },
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
      if (resolve) {
        resolve({ value: undefined, done: true });
        resolve = null;
      }
    },
  };
}

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Streaming Input Latency Benchmark (model: ${model}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) {
    console.log('SDK does not export query()');
    process.exit(1);
  }

  const channel = createMessageChannel();
  const timings: Timing[] = [];

  // Push the first message BEFORE creating the query — the SDK may need
  // a value from the iterable to start the process.
  console.log('Seeding first message (warmup) into channel...');
  channel.push('Respond with just: {"status":"ready"}');

  console.log('Starting long-lived query()...\n');
  const overallStart = Date.now();

  const stream = queryFn({
    prompt: channel.iterable,
    options: {
      model,
      tools: ALLOWED_TOOLS,
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: SYSTEM_PROMPT,
      cwd: CWD,
      settingSources: [],
      maxThinkingTokens: 1024,
      maxTurns: 50,
      persistSession: false,
    },
  });

  // Track state for the background consumer
  let currentResultResolve: ((value: { text: string; turns: number; toolCalls: string[] }) => void) | null = null;
  let initReceived = false;
  let initResolve: (() => void) | null = null;
  const initPromise = new Promise<void>((r) => { initResolve = r; });

  // Background stream consumer
  const consumer = (async () => {
    let currentText = '';
    let currentTurns = 0;
    const currentTools: string[] = [];

    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          const elapsed = Date.now() - overallStart;
          console.log(`  [init] ${elapsed}ms — model=${message.model}, tools=[${message.tools?.join(', ')}]`);
          initReceived = true;
          initResolve?.();
          continue;
        }

        if (message.type === 'assistant') {
          const content = message.message?.content ?? [];
          for (const block of content) {
            if (block.type === 'tool_use') {
              currentTools.push(block.name);
            }
          }
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            currentText = message.result ?? '';
          }
          currentTurns = message.num_turns ?? 0;

          if (currentResultResolve) {
            currentResultResolve({
              text: currentText,
              turns: currentTurns,
              toolCalls: [...currentTools],
            });
            currentResultResolve = null;
          }
          currentText = '';
          currentTurns = 0;
          currentTools.length = 0;
        }
      }
    } catch (err: any) {
      console.log(`  [stream error] ${err.message}`);
    }

    // If someone is waiting for a result when the stream ends, resolve with empty
    if (currentResultResolve) {
      currentResultResolve({ text: '', turns: 0, toolCalls: [] });
    }
  })();

  // Wait for init (with timeout)
  const initTimeout = setTimeout(() => {
    if (!initReceived) {
      console.log('  ✗ Init not received after 30s, aborting');
      channel.close();
      process.exit(1);
    }
  }, 30000);

  await initPromise;
  clearTimeout(initTimeout);

  // Helper to wait for the current result
  function waitForResult(): Promise<{ text: string; turns: number; toolCalls: string[] }> {
    return new Promise((r) => {
      currentResultResolve = r;
    });
  }

  // --- Collect warmup result ---
  console.log('\n1. Warmup result...');
  const warmupStart = overallStart; // warmup was pushed before query started
  const warmupResult = await waitForResult();
  const warmupMs = Date.now() - warmupStart;
  console.log(`   ${warmupMs}ms (includes cold start)\n`);
  timings.push({
    label: 'warmup (cold)',
    wallMs: warmupMs,
    turns: warmupResult.turns,
    toolCalls: warmupResult.toolCalls,
    chars: warmupResult.text.length,
    validJson: false,
  });

  // --- Analyze files (warm process) ---
  const files = [
    'src/utils/cache.ts',
    'src/utils/post-process.ts',
    'src/mode-detector.ts',
    'src/utils/debouncer.ts',
  ];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const content = fs.readFileSync(path.join(CWD, file), 'utf-8');
    const label = `analysis-${i + 1} (${file})`;
    console.log(`${i + 2}. ${label}...`);

    const start = Date.now();
    const resultPromise = waitForResult();
    channel.push(buildAnalysisPrompt(file, content));
    const result = await resultPromise;
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

    const t: Timing = { label, wallMs, turns: result.turns, toolCalls: result.toolCalls, chars: result.text.length, validJson };
    timings.push(t);
    console.log(`   ${t.wallMs}ms | ${t.turns}t | ${t.toolCalls.length} tools | JSON: ${t.validJson ? 'valid' : 'INVALID'} | ${t.chars} chars`);
    if (t.toolCalls.length > 0) {
      console.log(`   tools: ${t.toolCalls.join(', ')}`);
    }
  }

  // --- Trivial warm prompts (to measure floor) ---
  console.log(`\n${files.length + 2}. Trivial warm prompts (3x)...`);
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const resultPromise = waitForResult();
    channel.push('Respond with just: {"status":"ok"}');
    await resultPromise;
    const ms = Date.now() - start;
    const label = `trivial-warm-${i + 1}`;
    timings.push({ label, wallMs: ms, turns: 0, toolCalls: [], chars: 0, validJson: false });
    console.log(`   ${label}: ${ms}ms`);
  }

  // Close and wait
  channel.close();
  await consumer;

  // --- Summary ---
  const totalElapsed = Date.now() - overallStart;
  console.log('\n=== Summary ===\n');
  console.log('Label                                    | Wall ms | Turns | Tools | JSON');
  console.log('-----------------------------------------|---------|-------|-------|-----');
  for (const t of timings) {
    const l = t.label.substring(0, 41).padEnd(41);
    const w = String(t.wallMs).padStart(7);
    const tu = String(t.turns).padStart(5);
    const tc = String(t.toolCalls.length).padStart(5);
    const j = (t.validJson ? 'yes' : '-').padStart(5);
    console.log(`${l} | ${w} | ${tu} | ${tc} | ${j}`);
  }

  const analyses = timings.filter(t => t.label.startsWith('analysis'));
  const trivials = timings.filter(t => t.label.startsWith('trivial'));
  const avgAnalysis = analyses.length > 0 ? analyses.reduce((s, t) => s + t.wallMs, 0) / analyses.length : 0;
  const avgTrivial = trivials.length > 0 ? trivials.reduce((s, t) => s + t.wallMs, 0) / trivials.length : 0;

  console.log(`\nCold start (warmup): ${timings[0].wallMs}ms`);
  console.log(`Avg warm analysis: ${Math.round(avgAnalysis)}ms`);
  console.log(`Avg warm trivial: ${Math.round(avgTrivial)}ms`);
  console.log(`Total session: ${totalElapsed}ms`);
  console.log(`\n=== DONE ===`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
