import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where the Claude Code executable was found, and whether it is a standalone
 * native binary or the bundled Node script.
 */
export interface ResolvedClaudeExecutable {
  /** Absolute path to the executable (native binary or the bundled cli.js). */
  path: string;
  /**
   * True when `path` is a standalone native binary the SDK can spawn directly.
   * False when it is the bundled `cli.js`, which the SDK runs via `node <cli.js>`
   * and therefore requires `node` to be on PATH.
   *
   * The SDK decides this itself from the file extension (see `isNativeBinary` in
   * the SDK), so we only need to hand it the right path — this flag mirrors that
   * decision for logging and diagnostics.
   */
  native: boolean;
  /** How the path was resolved, for logging. */
  source: 'native-install' | 'path' | 'bundled';
}

/** Non-win32 only: JS-script extensions the SDK must run via `node` rather than
 * spawn directly. Windows uses the `WINDOWS_NATIVE_EXTENSIONS` allowlist below
 * and never consults this list. */
const NON_NATIVE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** Extensions Windows can spawn directly as a standalone executable. */
const WINDOWS_NATIVE_EXTENSIONS = ['.exe', '.com'];

function looksLikeNativeBinary(executablePath: string): boolean {
  const lower = executablePath.toLowerCase();
  if (process.platform === 'win32') {
    // On Windows a directly-spawnable native binary must carry an executable
    // extension. `where claude` also surfaces the extensionless npm Unix shim
    // (e.g. `C:\...\nodejs\claude`, a bash script) — the SDK's own
    // `isNativeBinary` classifies that as native by the absence of a JS
    // extension and spawns it directly, which fails with ENOENT because Windows
    // cannot execute an extensionless script. Requiring `.exe`/`.com` here skips
    // that shim so we fall back to the bundled cli.js run via `node`.
    return WINDOWS_NATIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }
  return !NON_NATIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The native installer places the Claude executable at a well-known location
 * under the user's home directory. This is resolved directly from the
 * filesystem (not via PATH), so it works even when the VS Code extension-host
 * process did not inherit the shell PATH that the installer updated — the exact
 * situation that breaks bare `claude`/`node` lookups on Windows.
 */
function nativeInstallPath(): string {
  const home = os.homedir();
  return process.platform === 'win32'
    ? path.join(home, '.local', 'bin', 'claude.exe')
    : path.join(home, '.local', 'bin', 'claude');
}

/**
 * Locate `claude` on PATH via `where`/`which`, accepting only a real native
 * binary (skips `.cmd`/`.ps1` shims and the `.js` npm shim, which would still
 * require `node`).
 */
function findClaudeOnPath(): string | null {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, ['claude'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    const candidates = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      if (looksLikeNativeBinary(candidate) && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // `claude` not found on PATH — fall through to the bundled cli.js.
  }
  return null;
}

/** Path to the SDK's bundled cli.js (a Node script; requires `node` on PATH). */
function bundledCliPath(): string {
  return require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
}

let cached: ResolvedClaudeExecutable | null = null;

/**
 * Resolve the Claude Code executable to hand the Agent SDK.
 *
 * Preference order:
 *   1. Native install at `~/.local/bin/claude(.exe)` — a standalone binary that
 *      runs without `node` on PATH. Preferred because it fixes startup on
 *      machines (notably Windows) where the extension host has no `node`.
 *   2. A native `claude` binary found on PATH.
 *   3. The bundled `cli.js` shipped in the VSIX — current behavior, only works
 *      when `node` is on PATH.
 *
 * The result is cached for the process lifetime.
 */
export function resolveClaudeExecutable(): ResolvedClaudeExecutable {
  if (cached) {
    return cached;
  }

  const native = nativeInstallPath();
  if (fs.existsSync(native)) {
    cached = { path: native, native: true, source: 'native-install' };
    return cached;
  }

  const onPath = findClaudeOnPath();
  if (onPath) {
    cached = { path: onPath, native: true, source: 'path' };
    return cached;
  }

  cached = { path: bundledCliPath(), native: false, source: 'bundled' };
  return cached;
}

/** Test-only: clear the memoized resolution. */
export function resetClaudeExecutableCache(): void {
  cached = null;
}
