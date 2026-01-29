/**
 * Oracle latency benchmark — measures cold vs warm query timing
 * and explores process reuse strategies.
 *
 * Run: npx tsx src/test/oracle-latency.ts [model]
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
  sdkMs: number;
  apiMs: number;
  turns: number;
  tools: number;
  cost: number;
  chars: number;
}

function buildPrompt(filePath: string, fileContent: string): string {
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

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Oracle Latency Benchmark (model: ${model}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) {
    console.log('SDK does not export query()');
    process.exit(1);
  }

  const timings: Timing[] = [];

  // --- Test 1: Independent queries (current approach) ---
  console.log('--- Test 1: Independent query() calls ---\n');

  const files = [
    'src/utils/cache.ts',
    'src/utils/post-process.ts',
    'src/mode-detector.ts',
  ];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const content = fs.readFileSync(path.join(CWD, file), 'utf-8');
    const label = `independent-${i + 1} (${file})`;
    console.log(`  ${label}...`);

    const t = await timedQuery(queryFn, buildPrompt(file, content), {
      model,
      tools: ALLOWED_TOOLS,
    });
    timings.push({ label, ...t });
    console.log(`    ${t.wallMs}ms wall | ${t.sdkMs}ms sdk | ${t.apiMs}ms api | ${t.turns}t | ${t.tools} tools | $${t.cost.toFixed(4)}`);
  }

  // --- Test 2: Resumed session ---
  console.log('\n--- Test 2: Resume session (process reuse?) ---\n');

  // First query to establish a session
  const file0 = files[0];
  const content0 = fs.readFileSync(path.join(CWD, file0), 'utf-8');
  console.log(`  initial: ${file0}...`);
  const initial = await timedQueryWithSessionId(queryFn, buildPrompt(file0, content0), {
    model,
    tools: ALLOWED_TOOLS,
  });
  timings.push({ label: `resume-initial (${file0})`, ...initial.timing });
  console.log(`    ${initial.timing.wallMs}ms wall | session=${initial.sessionId}`);

  if (initial.sessionId) {
    for (let i = 1; i < files.length; i++) {
      const file = files[i];
      const content = fs.readFileSync(path.join(CWD, file), 'utf-8');
      const label = `resume-${i + 1} (${file})`;
      console.log(`  ${label}...`);

      const t = await timedQuery(queryFn, buildPrompt(file, content), {
        model,
        tools: ALLOWED_TOOLS,
        resume: initial.sessionId,
      });
      timings.push({ label, ...t });
      console.log(`    ${t.wallMs}ms wall | ${t.sdkMs}ms sdk | ${t.apiMs}ms api | ${t.turns}t | ${t.tools} tools`);
    }
  } else {
    console.log('  (no session ID returned, skipping resume tests)');
  }

  // --- Test 3: Minimal overhead query ---
  console.log('\n--- Test 3: Minimal overhead (no tools, no persist) ---\n');

  for (let i = 0; i < 3; i++) {
    const label = `minimal-${i + 1}`;
    console.log(`  ${label}...`);
    const t = await timedQuery(queryFn, 'Respond with just: {"status":"ready"}', {
      model,
      tools: [],
      persistSession: false,
    });
    timings.push({ label, ...t });
    console.log(`    ${t.wallMs}ms wall | ${t.sdkMs}ms sdk | ${t.apiMs}ms api`);
  }

  // --- Summary ---
  console.log('\n=== Summary ===\n');
  console.log('Label                                  | Wall ms | SDK ms  | API ms  | Turns | Tools | Cost');
  console.log('---------------------------------------|---------|---------|---------|-------|-------|-------');
  for (const t of timings) {
    const l = t.label.substring(0, 39).padEnd(39);
    const w = String(t.wallMs).padStart(7);
    const s = String(t.sdkMs).padStart(7);
    const a = String(t.apiMs).padStart(7);
    const tu = String(t.turns).padStart(5);
    const tc = String(t.tools).padStart(5);
    const c = ('$' + t.cost.toFixed(4)).padStart(7);
    console.log(`${l} | ${w} | ${s} | ${a} | ${tu} | ${tc} | ${c}`);
  }
}

interface QueryOpts {
  model: string;
  tools: string[];
  resume?: string;
  persistSession?: boolean;
}

async function timedQuery(
  queryFn: any,
  prompt: string,
  opts: QueryOpts,
): Promise<Timing> {
  const r = await timedQueryWithSessionId(queryFn, prompt, opts);
  return r.timing;
}

async function timedQueryWithSessionId(
  queryFn: any,
  prompt: string,
  opts: QueryOpts,
): Promise<{ timing: Timing; sessionId: string }> {
  const start = Date.now();

  const options: any = {
    model: opts.model,
    tools: opts.tools,
    allowedTools: opts.tools,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: SYSTEM_PROMPT,
    cwd: CWD,
    settingSources: [],
    maxThinkingTokens: 1024,
    maxTurns: 15,
  };

  if (opts.resume) {
    options.resume = opts.resume;
  }
  if (opts.persistSession === false) {
    options.persistSession = false;
  }

  const stream = queryFn({ prompt, options });

  let result = '';
  let turns = 0;
  let cost = 0;
  let sdkMs = 0;
  let apiMs = 0;
  let toolCount = 0;
  let sessionId = '';

  for await (const message of stream) {
    if (message.type === 'assistant') {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_use') { toolCount++; }
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success') {
        result = message.result ?? '';
      }
      turns = message.num_turns ?? 0;
      cost = message.total_cost_usd ?? 0;
      sdkMs = message.duration_ms ?? 0;
      apiMs = message.duration_api_ms ?? 0;
      sessionId = message.session_id ?? '';
    }
  }

  return {
    timing: {
      label: '',
      wallMs: Date.now() - start,
      sdkMs,
      apiMs,
      turns,
      tools: toolCount,
      cost,
      chars: result.length,
    },
    sessionId,
  };
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
