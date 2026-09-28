/**
 * Opt-in OTLP/HTTP JSON trace exporter (`bespokeAI.trace.otlp.endpoint`).
 *
 * Hand-built OTLP JSON over `fetch` — no OpenTelemetry SDK dependency. Spans follow the GenAI
 * semantic conventions snapshot documented in `trace.ts` (schema gen-ai-dev/1.42.0-dev).
 *
 * Wire format (OTLP/HTTP, JSON encoding): POST {endpoint}/v1/traces, Content-Type
 * application/json, body `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }`.
 * traceId/spanId are lowercase hex strings (32/16 chars), times are decimal-string nanoseconds,
 * and int64 attribute values are strings (`intValue: "123"`).
 *
 * Compatibility: works with any collector that accepts OTLP/HTTP JSON (OTel Collector,
 * Langfuse at https://cloud.langfuse.com/api/public/otel with `Authorization=Basic <b64 pk:sk>`
 * and `x-langfuse-ingestion-version=4`). Arize Phoenix accepts protobuf only — put an OTel
 * Collector in front of it.
 *
 * Behavior: batches (flush every 5 s or at 20 spans), 5 s request timeout, never throws into
 * the completion path, drops a failed batch with a rate-limited log line, flushes on dispose
 * within an overall 5 s shutdown deadline. Failure log lines never include error messages
 * (fetch echoes header values into them) — only the error class/code and the host.
 */

import {
  GENAI_SCHEMA_URL,
  INT_ATTRIBUTES,
  SpanAttributeValue,
  TraceLogger,
  TraceRecord,
  TraceSink,
  buildSpanAttributes,
  msToUnixNano,
  spanKind,
  spanName,
  spanStatus,
  stripContent,
} from './trace';

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

/** Env var names only — the setting names a variable, it never carries a value. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_NAME.test(name);
}

/** RFC 7230 `token` — a valid header name. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** RFC 7230 field-value: visible ASCII, space, tab, obs-text. No controls (NUL, CR, LF, DEL). */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;

/**
 * Parse `key=value,key2=value2` (the OTEL_EXPORTER_OTLP_HEADERS format). Splits each pair on
 * the FIRST `=` (base64 padding stays in the value), trims, skips malformed/empty entries,
 * and percent-decodes values as that spec allows. Entries with an invalid name or value are
 * dropped and reported through `onInvalid` — with the key only when the key itself is valid
 * (never the value: it is usually a secret, and fetch would echo it into its error message).
 */
export function parseOtlpHeaders(
  raw: string | undefined,
  onInvalid?: (key: string | undefined) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (!key || !value) continue;
    if (!HEADER_NAME.test(key)) {
      onInvalid?.(undefined);
      continue;
    }
    try {
      value = decodeURIComponent(value).trim();
    } catch {
      /* keep raw */
    }
    if (!value) continue;
    if (!HEADER_VALUE.test(value)) {
      onInvalid?.(key);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** An endpoint for log lines: scheme, host, and path — no userinfo, query, or fragment. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

/** Storage key for the "trace data leaves the machine" notice; content export warns separately. */
export function otlpWarnKey(host: string, includeContent: boolean): string {
  return includeContent ? `${host}|content` : host;
}

/**
 * A log-safe description of a thrown value: its class and (for network errors) the errno-style
 * code. Never the message — undici's header errors quote the header value.
 */
export function describeErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = [(err as { code?: unknown }).code, (err.cause as { code?: unknown })?.code].find(
    (c): c is string => typeof c === 'string' && /^[A-Z][A-Z0-9_]*$/.test(c),
  );
  const name = err.name || err.constructor?.name || 'Error';
  return code ? `${name} ${code}` : name;
}

/** `{endpoint}/v1/traces`, unless the endpoint already names the traces path. */
export function otlpTracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return /\/v1\/traces$/.test(trimmed) ? trimmed : `${trimmed}/v1/traces`;
}

/** Only http(s) endpoints are accepted. */
export function isValidOtlpEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function toAnyValue(key: string, v: SpanAttributeValue): OtlpAnyValue {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return INT_ATTRIBUTES.has(key) && Number.isInteger(v)
      ? { intValue: String(v) }
      : { doubleValue: v };
  }
  return { stringValue: v };
}

export function toOtlpAttributes(attrs: Record<string, SpanAttributeValue>): OtlpKeyValue[] {
  return Object.entries(attrs).map(([key, v]) => ({ key, value: toAnyValue(key, v) }));
}

export function toOtlpSpan(record: TraceRecord, includeContent: boolean): OtlpSpan {
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    name: spanName(record),
    kind: spanKind(record),
    startTimeUnixNano: msToUnixNano(record.startTimeMs),
    endTimeUnixNano: msToUnixNano(record.endTimeMs),
    attributes: toOtlpAttributes(buildSpanAttributes(record, includeContent)),
    status: spanStatus(record, includeContent),
  };
}

export function buildOtlpPayload(spans: OtlpSpan[], serviceVersion: string): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'bespoke-ai' } },
            { key: 'service.version', value: { stringValue: serviceVersion } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'bespoke-ai', version: serviceVersion },
            spans,
            schemaUrl: GENAI_SCHEMA_URL,
          },
        ],
      },
    ],
  };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface OtlpExporterOptions {
  endpoint: string;
  /** Resolved at every flush so key-store / env changes apply without a restart. */
  getHeaders: () => Record<string, string>;
  serviceVersion: string;
  /** Send `gen_ai.*.messages` etc. Only when both capture settings are on. */
  includeContent: boolean;
  logger?: TraceLogger;
  fetchFn?: FetchLike;
  flushIntervalMs?: number;
  maxBatch?: number;
  timeoutMs?: number;
  /** Queue bound; oldest spans are dropped beyond this (collector down for a long time). */
  maxQueue?: number;
  /** Minimum gap between failure log lines. */
  logIntervalMs?: number;
  /** Overall deadline for the final flush on dispose; whatever is left is dropped. */
  shutdownMs?: number;
}

export class OtlpExporter implements TraceSink {
  readonly endpoint: string;
  readonly includeContent: boolean;
  private readonly url: string;
  private readonly opts: Required<
    Pick<
      OtlpExporterOptions,
      'flushIntervalMs' | 'maxBatch' | 'timeoutMs' | 'maxQueue' | 'logIntervalMs' | 'shutdownMs'
    >
  >;
  private readonly getHeaders: () => Record<string, string>;
  private readonly serviceVersion: string;
  private readonly logger?: TraceLogger;
  private readonly fetchFn: FetchLike;
  /** Records awaiting export; converted to OTLP spans at send time, off the completion path. */
  private queue: Array<{ record: TraceRecord; includeContent: boolean }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private lastFailureLog = 0;
  private droppedSinceLog = 0;
  private disposed = false;
  /** Set when the shutdown deadline passes: the flush loop stops sending. */
  private abandoned = false;

  constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint;
    this.url = otlpTracesUrl(options.endpoint);
    this.includeContent = options.includeContent;
    this.getHeaders = options.getHeaders;
    this.serviceVersion = options.serviceVersion;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.opts = {
      flushIntervalMs: options.flushIntervalMs ?? 5_000,
      maxBatch: options.maxBatch ?? 20,
      timeoutMs: options.timeoutMs ?? 5_000,
      maxQueue: options.maxQueue ?? 1_000,
      logIntervalMs: options.logIntervalMs ?? 60_000,
      shutdownMs: options.shutdownMs ?? 5_000,
    };
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Queue a span. Synchronous, never throws, never waits on the network. */
  export(record: TraceRecord, includeContent = true): void {
    if (this.disposed) return;
    try {
      this.queue.push({ record, includeContent });
      if (this.queue.length > this.opts.maxQueue) {
        const over = this.queue.length - this.opts.maxQueue;
        this.queue.splice(0, over);
        this.droppedSinceLog += over;
      }
      if (this.queue.length >= this.opts.maxBatch) void this.flush();
    } catch (err) {
      this.logFailure(`could not queue span: ${describeErrorForLog(err)}`);
    }
  }

  stripQueuedContent(): void {
    this.queue = this.queue.map((q) => ({ record: stripContent(q.record), includeContent: false }));
  }

  /** Send everything queued, in batches. Resolves when done; never rejects. */
  flush(): Promise<void> {
    this.inFlight = this.inFlight.then(async () => {
      while (this.queue.length > 0 && !this.abandoned) {
        const batch = this.queue.splice(0, this.opts.maxBatch);
        await this.send(batch);
      }
    });
    return this.inFlight;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A hung collector must not hold up VS Code's deactivate for batches × timeout.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.flush().then(() => false),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(true), this.opts.shutdownMs);
      }),
    ]);
    clearTimeout(deadline);
    if (!timedOut) return;
    this.abandoned = true;
    const dropped = this.queue.length;
    this.queue = [];
    try {
      this.logger?.error(
        `Trace export to ${this.host()} did not finish within ${this.opts.shutdownMs} ms at shutdown; dropped ${dropped} queued span(s).`,
      );
    } catch {
      // Logger may already be disposed during shutdown.
    }
  }

  private host(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return '(invalid URL)';
    }
  }

  private async send(
    batch: Array<{ record: TraceRecord; includeContent: boolean }>,
  ): Promise<void> {
    try {
      const spans = batch.map((q) => toOtlpSpan(q.record, this.includeContent && q.includeContent));
      const headers = { ...this.getHeaders(), 'Content-Type': 'application/json' };
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildOtlpPayload(spans, this.serviceVersion)),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        this.droppedSinceLog += batch.length;
        this.logFailure(`HTTP ${res.status}`);
      }
    } catch (err) {
      this.droppedSinceLog += batch.length;
      const name = (err as { name?: string })?.name;
      const reason =
        name === 'TimeoutError' || name === 'AbortError'
          ? `timed out after ${this.opts.timeoutMs} ms`
          : describeErrorForLog(err);
      this.logFailure(reason);
    }
  }

  private logFailure(reason: string): void {
    const now = Date.now();
    if (now - this.lastFailureLog < this.opts.logIntervalMs) return;
    this.lastFailureLog = now;
    const host = this.host();
    const dropped = this.droppedSinceLog;
    this.droppedSinceLog = 0;
    try {
      this.logger?.error(
        `Trace export to ${host} failed (${reason}); dropped ${dropped} span(s). Further failures are logged at most once a minute.`,
      );
    } catch {
      // Logger may already be disposed during shutdown.
    }
  }
}
