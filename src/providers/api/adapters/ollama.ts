import { ApiAdapter, ApiAdapterResult, Preset } from '../types';

/**
 * Native Ollama API adapter. Calls /api/chat directly instead of the
 * OpenAI-compatible /v1 endpoint. This is required for thinking/reasoning
 * models (e.g. Qwen 3.5) which need `think: false` to produce content
 * instead of burning tokens on reasoning traces.
 */
export class OllamaAdapter implements ApiAdapter {
  readonly providerId = 'ollama';
  private preset: Preset;

  constructor(preset: Preset) {
    this.preset = preset;
  }

  isConfigured(): boolean {
    return true; // Ollama never needs an API key
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
    const startTime = Date.now();
    const url = this.buildUrl();

    const ollamaMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body: Record<string, unknown> = {
      model: this.preset.modelId,
      messages: ollamaMessages,
      stream: false,
      think: false,
      options: {
        num_predict: options.maxTokens,
        temperature: options.temperature,
        ...(options.stopSequences?.length ? { stop: options.stopSequences } : {}),
      },
      ...this.preset.extraBody,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.preset.extraHeaders,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (response.status === 429) {
        return {
          text: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.preset.modelId,
          durationMs: Date.now() - startTime,
        };
      }

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as OllamaResponse;
      const text = data.message?.content || null;

      return {
        text,
        usage: {
          inputTokens: data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count ?? 0,
        },
        model: data.model ?? this.preset.modelId,
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

      // Connection refused — Ollama likely not running, return null silently
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
    // No persistent client to clean up
  }

  /** Resolve the /api/chat URL, stripping /v1 suffix for backward compat. */
  private buildUrl(): string {
    let base = this.preset.baseUrl ?? 'http://localhost:11434';
    if (base.endsWith('/v1')) {
      base = base.slice(0, -3);
    }
    base = base.replace(/\/+$/, '');
    return `${base}/api/chat`;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return false;
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('econnrefused') || msg.includes('fetch failed') || msg.includes('network');
}

// Minimal type definition for Ollama /api/chat response
interface OllamaResponse {
  model?: string;
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}
