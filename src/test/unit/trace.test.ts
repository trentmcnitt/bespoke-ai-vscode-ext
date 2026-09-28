import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TraceRecord,
  TraceRecorder,
  TraceFileSink,
  GenerationDetail,
  buildSpanAttributes,
  toSpanJson,
  stripContent,
  totalInputTokens,
  genAiProviderName,
  serverAddressFor,
  errorTypeOf,
  attachDetailToError,
  detailFromError,
  msToUnixNano,
  nullResultOutcome,
  newTraceId,
  newSpanId,
  spanName,
  GENAI_SCHEMA_URL,
  SPAN_KIND_INTERNAL,
} from '../../utils/trace';

function makeDetail(overrides: Partial<GenerationDetail> = {}): GenerationDetail {
  return {
    providerName: 'anthropic',
    requestModel: 'claude-haiku-4-5',
    responseModel: 'claude-haiku-4-5-20251001',
    serverAddress: 'api.anthropic.com',
    maxTokens: 200,
    inputTokens: 50,
    outputTokens: 8,
    cacheReadTokens: 900,
    cacheWriteTokens: 100,
    durationApiMs: 420,
    finishReason: 'end_turn',
    content: {
      systemPrompt: 'SYSTEM',
      userMessage: 'USER',
      prefill: 'PREFILL',
      rawOutput: 'RAW',
      extracted: 'EXTRACTED',
    },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    requestId: 'a7f3',
    source: 'completion',
    operation: 'text_completion',
    backend: 'api',
    mode: 'prose',
    languageId: 'markdown',
    outcome: 'ok',
    providerName: 'anthropic',
    requestModel: 'claude-haiku-4-5',
    receivedAtMs: 1_700_000_000_000,
    startTimeMs: 1_700_000_002_000,
    endTimeMs: 1_700_000_002_500,
    debounceMs: 2000,
    detail: makeDetail(),
    finalText: 'FINAL',
    ...overrides,
  };
}

describe('trace — span attributes', () => {
  it('uses the GenAI semantic-convention attribute names', () => {
    const a = buildSpanAttributes(makeRecord(), false);
    expect(a['gen_ai.operation.name']).toBe('text_completion');
    expect(a['gen_ai.provider.name']).toBe('anthropic');
    expect(a['gen_ai.request.model']).toBe('claude-haiku-4-5');
    expect(a['gen_ai.response.model']).toBe('claude-haiku-4-5-20251001');
    expect(a['gen_ai.request.max_tokens']).toBe(200);
    expect(a['gen_ai.usage.output_tokens']).toBe(8);
    expect(a['gen_ai.usage.cache_read.input_tokens']).toBe(900);
    expect(a['gen_ai.usage.cache_write.input_tokens']).toBe(100);
    expect(a['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    expect(a['server.address']).toBe('api.anthropic.com');
    expect(a['bespoke_ai.request_id']).toBe('a7f3');
    expect(a['bespoke_ai.mode']).toBe('prose');
    expect(a['bespoke_ai.outcome']).toBe('ok');
    expect(a['bespoke_ai.cache_hit']).toBe(false);
    expect(a['bespoke_ai.language_id']).toBe('markdown');
    expect(a['bespoke_ai.backend']).toBe('api');
    expect(a['bespoke_ai.debounce_ms']).toBe(2000);
    expect(a['bespoke_ai.duration_api_ms']).toBe(420);
  });

  it('gen_ai.usage.input_tokens includes cache reads and writes (adapters report non-cached)', () => {
    const a = buildSpanAttributes(makeRecord(), false);
    expect(a['gen_ai.usage.input_tokens']).toBe(50 + 900 + 100);
    expect(totalInputTokens({ providerName: 'openai', requestModel: 'm', inputTokens: 232 })).toBe(
      232,
    );
    expect(totalInputTokens({ providerName: 'openai', requestModel: 'm' })).toBeUndefined();
  });

  it('sets gen_ai.usage.cost only when the backend reported a cost', () => {
    expect(buildSpanAttributes(makeRecord(), false)['gen_ai.usage.cost']).toBeUndefined();
    const withCost = makeRecord({ detail: makeDetail({ costUsd: 0.0123 }) });
    expect(buildSpanAttributes(withCost, false)['gen_ai.usage.cost']).toBe(0.0123);
  });

  it('omits every content attribute when includeContent is false', () => {
    const a = buildSpanAttributes(makeRecord(), false);
    const json = JSON.stringify(a);
    for (const secret of ['SYSTEM', 'USER', 'PREFILL', 'RAW', 'FINAL']) {
      expect(json).not.toContain(secret);
    }
    expect(a['gen_ai.system_instructions']).toBeUndefined();
    expect(a['gen_ai.input.messages']).toBeUndefined();
    expect(a['gen_ai.output.messages']).toBeUndefined();
  });

  it('serializes content as the spec JSON message shapes (with prefill as an assistant message)', () => {
    const a = buildSpanAttributes(makeRecord(), true);
    expect(JSON.parse(a['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'SYSTEM' },
    ]);
    expect(JSON.parse(a['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'USER' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'PREFILL' }] },
    ]);
    expect(JSON.parse(a['gen_ai.output.messages'] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'RAW' }] },
    ]);
    expect(a['bespoke_ai.completion.text']).toBe('FINAL');
  });

  it('records error.type only for errors, falling back to _OTHER', () => {
    expect(buildSpanAttributes(makeRecord(), false)['error.type']).toBeUndefined();
    const err = makeRecord({ outcome: 'error', errorType: '429' });
    expect(buildSpanAttributes(err, false)['error.type']).toBe('429');
    const bare = makeRecord({ outcome: 'error', detail: undefined });
    expect(buildSpanAttributes(bare, false)['error.type']).toBe('_OTHER');
  });

  it('falls back to record-level provider/model when there is no detail (cache hit)', () => {
    const r = makeRecord({
      outcome: 'cache_hit',
      detail: undefined,
      providerName: 'x_ai',
      requestModel: 'grok-4',
    });
    const a = buildSpanAttributes(r, false);
    expect(a['gen_ai.provider.name']).toBe('x_ai');
    expect(a['gen_ai.request.model']).toBe('grok-4');
    expect(a['bespoke_ai.cache_hit']).toBe(true);
    expect(a['gen_ai.usage.input_tokens']).toBeUndefined();
  });
});

describe('trace — span JSON', () => {
  it('names the span "{operation} {model}", kind CLIENT, with string nanos', () => {
    const r = makeRecord();
    const span = toSpanJson(r, false);
    expect(span.name).toBe('text_completion claude-haiku-4-5');
    expect(spanName(makeRecord({ operation: 'chat' }))).toBe('chat claude-haiku-4-5');
    expect(span.kind).toBe(3);
    expect(span.startTimeUnixNano).toBe('1700000002000000000');
    expect(span.endTimeUnixNano).toBe('1700000002500000000');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.schemaUrl).toBe(GENAI_SCHEMA_URL);
  });

  it('maps outcomes to status codes', () => {
    expect(toSpanJson(makeRecord({ outcome: 'ok' }), false).status.code).toBe(1);
    expect(toSpanJson(makeRecord({ outcome: 'cache_hit' }), false).status.code).toBe(1);
    expect(toSpanJson(makeRecord({ outcome: 'empty' }), false).status.code).toBe(0);
    expect(toSpanJson(makeRecord({ outcome: 'aborted' }), false).status.code).toBe(0);
    const err = toSpanJson(makeRecord({ outcome: 'error', errorMessage: 'boom' }), true);
    expect(err.status).toEqual({ code: 2, message: 'boom' });
  });

  it('msToUnixNano avoids float formatting', () => {
    expect(msToUnixNano(1)).toBe('1000000');
    expect(msToUnixNano(1_759_000_000_123)).toBe('1759000000123000000');
  });
});

describe('trace — helpers', () => {
  it('maps preset providers to gen_ai.provider.name values', () => {
    expect(genAiProviderName('anthropic')).toBe('anthropic');
    expect(genAiProviderName('openai')).toBe('openai');
    expect(genAiProviderName('google')).toBe('gcp.gemini');
    expect(genAiProviderName('xai')).toBe('x_ai');
    expect(genAiProviderName('openrouter')).toBe('openrouter');
    expect(genAiProviderName('ollama')).toBe('ollama');
  });

  it('derives server.address from baseUrl or the provider default', () => {
    expect(serverAddressFor('xai', 'https://api.x.ai/v1')).toBe('api.x.ai');
    expect(serverAddressFor('anthropic')).toBe('api.anthropic.com');
    expect(serverAddressFor('openai')).toBe('api.openai.com');
    expect(serverAddressFor('ollama', 'not a url')).toBeUndefined();
  });

  it('nullResultOutcome attributes a null result: aborted, swallowed error, or empty', () => {
    const d: GenerationDetail = { providerName: 'anthropic', requestModel: 'm' };
    expect(nullResultOutcome(undefined)).toBe('empty');
    expect(nullResultOutcome({ ...d, outputTokens: 3, finishReason: 'end_turn' })).toBe('empty');
    expect(nullResultOutcome({ ...d, errorType: '429' })).toBe('error');
    expect(nullResultOutcome({ ...d, errorType: '529' })).toBe('error');
    expect(nullResultOutcome({ ...d, errorType: 'circuit_open' })).toBe('error');
    expect(nullResultOutcome({ ...d, aborted: true })).toBe('aborted');
    expect(nullResultOutcome({ ...d, errorType: '429' }, true)).toBe('aborted');
    expect(nullResultOutcome(undefined, true)).toBe('aborted');
  });

  it('errorTypeOf prefers HTTP status, then error name', () => {
    expect(errorTypeOf(Object.assign(new Error('x'), { status: 401 }))).toBe('401');
    expect(errorTypeOf(new TypeError('x'))).toBe('TypeError');
    expect(errorTypeOf(new Error('x'))).toBe('Error');
    expect(errorTypeOf('str')).toBe('_OTHER');
  });

  it('carries detail on thrown errors', () => {
    const err = new Error('x');
    const d = makeDetail();
    attachDetailToError(err, d);
    expect(detailFromError(err)).toBe(d);
    expect(detailFromError(new Error('y'))).toBeUndefined();
    expect(detailFromError(undefined)).toBeUndefined();
  });

  it('stripContent removes content and final text without mutating the input', () => {
    const r = makeRecord();
    const s = stripContent(r);
    expect(s.detail?.content).toBeUndefined();
    expect('finalText' in s).toBe(false);
    expect(s.detail?.outputTokens).toBe(8);
    expect(r.detail?.content?.systemPrompt).toBe('SYSTEM');
    expect(r.finalText).toBe('FINAL');
  });
});

describe('TraceRecorder', () => {
  it('keeps the last N records, newest first', () => {
    const rec = new TraceRecorder({ captureContent: true, capacity: 3 });
    for (let i = 0; i < 5; i++) rec.record(makeRecord({ requestId: `r${i}` }));
    expect(rec.getRecent().map((r) => r.requestId)).toEqual(['r4', 'r3', 'r2']);
  });

  it('defaults to a 200-record ring', () => {
    const rec = new TraceRecorder({ captureContent: false });
    for (let i = 0; i < 250; i++) rec.record(makeRecord());
    expect(rec.getRecent()).toHaveLength(200);
  });

  it('strips content before the ring, listeners, and sinks when capture is off', () => {
    const rec = new TraceRecorder({ captureContent: false });
    const seen: TraceRecord[] = [];
    const exported: TraceRecord[] = [];
    rec.onDidRecord((r) => seen.push(r));
    rec.setSink('test', { export: (r) => exported.push(r) });
    rec.record(makeRecord());
    for (const r of [rec.getRecent()[0], seen[0], exported[0]]) {
      expect(JSON.stringify(r)).not.toContain('SYSTEM');
      expect(JSON.stringify(r)).not.toContain('FINAL');
    }
    rec.setCaptureContent(true);
    rec.record(makeRecord());
    expect(rec.getRecent()[0].detail?.content?.systemPrompt).toBe('SYSTEM');
  });

  it('never throws when a listener or sink throws', () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const rec = new TraceRecorder({ captureContent: true, logger });
    rec.onDidRecord(() => {
      throw new Error('listener');
    });
    rec.setSink('bad', {
      export: () => {
        throw new Error('sink');
      },
    });
    expect(() => rec.record(makeRecord())).not.toThrow();
    expect(rec.getRecent()).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('listener disposal and sink replacement', async () => {
    const rec = new TraceRecorder({ captureContent: true });
    const l = vi.fn();
    const sub = rec.onDidRecord(l);
    rec.record(makeRecord());
    sub.dispose();
    rec.record(makeRecord());
    expect(l).toHaveBeenCalledTimes(1);

    const dispose = vi.fn();
    rec.setSink('s', { export: vi.fn(), dispose });
    rec.setSink('s', null);
    expect(dispose).toHaveBeenCalled();
    expect(rec.getSink('s')).toBeUndefined();
    await rec.dispose();
  });
});

describe('TraceFileSink', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends one OTel-shaped span per line, asynchronously and in order', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const file = path.join(dir, 'traces.jsonl');
    const sink = new TraceFileSink(file);
    sink.export(makeRecord({ requestId: 'r1' }));
    sink.export(makeRecord({ requestId: 'r2' }));
    // Nothing is written synchronously on the completion path.
    expect(fs.existsSync(file)).toBe(false);
    await sink.flush();
    const lines = fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.attributes['bespoke_ai.request_id'])).toEqual(['r1', 'r2']);
    expect(lines[0].name).toBe('text_completion claude-haiku-4-5');
    expect(lines[0].attributes['gen_ai.usage.input_tokens']).toBe(1050);
  });

  it('writes no content when the recorder has capture off', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const file = path.join(dir, 'traces.jsonl');
    const sink = new TraceFileSink(file);
    const rec = new TraceRecorder({ captureContent: false });
    rec.setSink('file', sink);
    rec.record(makeRecord());
    await sink.flush();
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('SYSTEM');
    expect(text).not.toContain('gen_ai.input.messages');
    expect(text).toContain('gen_ai.usage.output_tokens');
  });

  it('rotates to a dated archive past the size threshold', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const file = path.join(dir, 'traces.jsonl');
    const sink = new TraceFileSink(file, undefined, 200);
    sink.export(makeRecord());
    await sink.flush();
    const archive = path.join(dir, `traces-${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // A second rotation the same day appends to the existing archive.
    sink.export(makeRecord());
    await sink.flush();
    expect(fs.readFileSync(archive, 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('purges archives older than seven days on rotation', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const old = path.join(dir, 'traces-2020-01-01.jsonl');
    fs.writeFileSync(old, '{}\n');
    const sink = new TraceFileSink(path.join(dir, 'traces.jsonl'), undefined, 10);
    sink.export(makeRecord());
    await sink.flush();
    expect(fs.existsSync(old)).toBe(false);
  });

  it('logs and swallows write failures', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, '');
    const logger = { error: vi.fn(), info: vi.fn() };
    const sink = new TraceFileSink(path.join(blocker, 'traces.jsonl'), logger);
    sink.export(makeRecord());
    await sink.flush();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('trace — review fixes', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('exports cache hits and backend_unavailable as INTERNAL spans with no model/usage attributes', () => {
    const hit = makeRecord({ outcome: 'cache_hit', detail: undefined });
    const unavailable = makeRecord({
      outcome: 'error',
      errorType: 'backend_unavailable',
      detail: makeDetail(),
    });
    for (const r of [hit, unavailable]) {
      const span = toSpanJson(r, true);
      expect(span.kind).toBe(SPAN_KIND_INTERNAL);
      expect(span.attributes['gen_ai.operation.name']).toBe('text_completion');
      expect(Object.keys(span.attributes).some((k) => k.startsWith('gen_ai.usage.'))).toBe(false);
      expect(span.attributes['gen_ai.response.model']).toBeUndefined();
    }
    expect(toSpanJson(makeRecord(), false).kind).toBe(3);
  });

  it('omits gen_ai.usage.* for requests that did not complete (error / aborted)', () => {
    const zeros = makeDetail({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      costUsd: 0,
    });
    for (const outcome of ['error', 'aborted'] as const) {
      const a = buildSpanAttributes(
        makeRecord({ outcome, detail: zeros, errorType: '429' }),
        false,
      );
      expect(Object.keys(a).some((k) => k.startsWith('gen_ai.usage.'))).toBe(false);
    }
    const empty = buildSpanAttributes(makeRecord({ outcome: 'empty' }), false);
    expect(empty['gen_ai.usage.output_tokens']).toBe(8);
  });

  it('keeps real usage on aborted requests that still ran (superseded CLI requests)', () => {
    const a = buildSpanAttributes(makeRecord({ outcome: 'aborted' }), false);
    expect(a['gen_ai.usage.output_tokens']).toBe(8);
  });

  it('sets gen_ai.response.finish_reasons when the finish reason is known', () => {
    expect(buildSpanAttributes(makeRecord(), false)['gen_ai.response.finish_reasons']).toEqual([
      'end_turn',
    ]);
  });

  it('status.message is error.type only without content, flattened and capped with content', () => {
    const r = makeRecord({
      outcome: 'error',
      errorType: '400',
      errorMessage: 'proxy echo: SECRET-BODY\n' + 'x'.repeat(500),
    });
    expect(toSpanJson(r, false).status).toEqual({ code: 2, message: '400' });
    const withContent = toSpanJson(r, true).status.message!;
    expect(withContent.length).toBeLessThanOrEqual(200);
    expect(withContent).not.toContain('\n');
  });

  it('the file sink writes error.type (not the message) for records captured with content off', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const file = path.join(dir, 'traces.jsonl');
    const sink = new TraceFileSink(file);
    const rec = new TraceRecorder({ captureContent: false });
    rec.setSink('file', sink);
    rec.record(makeRecord({ outcome: 'error', errorType: '400', errorMessage: 'SECRET-BODY' }));
    await sink.flush();
    const line = JSON.parse(fs.readFileSync(file, 'utf-8').trim());
    expect(line.status).toEqual({ code: 2, message: '400' });
  });

  it('turning capture off strips content from the ring and queued sink items, and notifies', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const file = path.join(dir, 'traces.jsonl');
    const rec = new TraceRecorder({ captureContent: true });
    const sink = new TraceFileSink(file);
    rec.setSink('file', sink);
    const resets = vi.fn();
    rec.onDidReset(resets);
    rec.record(makeRecord({ outcome: 'error', errorMessage: 'SECRET-ERR' }));
    // Still queued (writes are deferred to a macrotask) when capture goes off.
    rec.setCaptureContent(false);
    expect(resets).toHaveBeenCalledTimes(1);
    const ringed = JSON.stringify(rec.getRecent()[0]);
    expect(ringed).not.toContain('SYSTEM');
    expect(ringed).not.toContain('FINAL');
    await sink.flush();
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('SYSTEM');
    expect(text).not.toContain('gen_ai.input.messages');
    expect(text).not.toContain('SECRET-ERR');
    // off→off and off→on do not fire.
    rec.setCaptureContent(false);
    rec.setCaptureContent(true);
    expect(resets).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')(
    'creates the trace file and its archives owner-only (0600), tightening a pre-existing file',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
      const file = path.join(dir, 'traces.jsonl');
      const mode = (p: string) => fs.statSync(p).mode & 0o777;

      const sink = new TraceFileSink(file);
      sink.export(makeRecord());
      await sink.flush();
      expect(mode(file)).toBe(0o600);

      const legacy = path.join(dir, 'legacy.jsonl');
      fs.writeFileSync(legacy, '', { mode: 0o644 });
      fs.chmodSync(legacy, 0o644);
      const legacySink = new TraceFileSink(legacy);
      legacySink.export(makeRecord());
      await legacySink.flush();
      expect(mode(legacy)).toBe(0o600);

      const rotating = new TraceFileSink(file, undefined, 10);
      rotating.export(makeRecord());
      await rotating.flush();
      const archive = path.join(dir, `traces-${new Date().toISOString().slice(0, 10)}.jsonl`);
      expect(mode(archive)).toBe(0o600);
    },
  );
});
