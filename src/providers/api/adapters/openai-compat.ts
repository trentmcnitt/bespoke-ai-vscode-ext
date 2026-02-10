import { ApiAdapter, ApiAdapterResult, Preset } from '../types';
import { resolveApiKey } from '../../../utils/api-key-store';

/**
 * OpenAI-compatible adapter. Covers OpenAI, xAI/Grok, and Ollama.
 *
 * Uses the `openai` npm package with configurable `baseURL` for
 * xAI (api.x.ai) and Ollama (localhost:11434).
 */
export class OpenAICompatAdapter implements ApiAdapter {
  readonly providerId: string;
  private client: unknown = null;
  private preset: Preset;

  constructor(preset: Preset) {
    this.preset = preset;
    this.providerId = preset.provider;
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
        },
        { signal: options.signal },
      );

      const text = response.choices?.[0]?.message?.content ?? null;
      const usage = response.usage;

      return {
        text,
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
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

    const { default: OpenAI } = await import('openai');
    this.client = new OpenAI({
      apiKey,
      baseURL: this.preset.baseUrl,
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
        },
        options?: { signal?: AbortSignal },
      ): Promise<{
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      }>;
    };
  };
}
