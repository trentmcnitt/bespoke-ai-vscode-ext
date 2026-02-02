/**
 * dump-prompts.ts — Dump the exact final prompt strings the Claude Code provider
 * sends to the model. Writes to prompt-dump.txt in the project root.
 *
 * Usage:
 *   npm run dump-prompts                    # both modes
 *   npm run dump-prompts -- prose           # prose only
 *   npm run dump-prompts -- code            # code only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SYSTEM_PROMPT as CLAUDE_CODE_SYSTEM, buildFillMessage } from '../providers/claude-code';
import { makeConfig, makeProseContext, makeCodeContext } from '../test/helpers';
import { CompletionContext } from '../types';

const config = makeConfig();
const proseCtx = makeProseContext();
const codeCtx = makeCodeContext();

const DIVIDER = '='.repeat(72);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type Mode = 'prose' | 'code';

interface Combo {
  mode: Mode;
  ctx: CompletionContext;
}

const ALL_COMBOS: Combo[] = [
  { mode: 'prose', ctx: proseCtx },
  { mode: 'code', ctx: codeCtx },
];

const MODES = new Set<string>(['prose', 'code']);

function parseArgs(argv: string[]): Combo[] {
  const args = argv.slice(2).filter((a) => a !== '--');

  if (args.length === 0) {
    return ALL_COMBOS;
  }

  let modeFilter: string | null = null;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (MODES.has(lower)) {
      modeFilter = lower;
    } else {
      console.error(`Unknown argument: "${arg}". Expected a mode (prose, code).`);
      process.exit(1);
    }
  }

  return ALL_COMBOS.filter((c) => !modeFilter || c.mode === modeFilter);
}

// ---------------------------------------------------------------------------
// Output buffer
// ---------------------------------------------------------------------------

const lines: string[] = [];

function out(text = ''): void {
  lines.push(text);
}

/** Wrap literal prompt content in >>> / <<< fences */
function prompt(text: string): void {
  out('>>>');
  out(text);
  out('<<<');
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function dumpClaudeCode(ctx: CompletionContext): void {
  const modeConfig = ctx.mode === 'prose' ? config.prose : config.code;

  const { message, completionStart } = buildFillMessage(ctx.prefix, ctx.suffix);

  out(DIVIDER);
  out(`CLAUDE CODE — ${ctx.mode.toUpperCase()}`);
  out(DIVIDER);

  out('\nSESSION SYSTEM PROMPT (set once at SDK init):');
  prompt(CLAUDE_CODE_SYSTEM);

  out('\nUSER MESSAGE (per-request):');
  prompt(message);

  out('\nCOMPLETION START (model output must begin with this, then stripped):');
  prompt(completionStart);

  out('\nPARAMETERS:');
  out(`  model:        ${config.claudeCode.model}`);
  out(`  contextChars: ${modeConfig.contextChars}  (from config.${ctx.mode})`);
  out(`  suffixChars:  ${modeConfig.suffixChars}  (from config.${ctx.mode})`);
  out();
}

// ---------------------------------------------------------------------------
// Dispatch + main
// ---------------------------------------------------------------------------

const combos = parseArgs(process.argv);

const timestamp = new Date().toISOString();
const comboLabels = combos.map((c) => `claude-code/${c.mode}`).join(', ');

out(`Prompt Dump`);
out(`Generated: ${timestamp}`);
out(`Combinations: ${comboLabels}`);
out(`Config: makeConfig() defaults from test helpers`);
out(`Legend: Text between >>> and <<< is the exact string the model receives.`);
out();

for (const combo of combos) {
  dumpClaudeCode(combo.ctx);
}

const outPath = path.resolve(__dirname, '../../prompt-dump.txt');
fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
console.log(`Wrote ${outPath}`);
