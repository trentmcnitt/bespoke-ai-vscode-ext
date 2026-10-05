/**
 * Static export of the replay page: plain files, no server, no model calls, every
 * path relative, so it can be served from any subpath (trentmcnitt.com/agentlabs/…).
 *
 *   npm run playground:export [-- <out dir>]     (default dist/playground/)
 *
 * Entry: index.html (replay.html). Monaco loads from cdn.jsdelivr.net.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const root = __dirname;
const out = resolve(process.argv[2] ?? join(root, '..', 'dist', 'playground'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'recordings'), { recursive: true });
// No live API behind a static copy: empty the meta tag so the page doesn't probe for one.
const html = readFileSync(join(root, 'client', 'replay.html'), 'utf8');
const staticHtml = html.replace(/(<meta name="bespoke-live-api" content=")[^"]*(")/, '$1$2');
if (staticHtml === html) throw new Error('replay.html: bespoke-live-api meta tag not found');
writeFileSync(join(out, 'index.html'), staticHtml);
for (const f of ['replay.js', 'style.css']) cpSync(join(root, 'client', f), join(out, f));
cpSync(join(root, 'topology.json'), join(out, 'topology.json'));
const recordings = readdirSync(join(root, 'recordings')).filter(
  (f) => f === 'index.json' || f.endsWith('.recording.jsonl'),
);
for (const f of recordings) cpSync(join(root, 'recordings', f), join(out, 'recordings', f));
console.log(`wrote ${out}: index.html + ${recordings.length - 1} recordings`);
