import { CompletionContext } from '../../types';
import { Preset } from './types';

/**
 * System prompt for prefill-capable models (Anthropic Haiku/Sonnet).
 *
 * With prefill, the assistant message already contains the tail of the prefix.
 * The model's response naturally continues from there — no echo-back needed.
 * This is much simpler than Claude Code's <completion_start> mechanism.
 */
export const PREFILL_SYSTEM_PROMPT = `You are an inline autocomplete engine embedded in a text editor. Your ONLY job is to predict what the author types next at the cursor position.

You receive the document with a [CURSOR] marker. Your response continues directly from the prefilled text — output ONLY the new text to insert. No tags, no fences, no commentary.

Rules:
- Output raw continuation text only — no wrapping, no markup, no explanation
- You are predicting what the AUTHOR writes next. NEVER respond as an assistant. NEVER acknowledge, summarize, or reply to the content
- NEVER use phrases like: "Sure", "Here's", "Got it", "I see", "Understood", "Great", "The completion is"
- If the text reads like someone giving instructions, continue AS that person — their next thought, their next sentence
- Match the voice, style, tone, and formatting of the existing text exactly
- Focus on what belongs at the cursor — ignore errors or incomplete text elsewhere in the document
- If there is text after [CURSOR], bridge to it naturally — do not repeat or overwrite what follows
- If there is no text after [CURSOR], continue for 1-2 sentences (prose) or a few lines (code)
- NEVER close a structure (bracket, brace, comment block, tag) if the suffix shows it continues
- Preserve whitespace patterns (indentation, blank lines) exactly as the surrounding text uses them`;

/**
 * System prompt for non-prefill models (OpenAI, xAI/Grok, Ollama, Gemini).
 *
 * Without prefill, we cannot seed the assistant's response. The model must be
 * explicitly told to output ONLY the continuation text. This prompt is more
 * forceful about the "no preamble" constraint since these models are more
 * prone to chatty responses.
 */
export const NON_PREFILL_SYSTEM_PROMPT = `You are an inline autocomplete engine embedded in a text editor. You receive a document with a [CURSOR] marker showing the insertion point. Output ONLY the raw text that should be inserted at [CURSOR]. Nothing else.

CRITICAL RULES:
1. Output ONLY the continuation text — no tags, no code fences, no quotes, no explanation, no preamble
2. Your very first character must be part of the actual completion. Do NOT start with "Here", "Sure", newlines, or any lead-in
3. You are predicting what the AUTHOR writes next. NEVER respond as an assistant. NEVER acknowledge, summarize, or reply
4. If the text reads like instructions or a conversation, continue AS that same speaker
5. Match voice, style, tone, and formatting exactly
6. If text follows [CURSOR], bridge to it — do not repeat what comes after
7. If nothing follows [CURSOR], continue naturally for 1-2 sentences (prose) or a few lines (code)
8. Do NOT close structures (brackets, braces, comments) that the suffix shows continuing
9. Focus on the cursor position — ignore errors or incomplete content elsewhere
10. Preserve indentation and whitespace patterns exactly`;

/** Number of characters to extract from the end of the prefix as the prefill anchor. */
const PREFILL_ANCHOR_LENGTH = 40;

/**
 * Extract an anchor string from the end of the prefix for assistant prefill.
 * Returns the last N characters, snapped to a word boundary when possible.
 *
 * A longer anchor (40 chars vs 10 in Claude Code) works better for direct API
 * because there's no echo-back mechanism — the model just continues from it.
 * The anchor gives the model a running start so it doesn't lose context.
 */
export function extractPrefillAnchor(prefix: string, maxLength = PREFILL_ANCHOR_LENGTH): string {
  if (!prefix) return '';

  // Anthropic's API rejects assistant messages with trailing whitespace.
  // Trim the prefix before extracting the anchor.
  const trimmed = prefix.trimEnd();
  if (!trimmed) return '';

  if (trimmed.length <= maxLength) return trimmed;

  const start = trimmed.length - maxLength;
  // Try to snap to a word boundary (space or newline) to avoid splitting tokens
  for (let i = start; i < Math.min(trimmed.length, start + 15); i++) {
    if (trimmed[i] === ' ' || trimmed[i] === '\n') {
      return trimmed.slice(i + 1);
    }
  }
  return trimmed.slice(start);
}

export interface PromptMessages {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Build prompt messages for a given completion context and preset.
 *
 * Two strategies:
 *
 * **With prefill** (Anthropic Haiku/Sonnet):
 * - System: autocomplete instructions
 * - User: `<document>{prefix}[CURSOR]{suffix}</document>` + brief instruction
 * - Assistant (prefill): last ~40 chars of prefix (the model continues from here)
 *
 * **Without prefill** (OpenAI, xAI, Gemini, Ollama):
 * - System: strong "output ONLY continuation" instructions
 * - User: `<document>{prefix}[CURSOR]{suffix}</document>` + forceful instruction
 *
 * The document block always uses `<document>` tags for clear context boundaries.
 */
export function buildApiPrompt(context: CompletionContext, preset: Preset): PromptMessages {
  const { prefix, suffix, mode } = context;
  const hasPrefill = preset.features?.prefill === true;

  const documentBlock = suffix.trim()
    ? `<document>\n${prefix}[CURSOR]${suffix}\n</document>`
    : `<document>\n${prefix}[CURSOR]\n</document>`;

  const modeHint =
    mode === 'code'
      ? 'This is source code. Continue with syntactically valid code that fits the language and style.'
      : 'This is prose/text. Continue naturally in the same voice and style.';

  if (hasPrefill) {
    const anchor = extractPrefillAnchor(prefix);
    return {
      system: PREFILL_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${documentBlock}\n\n${modeHint}\nContinue from [CURSOR]. Output only the new text.`,
        },
        { role: 'assistant', content: anchor },
      ],
    };
  }

  return {
    system: NON_PREFILL_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${documentBlock}\n\n${modeHint}\nOutput ONLY the raw text to insert at [CURSOR]. No explanation, no wrapping, no preamble. Start directly with the continuation text.`,
      },
    ],
  };
}
