/**
 * IPC Protocol for Global Pool Server
 *
 * JSON-RPC style messages over Unix domain socket.
 * Each message is a newline-delimited JSON object.
 */

import { CompletionMode } from '../types';

// --- Request Types ---

export interface CompletionRequest {
  type: 'completion';
  id: string;
  prefix: string;
  suffix: string;
  mode: CompletionMode;
  languageId: string;
  fileName: string;
  filePath: string;
}

export interface CommandRequest {
  type: 'command';
  id: string;
  message: string;
  timeoutMs?: number;
}

export interface WarmupRequest {
  type: 'warmup';
  id: string;
  pool: 'completion' | 'command';
}

export interface RecycleRequest {
  type: 'recycle';
  id: string;
  pool: 'completion' | 'command' | 'all';
}

export interface StatusRequest {
  type: 'status';
  id: string;
}

export interface ConfigUpdateRequest {
  type: 'config-update';
  id: string;
  model?: string;
}

export interface DisposeRequest {
  type: 'dispose';
  id: string;
}

export interface ClientHelloRequest {
  type: 'client-hello';
  id: string;
  clientId: string;
}

export type PoolRequest =
  | CompletionRequest
  | CommandRequest
  | WarmupRequest
  | RecycleRequest
  | StatusRequest
  | ConfigUpdateRequest
  | DisposeRequest
  | ClientHelloRequest;

// --- Response Types ---

export interface ResultMetadata {
  model: string;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  sessionId?: string;
}

export interface CompletionResponse {
  type: 'completion';
  id: string;
  success: boolean;
  text: string | null;
  meta?: ResultMetadata;
  error?: string;
}

export interface CommandResponse {
  type: 'command';
  id: string;
  success: boolean;
  text: string | null;
  meta?: ResultMetadata;
  error?: string;
}

export interface WarmupResponse {
  type: 'warmup';
  id: string;
  success: boolean;
  error?: string;
}

export interface RecycleResponse {
  type: 'recycle';
  id: string;
  success: boolean;
  error?: string;
}

export interface SlotStats {
  state: 'initializing' | 'available' | 'busy' | 'dead';
  requestCount: number;
  maxRequests: number;
}

export interface PoolStatsInfo {
  label: string;
  available: boolean;
  slots: SlotStats[];
  /** Timestamp when pool was activated (ms since epoch). */
  activatedAt: number | null;
  /** Uptime in milliseconds (null if not activated). */
  uptimeMs: number | null;
  /** Total requests served across all slot recycles. */
  totalRequests: number;
  /** Total times slots have been recycled. */
  totalRecycles: number;
  /** Timestamp of last completed request (ms since epoch). */
  lastRequestAt: number | null;
  /** Cumulative token usage. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** Cumulative cost in USD. */
  totalCostUsd: number;
}

export interface StatusResponse {
  type: 'status';
  id: string;
  success: boolean;
  completionPoolAvailable: boolean;
  commandPoolAvailable: boolean;
  connectedClients: number;
  model: string;
  completionPool?: PoolStatsInfo;
  commandPool?: PoolStatsInfo;
}

export interface ConfigUpdateResponse {
  type: 'config-update';
  id: string;
  success: boolean;
  error?: string;
}

export interface DisposeResponse {
  type: 'dispose';
  id: string;
  success: boolean;
}

export interface ClientHelloResponse {
  type: 'client-hello';
  id: string;
  success: boolean;
  serverId: string;
  model: string;
}

export interface ErrorResponse {
  type: 'error';
  id: string;
  success: false;
  error: string;
}

export type PoolResponse =
  | CompletionResponse
  | CommandResponse
  | WarmupResponse
  | RecycleResponse
  | StatusResponse
  | ConfigUpdateResponse
  | DisposeResponse
  | ClientHelloResponse
  | ErrorResponse;

// --- Server Events (pushed to clients) ---

export interface ServerShuttingDownEvent {
  type: 'server-shutting-down';
}

export interface PoolDegradedEvent {
  type: 'pool-degraded';
  pool: 'completion' | 'command';
}

export type ServerEvent = ServerShuttingDownEvent | PoolDegradedEvent;

// --- Utilities ---

export function generateRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function serializeMessage(msg: PoolRequest | PoolResponse | ServerEvent): string {
  return JSON.stringify(msg) + '\n';
}

export function parseMessage(line: string): PoolRequest | PoolResponse | ServerEvent | null {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}
