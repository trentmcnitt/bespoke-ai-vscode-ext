export type CompletionMode = 'prose' | 'code';

/** Default model used throughout the extension and tests.
 *  Keep in sync with the "default" value in package.json (bespokeAI.claudeCode.model). */
export const DEFAULT_MODEL = 'opus';

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
  contextMenu: {
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
  };
  logLevel: 'info' | 'debug' | 'trace';
}
