import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveApiKey, clearApiKeyCache, _parseEnvFile } from '../../utils/api-key-store';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

import * as fs from 'fs';

const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('api-key-store', () => {
  beforeEach(() => {
    clearApiKeyCache();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    clearApiKeyCache();
  });

  describe('_parseEnvFile', () => {
    it('parses key=value pairs', () => {
      mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux');
      const result = _parseEnvFile('/fake/path');
      expect(result.get('FOO')).toBe('bar');
      expect(result.get('BAZ')).toBe('qux');
    });

    it('handles double-quoted values', () => {
      mockReadFileSync.mockReturnValue('KEY="some value"');
      const result = _parseEnvFile('/fake/path');
      expect(result.get('KEY')).toBe('some value');
    });

    it('handles single-quoted values', () => {
      mockReadFileSync.mockReturnValue("KEY='some value'");
      const result = _parseEnvFile('/fake/path');
      expect(result.get('KEY')).toBe('some value');
    });

    it('skips comments and blank lines', () => {
      mockReadFileSync.mockReturnValue('# comment\n\nKEY=val\n  # another');
      const result = _parseEnvFile('/fake/path');
      expect(result.size).toBe(1);
      expect(result.get('KEY')).toBe('val');
    });

    it('returns empty map when file does not exist', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = _parseEnvFile('/fake/path');
      expect(result.size).toBe(0);
    });
  });

  describe('resolveApiKey', () => {
    it('returns value from process.env first', () => {
      process.env.TEST_API_KEY_XYZ = 'from-env';
      try {
        expect(resolveApiKey('TEST_API_KEY_XYZ')).toBe('from-env');
      } finally {
        delete process.env.TEST_API_KEY_XYZ;
      }
    });

    it('returns undefined when key not found anywhere', () => {
      mockReadFileSync.mockReturnValue('');
      expect(resolveApiKey('NONEXISTENT_KEY_12345')).toBeUndefined();
    });
  });
});
