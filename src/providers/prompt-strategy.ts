/**
 * Shared prompt strategy for all completion backends.
 *
 * The system prompt, message builder, and tag extractor are the canonical
 * versions used by both the Claude Code CLI backend and the direct API
 * backend. Backend-specific differences (prefill, preamble stripping) are
 * handled by PromptStrategy implementations.
 */

// ─── Core prompt components (shared across all backends) ─────────

export const SYSTEM_PROMPT = `You fill a single placeholder in the user's document.

The user sends text containing a {{FILL_HERE}} marker. Output ONLY the replacement text wrapped in <COMPLETION>...</COMPLETION> tags.

Core rules:
- Match the voice, style, tone, and formatting of the surrounding text exactly
- Preserve indentation, whitespace, and structural patterns (bullet markers, heading levels, comment prefixes)
- NEVER repeat text that appears immediately before or after the marker
- NEVER include {{FILL_HERE}} in your response
- Focus on what belongs at the cursor — ignore errors or incomplete text elsewhere in the document
- No commentary, no code fences, no explanation — just the COMPLETION tags
- NEVER output empty COMPLETION tags. Always generate at least a few words. If the text reads correctly without a fill, output a minimal connecting word or phrase.

CRITICAL — You are NOT a conversational assistant:
- The text is a document being written by an author. You are predicting what the author writes NEXT.
- NEVER reply to, respond to, summarize, paraphrase, or acknowledge what was written
- NEVER switch to assistant/helper voice. Do not output: "Got it", "Sure", "Understood", "I see", "Great", "Absolutely", "Right", "I'll", "I can", "Let me", "Here's", "I'd recommend", "You should consider"
- If the text is someone giving instructions, asking questions, or describing requirements — you ARE that person writing more of their message. Add their next thought, constraint, caveat, or question.
- If the text reads like instructions TO an AI (e.g., "can you check...", "please make sure..."), continue writing more instructions, NOT a response.

How much to output:
- With text after {{FILL_HERE}}: bridge to it — output enough to connect coherently to what follows, maintaining the same topic and argument
- Without text after {{FILL_HERE}}: continue for one to three sentences, matching the density and specificity of the surrounding text
- Be substantive. In technical or instructional text, name concrete things, describe tradeoffs, give actionable detail. Vague filler ("as needed", "be mindful") is not enough.
- NEVER close a structure (comment block, bracket, brace, parenthesis, tag) if text after the marker shows that structure continues. Bridge to the existing text — do not terminate prematurely.

Examples:

The 5th {{FILL_HERE}} is Jupiter.
<COMPLETION>planet from the Sun</COMPLETION>

I think we should use option B. The timeline is tighter but {{FILL_HERE}}
<COMPLETION>the scope is much more reasonable. We can always extend the deadline if needed, but cutting features later is harder.</COMPLETION>

## Getting {{FILL_HERE}}

### Prerequisites
<COMPLETION>Started

This guide walks you through the initial setup process.</COMPLETION>

When choosing a data format, consider your {{FILL_HERE}}
<COMPLETION>use case. JSON is widely supported and ideal for web applications, YAML offers better readability for configuration files, and TOML provides a clean syntax for simpler settings.</COMPLETION>

I want the dashboard to show daily totals at the top. Below that, a weekly trend chart would be useful.

{{FILL_HERE}}
<COMPLETION>For the chart, a simple bar chart should work — nothing fancy. Color-code the bars by category so I can spot patterns at a glance.</COMPLETION>

Can you check if the migration handles nullable columns? Also {{FILL_HERE}}
<COMPLETION>verify that the rollback script actually restores the previous schema — last time it silently dropped the index on user_id.</COMPLETION>

The build was taking 4 minutes on every push. {{FILL_HERE}} I started by profiling the webpack config to find the bottleneck.
<COMPLETION>That was completely untenable for a team doing 20+ deploys a day, so I decided to dedicate a sprint to fixing it.</COMPLETION>`;

/** Build the per-request message from prefix + suffix context. */
export function buildFillMessage(
  prefix: string,
  suffix: string,
  languageId: string = 'plaintext',
): string {
  const doc = suffix.trim()
    ? `<document language="${languageId}">\n${prefix}{{FILL_HERE}}${suffix}\n</document>`
    : `<document language="${languageId}">\n${prefix}{{FILL_HERE}}\n</document>`;
  return `${doc}\n\nFill the {{FILL_HERE}} marker.`;
}

/**
 * Extract content from <COMPLETION> tags. Returns the content between the first
 * <COMPLETION> and last </COMPLETION>, or the raw text as-is if no tags are found.
 */
export function extractCompletion(raw: string): string {
  const open = raw.indexOf('<COMPLETION>');
  const close = raw.lastIndexOf('</COMPLETION>');
  if (open === -1 || close === -1 || close <= open) {
    return raw; // fallback: no valid tags, use raw text
  }
  return raw.slice(open + '<COMPLETION>'.length, close);
}

// ─── Prompt strategy interface ───────────────────────────────────

/** Message ready to send to an API or CLI backend. */
export interface PromptMessages {
  system: string;
  user: string;
  /** Assistant prefill message, if the model supports it. */
  assistantPrefill?: string;
}

/**
 * A prompt strategy defines how to build messages and extract completions
 * for a specific backend type. All strategies share the same system prompt
 * and message format — they differ in extraction and optional prefill.
 */
export interface PromptStrategy {
  readonly id: string;
  /** Build the full message set from document context. */
  buildMessages(prefix: string, suffix: string, languageId: string): PromptMessages;
  /** Extract the completion text from the model's raw response. */
  extractCompletion(raw: string): string | null;
}

// ─── Strategy implementations ────────────────────────────────────

/**
 * Tag extraction — default strategy for Claude Code CLI.
 * Expects model response wrapped in <COMPLETION> tags.
 */
export const tagExtraction: PromptStrategy = {
  id: 'tag-extraction',
  buildMessages(prefix, suffix, languageId) {
    return {
      system: SYSTEM_PROMPT,
      user: buildFillMessage(prefix, suffix, languageId),
    };
  },
  extractCompletion,
};

/**
 * Prefill extraction — for Anthropic direct API.
 * Same prompt, but adds an assistant prefill with the tail of the prefix
 * to anchor the model's continuation. Claude models still follow the
 * <COMPLETION> tag instruction even with prefill.
 */
export const prefillExtraction: PromptStrategy = {
  id: 'prefill-extraction',
  buildMessages(prefix, suffix, languageId) {
    // Take the last ~40 chars of the prefix as the prefill anchor
    const anchor = prefix.slice(-40);
    return {
      system: SYSTEM_PROMPT,
      user: buildFillMessage(prefix, suffix, languageId),
      assistantPrefill: `<COMPLETION>${anchor}`,
    };
  },
  extractCompletion(raw: string): string | null {
    // With prefill, the model's response continues from the prefill.
    // The full response is: prefill + model output.
    // We need to extract from <COMPLETION> tags if present,
    // but the prefill already includes the opening tag.
    // The raw text here is what the model returned AFTER the prefill,
    // so we just need the closing tag.
    const close = raw.lastIndexOf('</COMPLETION>');
    if (close !== -1) {
      return raw.slice(0, close);
    }
    return raw; // fallback: no closing tag, use raw text
  },
};

/** Common preamble patterns that non-Anthropic models produce. */
const PREAMBLE_PATTERNS = [
  /^(?:Here(?:'s| is).*?:\s*)/i,
  /^(?:Sure[!,.]?\s*)/i,
  /^(?:Got it[!,.]?\s*)/i,
  /^(?:Understood[!,.]?\s*)/i,
  /^(?:Of course[!,.]?\s*)/i,
];

/**
 * Instruction extraction — for non-Anthropic models (OpenAI, xAI, Ollama).
 * Same prompt. Falls back to raw text if <COMPLETION> tags are missing,
 * with additional preamble stripping for chatty models.
 */
export const instructionExtraction: PromptStrategy = {
  id: 'instruction-extraction',
  buildMessages(prefix, suffix, languageId) {
    return {
      system: SYSTEM_PROMPT,
      user: buildFillMessage(prefix, suffix, languageId),
    };
  },
  extractCompletion(raw: string): string | null {
    // Try tag extraction first
    const open = raw.indexOf('<COMPLETION>');
    const close = raw.lastIndexOf('</COMPLETION>');
    if (open !== -1 && close !== -1 && close > open) {
      return raw.slice(open + '<COMPLETION>'.length, close);
    }

    // Fallback: strip code fences if model wrapped output
    let text = raw;
    const fenceMatch = text.match(/^```[\w]*\n([\s\S]*?)\n```$/);
    if (fenceMatch) {
      text = fenceMatch[1];
    }

    // Strip preamble patterns
    for (const pattern of PREAMBLE_PATTERNS) {
      text = text.replace(pattern, '');
    }

    return text.trim() || null;
  },
};

// ─── Strategy registry ───────────────────────────────────────────

export type PromptStrategyId = 'tag-extraction' | 'prefill-extraction' | 'instruction-extraction';

const STRATEGIES: Record<PromptStrategyId, PromptStrategy> = {
  'tag-extraction': tagExtraction,
  'prefill-extraction': prefillExtraction,
  'instruction-extraction': instructionExtraction,
};

export function getPromptStrategy(id: PromptStrategyId): PromptStrategy {
  return STRATEGIES[id];
}
