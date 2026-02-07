const SYSTEM_PROMPT = `You generate inline text suggestions. Given document context and an optional guidance instruction, produce 1 to 3 alternative suggestions. Each suggestion should be a plausible, high-quality continuation or expansion that fits naturally into the document.

Wrap each suggestion in numbered tags:
<suggestion id="1">...</suggestion>
<suggestion id="2">...</suggestion>
<suggestion id="3">...</suggestion>

Rules:
- Output ONLY the suggestion tags. No preamble, commentary, or explanation.
- Each suggestion should be meaningfully different from the others — vary in style, detail, or approach.
- Match the tone, style, and formatting of the surrounding text.
- Do not repeat text that already exists before or after the insertion point.
- Suggestions replace the indicated region exactly — do not include surrounding context in the suggestion.`;

export interface ExpandPromptOptions {
  mode: 'continue' | 'expand';
  beforeText: string;
  afterText: string;
  selectedText?: string;
  languageId: string;
  fileName: string;
  guidance?: string;
}

export function buildExpandPrompt(options: ExpandPromptOptions): string {
  const { mode, beforeText, afterText, selectedText, languageId, fileName, guidance } = options;

  const parts: string[] = [`<instructions>\n${SYSTEM_PROMPT}\n</instructions>`];

  parts.push(`\n<file language="${languageId}" name="${fileName}">`);

  if (mode === 'continue') {
    parts.push(`<before_cursor>\n${beforeText}\n</before_cursor>`);
    parts.push(`<after_cursor>\n${afterText}\n</after_cursor>`);
  } else {
    parts.push(`<before_selection>\n${beforeText}\n</before_selection>`);
    parts.push(`<selected>\n${selectedText ?? ''}\n</selected>`);
    parts.push(`<after_selection>\n${afterText}\n</after_selection>`);
  }

  parts.push('</file>');

  if (guidance) {
    parts.push(`\n<guidance>${guidance}</guidance>`);
  }

  const modeLabel =
    mode === 'continue'
      ? 'Generate 1-3 suggestions to continue from the cursor position.'
      : 'Generate 1-3 suggestions to replace the selected text.';

  parts.push(`\n${modeLabel}`);

  return parts.join('\n');
}

/**
 * Parse suggestion blocks from the model response.
 * Extracts content from `<suggestion id="N">...</suggestion>` tags.
 * Returns empty array on parse failure.
 */
export function parseSuggestions(response: string): string[] {
  const regex = /<suggestion\s+id="\d+">([\s\S]*?)<\/suggestion>/g;
  const suggestions: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    // Trim a single leading and trailing newline (artifact of tag formatting)
    let content = match[1];
    if (content.startsWith('\n')) {
      content = content.slice(1);
    }
    if (content.endsWith('\n')) {
      content = content.slice(0, -1);
    }
    suggestions.push(content);
  }

  return suggestions;
}
