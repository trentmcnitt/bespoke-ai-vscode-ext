import { CompletionContext, BuiltPrompt, ExtensionConfig } from './types';

const PROSE_SYSTEM = `You are a text continuation engine. Output ONLY the natural continuation of the text. Do not add commentary, explanations, or meta-text. Match the voice, tone, and style exactly. Output 1-2 sentences maximum. Do NOT repeat any of the provided text. Do NOT start with a newline. If the text ends mid-word, complete the word directly without adding a leading space.`;

const CODE_SYSTEM_BASE = `You are a code completion engine. Complete the code at the cursor position. Output ONLY the raw code that should be inserted — no explanations, no comments about what the code does. NEVER wrap output in markdown code fences (\`\`\`). Your output is inserted directly into a source file, so it must be valid code with no formatting wrappers. Match the existing code style. When code exists after the cursor, your output must fit exactly between the before and after code — do not generate code that belongs outside that scope or duplicates the surrounding context.`;

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
    if (context.suffix.trim()) {
      userMessage += `\n\n[Context: the text continues after the cursor with: ${context.suffix.slice(0, 100)}]\n[Do NOT include that text in your response — only output what goes BEFORE it.]`;
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
