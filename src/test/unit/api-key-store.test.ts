import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveApiKey,
  resolveApiKeySource,
  clearApiKeyCache,
  _parseEnvFile,
  initSecretStorage,
  loadSecretKey,
  storeSecretKey,
  removeSecretKey,
  hasSecretKey,
  SecretStorageLike,
} from '../../utils/api-key-store';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

import * as fs from 'fs';

const mockReadFileSync = vi.mocked(fs.readFileSync);

function makeSecretStorage(): SecretStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn((key: string) => Promise.resolve(data.get(key))),
    store: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
  };
}

describe('api-key-store', () => {
  beforeEach(() => {
    clearApiKeyCache();
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    clearApiKeyCache();
    // Reset secret storage to avoid leaking between tests
    initSecretStorage(null as unknown as SecretStorageLike);
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

  describe('SecretStorage integration', () => {
    it('resolves key from SecretStorage cache after loadSecretKey', async () => {
      const storage = makeSecretStorage();
      storage.data.set('bespokeAI.apiKey.MY_KEY', 'secret-value');
      initSecretStorage(storage);

      await loadSecretKey('MY_KEY');
      expect(resolveApiKey('MY_KEY')).toBe('secret-value');
    });

    it('SecretStorage takes priority over process.env', async () => {
      const storage = makeSecretStorage();
      storage.data.set('bespokeAI.apiKey.TEST_PRIORITY_KEY', 'from-secret');
      initSecretStorage(storage);
      await loadSecretKey('TEST_PRIORITY_KEY');

      process.env.TEST_PRIORITY_KEY = 'from-env';
      try {
        expect(resolveApiKey('TEST_PRIORITY_KEY')).toBe('from-secret');
      } finally {
        delete process.env.TEST_PRIORITY_KEY;
      }
    });

    it('storeSecretKey stores and caches the key', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);

      await storeSecretKey('NEW_KEY', 'new-value');
      expect(resolveApiKey('NEW_KEY')).toBe('new-value');
      expect(storage.store).toHaveBeenCalledWith('bespokeAI.apiKey.NEW_KEY', 'new-value');
    });

    it('removeSecretKey removes from storage and cache', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);

      await storeSecretKey('DEL_KEY', 'to-delete');
      expect(resolveApiKey('DEL_KEY')).toBe('to-delete');

      await removeSecretKey('DEL_KEY');
      mockReadFileSync.mockReturnValue('');
      expect(resolveApiKey('DEL_KEY')).toBeUndefined();
      expect(storage.delete).toHaveBeenCalledWith('bespokeAI.apiKey.DEL_KEY');
    });

    it('hasSecretKey returns true only for stored keys', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);

      expect(hasSecretKey('SOME_KEY')).toBe(false);
      await storeSecretKey('SOME_KEY', 'val');
      expect(hasSecretKey('SOME_KEY')).toBe(true);
    });

    it('clearApiKeyCache clears secret cache too', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);
      await storeSecretKey('CACHED_KEY', 'val');

      expect(resolveApiKey('CACHED_KEY')).toBe('val');
      clearApiKeyCache();
      mockReadFileSync.mockReturnValue('');
      expect(resolveApiKey('CACHED_KEY')).toBeUndefined();
    });

    it('loadSecretKey does nothing when key is not in storage', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);

      await loadSecretKey('MISSING_KEY');
      expect(hasSecretKey('MISSING_KEY')).toBe(false);
    });
  });

  describe('resolveApiKeySource', () => {
    it('returns keychain when key is in SecretStorage cache', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);
      await storeSecretKey('SRC_KEY', 'from-keychain');

      expect(resolveApiKeySource('SRC_KEY')).toBe('keychain');
    });

    it('returns env when key is in process.env', () => {
      process.env.SRC_ENV_KEY = 'from-env';
      try {
        expect(resolveApiKeySource('SRC_ENV_KEY')).toBe('env');
      } finally {
        delete process.env.SRC_ENV_KEY;
      }
    });

    it('returns file when key is in creds file', () => {
      mockReadFileSync.mockReturnValue('SRC_FILE_KEY=from-file');
      expect(resolveApiKeySource('SRC_FILE_KEY')).toBe('file');
    });

    it('returns null when key is not found', () => {
      mockReadFileSync.mockReturnValue('');
      expect(resolveApiKeySource('NONEXISTENT_SRC')).toBeNull();
    });

    it('keychain takes priority over env', async () => {
      const storage = makeSecretStorage();
      initSecretStorage(storage);
      await storeSecretKey('PRIORITY_SRC', 'from-keychain');

      process.env.PRIORITY_SRC = 'from-env';
      try {
        expect(resolveApiKeySource('PRIORITY_SRC')).toBe('keychain');
      } finally {
        delete process.env.PRIORITY_SRC;
      }
    });
  });
});
