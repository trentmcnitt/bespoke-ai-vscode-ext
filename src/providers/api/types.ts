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
    /** Anthropic models: the request ends with an assistant prefill (`prefill-extraction`). */
    prefill?: boolean;
    /**
     * `false` when the model rejects sampling parameters (HTTP 400 on
     * `temperature`): adapters then leave `temperature` out of the request.
     * Absent means sampling parameters are sent. See `model-capabilities.ts`.
     */
    sampling?: boolean;
  };

  /** Extra parameters merged into the API request body. */
  extraBody?: Record<string, unknown>;

  /** Extra HTTP headers merged into API requests. */
  extraHeaders?: Record<string, string>;
}

export interface ApiAdapterResult {
  text: string | null;
  /** `inputTokens` is NON-cached input across all adapters; cache reads/writes are separate. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  model: string;
  durationMs: number;
  /** True when the request was cancelled by an AbortSignal (not a real failure). */
  aborted?: boolean;
  /** Provider's stop/finish reason (e.g. `end_turn`, `stop`, `length`), when reported. */
  finishReason?: string;
  /** Set when the adapter swallowed a failure and returned null text (e.g. HTTP "429"). */
  errorType?: string;
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
