import Anthropic from '@anthropic-ai/sdk';
import { CompletionContext, CompletionProvider, BuiltPrompt, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { PromptBuilder } from '../prompt-builder';
import { postProcessCompletion } from '../utils/post-process';
import { ContextBrief } from '../oracle/types';
import { formatBriefForPrompt } from '../oracle/brief-formatter';

/**
 * Minimum token counts required for prompt caching to take effect, per model family.
 * Below these thresholds, cache_control is silently ignored by the API —
 * we still pay the 1.25x write premium but get zero cache hits.
 */
const CACHE_MIN_TOKENS: Record<string, number> = {
  'haiku-4-5': 4096,
  'haiku-4.5': 4096,
  'opus-4-5': 4096,
  'opus-4.5': 4096,
  'sonnet': 1024,
  'opus-4': 1024,
  'opus-4-1': 1024,
  'opus-4.1': 1024,
  'haiku-3': 2048,
};

/** Estimate token count from character length (~4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Look up the minimum cacheable token count for a model.
 * Checks model string against known family fragments; defaults to 1024.
 */
function getMinCacheableTokens(model: string): number {
  const lower = model.toLowerCase();
  for (const [fragment, min] of Object.entries(CACHE_MIN_TOKENS)) {
    if (lower.includes(fragment)) { return min; }
  }
  return 1024;
}

export type TokenUsageCallback = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number) => void;

export class AnthropicProvider implements CompletionProvider {
  private client: Anthropic | null = null;
  private promptBuilder: PromptBuilder;
  private getBrief: ((filePath: string) => ContextBrief | null) | null;
  private onTokenUsage: TokenUsageCallback | null = null;

  constructor(private config: ExtensionConfig, private logger: Logger, getBrief?: (filePath: string) => ContextBrief | null) {
    this.promptBuilder = new PromptBuilder();
    this.getBrief = getBrief ?? null;
    this.initClient();
  }

  setTokenUsageCallback(cb: TokenUsageCallback): void {
    this.onTokenUsage = cb;
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
    return this.client !== null && this.config.anthropic.apiCallsEnabled;
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (!this.client || !this.config.anthropic.apiCallsEnabled) { return null; }

    const prompt = this.promptBuilder.buildPrompt(context, this.config);

    // Trace: sent content
    this.logger.traceBlock('→ system', prompt.system);
    this.logger.traceBlock('→ user', prompt.userMessage);
    if (prompt.assistantPrefill) {
      this.logger.traceInline('→ prefill', prompt.assistantPrefill);
    }

    try {
      const raw = await this.callApi(prompt, signal, context.filePath);

      this.logger.traceBlock('← raw', raw ?? '(null)');

      if (!raw) { return null; }

      const result = postProcessCompletion(raw, prompt, context.prefix, context.suffix);

      if (result !== raw) {
        this.logger.traceBlock('← processed', result ?? '(null)');
      }

      return result;
    } catch (err: unknown) {
      // Abort errors — normal during typing, not worth logging
      if (err instanceof Anthropic.APIUserAbortError) { return null; }
      if (err instanceof Error && err.name === 'AbortError') { return null; }
      // API errors — differentiate rate limit / overload from other errors
      if (err instanceof Anthropic.APIError) {
        if (err.status === 429) {
          this.logger.traceInline('rate limited', err.message);
          return null;
        } else if (err.status === 529) {
          this.logger.traceInline('server overloaded', '529 (transient)');
          return null;
        } else {
          this.logger.error(`Anthropic API error: ${err.status}`, err);
          throw err;
        }
      }
      throw err;
    }
  }

  private async callApi(prompt: BuiltPrompt, signal: AbortSignal, fileName?: string): Promise<string | null> {
    if (!this.client) { return null; }

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt.userMessage },
    ];

    if (prompt.assistantPrefill) {
      messages.push({ role: 'assistant', content: prompt.assistantPrefill });
    }

    const systemBlocks: Anthropic.TextBlockParam[] = [];

    // Smart caching: only add cache_control when estimated tokens meet the model's
    // minimum cacheable threshold. Below the minimum, the API silently ignores
    // cache_control but we still pay the 1.25x write premium for nothing.
    const totalEstimatedTokens = estimateTokens(prompt.system + prompt.userMessage);
    const minTokens = getMinCacheableTokens(this.config.anthropic.model);
    const shouldCache = this.config.anthropic.useCaching && totalEstimatedTokens >= minTokens;

    if (this.config.anthropic.useCaching && !shouldCache) {
      this.logger.traceInline('caching', `skipped (~${totalEstimatedTokens} tokens < ${minTokens} min)`);
    }

    // Inject oracle brief as a separate cached system block (changes only on file events)
    if (this.getBrief && fileName) {
      const brief = this.getBrief(fileName);
      if (brief) {
        const briefText = formatBriefForPrompt(brief);
        if (briefText) {
          const briefBlock: Anthropic.TextBlockParam = {
            type: 'text',
            text: briefText,
          };
          if (shouldCache) {
            (briefBlock as Anthropic.TextBlockParam & { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' };
          }
          systemBlocks.push(briefBlock);
          this.logger.traceInline('oracle brief', `${briefText.length} chars`);
        }
      }
    }

    const systemContent: Anthropic.TextBlockParam = {
      type: 'text',
      text: prompt.system,
    };

    if (shouldCache) {
      (systemContent as Anthropic.TextBlockParam & { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' };
    }

    systemBlocks.push(systemContent);

    const response = await this.client.messages.create(
      {
        model: this.config.anthropic.model,
        max_tokens: prompt.maxTokens,
        temperature: prompt.temperature,
        // Anthropic rejects stop sequences that are purely whitespace.
        // Filter them out — the system prompt + maxTokens constrain output length instead.
        stop_sequences: prompt.stopSequences.filter(s => /\S/.test(s)),
        system: systemBlocks,
        messages,
      },
      { signal },
    );

    if (response.usage) {
      const usage = response.usage;
      const usageAny = usage as unknown as Record<string, unknown>;
      const cacheRead = (usageAny.cache_read_input_tokens as number) ?? 0;
      const cacheWrite = (usageAny.cache_creation_input_tokens as number) ?? 0;
      const uncached = usage.input_tokens;
      const totalInput = cacheRead + cacheWrite + uncached;
      const hitRate = totalInput > 0 ? (cacheRead / totalInput * 100).toFixed(1) : '0.0';

      this.logger.traceInline('tokens', `in=${uncached} out=${usage.output_tokens} cache=${cacheRead}r/${cacheWrite}w (${hitRate}% hit)`);

      this.onTokenUsage?.(this.config.anthropic.model, uncached, usage.output_tokens, cacheRead, cacheWrite);
    }

    const block = response.content[0];
    if (block && block.type === 'text') {
      return block.text;
    }
    return null;
  }
}
