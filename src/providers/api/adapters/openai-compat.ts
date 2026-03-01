import { randomUUID } from 'crypto';
import { ApiAdapter, ApiAdapterResult, Preset } from '../types';
import { resolveApiKey } from '../../../utils/api-key-store';

/**
 * OpenAI-compatible adapter. Covers OpenAI, xAI/Grok, Google Gemini,
 * OpenRouter, and Ollama.
 *
 * Uses the `openai` npm package with configurable `baseURL` for
 * provider-specific endpoints.
 */
export class OpenAICompatAdapter implements ApiAdapter {
  readonly providerId: string;
  private client: unknown = null;
  private preset: Preset;
  private sessionId: string;

  constructor(preset: Preset) {
    this.preset = preset;
    this.providerId = preset.provider;
    this.sessionId = randomUUID();
  }

  isConfigured(): boolean {
    // Ollama doesn't need an API key
    if (this.preset.provider === 'ollama') return true;
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

    // Build OpenAI-format messages
    const openaiMessages: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    try {
      const response = await (client as OpenAIClient).chat.completions.create(
        {
          model: this.preset.modelId,
          messages: openaiMessages,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
          stop: options.stopSequences,
          ...this.preset.extraBody,
        },
        { signal: options.signal },
      );

      const text = response.choices?.[0]?.message?.content ?? null;
      const usage = response.usage;

      // OpenAI-compat APIs include cached tokens in prompt_tokens (unlike
      // Anthropic where input_tokens excludes them). Subtract cached tokens
      // so inputTokens consistently means "non-cached input tokens" across
      // all adapters.
      const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const totalPromptTokens = usage?.prompt_tokens ?? 0;

      return {
        text,
        usage: {
          inputTokens: totalPromptTokens - cachedTokens,
          outputTokens: usage?.completion_tokens ?? 0,
          cacheReadTokens: cachedTokens || undefined,
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

      // Rate limit — return null silently
      if (status === 429) {
        return {
          text: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.preset.modelId,
          durationMs: Date.now() - startTime,
        };
      }

      // Auth error
      if (status === 401) {
        const provider = this.preset.provider;
        const envVar = this.preset.apiKeyEnvVar ?? 'API_KEY';
        throw new Error(
          `${provider} API key invalid or missing. Check ${envVar} in your environment or ~/.creds/api-keys.env`,
        );
      }

      // Connection refused — likely Ollama not running
      if (isConnectionError(err)) {
        return {
          text: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.preset.modelId,
          durationMs: Date.now() - startTime,
        };
      }

      throw err;
    }
  }

  dispose(): void {
    this.client = null;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (this.client) return this.client as OpenAIClient;

    let apiKey: string | undefined;
    if (this.preset.provider === 'ollama') {
      // Ollama doesn't require auth — use a dummy key
      apiKey = 'ollama';
    } else {
      apiKey = this.preset.apiKeyEnvVar ? resolveApiKey(this.preset.apiKeyEnvVar) : undefined;
      if (!apiKey) {
        throw new Error(
          `API key not found for ${this.preset.apiKeyEnvVar}. Set it in your environment or ~/.creds/api-keys.env`,
        );
      }
    }

    // Provider-specific headers
    const defaultHeaders: Record<string, string> = {};
    if (this.preset.provider === 'xai') {
      defaultHeaders['x-grok-conv-id'] = this.sessionId;
    } else if (this.preset.provider === 'openrouter') {
      defaultHeaders['HTTP-Referer'] = 'https://github.com/trentmcnitt/bespoke-ai-vscode-ext';
      defaultHeaders['X-OpenRouter-Title'] = 'Bespoke AI';
    }
    if (this.preset.extraHeaders) {
      Object.assign(defaultHeaders, this.preset.extraHeaders);
    }

    const { default: OpenAI } = await import('openai');
    this.client = new OpenAI({
      apiKey,
      baseURL: this.preset.baseUrl,
      ...(Object.keys(defaultHeaders).length > 0 && { defaultHeaders }),
    });
    return this.client as OpenAIClient;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  // OpenAI SDK wraps abort errors
  if (err instanceof Error && err.message?.includes('aborted')) return true;
  return false;
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network');
}

// Minimal type definitions to avoid import-time dependency
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface HttpError {
  status?: number;
}

interface OpenAIClient {
  chat: {
    completions: {
      create(
        params: {
          model: string;
          messages: OpenAIMessage[];
          max_tokens: number;
          temperature: number;
          stop?: string[];
          [key: string]: unknown;
        },
        options?: { signal?: AbortSignal },
      ): Promise<{
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
        model?: string;
      }>;
    };
  };
}
