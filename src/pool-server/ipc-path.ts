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
 * Ensure the state directory exists.
 * Called before writing the lockfile or (on Unix) creating the socket.
 */
export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}
