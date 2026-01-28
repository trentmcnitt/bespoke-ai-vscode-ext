import Anthropic from '@anthropic-ai/sdk';
import { CompletionContext, CompletionProvider, BuiltPrompt, ExtensionConfig } from '../types';
import { PromptBuilder } from '../prompt-builder';
import { postProcessCompletion } from '../utils/post-process';

export class AnthropicProvider implements CompletionProvider {
  private client: Anthropic | null = null;
  private promptBuilder: PromptBuilder;

  constructor(private config: ExtensionConfig) {
    this.promptBuilder = new PromptBuilder();
    this.initClient();
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.initClient();
  }

  private initClient(): void {
    const apiKey = this.config.anthropic.apiKey;
    if (!apiKey) {
      this.client = null;
      return;
    }
    this.client = new Anthropic({
      apiKey,
      timeout: 30_000, // 30s — default is 10min, far too long for inline completions
    });
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (!this.client) { return null; }

    const prompt = this.promptBuilder.buildPrompt(context, this.config);

    try {
      const raw = await this.callApi(prompt, signal);
      if (!raw) { return null; }

      return postProcessCompletion(raw, prompt);
    } catch (err: unknown) {
      // SDK throws APIUserAbortError on signal abort
      if (err instanceof Anthropic.APIUserAbortError) { return null; }
      if (err instanceof Error && err.name === 'AbortError') { return null; }
      console.error('[AI Prose] Anthropic API error:', err);
      return null;
    }
  }

  private async callApi(prompt: BuiltPrompt, signal: AbortSignal): Promise<string | null> {
    if (!this.client) { return null; }

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt.userMessage },
    ];

    if (prompt.assistantPrefill) {
      messages.push({ role: 'assistant', content: prompt.assistantPrefill });
    }

    const systemContent: Anthropic.TextBlockParam = {
      type: 'text',
      text: prompt.system,
    };

    if (this.config.anthropic.useCaching) {
      (systemContent as Anthropic.TextBlockParam & { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' };
    }

    const response = await this.client.messages.create(
      {
        model: this.config.anthropic.model,
        max_tokens: prompt.maxTokens,
        temperature: prompt.temperature,
        // Anthropic rejects stop sequences that are purely whitespace (e.g. "\n\n").
        // Filter them out — the system prompt + maxTokens constrain output length instead.
        stop_sequences: prompt.stopSequences.filter(s => /\S/.test(s)),
        system: [systemContent],
        messages,
      },
      { signal },
    );

    const block = response.content[0];
    if (block && block.type === 'text') {
      return block.text;
    }
    return null;
  }
}
