/**
 * Platform-aware IPC path utilities.
 *
 * - macOS/Linux: Unix domain socket at ~/.bespokeai/pool.sock
 * - Windows: Named pipe at \\.\pipe\bespokeai-pool-{username}
 *
 * Node.js net.createServer().listen() and net.createConnection() accept both
 * forms transparently. The protocol (newline-delimited JSON) and all socket
 * event handlers work identically across platforms.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_WINDOWS = process.platform === 'win32';

/** Directory for lockfile and other persistent state. */
export const STATE_DIR = path.join(os.homedir(), '.bespokeai');

/**
 * Current username for per-user IPC isolation.
 * Falls back to environment variables or 'default' if os.userInfo() throws
 * (can happen on Windows under certain domain/service account configurations).
 */
export function getUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'default';
  }
}

/**
 * IPC endpoint path.
 *
 * On macOS/Linux this is a Unix domain socket file.
 * On Windows this is a named pipe (kernel object, no file on disk).
 * The per-user suffix prevents collisions in multi-user environments.
 */
export function getIpcPath(): string {
  if (IS_WINDOWS) {
    return `\\\\.\\pipe\\bespokeai-pool-${getUsername()}`;
  }
  return path.join(STATE_DIR, 'pool.sock');
}

/** Lockfile path. Regular file on all platforms. */
export const LOCK_PATH = path.join(STATE_DIR, 'pool.lock');

/**
 * Check whether the IPC endpoint might be reachable.
 *
 * On macOS/Linux, checks if the socket file exists on disk.
 * On Windows, named pipes are kernel objects with no file presence —
 * always returns true so the caller attempts a connection (the connect
 * timeout handles the "no server" case). A connection to a non-existent
 * named pipe fails immediately with ENOENT, so there is no delay.
 */
export function ipcEndpointMayExist(): boolean {
  if (IS_WINDOWS) {
    return true;
  }
  return fs.existsSync(getIpcPath());
}

/**
 * Remove a stale IPC endpoint from disk if applicable.
 *
 * On macOS/Linux, removes the socket file so a new server can bind.
 * On Windows, named pipes are kernel objects that auto-cleanup when the
 * owning process exits — this is a no-op.
 */
export function cleanupStaleEndpoint(): void {
  if (IS_WINDOWS) return;
  const socketPath = getIpcPath();
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
}

/**
 * Owner-only state directory. It holds the pool socket and lockfile (used only by the same
 * user's VS Code windows), the usage ledger, and the opt-in trace file, which can hold prompt
 * text — nothing in it is meant for other local users.
 */
export const STATE_DIR_MODE = 0o700;

/**
 * Ensure the state directory exists, owner-only (0700).
 *
 * A new directory is created 0700. An existing one is tightened to 0700 only when it is a real
 * directory (not a symlink) owned by the current user — never chmod someone else's directory.
 * Tightening cannot break the pool: its socket and lockfile are only used by this same user.
 * Called before writing the lockfile or (on Unix) creating the socket, and at activation so the
 * API backend (which never starts the pool server) gets the same protection.
 */
export function ensureStateDir(dir: string = STATE_DIR): void {
  fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  if (IS_WINDOWS) return;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    if ((st.mode & 0o777) !== STATE_DIR_MODE) fs.chmodSync(dir, STATE_DIR_MODE);
  } catch {
    // Best effort: a failed tighten must not stop the pool from starting.
  }
}
