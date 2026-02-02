export type CompletionMode = 'prose' | 'code';

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
  updateConfig?(config: ExtensionConfig): void;
  recycleAll?(): Promise<void>;
}

export interface ExtensionConfig {
  enabled: boolean;
  mode: 'auto' | 'prose' | 'code';
  triggerMode: 'auto' | 'manual';
  debounceMs: number;
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
  claudeCode: {
    model: string;
    models: string[];
  };
  logLevel: 'info' | 'debug' | 'trace';
  activeProfile: string;
}

export interface ProfileOverrides {
  mode?: 'auto' | 'prose' | 'code';
  triggerMode?: 'auto' | 'manual';
  debounceMs?: number;
  logLevel?: 'info' | 'debug' | 'trace';
  claudeCode?: Partial<ExtensionConfig['claudeCode']>;
  prose?: Partial<ExtensionConfig['prose']>;
  code?: Partial<ExtensionConfig['code']>;
}
