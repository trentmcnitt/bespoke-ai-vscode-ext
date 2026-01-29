import Anthropic from '@anthropic-ai/sdk';
import { CompletionContext, CompletionProvider, BuiltPrompt, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { PromptBuilder } from '../prompt-builder';
import { postProcessCompletion } from '../utils/post-process';

export class AnthropicProvider implements CompletionProvider {
  private client: Anthropic | null = null;
  private promptBuilder: PromptBuilder;

  constructor(private config: ExtensionConfig, private logger: Logger) {
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

    this.logger.debug(`Anthropic request: model=${this.config.anthropic.model} max_tokens=${prompt.maxTokens} temp=${prompt.temperature} stop=${JSON.stringify(prompt.stopSequences.filter(s => /\S/.test(s)))} caching=${this.config.anthropic.useCaching} system_len=${prompt.system.length} user_len=${prompt.userMessage.length} prefill_len=${prompt.assistantPrefill?.length ?? 0}`);
    this.logger.trace(`Anthropic system: ${prompt.system}`);
    this.logger.trace(`Anthropic userMessage: ${prompt.userMessage}`);
    if (prompt.assistantPrefill) {
      this.logger.trace(`Anthropic prefill: ${prompt.assistantPrefill}`);
    }

    try {
      const raw = await this.callApi(prompt, signal);

      this.logger.debug(`Anthropic response: length=${raw?.length ?? 'null'}`);

      if (!raw) { return null; }

      return postProcessCompletion(raw, prompt, context.prefix);
    } catch (err: unknown) {
      // Abort errors — normal during typing, not worth logging
      if (err instanceof Anthropic.APIUserAbortError) { return null; }
      if (err instanceof Error && err.name === 'AbortError') { return null; }
      // API errors (auth, rate limit, server errors, etc.) — log and return null
      // per the architecture pattern: providers catch errors, return null
      if (err instanceof Anthropic.APIError) {
        this.logger.error(`Anthropic API error: ${err.status} ${err.message}`);
        return null;
      }
      throw err;
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

    if (response.usage) {
      const usage = response.usage;
      const usageAny = usage as unknown as Record<string, unknown>;
      this.logger.debug(`Anthropic usage: input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens} stop_reason=${response.stop_reason} cache_read=${usageAny.cache_read_input_tokens ?? 0} cache_creation=${usageAny.cache_creation_input_tokens ?? 0}`);
    }

    const block = response.content[0];
    if (block && block.type === 'text') {
      return block.text;
    }
    return null;
  }
}
