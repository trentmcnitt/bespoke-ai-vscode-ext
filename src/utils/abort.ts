/**
 * An AbortSignal that fires when the caller's signal aborts or `timeoutMs`
 * elapses, whichever comes first.
 *
 * `AbortSignal.any()` would combine the two, but it needs Node 20.3+ and
 * VS Code 1.85 runs Node 18. `timedOut()` says which source fired, so a caller
 * can treat a timeout as a backend failure and a cancel as the user's choice.
 * Call `dispose()` when the request settles: it clears the timer and removes
 * the listener on the caller's signal (which may outlive the request).
 */
export interface LinkedAbort {
  signal: AbortSignal;
  /** True when the timeout, not the caller's signal, aborted `signal`. */
  timedOut(): boolean;
  dispose(): void;
}

export function linkAbortSignal(caller: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => {
    clearTimeout(timer);
    timer = undefined;
    controller.abort();
  };
  const dispose = () => {
    clearTimeout(timer);
    timer = undefined;
    caller?.removeEventListener('abort', onCallerAbort);
  };

  if (caller?.aborted) {
    controller.abort();
  } else {
    caller?.addEventListener('abort', onCallerAbort, { once: true });
    timer = setTimeout(() => {
      timer = undefined;
      if (controller.signal.aborted) return;
      timedOut = true;
      caller?.removeEventListener('abort', onCallerAbort);
      controller.abort();
    }, timeoutMs);
  }

  return { signal: controller.signal, timedOut: () => timedOut, dispose };
}
