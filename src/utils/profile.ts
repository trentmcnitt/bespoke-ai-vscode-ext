import { ExtensionConfig, ProfileOverrides } from '../types';

/**
 * Deep-merge a profile's overrides onto a base config.
 */
export function applyProfile(base: ExtensionConfig, profile: ProfileOverrides): ExtensionConfig {
  return {
    ...base,
    ...(profile.mode !== undefined && { mode: profile.mode }),
    ...(profile.debounceMs !== undefined && { debounceMs: profile.debounceMs }),
    ...(profile.logLevel !== undefined && { logLevel: profile.logLevel }),
    claudeCode: { ...base.claudeCode, ...profile.claudeCode },
    prose: { ...base.prose, ...profile.prose },
    code: { ...base.code, ...profile.code },
  };
}
