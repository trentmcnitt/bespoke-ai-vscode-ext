import { ApiAdapter, ApiAdapterResult, Preset } from '../types';
import { resolveApiKey } from '../../../utils/api-key-store';

export class AnthropicAdapter implements ApiAdapter {
  readonly providerId = 'anthropic';
  private client: unknown = null;
  /** The key `client` was built with; a different resolved key rebuilds it. */
  private clientKey: string | undefined;
  private preset: Preset;

  constructor(preset: Preset) {
    this.preset = preset;
  }

  isConfigured(): boolean {
    if (!this.preset.apiKeyEnvVar) return false;
    return !!resolveApiKey(this.preset.apiKeyEnvVar);
  }

  async complete(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: {
      signal: AbortSignal;
      maxTokens: number;
      temperature: number;
      stopSequences?: string[];
    },
  ): Promise<ApiAdapterResult> {
    const client = await this.getClient();
    const startTime = Date.now();

    // Build system with cache_control if prompt caching is enabled
    const system: unknown = this.preset.features?.promptCaching
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;

    // Convert messages — the last assistant message is the prefill
    const apiMessages = messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    try {
      const response = await (client as AnthropicClient).messages.create(
        {
          model: this.preset.modelId,
          max_tokens: options.maxTokens,
          // Left out, not sent as undefined, when the model rejects sampling
          // parameters (Sonnet 5, Opus 4.7+: HTTP 400). See model-capabilities.ts.
          ...(this.preset.features?.sampling === false ? {} : { temperature: options.temperature }),
          // Models that think by default (Sonnet 5): thinking tokens count
          // against max_tokens and can use up the whole completion budget.
          ...(this.preset.features?.disableThinking ? { thinking: { type: 'disabled' } } : {}),
          system,
          messages: apiMessages,
          stop_sequences: options.stopSequences,
          ...this.preset.extraBody,
        },
        { signal: options.signal },
      );

      const text =
        response.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => b.text)
          .join('') || null;

      return {
        text,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          cacheReadTokens: (response.usage as CacheUsage)?.cache_read_input_tokens,
          cacheWriteTokens: (response.usage as CacheUsage)?.cache_creation_input_tokens,
        },
        model: response.model ?? this.preset.modelId,
        durationMs: Date.now() - startTime,
        finishReason: response.stop_reason ?? undefined,
      };
    } catch (err: unknown) {
      if (isAbortError(err, options.signal)) {
        return {
          text: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.preset.modelId,
          durationMs: Date.now() - startTime,
          aborted: true,
        };
      }

      const status = (err as HttpError)?.status;
      // Rate limit — return null silently, next keystroke retries
      if (status === 429 || status === 529) {
        return {
          text: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.preset.modelId,
          durationMs: Date.now() - startTime,
          errorType: String(status),
        };
      }

      // Auth error — throw with descriptive message
      if (status === 401) {
        throw new Error(
          `Anthropic API key invalid or missing. Check ${this.preset.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY'} in your environment or ~/.creds/api-keys.env`,
        );
      }

      throw err;
    }
  }

  dispose(): void {
    this.client = null;
  }

  private async getClient(): Promise<AnthropicClient> {
    // Resolved per request (an in-memory lookup) so a key replaced with
    // `setApiKey`, or changed in the environment, takes effect on the next
    // request instead of the cached client failing until reload.
    const apiKey = this.preset.apiKeyEnvVar ? resolveApiKey(this.preset.apiKeyEnvVar) : undefined;
    if (this.client && apiKey === this.clientKey) return this.client as AnthropicClient;
    if (!apiKey) {
      throw new Error(
        `API key not found for ${this.preset.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY'}. Set it in your environment or ~/.creds/api-keys.env`,
      );
    }

    // Dynamic import for lazy initialization (SDK is bundled by esbuild)
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    this.client = new Anthropic({
      apiKey,
      ...(this.preset.baseUrl && { baseURL: this.preset.baseUrl }),
      ...(this.preset.extraHeaders && { defaultHeaders: this.preset.extraHeaders }),
    });
    this.clientKey = apiKey;
    return this.client as AnthropicClient;
  }
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  // Our own signal is the source of truth: the SDK throws APIUserAbortError
  // ("Request was aborted.") only after checking that it was aborted. Matching
  // on message text also swallowed server errors that merely mention
  // "aborted", hiding them from the user and from the circuit breaker.
  if (signal.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

// Minimal type definitions for the Anthropic SDK to avoid import-time dependency
interface ContentBlock {
  type: string;
  text: string;
}

interface CacheUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface HttpError {
  status?: number;
}

interface AnthropicClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system: unknown;
        messages: Array<{ role: string; content: string }>;
        stop_sequences?: string[];
        [key: string]: unknown;
      },
      options?: { signal?: AbortSignal },
    ): Promise<{
      content: ContentBlock[];
      usage?: CacheUsage;
      model?: string;
      stop_reason?: string | null;
    }>;
  };
}
