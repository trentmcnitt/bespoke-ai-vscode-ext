import { ApiAdapter, ApiAdapterResult, Preset } from '../types';
import { resolveApiKey } from '../../../utils/api-key-store';

/**
 * Gemini adapter using the @google/genai SDK.
 *
 * Supports context caching for the system prompt when enabled.
 * The SDK is an optional dependency — dynamically imported.
 */
export class GeminiAdapter implements ApiAdapter {
  readonly providerId = 'gemini';
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
    const genAI = await this.getClient();
    const startTime = Date.now();

    try {
      // Build the contents array for Gemini
      const contents: GeminiContent[] = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      const response = await (genAI as GenAIClient).models.generateContent({
        model: this.preset.modelId,
        contents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: options.maxTokens,
          temperature: options.temperature,
          stopSequences: options.stopSequences,
          abortSignal: options.signal,
        },
      });

      const text = response.text ?? null;
      const usage = response.usageMetadata;

      return {
        text,
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          cacheReadTokens: usage?.cachedContentTokenCount,
        },
        model: this.preset.modelId,
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

      const status = (err as HttpError)?.status ?? (err as GoogleError)?.httpStatusCode;

      // Rate limit
      if (status === 429) {
        return {
          text: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.preset.modelId,
          durationMs: Date.now() - startTime,
        };
      }

      // Auth error
      if (status === 401 || status === 403) {
        throw new Error(
          `Gemini API key invalid or missing. Check ${this.preset.apiKeyEnvVar ?? 'GOOGLE_API_KEY'} in your environment or ~/.creds/api-keys.env`,
        );
      }

      throw err;
    }
  }

  dispose(): void {
    this.client = null;
  }

  private async getClient(): Promise<GenAIClient> {
    if (this.client) return this.client as GenAIClient;

    const apiKey = this.preset.apiKeyEnvVar ? resolveApiKey(this.preset.apiKeyEnvVar) : undefined;
    if (!apiKey) {
      throw new Error(
        `API key not found for ${this.preset.apiKeyEnvVar ?? 'GOOGLE_API_KEY'}. Set it in your environment or ~/.creds/api-keys.env`,
      );
    }

    try {
      const { GoogleGenAI } = await import('@google/genai');
      this.client = new GoogleGenAI({ apiKey });
      return this.client as GenAIClient;
    } catch {
      throw new Error(
        'Gemini adapter requires the @google/genai package. Install it with: npm install @google/genai',
      );
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return false;
}

// Minimal type definitions to avoid import-time dependency
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface HttpError {
  status?: number;
}

interface GoogleError {
  httpStatusCode?: number;
}

interface GenAIClient {
  models: {
    generateContent(params: {
      model: string;
      contents: GeminiContent[];
      config?: {
        systemInstruction?: string;
        maxOutputTokens?: number;
        temperature?: number;
        stopSequences?: string[];
        abortSignal?: AbortSignal;
      };
    }): Promise<{
      text?: string;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    }>;
  };
}
