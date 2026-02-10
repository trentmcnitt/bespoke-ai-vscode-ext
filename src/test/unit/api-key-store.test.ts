import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _parseEnvFile, resolveApiKey, clearApiKeyCache } from '../../utils/api-key-store';

describe('parseEnvFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-key-store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses simple key=value pairs', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, 'FOO=bar\nBAZ=qux\n');
    const result = _parseEnvFile(file);
    expect(result.get('FOO')).toBe('bar');
    expect(result.get('BAZ')).toBe('qux');
  });

  it('handles double-quoted values', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, 'KEY="my secret value"\n');
    const result = _parseEnvFile(file);
    expect(result.get('KEY')).toBe('my secret value');
  });

  it('handles single-quoted values', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, "KEY='my secret value'\n");
    const result = _parseEnvFile(file);
    expect(result.get('KEY')).toBe('my secret value');
  });

  it('skips comments and blank lines', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, '# comment\n\nKEY=value\n  \n# another comment\n');
    const result = _parseEnvFile(file);
    expect(result.size).toBe(1);
    expect(result.get('KEY')).toBe('value');
  });

  it('skips malformed lines (no =)', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, 'GOOD=value\nBADLINE\n');
    const result = _parseEnvFile(file);
    expect(result.size).toBe(1);
    expect(result.get('GOOD')).toBe('value');
  });

  it('returns empty map for missing file', () => {
    const result = _parseEnvFile('/nonexistent/path/file.env');
    expect(result.size).toBe(0);
  });

  it('handles values with = sign', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, 'KEY=value=with=equals\n');
    const result = _parseEnvFile(file);
    expect(result.get('KEY')).toBe('value=with=equals');
  });

  it('trims whitespace around keys and values', () => {
    const file = path.join(tmpDir, 'test.env');
    fs.writeFileSync(file, '  KEY  =  value  \n');
    const result = _parseEnvFile(file);
    expect(result.get('KEY')).toBe('value');
  });
});

describe('resolveApiKey', () => {
  beforeEach(() => {
    clearApiKeyCache();
  });

  afterEach(() => {
    clearApiKeyCache();
    delete process.env.TEST_RESOLVE_KEY;
  });

  it('returns process.env value when set', () => {
    process.env.TEST_RESOLVE_KEY = 'from-env';
    expect(resolveApiKey('TEST_RESOLVE_KEY')).toBe('from-env');
  });

  it('returns undefined for unset key with no creds file', () => {
    expect(resolveApiKey('NONEXISTENT_KEY_12345')).toBeUndefined();
  });

  it('prefers process.env over creds file', () => {
    process.env.TEST_RESOLVE_KEY = 'from-env';
    // Even if the creds file had a different value, env takes priority
    expect(resolveApiKey('TEST_RESOLVE_KEY')).toBe('from-env');
  });
});
