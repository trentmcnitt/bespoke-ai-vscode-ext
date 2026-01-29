import * as vscode from 'vscode';

export type LogLevel = 'info' | 'debug' | 'trace';

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2 };

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export class Logger {
  private channel: vscode.OutputChannel;
  private level: LogLevel = 'info';

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  info(msg: string): void {
    this.channel.appendLine(`[INFO  ${ts()}] ${msg}`);
  }

  debug(msg: string): void {
    if (LEVEL_RANK[this.level] <= LEVEL_RANK.debug) {
      this.channel.appendLine(`[DEBUG ${ts()}] ${msg}`);
    }
  }

  trace(msg: string): void {
    if (LEVEL_RANK[this.level] <= LEVEL_RANK.trace) {
      this.channel.appendLine(`[TRACE ${ts()}] ${msg}`);
    }
  }

  error(msg: string, err?: unknown): void {
    const suffix = err instanceof Error ? `: ${err.message}` : err ? `: ${String(err)}` : '';
    this.channel.appendLine(`[ERROR ${ts()}] ${msg}${suffix}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
