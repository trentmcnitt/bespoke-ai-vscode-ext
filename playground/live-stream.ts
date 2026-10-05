/**
 * The response framing for a live completion, shared by server.ts (local) and serverless.ts (Vercel).
 *
 * A page that asks for it (`"stream": true` in the request body) gets the run's bench events as they
 * happen, so its bench lights each step when it starts instead of the whole run at once after the
 * answer: NDJSON, one `{"events": [...]}` line the moment the request goes to the model, then one
 * `{"status": <http status>, "body": {...}}` line with the response (whose `events` hold the rest).
 * Until the first events line, nothing is written: a request refused before the model (a limit, a
 * bad session) still gets a plain JSON response with its real status.
 */
import type { ServerResponse } from 'http';
import type { BenchEvent } from './bench';

export const NDJSON = 'application/x-ndjson; charset=utf-8';

export function wantsStream(route: string, body: unknown): boolean {
  return (
    route === 'complete' &&
    !!body &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).stream === true
  );
}

export interface LiveResponder {
  /** Pass as LiveRequest.onEvents (undefined when the page didn't ask to stream). */
  onEvents?: (events: BenchEvent[]) => void;
  finish(status: number, body: Record<string, unknown>): void;
}

export function liveResponder(res: ServerResponse, stream: boolean): LiveResponder {
  let streaming = false;
  const onEvents = (events: BenchEvent[]) => {
    if (res.destroyed) return;
    if (!streaming) {
      streaming = true;
      res.writeHead(200, {
        'content-type': NDJSON,
        'cache-control': 'no-store',
        // Proxies must pass each line on as it's written.
        'x-accel-buffering': 'no',
      });
    }
    res.write(JSON.stringify({ events }) + '\n');
  };
  return {
    onEvents: stream ? onEvents : undefined,
    finish(status, body) {
      if (res.destroyed) return;
      if (streaming) {
        res.end(JSON.stringify({ status, body }) + '\n');
        return;
      }
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    },
  };
}
