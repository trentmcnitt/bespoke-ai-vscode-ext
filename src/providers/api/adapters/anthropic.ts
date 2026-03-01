import { ApiAdapter, ApiAdapterResult, Preset } from '../types';
import { resolveApiKey } from '../../../utils/api-key-store';

export class AnthropicAdapter implements ApiAdapter {
  readonly providerId = 'anthropic';
  private client: unknown = null;
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
          temperature: options.temperature,
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
        },
        model: response.model ?? this.preset.modelId,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      if (isAbortError(err)) {
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
    if (this.client) return this.client as AnthropicClient;

    const apiKey = this.preset.apiKeyEnvVar ? resolveApiKey(this.preset.apiKeyEnvVar) : undefined;
    if (!apiKey) {
      throw new Error(
        `API key not found for ${this.preset.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY'}. Set it in your environment or ~/.creds/api-keys.env`,
      );
    }

    // Dynamic import for lazy initialization (SDK is bundled by esbuild)
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    this.client = new Anthropic({
      apiKey,
      ...(this.preset.extraHeaders && { defaultHeaders: this.preset.extraHeaders }),
    });
    return this.client as AnthropicClient;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  // Anthropic SDK wraps abort errors
  if (err instanceof Error && err.message?.includes('aborted')) return true;
  return false;
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
        temperature: number;
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
    }>;
  };
}
