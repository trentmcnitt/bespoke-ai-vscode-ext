import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

function exportTo(...args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-export-'));
  try {
    execFileSync(TSX, [join(ROOT, 'playground', 'export.ts'), dir, ...args], { stdio: 'pipe' });
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
      execFileSync(TSX, [join(ROOT, 'playground', 'export.ts'), dir], { stdio: 'pipe' });
      const html = readFileSync(join(dir, 'index.html'), 'utf8');
      const local = [...html.matchAll(/<script src="([^":]+)"/g)].map((m) => m[1]);
      expect(local).toEqual(['replay-state.js', 'replay.js']);
      for (const f of local) expect(existsSync(join(dir, f))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('refuses a --live-api path that is not a directory', () => {
    expect(() => exportTo('--live-api', '/api/live')).toThrow();
  }, 30000);
});
