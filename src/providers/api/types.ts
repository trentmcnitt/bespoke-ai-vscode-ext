export interface Preset {
  id: string;
  displayName: string;
  provider: 'anthropic' | 'openai' | 'xai' | 'ollama' | 'gemini';
  modelId: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;

  maxTokens: number;
  temperature: number;
  stopSequences?: string[];

  features?: {
    promptCaching?: boolean;
    prefill?: boolean;
    contextCaching?: boolean;
  };

  pricing?: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok?: number;
  };

  /** Human-readable notes about how to get the best results from this model. */
  notes?: string;
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
