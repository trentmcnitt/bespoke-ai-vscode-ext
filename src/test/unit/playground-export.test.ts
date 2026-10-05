import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');
// Run tsx's CLI with this Node: node_modules/.bin/tsx is a .cmd shim on Windows, which
// execFileSync cannot start without a shell.
const TSX_CLI = createRequire(__filename).resolve('tsx/cli');
const tsx = (args: string[]) =>
  execFileSync(process.execPath, [TSX_CLI, ...args], { stdio: 'pipe' });

function exportTo(...args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-export-'));
  try {
    tsx([join(ROOT, 'playground', 'export.ts'), dir, ...args]);
    return readFileSync(join(dir, 'index.html'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const metaOf = (html: string) => /<meta name="bespoke-live-api" content="([^"]*)"/.exec(html)?.[1];

describe('playground export', () => {
  it('is replay-only by default: the live-API meta tag is empty', () => {
    expect(metaOf(exportTo())).toBe('');
  }, 30000);

  it('--live-api points the page at a deployed live API', () => {
    expect(metaOf(exportTo('--live-api', '/api/live/'))).toBe('/api/live/');
  }, 30000);

  it('copies every script the page loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-export-'));
    try {
      tsx([join(ROOT, 'playground', 'export.ts'), dir]);
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      const local = [...html.matchAll(/<script src="([^":]+)"/g)].map((m) => m[1]);
      expect(local).toEqual(['replay-state.js', 'live-requests.js', 'replay.js']);
      for (const f of local) expect(existsSync(join(dir, f))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('refuses a --live-api path that is not a directory', () => {
    expect(() => exportTo('--live-api', '/api/live')).toThrow(/needs a path ending in/);
  }, 30000);
});
