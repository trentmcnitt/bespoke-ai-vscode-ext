/**
 * Oracle smoke test — exercises the Agent SDK query() API end-to-end
 * and profiles cold vs warm latency.
 *
 * Run: npx tsx src/test/oracle-smoke.ts
 *
 * This is NOT part of the automated test suite. It requires:
 * - `claude` CLI installed and authenticated
 * - `@anthropic-ai/claude-agent-sdk` installed
 *
 * It uses query() (not sessions) to send analysis prompts with restricted
 * tools (Read, Grep, Glob only) and measures timing across multiple queries.
 */

import * as path from 'path';
import * as fs from 'fs';

const CWD = path.resolve(__dirname, '../..');

const SYSTEM_PROMPT = `You are a code analysis assistant that outputs structured JSON. You MUST output ONLY valid JSON with no other text, no markdown fences, no explanation.

You have access to Read, Grep, and Glob tools to explore the project.

Your output MUST match this EXACT schema — use these EXACT field names:

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
- imports: List each import/require with the module path and a brief description of what it provides
- typeContext: List type/interface signatures that are used or referenced in this file
- patterns: Note naming conventions, error handling patterns, architectural patterns
- relatedSymbols: List exported functions/classes from imported modules that this file uses
- projectSummary: One sentence describing the project based on what you can see
- ALL arrays must be present (use empty arrays if nothing found)
- Output ONLY the JSON object, nothing else`;

const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

interface QueryResult {
  text: string;
  durationMs: number;
  turns: number;
  toolCalls: string[];
  cost: number;
  sdkDurationMs: number;
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

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Oracle Latency Profile (model: ${model}) ===\n`);

  // Step 1: Load SDK
  console.log('1. Loading Agent SDK...');
  let sdk: any;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    console.log('   ✗ SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk');
    process.exit(1);
  }

  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) {
    console.log('   ✗ SDK does not export query()');
    process.exit(1);
  }
  console.log('   ✓ SDK loaded\n');

  // Step 2: Cold warmup — measures process spawn + init
  console.log('2. Cold warmup (trivial prompt, no tools)...');
  const warmup = await runQuery(queryFn, 'Respond with just the word "ready".', { model, tools: [] });
  console.log(`   ✓ "${warmup.text.trim()}" — ${warmup.durationMs}ms (SDK reports ${warmup.sdkDurationMs}ms)\n`);

  // Step 3: Analyze file #1 (first real query after warmup)
  const files = ['src/utils/cache.ts', 'src/providers/anthropic.ts', 'src/utils/post-process.ts'];
  const results: { file: string; result: QueryResult }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(CWD, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const label = i === 0 ? 'First analysis (post-warmup)' : `Analysis #${i + 1}`;

    console.log(`${i + 3}. ${label}: ${file}...`);
    const result = await runQuery(queryFn, buildAnalysisPrompt(file, content), { model });
    results.push({ file, result });

    // Validate JSON
    let parsed: any;
    try {
      let cleaned = result.text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch {
      console.log(`   ✗ Invalid JSON (${result.text.length} chars)`);
      console.log(`   Raw: ${result.text.substring(0, 200)}`);
      continue;
    }

    const imports = Array.isArray(parsed.imports) ? parsed.imports.length : 0;
    const types = Array.isArray(parsed.typeContext) ? parsed.typeContext.length : 0;
    const symbols = Array.isArray(parsed.relatedSymbols) ? parsed.relatedSymbols.length : 0;
    console.log(`   ✓ ${result.durationMs}ms | ${result.turns} turn(s) | ${result.toolCalls.length} tool calls | $${result.cost.toFixed(4)}`);
    console.log(`     ${imports} imports, ${types} types, ${symbols} symbols`);
    if (result.toolCalls.length > 0) {
      console.log(`     tools: ${result.toolCalls.join(', ')}`);
    }
    console.log();
  }

  // Summary table
  console.log('=== Latency Summary ===');
  console.log(`Model: ${model}`);
  console.log(`Warmup (cold): ${warmup.durationMs}ms`);
  console.log();
  console.log('File                          | Wall ms | SDK ms  | Turns | Tools | Cost');
  console.log('------------------------------|---------|---------|-------|-------|-------');
  for (const { file, result } of results) {
    const f = file.padEnd(30);
    const w = String(result.durationMs).padStart(7);
    const s = String(result.sdkDurationMs).padStart(7);
    const t = String(result.turns).padStart(5);
    const tc = String(result.toolCalls.length).padStart(5);
    const c = ('$' + result.cost.toFixed(4)).padStart(7);
    console.log(`${f}| ${w} | ${s} | ${t} | ${tc} | ${c}`);
  }

  const avgMs = results.reduce((sum, r) => sum + r.result.durationMs, 0) / results.length;
  console.log(`\nAverage analysis: ${Math.round(avgMs)}ms`);
  console.log(`\n=== DONE ===`);
}

async function runQuery(
  queryFn: any,
  prompt: string,
  opts: { model?: string; tools?: string[] } = {},
): Promise<QueryResult> {
  const tools = opts.tools ?? ALLOWED_TOOLS;
  const start = Date.now();

  const stream = queryFn({
    prompt,
    options: {
      model: opts.model ?? 'haiku',
      tools,
      allowedTools: tools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: SYSTEM_PROMPT,
      cwd: CWD,
      settingSources: [],
      maxThinkingTokens: 1024,
      maxTurns: 15,
    },
  });

  let result = '';
  let turns = 0;
  let cost = 0;
  let sdkDurationMs = 0;
  const toolCalls: string[] = [];

  for await (const message of stream) {
    if (message.type === 'assistant') {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          toolCalls.push(block.name);
        }
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success') {
        result = message.result ?? '';
      }
      turns = message.num_turns ?? 0;
      cost = message.total_cost_usd ?? 0;
      sdkDurationMs = message.duration_ms ?? 0;
    }
  }

  return {
    text: result,
    durationMs: Date.now() - start,
    turns,
    toolCalls,
    cost,
    sdkDurationMs,
  };
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
