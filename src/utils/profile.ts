import { ExtensionConfig, ProfileOverrides } from '../types';

/**
 * Deep-merge a profile's overrides onto a base config.
 * The API key always comes from the base config (security guard).
 */
export function applyProfile(base: ExtensionConfig, profile: ProfileOverrides): ExtensionConfig {
  return {
    ...base,
    ...(profile.backend !== undefined && { backend: profile.backend }),
    ...(profile.mode !== undefined && { mode: profile.mode }),
    ...(profile.debounceMs !== undefined && { debounceMs: profile.debounceMs }),
    ...(profile.logLevel !== undefined && { logLevel: profile.logLevel }),
    anthropic: { ...base.anthropic, ...profile.anthropic, apiKey: base.anthropic.apiKey },
    ollama: { ...base.ollama, ...profile.ollama },
    prose: { ...base.prose, ...profile.prose },
    code: { ...base.code, ...profile.code },
    oracle: { ...base.oracle, ...profile.oracle },
  };
}
