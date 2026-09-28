import { describe, it, expect } from 'vitest';
import {
  generateRequestId,
  serializeMessage,
  parseMessage,
  CompletionRequest,
  CommandResponse,
  PoolDegradedEvent,
  PoolRequest,
  PoolResponse,
  ServerEvent,
} from '../../pool-server/protocol';

describe('serializeMessage', () => {
  it('produces exactly one newline-terminated line', () => {
    const line = serializeMessage({ type: 'status', id: 'abc' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2); // content + trailing empty
  });

  it('escapes embedded newlines so multi-line document text never breaks framing', () => {
    const req: CompletionRequest = {
      type: 'completion',
      id: 'r1',
      prefix: 'line one\nline two\r\n\tindented',
      suffix: '\n\n}',
      mode: 'code',
      languageId: 'typescript',
      fileName: 'a.ts',
      filePath: '/tmp/a.ts',
    };
    const line = serializeMessage(req);
    // Only the terminating newline is a raw newline
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(parseMessage(line)).toEqual(req);
  });

  it('round-trips every message family (request, response, event)', () => {
    const messages: Array<PoolRequest | PoolResponse | ServerEvent> = [
      { type: 'client-hello', id: 'h', clientId: 'win-1' },
      { type: 'command', id: 'c', message: 'write a commit msg', timeoutMs: 5000 },
      { type: 'config-update', id: 'u', customInstructions: '' },
      { type: 'recycle', id: 'r', pool: 'all' },
      {
        type: 'command',
        id: 'c',
        success: true,
        text: 'feat: thing',
        meta: { model: 'claude-haiku', costUsd: 0.001, inputTokens: 10 },
      } satisfies CommandResponse,
      { type: 'completion', id: 'x', success: true, text: null },
      { type: 'error', id: 'unknown', success: false, error: 'bad' },
      { type: 'server-shutting-down' },
      {
        type: 'pool-degraded',
        pool: 'command',
        reason: 'warmup failed',
      } satisfies PoolDegradedEvent,
    ];
    for (const msg of messages) {
      expect(parseMessage(serializeMessage(msg))).toEqual(msg);
    }
  });

  it('preserves unicode (emoji, CJK, bidi) through a round-trip', () => {
    const msg: PoolRequest = { type: 'command', id: 'u', message: 'héllo 世界 \u{1F600} ‮' };
    expect(parseMessage(serializeMessage(msg))).toEqual(msg);
  });

  it('drops undefined optional fields (so absence is distinguishable from empty string)', () => {
    const parsed = parseMessage(
      serializeMessage({
        type: 'config-update',
        id: 'u',
        model: undefined,
        customInstructions: '',
      }),
    ) as Record<string, unknown>;
    expect('model' in parsed).toBe(false);
    expect(parsed.customInstructions).toBe('');
  });
});

describe('parseMessage', () => {
  it('tolerates surrounding whitespace and CRLF line endings', () => {
    expect(parseMessage('  {"type":"status","id":"a"}\r\n')).toEqual({ type: 'status', id: 'a' });
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n'],
    ['truncated JSON', '{"type":"status","id":'],
    ['non-JSON text', 'hello world'],
    ['two messages on one line', '{"type":"status","id":"a"}{"type":"status","id":"b"}'],
  ])('returns null for %s', (_label, input) => {
    expect(parseMessage(input)).toBeNull();
  });

  it('does not validate shape: any valid JSON value is returned as-is', () => {
    // Callers must not assume the result is an object with a `type` field.
    expect(parseMessage('42')).toBe(42);
    expect(parseMessage('null')).toBeNull();
    expect(parseMessage('{"foo":1}')).toEqual({ foo: 1 });
  });

  it('reassembles a stream split at arbitrary byte boundaries', () => {
    // Mirrors the server's buffering: accumulate, split on \n, keep the tail.
    const msgs: PoolRequest[] = [
      { type: 'status', id: '1' },
      { type: 'command', id: '2', message: 'a\nb' },
      { type: 'warmup', id: '3', pool: 'completion' },
    ];
    const wire = msgs.map(serializeMessage).join('');
    for (const chunkSize of [1, 3, 7, wire.length]) {
      let buffer = '';
      const out: unknown[] = [];
      for (let i = 0; i < wire.length; i += chunkSize) {
        buffer += wire.slice(i, i + chunkSize);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const l of lines) out.push(parseMessage(l));
      }
      expect(buffer).toBe('');
      expect(out).toEqual(msgs);
    }
  });
});

describe('generateRequestId', () => {
  it('returns a short lowercase base-36 string', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRequestId()).toMatch(/^[0-9a-z]{1,8}$/);
    }
  });

  it('is effectively unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRequestId()));
    expect(ids.size).toBeGreaterThan(995);
  });
});
