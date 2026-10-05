/**
 * Config and logger stubs for running the extension's API pipeline outside VS Code.
 * Mirrors DEFAULT_CONFIG in src/test/helpers.ts (which can't be imported here: it
 * pulls in vitest). Type-checked against ExtensionConfig, so a new field fails
 * `npm run check` until it is added.
 */
import { DEFAULT_MODEL, ExtensionConfig } from '../src/types';
import type { Logger } from '../src/utils/logger';

export function playgroundConfig(presetId: string): ExtensionConfig {
  return {
    enabled: true,
    mode: 'auto',
    backend: 'api',
    triggerPreset: 'relaxed',
    triggerMode: 'auto',
    debounceMs: 2000,
    prose: { contextChars: 2500, suffixChars: 2000, fileTypes: [] },
    code: { contextChars: 2500, suffixChars: 2000 },
    claudeCode: { model: DEFAULT_MODEL, models: ['haiku', 'sonnet', 'opus', 'fable'] },
    api: { preset: presetId, customPresets: [] },
    codeOverride: { backend: '', model: '' },
    contextMenu: { agent: 'claude-code', permissionMode: 'default' },
    customInstructions: '',
    trace: {
      captureContent: true,
      file: false,
      otlp: { endpoint: '', headersEnvVar: 'BESPOKE_OTLP_HEADERS', captureContent: false },
    },
    logLevel: 'info',
  };
}

/** Errors go to stderr; everything else is dropped (the bench is the log). */
export function playgroundLogger(): Logger {
  const noop = (): void => {};
  return {
    setLevel: noop,
    info: noop,
    debug: noop,
    trace: noop,
    error: (msg: string, err?: unknown) => console.error(`[playground] ${msg}`, err ?? ''),
    requestStart: noop,
    requestEnd: noop,
    cacheHit: noop,
    traceBlock: noop,
    traceInline: noop,
    show: noop,
    dispose: noop,
  } as unknown as Logger;
}
