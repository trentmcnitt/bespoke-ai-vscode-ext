/**
 * Oracle inference tuning — tests different options to reduce model
 * inference time on the warm streaming path.
 *
 * Run: npx tsx src/test/oracle-inference-tuning.ts [model]
 *
 * Tests:
 * A) Baseline (current settings: maxThinkingTokens=1024, full schema)
 * B) maxThinkingTokens=0 (no thinking)
 * C) Structured output (outputFormat json_schema)
 * D) Minimal schema (fewer fields)
 * E) No tools (all context inline)
 */

import * as path from 'path';
import * as fs from 'fs';
import { ORACLE_SYSTEM_PROMPT } from '../oracle/context-oracle';

const CWD = path.resolve(__dirname, '../..');
const TARGET_FILE = 'src/utils/cache.ts';
const TARGET_CONTENT = fs.readFileSync(path.join(CWD, TARGET_FILE), 'utf-8');

const MINIMAL_SYSTEM_PROMPT = `Output ONLY valid JSON. No other text.

Schema: {"imports":[{"module":"<path>","provides":"<desc>"}],"typeContext":[{"name":"<name>","signature":"<sig>"}],"patterns":["<pattern>"]}`;

const FULL_SCHEMA = {
  type: 'object' as const,
  properties: {
    filePath: { type: 'string' },
    generatedAt: { type: 'number' },
    language: { type: 'string' },
    imports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          module: { type: 'string' },
          provides: { type: 'string' },
        },
        required: ['module', 'provides'],
      },
    },
    typeContext: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          signature: { type: 'string' },
        },
        required: ['name', 'signature'],
      },
    },
    patterns: {
      type: 'array',
      items: { type: 'string' },
    },
    relatedSymbols: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          signature: { type: 'string' },
        },
        required: ['name', 'description', 'signature'],
      },
    },
    projectSummary: { type: 'string' },
  },
  required: [
    'filePath',
    'generatedAt',
    'language',
    'imports',
    'typeContext',
    'patterns',
    'relatedSymbols',
    'projectSummary',
  ],
};

function buildPrompt(filePath: string, content: string): string {
  return `Analyze this file for inline completion context. The file content is below — do NOT re-read it. Do NOT use any tools.

File: ${filePath}
Language: typescript

\`\`\`typescript
${content}
\`\`\`

Output ONLY the JSON.`;
}

function buildMinimalPrompt(filePath: string, content: string): string {
  return `List imports, types, and patterns for this file. No tools. JSON only.

File: ${filePath}

\`\`\`typescript
${content}
\`\`\``;
}

interface TestConfig {
  label: string;
  systemPrompt: string;
  prompt: string;
  tools: string[];
  maxThinkingTokens: number;
  outputFormat?: any;
}

async function main() {
  const model = process.argv[2] || 'haiku';
  console.log(`=== Inference Tuning (model: ${model}, file: ${TARGET_FILE}) ===\n`);

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) {
    console.log('SDK does not export query()');
    process.exit(1);
  }

  const configs: TestConfig[] = [
    {
      label: 'A: Baseline (thinking=1024, tools, full prompt)',
      systemPrompt: ORACLE_SYSTEM_PROMPT,
      prompt: buildPrompt(TARGET_FILE, TARGET_CONTENT),
      tools: ['Read', 'Grep', 'Glob'],
      maxThinkingTokens: 1024,
    },
    {
      label: 'B: No thinking (maxThinkingTokens=0)',
      systemPrompt: ORACLE_SYSTEM_PROMPT,
      prompt: buildPrompt(TARGET_FILE, TARGET_CONTENT),
      tools: ['Read', 'Grep', 'Glob'],
      maxThinkingTokens: 0,
    },
    {
      label: 'C: No tools + no thinking',
      systemPrompt: ORACLE_SYSTEM_PROMPT,
      prompt: buildPrompt(TARGET_FILE, TARGET_CONTENT),
      tools: [],
      maxThinkingTokens: 0,
    },
    {
      label: 'D: Minimal prompt + no tools + no thinking',
      systemPrompt: MINIMAL_SYSTEM_PROMPT,
      prompt: buildMinimalPrompt(TARGET_FILE, TARGET_CONTENT),
      tools: [],
      maxThinkingTokens: 0,
    },
    {
      label: 'E: Structured output (json_schema) + no thinking',
      systemPrompt:
        'Analyze the given file and extract imports, types, patterns, and related symbols.',
      prompt: buildPrompt(TARGET_FILE, TARGET_CONTENT),
      tools: [],
      maxThinkingTokens: 0,
      outputFormat: { type: 'json_schema', schema: FULL_SCHEMA },
    },
  ];

  const results: {
    label: string;
    wallMs: number;
    chars: number;
    validJson: boolean;
    turns: number;
  }[] = [];

  for (const config of configs) {
    console.log(`${config.label}...`);

    const start = Date.now();
    const options: any = {
      model,
      tools: config.tools,
      allowedTools: config.tools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: config.systemPrompt,
      cwd: CWD,
      settingSources: [],
      maxThinkingTokens: config.maxThinkingTokens,
      maxTurns: 15,
      persistSession: false,
    };
    if (config.outputFormat) {
      options.outputFormat = config.outputFormat;
    }

    const stream = queryFn({ prompt: config.prompt, options });

    let resultText = '';
    let turns = 0;
    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result ?? '';
          // Check for structured_output
          if (message.structured_output) {
            resultText = JSON.stringify(message.structured_output);
          }
        }
        turns = message.num_turns ?? 0;
      }
    }
    const wallMs = Date.now() - start;

    let validJson = false;
    try {
      let cleaned = resultText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      }
      JSON.parse(cleaned);
      validJson = true;
    } catch {
      /* */
    }

    results.push({ label: config.label, wallMs, chars: resultText.length, validJson, turns });
    console.log(
      `  ${wallMs}ms | ${turns}t | ${resultText.length} chars | JSON: ${validJson ? 'valid' : 'INVALID'}`,
    );
    if (!validJson && resultText.length > 0) {
      console.log(`  preview: ${resultText.substring(0, 200)}`);
    }
    console.log();
  }

  // Summary
  console.log('=== Summary ===\n');
  console.log('Config                                           | Wall ms | Chars | JSON  | Turns');
  console.log('-------------------------------------------------|---------|-------|-------|------');
  for (const r of results) {
    const l = r.label.substring(0, 49).padEnd(49);
    const w = String(r.wallMs).padStart(7);
    const c = String(r.chars).padStart(5);
    const j = (r.validJson ? 'yes' : 'NO').padStart(5);
    const t = String(r.turns).padStart(5);
    console.log(`${l} | ${w} | ${c} | ${j} | ${t}`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
