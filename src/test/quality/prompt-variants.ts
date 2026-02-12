/**
 * Prompt variants for A/B testing different autocomplete prompt strategies.
 *
 * Each variant defines a complete prompt approach: system prompt, message
 * builder, and response extractor. Variants are tested against the same
 * scenarios to compare completion quality.
 *
 * Usage: PROMPT_VARIANT=hole-filler npm run test:quality:compare
 *
 * IMPORTANT: External prompts are copied VERBATIM from their source repos.
 * Do not modify them — if you need an adapted version, create a new variant.
 * Source URLs and commit SHAs are documented for each variant.
 *
 * Structural adaptation notes (applies to all external variants):
 * - Our test infrastructure (Claude Code SDK) requires a separate system
 *   prompt and user message. Some source projects concatenate everything
 *   into a single prompt. We split system from user query but keep the
 *   TEXT verbatim. These adaptations are documented per-variant.
 * - Claude Code SDK does not support stop sequences. Variants that rely
 *   on stop sequences (e.g., </COMPLETION>) instead let the model produce
 *   the closing tag naturally, and we extract between the tags.
 * - Warmup messages are our own additions for test infrastructure — they
 *   are not part of the original prompts.
 *
 * See docs/autocomplete-prompt-research.md for the full source analysis.
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

// ─── Variant: Hole Filler (Continue.dev / Taelin) ─────────────────
//
// Source: https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts
// SHA: 72820b2fda2407ed1047bcb54254a7173579ae56
// Function: holeFillerTemplate (SYSTEM_MSG constant + fullPrompt template)
//
// VERBATIM system prompt from the source. Note:
// - Uses '{{HOLE_NAME}}' in the intro (not '{{FILL_HERE}}')
// - Double space after "if needed." ("if needed.  All completions")
// - Examples use {{FILL_HERE}} as the actual marker
//
// Structural adaptations:
// - Original concatenates SYSTEM_MSG + query into ONE user message.
//   We split: SYSTEM_MSG → systemPrompt, query → buildMessage().
// - Original ends user message with opening <COMPLETION> tag (tag-based
//   prefill) and uses </COMPLETION> as stop sequence. We omit the trailing
//   tag since Claude Code SDK doesn't support stop sequences.

const HOLE_FILLER_SYSTEM = `You are a HOLE FILLER. You are provided with a file containing holes, formatted as '{{HOLE_NAME}}'. Your TASK is to complete with a string to replace this hole with, inside a <COMPLETION/> XML tag, including context-aware indentation, if needed.  All completions MUST be truthful, accurate, well-written and correct.

## EXAMPLE QUERY:

<QUERY>
function sum_evens(lim) {
  var sum = 0;
  for (var i = 0; i < lim; ++i) {
    {{FILL_HERE}}
  }
  return sum;
}
</QUERY>

TASK: Fill the {{FILL_HERE}} hole.

## CORRECT COMPLETION

<COMPLETION>if (i % 2 === 0) {
      sum += i;
    }</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
def sum_list(lst):
  total = 0
  for x in lst:
  {{FILL_HERE}}
  return total

print sum_list([1, 2, 3])
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>  total += x</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
// data Tree a = Node (Tree a) (Tree a) | Leaf a

// sum :: Tree Int -> Int
// sum (Node lft rgt) = sum lft + sum rgt
// sum (Leaf val)     = val

// convert to TypeScript:
{{FILL_HERE}}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>type Tree<T>
  = {$:"Node", lft: Tree<T>, rgt: Tree<T>}
  | {$:"Leaf", val: T};

function sum(tree: Tree<number>): number {
  switch (tree.$) {
    case "Node":
      return sum(tree.lft) + sum(tree.rgt);
    case "Leaf":
      return tree.val;
  }
}</COMPLETION>

## EXAMPLE QUERY:

The 5th {{FILL_HERE}} is Jupiter.

## CORRECT COMPLETION:

<COMPLETION>planet from the Sun</COMPLETION>

## EXAMPLE QUERY:

function hypothenuse(a, b) {
  return Math.sqrt({{FILL_HERE}}b ** 2);
}

## CORRECT COMPLETION:

<COMPLETION>a ** 2 + </COMPLETION>`;

const holeFillerVariant: PromptVariant = {
  id: 'hole-filler',
  name: 'Hole Filler (Continue.dev/Taelin)',
  source:
    'https://github.com/continuedev/continue/blob/72820b2fda2407ed1047bcb54254a7173579ae56/core/autocomplete/templating/AutocompleteTemplate.ts',
  systemPrompt: HOLE_FILLER_SYSTEM,

  // Original user message template (from fullPrompt):
  //   SYSTEM_MSG + `\n\n<QUERY>\n${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\n
  //   TASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion,
  //   and NOTHING ELSE. Do it now.\n<COMPLETION>`
  // We omit SYSTEM_MSG (in systemPrompt) and trailing <COMPLETION> (no stop sequence).
  buildMessage(prefix, suffix) {
    return `<QUERY>\n${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\nTASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion, and NOTHING ELSE. Do it now.`;
  },

  extractCompletion(raw) {
    return extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
  },

  buildWarmupMessage() {
    return `<QUERY>\nTwo plus two equals {{FILL_HERE}}.\n</QUERY>\nTASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion, and NOTHING ELSE. Do it now.`;
  },

  validateWarmup(raw) {
    const completion = extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
    return completion?.trim().toLowerCase() === 'four';
  },
};

// ─── Variant: Minimal Hole Filler (Taelin v2) ────────────────────
//
// Source: https://github.com/VictorTaelin/AI-scripts/blob/main/HoleFill.ts
// SHA: bb603d8c5b88ccf7d3e07db47b24d2c0131dda83
// Constants: FILL and SYSTEM (array joined with '\n')
//
// VERBATIM system prompt from the source (SYSTEM array joined with '\n').
// Note:
// - Uses {:FILL_HERE:} marker (not {{FILL_HERE}})
// - Includes "rewrite the entire file" rules (part of original)
// - No few-shot examples at all
//
// Structural adaptations:
// - User message is just the file content with {:FILL_HERE:} marker
//   (original replaces '.?.' with {:FILL_HERE:} and sends raw file text)

const MINIMAL_HOLE_FILLER_SYSTEM = `You fill exactly one placeholder inside a user-provided file.

Rules:
- The user sends the complete file text containing a single {:FILL_HERE:} marker.
- Inspect the surrounding text to understand the context (code, prose, question, etc.) and produce content that fits seamlessly.
- Preserve indentation, spacing, and style so the replacement feels native to the file.
- Unless the user explicitly asks you to rewrite the entire file, output only the text that should replace the placeholder.
- When asked to rewrite the entire file, emit the full file contents while keeping everything else identical apart from the requested changes.
- Wrap the replacement in a single <COMPLETION>...</COMPLETION> block with no commentary before or after the tags.
- The text inside <COMPLETION> should be exactly what replaces the placeholder (no fences, no marker tokens).
- Never include {:FILL_HERE:} in your response and never output more than one <COMPLETION> block.`;

const minimalHoleFillerVariant: PromptVariant = {
  id: 'minimal-hole-filler',
  name: 'Minimal Hole Filler (Taelin v2)',
  source:
    'https://github.com/VictorTaelin/AI-scripts/blob/bb603d8c5b88ccf7d3e07db47b24d2c0131dda83/HoleFill.ts',
  systemPrompt: MINIMAL_HOLE_FILLER_SYSTEM,

  // Original: sends raw file content with {:FILL_HERE:} replacing '.?.'
  // No <QUERY> tags, no task instruction — just the file text.
  buildMessage(prefix, suffix) {
    return suffix.trim() ? `${prefix}{:FILL_HERE:}${suffix}` : `${prefix}{:FILL_HERE:}`;
  },

  extractCompletion(raw) {
    return extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
  },

  buildWarmupMessage() {
    return 'Two plus two equals {:FILL_HERE:}.';
  },

  validateWarmup(raw) {
    const completion = extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
    return completion?.trim().toLowerCase() === 'four';
  },
};

// ─── Variant: Enhanced Hole Filler (Kilo Code) ───────────────────
//
// Source: https://github.com/Kilo-Org/kilocode/blob/main/src/services/ghost/classic-auto-complete/HoleFiller.ts
// SHA: 47e7de0e7658d7a6fc40a4d74adf429d4c0831ee
// Method: HoleFiller.getSystemInstructions()
//
// VERBATIM system prompt from getSystemInstructions(). Includes:
// - Same 5 few-shot examples as Continue.dev
// - Added "## CRITICAL RULES" section
// - Added "## Context Format" section
// - Trailing "Task: Auto-Completion" footer
// Note: single space after "if needed." (differs from Continue.dev's double space)
//
// Structural adaptations:
// - Original getUserPrompt() includes cross-file context via formattedContext
//   (commented reference code from related files). We omit cross-file context
//   since test scenarios are single-file.

const ENHANCED_HOLE_FILLER_SYSTEM = `You are a HOLE FILLER. You are provided with a file containing holes, formatted as '{{FILL_HERE}}'. Your TASK is to complete with a string to replace this hole with, inside a <COMPLETION/> XML tag, including context-aware indentation, if needed. All completions MUST be truthful, accurate, well-written and correct.

## CRITICAL RULES
- NEVER repeat or duplicate content that appears immediately before {{FILL_HERE}}
- If {{FILL_HERE}} is at the end of a comment line, start your completion with a newline and new code
- Maintain proper indentation matching the surrounding code

## Context Format
<LANGUAGE>: file language
<QUERY>: contains commented reference code (// Path: file.ts) followed by code with {{FILL_HERE}}
Comments provide context from related files, recent edits, imports, etc.

## EXAMPLE QUERY:

<QUERY>
function sum_evens(lim) {
  var sum = 0;
  for (var i = 0; i < lim; ++i) {
    {{FILL_HERE}}
  }
  return sum;
}
</QUERY>

TASK: Fill the {{FILL_HERE}} hole.

## CORRECT COMPLETION

<COMPLETION>if (i % 2 === 0) {
      sum += i;
    }</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
def sum_list(lst):
  total = 0
  for x in lst:
  {{FILL_HERE}}
  return total

print sum_list([1, 2, 3])
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>  total += x</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
// data Tree a = Node (Tree a) (Tree a) | Leaf a

// sum :: Tree Int -> Int
// sum (Node lft rgt) = sum lft + sum rgt
// sum (Leaf val)     = val

// convert to TypeScript:
{{FILL_HERE}}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>type Tree<T>
  = {$:"Node", lft: Tree<T>, rgt: Tree<T>}
  | {$:"Leaf", val: T};

function sum(tree: Tree<number>): number {
  switch (tree.$) {
    case "Node":
      return sum(tree.lft) + sum(tree.rgt);
    case "Leaf":
      return tree.val;
  }
}</COMPLETION>

## EXAMPLE QUERY:

The 5th {{FILL_HERE}} is Jupiter.

## CORRECT COMPLETION:

<COMPLETION>planet from the Sun</COMPLETION>

## EXAMPLE QUERY:

function hypothenuse(a, b) {
  return Math.sqrt({{FILL_HERE}}b ** 2);
}

## CORRECT COMPLETION:

<COMPLETION>a ** 2 + </COMPLETION>

Task: Auto-Completion
Provide a subtle, non-intrusive completion after a typing pause.
`;

const enhancedHoleFillerVariant: PromptVariant = {
  id: 'enhanced-hole-filler',
  name: 'Enhanced Hole Filler (Kilo Code)',
  source:
    'https://github.com/Kilo-Org/kilocode/blob/47e7de0e7658d7a6fc40a4d74adf429d4c0831ee/src/services/ghost/classic-auto-complete/HoleFiller.ts',
  systemPrompt: ENHANCED_HOLE_FILLER_SYSTEM,

  // Original getUserPrompt() template:
  //   `<LANGUAGE>${languageId}</LANGUAGE>\n\n` +
  //   `<QUERY>\n${formattedContext}${...}${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\n\n` +
  //   `TASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion, and NOTHING ELSE. Do it now.\n` +
  //   `Return the COMPLETION tags`
  // We omit formattedContext (no cross-file context in test scenarios).
  buildMessage(prefix, suffix, _mode, languageId) {
    return `<LANGUAGE>${languageId}</LANGUAGE>\n\n<QUERY>\n${prefix}{{FILL_HERE}}${suffix}\n</QUERY>\n\nTASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion, and NOTHING ELSE. Do it now.\nReturn the COMPLETION tags`;
  },

  extractCompletion(raw) {
    return extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
  },

  buildWarmupMessage() {
    return `<LANGUAGE>plaintext</LANGUAGE>\n\n<QUERY>\nTwo plus two equals {{FILL_HERE}}.\n</QUERY>\n\nTASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion, and NOTHING ELSE. Do it now.\nReturn the COMPLETION tags`;
  },

  validateWarmup(raw) {
    const completion = extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
    return completion?.trim().toLowerCase() === 'four';
  },
};

// ─── Variant: Minuet Suffix-First ─────────────────────────────────
//
// Source: https://github.com/milanglacier/minuet-ai.nvim/blob/main/lua/minuet/config.lua
// SHA: 2f82a61e30b383230aebe141e55e371db8416831
// Variables: default_prompt, default_guidelines, n_completion_template,
//            default_system_template, default_chat_input, default_few_shots
//
// VERBATIM system prompt assembled from source components:
// - default_prompt (with "reverse order" note for Claude)
// - default_guidelines (7 items, verbatim including line-wrapped guideline 2)
// - n_completion_template with n=3 (Claude default in source: n_completions=3)
// Combined via default_system_template: '{{{prompt}}}\n{{{guidelines}}}\n{{{n_completion_template}}}'
//
// Structural adaptations:
// - Original includes few-shot user/assistant message pairs (default_few_shots)
//   in the conversation. Our SlotPool infrastructure only supports system prompt
//   + single user message, so few-shots are omitted.
// - Original user message template includes a {{{tab}}} placeholder resolved
//   to editor indentation style (e.g., "# use 4 spaces for indentation").
//   We omit this since test scenarios don't have editor context.

const MINUET_SYSTEM = `You are an AI code completion engine. Provide contextually appropriate completions:
- Code completions in code context
- Comment/documentation text in comments
- String content in string literals
- Prose in markdown/documentation files

Input markers:
- \`<contextAfterCursor>\`: Context after cursor
- \`<cursorPosition>\`: Current cursor location
- \`<contextBeforeCursor>\`: Context before cursor

Note that the user input will be provided in **reverse** order: first the
context after cursor, followed by the context before cursor.
Guidelines:
1. Offer completions after the \`<cursorPosition>\` marker.
2. Make sure you have maintained the user's existing whitespace and indentation.
   This is REALLY IMPORTANT!
3. Provide multiple completion options when possible.
4. Return completions separated by the marker <endCompletion>.
5. The returned message will be further parsed and processed. DO NOT include
   additional comments or markdown code block fences. Return the result directly.
6. Keep each completion option concise, limiting it to a single line or a few lines.
7. Create entirely new code completion that DO NOT REPEAT OR COPY any user's existing code around <cursorPosition>.
8. Provide at most 3 completion items.`;

const minuetVariant: PromptVariant = {
  id: 'minuet',
  name: 'Minuet Suffix-First',
  source:
    'https://github.com/milanglacier/minuet-ai.nvim/blob/2f82a61e30b383230aebe141e55e371db8416831/lua/minuet/config.lua',
  systemPrompt: MINUET_SYSTEM,

  // Original default_chat_input.template (suffix-first, used for Claude):
  //   '{{{language}}}\n{{{tab}}}\n<contextAfterCursor>\n{{{context_after_cursor}}}\n
  //    <contextBeforeCursor>\n{{{context_before_cursor}}}<cursorPosition>'
  // We omit {{{tab}}} (no editor context in tests).
  buildMessage(prefix, suffix, _mode, languageId) {
    const parts = [`# language: ${languageId}`];
    if (suffix.trim()) {
      parts.push(`<contextAfterCursor>\n${suffix}`);
    }
    parts.push(`<contextBeforeCursor>\n${prefix}<cursorPosition>`);
    return parts.join('\n');
  },

  extractCompletion(raw) {
    // Minuet uses bare response (no wrapping tags)
    // Strip <endCompletion> and anything after it (take first completion only)
    const endIdx = raw.indexOf('<endCompletion>');
    const text = endIdx >= 0 ? raw.slice(0, endIdx) : raw;
    return text || null;
  },

  buildWarmupMessage() {
    return `# language: plaintext\n<contextAfterCursor>\n.\n<contextBeforeCursor>\nTwo plus two equals <cursorPosition>`;
  },

  validateWarmup(raw) {
    const endIdx = raw.indexOf('<endCompletion>');
    const text = endIdx >= 0 ? raw.slice(0, endIdx) : raw;
    return text.trim().toLowerCase().includes('four');
  },
};

// ─── Variant: Prose-Optimized Hole Filler ─────────────────────────
// Custom variant (NOT from an external source). Combines the best of
// the researched approaches, optimized for prose completion (our
// 70-80% use case).

const PROSE_OPTIMIZED_SYSTEM = `You fill a single placeholder in the user's document.

The user sends text containing a {{FILL_HERE}} marker. Output ONLY the text that replaces {{FILL_HERE}}, wrapped in <COMPLETION>...</COMPLETION> tags.

Rules:
- Match the voice, style, tone, and formatting of the surrounding text exactly
- Preserve indentation and whitespace patterns
- NEVER repeat or duplicate text that appears immediately before or after the marker
- NEVER include {{FILL_HERE}} in your response
- No commentary, no code fences, no explanation — just the COMPLETION tags

CRITICAL — You are NOT a conversational assistant:
- The text is a document being written by an author. You are predicting what the author writes NEXT.
- NEVER reply to, respond to, summarize, or acknowledge what was written
- NEVER use phrases like: "Got it", "That makes sense", "Understood", "I see", "Sure", "Great"
- If the text reads like someone talking or giving instructions, continue AS that person

Length:
- If there is text after {{FILL_HERE}}, output just enough to bridge to it naturally
- If there is no text after {{FILL_HERE}}, continue for a sentence or two
- Do not close structures (brackets, comments, tags) if text after the marker shows they continue

Examples:

The 5th {{FILL_HERE}} is Jupiter.
<COMPLETION>planet from the Sun</COMPLETION>

I think we should use option B. The timeline is tighter but {{FILL_HERE}}
<COMPLETION>the scope is much more reasonable. We can always extend the deadline if needed, but cutting features later is harder.</COMPLETION>

## Getting {{FILL_HERE}}

### Prerequisites
<COMPLETION>Started

This guide walks you through the initial setup process.</COMPLETION>`;

const proseOptimizedVariant: PromptVariant = {
  id: 'prose-optimized',
  name: 'Prose-Optimized Hole Filler',
  source: 'Custom — combines Continue.dev pattern with Kilo Code anti-chat rules',
  systemPrompt: PROSE_OPTIMIZED_SYSTEM,

  buildMessage(prefix, suffix, _mode, languageId) {
    const doc = suffix.trim()
      ? `<document language="${languageId}">\n${prefix}{{FILL_HERE}}${suffix}\n</document>`
      : `<document language="${languageId}">\n${prefix}{{FILL_HERE}}\n</document>`;
    return `${doc}\n\nFill the {{FILL_HERE}} marker.`;
  },

  extractCompletion(raw) {
    return extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
  },

  buildWarmupMessage() {
    return `<document language="plaintext">\nTwo plus two equals {{FILL_HERE}}.\n</document>\n\nFill the {{FILL_HERE}} marker.`;
  },

  validateWarmup(raw) {
    const completion = extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
    return completion?.trim().toLowerCase() === 'four';
  },
};

// ─── Variant: Prose V2 (Hybrid) ───────────────────────────────────
// HISTORICAL: This variant was adopted as the production prompt.
// The `current` variant now uses the same prompt. Kept for reference
// and to allow historical comparison runs to still resolve `prose-v2`.

const PROSE_V2_SYSTEM = `You fill a single placeholder in the user's document.

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

const proseV2Variant: PromptVariant = {
  id: 'prose-v2',
  name: 'Prose V2 (Hybrid)',
  source: 'Custom — prose-optimized reliability + current quality fixes',
  systemPrompt: PROSE_V2_SYSTEM,

  buildMessage(prefix, suffix, _mode, languageId) {
    const doc = suffix.trim()
      ? `<document language="${languageId}">\n${prefix}{{FILL_HERE}}${suffix}\n</document>`
      : `<document language="${languageId}">\n${prefix}{{FILL_HERE}}\n</document>`;
    return `${doc}\n\nFill the {{FILL_HERE}} marker.`;
  },

  extractCompletion(raw) {
    return extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
  },

  buildWarmupMessage() {
    return `<document language="plaintext">\nTwo plus two equals {{FILL_HERE}}.\n</document>\n\nFill the {{FILL_HERE}} marker.`;
  },

  validateWarmup(raw) {
    const completion = extractBetweenTags(raw, '<COMPLETION>', '</COMPLETION>');
    return completion?.trim().toLowerCase() === 'four';
  },
};

// ─── Registry ─────────────────────────────────────────────────────

export const PROMPT_VARIANTS: Record<string, PromptVariant> = {
  current: currentVariant,
  'hole-filler': holeFillerVariant,
  'minimal-hole-filler': minimalHoleFillerVariant,
  'enhanced-hole-filler': enhancedHoleFillerVariant,
  minuet: minuetVariant,
  'prose-optimized': proseOptimizedVariant,
  'prose-v2': proseV2Variant,
};

export function getVariant(id: string): PromptVariant | undefined {
  return PROMPT_VARIANTS[id];
}

export function getAllVariantIds(): string[] {
  return Object.keys(PROMPT_VARIANTS);
}
