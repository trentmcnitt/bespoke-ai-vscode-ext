/**
 * Test V2 session API latency — measures cold start vs warm send().
 *
 * Run: npx tsx src/test/oracle-session-latency.ts [model]
 *
 * The V2 session keeps one process alive. We want to know if
 * subsequent send() calls avoid the ~5.5s spawn overhead.
 */

import * as path from 'path';
import * as fs from 'fs';

const CWD = path.resolve(__dirname, '../..');

interface Timing {
  label: string;
  wallMs: number;
  turns: number;
  tools: string[];
}

function buildPrompt(filePath: string, fileContent: string): string {
  return `You are a code analysis assistant. Output ONLY valid JSON, no markdown fences.

Analyze this file. The content is below — do NOT re-read it. Do NOT use any tools unless absolutely necessary to resolve a type signature from an import. Limit yourself to at most 2 tool calls.

Output this exact JSON schema:
{"filePath":"<path>","language":"<lang>","imports":[{"module":"<path>","provides":"<desc>"}],"typeContext":[{"name":"<name>","signature":"<sig>"}],"patterns":["<pattern>"],"relatedSymbols":[{"name":"<name>","description":"<desc>","signature":"<sig>"}],"projectSummary":"<summary>"}

File: ${filePath}
Language: typescript

\`\`\`typescript
${fileContent}
\`\`\`

Output ONLY the JSON.`;
}

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== V2 Session Latency Test (model: ${model}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const createSession = sdk.unstable_v2_createSession ?? sdk.default?.unstable_v2_createSession;
  if (!createSession) {
    console.log('SDK does not export unstable_v2_createSession()');
    process.exit(1);
  }

  const files = [
    'src/utils/cache.ts',
    'src/utils/post-process.ts',
    'src/mode-detector.ts',
    'src/utils/debouncer.ts',
  ];

  // Create session
  console.log('Creating session...');
  const sessionStart = Date.now();
  const session = createSession({ model });

  const timings: Timing[] = [];

  // Wait for init by draining the first system message
  const stream1 = session.stream();
  let initTools: string[] = [];
  for await (const msg of stream1) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      initTools = msg.tools ?? [];
      console.log(`  Session created in ${Date.now() - sessionStart}ms`);
      console.log(
        `  Tools loaded: ${initTools.length} (${initTools.slice(0, 5).join(', ')}${initTools.length > 5 ? '...' : ''})`,
      );
      console.log(`  Model: ${msg.model}`);
      console.log(`  Session ID: ${session.sessionId}\n`);
      break;
    }
  }

  // Send analysis prompts
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const content = fs.readFileSync(path.join(CWD, file), 'utf-8');
    const prompt = buildPrompt(file, content);
    const label = i === 0 ? `send-1 COLD (${file})` : `send-${i + 1} (${file})`;

    console.log(`  ${label}...`);
    const start = Date.now();
    await session.send(prompt);

    let resultText = '';
    let turns = 0;
    const tools: string[] = [];
    const stream = session.stream();

    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            tools.push(block.name);
          }
        }
      } else if (msg.type === 'result') {
        turns = msg.num_turns ?? 0;
        if (msg.subtype === 'success') {
          resultText = msg.result ?? '';
        }
        break;
      }
    }

    const wallMs = Date.now() - start;
    timings.push({ label, wallMs, turns, tools });

    // Validate JSON
    let valid = false;
    try {
      let cleaned = resultText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      }
      JSON.parse(cleaned);
      valid = true;
    } catch {
      /* */
    }

    console.log(
      `    ${wallMs}ms | ${turns} turn(s) | ${tools.length} tools | JSON: ${valid ? 'valid' : 'INVALID'} | ${resultText.length} chars`,
    );
    if (tools.length > 0) {
      console.log(`    tools: ${tools.join(', ')}`);
    }
  }

  session.close();

  // Summary
  console.log('\n=== Summary ===\n');
  console.log('Message | Wall ms | Turns | Tools');
  console.log('--------|---------|-------|------');
  for (const t of timings) {
    const l = t.label.substring(0, 40).padEnd(40);
    const w = String(t.wallMs).padStart(7);
    const tu = String(t.turns).padStart(5);
    const tc = String(t.tools.length).padStart(5);
    console.log(`${l} | ${w} | ${tu} | ${tc}`);
  }

  const avg = timings.reduce((s, t) => s + t.wallMs, 0) / timings.length;
  const avgWarm = timings.slice(1).reduce((s, t) => s + t.wallMs, 0) / (timings.length - 1);
  console.log(`\nAverage (all): ${Math.round(avg)}ms`);
  console.log(`Average (warm, 2nd+): ${Math.round(avgWarm)}ms`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
