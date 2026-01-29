export type CompletionMode = 'prose' | 'code';
export type Backend = 'anthropic' | 'ollama';

export interface CompletionContext {
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  filePath: string;
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
  /** Raw suffix text for providers that support native FIM (e.g. Ollama suffix param) */
  suffix?: string;
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
    models: string[];
    useCaching: boolean;
  };
  ollama: {
    endpoint: string;
    model: string;
    models: string[];
    raw: boolean;
  };
  prose: {
    maxTokens: number;
    temperature: number;
    stopSequences: string[];
    contextChars: number;
    suffixChars: number;
    fileTypes: string[];
  };
  code: {
    maxTokens: number;
    temperature: number;
    stopSequences: string[];
    contextChars: number;
    suffixChars: number;
  };
  logLevel: 'info' | 'debug' | 'trace';
  activeProfile: string;
  oracle: {
    enabled: boolean;
    debounceMs: number;
    briefTtlMs: number;
    model: string;
    allowedTools: string[];
  };
}

export interface ProfileOverrides {
  backend?: Backend;
  mode?: 'auto' | 'prose' | 'code';
  debounceMs?: number;
  logLevel?: 'info' | 'debug' | 'trace';
  anthropic?: Partial<Omit<ExtensionConfig['anthropic'], 'apiKey'>>;
  ollama?: Partial<ExtensionConfig['ollama']>;
  prose?: Partial<ExtensionConfig['prose']>;
  code?: Partial<ExtensionConfig['code']>;
  oracle?: Partial<ExtensionConfig['oracle']>;
}
