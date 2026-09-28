import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { PoolServer, acquireLock, readLockfile, isProcessAlive } from '../../pool-server/server';
import { serializeMessage } from '../../pool-server/protocol';
import * as ipc from '../../pool-server/ipc-path';
import { makeConfig, makeLogger } from '../helpers';
import type { UsageLedger } from '../../utils/usage-ledger';
import type { Logger } from '../../utils/logger';
import type { ExtensionConfig, CompletionContext } from '../../types';

// ---------------------------------------------------------------------------
// Redirect the IPC endpoint + lockfile into a temp dir. The real module
// resolves them under ~/.bespokeai, which would collide with a live extension.
// Kept short: macOS caps Unix socket paths at ~104 bytes.
// ---------------------------------------------------------------------------
vi.mock('../../pool-server/ipc-path', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'bsp-'));
  const state = { sock: pathMod.join(dir, 'pool.sock') };
  return {
    STATE_DIR: dir,
    LOCK_PATH: pathMod.join(dir, 'pool.lock'),
    getIpcPath: () => state.sock,
    cleanupStaleEndpoint: () => {
      if (fsMod.existsSync(state.sock)) fsMod.unlinkSync(state.sock);
    },
    ensureStateDir: () => fsMod.mkdirSync(dir, { recursive: true }),
    __state: state,
  };
});

// ---------------------------------------------------------------------------
// Fake pools — stand in for the Claude Code CLI subprocess pools.
// ---------------------------------------------------------------------------
const pools = vi.hoisted(() => ({
  completion: [] as FakeCompletionPool[],
  command: [] as FakeCommandPool[],
}));

type FakeCompletionPool = InstanceType<
  typeof import('../../providers/claude-code').ClaudeCodeProvider
> & {
  config: ExtensionConfig;
  available: boolean;
  onPoolDegraded: ((reason: string) => void) | null;
} & Record<string, ReturnType<typeof vi.fn>>;
type FakeCommandPool = FakeCompletionPool & { model: string };

function fakeStats(label: string) {
  return {
    label,
    available: true,
    slots: [{ state: 'available', requestCount: 3, maxRequests: 24 }],
    activatedAt: 1,
    uptimeMs: 10,
    totalRequests: 3,
    totalRecycles: 0,
    lastRequestAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    resolvedModel: null,
  };
}

vi.mock('../../providers/claude-code', () => {
  class ClaudeCodeProvider {
    available = true;
    onPoolDegraded: ((reason: string) => void) | null = null;
    lastUsedModel: string | null = null;
    setLedger = vi.fn();
    activate = vi.fn(async () => {});
    isAvailable = vi.fn(() => this.available);
    getCompletion = vi.fn(async (ctx: CompletionContext) => `<<${ctx.prefix}|${ctx.suffix}>>`);
    getStats = vi.fn(() => fakeStats('completion'));
    recycleAll = vi.fn(async () => {});
    restart = vi.fn(async () => {});
    updateConfig = vi.fn((c: ExtensionConfig) => {
      this.config = c;
    });
    dispose = vi.fn();
    constructor(public config: ExtensionConfig) {
      pools.completion.push(this as unknown as FakeCompletionPool);
    }
  }
  return { ClaudeCodeProvider };
});

vi.mock('../../providers/command-pool', () => {
  class CommandPool {
    available = true;
    onPoolDegraded: ((reason: string) => void) | null = null;
    setLedger = vi.fn();
    activate = vi.fn(async () => {});
    isAvailable = vi.fn(() => this.available);
    sendPrompt = vi.fn(async (msg: string) => ({ text: `reply:${msg}`, meta: null }));
    getStats = vi.fn(() => fakeStats('command'));
    recycleAll = vi.fn(async () => {});
    restart = vi.fn(async () => {});
    updateModel = vi.fn((m: string) => {
      this.model = m;
    });
    dispose = vi.fn();
    constructor(public model: string) {
      pools.command.push(this as unknown as FakeCommandPool);
    }
  }
  return { CommandPool };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ipcState = (ipc as unknown as { __state: { sock: string } }).__state;
const DIR = ipc.STATE_DIR;
let sockCounter = 0;

type Msg = any;

interface TestClient {
  socket: net.Socket;
  messages: Msg[];
  waitFor: (pred: (m: Msg) => boolean, timeoutMs?: number) => Promise<Msg>;
  request: (req: Record<string, unknown>) => Promise<Msg>;
  closed: Promise<void>;
}

const openClients: TestClient[] = [];

function connect(): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ipcState.sock);
    const messages: Msg[] = [];
    const waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
    let buffer = '';
    socket.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        messages.push(msg);
        for (const w of [...waiters]) {
          if (w.pred(msg)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(msg);
          }
        }
      }
    });
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    const client: TestClient = {
      socket,
      messages,
      closed,
      waitFor(pred, timeoutMs = 2000) {
        const existing = messages.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('waitFor timed out')), timeoutMs);
          waiters.push({
            pred,
            resolve: (m) => {
              clearTimeout(timer);
              res(m);
            },
          });
        });
      },
      request(req) {
        socket.write(serializeMessage(req as never));
        return client.waitFor((m) => m.id === req.id && m.type !== undefined);
      },
    };
    socket.once('error', reject);
    socket.once('connect', () => {
      openClients.push(client);
      resolve(client);
    });
  });
}

function makeErrorLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const logger = { ...makeLogger(), error: (m: string) => errors.push(m) } as unknown as Logger;
  return { logger, errors };
}

let server: PoolServer | null = null;
let serverErrors: string[] = [];
let degradedCallback: ReturnType<typeof vi.fn>;

async function startServer(configOverrides: Partial<ExtensionConfig> = {}): Promise<PoolServer> {
  const { logger, errors } = makeErrorLogger();
  serverErrors = errors;
  degradedCallback = vi.fn();
  server = new PoolServer({
    config: makeConfig(configOverrides),
    logger,
    ledger: {} as UsageLedger,
    serverId: 'server-A',
    onPoolDegraded: degradedCallback,
  });
  await server.start();
  return server;
}

const completionPool = () => pools.completion[pools.completion.length - 1];
const commandPool = () => pools.command[pools.command.length - 1];

beforeEach(() => {
  // A fresh socket path per test so a closing server never races the next bind.
  ipcState.sock = path.join(DIR, `s${++sockCounter}.sock`);
  pools.completion.length = 0;
  pools.command.length = 0;
  if (fs.existsSync(ipc.LOCK_PATH)) fs.unlinkSync(ipc.LOCK_PATH);
});

afterEach(async () => {
  for (const c of openClients) c.socket.destroy();
  await Promise.all(openClients.map((c) => c.closed));
  openClients.length = 0;
  server?.dispose();
  server = null;
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PoolServer — lifecycle', () => {
  it('uses a socket path short enough for macOS', () => {
    expect(ipcState.sock.length).toBeLessThan(100);
  });

  it('listens on the IPC path, activates both pools, and wires the ledger', async () => {
    await startServer();
    expect(fs.existsSync(ipcState.sock)).toBe(true);
    expect(completionPool().activate).toHaveBeenCalledTimes(1);
    expect(commandPool().activate).toHaveBeenCalledTimes(1);
    const client = await connect();
    const res = await client.request({ type: 'client-hello', id: 'h1', clientId: 'win-1' });
    expect(res).toEqual({
      type: 'client-hello',
      id: 'h1',
      success: true,
      serverId: 'server-A',
      model: makeConfig().claudeCode.model,
    });
  });

  it('removes a stale socket file left by a crashed server before binding', async () => {
    fs.writeFileSync(ipcState.sock, 'stale');
    await startServer();
    const client = await connect();
    const res = await client.request({ type: 'warmup', id: 'w', pool: 'completion' });
    expect(res.success).toBe(true);
  });

  it('removes the lockfile and rejects when listen() fails', async () => {
    expect(acquireLock(process.pid)).toBe(true);
    ipcState.sock = path.join(DIR, 'no-such-dir', 'x.sock');
    await expect(startServer()).rejects.toThrow();
    expect(fs.existsSync(ipc.LOCK_PATH)).toBe(false);
    server = null; // nothing to dispose
  });

  it('removes the lockfile and rejects when pool activation fails', async () => {
    expect(acquireLock(process.pid)).toBe(true);
    const { logger } = makeErrorLogger();
    const s = new PoolServer({
      config: makeConfig(),
      logger,
      ledger: {} as UsageLedger,
      serverId: 'x',
    });
    server = s; // afterEach disposes it (closes the listener that start() left open)
    completionPool().activate.mockRejectedValueOnce(new Error('SDK missing'));
    await expect(s.start()).rejects.toThrow('SDK missing');
    expect(fs.existsSync(ipc.LOCK_PATH)).toBe(false);
  });

  // Regression: when listen() succeeded but activate() rejected, start() used to leave
  // the net.Server listening and the socket file on disk, so other windows connected
  // to a half-started server whose pools never activated.
  it('closes the listener and socket file when pool activation fails', async () => {
    const s = new PoolServer({
      config: makeConfig(),
      logger: makeLogger(),
      ledger: {} as UsageLedger,
      serverId: 'x',
    });
    server = s;
    commandPool().activate.mockRejectedValueOnce(new Error('SDK missing'));
    await expect(s.start()).rejects.toThrow('SDK missing');
    expect(fs.existsSync(ipcState.sock)).toBe(false);
  });

  it('dispose() closes the listener, disposes pools, and removes socket + lockfile', async () => {
    expect(acquireLock(process.pid)).toBe(true);
    const s = await startServer();
    s.dispose();
    server = null;
    expect(fs.existsSync(ipcState.sock)).toBe(false);
    expect(fs.existsSync(ipc.LOCK_PATH)).toBe(false);
    expect(completionPool().dispose).toHaveBeenCalledTimes(1);
    expect(commandPool().dispose).toHaveBeenCalledTimes(1);
    await expect(connect()).rejects.toThrow();
    // Idempotent
    s.dispose();
    expect(completionPool().dispose).toHaveBeenCalledTimes(1);
  });
});

describe('PoolServer — framing', () => {
  it('reassembles a request split across multiple writes', async () => {
    await startServer();
    const client = await connect();
    const wire = serializeMessage({ type: 'status', id: 'split' });
    client.socket.write(wire.slice(0, 5));
    await new Promise((r) => setTimeout(r, 20));
    client.socket.write(wire.slice(5, 12));
    await new Promise((r) => setTimeout(r, 20));
    client.socket.write(wire.slice(12));
    const res = await client.waitFor((m) => m.id === 'split');
    expect(res.type).toBe('status');
    expect(res.success).toBe(true);
  });

  it('answers every request when several arrive in one chunk', async () => {
    await startServer();
    const client = await connect();
    client.socket.write(
      serializeMessage({ type: 'warmup', id: 'a', pool: 'command' }) +
        serializeMessage({ type: 'status', id: 'b' }) +
        '\n\n' + // blank lines are ignored
        serializeMessage({ type: 'client-hello', id: 'c', clientId: 'z' }),
    );
    const [a, b, c] = await Promise.all([
      client.waitFor((m) => m.id === 'a'),
      client.waitFor((m) => m.id === 'b'),
      client.waitFor((m) => m.id === 'c'),
    ]);
    expect([a.type, b.type, c.type]).toEqual(['warmup', 'status', 'client-hello']);
    expect(client.messages).toHaveLength(3);
  });

  it('skips a malformed line, logs it, and keeps serving the connection', async () => {
    await startServer();
    const client = await connect();
    client.socket.write('{not json\n' + serializeMessage({ type: 'status', id: 'ok' }));
    const res = await client.waitFor((m) => m.id === 'ok');
    expect(res.success).toBe(true);
    expect(client.messages).toHaveLength(1);
    expect(serverErrors.some((e) => e.includes('failed to parse') && e.includes('{not json'))).toBe(
      true,
    );
  });

  it('replies with an error for valid JSON that is not a known request', async () => {
    await startServer();
    const client = await connect();
    client.socket.write('42\n' + serializeMessage({ type: 'bogus', id: 'q' } as never));
    const bogus = await client.waitFor((m) => m.id === 'q');
    expect(bogus).toEqual({
      type: 'error',
      id: 'q',
      success: false,
      error: 'Unknown request type: bogus',
    });
    const numeric = await client.waitFor((m) => m.id === 'unknown');
    expect(numeric.type).toBe('error');
    expect(numeric.success).toBe(false);
  });

  it('carries multi-line document text through the socket intact', async () => {
    await startServer();
    const client = await connect();
    const res = await client.request({
      type: 'completion',
      id: 'ml',
      prefix: 'function f() {\n  return 1;\n',
      suffix: '\n}\n',
      mode: 'code',
      languageId: 'typescript',
      fileName: 'f.ts',
      filePath: '/w/f.ts',
    });
    expect(res.text).toBe('<<function f() {\n  return 1;\n|\n}\n>>');
  });
});

describe('PoolServer — request dispatch', () => {
  const completionReq = (id: string, extra: Record<string, unknown> = {}) => ({
    type: 'completion',
    id,
    prefix: 'Hello',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'a.md',
    filePath: '/a.md',
    ...extra,
  });

  it('completion: returns text and the resolved model, falling back to the configured one', async () => {
    await startServer({ claudeCode: { model: 'haiku', models: ['haiku'] } });
    const client = await connect();

    const first = await client.request(completionReq('c1'));
    expect(first).toMatchObject({ success: true, text: '<<Hello|>>', meta: { model: 'haiku' } });

    completionPool().lastUsedModel = 'claude-haiku-4-5-20251001';
    const second = await client.request(completionReq('c2'));
    expect(second.meta).toEqual({ model: 'claude-haiku-4-5-20251001' });
  });

  it('completion: fills defaults for missing optional context fields', async () => {
    await startServer();
    const client = await connect();
    await client.request(
      completionReq('d', { languageId: '', fileName: undefined, filePath: undefined }),
    );
    const ctx = completionPool().getCompletion.mock.calls[0][0] as CompletionContext;
    expect(ctx).toMatchObject({ languageId: 'plaintext', fileName: '', filePath: '' });
  });

  it('completion: reports unavailable pool without calling the CLI', async () => {
    await startServer();
    completionPool().available = false;
    const client = await connect();
    const res = await client.request(completionReq('u'));
    expect(res).toEqual({
      type: 'completion',
      id: 'u',
      success: false,
      text: null,
      error: 'Completion pool not available',
    });
    expect(completionPool().getCompletion).not.toHaveBeenCalled();
  });

  it('completion: surfaces provider errors as a failed response', async () => {
    await startServer();
    completionPool().getCompletion.mockRejectedValueOnce(new Error('slot crashed'));
    const client = await connect();
    const res = await client.request(completionReq('e'));
    expect(res).toMatchObject({ success: false, text: null, error: 'slot crashed' });
  });

  it('completion: a slow request does not block a later fast one on the same socket', async () => {
    await startServer();
    let release!: () => void;
    completionPool().getCompletion.mockImplementationOnce(
      () => new Promise<string>((r) => (release = () => r('slow'))),
    );
    const client = await connect();
    client.socket.write(
      serializeMessage(completionReq('slow') as never) +
        serializeMessage({ type: 'status', id: 'fast' }),
    );
    await client.waitFor((m) => m.id === 'fast');
    expect(client.messages.map((m) => m.id)).toEqual(['fast']);
    release();
    const slow = await client.waitFor((m) => m.id === 'slow');
    expect(slow.text).toBe('slow');
  });

  it('command: forwards timeout and returns only whitelisted metadata', async () => {
    await startServer();
    commandPool().sendPrompt.mockResolvedValueOnce({
      text: 'feat: add thing',
      meta: {
        model: 'claude-sonnet',
        durationMs: 900,
        durationApiMs: 800,
        costUsd: 0.002,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 0,
        sessionId: 'sess',
        internalOnly: 'should not leak',
      },
    });
    const client = await connect();
    const res = await client.request({
      type: 'command',
      id: 'cm',
      message: 'diff',
      timeoutMs: 1234,
    });
    expect(commandPool().sendPrompt).toHaveBeenCalledWith('diff', { timeoutMs: 1234 });
    expect(res.text).toBe('feat: add thing');
    expect(res.meta).toEqual({
      model: 'claude-sonnet',
      durationMs: 900,
      durationApiMs: 800,
      costUsd: 0.002,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 0,
      sessionId: 'sess',
    });
  });

  it('command: omits meta when the pool returned none', async () => {
    await startServer();
    const client = await connect();
    const res = await client.request({ type: 'command', id: 'nm', message: 'x' });
    expect(res).toEqual({ type: 'command', id: 'nm', success: true, text: 'reply:x' });
  });

  it('command: reports unavailable pool and surfaces thrown errors', async () => {
    await startServer();
    const client = await connect();

    commandPool().sendPrompt.mockRejectedValueOnce('string failure');
    const thrown = await client.request({ type: 'command', id: 't', message: 'x' });
    expect(thrown).toMatchObject({ success: false, text: null, error: 'string failure' });

    commandPool().available = false;
    const unavailable = await client.request({ type: 'command', id: 'n', message: 'x' });
    expect(unavailable.error).toBe('Command pool not available');
  });

  it('status: reports pool availability, stats, model, and live client count', async () => {
    await startServer({ claudeCode: { model: 'opus', models: ['opus'] } });
    commandPool().available = false;
    const a = await connect();
    const b = await connect();
    const res = await a.request({ type: 'status', id: 's1' });
    expect(res).toMatchObject({
      success: true,
      completionPoolAvailable: true,
      commandPoolAvailable: false,
      connectedClients: 2,
      model: 'opus',
      completionPool: { label: 'completion', totalRequests: 3 },
      commandPool: { label: 'command' },
    });

    b.socket.destroy();
    await b.closed;
    // Server notices the disconnect asynchronously
    await vi.waitFor(async () => {
      const r = await a.request({ type: 'status', id: `s-${Math.random()}` });
      expect(r.connectedClients).toBe(1);
    });
  });

  it('warmup: acknowledges without touching the pools', async () => {
    await startServer();
    const client = await connect();
    const res = await client.request({ type: 'warmup', id: 'w', pool: 'completion' });
    expect(res).toEqual({ type: 'warmup', id: 'w', success: true });
  });

  it.each([
    ['completion', true, false],
    ['command', false, true],
    ['all', true, true],
  ] as const)(
    'recycle %s: recycles only the targeted pool(s)',
    async (pool, hitsCompl, hitsCmd) => {
      await startServer();
      const client = await connect();
      const res = await client.request({ type: 'recycle', id: 'r', pool });
      expect(res).toEqual({ type: 'recycle', id: 'r', success: true });
      expect(completionPool().recycleAll).toHaveBeenCalledTimes(hitsCompl ? 1 : 0);
      expect(commandPool().recycleAll).toHaveBeenCalledTimes(hitsCmd ? 1 : 0);
    },
  );

  it('recycle: restarts a degraded pool instead of recycling it', async () => {
    // recycleAll() early-returns on unavailable pools, so a degraded pool must restart.
    await startServer();
    completionPool().available = false;
    commandPool().available = false;
    const client = await connect();
    await client.request({ type: 'recycle', id: 'r', pool: 'all' });
    expect(completionPool().restart).toHaveBeenCalledTimes(1);
    expect(commandPool().restart).toHaveBeenCalledTimes(1);
    expect(completionPool().recycleAll).not.toHaveBeenCalled();
  });

  it('recycle: returns success:false with the error message on failure', async () => {
    await startServer();
    commandPool().recycleAll.mockRejectedValueOnce(new Error('kill failed'));
    const client = await connect();
    const res = await client.request({ type: 'recycle', id: 'r', pool: 'command' });
    expect(res).toEqual({ type: 'recycle', id: 'r', success: false, error: 'kill failed' });
  });
});

describe('PoolServer — config-update', () => {
  it('is a no-op when neither model nor instructions changed', async () => {
    await startServer({ customInstructions: 'be terse' });
    const client = await connect();
    const res = await client.request({
      type: 'config-update',
      id: 'n',
      model: makeConfig().claudeCode.model,
      customInstructions: 'be terse',
    });
    expect(res.success).toBe(true);
    expect(completionPool().recycleAll).not.toHaveBeenCalled();
    expect(commandPool().updateModel).not.toHaveBeenCalled();
  });

  it('model change: updates both pools and later hellos report the new model', async () => {
    await startServer({ claudeCode: { model: 'haiku', models: [] } });
    const client = await connect();
    const res = await client.request({ type: 'config-update', id: 'm', model: 'sonnet' });
    expect(res).toEqual({ type: 'config-update', id: 'm', success: true });
    expect(commandPool().model).toBe('sonnet');
    expect(completionPool().config.claudeCode.model).toBe('sonnet');
    expect(completionPool().recycleAll).toHaveBeenCalledTimes(1);

    const hello = await client.request({ type: 'client-hello', id: 'h', clientId: 'w2' });
    expect(hello.model).toBe('sonnet');
  });

  it('clearing instructions with an empty string counts as a change', async () => {
    await startServer({ customInstructions: 'use British spelling' });
    const client = await connect();
    await client.request({ type: 'config-update', id: 'c', customInstructions: '' });
    expect(completionPool().config.customInstructions).toBe('');
    expect(completionPool().recycleAll).toHaveBeenCalledTimes(1);
    // Instructions are completion-only; command pool untouched
    expect(commandPool().updateModel).not.toHaveBeenCalled();
  });

  it('restarts a degraded completion pool rather than recycling it', async () => {
    await startServer();
    completionPool().available = false;
    const client = await connect();
    await client.request({ type: 'config-update', id: 'd', customInstructions: 'new' });
    expect(completionPool().restart).toHaveBeenCalledTimes(1);
    expect(completionPool().recycleAll).not.toHaveBeenCalled();
  });

  it('returns success:false when the recycle throws', async () => {
    await startServer();
    completionPool().recycleAll.mockRejectedValueOnce(new Error('boom'));
    const client = await connect();
    const res = await client.request({ type: 'config-update', id: 'f', model: 'opus' });
    expect(res).toEqual({ type: 'config-update', id: 'f', success: false, error: 'boom' });
  });
});

describe('PoolServer — server-pushed events', () => {
  it('broadcasts pool-degraded to every client and notifies the host callback', async () => {
    await startServer();
    const a = await connect();
    const b = await connect();
    // Make sure the server has registered both sockets before broadcasting.
    await Promise.all([
      a.request({ type: 'client-hello', id: 'ha', clientId: 'a' }),
      b.request({ type: 'client-hello', id: 'hb', clientId: 'b' }),
    ]);

    commandPool().onPoolDegraded!('warmup failed after retry');
    completionPool().onPoolDegraded!('circuit breaker');

    for (const c of [a, b]) {
      await c.waitFor((m) => m.type === 'pool-degraded' && m.pool === 'completion');
      const cmd = await c.waitFor((m) => m.type === 'pool-degraded' && m.pool === 'command');
      expect(cmd).toEqual({
        type: 'pool-degraded',
        pool: 'command',
        reason: 'warmup failed after retry',
      });
    }
    expect(degradedCallback).toHaveBeenCalledWith('command', 'warmup failed after retry');
    expect(degradedCallback).toHaveBeenCalledWith('completion', 'circuit breaker');
  });

  it('dispose request: acks, then pushes server-shutting-down to all clients, then closes', async () => {
    const s = await startServer();
    const a = await connect();
    const b = await connect();
    await b.request({ type: 'client-hello', id: 'hb', clientId: 'b' });

    const res = await a.request({ type: 'dispose', id: 'bye' });
    expect(res).toEqual({ type: 'dispose', id: 'bye', success: true });

    await Promise.all([a.closed, b.closed]);
    expect(a.messages.map((m) => m.type)).toEqual(['dispose', 'server-shutting-down']);
    expect(b.messages.map((m) => m.type)).toEqual(['client-hello', 'server-shutting-down']);
    expect(fs.existsSync(ipcState.sock)).toBe(false);
    expect(completionPool().dispose).toHaveBeenCalledTimes(1);
    s.dispose(); // idempotent
    server = null;
  });
});

describe('PoolServer — local fast path', () => {
  it('exposes pool operations directly without IPC', async () => {
    const s = await startServer({ claudeCode: { model: 'haiku', models: [] } });
    expect(s.getModel()).toBe('haiku');
    expect(s.isCompletionPoolAvailable()).toBe(true);
    commandPool().available = false;
    expect(s.isCommandPoolAvailable()).toBe(false);

    const text = await s.getCompletion(
      {
        prefix: 'a',
        suffix: 'b',
        mode: 'prose',
        languageId: 'markdown',
        fileName: 'x',
        filePath: 'x',
      },
      new AbortController().signal,
    );
    expect(text).toBe('<<a|b>>');
    expect((await s.sendCommand('hi')).text).toBe('reply:hi');
    expect(s.getCompletionPoolStats().label).toBe('completion');
    expect(s.getCommandPoolStats().label).toBe('command');

    await s.restartPools();
    expect(completionPool().restart).toHaveBeenCalledTimes(1);
    expect(commandPool().restart).toHaveBeenCalledTimes(1);
  });
});

describe('lockfile', () => {
  const DEAD_PID = 2_000_000; // above macOS/Linux pid_max defaults

  it('acquires a fresh lock and records pid + timestamp', () => {
    const before = Date.now();
    expect(acquireLock(process.pid)).toBe(true);
    const info = readLockfile();
    expect(info?.pid).toBe(process.pid);
    expect(info!.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('refuses when a live process already holds the lock', () => {
    expect(acquireLock(process.pid)).toBe(true);
    expect(acquireLock(process.pid + 1)).toBe(false);
    expect(readLockfile()?.pid).toBe(process.pid);
  });

  it('takes over a lock whose holder is dead', () => {
    fs.writeFileSync(ipc.LOCK_PATH, JSON.stringify({ pid: DEAD_PID, timestamp: 0 }));
    expect(acquireLock(process.pid)).toBe(true);
    expect(readLockfile()?.pid).toBe(process.pid);
  });

  // A truncated/garbage lockfile (e.g. crash mid-write) is reclaimed once it is
  // older than a short grace period, so it can't block acquisition forever.
  it('replaces a corrupt lockfile once it is past the grace period', () => {
    fs.writeFileSync(ipc.LOCK_PATH, '{garbage');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(ipc.LOCK_PATH, old, old);
    expect(readLockfile()).toBeNull();
    expect(acquireLock(process.pid)).toBe(true);
    expect(readLockfile()?.pid).toBe(process.pid);
  });

  // A fresh unparseable lockfile may belong to a writer that is mid-write — leave it.
  it('does not reclaim a corrupt lockfile that was just written', () => {
    fs.writeFileSync(ipc.LOCK_PATH, '{garbage');
    expect(acquireLock(process.pid)).toBe(false);
    expect(fs.readFileSync(ipc.LOCK_PATH, 'utf-8')).toBe('{garbage');
  });

  it('readLockfile returns null when there is no lock', () => {
    expect(readLockfile()).toBeNull();
  });

  it('isProcessAlive distinguishes live and dead pids', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});
