import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UsageLedger, LedgerEntry } from '../../utils/usage-ledger';
import { makeLedger, makeLogger } from '../helpers';

describe('UsageLedger', () => {
  let tmpDir: string;
  let filePath: string;
  let ledger: UsageLedger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bespoke-ledger-test-'));
    const result = makeLedger(tmpDir);
    ledger = result.ledger;
    filePath = result.filePath;
  });

  afterEach(() => {
    ledger.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readEntries(): LedgerEntry[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  it('creates directory and file on first record()', () => {
    // Delete the dir to prove it gets re-created
    fs.rmSync(tmpDir, { recursive: true, force: true });

    const nestedDir = path.join(tmpDir, 'sub');
    const nestedPath = path.join(nestedDir, 'usage-ledger.jsonl');
    const freshLedger = new UsageLedger(nestedPath, makeLogger());

    freshLedger.record({
      source: 'completion',
      model: 'haiku',
      project: 'test',
      durationMs: 100,
      inputChars: 50,
      outputChars: 10,
    });

    expect(fs.existsSync(nestedPath)).toBe(true);
    const content = fs.readFileSync(nestedPath, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.source).toBe('completion');
    expect(entry.model).toBe('haiku');
    freshLedger.dispose();
  });

  it('appends valid JSONL with ts field', () => {
    const before = Date.now();

    ledger.record({
      source: 'completion',
      model: 'haiku',
      project: 'myproject',
      durationMs: 200,
      inputChars: 100,
      outputChars: 20,
    });

    ledger.record({
      source: 'warmup',
      model: 'sonnet',
      project: 'myproject',
      durationMs: 50,
      inputChars: 10,
      outputChars: 5,
      slotIndex: 0,
    });

    const entries = readEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBeGreaterThanOrEqual(before);
    expect(entries[0].ts).toBeLessThanOrEqual(Date.now());
    expect(entries[0].source).toBe('completion');
    expect(entries[1].source).toBe('warmup');
    expect(entries[1].slotIndex).toBe(0);
  });

  describe('getSummary()', () => {
    it('aggregates correctly by today/week/month', () => {
      // Write entries with current timestamp (today)
      ledger.record({
        source: 'completion',
        model: 'haiku',
        project: 'proj-a',
        durationMs: 100,
        inputTokens: 500,
        outputTokens: 50,
        costUsd: 0.001,
        inputChars: 200,
        outputChars: 30,
      });
      ledger.record({
        source: 'completion',
        model: 'sonnet',
        project: 'proj-b',
        durationMs: 200,
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: 0.005,
        inputChars: 400,
        outputChars: 60,
      });
      ledger.record({
        source: 'startup',
        model: 'haiku',
        project: 'proj-a',
        durationMs: 0,
        inputChars: 0,
        outputChars: 0,
      });

      const summary = ledger.getSummary();

      // Today
      expect(summary.today.requests).toBe(2);
      expect(summary.today.startups).toBe(1);
      expect(summary.today.inputTokens).toBe(1500);
      expect(summary.today.outputTokens).toBe(150);
      expect(summary.today.costUsd).toBeCloseTo(0.006);
      expect(summary.today.durationMs).toBe(300);

      // This week and month should include today's data
      expect(summary.thisWeek.requests).toBe(2);
      expect(summary.thisMonth.requests).toBe(2);

      // By model
      expect(summary.byModel['haiku'].requests).toBe(1);
      expect(summary.byModel['sonnet'].requests).toBe(1);

      // By source
      expect(summary.bySource['completion'].requests).toBe(2);
      expect(summary.bySource['startup'].startups).toBe(1);

      // By project
      expect(summary.byProject['proj-a'].requests).toBe(1);
      expect(summary.byProject['proj-b'].requests).toBe(1);
    });

    it('handles empty/missing file', () => {
      const summary = ledger.getSummary();
      expect(summary.today.requests).toBe(0);
      expect(summary.thisWeek.requests).toBe(0);
      expect(summary.thisMonth.requests).toBe(0);
    });

    it('skips corrupt/truncated lines gracefully', () => {
      // Write a valid entry followed by corrupt lines
      ledger.record({
        source: 'completion',
        model: 'haiku',
        project: 'test',
        durationMs: 100,
        inputChars: 50,
        outputChars: 10,
      });

      // Append corrupt lines directly
      fs.appendFileSync(filePath, '{invalid json\n');
      fs.appendFileSync(filePath, '{"ts":123}\n'); // missing source
      fs.appendFileSync(filePath, '\n');

      const summary = ledger.getSummary();
      expect(summary.today.requests).toBe(1);
    });
  });

  describe('checkRotation()', () => {
    it('renames file when exceeding threshold and starts fresh', () => {
      // Write enough data to exceed 1MB
      const bigEntry = {
        source: 'completion' as const,
        model: 'haiku',
        project: 'test',
        durationMs: 100,
        inputChars: 50,
        outputChars: 10,
      };

      // Create a file just over 1MB by writing directly
      const line = JSON.stringify({ ts: Date.now(), ...bigEntry }) + '\n';
      const repeats = Math.ceil(1_048_577 / line.length);
      const bigContent = line.repeat(repeats);
      fs.writeFileSync(filePath, bigContent);

      // Now record one more — triggers rotation
      ledger.record(bigEntry);

      // The active file should exist and be empty (the triggering entry is in the archive)
      expect(fs.existsSync(filePath)).toBe(true);
      const activeSize = fs.statSync(filePath).size;
      expect(activeSize).toBe(0);

      // An archive file should exist
      const files = fs.readdirSync(tmpDir);
      const archives = files.filter((f) => f.match(/^usage-ledger-\d{4}-\d{2}-\d{2}\.jsonl$/));
      expect(archives.length).toBeGreaterThanOrEqual(1);
    });

    it('deletes archives older than 1 month on rotation', () => {
      // Create an old archive file
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 45);
      const oldDateStr = oldDate.toISOString().slice(0, 10);
      const oldArchive = path.join(tmpDir, `usage-ledger-${oldDateStr}.jsonl`);
      fs.writeFileSync(oldArchive, '{"ts":1}\n');

      // Create a recent archive that should NOT be deleted
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const recentDateStr = recentDate.toISOString().slice(0, 10);
      const recentArchive = path.join(tmpDir, `usage-ledger-${recentDateStr}.jsonl`);
      fs.writeFileSync(recentArchive, '{"ts":2}\n');

      // Write enough to trigger rotation
      const line =
        JSON.stringify({
          ts: Date.now(),
          source: 'completion',
          model: 'haiku',
          project: 'test',
          durationMs: 100,
          inputChars: 50,
          outputChars: 10,
        }) + '\n';
      const repeats = Math.ceil(1_048_577 / line.length);
      fs.writeFileSync(filePath, line.repeat(repeats));

      // Trigger rotation
      ledger.record({
        source: 'completion',
        model: 'haiku',
        project: 'test',
        durationMs: 100,
        inputChars: 50,
        outputChars: 10,
      });

      // Old archive should be deleted
      expect(fs.existsSync(oldArchive)).toBe(false);
      // Recent archive should still exist
      expect(fs.existsSync(recentArchive)).toBe(true);
    });
  });

  it('record() catches I/O errors without throwing', () => {
    // Point ledger at a read-only path that can't be written
    // Don't create the directory — the constructor's ensureDirectory may create it,
    // but we can break things by making the file a directory
    const dirAsFile = path.join(tmpDir, 'dir-as-file');
    fs.mkdirSync(dirAsFile);
    const impossiblePath = path.join(dirAsFile, 'usage-ledger.jsonl', 'impossible');
    const badLedger = new UsageLedger(impossiblePath, makeLogger());

    // Should not throw
    expect(() => {
      badLedger.record({
        source: 'completion',
        model: 'haiku',
        project: 'test',
        durationMs: 100,
        inputChars: 50,
        outputChars: 10,
      });
    }).not.toThrow();

    badLedger.dispose();
  });

  it('two ledger instances appending to same file produce valid JSONL', () => {
    const { ledger: ledger2 } = makeLedger(tmpDir);

    // Interleave writes from both instances
    ledger.record({
      source: 'completion',
      model: 'haiku',
      project: 'proj-1',
      durationMs: 100,
      inputChars: 50,
      outputChars: 10,
    });
    ledger2.record({
      source: 'warmup',
      model: 'sonnet',
      project: 'proj-2',
      durationMs: 50,
      inputChars: 10,
      outputChars: 5,
    });
    ledger.record({
      source: 'startup',
      model: 'haiku',
      project: 'proj-1',
      durationMs: 0,
      inputChars: 0,
      outputChars: 0,
    });

    const entries = readEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].project).toBe('proj-1');
    expect(entries[1].project).toBe('proj-2');
    expect(entries[2].source).toBe('startup');

    // All should be valid JSON with ts
    for (const entry of entries) {
      expect(entry.ts).toBeTypeOf('number');
      expect(entry.source).toBeTypeOf('string');
    }

    ledger2.dispose();
  });

  it('records optional SDK metadata fields', () => {
    ledger.record({
      source: 'completion',
      model: 'sonnet',
      project: 'test',
      durationMs: 500,
      durationApiMs: 450,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
      costUsd: 0.003,
      inputChars: 2000,
      outputChars: 300,
      slotIndex: 1,
      sessionId: 'sess-abc123',
    });

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.durationApiMs).toBe(450);
    expect(e.inputTokens).toBe(1000);
    expect(e.outputTokens).toBe(200);
    expect(e.cacheReadTokens).toBe(800);
    expect(e.cacheCreationTokens).toBe(100);
    expect(e.costUsd).toBe(0.003);
    expect(e.slotIndex).toBe(1);
    expect(e.sessionId).toBe('sess-abc123');
  });
});
