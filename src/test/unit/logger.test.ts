import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const channel = {
  appendLine: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => channel),
  },
}));

import * as vscode from 'vscode';
import { Logger, LogLevel, generateRequestId, isLogLevel } from '../../utils/logger';

const SEPARATOR = '─'.repeat(67);

function lines(): string[] {
  return channel.appendLine.mock.calls.map((c) => c[0] as string);
}

function makeLogger(level?: LogLevel): Logger {
  const logger = new Logger('Bespoke AI');
  if (level) logger.setLevel(level);
  return logger;
}

describe('Logger', () => {
  beforeEach(() => {
    channel.appendLine.mockClear();
    channel.show.mockClear();
    channel.dispose.mockClear();
    vi.useFakeTimers();
    // Timestamp is the UTC time-of-day slice of the ISO string.
    vi.setSystemTime(new Date('2026-01-02T00:51:11.539Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an output channel with the given name', () => {
    new Logger('Bespoke AI');
    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Bespoke AI');
  });

  describe('level filtering', () => {
    const emitAll = (logger: Logger) => {
      logger.info('i');
      logger.debug('d');
      logger.trace('t');
      logger.error('e');
    };

    it('defaults to info: only info and error are written', () => {
      emitAll(makeLogger());
      expect(lines()).toEqual(['[INFO  00:51:11.539] i', '[ERROR 00:51:11.539] e']);
    });

    it('debug level adds debug but not trace', () => {
      emitAll(makeLogger('debug'));
      expect(lines()).toEqual([
        '[INFO  00:51:11.539] i',
        '[DEBUG 00:51:11.539] d',
        '[ERROR 00:51:11.539] e',
      ]);
    });

    it('trace level writes everything', () => {
      emitAll(makeLogger('trace'));
      expect(lines()).toEqual([
        '[INFO  00:51:11.539] i',
        '[DEBUG 00:51:11.539] d',
        '[TRACE 00:51:11.539] t',
        '[ERROR 00:51:11.539] e',
      ]);
    });

    it('setLevel takes effect for subsequent calls (downgrade suppresses debug)', () => {
      const logger = makeLogger('trace');
      logger.debug('shown');
      logger.setLevel('info');
      logger.debug('hidden');
      logger.trace('hidden');
      expect(lines()).toEqual(['[DEBUG 00:51:11.539] shown']);
    });
  });

  describe('error', () => {
    it('appends an Error message', () => {
      makeLogger().error('Request failed', new Error('boom'));
      expect(lines()).toEqual(['[ERROR 00:51:11.539] Request failed: boom']);
    });

    it('stringifies non-Error values', () => {
      makeLogger().error('Request failed', 'socket closed');
      makeLogger().error('Request failed', 42);
      expect(lines()).toEqual([
        '[ERROR 00:51:11.539] Request failed: socket closed',
        '[ERROR 00:51:11.539] Request failed: 42',
      ]);
    });

    it('omits the suffix when no error (or a falsy one) is given', () => {
      makeLogger().error('Plain');
      makeLogger().error('Null', null);
      expect(lines()).toEqual(['[ERROR 00:51:11.539] Plain', '[ERROR 00:51:11.539] Null']);
    });
  });

  describe('requestStart', () => {
    const details = {
      mode: 'code',
      backend: 'api',
      file: 'main.ts',
      prefixLen: 645,
      suffixLen: 69,
    };

    it('writes a separator then the ▶ line at debug level', () => {
      makeLogger('debug').requestStart('a7f3', details);
      expect(lines()).toEqual([
        SEPARATOR,
        '[DEBUG 00:51:11.539] ▶ #a7f3 | code | api | main.ts | 645+69 chars',
      ]);
    });

    it('is shown at trace level too', () => {
      makeLogger('trace').requestStart('a7f3', details);
      expect(lines()).toHaveLength(2);
    });

    it('writes nothing at info level', () => {
      makeLogger('info').requestStart('a7f3', details);
      expect(lines()).toEqual([]);
    });
  });

  describe('requestEnd', () => {
    it('reports duration, result length, and slot', () => {
      makeLogger('debug').requestEnd('a7f3', { durationMs: 835, resultLen: 9, slot: 0 });
      expect(lines()).toEqual(['[DEBUG 00:51:11.539] ◀ #a7f3 | 835ms | 9 chars | slot=0']);
    });

    it('omits slot when undefined', () => {
      makeLogger('debug').requestEnd('a7f3', { durationMs: 12, resultLen: 0 });
      expect(lines()).toEqual(['[DEBUG 00:51:11.539] ◀ #a7f3 | 12ms | 0 chars']);
    });

    it('reports null results as "null"', () => {
      makeLogger('debug').requestEnd('a7f3', { durationMs: 5, resultLen: null });
      expect(lines()).toEqual(['[DEBUG 00:51:11.539] ◀ #a7f3 | 5ms | null']);
    });

    it('cancelled takes precedence over result length', () => {
      makeLogger('debug').requestEnd('a7f3', {
        durationMs: 5,
        resultLen: 20,
        cancelled: true,
        slot: 1,
      });
      expect(lines()).toEqual(['[DEBUG 00:51:11.539] ◀ #a7f3 | 5ms | cancelled | slot=1']);
    });

    it('writes nothing at info level', () => {
      makeLogger('info').requestEnd('a7f3', { durationMs: 5, resultLen: 1 });
      expect(lines()).toEqual([]);
    });
  });

  describe('cacheHit', () => {
    it('writes a separator and a cache-hit line at debug level', () => {
      makeLogger('debug').cacheHit('beef', 17);
      expect(lines()).toEqual([SEPARATOR, '[DEBUG 00:51:11.539] ◀ #beef | cache hit | 17 chars']);
    });

    it('writes nothing at info level', () => {
      makeLogger('info').cacheHit('beef', 17);
      expect(lines()).toEqual([]);
    });
  });

  describe('traceBlock', () => {
    it('writes a label line then every content line indented by 10 spaces', () => {
      makeLogger('trace').traceBlock('prefix', 'const x = 1;\nfunction foo() {\n');
      expect(lines()).toEqual([
        '[TRACE]   prefix:',
        '          const x = 1;\n          function foo() {\n          ',
      ]);
    });

    it('does not truncate long content (callers own truncation)', () => {
      // Truncation was removed deliberately (10e2781): trace logs show exactly what was sent.
      const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
      makeLogger('trace').traceBlock('→ sent', content);
      const body = lines()[1];
      expect(body.split('\n')).toHaveLength(500);
      expect(body).not.toContain('⋮');
    });

    it('is suppressed at debug and info levels', () => {
      makeLogger('debug').traceBlock('prefix', 'secret document text');
      makeLogger('info').traceBlock('prefix', 'secret document text');
      expect(lines()).toEqual([]);
    });
  });

  describe('traceInline', () => {
    it('writes label: value on one line at trace level', () => {
      makeLogger('trace').traceInline('model', 'sonnet');
      expect(lines()).toEqual(['[TRACE]   model: sonnet']);
    });

    it('is suppressed below trace level', () => {
      makeLogger('debug').traceInline('model', 'sonnet');
      expect(lines()).toEqual([]);
    });
  });

  describe('invalid levels (hand-edited settings.json)', () => {
    const emitGated = (logger: Logger) => {
      logger.debug('d');
      logger.trace('t');
      logger.requestStart('a7f3', {
        mode: 'prose',
        backend: 'api',
        file: 'notes.md',
        prefixLen: 1,
        suffixLen: 0,
      });
      logger.requestEnd('a7f3', { durationMs: 5, resultLen: 3 });
      logger.cacheHit('a7f3', 3);
      logger.traceBlock('prefix', 'SECRET DOCUMENT TEXT');
      logger.traceInline('model', 'm');
    };

    // 'error' reads like a level but is not one; 'Debug' is a case slip; 'constructor'
    // is a prototype key, so an `in` check would wrongly accept it.
    for (const bad of ['error', 'Debug', 'constructor', '__proto__', '']) {
      it(`'${bad}' silences every gated method and behaves as info`, () => {
        const logger = makeLogger(bad as LogLevel);
        emitGated(logger);
        logger.info('i');
        logger.error('e');
        expect(lines()).toEqual(['[INFO  00:51:11.539] i', '[ERROR 00:51:11.539] e']);
      });
    }

    it('a later valid setLevel still takes effect', () => {
      const logger = makeLogger('error' as LogLevel);
      logger.setLevel('debug');
      logger.debug('d');
      expect(lines()).toEqual(['[DEBUG 00:51:11.539] d']);
    });

    it('isLogLevel accepts exactly info, debug, trace', () => {
      expect(['info', 'debug', 'trace'].every(isLogLevel)).toBe(true);
      for (const v of [
        'error',
        'Debug',
        'constructor',
        'toString',
        '__proto__',
        '',
        undefined,
        1,
      ]) {
        expect(isLogLevel(v)).toBe(false);
      }
    });
  });

  it('show() reveals the channel without taking focus; dispose() disposes it', () => {
    const logger = makeLogger();
    logger.show();
    logger.dispose();
    expect(channel.show).toHaveBeenCalledWith(true);
    expect(channel.dispose).toHaveBeenCalledOnce();
  });
});

describe('generateRequestId', () => {
  it('returns 4 lowercase hex characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRequestId()).toMatch(/^[0-9a-f]{4}$/);
    }
  });
});
