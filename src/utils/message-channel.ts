export interface MessageChannel {
  iterable: AsyncIterable<unknown>;
  push(message: string): void;
  close(): void;
}

export function createMessageChannel(): MessageChannel {
  let resolve: ((value: IteratorResult<unknown>) => void) | null = null;
  let done = false;
  const pending: unknown[] = [];

  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((r) => { resolve = r; });
        },
        return(): Promise<IteratorResult<unknown>> {
          done = true;
          if (resolve) {
            resolve({ value: undefined, done: true });
            resolve = null;
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(message: string) {
      const msg = {
        type: 'user' as const,
        message: { role: 'user' as const, content: message },
        parent_tool_use_id: null,
        session_id: '',
      };
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        pending.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) {
        resolve({ value: undefined, done: true });
        resolve = null;
      }
    },
  };
}
