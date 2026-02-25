import { describe, it, expect } from 'vitest';
import { resolvePreset, PresetResolutionInput } from '../../types';

/** Shorthand: returns input with all flags false (nothing explicitly set). */
function defaults(overrides: Partial<PresetResolutionInput> = {}): PresetResolutionInput {
  return {
    presetExplicitlySet: false,
    presetValue: 'relaxed',
    triggerModeExplicitlySet: false,
    triggerModeValue: 'auto',
    debounceExplicitlySet: false,
    debounceValue: 2000,
    ...overrides,
  };
}

describe('resolvePreset', () => {
  describe('preset selection', () => {
    it('defaults to relaxed when nothing is explicitly set', () => {
      const result = resolvePreset(defaults());
      expect(result.triggerPreset).toBe('relaxed');
      expect(result.triggerMode).toBe('auto');
      expect(result.debounceMs).toBe(2000);
    });

    it('uses explicitly set preset', () => {
      const result = resolvePreset(defaults({ presetExplicitlySet: true, presetValue: 'eager' }));
      expect(result.triggerPreset).toBe('eager');
      expect(result.triggerMode).toBe('auto');
      expect(result.debounceMs).toBe(800);
    });

    it('uses on-demand preset when explicitly set', () => {
      const result = resolvePreset(
        defaults({ presetExplicitlySet: true, presetValue: 'on-demand' }),
      );
      expect(result.triggerPreset).toBe('on-demand');
      expect(result.triggerMode).toBe('manual');
      expect(result.debounceMs).toBe(0);
    });
  });

  describe('backward compat: triggerMode=manual', () => {
    it('maps triggerMode=manual to on-demand when no preset is set', () => {
      const result = resolvePreset(
        defaults({ triggerModeExplicitlySet: true, triggerModeValue: 'manual' }),
      );
      expect(result.triggerPreset).toBe('on-demand');
      expect(result.triggerMode).toBe('manual');
      expect(result.debounceMs).toBe(0);
    });

    it('ignores triggerMode=manual when preset is explicitly set', () => {
      const result = resolvePreset(
        defaults({
          presetExplicitlySet: true,
          presetValue: 'eager',
          triggerModeExplicitlySet: true,
          triggerModeValue: 'manual',
        }),
      );
      expect(result.triggerPreset).toBe('eager');
      expect(result.triggerMode).toBe('auto');
    });

    it('ignores triggerMode=auto even when explicitly set (no effect)', () => {
      const result = resolvePreset(
        defaults({ triggerModeExplicitlySet: true, triggerModeValue: 'auto' }),
      );
      expect(result.triggerPreset).toBe('relaxed');
      expect(result.triggerMode).toBe('auto');
    });
  });

  describe('debounceMs override', () => {
    it('uses preset debounce when debounceMs is not explicitly set', () => {
      const result = resolvePreset(defaults({ presetExplicitlySet: true, presetValue: 'eager' }));
      expect(result.debounceMs).toBe(800);
    });

    it('uses explicit debounceMs when set, overriding the preset', () => {
      const result = resolvePreset(
        defaults({
          presetExplicitlySet: true,
          presetValue: 'eager',
          debounceExplicitlySet: true,
          debounceValue: 5000,
        }),
      );
      expect(result.triggerPreset).toBe('eager');
      expect(result.debounceMs).toBe(5000);
    });

    it('uses explicit debounceMs with default relaxed preset', () => {
      const result = resolvePreset(defaults({ debounceExplicitlySet: true, debounceValue: 3000 }));
      expect(result.triggerPreset).toBe('relaxed');
      expect(result.debounceMs).toBe(3000);
    });
  });
});
