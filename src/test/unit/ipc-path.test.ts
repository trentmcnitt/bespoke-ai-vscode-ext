import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  // Temp dirs only: the default target is the developer's real ~/.bespokeai.
  it('creates the directory if it does not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-'));
    try {
      const dir = path.join(tmp, 'a', '.bespokeai');
      ensureStateDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not throw if the directory already exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-'));
    try {
      ensureStateDir(tmp);
      expect(() => ensureStateDir(tmp)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe.skipIf(IS_WINDOWS)('owner-only mode (0700)', () => {
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('creates a new directory 0700', () => {
      const dir = path.join(tmp, '.bespokeai');
      ensureStateDir(dir);
      expect(mode(dir)).toBe(0o700);
    });

    it('tightens an existing 0755 directory owned by this user', () => {
      const dir = path.join(tmp, '.bespokeai');
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o755);
      ensureStateDir(dir);
      expect(mode(dir)).toBe(0o700);
    });

    it('does not chmod through a symlink', () => {
      const real = path.join(tmp, 'real');
      fs.mkdirSync(real);
      fs.chmodSync(real, 0o755);
      const link = path.join(tmp, '.bespokeai');
      fs.symlinkSync(real, link);
      ensureStateDir(link);
      expect(mode(real)).toBe(0o755);
    });
  });
});
