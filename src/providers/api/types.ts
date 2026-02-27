import { PromptStrategyId } from '../prompt-strategy';

export interface Preset {
  id: string;
  displayName: string;
  provider: 'anthropic' | 'openai' | 'xai' | 'ollama';
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

  pricing?: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
  };
}

export interface ApiAdapterResult {
  text: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  model: string;
  durationMs: number;
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
