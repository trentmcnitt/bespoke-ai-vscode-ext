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
    contextChars: number;
    suffixChars: number;
    fileTypes: string[];
  };
  code: {
    contextChars: number;
    suffixChars: number;
  };
  claudeCode: {
    model: string;
    models: string[];
  };
  logLevel: 'info' | 'debug' | 'trace';
}
