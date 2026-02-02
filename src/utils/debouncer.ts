import * as vscode from 'vscode';

export const MAX_BACKOFF_MS = 30_000;
export const MAX_DISMISSALS = 8;

export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentAbort: AbortController | null = null;
  // private dismissalCount = 0;

  constructor(private delayMs: number) {}

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  // --- Adaptive back-off (commented out — may restore later) ---
  // /** Record a dismissal — increases back-off for the next debounce. */
  // recordDismissal(): void {
  //   if (this.dismissalCount < MAX_DISMISSALS) {
  //     this.dismissalCount++;
  //   }
  // }
  //
  // /** Reset back-off to zero (called on acceptance). */
  // resetBackoff(): void {
  //   this.dismissalCount = 0;
  // }

  /** Current effective delay — returns base delay (back-off disabled). */
  getCurrentDelay(): number {
    return this.delayMs;
    // Back-off formula (disabled):
    // if (this.dismissalCount === 0) {
    //   return this.delayMs;
    // }
    // const ratio = MAX_BACKOFF_MS / this.delayMs;
    // const exponent = Math.min(this.dismissalCount, MAX_DISMISSALS) / MAX_DISMISSALS;
    // return Math.min(Math.round(this.delayMs * Math.pow(ratio, exponent)), MAX_BACKOFF_MS);
  }

  // get currentDismissalCount(): number {
  //   return this.dismissalCount;
  // }

  /**
   * Waits for the debounce period, then returns an AbortSignal for the HTTP request.
   * Returns null if cancelled during the wait.
   */
  async debounce(
    token: vscode.CancellationToken,
    overrideDelayMs?: number,
  ): Promise<AbortSignal | null> {
    // Cancel any previous pending debounce
    this.cancel();

    // Abort any in-flight HTTP request
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
    this.currentAbort = new AbortController();
    const signal = this.currentAbort.signal;

    const effectiveDelay = overrideDelayMs ?? this.getCurrentDelay();

    // Wait for debounce period
    let listener: vscode.Disposable | undefined;
    const cancelled = await new Promise<boolean>((resolve) => {
      this.timer = setTimeout(() => {
        listener?.dispose();
        resolve(false);
      }, effectiveDelay);

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
