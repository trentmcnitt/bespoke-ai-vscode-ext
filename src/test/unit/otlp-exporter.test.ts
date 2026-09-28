import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OtlpExporter,
  FetchLike,
  buildOtlpPayload,
  isValidEnvVarName,
  isValidOtlpEndpoint,
  otlpTracesUrl,
  otlpWarnKey,
  parseOtlpHeaders,
  redactUrl,
  stopOtlpExport,
  toOtlpAttributes,
  toOtlpSpan,
} from '../../utils/otlp-exporter';
import { TraceRecord, TraceRecorder, GENAI_SCHEMA_URL } from '../../utils/trace';

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    requestId: 'c0de',
    source: 'completion',
    operation: 'text_completion',
    backend: 'claude-code',
    mode: 'code',
    languageId: 'typescript',
    outcome: 'ok',
    providerName: 'anthropic',
    requestModel: 'sonnet',
    receivedAtMs: 1_759_000_000_000,
    startTimeMs: 1_759_000_000_800,
    endTimeMs: 1_759_000_001_234,
    debounceMs: 800,
    detail: {
      providerName: 'anthropic',
      requestModel: 'sonnet',
      responseModel: 'claude-sonnet-4-5',
      inputTokens: 3,
      outputTokens: 17,
      cacheReadTokens: 16000,
      cacheWriteTokens: 0,
      costUsd: 0.0061,
      waitMs: 4,
      finishReason: 'end_turn',
      content: { systemPrompt: 'SECRET-SYS', userMessage: 'SECRET-USER', rawOutput: 'SECRET-RAW' },
    },
    finalText: 'SECRET-FINAL',
    ...overrides,
  };
}

function okFetch() {
  return vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
}

function makeExporter(overrides: Partial<ConstructorParameters<typeof OtlpExporter>[0]> = {}) {
  const fetchFn = overrides.fetchFn ?? okFetch();
  const logger = { error: vi.fn(), info: vi.fn() };
  const exporter = new OtlpExporter({
    endpoint: 'https://collector.example.com/',
    getHeaders: () => ({ Authorization: 'Basic abc==' }),
    serviceVersion: '9.9.9',
    includeContent: false,
    logger,
    fetchFn,
    ...overrides,
  });
  live.push(exporter);
  return { exporter, fetchFn: fetchFn as ReturnType<typeof okFetch>, logger };
}

const live: OtlpExporter[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const e of live.splice(0)) await e.dispose();
});

describe('OTLP JSON shape', () => {
  it('encodes typed attributes: int64 as strings, doubles, bools, string arrays', () => {
    const attrs = toOtlpAttributes({
      'gen_ai.usage.input_tokens': 16003,
      'gen_ai.usage.cost': 0.0061,
      'bespoke_ai.cache_hit': false,
      'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.request.model': 'sonnet',
    });
    expect(attrs).toEqual([
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '16003' } },
      { key: 'gen_ai.usage.cost', value: { doubleValue: 0.0061 } },
      { key: 'bespoke_ai.cache_hit', value: { boolValue: false } },
      {
        key: 'gen_ai.response.finish_reasons',
        value: { arrayValue: { values: [{ stringValue: 'end_turn' }] } },
      },
      { key: 'gen_ai.request.model', value: { stringValue: 'sonnet' } },
    ]);
  });

  it('builds a CLIENT span with hex ids, string nanos, and GenAI attributes', () => {
    const span = toOtlpSpan(makeRecord(), false);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.kind).toBe(3);
    expect(span.name).toBe('text_completion sonnet');
    expect(span.startTimeUnixNano).toBe('1759000000800000000');
    expect(span.endTimeUnixNano).toBe('1759000001234000000');
    expect(span.status).toEqual({ code: 1 });
    const get = (k: string) => span.attributes.find((a) => a.key === k)?.value;
    expect(get('gen_ai.operation.name')).toEqual({ stringValue: 'text_completion' });
    expect(get('gen_ai.provider.name')).toEqual({ stringValue: 'anthropic' });
    expect(get('gen_ai.usage.input_tokens')).toEqual({ intValue: '16003' });
    expect(get('gen_ai.usage.output_tokens')).toEqual({ intValue: '17' });
    expect(get('gen_ai.usage.cost')).toEqual({ doubleValue: 0.0061 });
    expect(get('bespoke_ai.wait_ms')).toEqual({ intValue: '4' });
    expect(JSON.stringify(span)).not.toContain('SECRET');
  });

  it('includes content attributes only when asked', () => {
    const span = toOtlpSpan(makeRecord(), true);
    const keys = span.attributes.map((a) => a.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'gen_ai.system_instructions',
        'gen_ai.input.messages',
        'gen_ai.output.messages',
        'bespoke_ai.completion.text',
      ]),
    );
  });

  it('marks errors with status 2 and a message (error.type unless content is included)', () => {
    const r = makeRecord({ outcome: 'error', errorType: '429', errorMessage: 'rate limited' });
    expect(toOtlpSpan(r, true).status).toEqual({ code: 2, message: 'rate limited' });
    const span = toOtlpSpan(r, false);
    expect(span.status).toEqual({ code: 2, message: '429' });
    expect(span.attributes.find((a) => a.key === 'error.type')?.value).toEqual({
      stringValue: '429',
    });
  });

  it('wraps spans in resourceSpans with service + scope identity', () => {
    const payload = buildOtlpPayload([toOtlpSpan(makeRecord(), false)], '1.2.3') as {
      resourceSpans: Array<{
        resource: { attributes: unknown[] };
        scopeSpans: Array<{ scope: unknown; spans: unknown[]; schemaUrl: string }>;
      }>;
    };
    const rs = payload.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'bespoke-ai' } },
      { key: 'service.version', value: { stringValue: '1.2.3' } },
    ]);
    expect(rs.scopeSpans[0].scope).toEqual({ name: 'bespoke-ai', version: '1.2.3' });
    expect(rs.scopeSpans[0].spans).toHaveLength(1);
    expect(rs.scopeSpans[0].schemaUrl).toBe(GENAI_SCHEMA_URL);
  });
});

describe('OTLP config helpers', () => {
  it('parses OTEL-style headers, splitting on the first "=" only', () => {
    expect(parseOtlpHeaders('Authorization=Basic cGs6c2s=,x-langfuse-ingestion-version=4')).toEqual(
      { Authorization: 'Basic cGs6c2s=', 'x-langfuse-ingestion-version': '4' },
    );
    expect(parseOtlpHeaders(' a = b , , =x, noeq, c=%20d ')).toEqual({ a: 'b', c: 'd' });
    expect(parseOtlpHeaders('bad key=v,ok=1')).toEqual({ ok: '1' });
    expect(parseOtlpHeaders('x=a%0D%0AInjected: y')).toEqual({});
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });

  it('builds the traces URL', () => {
    expect(otlpTracesUrl('http://localhost:4318')).toBe('http://localhost:4318/v1/traces');
    expect(otlpTracesUrl('https://cloud.langfuse.com/api/public/otel/')).toBe(
      'https://cloud.langfuse.com/api/public/otel/v1/traces',
    );
    expect(otlpTracesUrl('http://c:4318/v1/traces')).toBe('http://c:4318/v1/traces');
  });

  it('validates endpoints and env var names', () => {
    expect(isValidOtlpEndpoint('https://x.example')).toBe(true);
    expect(isValidOtlpEndpoint('file:///etc/passwd')).toBe(false);
    expect(isValidOtlpEndpoint('nope')).toBe(false);
    expect(isValidEnvVarName('BESPOKE_OTLP_HEADERS')).toBe(true);
    expect(isValidEnvVarName('$(rm -rf)')).toBe(false);
  });
});

describe('OtlpExporter', () => {
  it('batches: flushes at 20 spans with one POST per batch', async () => {
    const { exporter, fetchFn } = makeExporter();
    for (let i = 0; i < 19; i++) exporter.export(makeRecord());
    expect(fetchFn).not.toHaveBeenCalled();
    exporter.export(makeRecord());
    await exporter.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://collector.example.com/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Basic abc==',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(init.body);
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(20);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('flushes on the 5s timer', async () => {
    vi.useFakeTimers();
    const { exporter, fetchFn } = makeExporter();
    exporter.export(makeRecord());
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await exporter.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends no content unless includeContent', async () => {
    const off = makeExporter();
    off.exporter.export(makeRecord());
    await off.exporter.flush();
    expect(off.fetchFn.mock.calls[0][1].body).not.toContain('SECRET');

    const on = makeExporter({ includeContent: true });
    on.exporter.export(makeRecord());
    await on.exporter.flush();
    expect(on.fetchFn.mock.calls[0][1].body).toContain('SECRET-USER');
  });

  it('never sends content the recorder stripped (capture off) even if includeContent', async () => {
    const { exporter, fetchFn } = makeExporter({ includeContent: true });
    const rec = new TraceRecorder({ captureContent: false });
    rec.setSink('otlp', exporter);
    rec.record(makeRecord());
    await exporter.flush();
    expect(fetchFn.mock.calls[0][1].body).not.toContain('SECRET');
  });

  it('times out a hung request after 5s and drops the batch without throwing', async () => {
    const fetchFn = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    const { exporter, logger } = makeExporter({ fetchFn, timeoutMs: 30 });
    exporter.export(makeRecord());
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/timed out after 30 ms\); dropped 1 span/);
  });

  it('swallows network errors and HTTP failures with a rate-limited log line', async () => {
    let n = 0;
    const fetchFn = vi.fn<FetchLike>(async () => {
      if (n++ === 0) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      return { ok: false, status: 503 };
    });
    const { exporter, logger } = makeExporter({ fetchFn });
    exporter.export(makeRecord());
    await exporter.flush();
    exporter.export(makeRecord());
    await exporter.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Second failure is within the 60s window — not logged again.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain('collector.example.com');
    expect(logger.error.mock.calls[0][0]).toContain('ECONNREFUSED');
  });

  it('export() never throws, even when headers resolution throws at flush', async () => {
    const { exporter, logger } = makeExporter({
      getHeaders: () => {
        throw new Error('keychain locked');
      },
    });
    expect(() => exporter.export(makeRecord())).not.toThrow();
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('bounds the queue, dropping the oldest spans', async () => {
    const fetchFn = okFetch();
    const { exporter } = makeExporter({ fetchFn, maxBatch: 1000, maxQueue: 5 });
    for (let i = 0; i < 8; i++) exporter.export(makeRecord({ requestId: `r${i}` }));
    await exporter.flush();
    const body = fetchFn.mock.calls[0][1].body;
    expect(body).not.toContain('"r2"');
    expect(body).toContain('"r3"');
    expect(body).toContain('"r7"');
  });

  it('flushes remaining spans on dispose and ignores records afterwards', async () => {
    const { exporter, fetchFn } = makeExporter();
    exporter.export(makeRecord());
    await exporter.dispose();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    exporter.export(makeRecord());
    await exporter.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('trace settings (package.json)', () => {
  it('every bespokeAI.trace.* setting is application-scoped (a repo cannot turn on capture/export)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf-8'));
    const props = pkg.contributes.configuration.properties as Record<string, { scope?: string }>;
    const trace = Object.entries(props).filter(([k]) => k.startsWith('bespokeAI.trace.'));
    expect(trace.map(([k]) => k).sort()).toEqual([
      'bespokeAI.trace.captureContent',
      'bespokeAI.trace.file',
      'bespokeAI.trace.otlp.captureContent',
      'bespokeAI.trace.otlp.endpoint',
      'bespokeAI.trace.otlp.headersEnvVar',
    ]);
    for (const [, v] of trace) expect(v.scope).toBe('application');
  });

  it('bespokeAI.logLevel is application-scoped (trace level logs prompts; a repo cannot turn it on)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf-8'));
    const props = pkg.contributes.configuration.properties as Record<string, { scope?: string }>;
    expect(props['bespokeAI.logLevel'].scope).toBe('application');
  });
});

describe('OTLP review fixes', () => {
  it('drops header values with control characters (NUL) and reports only the key', () => {
    const invalid: Array<string | undefined> = [];
    const headers = parseOtlpHeaders('Authorization=Bearer%00SECRET,ok=1,bad name=SECRET2', (k) =>
      invalid.push(k),
    );
    expect(headers).toEqual({ ok: '1' });
    expect(invalid).toEqual(['Authorization', undefined]);
    expect(parseOtlpHeaders('x=a%7Fb,t=a%09b')).toEqual({ t: 'a\tb' });
  });

  it('never logs a fetch error message (undici quotes the header value in it)', async () => {
    const fetchFn = vi.fn<FetchLike>(async () => {
      throw new TypeError('Headers.append: "Bearer SECRET-TOKEN" is an invalid header value.');
    });
    const { exporter, logger } = makeExporter({ fetchFn });
    exporter.export(makeRecord());
    await exporter.flush();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = logger.error.mock.calls[0][0] as string;
    expect(line).not.toContain('SECRET');
    expect(line).toContain('TypeError');
    expect(line).toContain('collector.example.com');
  });

  it('redactUrl drops userinfo, query, and fragment', () => {
    expect(redactUrl('https://user:pw@collector.example.com:4318/v1/traces?api_key=SECRET#x')).toBe(
      'https://collector.example.com:4318/v1/traces',
    );
    expect(redactUrl('not a url')).not.toContain('not a url');
  });

  it('warn key distinguishes metadata-only from content export for the same host', () => {
    expect(otlpWarnKey('h:1', false)).toBe('h:1');
    expect(otlpWarnKey('h:1', true)).not.toBe(otlpWarnKey('h:1', false));
  });

  it('dispose() gives up after the shutdown deadline and logs the dropped count', async () => {
    const fetchFn = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    const { exporter, logger } = makeExporter({
      fetchFn,
      maxBatch: 1,
      timeoutMs: 5_000,
      shutdownMs: 50,
    });
    // Three one-span batches: the first hangs on the collector, two stay queued.
    for (let i = 0; i < 3; i++) exporter.export(makeRecord());
    const t0 = Date.now();
    await exporter.dispose();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const line = logger.error.mock.calls.at(-1)?.[0] as string;
    expect(line).toMatch(/did not finish within 50 ms at shutdown; dropped 2 queued span/);
  });

  it('turning capture off strips content from spans queued but not yet sent', async () => {
    const { exporter, fetchFn } = makeExporter({ includeContent: true });
    const rec = new TraceRecorder({ captureContent: true });
    rec.setSink('otlp', exporter);
    rec.record(makeRecord({ outcome: 'error', errorType: '400', errorMessage: 'SECRET-ERR' }));
    rec.setCaptureContent(false);
    await exporter.flush();
    expect(fetchFn.mock.calls[0][1].body).not.toContain('SECRET');
  });

  it('exports cache hits as INTERNAL spans', () => {
    expect(toOtlpSpan(makeRecord({ outcome: 'cache_hit', detail: undefined }), false).kind).toBe(1);
    expect(toOtlpSpan(makeRecord(), false).kind).toBe(3);
  });
});

describe('OTLP stop-sending (discard)', () => {
  it('stopOtlpExport (telemetry off / endpoint cleared or invalid) sends 0 queued spans', async () => {
    vi.useFakeTimers();
    const { exporter, fetchFn } = makeExporter({ includeContent: true });
    const rec = new TraceRecorder({ captureContent: true });
    rec.setSink('otlp', exporter);
    for (let i = 0; i < 5; i++) rec.record(makeRecord());
    stopOtlpExport(rec);
    expect(rec.getSink('otlp')).toBeUndefined();
    // Past the 5 s flush interval and the dispose deadline: still nothing sent.
    await vi.advanceTimersByTimeAsync(20_000);
    await exporter.flush();
    await exporter.dispose();
    exporter.export(makeRecord());
    await exporter.flush();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aborts the request in flight and drops the rest of the queue, without a failure log', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signals.push(init.signal);
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );
    const { exporter, logger } = makeExporter({ fetchFn, maxBatch: 1, timeoutMs: 60_000 });
    const rec = new TraceRecorder({ captureContent: true });
    rec.setSink('otlp', exporter);
    for (let i = 0; i < 3; i++) rec.record(makeRecord());
    const flushing = exporter.flush();
    await new Promise((r) => setImmediate(r));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);

    stopOtlpExport(rec);
    expect(signals[0].aborted).toBe(true);
    await flushing;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a normal replace (endpoint change) still flushes the old exporter to its endpoint', async () => {
    const { exporter, fetchFn } = makeExporter();
    const rec = new TraceRecorder({ captureContent: false });
    rec.setSink('otlp', exporter);
    rec.record(makeRecord());
    const next = makeExporter({ endpoint: 'https://other.example.com' });
    rec.setSink('otlp', next.exporter);
    await exporter.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://collector.example.com/v1/traces');
  });

  it('setSink with discard falls back to dispose for sinks without discard()', () => {
    const dispose = vi.fn();
    const rec = new TraceRecorder({ captureContent: false });
    rec.setSink('x', { export: () => {}, dispose });
    rec.setSink('x', null, { discard: true });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
