/**
 * Static export of the replay page: plain files, no server, no model calls, every
 * path relative, so it can be served from any subpath (trentmcnitt.com/agentlabs/…).
 *
 *   npm run playground:export [-- <out dir>] [--live-api <path>]     (default dist/playground/)
 *
 * --live-api: where live mode's API answers, as the page will request it (e.g. /api/live/ when a
 * deploy serves serverless.ts there). Without it the copy is replay-only: the meta tag is emptied,
 * so the page never probes for a live backend.
 *
 * Entry: index.html (replay.html). Monaco loads from cdn.jsdelivr.net.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const root = __dirname;
const args = process.argv.slice(2);
const liveAt = args.indexOf('--live-api');
const liveApi = liveAt >= 0 ? (args.splice(liveAt, 2)[1] ?? '') : '';
if (liveAt >= 0 && !/^[\w./:-]+\/$/.test(liveApi)) {
  throw new Error(`--live-api needs a path ending in "/" (got "${liveApi}")`);
}
const out = resolve(args[0] ?? join(root, '..', 'dist', 'playground'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'recordings'), { recursive: true });
// No live API behind a plain static copy: empty the meta tag so the page doesn't probe for one.
const html = readFileSync(join(root, 'client', 'replay.html'), 'utf8');
const staticHtml = html.replace(
  /(<meta name="bespoke-live-api" content=")[^"]*(")/,
  (_m, a: string, b: string) => a + liveApi + b,
);
if (staticHtml === html) throw new Error('replay.html: bespoke-live-api meta tag not found');
writeFileSync(join(out, 'index.html'), staticHtml);
for (const f of ['replay.js', 'style.css']) cpSync(join(root, 'client', f), join(out, f));
cpSync(join(root, 'topology.json'), join(out, 'topology.json'));
const recordings = readdirSync(join(root, 'recordings')).filter(
  (f) => f === 'index.json' || f.endsWith('.recording.jsonl'),
);
for (const f of recordings) cpSync(join(root, 'recordings', f), join(out, 'recordings', f));
console.log(
  `wrote ${out}: index.html + ${recordings.length - 1} recordings` +
    (liveApi ? `; live mode at ${liveApi}` : '; replay only'),
);
