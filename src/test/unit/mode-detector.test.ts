import { describe, it, expect } from 'vitest';
import { ModeDetector } from '../../mode-detector';
import { makeConfig } from '../helpers';

describe('ModeDetector', () => {
  const detector = new ModeDetector();

  describe('auto mode', () => {
    it('detects markdown as prose', () => {
      expect(detector.detectMode('markdown', makeConfig())).toBe('prose');
    });

    it('detects plaintext as prose', () => {
      expect(detector.detectMode('plaintext', makeConfig())).toBe('prose');
    });

    it('detects latex as prose', () => {
      expect(detector.detectMode('latex', makeConfig())).toBe('prose');
    });

    it('detects typescript as code', () => {
      expect(detector.detectMode('typescript', makeConfig())).toBe('code');
    });

    it('detects javascript as code', () => {
      expect(detector.detectMode('javascript', makeConfig())).toBe('code');
    });

    it('detects python as code', () => {
      expect(detector.detectMode('python', makeConfig())).toBe('code');
    });

    it('detects rust as code', () => {
      expect(detector.detectMode('rust', makeConfig())).toBe('code');
    });

    it('detects html as code', () => {
      expect(detector.detectMode('html', makeConfig())).toBe('code');
    });

    it('detects json as code', () => {
      expect(detector.detectMode('json', makeConfig())).toBe('code');
    });

    it('falls back to prose for unknown language IDs', () => {
      expect(detector.detectMode('unknown-lang-xyz', makeConfig())).toBe('prose');
    });

    it('falls back to prose for empty string language ID', () => {
      expect(detector.detectMode('', makeConfig())).toBe('prose');
    });
  });

  describe('user overrides', () => {
    it('forces prose mode regardless of language', () => {
      expect(detector.detectMode('typescript', makeConfig({ mode: 'prose' }))).toBe('prose');
      expect(detector.detectMode('python', makeConfig({ mode: 'prose' }))).toBe('prose');
    });

    it('forces code mode regardless of language', () => {
      expect(detector.detectMode('markdown', makeConfig({ mode: 'code' }))).toBe('code');
      expect(detector.detectMode('plaintext', makeConfig({ mode: 'code' }))).toBe('code');
    });
  });

  describe('custom prose file types from config', () => {
    it('treats custom language IDs as prose', () => {
      const config = makeConfig();
      config.prose.fileTypes = ['markdown', 'plaintext', 'my-custom-prose'];
      expect(detector.detectMode('my-custom-prose', config)).toBe('prose');
    });

    it('custom file types take precedence over code language set', () => {
      const config = makeConfig();
      // Force typescript to be treated as prose via fileTypes
      config.prose.fileTypes = ['typescript'];
      expect(detector.detectMode('typescript', config)).toBe('prose');
    });
  });
});
