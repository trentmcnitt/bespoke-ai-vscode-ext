import { CompletionContext, BuiltPrompt, ExtensionConfig } from './types';

const PROSE_SYSTEM = `Continue the text naturally. Match the voice, tone, and style exactly. Output only the continuation — no commentary or meta-text.

Length: finish the current sentence or thought, then stop. 1-3 sentences maximum. Shorter is better.`;

const CODE_SYSTEM_BASE = `Complete the code at the cursor position. Output ONLY the raw code to insert — no explanations, no comments about what the code does, no markdown code fences. Your output is inserted directly into a source file. Match the existing code style. When code exists after the cursor, your output must fit exactly between the before and after code — do not duplicate the surrounding context.`;

export class PromptBuilder {
  buildPrompt(context: CompletionContext, config: ExtensionConfig): BuiltPrompt {
    switch (context.mode) {
      case 'prose':
        return this.buildProsePrompt(context, config);
      case 'code':
        return this.buildCodePrompt(context, config);
    }
  }

  private buildProsePrompt(context: CompletionContext, config: ExtensionConfig): BuiltPrompt {
    let userMessage = context.prefix;

    // Heading heuristic: when the prefix ends with a heading + blank line(s),
    // the model has minimal context about what to write. Guide it to start
    // a paragraph rather than producing a fragment or extending the heading.
    if (/^#{1,6}\s+.+\n\n$/m.test(context.prefix.slice(-200))) {
      userMessage += `[Begin a new paragraph under this heading. Start with a capital letter.]`;
    }

    if (context.suffix.trim()) {
      userMessage += `\n\n[SUFFIX: The document continues after the cursor with: ${context.suffix.slice(0, 100)}]\n[Your output fills the gap before this existing text. Do not regenerate or overlap with it.]\n[Include any leading newlines or whitespace needed for correct formatting at the insertion point.]`;
    }

    // Extract last few words for Anthropic prefill.
    // Skip prefill when the prefix is very short (< 3 words) — the prefill
    // would duplicate the entire user message, confusing the model.
    const words = context.prefix.trim().split(/\s+/);
    const assistantPrefill = words.length >= 3 ? words.slice(-4).join(' ') : undefined;

    return {
      system: PROSE_SYSTEM,
      userMessage,
      assistantPrefill,
      maxTokens: config.prose.maxTokens,
      temperature: config.prose.temperature,
      stopSequences: config.prose.stopSequences,
    };
  }

  private buildCodePrompt(context: CompletionContext, config: ExtensionConfig): BuiltPrompt {
    const system = `${CODE_SYSTEM_BASE}\nFile: ${context.fileName} (${context.languageId})`;

    let userMessage: string;
    if (context.suffix.trim()) {
      userMessage = `Code before cursor:\n${context.prefix}\n\nCode after cursor:\n${context.suffix}\n\nInsert ONLY the code that belongs at the cursor position. The code after the cursor already exists — do not regenerate or extend beyond it:`;
    } else {
      userMessage = context.prefix;
    }

    return {
      system,
      userMessage,
      suffix: context.suffix.trim() ? context.suffix : undefined,
      maxTokens: config.code.maxTokens,
      temperature: config.code.temperature,
      stopSequences: config.code.stopSequences,
    };
  }

}
