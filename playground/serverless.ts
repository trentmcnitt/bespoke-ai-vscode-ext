/**
 * Vercel adapter for live mode: one function serving /api/live/{config,session,complete}.
 * Bundled to a single file by `npm run playground:build-api` (esbuild), so it carries the
 * extension's pipeline with it. Configuration is all env vars; see live.ts.
 *
 * Route: the deploy rewrites /…/api/live/:route to this function with ?route=:route
 * (or mounts it at api/live/[route].js, which Vercel passes as req.query.route).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { handleLive, liveConfigFromEnv } from './live';

const cfg = liveConfigFromEnv();

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
  try {
    const session = req.headers['x-live-session'];
    ({ status, body } = await handleLive(cfg, {
      method: req.method ?? 'GET',
      route,
      body: typeof req.body === 'string' ? JSON.parse(req.body) : req.body,
      ip: clientIp(req),
      headers: { 'x-live-session': Array.isArray(session) ? session[0] : session },
      signal: ac.signal,
    }));
  } catch (err) {
    // Error class only: never the request content.
    console.error('[live] failed:', err instanceof Error ? err.name : 'unknown');
  }
  if (res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
