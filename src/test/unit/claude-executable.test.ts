import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));
vi.mock('os', () => ({
  homedir: vi.fn(),
}));
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { resolveClaudeExecutable, resetClaudeExecutableCache } from '../../utils/claude-executable';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockHomedir = vi.mocked(os.homedir);
const mockExecFileSync = vi.mocked(execFileSync);

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('resolveClaudeExecutable', () => {
  beforeEach(() => {
    resetClaudeExecutableCache();
    mockExistsSync.mockReset();
    mockHomedir.mockReset();
    mockExecFileSync.mockReset();
    mockHomedir.mockReturnValue('/home/user');
    setPlatform(originalPlatform);
  });

  it('prefers the native install and marks it native (unix)', () => {
    setPlatform('linux');
    mockExistsSync.mockImplementation((p) => p === '/home/user/.local/bin/claude');

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('native-install');
    expect(result.native).toBe(true);
    expect(result.path).toBe('/home/user/.local/bin/claude');
    // Native install is resolved from disk, never via PATH lookup.
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses the Windows .exe native install path', () => {
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\user');
    // path.join uses the host separator under test, so match on the suffix the
    // Windows branch actually appends rather than a hardcoded backslash path.
    mockExistsSync.mockImplementation((p) => String(p).endsWith('claude.exe'));

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('native-install');
    expect(result.native).toBe(true);
    expect(result.path).toContain('claude.exe');
  });

  it('falls back to a native binary found on PATH', () => {
    setPlatform('linux');
    // No native install on disk, but PATH resolves to a real binary.
    mockExistsSync.mockImplementation((p) => p === '/usr/local/bin/claude');
    mockExecFileSync.mockReturnValue('/usr/local/bin/claude\n' as never);

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('path');
    expect(result.native).toBe(true);
    expect(result.path).toBe('/usr/local/bin/claude');
  });

  it('rejects a .cmd shim on PATH and falls back to the bundled cli.js', () => {
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\user');
    // No native install; PATH only offers a non-native .cmd shim.
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('C:\\npm\\claude.cmd\n' as never);

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('bundled');
    expect(result.native).toBe(false);
    expect(result.path).toContain('cli.js');
  });

  it('rejects the extensionless npm Unix shim on Windows PATH', () => {
    // Regression: `where claude` on Windows surfaces the extensionless npm shim
    // (a bash script) first. It must not be treated as a native binary — the
    // SDK would spawn it directly and fail with ENOENT.
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\user');
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue(
      'C:\\Programas\\nodejs\\claude\nC:\\Programas\\nodejs\\claude.cmd\n' as never,
    );

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('bundled');
    expect(result.native).toBe(false);
    expect(result.path).toContain('cli.js');
  });

  it('accepts a .exe binary on Windows PATH', () => {
    setPlatform('win32');
    mockHomedir.mockReturnValue('C:\\Users\\user');
    // No native install on disk, but PATH resolves to a real .exe binary.
    mockExistsSync.mockImplementation((p) => String(p) === 'C:\\tools\\claude.exe');
    mockExecFileSync.mockReturnValue('C:\\tools\\claude.exe\n' as never);

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('path');
    expect(result.native).toBe(true);
    expect(result.path).toBe('C:\\tools\\claude.exe');
  });

  it('falls back to the bundled cli.js when nothing else is found', () => {
    setPlatform('linux');
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = resolveClaudeExecutable();

    expect(result.source).toBe('bundled');
    expect(result.native).toBe(false);
    expect(result.path).toContain('cli.js');
  });

  it('caches the resolution across calls', () => {
    setPlatform('linux');
    mockExistsSync.mockImplementation((p) => p === '/home/user/.local/bin/claude');

    const first = resolveClaudeExecutable();
    mockExistsSync.mockReturnValue(false);
    const second = resolveClaudeExecutable();

    expect(second).toBe(first);
    expect(second.source).toBe('native-install');
  });
});
