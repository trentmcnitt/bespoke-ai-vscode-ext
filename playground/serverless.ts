/**
 * Vercel adapter for live mode: one function serving /api/live/{config,session,complete}.
 * Bundled to a single file by `npm run playground:build-api` (esbuild), so it carries the
 * extension's pipeline with it. Configuration is all env vars; see live.ts.
 *
 * Route: the deploy rewrites /…/api/live/:route to this function with ?route=:route
 * (or mounts it at api/live/[route].js, which Vercel passes as req.query.route).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { handleLive, liveConfigFromEnv, MemoryStore } from './live';
import { liveResponder, wantsStream } from './live-stream';

const cfg = liveConfigFromEnv();
// Once per cold start, to the function log (not the public config): which limiter store is in use.
// "memory" means the limits and the daily cap are per instance.
console.log(`[live] store: ${cfg.store instanceof MemoryStore ? 'memory' : 'upstash'}`);

type VercelRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[]>;
};

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || '';
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  const q = req.query?.route;
  const route =
    (Array.isArray(q) ? q[0] : q) ??
    new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ??
    '';
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  let status = 500;
  let body: Record<string, unknown> = { error: 'internal error' };
  let responder = liveResponder(res, false);
  try {
    const session = req.headers['x-live-session'];
    const reqBody: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    responder = liveResponder(res, wantsStream(route, reqBody));
    ({ status, body } = await handleLive(cfg, {
      method: req.method ?? 'GET',
      route,
      body: reqBody,
      ip: clientIp(req),
      headers: { 'x-live-session': Array.isArray(session) ? session[0] : session },
      signal: ac.signal,
      onEvents: responder.onEvents,
    }));
  } catch (err) {
    // Error class only: never the request content.
    console.error('[live] failed:', err instanceof Error ? err.name : 'unknown');
  }
  responder.finish(status, body);
}
