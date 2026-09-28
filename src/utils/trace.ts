/**
 * Per-request LLM trace records, shaped after the OpenTelemetry GenAI semantic conventions.
 *
 * Spec version: open-telemetry/semantic-conventions-genai (status "development", unreleased),
 * verified 2026-09-27. Schema URL: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev
 * The GenAI conventions are still changing; attribute names here follow that snapshot.
 *
 * One `TraceRecord` is produced per inline completion that reaches the cache check (and per
 * commit-message / suggest-edit command). Records flow to sinks:
 *   - the in-memory ring buffer (last 200, per window) behind "Show Recent Completions"
 *   - an opt-in JSONL file (`bespokeAI.trace.file`) — one OTel-shaped span per line
 *   - an opt-in OTLP/HTTP exporter (`bespokeAI.trace.otlp.endpoint`)
 *
 * Privacy: prompt/response text lives only in `detail.content` and `finalText`. When
 * `bespokeAI.trace.captureContent` is off, the recorder strips both before any sink sees the
 * record, and providers are asked not to produce content in the first place (so it never
 * crosses the pool-server socket either).
 *
 * This module has no `vscode` dependency so it can be unit-tested directly.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CompletionMode } from '../types';

export const GENAI_SCHEMA_URL = 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev';

/** What happened to a request. */
export type TraceOutcome = 'cache_hit' | 'ok' | 'empty' | 'aborted' | 'error';

/** Which feature issued the request. */
export type TraceSource = 'completion' | 'commit-message' | 'suggest-edit' | 'command';

/** `gen_ai.operation.name` — `text_completion` for inline completions, `chat` for commands. */
export type GenAiOperation = 'text_completion' | 'chat';

/** Prompt/response text. Only present when content capture is on. */
export interface GenerationContent {
  systemPrompt?: string;
  userMessage?: string;
  /** Assistant prefill (Anthropic prefill-extraction strategy), sent as a trailing assistant message. */
  prefill?: string;
  /** What the model returned, before extraction/post-processing. */
  rawOutput?: string | null;
  /** After tag/prefill extraction, before post-processing. */
  extracted?: string | null;
}

/**
 * Model-side detail produced by a provider for one generation. Token counts follow the
 * adapters' convention: `inputTokens` is NON-cached input; cache reads/writes are separate.
 * (OTel's `gen_ai.usage.input_tokens` includes cached tokens — `buildSpanAttributes` adds them.)
 */
export interface GenerationDetail {
  /** `gen_ai.provider.name` (anthropic | openai | gcp.gemini | x_ai | openrouter | ollama). */
  providerName: string;
  requestModel: string;
  responseModel?: string;
  serverAddress?: string;
  maxTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cost reported by the backend for THIS request (USD). Never computed from a price table. */
  costUsd?: number;
  /** Time the backend reports spending on the API call (or the adapter's HTTP round trip). */
  durationApiMs?: number;
  /** Time spent waiting for a pool slot before the request was sent (CLI backend). */
  waitMs?: number;
  finishReason?: string;
  /** The request was superseded or cancelled after it was sent. */
  aborted?: boolean;
  /** Low-cardinality error class (e.g. HTTP status "429", "pool_error"). */
  errorType?: string;
  errorMessage?: string;
  content?: GenerationContent;
}

/** Returned by `CompletionProvider.getCompletionWithDetail`. */
export interface CompletionWithDetail {
  text: string | null;
  detail?: GenerationDetail;
}

export interface GenerationOptions {
  /** When false, providers omit `detail.content` (and the pool server never ships it). */
  captureContent?: boolean;
}

export interface TraceRecord {
  traceId: string;
  spanId: string;
  /** Short log-correlation id (matches `#a7f3` in the Output log). */
  requestId: string;
  source: TraceSource;
  operation: GenAiOperation;
  backend: 'claude-code' | 'api';
  mode?: CompletionMode;
  languageId?: string;
  outcome: TraceOutcome;
  /** Provider/model used when `detail` is absent (cache hits, unavailable backend). */
  providerName: string;
  requestModel: string;
  /** When the request entered the orchestrator (before debounce). */
  receivedAtMs: number;
  /** Span start: when the request was sent to the backend (after debounce). */
  startTimeMs: number;
  endTimeMs: number;
  /** Time spent in the debounce window before sending. */
  debounceMs?: number;
  detail?: GenerationDetail;
  /** Ghost text actually shown (after post-processing). Content — capture-gated. */
  finalText?: string | null;
  errorType?: string;
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

export function newTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** 4-hex id in the same format as the Output log's `#a7f3` request ids. */
export function newShortRequestId(): string {
  return crypto.randomBytes(2).toString('hex');
}

/** Map a preset's provider to the `gen_ai.provider.name` well-known value. */
export function genAiProviderName(presetProvider: string): string {
  switch (presetProvider) {
    case 'google':
      return 'gcp.gemini';
    case 'xai':
      return 'x_ai';
    default:
      // anthropic, openai (incl. custom openai-compat), and custom values openrouter / ollama
      return presetProvider;
  }
}

const DEFAULT_PROVIDER_HOSTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
};

/** `server.address` for an API preset: the baseUrl host, else the provider's default host. */
export function serverAddressFor(presetProvider: string, baseUrl?: string): string | undefined {
  if (baseUrl) {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return undefined;
    }
  }
  return DEFAULT_PROVIDER_HOSTS[presetProvider];
}

/** Low-cardinality `error.type` for a thrown value. */
export function errorTypeOf(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return String(status);
    return err.name && err.name !== 'Error' ? err.name : err.constructor?.name || 'Error';
  }
  return '_OTHER';
}

// Providers that throw can still describe what they sent. They attach the detail to the error
// object here; the orchestrator reads it back when it records the failure.
const errorDetails = new WeakMap<object, GenerationDetail>();

export function attachDetailToError(err: unknown, detail: GenerationDetail): void {
  if (err !== null && typeof err === 'object') errorDetails.set(err, detail);
}

export function detailFromError(err: unknown): GenerationDetail | undefined {
  return err !== null && typeof err === 'object' ? errorDetails.get(err) : undefined;
}

/** A copy of the record with every content field removed. */
export function stripContent(record: TraceRecord): TraceRecord {
  if (!record.detail?.content && record.finalText === undefined) return record;
  const copy: TraceRecord = { ...record };
  delete copy.finalText;
  if (copy.detail) {
    const d = { ...copy.detail };
    delete d.content;
    copy.detail = d;
  }
  return copy;
}

/** Total input tokens per the OTel spec: non-cached + cache reads + cache writes. */
export function totalInputTokens(d: GenerationDetail): number | undefined {
  if (
    d.inputTokens === undefined &&
    d.cacheReadTokens === undefined &&
    d.cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return (d.inputTokens ?? 0) + (d.cacheReadTokens ?? 0) + (d.cacheWriteTokens ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────
// OTel span shape
// ─────────────────────────────────────────────────────────────────────────

export type SpanAttributeValue = string | number | boolean | string[];

/** OTLP `Status.code`. */
export const SPAN_STATUS = { UNSET: 0, OK: 1, ERROR: 2 } as const;
/** OTLP `Span.SpanKind` — CLIENT. */
export const SPAN_KIND_CLIENT = 3;

/** Integer-valued attributes (sent as OTLP `intValue`). Everything else numeric is a double. */
export const INT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'gen_ai.request.max_tokens',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_write.input_tokens',
  'bespoke_ai.wait_ms',
  'bespoke_ai.debounce_ms',
  'bespoke_ai.duration_api_ms',
]);

export function spanName(record: TraceRecord): string {
  return `${record.operation} ${record.detail?.requestModel || record.requestModel}`;
}

export function spanStatusCode(record: TraceRecord): number {
  if (record.outcome === 'error') return SPAN_STATUS.ERROR;
  if (record.outcome === 'ok' || record.outcome === 'cache_hit') return SPAN_STATUS.OK;
  return SPAN_STATUS.UNSET;
}

function textMessages(role: 'user' | 'assistant', content: string) {
  return { role, parts: [{ type: 'text', content }] };
}

/**
 * Build the span's attributes. Standard `gen_ai.*` names where the spec has one; extension
 * specifics under `bespoke_ai.*`. `gen_ai.usage.cost` is NOT in the spec (it is the attribute
 * Langfuse reads) and is only set when the backend reported a cost.
 */
export function buildSpanAttributes(
  record: TraceRecord,
  includeContent: boolean,
): Record<string, SpanAttributeValue> {
  const d = record.detail;
  const a: Record<string, SpanAttributeValue> = {
    'gen_ai.operation.name': record.operation,
    'gen_ai.provider.name': d?.providerName || record.providerName,
    'gen_ai.request.model': d?.requestModel || record.requestModel,
  };
  if (d) {
    if (d.responseModel) a['gen_ai.response.model'] = d.responseModel;
    if (d.maxTokens !== undefined) a['gen_ai.request.max_tokens'] = d.maxTokens;
    const input = totalInputTokens(d);
    if (input !== undefined) a['gen_ai.usage.input_tokens'] = input;
    if (d.outputTokens !== undefined) a['gen_ai.usage.output_tokens'] = d.outputTokens;
    if (d.cacheReadTokens !== undefined) {
      a['gen_ai.usage.cache_read.input_tokens'] = d.cacheReadTokens;
    }
    if (d.cacheWriteTokens !== undefined) {
      a['gen_ai.usage.cache_write.input_tokens'] = d.cacheWriteTokens;
    }
    if (d.costUsd !== undefined) a['gen_ai.usage.cost'] = d.costUsd;
    if (d.finishReason) a['gen_ai.response.finish_reasons'] = [d.finishReason];
    if (d.serverAddress) a['server.address'] = d.serverAddress;
    if (d.waitMs !== undefined) a['bespoke_ai.wait_ms'] = d.waitMs;
    if (d.durationApiMs !== undefined) a['bespoke_ai.duration_api_ms'] = d.durationApiMs;
  }
  const errorType = record.errorType ?? d?.errorType;
  if (record.outcome === 'error') a['error.type'] = errorType || '_OTHER';

  a['bespoke_ai.request_id'] = record.requestId;
  a['bespoke_ai.source'] = record.source;
  a['bespoke_ai.backend'] = record.backend;
  a['bespoke_ai.outcome'] = record.outcome;
  a['bespoke_ai.cache_hit'] = record.outcome === 'cache_hit';
  if (record.mode) a['bespoke_ai.mode'] = record.mode;
  if (record.languageId) a['bespoke_ai.language_id'] = record.languageId;
  if (record.debounceMs !== undefined) a['bespoke_ai.debounce_ms'] = record.debounceMs;

  if (includeContent) {
    const c = d?.content;
    if (c?.systemPrompt !== undefined) {
      a['gen_ai.system_instructions'] = JSON.stringify([{ type: 'text', content: c.systemPrompt }]);
    }
    if (c?.userMessage !== undefined) {
      const msgs = [textMessages('user', c.userMessage)];
      if (c.prefill) msgs.push(textMessages('assistant', c.prefill));
      a['gen_ai.input.messages'] = JSON.stringify(msgs);
    }
    if (c?.rawOutput) {
      a['gen_ai.output.messages'] = JSON.stringify([textMessages('assistant', c.rawOutput)]);
    }
    if (typeof record.finalText === 'string') {
      a['bespoke_ai.completion.text'] = record.finalText;
    }
  }
  return a;
}

/** Decimal-string nanoseconds from epoch milliseconds (no float/BigInt rounding). */
export function msToUnixNano(ms: number): string {
  return `${Math.round(ms)}000000`;
}

/** A readable OTel-shaped span (flat attribute map). Used for JSONL lines. */
export interface SpanJson {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: Record<string, SpanAttributeValue>;
  schemaUrl: string;
}

export function toSpanJson(record: TraceRecord, includeContent: boolean): SpanJson {
  const status: SpanJson['status'] = { code: spanStatusCode(record) };
  const message = record.errorMessage ?? record.detail?.errorMessage;
  if (record.outcome === 'error' && message) status.message = message;
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    name: spanName(record),
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: msToUnixNano(record.startTimeMs),
    endTimeUnixNano: msToUnixNano(record.endTimeMs),
    status,
    attributes: buildSpanAttributes(record, includeContent),
    schemaUrl: GENAI_SCHEMA_URL,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Recorder + sinks
// ─────────────────────────────────────────────────────────────────────────

/** Minimal logger surface so tests don't need the vscode-backed Logger. */
export interface TraceLogger {
  error(msg: string): void;
  info(msg: string): void;
}

export interface TraceSink {
  /** Receives records already stripped of content when capture is off. Must not throw. */
  export(record: TraceRecord): void;
  dispose?(): void | Promise<void>;
}

export const TRACE_RING_CAPACITY = 200;

export interface TraceRecorderOptions {
  captureContent: boolean;
  capacity?: number;
  logger?: TraceLogger;
}

/**
 * Collects trace records. `record()` is synchronous, cheap, and never throws — sinks that do
 * I/O queue the work and return immediately.
 */
export class TraceRecorder {
  private readonly capacity: number;
  private captureContent: boolean;
  private readonly ring: TraceRecord[] = [];
  private readonly listeners = new Set<(r: TraceRecord) => void>();
  private readonly sinks = new Map<string, TraceSink>();
  private readonly logger?: TraceLogger;

  constructor(options: TraceRecorderOptions) {
    this.captureContent = options.captureContent;
    this.capacity = options.capacity ?? TRACE_RING_CAPACITY;
    this.logger = options.logger;
  }

  get isCapturingContent(): boolean {
    return this.captureContent;
  }

  setCaptureContent(on: boolean): void {
    this.captureContent = on;
  }

  /** Install (or replace, or remove with `null`) a named sink. */
  setSink(name: string, sink: TraceSink | null): void {
    const prev = this.sinks.get(name);
    if (prev && prev !== sink) {
      try {
        void prev.dispose?.();
      } catch {
        /* ignore */
      }
    }
    if (sink) this.sinks.set(name, sink);
    else this.sinks.delete(name);
  }

  getSink(name: string): TraceSink | undefined {
    return this.sinks.get(name);
  }

  record(input: TraceRecord): void {
    try {
      const record = this.captureContent ? input : stripContent(input);
      this.ring.push(record);
      if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
      for (const l of this.listeners) {
        try {
          l(record);
        } catch (err) {
          this.logger?.error(`Trace: listener failed: ${err}`);
        }
      }
      for (const [name, sink] of this.sinks) {
        try {
          sink.export(record);
        } catch (err) {
          this.logger?.error(`Trace: sink ${name} failed: ${err}`);
        }
      }
    } catch (err) {
      this.logger?.error(`Trace: record failed: ${err}`);
    }
  }

  /** Newest first. */
  getRecent(): TraceRecord[] {
    return this.ring.slice().reverse();
  }

  clear(): void {
    this.ring.length = 0;
  }

  onDidRecord(listener: (r: TraceRecord) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    const pending = [...this.sinks.values()].map(async (s) => {
      try {
        await s.dispose?.();
      } catch {
        /* ignore */
      }
    });
    this.sinks.clear();
    await Promise.all(pending);
  }
}

/** Rotate when the active trace file exceeds this size. Content-bearing lines are large. */
export const TRACE_FILE_ROTATION_BYTES = 5 * 1_048_576;
/** Archives older than this are purged on rotation. */
export const TRACE_ARCHIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Appends one OTel-shaped span (`toSpanJson`) per line to a JSONL file. Writes are queued and
 * performed asynchronously in order; nothing on the completion path waits for disk.
 * Rotation mirrors `UsageLedger`: rename to `traces-YYYY-MM-DD.jsonl`, purge old archives.
 * Concurrent-safe across windows the same way (append mode + rename-based claim).
 */
export class TraceFileSink implements TraceSink {
  private readonly filePath: string;
  private readonly dirPath: string;
  private readonly logger?: TraceLogger;
  private readonly rotationBytes: number;
  private queue: TraceRecord[] = [];
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private disposed = false;

  constructor(filePath: string, logger?: TraceLogger, rotationBytes = TRACE_FILE_ROTATION_BYTES) {
    this.filePath = filePath;
    this.dirPath = path.dirname(filePath);
    this.logger = logger;
    this.rotationBytes = rotationBytes;
  }

  export(record: TraceRecord): void {
    if (this.disposed) return;
    // Content is already stripped by the recorder when capture is off. Serialization happens
    // in drain(), off the completion path.
    this.queue.push(record);
    if (!this.scheduled) {
      this.scheduled = true;
      // Defer to a macrotask so serialization + I/O start after the completion is returned.
      this.chain = this.chain
        .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
        .then(() => this.drain());
    }
  }

  /** Resolves once every queued line has been written. */
  flush(): Promise<void> {
    return this.chain;
  }

  async dispose(): Promise<void> {
    await this.chain;
    this.disposed = true;
  }

  private async drain(): Promise<void> {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const records = this.queue;
    this.queue = [];
    let data = '';
    for (const r of records) data += JSON.stringify(toSpanJson(r, true)) + '\n';
    try {
      await fs.promises.mkdir(this.dirPath, { recursive: true });
      await fs.promises.appendFile(this.filePath, data, { flag: 'a' });
      await this.checkRotation();
    } catch (err) {
      this.logger?.error(`Trace: file write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async checkRotation(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size <= this.rotationBytes) return;

      const base = path.basename(this.filePath, '.jsonl');
      const archiveName = `${base}-${new Date().toISOString().slice(0, 10)}.jsonl`;
      const archivePath = path.join(this.dirPath, archiveName);
      const tempPath = `${this.filePath}.rotating.${process.pid}`;
      try {
        // Atomic claim — if another window wins the race, let it rotate.
        await fs.promises.rename(this.filePath, tempPath);
      } catch {
        return;
      }
      if (fs.existsSync(archivePath)) {
        await fs.promises.appendFile(archivePath, await fs.promises.readFile(tempPath));
        await fs.promises.unlink(tempPath);
      } else {
        await fs.promises.rename(tempPath, archivePath);
      }
      this.logger?.info(`Trace: rotated to ${archiveName}`);
      await this.purgeOldArchives(base);
    } catch (err) {
      this.logger?.error(`Trace: rotation failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async purgeOldArchives(base: string): Promise<void> {
    const re = new RegExp(
      `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`,
    );
    const now = Date.now();
    for (const file of await fs.promises.readdir(this.dirPath)) {
      const m = file.match(re);
      if (!m) continue;
      const t = new Date(m[1] + 'T00:00:00').getTime();
      if (!isNaN(t) && now - t > TRACE_ARCHIVE_MAX_AGE_MS) {
        await fs.promises.unlink(path.join(this.dirPath, file)).catch(() => {});
      }
    }
  }
}
