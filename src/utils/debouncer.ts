import * as vscode from 'vscode';

export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentAbort: AbortController | null = null;

  constructor(private delayMs: number) {}

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  /**
   * Waits for the debounce period, then returns an AbortSignal for the HTTP request.
   * Returns null if cancelled during the wait.
   */
  async debounce(token: vscode.CancellationToken): Promise<AbortSignal | null> {
    // Cancel any previous pending debounce
    this.cancel();

    // Abort any in-flight HTTP request
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
    this.currentAbort = new AbortController();
    const signal = this.currentAbort.signal;

    // Wait for debounce period
    let listener: vscode.Disposable | undefined;
    const cancelled = await new Promise<boolean>((resolve) => {
      this.timer = setTimeout(() => {
        listener?.dispose();
        resolve(false);
      }, this.delayMs);

      listener = token.onCancellationRequested(() => {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        listener?.dispose();
        resolve(true);
      });
    });

    this.timer = null;

    if (cancelled || token.isCancellationRequested) {
      this.currentAbort.abort();
      return null;
    }

    return signal;
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  abortCurrent(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
  }

  dispose(): void {
    this.cancel();
    this.abortCurrent();
  }
}
