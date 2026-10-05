/**
 * Local playground server: serves the Monaco page, runs completions through the
 * extension's API pipeline (complete.ts), and reports each run to the bench.
 *
 *   npm run playground          (keys from the environment, e.g. via credentials.py run)
 *
 * Env: PLAYGROUND_PORT (8791), BENCH_URL (http://127.0.0.1:8790),
 * PLAYGROUND_DAILY_CAP_USD (5). Binds 127.0.0.1 only.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getAllPresets, getPreset, isPresetAvailable } from '../src/providers/api/presets';
import { SCENARIOS, scenarioById, checkFlagsFor } from './scenarios';
import { complete, disposeProviders, type CompleteRequest } from './complete';
import { benchClient, APP_ID } from './bench';
import { hasPrice } from './prices';
import { SpendTally } from './spend';
import { handleLive, liveConfigFromEnv } from './live';
import { randomBytes } from 'crypto';

const PORT = Number(process.env.PLAYGROUND_PORT ?? 8791);
const BENCH_URL = (process.env.BENCH_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
const CAP_USD = Number(process.env.PLAYGROUND_DAILY_CAP_USD ?? 5);
const MAX_BODY = 512 * 1024;

const bench = benchClient(BENCH_URL);
const spend = new SpendTally(CAP_USD);

// Live mode for replay.html. Locally it is on by default, without Turnstile, with an
// in-memory rate limiter (this server binds 127.0.0.1 only); set LIVE_* env vars to
// exercise the production configuration.
const live = liveConfigFromEnv({
  LIVE_ENABLED: '1',
  LIVE_SESSION_SECRET: randomBytes(32).toString('hex'),
  LIVE_ALLOW_NO_TURNSTILE: '1',
  ...process.env,
});

/** Presets the playground offers: API presets with a key and a price (or local Ollama). */
function presetOffer(): Array<{
  id: string;
  name: string;
  model: string;
  usable: boolean;
  why?: string;
}> {
  return getAllPresets().map((p) => {
    const free = p.provider === 'ollama';
    const priced = free || hasPrice(p.modelId);
    const keyed = isPresetAvailable(p);
    const why = !keyed ? 'no API key' : !priced ? 'no price on file (spend cap)' : undefined;
    return { id: p.id, name: p.displayName, model: p.modelId, usable: keyed && priced, why };
  });
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'client/index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'client/app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'client/style.css', type: 'text/css; charset=utf-8' },
  '/replay.html': { file: 'client/replay.html', type: 'text/html; charset=utf-8' },
  '/replay-state.js': { file: 'client/replay-state.js', type: 'text/javascript; charset=utf-8' },
  '/replay.js': { file: 'client/replay.js', type: 'text/javascript; charset=utf-8' },
  '/topology.json': { file: 'topology.json', type: 'application/json; charset=utf-8' },
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

async function handleComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as Record<string, unknown>;
  const presetId = str(body.presetId);
  const offer = presetOffer().find((p) => p.id === presetId);
  if (!offer || !getPreset(presetId))
    return send(res, 400, { error: `unknown preset ${presetId}` });
  if (!offer.usable) return send(res, 400, { error: `${presetId}: ${offer.why}` });
  if (spend.overCap()) {
    return send(res, 429, { error: `daily spend cap reached ($${CAP_USD}); resets at midnight` });
  }

  const scenario = scenarioById.get(str(body.scenarioId));
  const request: CompleteRequest = {
    presetId,
    prefix: str(body.prefix),
    suffix: str(body.suffix),
    languageId: str(body.languageId, 'markdown'),
    fileName: str(body.fileName, 'untitled.md'),
    sessionId: str(body.sessionId) || 'playground',
    debounceMs: typeof body.debounceMs === 'number' ? Math.max(0, body.debounceMs) : 0,
    label: scenario ? scenario.id : str(body.fileName, 'untitled'),
    checkFlags: scenario ? checkFlagsFor(scenario) : undefined,
  };

  // A superseded keystroke closes the request; abort so it stops costing.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const { response, events } = await complete(request, ac.signal);
  if (response.costUsd) spend.add(response.costUsd);
  bench.send(events);
  if (!res.destroyed) send(res, 200, { ...response, spend: spend.status() });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  void (async () => {
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const { file, type } = STATIC[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(readFileSync(join(__dirname, file)));
        return;
      }
      // Recorded runs for replay.html (file names only, no paths).
      const rec = /^\/recordings\/([\w.-]+\.(?:json|jsonl))$/.exec(url.pathname);
      if (req.method === 'GET' && rec) {
        const type = rec[1].endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json';
        try {
          const body = readFileSync(join(__dirname, 'recordings', rec[1]));
          res.writeHead(200, {
            'content-type': `${type}; charset=utf-8`,
            'cache-control': 'no-store',
          });
          res.end(body);
        } catch {
          send(res, 404, { error: 'no such recording' });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/presets')
        return send(res, 200, presetOffer());
      if (req.method === 'GET' && url.pathname === '/api/scenarios') {
        return send(
          res,
          200,
          SCENARIOS.map((s) => ({
            id: s.id,
            description: s.description,
            mode: s.mode,
            languageId: s.languageId,
            fileName: s.fileName,
            prefix: s.prefix,
            suffix: s.suffix,
          })),
        );
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        return send(res, 200, { benchUrl: BENCH_URL, appId: APP_ID, spend: spend.status() });
      }
      if (url.pathname.startsWith('/api/live/')) {
        const ac = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) ac.abort();
        });
        const out = await handleLive(live, {
          method: req.method ?? 'GET',
          route: url.pathname.slice('/api/live/'.length),
          body: req.method === 'POST' ? await readJson(req) : undefined,
          ip: req.socket.remoteAddress ?? '',
          headers: { 'x-live-session': req.headers['x-live-session'] as string | undefined },
          signal: ac.signal,
        });
        if (!res.destroyed) send(res, out.status, out.body);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/complete')
        return await handleComplete(req, res);
      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[playground] request failed', err);
      if (!res.headersSent)
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[playground] http://127.0.0.1:${PORT}/  (bench: ${BENCH_URL}, cap $${CAP_USD}/day)`);
  const usable = presetOffer()
    .filter((p) => p.usable)
    .map((p) => p.id);
  console.log(
    `[playground] usable presets: ${usable.join(', ') || 'none — start with API keys in the env'}`,
  );
  void bench.register().then((ok) => {
    if (ok) {
      console.log(`[playground] registered with the bench: ${BENCH_URL}/?app=${APP_ID}`);
      console.log(
        `[playground] side by side: ${BENCH_URL}/shell/?app=http://127.0.0.1:${PORT}/&appid=${APP_ID}`,
      );
    }
  });
});

const shutdown = () => {
  disposeProviders();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
