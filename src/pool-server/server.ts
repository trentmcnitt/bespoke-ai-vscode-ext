/**
 * Global Pool Server
 *
 * Manages shared ClaudeCodeProvider and CommandPool instances for all VS Code windows.
 * Listens on a Unix domain socket (macOS/Linux) or named pipe (Windows).
 */

import * as net from 'net';
import * as fs from 'fs';
import { Logger } from '../utils/logger';
import { UsageLedger } from '../utils/usage-ledger';
import { ClaudeCodeProvider } from '../providers/claude-code';
import { CommandPool } from '../providers/command-pool';
import { ResultMetadata, PoolStats } from '../providers/slot-pool';
import { ExtensionConfig, CompletionContext } from '../types';
import {
  PoolRequest,
  PoolResponse,
  ServerEvent,
  CompletionRequest,
  CommandRequest,
  ConfigUpdateRequest,
  serializeMessage,
  parseMessage,
} from './protocol';
import { LOCK_PATH, getIpcPath, cleanupStaleEndpoint, ensureStateDir } from './ipc-path';

export interface PoolServerOptions {
  config: ExtensionConfig;
  logger: Logger;
  ledger: UsageLedger;
  serverId: string;
  onPoolDegraded?: (pool: 'completion' | 'command') => void;
}

interface ConnectedClient {
  id: string;
  socket: net.Socket;
  buffer: string;
}

export class PoolServer {
  private server: net.Server | null = null;
  private clients = new Map<net.Socket, ConnectedClient>();
  private completionProvider: ClaudeCodeProvider;
  private commandPool: CommandPool;
  private logger: Logger;
  private ledger: UsageLedger;
  private config: ExtensionConfig;
  private serverId: string;
  private disposed = false;
  private onPoolDegraded?: (pool: 'completion' | 'command') => void;

  constructor(options: PoolServerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.ledger = options.ledger;
    this.serverId = options.serverId;
    this.onPoolDegraded = options.onPoolDegraded;

    // Create providers
    this.completionProvider = new ClaudeCodeProvider(this.config, this.logger);
    this.completionProvider.setLedger(this.ledger);
    this.completionProvider.onPoolDegraded = () => {
      this.broadcastEvent({ type: 'pool-degraded', pool: 'completion' });
      this.onPoolDegraded?.('completion');
    };

    this.commandPool = new CommandPool(this.config.claudeCode.model, this.logger);
    this.commandPool.setLedger(this.ledger);
    this.commandPool.onPoolDegraded = () => {
      this.broadcastEvent({ type: 'pool-degraded', pool: 'command' });
      this.onPoolDegraded?.('command');
    };
  }

  async start(): Promise<void> {
    // Ensure state directory exists (for lockfile; on Unix, also for socket file)
    ensureStateDir();

    // Clean up stale socket file (no-op on Windows — named pipes auto-cleanup)
    try {
      cleanupStaleEndpoint();
    } catch (err) {
      this.logger.error(`Failed to remove stale endpoint: ${err}`);
      throw err;
    }

    // Lockfile is already written by acquireLock() — no need to overwrite here.

    // Create and start server
    this.server = net.createServer((socket) => this.handleConnection(socket));

    const ipcPath = getIpcPath();
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(ipcPath, () => {
          this.logger.info(`Pool server listening on ${ipcPath}`);
          resolve();
        });
      });

      // Activate providers
      await Promise.all([this.completionProvider.activate(), this.commandPool.activate()]);

      this.logger.info('Pool server: providers activated');
    } catch (err) {
      // Clean up lockfile on failure so other clients can acquire it
      try {
        if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  // --- Public methods for local access when client is also server ---

  isCompletionPoolAvailable(): boolean {
    return this.completionProvider.isAvailable();
  }

  isCommandPoolAvailable(): boolean {
    return this.commandPool.isAvailable();
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    return this.completionProvider.getCompletion(context, signal);
  }

  async sendCommand(
    message: string,
    options?: { timeoutMs?: number },
  ): Promise<{ text: string | null; meta: ResultMetadata | null }> {
    return this.commandPool.sendPrompt(message, options);
  }

  getModel(): string {
    return this.config.claudeCode.model;
  }

  getCompletionPoolStats(): PoolStats {
    return this.completionProvider.getStats();
  }

  getCommandPoolStats(): PoolStats {
    return this.commandPool.getStats();
  }

  async restartPools(): Promise<void> {
    await Promise.all([this.completionProvider.restart(), this.commandPool.restart()]);
  }

  /** Direct config update for local fast path (bypasses IPC serialization). */
  async handleConfigUpdateDirect(request: ConfigUpdateRequest): Promise<void> {
    if (request.model && request.model !== this.config.claudeCode.model) {
      const oldModel = this.config.claudeCode.model;
      this.config.claudeCode.model = request.model;
      this.logger.info(`Pool server: model changed ${oldModel} → ${request.model}, recycling`);
      this.completionProvider.updateConfig(this.config);
      this.commandPool.updateModel(request.model);
      await Promise.all([this.completionProvider.recycleAll(), this.commandPool.recycleAll()]);
    }
  }

  /** Direct recycle for local fast path (bypasses IPC serialization). */
  async handleRecycleDirect(pool: 'completion' | 'command' | 'all'): Promise<void> {
    if (pool === 'completion' || pool === 'all') {
      await this.completionProvider.recycleAll();
    }
    if (pool === 'command' || pool === 'all') {
      await this.commandPool.recycleAll();
    }
  }

  private handleConnection(socket: net.Socket): void {
    const client: ConnectedClient = {
      id: '',
      socket,
      buffer: '',
    };
    this.clients.set(socket, client);
    this.logger.debug(`Pool server: client connected (${this.clients.size} total)`);

    socket.on('data', (data) => this.handleData(client, data));
    socket.on('close', () => this.handleDisconnect(socket));
    socket.on('error', (err) => {
      this.logger.error(`Pool server: client socket error: ${err.message}`);
      this.handleDisconnect(socket);
    });
  }

  private handleData(client: ConnectedClient, data: Buffer): void {
    client.buffer += data.toString();

    // Process complete lines (newline-delimited JSON)
    const lines = client.buffer.split('\n');
    client.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      const message = parseMessage(line);
      if (!message) {
        this.logger.error(`Pool server: failed to parse message: ${line.slice(0, 100)}`);
        continue;
      }

      this.handleRequest(client, message as PoolRequest).catch((err) => {
        this.logger.error(`Pool server: request handler error: ${err}`);
      });
    }
  }

  private async handleRequest(client: ConnectedClient, request: PoolRequest): Promise<void> {
    let response: PoolResponse;

    switch (request.type) {
      case 'client-hello':
        client.id = request.clientId;
        response = {
          type: 'client-hello',
          id: request.id,
          success: true,
          serverId: this.serverId,
          model: this.config.claudeCode.model,
        };
        break;

      case 'completion':
        response = await this.handleCompletion(request);
        break;

      case 'command':
        response = await this.handleCommand(request);
        break;

      case 'status':
        response = {
          type: 'status',
          id: request.id,
          success: true,
          completionPoolAvailable: this.completionProvider.isAvailable(),
          commandPoolAvailable: this.commandPool.isAvailable(),
          connectedClients: this.clients.size,
          model: this.config.claudeCode.model,
          completionPool: this.completionProvider.getStats(),
          commandPool: this.commandPool.getStats(),
        };
        break;

      case 'config-update':
        response = await this.handleConfigUpdate(request);
        break;

      case 'recycle':
        try {
          await this.handleRecycleDirect(request.pool);
          response = { type: 'recycle', id: request.id, success: true };
        } catch (err) {
          response = {
            type: 'recycle',
            id: request.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        break;

      case 'warmup':
        // Warmup happens automatically on pool start; this is a no-op for explicit requests
        response = { type: 'warmup', id: request.id, success: true };
        break;

      case 'dispose':
        response = { type: 'dispose', id: request.id, success: true };
        // Schedule shutdown after sending response
        setImmediate(() => this.dispose());
        break;

      default:
        response = {
          type: 'error',
          id: (request as { id?: string }).id || 'unknown',
          success: false,
          error: `Unknown request type: ${(request as { type: string }).type}`,
        };
    }

    this.sendResponse(client.socket, response);
  }

  private async handleCompletion(request: CompletionRequest): Promise<PoolResponse> {
    if (!this.completionProvider.isAvailable()) {
      return {
        type: 'completion',
        id: request.id,
        success: false,
        text: null,
        error: 'Completion pool not available',
      };
    }

    const context: CompletionContext = {
      prefix: request.prefix,
      suffix: request.suffix,
      mode: request.mode,
      languageId: request.languageId || 'plaintext',
      fileName: request.fileName || '',
      filePath: request.filePath || '',
    };

    // AbortSignal not used by pool (ignored once slot acquired)
    const abortController = new AbortController();

    try {
      const text = await this.completionProvider.getCompletion(context, abortController.signal);
      // Include model in response for tracking (full metadata would require interface changes)
      const model = this.completionProvider.lastUsedModel || this.config.claudeCode.model;
      return {
        type: 'completion',
        id: request.id,
        success: true,
        text,
        meta: { model },
      };
    } catch (err) {
      return {
        type: 'completion',
        id: request.id,
        success: false,
        text: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleCommand(request: CommandRequest): Promise<PoolResponse> {
    if (!this.commandPool.isAvailable()) {
      return {
        type: 'command',
        id: request.id,
        success: false,
        text: null,
        error: 'Command pool not available',
      };
    }

    try {
      const result = await this.commandPool.sendPrompt(request.message, {
        timeoutMs: request.timeoutMs,
      });

      return {
        type: 'command',
        id: request.id,
        success: true,
        text: result.text,
        meta: result.meta
          ? {
              durationMs: result.meta.durationMs,
              durationApiMs: result.meta.durationApiMs,
              costUsd: result.meta.costUsd,
              inputTokens: result.meta.inputTokens,
              outputTokens: result.meta.outputTokens,
              cacheReadTokens: result.meta.cacheReadTokens,
              cacheCreationTokens: result.meta.cacheCreationTokens,
              sessionId: result.meta.sessionId,
              model: result.meta.model,
            }
          : undefined,
      };
    } catch (err) {
      return {
        type: 'command',
        id: request.id,
        success: false,
        text: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleConfigUpdate(request: ConfigUpdateRequest): Promise<PoolResponse> {
    try {
      await this.handleConfigUpdateDirect(request);
      return { type: 'config-update', id: request.id, success: true };
    } catch (err) {
      return {
        type: 'config-update',
        id: request.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private sendResponse(socket: net.Socket, response: PoolResponse): void {
    if (socket.destroyed) return;
    socket.write(serializeMessage(response));
  }

  private broadcastEvent(event: ServerEvent): void {
    const message = serializeMessage(event);
    for (const client of this.clients.values()) {
      if (!client.socket.destroyed) {
        client.socket.write(message);
      }
    }
  }

  private handleDisconnect(socket: net.Socket): void {
    this.clients.delete(socket);
    this.logger.debug(`Pool server: client disconnected (${this.clients.size} remaining)`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.logger.info('Pool server: shutting down');

    // Broadcast shutdown to all clients
    this.broadcastEvent({ type: 'server-shutting-down' });

    // Close all client connections
    for (const client of this.clients.values()) {
      client.socket.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Dispose providers
    this.completionProvider.dispose();
    this.commandPool.dispose();

    // Clean up IPC endpoint and lock files
    try {
      cleanupStaleEndpoint();
      if (fs.existsSync(LOCK_PATH)) {
        fs.unlinkSync(LOCK_PATH);
      }
    } catch (err) {
      this.logger.error(`Pool server: cleanup error: ${err}`);
    }

    this.logger.info('Pool server: disposed');
  }
}

// --- Lockfile utilities ---

export interface LockInfo {
  pid: number;
  timestamp: number;
}

export function readLockfile(): LockInfo | null {
  try {
    if (!fs.existsSync(LOCK_PATH)) {
      return null;
    }
    const content = fs.readFileSync(LOCK_PATH, 'utf-8');
    return JSON.parse(content) as LockInfo;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(pid: number): boolean {
  try {
    // Ensure directory exists
    ensureStateDir();

    const existing = readLockfile();

    // If lock exists and process is alive, we can't acquire
    if (existing && isProcessAlive(existing.pid)) {
      return false;
    }

    // Stale lock exists — remove it first
    if (existing) {
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        // Another process may have removed it
      }
    }

    // Atomically create the lockfile — 'wx' flag fails if file already exists
    // This prevents TOCTOU race where two processes both think they can acquire
    const lockContent = JSON.stringify({ pid, timestamp: Date.now() });
    fs.writeFileSync(LOCK_PATH, lockContent, { flag: 'wx' });

    // Verify we actually own the lock (handle race where another process
    // created the file between our unlink and writeFile)
    const verified = readLockfile();
    if (verified?.pid !== pid) {
      return false;
    }

    return true;
  } catch (err) {
    // EEXIST means another process won the race — check if it's alive
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readLockfile();
      if (winner && isProcessAlive(winner.pid)) {
        return false; // Valid lock held by another process
      }
      // Winner died immediately — could retry, but simpler to just fail
    }
    return false;
  }
}
