/**
 * Prompt variants for A/B testing different autocomplete prompt strategies.
 *
 * Each variant defines a complete prompt approach: system prompt, message
 * builder, and response extractor. Variants are tested against the same
 * scenarios to compare completion quality.
 *
 * Usage: PROMPT_VARIANTS=current npm run test:quality:compare
 */

export interface PromptVariant {
  /** Unique identifier for this variant. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Where this prompt originated. */
  source: string;
  /** System prompt for the Claude Code session. */
  systemPrompt: string;
  /** Build the per-request user message from document context. */
  buildMessage(prefix: string, suffix: string, mode: 'prose' | 'code', languageId: string): string;
  /** Extract the completion text from the model's raw response. */
  extractCompletion(raw: string, prefix: string, suffix: string): string | null;
  /** Build a warmup message to validate the session. */
  buildWarmupMessage(): string;
  /** Validate the warmup response. */
  validateWarmup(raw: string): boolean;
}

// ─── Shared helpers ────────────────────────────────────────────────

function extractBetweenTags(raw: string, openTag: string, closeTag: string): string | null {
  const openIdx = raw.indexOf(openTag);
  const closeIdx = raw.lastIndexOf(closeTag);
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) return null;
  return raw.slice(openIdx + openTag.length, closeIdx);
}

// ─── Variant: Current (baseline) ──────────────────────────────────
// Source: src/providers/claude-code.ts

import {
  SYSTEM_PROMPT as CURRENT_SYSTEM_PROMPT,
  buildFillMessage,
  extractCompletion,
  WARMUP_PREFIX,
  WARMUP_SUFFIX,
  WARMUP_EXPECTED,
} from '../../providers/claude-code';

const currentVariant: PromptVariant = {
  id: 'current',
  name: 'Current (Baseline)',
  source: 'Bespoke AI — src/providers/claude-code.ts',
  systemPrompt: CURRENT_SYSTEM_PROMPT,

  buildMessage(prefix, suffix, _mode, languageId) {
    return buildFillMessage(prefix, suffix, languageId);
  },

  extractCompletion(raw) {
    return extractCompletion(raw);
  },

  buildWarmupMessage() {
    return buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);
  },

  validateWarmup(raw) {
    const extracted = extractCompletion(raw);
    return extracted.trim().toLowerCase() === WARMUP_EXPECTED;
  },
};

// ─── Registry ─────────────────────────────────────────────────────

export const PROMPT_VARIANTS: Record<string, PromptVariant> = {
  current: currentVariant,
};

export function getVariant(id: string): PromptVariant | undefined {
  return PROMPT_VARIANTS[id];
}

export function getAllVariantIds(): string[] {
  return Object.keys(PROMPT_VARIANTS);
}
