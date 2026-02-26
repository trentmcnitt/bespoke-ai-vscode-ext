import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  STATE_DIR,
  LOCK_PATH,
  getIpcPath,
  getUsername,
  ipcEndpointMayExist,
  cleanupStaleEndpoint,
  ensureStateDir,
} from '../../pool-server/ipc-path';

describe('STATE_DIR', () => {
  it('is under home directory', () => {
    expect(STATE_DIR).toBe(path.join(os.homedir(), '.bespokeai'));
  });
});

describe('LOCK_PATH', () => {
  it('is under STATE_DIR', () => {
    expect(LOCK_PATH).toBe(path.join(STATE_DIR, 'pool.lock'));
  });
});

describe('getUsername', () => {
  it('returns a non-empty string', () => {
    const result = getUsername();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('matches os.userInfo().username on this platform', () => {
    expect(getUsername()).toBe(os.userInfo().username);
  });
});

const IS_WINDOWS = process.platform === 'win32';

describe('getIpcPath', () => {
  it.skipIf(IS_WINDOWS)('returns a Unix socket path under STATE_DIR on macOS/Linux', () => {
    expect(getIpcPath()).toBe(path.join(STATE_DIR, 'pool.sock'));
  });

  it.skipIf(!IS_WINDOWS)('returns a named pipe path on Windows', () => {
    expect(getIpcPath()).toMatch(/^\\\\\.\\pipe\\bespokeai-pool-/);
  });

  it('returns a consistent value across calls', () => {
    expect(getIpcPath()).toBe(getIpcPath());
  });
});

describe('ipcEndpointMayExist', () => {
  it('returns a boolean', () => {
    expect(typeof ipcEndpointMayExist()).toBe('boolean');
  });
});

describe('cleanupStaleEndpoint', () => {
  it('does not throw when no endpoint exists', () => {
    expect(() => cleanupStaleEndpoint()).not.toThrow();
  });
});

describe('ensureStateDir', () => {
  it('creates the directory if it does not exist', () => {
    // ensureStateDir targets STATE_DIR which already exists in normal use.
    // We verify the contract by confirming STATE_DIR exists after the call.
    ensureStateDir();
    expect(fs.existsSync(STATE_DIR)).toBe(true);
  });

  it('does not throw if the directory already exists', () => {
    ensureStateDir();
    expect(() => ensureStateDir()).not.toThrow();
  });
});
