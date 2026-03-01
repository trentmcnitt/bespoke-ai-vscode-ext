import { PromptStrategyId } from '../prompt-strategy';

export interface Preset {
  id: string;
  displayName: string;
  description?: string;
  provider: 'anthropic' | 'openai' | 'xai' | 'google' | 'openrouter' | 'ollama';
  modelId: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;

  maxTokens: number;
  temperature: number;
  stopSequences?: string[];

  /** Which prompt strategy to use for this preset. */
  promptStrategy: PromptStrategyId;

  features?: {
    promptCaching?: boolean;
    prefill?: boolean;
  };

  /** Extra parameters merged into the API request body. */
  extraBody?: Record<string, unknown>;

  /** Extra HTTP headers merged into API requests. */
  extraHeaders?: Record<string, string>;
}

export interface ApiAdapterResult {
  text: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  model: string;
  durationMs: number;
  /** True when the request was cancelled by an AbortSignal (not a real failure). */
  aborted?: boolean;
}

export interface ApiAdapter {
  readonly providerId: string;
  complete(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: {
      signal: AbortSignal;
      maxTokens: number;
      temperature: number;
      stopSequences?: string[];
    },
  ): Promise<ApiAdapterResult>;
  isConfigured(): boolean;
  dispose(): void;
}
