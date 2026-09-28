/**
 * Pool Client
 *
 * Connects to the global pool server via IPC (Unix socket on macOS/Linux,
 * named pipe on Windows). Implements CompletionProvider interface for
 * seamless integration. If no server exists, becomes the server (leader election).
 */

import * as net from 'net';
import { Logger } from '../utils/logger';
import { UsageLedger } from '../utils/usage-ledger';
import {
  CompletionProvider as ICompletionProvider,
  CompletionContext,
  ExtensionConfig,
} from '../types';
import { SendPromptOptions, SendPromptResult } from '../providers/command-pool';
import {
  PoolRequest,
  PoolResponse,
  ServerEvent,
  PoolStatsInfo,
  generateRequestId,
  serializeMessage,
  parseMessage,
  wireMetaToDetail,
} from './protocol';
import type { CompletionWithDetail, GenerationOptions } from '../utils/trace';
import {
  PoolServer,
  acquireLock,
  commandMetaToWire,
  isProcessAlive,
  readLockfile,
  releaseLock,
} from './server';
import { getIpcPath, ipcEndpointMayExist } from './ipc-path';

const CONNECT_TIMEOUT_MS = 2000;
const RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_ATTEMPTS = 3;

export type PoolRole = 'server' | 'client';

export interface PoolClientOptions {
  config: ExtensionConfig;
  logger: Logger;
  ledger: UsageLedger;
  clientId: string;
  onPoolDegraded?: (pool: 'completion' | 'command', reason: string) => void;
  onRoleChange?: (role: PoolRole) => void;
}

type PendingRequest = {
  resolve: (response: PoolResponse) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class PoolClient implements ICompletionProvider {
  private socket: net.Socket | null = null;
  private server: PoolServer | null = null;
  private logger: Logger;
  private ledger: UsageLedger;
  private config: ExtensionConfig;
  private clientId: string;
  private role: PoolRole = 'client';
  private disposed = false;
  private buffer = '';
  private pendingRequests = new Map<string, PendingRequest>();
  private onPoolDegraded?: (pool: 'completion' | 'command', reason: string) => void;
  private onRoleChange?: (role: PoolRole) => void;
  private reconnectAttempts = 0;
  private connecting = false;
  private activating = false;

  /** Model reported by server in client-hello response */
  private serverModel: string | null = null;
  /** Guards against concurrent attemptTakeOver calls */
  private takingOver = false;

  constructor(options: PoolClientOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.ledger = options.ledger;
    this.clientId = options.clientId;
    this.onPoolDegraded = options.onPoolDegraded;
    this.onRoleChange = options.onRoleChange;
  }

  getRole(): PoolRole {
    return this.role;
  }

  async activate(): Promise<void> {
    if (this.activating) return;
    // Reset state to allow re-activation after disable/enable cycle
    this.disposed = false;
    this.reconnectAttempts = 0;
    this.takingOver = false;
    this.activating = true;

    try {
      // Try to connect to existing server
      const connected = await this.tryConnect();
      if (connected) {
        this.role = 'client';
        this.onRoleChange?.('client');
        this.logger.info(`Pool: connected to existing server`);
        return;
      }

      // No server — try to become one
      if (acquireLock(process.pid)) {
        await this.becomeServer();
        return;
      }

      // Lock held but couldn't connect — retry a few times
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
        await this.delay(RECONNECT_DELAY_MS);
        const retryConnected = await this.tryConnect();
        if (retryConnected) {
          this.role = 'client';
          this.onRoleChange?.('client');
          this.logger.info(`Pool: connected to server on retry ${i + 1}`);
          return;
        }

        // Check if lock holder is dead
        const lock = readLockfile();
        if (!lock || !isProcessAlive(lock.pid)) {
          if (acquireLock(process.pid)) {
            await this.becomeServer();
            return;
          }
        }
      }

      // Give up waiting — attempt lock acquisition as last resort and become server
      this.logger.error('Pool: failed to connect after retries, forcing lock acquisition');
      // Best-effort: acquireLock() fails if the lock still names a live pid (a hung
      // leader, or a pid reused after a crash). We become the server anyway, WITHOUT
      // the lock. On Unix this does not fail when another server is active:
      // PoolServer.start() deletes the socket path before listen(), so we displace a
      // live leader and two servers can run (only Windows' named pipe refuses a second
      // listener). Known limitation — see AGENTS.md "Forced pool leadership". Do not
      // make dispose() release only its own lock without also force-taking the lock
      // here: followers recover from a forced server's exit only because dispose()
      // deletes the lock unconditionally.
      acquireLock(process.pid);
      await this.becomeServer();
    } finally {
      this.activating = false;
    }
  }

  private async tryConnect(): Promise<boolean> {
    if (!ipcEndpointMayExist()) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      if (this.connecting) {
        resolve(false);
        return;
      }
      this.connecting = true;

      const socket = net.createConnection(getIpcPath());
      let resolved = false;

      const cleanup = () => {
        this.connecting = false;
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      };

      const timer = setTimeout(() => {
        socket.destroy();
        cleanup();
      }, CONNECT_TIMEOUT_MS);

      socket.on('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        this.setupSocketHandlers();

        // Send client-hello
        this.sendRequest({
          type: 'client-hello',
          id: generateRequestId(),
          clientId: this.clientId,
        })
          .then((response) => {
            if (response.type === 'client-hello' && response.success) {
              // Disposed while connecting: don't keep a socket open to the leader.
              if (this.disposed) {
                socket.destroy();
                cleanup();
                return;
              }
              this.serverModel = response.model;
              resolved = true;
              this.connecting = false;
              resolve(true);
            } else {
              socket.destroy();
              cleanup();
            }
          })
          .catch(() => {
            socket.destroy();
            cleanup();
          });
      });

      socket.on('error', () => {
        clearTimeout(timer);
        cleanup();
      });
    });
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => this.handleData(data));
    this.socket.on('close', () => this.handleDisconnect());
    this.socket.on('error', (err) => {
      this.logger.error(`Pool: socket error: ${err.message}`);
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      const message = parseMessage(line);
      if (!message) {
        this.logger.error(`Pool: failed to parse message: ${line.slice(0, 100)}`);
        continue;
      }

      // Check if it's a server event
      if ('type' in message && !('id' in message)) {
        this.handleServerEvent(message as ServerEvent);
        continue;
      }

      // Check if it's a response to a pending request
      const response = message as PoolResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.resolve(response);
      }
    }
  }

  private handleServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'server-shutting-down':
        this.logger.info('Pool: server shutting down, will attempt reconnect');
        this.socket?.destroy();
        this.socket = null;
        // The 'close' event handler (handleDisconnect) will call attemptTakeOver
        break;

      case 'pool-degraded':
        this.logger.error(
          `Pool: ${event.pool} pool degraded — ${event.reason ?? 'unknown reason'}`,
        );
        this.onPoolDegraded?.(event.pool, event.reason ?? 'unknown');
        break;
    }
  }

  private handleDisconnect(): void {
    this.socket = null;
    this.rejectAllPending(new Error('Server disconnected'));

    if (this.disposed) return;

    this.logger.info('Pool: disconnected from server');
    this.attemptTakeOver().catch((err) => this.logger.error('Pool: takeover failed', err));
  }

  private async attemptTakeOver(): Promise<void> {
    if (this.disposed || this.role === 'server' || this.takingOver) return;
    this.takingOver = true;

    try {
      this.reconnectAttempts++;
      await this.delay(RECONNECT_DELAY_MS * this.reconnectAttempts);
      // The window may have closed during the back-off; dispose() has already run
      // and would never shut down a server we started now.
      if (this.disposed) return;

      // Try to connect first (another client may have become server)
      const connected = await this.tryConnect();
      if (connected) {
        this.reconnectAttempts = 0;
        return;
      }

      // Try to acquire lock and become server
      if (acquireLock(process.pid)) {
        await this.becomeServer();
        return;
      }

      // Retry
      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.takingOver = false; // allow re-entry for retry
        await this.attemptTakeOver();
      } else {
        this.logger.error('Pool: failed to reconnect or become server');
      }
    } finally {
      this.takingOver = false;
    }
  }

  private async becomeServer(): Promise<void> {
    // Every path to leadership comes through here, after the caller took the lock.
    // If the window was disabled meanwhile, give the lock back instead of serving.
    if (this.disposed) {
      releaseLock(process.pid);
      return;
    }
    this.logger.info('Pool: becoming server');

    this.server = new PoolServer({
      config: this.config,
      logger: this.logger,
      ledger: this.ledger,
      serverId: this.clientId,
      onPoolDegraded: this.onPoolDegraded,
    });

    try {
      await this.server.start();
    } catch (err) {
      // Don't leave a failed server behind for dispose() to clean up later.
      this.server = null;
      throw err;
    }

    // Disposed during warmup: dispose() already shut the server down.
    if (this.disposed) return;

    this.role = 'server';
    // Forget the previous leader's model so getCurrentModel() reports our own.
    this.serverModel = null;
    this.reconnectAttempts = 0;
    this.onRoleChange?.('server');
    this.logger.debug('Pool: now acting as server');
  }

  private sendRequest(request: PoolRequest): Promise<PoolResponse> {
    return new Promise((resolve, reject) => {
      // If we're the server, handle locally
      if (this.role === 'server' && this.server) {
        // For server role, we need to call the pools directly
        this.handleLocalRequest(request).then(resolve).catch(reject);
        return;
      }

      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected to server'));
        return;
      }

      const pending: PendingRequest = { resolve, reject };

      // Set timeout for requests
      pending.timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('Request timed out'));
      }, 60_000);

      this.pendingRequests.set(request.id, pending);
      this.socket.write(serializeMessage(request));
    });
  }

  private async handleLocalRequest(request: PoolRequest): Promise<PoolResponse> {
    if (!this.server) {
      return {
        type: 'error',
        id: request.id,
        success: false,
        error: 'Server not initialized',
      };
    }

    switch (request.type) {
      case 'completion': {
        const context: CompletionContext = {
          prefix: request.prefix,
          suffix: request.suffix,
          mode: request.mode,
          languageId: request.languageId,
          fileName: request.fileName,
          filePath: request.filePath,
        };
        const { text, meta } = await this.server.completeWithMeta(
          context,
          request.captureContent === true,
        );
        return {
          type: 'completion',
          id: request.id,
          success: true,
          text,
          meta,
        };
      }

      case 'command': {
        const result = await this.server.sendCommand(request.message, {
          timeoutMs: request.timeoutMs,
        });
        return {
          type: 'command',
          id: request.id,
          success: true,
          text: result.text,
          meta: commandMetaToWire(result.meta, result),
        };
      }

      case 'status':
        return {
          type: 'status',
          id: request.id,
          success: true,
          completionPoolAvailable: this.server.isCompletionPoolAvailable(),
          commandPoolAvailable: this.server.isCommandPoolAvailable(),
          connectedClients: 0,
          model: this.server.getModel(),
          completionPool: this.server.getCompletionPoolStats(),
          commandPool: this.server.getCommandPoolStats(),
        };

      case 'config-update': {
        await this.server.handleConfigUpdateDirect(request);
        return { type: 'config-update', id: request.id, success: true };
      }

      case 'recycle': {
        await this.server.handleRecycleDirect(request.pool);
        return { type: 'recycle', id: request.id, success: true };
      }

      case 'warmup':
        return { type: 'warmup', id: request.id, success: true };

      case 'dispose':
        setImmediate(() => this.server?.dispose());
        return { type: 'dispose', id: request.id, success: true };

      case 'client-hello':
        return {
          type: 'client-hello',
          id: request.id,
          success: true,
          serverId: this.clientId,
          model: this.server.getModel(),
        };

      default: {
        const unhandled = request as PoolRequest;
        return {
          type: 'error',
          id: unhandled.id,
          success: false as const,
          error: `Unhandled local request type: ${unhandled.type}`,
        };
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- CompletionProvider interface ---

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    return (await this.getCompletionWithDetail(context, signal)).text;
  }

  async getCompletionWithDetail(
    context: CompletionContext,
    _signal: AbortSignal,
    options?: GenerationOptions,
  ): Promise<CompletionWithDetail> {
    const configuredModel = this.config.claudeCode.model;
    const captureContent = options?.captureContent === true;
    if (this.disposed) {
      return {
        text: null,
        detail: { ...wireMetaToDetail(undefined, configuredModel, false), aborted: true },
      };
    }

    try {
      const response = await this.sendRequest({
        type: 'completion',
        id: generateRequestId(),
        prefix: context.prefix,
        suffix: context.suffix,
        mode: context.mode,
        languageId: context.languageId,
        fileName: context.fileName,
        filePath: context.filePath,
        captureContent,
      });

      if (response.type === 'completion' && response.success) {
        return {
          text: response.text,
          detail: wireMetaToDetail(response.meta, configuredModel, captureContent),
        };
      }
      // Log error responses instead of silently swallowing
      const errorMsg = 'error' in response ? (response.error ?? 'unknown error') : 'unknown error';
      this.logger.error(`Pool: completion failed: ${errorMsg}`);
      // An unavailable leader pool says why in meta (e.g. pool_circuit_open).
      const why = response.type === 'completion' ? response.meta : undefined;
      if (why?.errorType || why?.aborted) {
        return {
          text: null,
          detail: { ...wireMetaToDetail(why, configuredModel, false), errorMessage: errorMsg },
        };
      }
      return {
        text: null,
        detail: {
          ...wireMetaToDetail(undefined, configuredModel, false),
          errorType: 'pool_error',
          errorMessage: errorMsg,
        },
      };
    } catch (err) {
      // Disposed mid-request (pending requests are rejected): cancelled, not a pool failure.
      if (this.disposed) {
        return {
          text: null,
          detail: { ...wireMetaToDetail(undefined, configuredModel, false), aborted: true },
        };
      }
      this.logger.error(`Pool: completion error: ${err}`);
      return {
        text: null,
        detail: {
          ...wireMetaToDetail(undefined, configuredModel, false),
          errorType: 'pool_error',
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  isAvailable(): boolean {
    if (this.disposed) return false;

    if (this.role === 'server' && this.server) {
      return this.server.isCompletionPoolAvailable();
    }

    return this.socket !== null && !this.socket.destroyed;
  }

  updateConfig(config: ExtensionConfig): void {
    const modelChanged = config.claudeCode.model !== this.config.claudeCode.model;
    const instructionsChanged = config.customInstructions !== this.config.customInstructions;
    this.config = config;
    // The cached leader model is stale once the model changes.
    if (modelChanged) this.serverModel = null;

    // Only the CLI backend runs a pool server. In API mode the client is never
    // connected, so sending a config-update would reject and log a spurious
    // "not connected" error every time these settings change.
    if (
      (modelChanged || instructionsChanged) &&
      !this.disposed &&
      config.backend === 'claude-code'
    ) {
      // Notify server of config change. Send only the fields that changed so
      // the server recycles the completion pool exactly when needed.
      this.sendRequest({
        type: 'config-update',
        id: generateRequestId(),
        ...(modelChanged ? { model: config.claudeCode.model } : {}),
        ...(instructionsChanged ? { customInstructions: config.customInstructions } : {}),
      }).catch((err) => {
        this.logger.error(`Pool: config update failed: ${err}`);
      });
    }
  }

  async recycleAll(): Promise<void> {
    if (this.disposed) return;

    try {
      await this.sendRequest({
        type: 'recycle',
        id: generateRequestId(),
        pool: 'all',
      });
    } catch (err) {
      this.logger.error(`Pool: recycle failed: ${err}`);
    }
  }

  // --- Command interface for commit-message and suggest-edit ---

  async sendCommand(message: string, options?: SendPromptOptions): Promise<SendPromptResult> {
    // The window is shutting down: cancelled, as for a completion after dispose and a
    // command whose client is disposed mid-request — not an empty model reply.
    if (this.disposed) {
      return { text: null, meta: null, aborted: true };
    }

    try {
      const response = await this.sendRequest({
        type: 'command',
        id: generateRequestId(),
        message,
        timeoutMs: options?.timeoutMs,
      });

      if (response.type === 'command' && response.success) {
        // Map protocol metadata to slot-pool format (fill defaults for optional fields)
        const protocolMeta = response.meta;
        // A failure-only meta (no usage) carries just errorType / aborted.
        const meta =
          protocolMeta && protocolMeta.outputTokens !== undefined
            ? {
                model: protocolMeta.model,
                durationMs: protocolMeta.durationMs ?? 0,
                durationApiMs: protocolMeta.durationApiMs ?? 0,
                // Older servers sent the cumulative session total as costUsd.
                costUsd: protocolMeta.turnCostUsd ?? protocolMeta.costUsd ?? 0,
                inputTokens: protocolMeta.inputTokens ?? 0,
                outputTokens: protocolMeta.outputTokens ?? 0,
                cacheReadTokens: protocolMeta.cacheReadTokens ?? 0,
                cacheCreationTokens: protocolMeta.cacheCreationTokens ?? 0,
                sessionId: protocolMeta.sessionId ?? '',
                stopReason: protocolMeta.finishReason,
                turnCostUsd: protocolMeta.turnCostUsd,
              }
            : null;
        return {
          text: response.text,
          meta,
          ...(protocolMeta?.errorType ? { errorType: protocolMeta.errorType } : {}),
          ...(protocolMeta?.aborted ? { aborted: true } : {}),
        };
      }
      // Log error responses instead of silently swallowing
      if (response.type === 'error' || (response.type === 'command' && !response.success)) {
        const errorMsg = 'error' in response ? response.error : 'unknown error';
        this.logger.error(`Pool: command failed: ${errorMsg}`);
      }
      // An unavailable leader pool says why in meta (e.g. pool_circuit_open).
      const why = response.type === 'command' ? response.meta : undefined;
      if (why?.aborted) return { text: null, meta: null, aborted: true };
      if (why?.errorType) return { text: null, meta: null, errorType: why.errorType };
      return { text: null, meta: null, errorType: 'pool_error' };
    } catch (err) {
      // Disposed mid-request (pending requests are rejected): cancelled, not a pool failure.
      if (this.disposed) return { text: null, meta: null, aborted: true };
      this.logger.error(`Pool: command error: ${err}`);
      return { text: null, meta: null, errorType: 'pool_error' };
    }
  }

  isCommandPoolAvailable(): boolean {
    if (this.disposed) return false;

    if (this.role === 'server' && this.server) {
      return this.server.isCommandPoolAvailable();
    }

    // For clients, we can't know for sure without asking the server
    // Assume available if connected
    return this.socket !== null && !this.socket.destroyed;
  }

  getCurrentModel(): string {
    return this.serverModel || this.config.claudeCode.model;
  }

  /** Get pool status including slot statistics. */
  async getPoolStatus(): Promise<{
    role: PoolRole;
    model: string;
    completionPool?: PoolStatsInfo;
    commandPool?: PoolStatsInfo;
  } | null> {
    if (this.disposed) return null;

    try {
      const response = await this.sendRequest({
        type: 'status',
        id: generateRequestId(),
      });

      if (response.type === 'status' && response.success) {
        return {
          role: this.role,
          model: response.model,
          completionPool: response.completionPool,
          commandPool: response.commandPool,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // --- Lifecycle ---

  async restart(): Promise<void> {
    if (this.disposed) return;

    if (this.role === 'server' && this.server) {
      await this.server.restartPools();
    } else {
      // Request recycle from server
      await this.recycleAll();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.rejectAllPending(new Error('Client disposed'));

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    if (this.server) {
      this.server.dispose();
      this.server = null;
    }

    this.logger.info('Pool: disposed');
  }
}
