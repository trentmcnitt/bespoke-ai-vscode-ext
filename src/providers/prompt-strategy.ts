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
- Your output is inserted at {{FILL_HERE}} exactly as written, and the text on both sides stays unchanged. In prose, check the character just before the marker:
  - A letter, digit, or punctuation mark, and your output starts a new word: begin your output with a space (see the examples).
  - A space or line break, or a partly typed word you are finishing: do not begin with a space.
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

I think we should use option B. The timeline is tighter but{{FILL_HERE}}
<COMPLETION> the scope is much more reasonable. We can always extend the deadline if needed, but cutting features later is harder.</COMPLETION>

## Getting {{FILL_HERE}}

### Prerequisites
<COMPLETION>Started

This guide walks you through the initial setup process.</COMPLETION>

We finally shipped the new onboar{{FILL_HERE}}
<COMPLETION>ding flow last week.</COMPLETION>

When choosing a data format, consider your {{FILL_HERE}}
<COMPLETION>use case. JSON is widely supported and ideal for web applications, YAML offers better readability for configuration files, and TOML provides a clean syntax for simpler settings.</COMPLETION>

I want the dashboard to show daily totals at the top. Below that, a weekly trend chart would be useful.

{{FILL_HERE}}
<COMPLETION>For the chart, a simple bar chart should work — nothing fancy. Color-code the bars by category so I can spot patterns at a glance.</COMPLETION>

Can you check if the migration handles nullable columns? Also {{FILL_HERE}}
<COMPLETION>verify that the rollback script actually restores the previous schema — last time it silently dropped the index on user_id.</COMPLETION>

The build was taking 4 minutes on every push.{{FILL_HERE}} I started by profiling the webpack config to find the bottleneck.
<COMPLETION> That was completely untenable for a team doing 20+ deploys a day, so I decided to dedicate a sprint to fixing it.</COMPLETION>

Code examples — suffix delimiters are already in the document, never repeat them:

return \`Hello, \${name{{FILL_HERE}}\`;\n}
<COMPLETION>}! Welcome aboard</COMPLETION>

evens = [n for n in range(20) if {{FILL_HERE}}]\nprint(evens)
<COMPLETION>n % 2 == 0</COMPLETION>

echo "Processing \${{FILL_HERE}}"\ndone
<COMPLETION>file</COMPLETION>

Code suffix rule: when the text after {{FILL_HERE}} starts with a closing delimiter (] } ) \` " ' ;), that delimiter is ALREADY in the document. Your output must stop BEFORE it — never include it.`;

/**
 * Compose the completion system prompt, optionally appending the user's
 * standing instructions (the `bespokeAI.customInstructions` setting).
 *
 * The user block is appended AFTER the core prompt and explicitly subordinated:
 * it steers content (style, conventions, constraints) but never overrides the
 * output-format and "continue, don't reply" rules above it. Returns the bare
 * SYSTEM_PROMPT unchanged when there are no instructions, so the common case
 * costs nothing and stays byte-identical (preserving prompt-cache affinity).
 */
/** Upper bound on custom instructions, in characters. Mirrored in the setting's description. */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 2000;

// C0 controls other than \t and \n, plus DEL. Newlines and tabs are legitimate in a
// multi-line list of rules; nothing else in this range is.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Unicode bidirectional overrides and isolates. They have no place in an instruction
// string and can make displayed text differ from what the model actually receives.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Normalize a custom-instructions value before it enters a prompt.
 *
 * The setting is workspace-settable by design (per-project rules), so the value may
 * come from a repository rather than the user. This does not try to judge the content —
 * it removes what is never legitimate (control and bidi characters), normalizes line
 * endings, and bounds the length so a stray value cannot dominate the prompt. On the
 * CLI backend the result is baked into every slot's system prompt, pool-wide.
 */
export function sanitizeCustomInstructions(raw: string | undefined): string {
  if (!raw) return '';
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_CONTROLS, '')
    .trim();
  return cleaned.length > MAX_CUSTOM_INSTRUCTIONS_CHARS
    ? cleaned.slice(0, MAX_CUSTOM_INSTRUCTIONS_CHARS).trimEnd()
    : cleaned;
}

export function composeSystemPrompt(customInstructions?: string): string {
  const trimmed = sanitizeCustomInstructions(customInstructions);
  if (!trimmed) {
    return SYSTEM_PROMPT;
  }
  return `${SYSTEM_PROMPT}

Additional user instructions:
The user configured the standing instructions below. Apply them to the completion content when relevant. They must NOT override the core rules above — always keep the COMPLETION tag output format, produce no commentary, and continue the author's text rather than replying to it.

${trimmed}`;
}

/** Build the per-request message from prefix + suffix context. */
export function buildFillMessage(
  prefix: string,
  suffix: string,
  languageId: string = 'plaintext',
): string {
  const doc = suffix.trim()
    ? `<document language="${languageId}">\n${prefix}{{FILL_HERE}}${suffix}\n</document>`
    : `<document language="${languageId}">\n${prefix}{{FILL_HERE}}\n</document>`;
  return `${doc}\n\n${fillInstructionSentences(prefix).join(' ')}`;
}

/** The fixed instruction line appended after the document. */
export const FILL_INSTRUCTION = 'Fill the {{FILL_HERE}} marker.';
/** Whitespace cue sent when the prefix ends in a non-word character plus one space. */
export const ENDS_WITH_SPACE_CUE = 'The text before it already ends with a space.';

/**
 * The sentences appended after the document, in order. Shared by
 * buildFillMessage() and the prefill echo check, so the check keys on exactly
 * the text that was sent.
 *
 * Whitespace cue: the completion is inserted verbatim, but models often cannot
 * tell that the marker sits flush against the preceding word and drop the
 * leading space ("behind" + "inadequate" -> "behindinadequate"). State it
 * explicitly. Only word-like tails get the cue, so code positions such as
 * `href="` or `foo(` are left alone.
 */
export function fillInstructionSentences(prefix: string): string[] {
  const lastWord = /[\p{L}\p{N}][\p{L}\p{N}_'’-]{0,29}[,.;:!?)]?$/u.exec(prefix)?.[0];
  if (lastWord) {
    return [
      FILL_INSTRUCTION,
      `There is no space between "${lastWord}" and the marker.`,
      `If "${lastWord}" is a complete word or ends in punctuation and your output starts a new word, begin with a space.`,
      `If you are finishing "${lastWord}" itself, do not.`,
    ];
  }
  return /\S $/.test(prefix) ? [FILL_INSTRUCTION, ENDS_WITH_SPACE_CUE] : [FILL_INSTRUCTION];
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
  /**
   * Extract the completion text from the model's raw response. `prefix` and
   * `suffix` are the document text around the cursor as sent, for strategies
   * that need to tell the model's text apart from the prompt's.
   */
  extractCompletion(raw: string, prefix?: string, suffix?: string): string | null;
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
    // Take the last ~40 chars of the prefix as the prefill anchor.
    // trimEnd() is required — the Anthropic API rejects assistant messages
    // with trailing whitespace. The model still sees the full prefix
    // (including whitespace) in the user message, so completions are correct.
    const anchor = prefillAnchor(prefix);
    return {
      system: SYSTEM_PROMPT,
      user: buildFillMessage(prefix, suffix, languageId),
      assistantPrefill: `<COMPLETION>${anchor}`,
    };
  },
  extractCompletion(raw: string, prefix?: string, suffix?: string): string | null {
    const content = extractPrefillContent(raw, prefix, suffix);
    if (content === null || prefix === undefined) return content;
    // The anchor had the prefix's trailing whitespace trimmed, so the model
    // continues from e.g. "behind" and often re-emits that whitespace
    // (" inadequate"). Those characters already sit before the cursor, so drop
    // exactly the part of the output that reproduces them; otherwise the ghost
    // text doubles the space ("behind  inadequate").
    const trimmed = prefix.slice(-PREFILL_ANCHOR_CHARS).slice(prefillAnchor(prefix).length);
    let i = 0;
    while (i < trimmed.length && i < content.length && trimmed[i] === content[i]) i++;
    return content.slice(i);
  },
};

/** How much of the prefix tail is echoed into the assistant prefill. */
const PREFILL_ANCHOR_CHARS = 40;

// trimEnd() is required — the Anthropic API rejects assistant messages with
// trailing whitespace. The model still sees the full prefix (including
// whitespace) in the user message.
function prefillAnchor(prefix: string): string {
  return prefix.slice(-PREFILL_ANCHOR_CHARS).trimEnd();
}

function extractPrefillContent(raw: string, prefix?: string, suffix?: string): string | null {
  // With prefill, the model's response continues from the prefill.
  // The raw text is what the model returned AFTER the prefill
  // (which already includes the opening <COMPLETION> tag + anchor).
  //
  // Anthropic models sometimes exhibit a "thinking leak" pattern:
  // they immediately close the tag (</COMPLETION>), produce thinking
  // text, then re-open a new <COMPLETION> block with the real content.
  //
  // Strategy: use indexOf to find the first </COMPLETION>. If the
  // content before it is substantive, use it (handles clean responses
  // and "valid-first-then-think" patterns). If empty, look for a
  // second <COMPLETION>...</COMPLETION> pair (the model's retry after
  // thinking).
  //
  // "Substantive" ignores prompt scaffolding: a first block that is only the
  // {{FILL_HERE}} marker (the model echoing the placeholder, then retrying)
  // counts as empty, so the retry is used. Otherwise the marker was returned,
  // post-processing stripped it, and the retry's real text was lost.
  //
  // A block that echoes the user message back (see echoesUserMessage) is not an
  // answer either: it is treated like a blank block, so the retry is used if
  // there is a closed one, and otherwise nothing is shown.
  const isAnswer = (block: string) =>
    !isScaffoldOnly(block) && !echoesUserMessage(block, prefix, suffix);
  const close = raw.indexOf('</COMPLETION>');
  if (close !== -1) {
    const content = raw.slice(0, close);
    if (isAnswer(content)) {
      return content;
    }
    // Immediate close — model may have started thinking then retried.
    // Look for a second <COMPLETION>...</COMPLETION> pair.
    const secondOpen = raw.indexOf('<COMPLETION>', close);
    if (secondOpen !== -1) {
      const afterOpen = secondOpen + '<COMPLETION>'.length;
      const secondClose = raw.indexOf('</COMPLETION>', afterOpen);
      if (secondClose !== -1) {
        const retryContent = raw.slice(afterOpen, secondClose);
        if (isAnswer(retryContent)) {
          return retryContent;
        }
      }
    }
    // Last resort: the answer may sit inside the rejected echo block, after a
    // <COMPLETION> the model reopened (see recoverFromEchoBlock).
    if (echoesUserMessage(content, prefix, suffix)) {
      return recoverFromEchoBlock(content, prefix, suffix);
    }
    // No usable content found
    return null;
  }
  // Fallback: no closing tag (stop sequence or a max_tokens cut), use raw text.
  return echoesUserMessage(raw, prefix, suffix) ? null : raw;
}

/**
 * True when a prefill-path block contains the user message's own scaffolding,
 * copied back by the model rather than written as an answer.
 *
 * Problem: haiku sometimes continues past the prefill anchor by re-typing the
 * rest of the user message — `{{FILL_HERE}}`, the suffix, `</document>`, the
 * "Fill the {{FILL_HERE}} marker." line and the whitespace cue — then reasons
 * and only then answers, all before its first `</COMPLETION>`. Everything
 * before that tag was the ghost text (2 of 24 mid-word samples on
 * `the deploym`, and `code-html-tag` at `href="`; see
 * evals/2026-09-28-reasoning-leakage.md).
 *
 * Why it is safe: each signal is text this extension writes, never text the
 * author wrote.
 *  - The block starts with the `{{FILL_HERE}}` marker and also contains
 *    `</document>`: the model is copying the document from the marker to the
 *    wrapper's closing tag. Neither alone is enough — `</document>` is a real
 *    closing tag in XML, and a leading marker followed by a real answer is
 *    handled by stripLeakedTags() as before.
 *  - The block contains one of the exact sentences appended after the
 *    document for this request (fillInstructionSentences(prefix)), including
 *    the whitespace cue that quotes the author's last word.
 * A signal that also appears in the document text sent (prefix + suffix) is
 * ignored: someone editing this very file, or a document that mentions the
 * marker, can legitimately produce it.
 *
 * Not covered, on purpose: reasoning that quotes nothing from the prompt
 * ("Wait, let me reconsider…") is still shown. That wording can be legitimate
 * prose, so it is not a safe trigger.
 */
function echoesUserMessage(block: string, prefix?: string, suffix?: string): boolean {
  const docText = (prefix ?? '') + (suffix ?? '');
  const fromPrompt = (s: string) => block.includes(s) && !docText.includes(s);
  if (
    /^\s*\{\{FILL_HERE\}\}/.test(block) &&
    fromPrompt('{{FILL_HERE}}') &&
    fromPrompt('</document>')
  ) {
    return true;
  }
  const sentences = prefix === undefined ? [FILL_INSTRUCTION] : fillInstructionSentences(prefix);
  return sentences.some(fromPrompt);
}

/**
 * Recover the answer from a closed first block that was rejected as an echo of
 * the user message, when the model reopened `<COMPLETION>` inside it.
 *
 * Problem: haiku's echo detour usually ends with the real answer inside a tag it
 * reopened without closing the first one:
 * `{{FILL_HERE}}</a></li>\n</document>\n\nI need to see… <COMPLETION>/contact">Contact</COMPLETION>`.
 * The first `</COMPLETION>` closes that inner tag, so the whole thing is one
 * block. echoesUserMessage() rejects it, and with no retry block after it the
 * result is nothing (24 of the 36 recorded echo rejections; see
 * evals/2026-09-28-echo-recovery-prototype.md).
 *
 * Rule: take the text after the LAST `<COMPLETION>` in the block, up to the
 * block's end (the first `</COMPLETION>`), and use it only if it passes every
 * check below; otherwise return null (the behavior without this step).
 *
 * Why it is safe:
 *  - It only runs when the first block is closed, was rejected as an echo, and
 *    no closed retry block was usable — i.e. when the result would otherwise be
 *    null. It never changes a completion that is shown today.
 *  - The recovered text must contain none of the prompt's scaffolding:
 *    `{{FILL_HERE}}`, `</document>`, or an appended instruction sentence (each
 *    ignored when it is in the prefix/suffix sent, as in echoesUserMessage).
 *    Since the block was rejected for one of these and the recovered text has
 *    none, the echo lies wholly before the reopened tag.
 *  - The recovered text must not restart the prefix: it may not begin with the
 *    prefill anchor, or with the partly typed word before the cursor (re-typing
 *    `deploym` would show `deploymdeployment`).
 *  - It is not blank or scaffolding only.
 *  - Unclosed blocks (a `max_tokens` cut) are not recovered: a reopened tag
 *    with no close has no evidence that the answer is complete.
 *
 * Nothing is rewritten: the recovered text is used verbatim or not at all.
 */
function recoverFromEchoBlock(block: string, prefix?: string, suffix?: string): string | null {
  const open = block.lastIndexOf('<COMPLETION>');
  if (open === -1) return null;
  const text = block.slice(open + '<COMPLETION>'.length);
  if (isScaffoldOnly(text)) return null;
  const docText = (prefix ?? '') + (suffix ?? '');
  const fromPrompt = (s: string) => text.includes(s) && !docText.includes(s);
  const sentences = prefix === undefined ? [FILL_INSTRUCTION] : fillInstructionSentences(prefix);
  if (['{{FILL_HERE}}', '</document>', ...sentences].some(fromPrompt)) return null;
  if (prefix !== undefined) {
    const anchor = prefillAnchor(prefix);
    if (anchor && text.startsWith(anchor)) return null;
    const partialWord = /[\p{L}\p{N}_]{2,}$/u.exec(prefix)?.[0];
    if (partialWord && text.startsWith(partialWord)) return null;
  }
  return text;
}

/** True when `text` is blank once prompt scaffolding tags / the fill marker are removed. */
function isScaffoldOnly(text: string): boolean {
  return !text.replace(/<\/?COMPLETION>|\{\{FILL_HERE\}\}/g, '').trim();
}

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
