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
 * the completion path, drops a failed batch with a rate-limited log line, flushes on dispose.
 */

import {
  GENAI_SCHEMA_URL,
  INT_ATTRIBUTES,
  SPAN_KIND_CLIENT,
  SpanAttributeValue,
  TraceLogger,
  TraceRecord,
  TraceSink,
  buildSpanAttributes,
  msToUnixNano,
  spanName,
  spanStatusCode,
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

/**
 * Parse `key=value,key2=value2` (the OTEL_EXPORTER_OTLP_HEADERS format). Splits each pair on
 * the FIRST `=` (base64 padding stays in the value), trims, skips malformed/empty entries,
 * and percent-decodes values as that spec allows.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (!key || !value || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (/[\r\n]/.test(value)) continue;
    out[key] = value;
  }
  return out;
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
  const status: OtlpSpan['status'] = { code: spanStatusCode(record) };
  const message = record.errorMessage ?? record.detail?.errorMessage;
  if (record.outcome === 'error' && message) status.message = message;
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    name: spanName(record),
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: msToUnixNano(record.startTimeMs),
    endTimeUnixNano: msToUnixNano(record.endTimeMs),
    attributes: toOtlpAttributes(buildSpanAttributes(record, includeContent)),
    status,
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
}

export class OtlpExporter implements TraceSink {
  readonly endpoint: string;
  readonly includeContent: boolean;
  private readonly url: string;
  private readonly opts: Required<
    Pick<
      OtlpExporterOptions,
      'flushIntervalMs' | 'maxBatch' | 'timeoutMs' | 'maxQueue' | 'logIntervalMs'
    >
  >;
  private readonly getHeaders: () => Record<string, string>;
  private readonly serviceVersion: string;
  private readonly logger?: TraceLogger;
  private readonly fetchFn: FetchLike;
  /** Records awaiting export; converted to OTLP spans at send time, off the completion path. */
  private queue: TraceRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private lastFailureLog = 0;
  private droppedSinceLog = 0;
  private disposed = false;

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
    };
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Queue a span. Synchronous, never throws, never waits on the network. */
  export(record: TraceRecord): void {
    if (this.disposed) return;
    try {
      this.queue.push(record);
      if (this.queue.length > this.opts.maxQueue) {
        const over = this.queue.length - this.opts.maxQueue;
        this.queue.splice(0, over);
        this.droppedSinceLog += over;
      }
      if (this.queue.length >= this.opts.maxBatch) void this.flush();
    } catch (err) {
      this.logFailure(`could not queue span: ${err}`);
    }
  }

  /** Send everything queued, in batches. Resolves when done; never rejects. */
  flush(): Promise<void> {
    this.inFlight = this.inFlight.then(async () => {
      while (this.queue.length > 0) {
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
    await this.flush();
  }

  private async send(records: TraceRecord[]): Promise<void> {
    const batch = records;
    try {
      const spans = records.map((r) => toOtlpSpan(r, this.includeContent));
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
          : err instanceof Error
            ? err.message
            : String(err);
      this.logFailure(reason);
    }
  }

  private logFailure(reason: string): void {
    const now = Date.now();
    if (now - this.lastFailureLog < this.opts.logIntervalMs) return;
    this.lastFailureLog = now;
    let host = this.url;
    try {
      host = new URL(this.url).host;
    } catch {
      /* keep */
    }
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
