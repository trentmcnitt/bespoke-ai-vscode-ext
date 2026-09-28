import * as vscode from 'vscode';

export type LogLevel = 'info' | 'debug' | 'trace';

/** The valid `bespokeAI.logLevel` values. `error` is not one: `[ERROR]` lines are always written. */
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug', 'trace'];

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2 };

/**
 * Whether `value` is a real log level. Uses `typeof` on an own lookup rather than
 * `in`, because `'constructor' in LEVEL_RANK` (and other prototype keys) is true.
 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && typeof LEVEL_RANK[value as LogLevel] === 'number';
}

const SEPARATOR = '───────────────────────────────────────────────────────────────────';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Generate a short 4-character hex request ID */
export function generateRequestId(): string {
  return Math.random().toString(16).slice(2, 6);
}

export interface RequestStartDetails {
  mode: string;
  backend: string;
  file: string;
  prefixLen: number;
  suffixLen: number;
}

export interface RequestEndDetails {
  durationMs: number;
  resultLen: number | null;
  slot?: number;
  cancelled?: boolean;
}

export class Logger {
  private channel: vscode.OutputChannel;
  private level: LogLevel = 'info';

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  /**
   * Set the level. An unknown value (e.g. `'error'`, `'Debug'` from a hand-edited
   * settings.json) falls back to `'info'` — an unrecognized value must never widen
   * what is written.
   */
  setLevel(level: LogLevel): void {
    this.level = isLogLevel(level) ? level : 'info';
  }

  /**
   * The single gate for every level-filtered method. Treats an unknown level as
   * disabled, so a bad value can never make the two guard styles disagree
   * (previously `rank <= X` suppressed while `rank > X` early-returns wrote).
   */
  private enabled(min: LogLevel): boolean {
    const rank = LEVEL_RANK[this.level];
    return typeof rank === 'number' && rank <= LEVEL_RANK[min];
  }

  // ─────────────────────────────────────────────────────────────────
  // Basic logging methods
  // ─────────────────────────────────────────────────────────────────

  info(msg: string): void {
    this.channel.appendLine(`[INFO  ${ts()}] ${msg}`);
  }

  debug(msg: string): void {
    if (this.enabled('debug')) {
      this.channel.appendLine(`[DEBUG ${ts()}] ${msg}`);
    }
  }

  trace(msg: string): void {
    if (this.enabled('trace')) {
      this.channel.appendLine(`[TRACE ${ts()}] ${msg}`);
    }
  }

  error(msg: string, err?: unknown): void {
    const suffix = err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : '';
    this.channel.appendLine(`[ERROR ${ts()}] ${msg}${suffix}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Structured request logging (debug+ level)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Log the start of a completion request with visual separator.
   * Only shown at debug level and above.
   */
  requestStart(reqId: string, details: RequestStartDetails): void {
    if (!this.enabled('debug')) {
      return;
    }
    this.channel.appendLine(SEPARATOR);
    this.channel.appendLine(
      `[DEBUG ${ts()}] ▶ #${reqId} | ${details.mode} | ${details.backend} | ${details.file} | ${details.prefixLen}+${details.suffixLen} chars`,
    );
  }

  /**
   * Log the end of a completion request.
   * Only shown at debug level and above.
   */
  requestEnd(reqId: string, details: RequestEndDetails): void {
    if (!this.enabled('debug')) {
      return;
    }

    let status: string;
    if (details.cancelled) {
      status = 'cancelled';
    } else if (details.resultLen === null) {
      status = 'null';
    } else {
      status = `${details.resultLen} chars`;
    }

    const parts = [`${details.durationMs}ms`, status];
    if (details.slot !== undefined) {
      parts.push(`slot=${details.slot}`);
    }

    this.channel.appendLine(`[DEBUG ${ts()}] ◀ #${reqId} | ${parts.join(' | ')}`);
  }

  /**
   * Log a cache hit (no API call made).
   * Only shown at debug level and above.
   */
  cacheHit(reqId: string, resultLen: number): void {
    if (!this.enabled('debug')) {
      return;
    }
    this.channel.appendLine(SEPARATOR);
    this.channel.appendLine(`[DEBUG ${ts()}] ◀ #${reqId} | cache hit | ${resultLen} chars`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Trace content blocks (trace level only)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Log a labeled block of trace content with indentation.
   * Content is written verbatim (no truncation), so trace logs show exactly what was sent.
   */
  traceBlock(label: string, content: string): void {
    if (!this.enabled('trace')) {
      return;
    }

    // Indent each line of content
    const indented = content
      .split('\n')
      .map((line) => `          ${line}`)
      .join('\n');
    this.channel.appendLine(`[TRACE]   ${label}:`);
    this.channel.appendLine(indented);
  }

  /**
   * Log a short inline trace value (no block formatting).
   */
  traceInline(label: string, value: string): void {
    if (!this.enabled('trace')) {
      return;
    }
    this.channel.appendLine(`[TRACE]   ${label}: ${value}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
