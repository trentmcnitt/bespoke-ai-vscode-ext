import * as path from 'path';
import { Logger } from '../utils/logger';
import { createMessageChannel, MessageChannel } from '../utils/message-channel';
import { UsageLedger } from '../utils/usage-ledger';

export type SlotState = 'initializing' | 'available' | 'busy' | 'dead';

export interface ResultMetadata {
  durationMs: number;
  durationApiMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionId: string;
}

export interface Slot {
  state: SlotState;
  channel: MessageChannel | null;
  /** Resolves with the next result from the stream consumer. */
  resultPromise: Promise<string | null> | null;
  /** Call to deliver a result from the background consumer. */
  deliverResult: ((value: string | null) => void) | null;
  /** Number of completions delivered by this slot (excludes warmup). */
  resultCount: number;
  /** Monotonically increasing generation — incremented on killAllSlots to invalidate stale consumers. */
  generation: number;
  /** Timestamp of the last recycleSlot call (for circuit breaker). */
  lastRecycleTime: number;
  /** Count of rapid consecutive recycles (resets when gap exceeds threshold). */
  rapidRecycleCount: number;
  /** SDK metadata from the most recent result message, read by callers. */
  lastResultMeta: ResultMetadata | null;
}

/** Circuit breaker: max rapid recycles before marking a slot dead. */
const RAPID_RECYCLE_LIMIT = 5;
/** Circuit breaker: time window (ms) for counting rapid recycles. */
const RAPID_RECYCLE_WINDOW_MS = 5_000;

export abstract class SlotPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected queryFn: ((...args: any[]) => any) | null = null;
  protected sdkAvailable: boolean | null = null;
  protected slots: Slot[];
  protected nextSlot = 0;
  protected logger: Logger;
  protected readonly poolSize: number;
  protected ledger: UsageLedger | null = null;
  /** Single-waiter queue: only one request can wait for a slot at a time. */
  protected pendingWaiter: ((index: number | null) => void) | null = null;
  /** Deduplicates overlapping recycleAll calls. */
  private _recyclePromise: Promise<void> | null = null;
  protected _warmupResolvers: (((ok: boolean) => void) | null)[];
  private _warmupFailureCount = 0;
  private _warmupFailureHandled = false;

  /** Called when the pool is fully degraded (all warmup retries exhausted). */
  onPoolDegraded: (() => void) | null = null;

  constructor(logger: Logger, poolSize: number) {
    this.logger = logger;
    this.poolSize = poolSize;
    this.slots = Array.from({ length: poolSize }, () => ({
      state: 'dead' as SlotState,
      channel: null,
      resultPromise: null,
      deliverResult: null,
      resultCount: 0,
      generation: 0,
      lastRecycleTime: 0,
      rapidRecycleCount: 0,
      lastResultMeta: null,
    }));
    this._warmupResolvers = Array.from({ length: poolSize }, () => null);
  }

  // --- Abstract methods subclasses must implement ---

  protected abstract getSystemPrompt(): string;
  protected abstract getModel(): string;
  protected abstract getCwd(): string;
  protected abstract getMaxReuses(): number;
  protected abstract getPoolLabel(): string;
  protected abstract buildWarmupMessage(): string;
  protected abstract validateWarmupResponse(raw: string): boolean;

  // --- Public API ---

  setLedger(ledger: UsageLedger): void {
    this.ledger = ledger;
  }

  isAvailable(): boolean {
    return this.sdkAvailable === true;
  }

  /** Close all slots and reinitialize them. Used when the model changes.
   *  Serialized: overlapping calls return the same promise. */
  async recycleAll(): Promise<void> {
    if (!this.sdkAvailable) {
      return;
    }

    // Deduplicate overlapping recycleAll calls
    if (this._recyclePromise) {
      return this._recyclePromise;
    }

    this._recyclePromise = this._doRecycleAll();
    try {
      await this._recyclePromise;
    } finally {
      this._recyclePromise = null;
    }
  }

  /**
   * Restart the pool from scratch. Resets warmup failure tracking and
   * re-initializes all slots. Use after the pool has been degraded.
   */
  async restart(): Promise<void> {
    this.killAllSlots();
    this._warmupFailureCount = 0;
    this._warmupFailureHandled = false;
    this.sdkAvailable = null;

    await this.loadSdk();
    if (!this.sdkAvailable) {
      this.logger.error(`${this.getPoolLabel()}: SDK not available on restart`);
      return;
    }

    this.logger.info(`${this.getPoolLabel()}: restarting pool...`);
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));
    this.logger.info(`${this.getPoolLabel()}: pool restarted`);
  }

  dispose(): void {
    this.killAllSlots();
    this.sdkAvailable = false;
    this.queryFn = null;
    this.logger.info(`${this.getPoolLabel()} provider: disposed`);
  }

  // --- Protected pool infrastructure ---

  protected async loadSdk(): Promise<void> {
    try {
      if (this.sdkAvailable === false) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = await (import('@anthropic-ai/claude-agent-sdk') as Promise<any>);
      const queryFn = sdk.query ?? sdk.default?.query;
      if (!queryFn) {
        this.logger.error(`${this.getPoolLabel()}: Agent SDK does not export query()`);
        this.sdkAvailable = false;
        return;
      }

      this.queryFn = queryFn;
      this.sdkAvailable = true;
      this.logger.info(`${this.getPoolLabel()}: SDK loaded`);
    } catch (err) {
      this.sdkAvailable = false;
      this.logger.error(
        `${this.getPoolLabel()}: Agent SDK not available — provider disabled (${err instanceof Error ? (err.stack ?? err.message) : err})`,
      );
    }
  }

  protected async initSlot(index: number): Promise<void> {
    const slot = this.slots[index];
    try {
      slot.state = 'initializing';
      slot.resultCount = 0;

      const channel = createMessageChannel();
      slot.channel = channel;

      // Push a warmup message to prime the session
      const warmup = this.buildWarmupMessage();
      channel.push(warmup);
      this.logger.traceBlock(`warmup → sent (slot ${index})`, warmup);

      // Start streaming query — it consumes messages from the channel.
      // The SDK resolves cli.js via import.meta.url, which is undefined when
      // loaded via require() in a CJS bundle. Pass the path explicitly.
      const sdkCliPath = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
      const stream = this.queryFn!({
        prompt: channel.iterable,
        options: {
          model: this.getModel(),
          tools: [],
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: this.getSystemPrompt(),
          cwd: this.getCwd(),
          settingSources: [],
          maxThinkingTokens: 0,
          maxTurns: 50,
          persistSession: false,
          pathToClaudeCodeExecutable: sdkCliPath,
        },
      });

      // Set up promise that callers will await
      this.resetResultPromise(slot);

      // Start background consumer (eats warmup, then delivers real results)
      this.consumeStream(stream, index);

      // Wait for warmup to establish the subprocess and validate
      const warmupOk = await this.waitForWarmup(index);

      this.logger.traceBlock('system prompt (slot ' + index + ')', this.getSystemPrompt());

      if (!warmupOk) {
        this.handleWarmupFailure(index);
        return;
      }

      // Guard: handleWarmupFailure from a sibling slot may have killed this slot.
      // Re-read from this.slots[] to bypass TypeScript's narrowing of the local.
      if (this.slots[index].state === 'dead') {
        return;
      }

      slot.state = 'available';

      // Record startup in ledger
      this.ledger?.record({
        source: 'startup',
        model: this.getModel(),
        project: this.projectName,
        durationMs: 0,
        inputChars: 0,
        outputChars: 0,
        slotIndex: index,
      });

      // If a request is already waiting, claim this slot for it
      this.notifyWaiter(index);
    } catch (err) {
      slot.state = 'dead';
      this.logger.error(
        `${this.getPoolLabel()}: slot ${index} init failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
    }
  }

  /**
   * Acquire an available slot. Returns the slot index (already marked busy)
   * or null if cancelled by a newer waiter.
   *
   * Fast path: find any available slot, mark busy, return.
   * Slow path: register as single waiter. A new arrival cancels the previous
   * waiter (resolve(null)), so only the most recent request waits.
   */
  protected async acquireSlot(): Promise<number | null> {
    // Fast path: find an available slot
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.nextSlot + i) % this.slots.length;
      if (this.slots[idx].state === 'available') {
        this.slots[idx].state = 'busy';
        this.nextSlot = (idx + 1) % this.slots.length;
        return idx;
      }
    }

    // Slow path: cancel existing waiter and register self
    if (this.pendingWaiter) {
      this.pendingWaiter(null);
    }

    this.logger.trace(
      `waiting for slot (${this.slots.map((s, i) => `slot${i}=${s.state}`).join(', ')})`,
    );

    return new Promise<number | null>((resolve) => {
      this.pendingWaiter = resolve;
    });
  }

  /**
   * Notify the pending waiter that a slot is available. Called by consumeStream
   * after delivering a result (slot reuse) and by initSlot after warmup (fresh slot).
   * The slot is marked busy before notifying the waiter.
   */
  protected notifyWaiter(slotIndex: number): boolean {
    if (!this.pendingWaiter) {
      return false;
    }
    const waiter = this.pendingWaiter;
    this.pendingWaiter = null;
    this.slots[slotIndex].state = 'busy';
    waiter(slotIndex);
    return true;
  }

  /** Extract SDK metadata from a result message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected extractMetadata(message: any): ResultMetadata {
    const usage = message.usage;
    return {
      durationMs: message.duration_ms ?? 0,
      durationApiMs: message.duration_api_ms ?? 0,
      costUsd: message.total_cost_usd ?? 0,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
      sessionId: message.session_id ?? '',
    };
  }

  /** Get the workspace root basename for ledger entries. */
  protected get projectName(): string {
    return this.getCwd() ? path.basename(this.getCwd()) : '';
  }

  protected resetResultPromise(slot: Slot): void {
    slot.resultPromise = new Promise<string | null>((resolve) => {
      slot.deliverResult = resolve;
    });
  }

  protected waitForWarmup(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      // Store a callback that the consumer calls after validating the warmup result.
      // Resolves true on success, false on validation failure.
      this._warmupResolvers[index] = resolve;
    });
  }

  /**
   * Background consumer loop. Eats the warmup result, then loops delivering
   * real completion results. After getMaxReuses() completions or on stream error,
   * recycles the slot (finally block).
   */
  protected async consumeStream(stream: AsyncIterable<unknown>, slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    const myGeneration = slot.generation;
    // Keep reference to iterator for cleanup on early return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iterator = (stream as AsyncIterable<any>)[Symbol.asyncIterator]();
    try {
      let resultCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let iterResult: IteratorResult<any>;
      while (!(iterResult = await iterator.next()).done) {
        const message = iterResult.value;
        if (message.type === 'result') {
          resultCount++;
          const text: string | null =
            message.subtype === 'success' ? (message.result ?? null) : null;

          // Extract SDK metadata from every result message
          const meta = this.extractMetadata(message);

          if (resultCount === 1) {
            // Warmup result — validate, then signal initSlot
            this.logger.traceBlock(`warmup ← recv (slot ${slotIndex})`, text ?? '(null)');

            // Record warmup in ledger
            this.ledger?.record({
              source: 'warmup',
              model: this.getModel(),
              project: this.projectName,
              durationMs: meta.durationMs,
              durationApiMs: meta.durationApiMs,
              inputTokens: meta.inputTokens,
              outputTokens: meta.outputTokens,
              cacheReadTokens: meta.cacheReadTokens,
              cacheCreationTokens: meta.cacheCreationTokens,
              costUsd: meta.costUsd,
              inputChars: 0,
              outputChars: text?.length ?? 0,
              slotIndex,
              sessionId: meta.sessionId,
            });

            let warmupOk = false;
            if (text) {
              warmupOk = this.validateWarmupResponse(text);
              if (!warmupOk) {
                this.logger.error(
                  `warmup validation failed on slot ${slotIndex}: raw="${text.slice(0, 100)}"`,
                );
              }
            } else {
              this.logger.error(`warmup returned null on slot ${slotIndex}, recycling`);
            }

            this._warmupResolvers[slotIndex]?.(warmupOk);
            this._warmupResolvers[slotIndex] = null;

            if (!warmupOk) {
              break; // exits for-await, triggering recycleSlot in finally
            }
            continue;
          }

          // Stale consumer guard — slot was recycled while we were iterating
          if (this.slots[slotIndex].generation !== myGeneration) {
            return; // skip deliverResult and finally-block recycleSlot
          }

          // Store metadata for callers to read
          slot.lastResultMeta = meta;

          // Real completion result — deliver to the waiting caller
          slot.resultCount++;
          slot.deliverResult?.(text);

          // Stop if disposed or hit reuse limit
          if (slot.state === 'dead') {
            break;
          }
          if (slot.resultCount >= this.getMaxReuses()) {
            this.logger.debug(
              `slot ${slotIndex} reached max reuses (${this.getMaxReuses()}), recycling`,
            );
            break;
          }

          // Reuse: reset the result promise and mark available for next request
          this.resetResultPromise(slot);
          slot.state = 'available';

          // If a request is already waiting, claim this slot immediately
          this.notifyWaiter(slotIndex);
        }
      }
    } catch (err) {
      // Stale consumer guard — don't touch the new slot's state
      if (this.slots[slotIndex].generation !== myGeneration) {
        return;
      }
      this.logger.error(
        `${this.getPoolLabel()}: stream error on slot ${slotIndex}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
      slot.deliverResult?.(null);
      // Also resolve warmup if still pending (failure)
      this._warmupResolvers[slotIndex]?.(false);
      this._warmupResolvers[slotIndex] = null;
    } finally {
      // Stale consumer guard — if the slot generation changed, a recycleAll
      // (or similar) already replaced this slot. Don't touch the new one.
      if (this.slots[slotIndex].generation !== myGeneration) {
        // Clean up the iterator before returning to release resources
        await iterator.return?.();
        return;
      }
      this.recycleSlot(slotIndex);
    }
  }

  /**
   * Kill all slots immediately. Cancels pending waiters, resolves in-flight
   * deliverResult and warmup promises, closes channels, marks all slots dead.
   */
  protected killAllSlots(): void {
    if (this.pendingWaiter) {
      this.pendingWaiter(null);
      this.pendingWaiter = null;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.generation++;
      slot.deliverResult?.(null);
      slot.state = 'dead';
      slot.channel?.close();
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;
      slot.resultCount = 0;
      slot.lastResultMeta = null;
      // Reset circuit breaker so intentional recycles (recycleAll) don't count
      slot.lastRecycleTime = 0;
      slot.rapidRecycleCount = 0;
      // Unblock any pending initSlot awaiting warmup
      this._warmupResolvers[i]?.(false);
      this._warmupResolvers[i] = null;
    }
  }

  // --- Private helpers ---

  private async _doRecycleAll(): Promise<void> {
    this._warmupFailureCount = 0;
    this._warmupFailureHandled = false;
    this.logger.info(`${this.getPoolLabel()}: recycling all slots`);
    this.killAllSlots();

    // Reinitialize all slots
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));
    this.logger.info(`${this.getPoolLabel()}: pool recycled`);
  }

  private recycleSlot(index: number): void {
    const slot = this.slots[index];
    if (slot.state === 'dead') {
      return;
    } // already disposed

    // Circuit breaker: detect rapid consecutive recycles
    const now = Date.now();
    if (now - slot.lastRecycleTime < RAPID_RECYCLE_WINDOW_MS) {
      slot.rapidRecycleCount++;
    } else {
      slot.rapidRecycleCount = 1;
    }
    slot.lastRecycleTime = now;

    if (slot.rapidRecycleCount >= RAPID_RECYCLE_LIMIT) {
      this.logger.error(
        `${this.getPoolLabel()}: slot ${index} recycled ${slot.rapidRecycleCount} times in < ${RAPID_RECYCLE_WINDOW_MS}ms — marking dead (circuit breaker)`,
      );
      slot.generation++;
      slot.state = 'dead';
      slot.channel?.close();
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;

      // Check if all slots are now dead → fire onPoolDegraded
      if (this.slots.every((s) => s.state === 'dead')) {
        this.logger.error(
          `${this.getPoolLabel()}: all slots dead (circuit breaker), pool degraded`,
        );
        this.onPoolDegraded?.();
      }
      return;
    }

    slot.state = 'initializing';

    // Close old channel (kills subprocess)
    slot.channel?.close();
    slot.channel = null;
    slot.resultPromise = null;
    slot.deliverResult = null;
    slot.resultCount = 0;

    // Spawn fresh session in background. setTimeout breaks the microtask chain
    // so consumeStream → recycleSlot → initSlot → consumeStream doesn't recurse
    // synchronously through promise resolution.
    setTimeout(() => {
      if (this.slots[index].state === 'dead') {
        return;
      }
      this.initSlot(index).catch((err) => {
        this.logger.error(`${this.getPoolLabel()}: slot ${index} recycle failed: ${err}`);
      });
    }, 0);
  }

  /**
   * Handle a warmup validation failure. Kills the entire pool immediately.
   * On first failure: retries all slots. On second failure: shuts down and
   * notifies the host via onPoolDegraded.
   */
  private handleWarmupFailure(failedSlot: number): void {
    // Guard: another slot's failure may have already triggered this
    if (this._warmupFailureHandled) {
      return;
    }
    this._warmupFailureHandled = true;
    this._warmupFailureCount++;

    this.logger.error(
      `${this.getPoolLabel()}: warmup failed on slot ${failedSlot} (attempt ${this._warmupFailureCount}/2)`,
    );

    this.killAllSlots();

    if (this._warmupFailureCount >= 2) {
      // Exhausted retries — shut down
      this.sdkAvailable = false;
      this.logger.error(`${this.getPoolLabel()}: warmup failed after retry, autocomplete disabled`);
      this.onPoolDegraded?.();
    } else {
      // Retry once
      this.logger.info(`${this.getPoolLabel()}: retrying all slots after warmup failure...`);
      setTimeout(() => {
        this._warmupFailureHandled = false;
        Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i))).catch(
          (err) => {
            this.logger.error(`${this.getPoolLabel()}: warmup retry failed: ${err}`);
          },
        );
      }, 0);
    }
  }
}
