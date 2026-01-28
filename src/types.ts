export type CompletionMode = 'prose' | 'code';
export type Backend = 'anthropic' | 'ollama';

export interface CompletionContext {
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  mode: CompletionMode;
}

export interface CompletionProvider {
  getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null>;
  isAvailable(): boolean;
}

export interface BuiltPrompt {
  system: string;
  userMessage: string;
  assistantPrefill?: string;
  maxTokens: number;
  temperature: number;
  stopSequences: string[];
}

export interface ExtensionConfig {
  enabled: boolean;
  backend: Backend;
  mode: 'auto' | 'prose' | 'code';
  debounceMs: number;
  anthropic: {
    apiKey: string;
    model: string;
    useCaching: boolean;
  };
  ollama: {
    endpoint: string;
    model: string;
    raw: boolean;
  };
  prose: {
    maxTokens: number;
    temperature: number;
    stopSequences: string[];
    contextChars: number;
    fileTypes: string[];
  };
  code: {
    maxTokens: number;
    temperature: number;
    stopSequences: string[];
    contextChars: number;
  };
}
