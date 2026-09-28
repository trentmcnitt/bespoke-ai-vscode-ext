/**
 * IPC Protocol for Global Pool Server
 *
 * JSON-RPC style messages over IPC (Unix domain socket or named pipe).
 * Each message is a newline-delimited JSON object.
 */

import { CompletionMode } from '../types';
import type { GenerationDetail } from '../utils/trace';

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
  /**
   * Requester's `bespokeAI.trace.captureContent`. The server includes prompt/response text in
   * `meta.content` only when this is exactly `true` — absent (older clients) means no content.
   */
  captureContent?: boolean;
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
  /**
   * Standing user instructions for the completion system prompt. Present only
   * when the value changed. Empty string clears them. A change recycles the
   * completion pool so slots respawn with the new system prompt.
   */
  customInstructions?: string;
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
  /** Per-turn API time (delta of the SDK's cumulative `duration_api_ms`; approximate). */
  durationApiMs?: number;
  /**
   * Per-turn cost in USD (commands). Servers before this change sent the SDK's cumulative
   * per-session total here, so clients prefer `turnCostUsd` when both are present.
   */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  sessionId?: string;
  // --- Trace detail (all optional; see utils/trace.ts GenerationDetail) ---
  /** Model the request asked for (config alias, e.g. `sonnet`); `model` is what responded. */
  requestModel?: string;
  /** Cost of this turn, only when the SDK reported one (see slot-pool `ResultMetadata`). */
  turnCostUsd?: number;
  /** Time waiting for a pool slot before sending. */
  waitMs?: number;
  finishReason?: string;
  /** Request superseded (latest-request-wins) or pool disposed before sending. */
  aborted?: boolean;
  errorType?: string;
  /** Prompt/response text — only when the request set `captureContent: true`. */
  content?: {
    systemPrompt?: string;
    userMessage?: string;
    rawOutput?: string | null;
    extracted?: string | null;
  };
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
  /** Total cost in USD of served requests since activation, summed from per-turn costs. */
  totalCostUsd: number;
  /** Full model ID reported by the CLI, resolving aliases like `sonnet`. Null until the first response. */
  resolvedModel: string | null;
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
  /** Why the pool degraded (e.g., 'warmup failed after retry'). Optional for backward compat. */
  reason?: string;
}

export type ServerEvent = ServerShuttingDownEvent | PoolDegradedEvent;

// --- Trace detail <-> wire metadata ---

/**
 * Convert a provider's generation detail into wire metadata for a completion response.
 * Content is copied only when `captureContent` is true — when the requesting window has
 * content capture off, prompt text never crosses the socket.
 */
export function detailToWireMeta(
  detail: GenerationDetail | undefined,
  fallbackModel: string,
  captureContent: boolean,
): ResultMetadata {
  if (!detail) return { model: fallbackModel };
  const meta: ResultMetadata = {
    model: detail.responseModel || fallbackModel,
    requestModel: detail.requestModel,
    durationApiMs: detail.durationApiMs,
    turnCostUsd: detail.costUsd,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    cacheReadTokens: detail.cacheReadTokens,
    cacheCreationTokens: detail.cacheWriteTokens,
    waitMs: detail.waitMs,
    finishReason: detail.finishReason,
    aborted: detail.aborted,
    errorType: detail.errorType,
  };
  if (captureContent && detail.content) {
    const c = detail.content;
    meta.content = {
      systemPrompt: c.systemPrompt,
      userMessage: c.userMessage,
      rawOutput: c.rawOutput,
      extracted: c.extracted,
    };
  }
  return meta;
}

/** Rebuild a GenerationDetail (CLI backend) from wire metadata. */
export function wireMetaToDetail(
  meta: ResultMetadata | undefined,
  configuredModel: string,
  captureContent: boolean,
): GenerationDetail {
  const detail: GenerationDetail = {
    providerName: 'anthropic',
    requestModel: meta?.requestModel || configuredModel,
  };
  if (!meta) return detail;
  // `model` falls back to the configured alias / previous response model when nothing
  // responded, so only trust it as the response model when the backend reported usage.
  if (meta.model && meta.outputTokens !== undefined) detail.responseModel = meta.model;
  detail.inputTokens = meta.inputTokens;
  detail.outputTokens = meta.outputTokens;
  detail.cacheReadTokens = meta.cacheReadTokens;
  detail.cacheWriteTokens = meta.cacheCreationTokens;
  detail.costUsd = meta.turnCostUsd;
  detail.durationApiMs = meta.durationApiMs;
  detail.waitMs = meta.waitMs;
  detail.finishReason = meta.finishReason;
  if (meta.aborted) detail.aborted = true;
  if (meta.errorType) detail.errorType = meta.errorType;
  if (captureContent && meta.content) detail.content = { ...meta.content };
  return detail;
}

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
