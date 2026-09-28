import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export type LedgerSource =
  | 'completion'
  | 'command'
  | 'commit-message'
  | 'suggest-edit'
  | 'warmup'
  | 'startup';

export interface LedgerEntry {
  ts: number;
  source: LedgerSource;
  model: string;
  backend?: 'claude-code' | 'api';
  project?: string;
  durationMs: number;
  durationApiMs?: number;
  /** Time spent waiting for a pool slot before the request was sent (CLI backend). */
  waitMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  inputChars: number;
  outputChars: number;
  slotIndex?: number;
  sessionId?: string;
}

export interface PeriodStats {
  requests: number;
  startups: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface LedgerSummary {
  today: PeriodStats;
  thisWeek: PeriodStats;
  thisMonth: PeriodStats;
  byModel: Record<string, PeriodStats>;
  bySource: Record<string, PeriodStats>;
  byProject: Record<string, PeriodStats>;
}

/** Maximum active file size before rotation (1MB). */
const ROTATION_THRESHOLD = 1_048_576;

/** Ledger files are owner-only: they list project names, models, and usage. */
export const LEDGER_FILE_MODE = 0o600;

/** Archive files older than this are purged on rotation. */
const ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 1 month

function emptyStats(): PeriodStats {
  return { requests: 0, startups: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

function addToStats(stats: PeriodStats, entry: LedgerEntry): void {
  if (entry.source === 'startup') {
    stats.startups++;
  } else {
    stats.requests++;
  }
  stats.inputTokens += entry.inputTokens ?? 0;
  stats.outputTokens += entry.outputTokens ?? 0;
  stats.durationMs += entry.durationMs;
}

export class UsageLedger {
  private readonly filePath: string;
  private readonly dirPath: string;
  private readonly logger: Logger;
  /** A ledger created before 0600 was enforced keeps its old mode; tighten it once. */
  private modeChecked = false;

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.dirPath = path.dirname(filePath);
    this.logger = logger;
    this.ensureDirectory();
  }

  /** Append an entry to the ledger file. Never throws. */
  record(entry: Omit<LedgerEntry, 'ts'>): void {
    try {
      const full: LedgerEntry = { ts: Date.now(), ...entry };
      if (!this.modeChecked) {
        this.modeChecked = true;
        this.restrictMode(this.filePath);
      }
      fs.appendFileSync(this.filePath, JSON.stringify(full) + '\n', {
        flag: 'a',
        mode: LEDGER_FILE_MODE,
      });
      this.checkRotation();
    } catch (err) {
      this.logger.error(`UsageLedger: write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Read the active file and return aggregated stats. */
  getSummary(): LedgerSummary {
    const summary: LedgerSummary = {
      today: emptyStats(),
      thisWeek: emptyStats(),
      thisMonth: emptyStats(),
      byModel: {},
      bySource: {},
      byProject: {},
    };

    let lines: string[];
    try {
      if (!fs.existsSync(this.filePath)) {
        return summary;
      }
      const content = fs.readFileSync(this.filePath, 'utf-8');
      lines = content.split('\n').filter((l) => l.trim().length > 0);
    } catch {
      return summary;
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    // Week start: most recent Monday at midnight
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekMs = weekStart.getTime();

    // Month start: 1st of current month at midnight
    const monthStart = new Date(todayStart);
    monthStart.setDate(1);
    const monthMs = monthStart.getTime();

    for (const line of lines) {
      let entry: LedgerEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip corrupt lines
      }

      if (!entry.ts || !entry.source) {
        continue;
      }

      // Period aggregation
      if (entry.ts >= todayMs) {
        addToStats(summary.today, entry);
      }
      if (entry.ts >= weekMs) {
        addToStats(summary.thisWeek, entry);
      }
      if (entry.ts >= monthMs) {
        addToStats(summary.thisMonth, entry);
      }

      // By-model
      if (entry.model) {
        if (!summary.byModel[entry.model]) {
          summary.byModel[entry.model] = emptyStats();
        }
        addToStats(summary.byModel[entry.model], entry);
      }

      // By-source
      if (!summary.bySource[entry.source]) {
        summary.bySource[entry.source] = emptyStats();
      }
      addToStats(summary.bySource[entry.source], entry);

      // By-project
      if (entry.project) {
        if (!summary.byProject[entry.project]) {
          summary.byProject[entry.project] = emptyStats();
        }
        addToStats(summary.byProject[entry.project], entry);
      }
    }

    return summary;
  }

  dispose(): void {
    // No open handles to clean up
  }

  private ensureDirectory(): void {
    try {
      if (!fs.existsSync(this.dirPath)) {
        fs.mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
      }
    } catch (err) {
      this.logger.error(
        `UsageLedger: failed to create directory ${this.dirPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** chmod 0600; a missing file is fine (append creates it 0600). No-op on Windows. */
  private restrictMode(filePath: string): void {
    if (process.platform === 'win32') return;
    try {
      fs.chmodSync(filePath, LEDGER_FILE_MODE);
    } catch {
      // ENOENT on first use, or not ours to change — the append still proceeds.
    }
  }

  private checkRotation(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= ROTATION_THRESHOLD) {
        return;
      }

      // Rotate: rename to usage-ledger-YYYY-MM-DD.jsonl
      const dateStr = new Date().toISOString().slice(0, 10);
      const archiveName = `usage-ledger-${dateStr}.jsonl`;
      const archivePath = path.join(this.dirPath, archiveName);

      // Use process-unique temp file and rename-based atomic claim for concurrency safety
      const tempPath = `${this.filePath}.rotating.${process.pid}`;

      // If archive for today already exists, append to it instead of overwriting
      if (fs.existsSync(archivePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        fs.appendFileSync(archivePath, content, { mode: LEDGER_FILE_MODE });
        fs.writeFileSync(this.filePath, '', { mode: LEDGER_FILE_MODE });
      } else {
        // Atomic claim: rename to process-unique temp, then rename to archive
        // If another process wins the race, our renameSync will fail
        try {
          fs.renameSync(this.filePath, tempPath);
        } catch {
          // Another process won the race — let them handle rotation
          return;
        }
        fs.renameSync(tempPath, archivePath);
        // Start a fresh active file
        fs.writeFileSync(this.filePath, '', { mode: LEDGER_FILE_MODE });
      }

      this.restrictMode(archivePath);
      this.logger.info(`UsageLedger: rotated to ${archiveName}`);

      // Purge old archives
      this.purgeOldArchives();
    } catch (err) {
      this.logger.error(
        `UsageLedger: rotation failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private purgeOldArchives(): void {
    try {
      const files = fs.readdirSync(this.dirPath);
      const now = Date.now();

      for (const file of files) {
        const match = file.match(/^usage-ledger-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!match) {
          continue;
        }
        const fileDate = new Date(match[1] + 'T00:00:00');
        if (isNaN(fileDate.getTime())) {
          continue;
        }
        if (now - fileDate.getTime() > ARCHIVE_MAX_AGE_MS) {
          fs.unlinkSync(path.join(this.dirPath, file));
          this.logger.info(`UsageLedger: purged old archive ${file}`);
        }
      }
    } catch (err) {
      this.logger.error(`UsageLedger: purge failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
