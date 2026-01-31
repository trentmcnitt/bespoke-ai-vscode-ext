/**
 * dump-prompts.ts — Dump the exact final prompt strings each provider/mode
 * combination sends to the model. Writes to prompt-dump.txt in the project root.
 *
 * Actual prompt content the model receives is wrapped in >>> / <<< fences.
 * Everything outside the fences is annotation/metadata.
 *
 * Usage:
 *   npm run dump-prompts                          # all 6 combinations
 *   npm run dump-prompts -- anthropic              # anthropic prose + code
 *   npm run dump-prompts -- ollama prose            # ollama prose only
 *   npm run dump-prompts -- claude-code code        # claude-code code only
 *   npm run dump-prompts -- prose                   # all providers, prose only
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PromptBuilder } from '../prompt-builder';
import { SYSTEM_PROMPT as CLAUDE_CODE_SYSTEM, buildFillMessage } from '../providers/claude-code';
import { makeConfig, makeProseContext, makeCodeContext } from '../test/helpers';
import { CompletionContext } from '../types';

const builder = new PromptBuilder();
const config = makeConfig();
const proseCtx = makeProseContext();
const codeCtx = makeCodeContext();

const DIVIDER = '='.repeat(72);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type Provider = 'anthropic' | 'ollama' | 'claude-code';
type Mode = 'prose' | 'code';

interface Combo { provider: Provider; mode: Mode; ctx: CompletionContext }

const ALL_COMBOS: Combo[] = [
  { provider: 'anthropic', mode: 'prose', ctx: proseCtx },
  { provider: 'anthropic', mode: 'code', ctx: codeCtx },
  { provider: 'ollama', mode: 'prose', ctx: proseCtx },
  { provider: 'ollama', mode: 'code', ctx: codeCtx },
  { provider: 'claude-code', mode: 'prose', ctx: proseCtx },
  { provider: 'claude-code', mode: 'code', ctx: codeCtx },
];

const PROVIDERS = new Set<string>(['anthropic', 'ollama', 'claude-code']);
const MODES = new Set<string>(['prose', 'code']);

function parseArgs(argv: string[]): Combo[] {
  const args = argv.slice(2).filter(a => a !== '--');

  if (args.length === 0) { return ALL_COMBOS; }

  let providerFilter: string | null = null;
  let modeFilter: string | null = null;

  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (PROVIDERS.has(lower)) {
      providerFilter = lower;
    } else if (MODES.has(lower)) {
      modeFilter = lower;
    } else {
      console.error(`Unknown argument: "${arg}". Expected a provider (${[...PROVIDERS].join(', ')}) or mode (prose, code).`);
      process.exit(1);
    }
  }

  return ALL_COMBOS.filter(c =>
    (!providerFilter || c.provider === providerFilter) &&
    (!modeFilter || c.mode === modeFilter),
  );
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
// Anthropic
// ---------------------------------------------------------------------------

function dumpAnthropic(ctx: CompletionContext): void {
  const p = builder.buildPrompt(ctx, config);

  out(DIVIDER);
  out(`ANTHROPIC — ${ctx.mode.toUpperCase()}`);
  out(DIVIDER);

  // Oracle brief
  out('\nSYSTEM BLOCK 1 (oracle brief — populated at runtime from file analysis):');
  out('  (not injected in this dump)');

  // Main system
  out('\nSYSTEM BLOCK 2 (main system):');
  prompt(p.system);

  const totalEstTokens = Math.ceil((p.system.length + p.userMessage.length) / 4);
  const cacheable = config.anthropic.useCaching && totalEstTokens >= 4096;
  out(`\n  cache_control: ${cacheable ? 'ephemeral' : 'disabled (useCaching=' + config.anthropic.useCaching + ', ~' + totalEstTokens + ' tokens)'}`);

  // Messages
  out('\nUSER MESSAGE:');
  prompt(p.userMessage);

  if (p.assistantPrefill) {
    out('\nASSISTANT PREFILL:');
    prompt(p.assistantPrefill);
  }

  // Parameters
  const filteredStops = p.stopSequences.filter(s => /\S/.test(s));

  out('\nPARAMETERS:');
  out(`  model:          ${config.anthropic.model}`);
  out(`  max_tokens:     ${p.maxTokens}`);
  out(`  temperature:    ${p.temperature}`);
  out(`  stop_sequences: ${JSON.stringify(filteredStops)}`);
  out();
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

function dumpOllama(ctx: CompletionContext): void {
  const p = builder.buildPrompt(ctx, config);

  const hasFimSuffix = ctx.mode === 'code' && p.suffix;
  const useRaw = hasFimSuffix ? false : config.ollama.raw;
  const promptText = hasFimSuffix ? ctx.prefix : p.userMessage;

  out(DIVIDER);
  out(`OLLAMA — ${ctx.mode.toUpperCase()} (raw=${useRaw}, fim=${!!hasFimSuffix})`);
  out(DIVIDER);

  out('\nPROMPT FIELD:');
  prompt(promptText);

  if (!useRaw && p.system) {
    out('\nSYSTEM FIELD:');
    prompt(p.system);
  } else if (useRaw) {
    out('\n  (raw mode — system prompt discarded by Ollama)');
  }

  if (hasFimSuffix && p.suffix) {
    out('\nSUFFIX FIELD (native FIM):');
    prompt(p.suffix);
  }

  out('\nPARAMETERS:');
  out(`  model:       ${config.ollama.model}`);
  out(`  raw:         ${useRaw}`);
  out(`  num_predict: ${p.maxTokens}`);
  out(`  temperature: ${p.temperature}`);
  out(`  stop:        ${JSON.stringify(p.stopSequences)}`);
  out(`  stream:      false`);
  out(`  keep_alive:  30m`);
  out();
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function dumpClaudeCode(ctx: CompletionContext): void {
  const modeConfig = ctx.mode === 'prose' ? config.prose : config.code;

  const message = buildFillMessage(ctx.prefix, ctx.suffix);

  out(DIVIDER);
  out(`CLAUDE CODE — ${ctx.mode.toUpperCase()}`);
  out(DIVIDER);

  out('\nSESSION SYSTEM PROMPT (set once at SDK init):');
  prompt(CLAUDE_CODE_SYSTEM);

  out('\nUSER MESSAGE (per-request):');
  prompt(message);

  out('\nPARAMETERS:');
  out(`  model:       ${config.claudeCode.model}`);
  out(`  max_tokens:  ${modeConfig.maxTokens}  (from config.${ctx.mode})`);
  out(`  temperature: ${modeConfig.temperature}  (from config.${ctx.mode})`);
  out();
}

// ---------------------------------------------------------------------------
// Dispatch + main
// ---------------------------------------------------------------------------

const DUMP_FN: Record<Provider, (ctx: CompletionContext) => void> = {
  'anthropic': dumpAnthropic,
  'ollama': dumpOllama,
  'claude-code': dumpClaudeCode,
};

const combos = parseArgs(process.argv);

const timestamp = new Date().toISOString();
const comboLabels = combos.map(c => `${c.provider}/${c.mode}`).join(', ');

out(`Prompt Dump`);
out(`Generated: ${timestamp}`);
out(`Combinations: ${comboLabels}`);
out(`Config: makeConfig() defaults from test helpers`);
out(`Legend: Text between >>> and <<< is the exact string the model receives.`);
out();

for (const combo of combos) {
  DUMP_FN[combo.provider](combo.ctx);
}

const outPath = path.resolve(__dirname, '../../prompt-dump.txt');
fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
console.log(`Wrote ${outPath}`);
