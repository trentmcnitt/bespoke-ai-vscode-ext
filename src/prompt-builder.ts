import { CompletionContext, BuiltPrompt, ExtensionConfig } from './types';

const PROSE_SYSTEM = `You are a text continuation engine. Output ONLY the natural continuation of the text. Do not add commentary, explanations, or meta-text. Match the voice, tone, and style exactly. Output 1-2 sentences maximum. Do NOT repeat any of the provided text. Do NOT start with a newline.`;

const CODE_SYSTEM_BASE = `You are a code completion engine. Complete the code at the cursor position. Output ONLY the code that should be inserted. No explanations, no markdown fences, no comments about what the code does. Match the existing code style.`;

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
      userMessage += `\n\n[The text continues with: ${context.suffix.slice(0, 100)}]`;
    }

    // Extract last few words for Anthropic prefill
    const prefillWords = context.prefix.trim().split(/\s+/).slice(-4).join(' ');
    const assistantPrefill = prefillWords.length > 0 ? prefillWords : undefined;

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
      userMessage = `Code before cursor:\n${context.prefix}\n\nCode after cursor:\n${context.suffix}\n\nInsert code at the cursor:`;
    } else {
      userMessage = context.prefix;
    }

    return {
      system,
      userMessage,
      maxTokens: config.code.maxTokens,
      temperature: config.code.temperature,
      stopSequences: config.code.stopSequences,
    };
  }

}
