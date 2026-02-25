export type CompletionMode = 'prose' | 'code';

/** Default model used throughout the extension and tests.
 *  Keep in sync with the "default" value in package.json (bespokeAI.claudeCode.model). */
export const DEFAULT_MODEL = 'haiku';

/** Trigger presets control when completions appear. */
export type TriggerPreset = 'relaxed' | 'eager' | 'on-demand';

/** Resolved trigger behavior for each preset. */
export const TRIGGER_PRESET_DEFAULTS: Record<
  TriggerPreset,
  { triggerMode: 'auto' | 'manual'; debounceMs: number }
> = {
  relaxed: { triggerMode: 'auto', debounceMs: 2000 },
  eager: { triggerMode: 'auto', debounceMs: 800 },
  'on-demand': { triggerMode: 'manual', debounceMs: 0 },
};

/** Input signals for resolving trigger preset, triggerMode, and debounceMs.
 *  Each flag indicates whether the user explicitly set the value (vs relying on the default). */
export interface PresetResolutionInput {
  presetExplicitlySet: boolean;
  presetValue: string;
  triggerModeExplicitlySet: boolean;
  triggerModeValue: string;
  debounceExplicitlySet: boolean;
  debounceValue: number;
}

/** Resolve trigger preset, triggerMode, and debounceMs from user settings.
 *  Pure function — no VS Code dependency. */
export function resolvePreset(input: PresetResolutionInput): {
  triggerPreset: TriggerPreset;
  triggerMode: 'auto' | 'manual';
  debounceMs: number;
} {
  let triggerPreset: TriggerPreset;
  if (input.presetExplicitlySet) {
    triggerPreset = input.presetValue as TriggerPreset;
  } else if (input.triggerModeExplicitlySet && input.triggerModeValue === 'manual') {
    triggerPreset = 'on-demand';
  } else {
    triggerPreset = 'relaxed';
  }

  const presetDefaults = TRIGGER_PRESET_DEFAULTS[triggerPreset];
  const debounceMs = input.debounceExplicitlySet ? input.debounceValue : presetDefaults.debounceMs;

  return { triggerPreset, triggerMode: presetDefaults.triggerMode, debounceMs };
}

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
  triggerPreset: TriggerPreset;
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
