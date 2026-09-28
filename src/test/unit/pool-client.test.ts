/**
 * PoolClient leader election and IPC tests.
 *
 * These run real Unix-socket traffic between PoolClient instances in one process.
 * `os.homedir()` is redirected to a temp dir so the real ipc-path module resolves
 * STATE_DIR / pool.sock / pool.lock there instead of ~/.bespokeai. The Claude CLI
 * providers (ClaudeCodeProvider, CommandPool) are replaced with in-memory fakes
 * that echo which server instance handled the request, so a response proves
 * which leader actually served it.
 */
import * as fs from 'fs';
import * as net from 'net';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const { fakeHome, registry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os');
  return {
    fakeHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'bpc-')),
    registry: {
      completion: [] as FakeCompletionProviderShape[],
      command: [] as FakeCommandPoolShape[],
    },
  };
});

interface FakeCompletionProviderShape {
  config: { claudeCode: { model: string }; customInstructions: string };
  available: boolean;
  disposed: boolean;
  recycles: number;
  restarts: number;
  configUpdates: number;
}

interface FakeCommandPoolShape {
  model: string;
  available: boolean;
  disposed: boolean;
  recycles: number;
  restarts: number;
  modelUpdates: string[];
}

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

function fakeStats(label: string, available: boolean) {
  return {
    label,
    available,
    slots: [],
    activatedAt: null,
    uptimeMs: null,
    totalRequests: 0,
    totalRecycles: 0,
    lastRequestAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
  };
}

vi.mock('../../providers/claude-code', () => ({
  ClaudeCodeProvider: class {
    available = true;
    disposed = false;
    recycles = 0;
    restarts = 0;
    configUpdates = 0;
    lastUsedModel: string | undefined;
    onPoolDegraded?: (reason: string) => void;
    constructor(public config: FakeCompletionProviderShape['config']) {
      registry.completion.push(this);
    }
    setLedger() {}
    async activate() {}
    isAvailable() {
      return this.available && !this.disposed;
    }
    async getCompletion(ctx: { prefix: string }) {
      if (ctx.prefix === 'THROW') throw new Error('boom');
      // Identify the serving instance: model + index in registry
      return `${this.config.claudeCode.model}#${registry.completion.indexOf(this)}:${ctx.prefix}`;
    }
    getStats() {
      return fakeStats('completion', this.isAvailable());
    }
    updateConfig(config: FakeCompletionProviderShape['config']) {
      this.config = config;
      this.configUpdates++;
    }
    async recycleAll() {
      this.recycles++;
    }
    async restart() {
      this.restarts++;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));

vi.mock('../../providers/command-pool', () => ({
  CommandPool: class {
    available = true;
    disposed = false;
    recycles = 0;
    restarts = 0;
    modelUpdates: string[] = [];
    onPoolDegraded?: (reason: string) => void;
    constructor(public model: string) {
      registry.command.push(this);
    }
    setLedger() {}
    async activate() {}
    isAvailable() {
      return this.available && !this.disposed;
    }
    async sendPrompt(message: string) {
      if (message === 'NO_META') return { text: `cmd:${message}`, meta: null };
      return {
        text: `cmd:${this.model}:${message}`,
        meta: {
          model: this.model,
          durationMs: 12,
          durationApiMs: 10,
          costUsd: 0.001,
          inputTokens: 100,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          sessionId: 'sess-1',
        },
      };
    }
    getStats() {
      return fakeStats('command', this.isAvailable());
    }
    updateModel(model: string) {
      this.model = model;
      this.modelUpdates.push(model);
    }
    async recycleAll() {
      this.recycles++;
    }
    async restart() {
      this.restarts++;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));

import { PoolClient, PoolRole } from '../../pool-server/client';
import { acquireLock } from '../../pool-server/server';
import { STATE_DIR, LOCK_PATH, getIpcPath } from '../../pool-server/ipc-path';
import { UsageLedger } from '../../utils/usage-ledger';
import { Logger } from '../../utils/logger';
import { makeConfig, makeLogger, makeProseContext } from '../helpers';
import type { ExtensionConfig } from '../../types';

const IS_WINDOWS = process.platform === 'win32';
const SOCK_PATH = getIpcPath();

interface Harness {
  client: PoolClient;
  roles: PoolRole[];
  degraded: Array<{ pool: string; reason: string }>;
  errors: string[];
}

const live: PoolClient[] = [];
const rawServers: net.Server[] = [];

function makeClient(id: string, config: ExtensionConfig = makeConfig()): Harness {
  const roles: PoolRole[] = [];
  const degraded: Array<{ pool: string; reason: string }> = [];
  const errors: string[] = [];
  const logger = { ...makeLogger(), error: (m: string) => errors.push(m) } as unknown as Logger;
  const client = new PoolClient({
    config,
    logger,
    ledger: {} as UsageLedger,
    clientId: id,
    onRoleChange: (r) => roles.push(r),
    onPoolDegraded: (pool, reason) => degraded.push({ pool, reason }),
  });
  live.push(client);
  return { client, roles, degraded, errors };
}

const signal = () => new AbortController().signal;

/** Stand up a bare socket server at the pool path with a custom responder. */
async function startRawServer(
  onLine: (socket: net.Socket, msg: Record<string, unknown>) => void,
): Promise<{ server: net.Server; sockets: net.Socket[] }> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(socket, JSON.parse(line));
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(SOCK_PATH, resolve));
  rawServers.push(server);
  return { server, sockets };
}

beforeEach(() => {
  registry.completion.length = 0;
  registry.command.length = 0;
});

afterEach(async () => {
  for (const c of live.splice(0)) c.dispose();
  for (const s of rawServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe.skipIf(IS_WINDOWS)('PoolClient', () => {
  it('redirects the state dir into the temp home (sanity check for isolation)', () => {
    expect(STATE_DIR.startsWith(fakeHome)).toBe(true);
    expect(SOCK_PATH.startsWith(fakeHome)).toBe(true);
  });

  describe('leader election', () => {
    it('first client becomes server, writes lockfile with its pid, and binds the socket', async () => {
      const a = makeClient('A');
      await a.client.activate();

      expect(a.client.getRole()).toBe('server');
      expect(a.roles).toEqual(['server']);
      expect(JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8')).pid).toBe(process.pid);
      expect(fs.existsSync(SOCK_PATH)).toBe(true);
      expect(registry.completion).toHaveLength(1);
    });

    it('second client connects as follower instead of starting another server', async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      const b = makeClient('B', makeConfig({ claudeCode: { model: 'haiku', models: [] } }));
      await a.client.activate();
      await b.client.activate();

      expect(b.client.getRole()).toBe('client');
      expect(b.roles).toEqual(['client']);
      expect(registry.completion).toHaveLength(1); // no second provider spawned
      expect(b.client.isAvailable()).toBe(true);
      expect(b.client.isCommandPoolAvailable()).toBe(true);
      // Follower reports the leader's model from client-hello, not its own setting
      expect(b.client.getCurrentModel()).toBe('opus');
      expect(a.client.getCurrentModel()).toBe('opus');
    });

    it('activate() is a no-op while an activation is already in flight', async () => {
      const a = makeClient('A');
      await Promise.all([a.client.activate(), a.client.activate()]);
      expect(a.roles).toEqual(['server']);
      expect(registry.completion).toHaveLength(1);
    });
  });

  describe('request routing', () => {
    it('follower completions travel over the socket and are served by the leader', async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      const b = makeClient('B', makeConfig({ claudeCode: { model: 'haiku', models: [] } }));
      await a.client.activate();
      await b.client.activate();

      const ctx = makeProseContext({ prefix: 'hello' });
      expect(await b.client.getCompletion(ctx, signal())).toBe('opus#0:hello');
      // Leader uses the local fast path and hits the same provider
      expect(await a.client.getCompletion(ctx, signal())).toBe('opus#0:hello');
    });

    it('concurrent follower requests are matched to their own responses', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      const prefixes = Array.from({ length: 20 }, (_, i) => `p${i}`);
      const results = await Promise.all(
        prefixes.map((p) => b.client.getCompletion(makeProseContext({ prefix: p }), signal())),
      );
      expect(results.map((r) => r!.split(':').pop())).toEqual(prefixes);
    });

    it('commands return text and fully-populated metadata on both paths', async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      for (const c of [a.client, b.client]) {
        const res = await c.sendCommand('commit msg', { timeoutMs: 5000 });
        expect(res.text).toBe('cmd:opus:commit msg');
        expect(res.meta).toMatchObject({ model: 'opus', durationMs: 12, sessionId: 'sess-1' });
      }
      expect((await b.client.sendCommand('NO_META')).meta).toBeNull();
    });

    it('follower returns null and logs when the leader reports the completion pool unavailable', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();
      registry.completion[0].available = false;
      registry.command[0].available = false;

      expect(await b.client.getCompletion(makeProseContext(), signal())).toBeNull();
      expect(b.errors.some((e) => e.includes('Completion pool not available'))).toBe(true);
      expect((await b.client.sendCommand('x')).text).toBeNull();
      expect(b.errors.some((e) => e.includes('Command pool not available'))).toBe(true);
      // Leader's availability reflects the provider directly
      expect(a.client.isAvailable()).toBe(false);
      expect(a.client.isCommandPoolAvailable()).toBe(false);
    });

    it('provider exceptions surface as null, not a thrown error, on both paths', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();
      const ctx = makeProseContext({ prefix: 'THROW' });

      expect(await a.client.getCompletion(ctx, signal())).toBeNull();
      expect(await b.client.getCompletion(ctx, signal())).toBeNull();
      expect(b.errors.some((e) => e.includes('boom'))).toBe(true);
    });

    it('getPoolStatus reports each client its own role but the shared server model', async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      const sa = await a.client.getPoolStatus();
      const sb = await b.client.getPoolStatus();
      expect(sa).toMatchObject({ role: 'server', model: 'opus' });
      expect(sb).toMatchObject({ role: 'client', model: 'opus' });
      expect(sb!.completionPool!.label).toBe('completion');
      expect(sb!.commandPool!.label).toBe('command');
    });

    it('recycleAll / restart from a follower recycle both pools on the leader', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      await b.client.restart(); // follower restart → recycle request
      expect(registry.completion[0].recycles).toBe(1);
      expect(registry.command[0].recycles).toBe(1);

      await a.client.recycleAll(); // leader local path
      expect(registry.completion[0].recycles).toBe(2);

      await a.client.restart(); // leader restart → restartPools
      expect(registry.completion[0].restarts).toBe(1);
      expect(registry.command[0].restarts).toBe(1);
    });
  });

  describe('config propagation', () => {
    it("follower model change reaches the leader's pools", async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'sonnet', models: [] } }));
      const b = makeClient('B', makeConfig({ claudeCode: { model: 'sonnet', models: [] } }));
      await a.client.activate();
      await b.client.activate();

      b.client.updateConfig(makeConfig({ claudeCode: { model: 'opus', models: [] } }));

      await vi.waitFor(() => expect(registry.command[0].modelUpdates).toEqual(['opus']));
      await vi.waitFor(() => expect(registry.completion[0].recycles).toBe(1));
      expect(await b.client.getCompletion(makeProseContext({ prefix: 'x' }), signal())).toBe(
        'opus#0:x',
      );
    });

    it('custom-instructions-only change recycles completions but leaves the command pool alone', async () => {
      const a = makeClient('A');
      await a.client.activate();

      a.client.updateConfig(makeConfig({ customInstructions: 'be terse' }));

      await vi.waitFor(() => expect(registry.completion[0].recycles).toBe(1));
      expect(registry.completion[0].config.customInstructions).toBe('be terse');
      expect(registry.command[0].modelUpdates).toEqual([]);
    });

    it('does not contact the server for unrelated changes or in API mode', async () => {
      const a = makeClient('A');
      await a.client.activate();

      a.client.updateConfig(makeConfig({ debounceMs: 42 }));
      a.client.updateConfig(
        makeConfig({ backend: 'api', claudeCode: { model: 'opus', models: [] } }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(registry.completion[0].configUpdates).toBe(0);
      expect(registry.command[0].modelUpdates).toEqual([]);
      expect(a.errors).toEqual([]);
    });

    it('an unconnected client logs (not throws) when a config update cannot be sent', async () => {
      const a = makeClient('A');
      // never activated: role 'client', no socket
      a.client.updateConfig(makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      await vi.waitFor(() =>
        expect(a.errors.some((e) => e.includes('config update failed'))).toBe(true),
      );
      expect(a.client.isAvailable()).toBe(false);
      expect(a.client.isCommandPoolAvailable()).toBe(false);

      // Every public request method honors the null-on-error contract
      expect(await a.client.getCompletion(makeProseContext(), signal())).toBeNull();
      expect(await a.client.sendCommand('x')).toEqual({ text: null, meta: null });
      expect(await a.client.getPoolStatus()).toBeNull();
      await expect(a.client.recycleAll()).resolves.toBeUndefined();
      await expect(a.client.restart()).resolves.toBeUndefined();
      expect(a.errors.some((e) => e.includes('command error'))).toBe(true);
      expect(a.errors.some((e) => e.includes('recycle failed'))).toBe(true);
    });
  });

  describe('server events', () => {
    it('forwards pool-degraded broadcasts from the leader to follower callbacks', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      const provider = registry.completion[0] as unknown as { onPoolDegraded: (r: string) => void };
      provider.onPoolDegraded('credit balance too low');

      await vi.waitFor(() =>
        expect(b.degraded).toEqual([{ pool: 'completion', reason: 'credit balance too low' }]),
      );
      expect(a.degraded).toEqual([{ pool: 'completion', reason: 'credit balance too low' }]);
    });

    it('handles messages split across TCP chunks and ignores garbage lines', async () => {
      await startRawServer((socket, msg) => {
        if (msg.type === 'client-hello') {
          socket.write(
            JSON.stringify({
              type: 'client-hello',
              id: msg.id,
              success: true,
              serverId: 'raw',
              model: 'raw-model',
            }) + '\n',
          );
        } else if (msg.type === 'completion') {
          const payload = JSON.stringify({
            type: 'completion',
            id: msg.id,
            success: true,
            text: 'split-ok',
          });
          // garbage line, an event without id, then the response split in two writes
          socket.write('not json\n' + JSON.stringify({ type: 'pool-degraded', pool: 'command' }));
          socket.write('\n' + payload.slice(0, 10));
          setTimeout(() => socket.write(payload.slice(10) + '\n'), 5);
        }
      });
      const b = makeClient('B');
      await b.client.activate();
      expect(b.client.getRole()).toBe('client');
      expect(b.client.getCurrentModel()).toBe('raw-model');

      expect(await b.client.getCompletion(makeProseContext(), signal())).toBe('split-ok');
      expect(b.errors.some((e) => e.includes('failed to parse message'))).toBe(true);
      expect(b.degraded).toEqual([{ pool: 'command', reason: 'unknown' }]);
    });

    it('rejects in-flight follower requests when the server connection drops', async () => {
      const { sockets } = await startRawServer((socket, msg) => {
        if (msg.type === 'client-hello') {
          socket.write(
            JSON.stringify({
              type: 'client-hello',
              id: msg.id,
              success: true,
              serverId: 'raw',
              model: 'm',
            }) + '\n',
          );
        }
        // completion requests are never answered
      });
      const b = makeClient('B');
      await b.client.activate();

      const pending = b.client.getCompletion(makeProseContext(), signal());
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0].destroy();

      expect(await pending).toBeNull();
      expect(b.errors.some((e) => e.includes('Server disconnected'))).toBe(true);
      expect(b.client.isAvailable()).toBe(false);

      // The server is still up, so the back-off path reconnects instead of taking over.
      // (Wait for it to settle — disposing mid-back-off leaks a server; see bug test below.)
      await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2000 });
      await vi.waitFor(() => expect(b.client.isAvailable()).toBe(true));
      expect(b.client.getRole()).toBe('client');
    });
  });

  describe('takeover', () => {
    it('follower becomes the new server after the leader disposes', async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      const b = makeClient('B', makeConfig({ claudeCode: { model: 'haiku', models: [] } }));
      await a.client.activate();
      await b.client.activate();

      a.client.dispose();
      expect(registry.completion[0].disposed).toBe(true);

      await vi.waitFor(() => expect(b.client.getRole()).toBe('server'), { timeout: 3000 });
      expect(b.roles).toEqual(['client', 'server']);
      expect(JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8')).pid).toBe(process.pid);
      // New server spun up its own providers with the follower's config
      expect(registry.completion).toHaveLength(2);
      expect(await b.client.getCompletion(makeProseContext({ prefix: 'z' }), signal())).toBe(
        'haiku#1:z',
      );
      expect((await b.client.getPoolStatus())!.model).toBe('haiku');
    });

    it('with two followers, exactly one takes over and the other reconnects to it', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      const c = makeClient('C');
      await a.client.activate();
      await b.client.activate();
      await c.client.activate();

      a.client.dispose();

      await vi.waitFor(
        () => {
          const roles = [b.client.getRole(), c.client.getRole()].sort();
          expect(roles).toEqual(['client', 'server']);
          const follower = b.client.getRole() === 'client' ? b.client : c.client;
          expect(follower.isAvailable()).toBe(true);
        },
        { timeout: 4000, interval: 25 },
      );
      expect(registry.completion).toHaveLength(2);

      const follower = b.client.getRole() === 'client' ? b : c;
      expect(await follower.client.getCompletion(makeProseContext({ prefix: 'q' }), signal())).toBe(
        'sonnet#1:q',
      );
    });

    // Regression: `disposed` used to be checked only before the back-off delay, so a
    // client disposed during the delay still started a PoolServer nothing would dispose.
    it('dispose during takeover back-off cancels the takeover', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      a.client.dispose();
      await new Promise((r) => setTimeout(r, 50)); // B is now inside the 500ms back-off
      b.client.dispose();
      await new Promise((r) => setTimeout(r, 700));
      try {
        expect(b.client.getRole()).toBe('client');
        expect(fs.existsSync(LOCK_PATH)).toBe(false);
      } finally {
        // Reach the orphaned server so it doesn't leak into later tests
        (b.client as unknown as { server: { dispose(): void } | null }).server?.dispose();
      }
    });

    // Regression: serverModel (cached from the client-hello) used to survive takeover,
    // so the new leader kept reporting the old leader's model.
    it('getCurrentModel reflects the new server after takeover', async () => {
      const a = makeClient('A', makeConfig({ claudeCode: { model: 'opus', models: [] } }));
      const b = makeClient('B', makeConfig({ claudeCode: { model: 'haiku', models: [] } }));
      await a.client.activate();
      await b.client.activate();
      a.client.dispose();
      await vi.waitFor(() => expect(b.client.getRole()).toBe('server'), { timeout: 3000 });

      expect(b.client.getCurrentModel()).toBe('haiku');
    });

    it('a disposed follower does not attempt takeover', async () => {
      const a = makeClient('A');
      const b = makeClient('B');
      await a.client.activate();
      await b.client.activate();

      b.client.dispose();
      a.client.dispose();
      await new Promise((r) => setTimeout(r, 700));

      expect(b.client.getRole()).toBe('client');
      expect(registry.completion).toHaveLength(1);
      expect(fs.existsSync(LOCK_PATH)).toBe(false);
      expect(await b.client.getCompletion(makeProseContext(), signal())).toBeNull();
      expect(await b.client.sendCommand('x')).toEqual({ text: null, meta: null });
      expect(await b.client.getPoolStatus()).toBeNull();
      expect(b.client.isAvailable()).toBe(false);
      expect(b.client.isCommandPoolAvailable()).toBe(false);
    });

    it('can re-activate after dispose (disable/enable cycle)', async () => {
      const a = makeClient('A');
      await a.client.activate();
      a.client.dispose();
      expect(fs.existsSync(LOCK_PATH)).toBe(false);
      expect(fs.existsSync(SOCK_PATH)).toBe(false);

      await a.client.activate();
      expect(a.client.getRole()).toBe('server');
      expect(await a.client.getCompletion(makeProseContext({ prefix: 'r' }), signal())).toBe(
        'sonnet#1:r',
      );
    });
  });

  describe('stale state', () => {
    it('reclaims a lockfile left by a dead process and removes a leftover socket file', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      // PID far above any realistic pid_max → process.kill(pid, 0) throws ESRCH
      fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: 2 ** 30, timestamp: 0 }));
      fs.writeFileSync(SOCK_PATH, ''); // stale regular file where the socket should be

      const a = makeClient('A');
      await a.client.activate();

      expect(a.client.getRole()).toBe('server');
      expect(JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8')).pid).toBe(process.pid);
      expect(fs.statSync(SOCK_PATH).isSocket()).toBe(true);
    });

    it('reclaims a corrupt lockfile left behind by a crash', () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LOCK_PATH, '{not json');
      const old = new Date(Date.now() - 5000);
      fs.utimesSync(LOCK_PATH, old, old);

      expect(acquireLock(process.pid)).toBe(true);
    });

    it('rejects a server that answers client-hello with failure, then falls back to leadership', async () => {
      await startRawServer((socket, msg) => {
        socket.write(
          JSON.stringify({ type: 'error', id: msg.id, success: false, error: 'nope' }) + '\n',
        );
      });
      const b = makeClient('B');
      await b.client.activate();
      // No valid server → it acquires the lock, unlinks the (live) socket path, and
      // binds its own server there.
      expect(b.client.getRole()).toBe('server');
      expect(JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8')).pid).toBe(process.pid);
      // Let the takeover back-off (started by the rejected hello socket closing) settle
      // before teardown, so it can't resurrect a server after dispose.
      await new Promise((r) => setTimeout(r, 600));
      expect(b.client.getRole()).toBe('server');
      expect(await b.client.getCompletion(makeProseContext({ prefix: 'h' }), signal())).toBe(
        'sonnet#0:h',
      );
    });

    it('waits for a live lock holder, then forces leadership when no server ever appears', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      // Parent process is alive and owned by us, so the lock looks legitimately held
      fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.ppid, timestamp: 0 }));

      const a = makeClient('A');
      const start = Date.now();
      await a.client.activate();

      expect(Date.now() - start).toBeGreaterThanOrEqual(1400); // 3 × 500ms retries
      expect(a.client.getRole()).toBe('server');
      expect(a.errors).toContain('Pool: failed to connect after retries, forcing lock acquisition');
      // Forced leadership does not take the lock — it still names the other pid
      expect(JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8')).pid).toBe(process.ppid);
    }, 5000);

    it('connects on retry when the lock holder starts listening late', async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.ppid, timestamp: 0 }));

      const leader = makeClient('A');
      const b = makeClient('B');
      const activating = b.client.activate();
      // After B's first connect attempt fails, bring up a real leader. It can't
      // take the (ppid-held) lock either, so hand it over first.
      setTimeout(async () => {
        fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: 2 ** 30, timestamp: 0 }));
        await leader.client.activate();
        fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.ppid, timestamp: 0 }));
      }, 100);
      await activating;

      expect(leader.client.getRole()).toBe('server');
      expect(b.client.getRole()).toBe('client');
      expect(registry.completion).toHaveLength(1);
    });
  });
});
