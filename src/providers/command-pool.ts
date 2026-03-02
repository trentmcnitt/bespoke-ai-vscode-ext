import { Logger } from '../utils/logger';
import { SlotPool, ResultMetadata } from './slot-pool';

export const COMMAND_SYSTEM_PROMPT = `Follow the instructions in each message precisely. Output only what is requested — no commentary, preamble, or meta-text.`;

const WARMUP_MESSAGE = 'Reply with exactly the word: READY';

/** Maximum requests per slot before recycling. */
const MAX_COMMAND_REUSES = 4;

/** Error text returned by Claude Code CLI when accumulated conversation exceeds context limit. */
const PROMPT_TOO_LONG = 'Prompt is too long';

export interface SendPromptOptions {
  timeoutMs?: number;
  onCancel?: AbortSignal;
}

export interface SendPromptResult {
  text: string | null;
  meta: ResultMetadata | null;
}

export class CommandPool extends SlotPool {
  private model: string;

  constructor(model: string, logger: Logger) {
    super(logger, 1); // 1-slot pool
    this.model = model;
  }

  async activate(): Promise<void> {
    this.logger.info('CommandPool: activating');
    await this.loadSdk();
    if (!this.sdkAvailable) {
      this.logger.error('CommandPool: SDK not available, skipping slot init');
      return;
    }

    this.logger.info('CommandPool: initializing pool...');
    await this.initAllSlots();
    this.logger.info('CommandPool: pool ready');
  }

  updateModel(model: string): void {
    if (this.model === model) {
      return;
    }
    this.model = model;
    this.logger.info(`CommandPool: model changed to ${model}, recycling`);
    this.recycleAll().catch((err) => {
      this.logger.error(`CommandPool: recycleAll failed: ${err}`);
    });
  }

  /** Get the current model for ledger/logging purposes. */
  getCurrentModel(): string {
    return this.model;
  }

  /**
   * Send a prompt to the command pool and wait for the response.
   * Returns null text if the pool is unavailable, timed out, or cancelled.
   *
   * If the CLI returns "Prompt is too long" (conversation history exceeded
   * context limit), the pool is recycled and the request is retried once.
   */
  async sendPrompt(message: string, options?: SendPromptOptions): Promise<SendPromptResult> {
    const result = await this._doSendPrompt(message, options);

    // Retry once on context overflow — recycle the pool to get a fresh subprocess
    if (result.text?.trim() === PROMPT_TOO_LONG) {
      this.logger.info('CommandPool: prompt too long (context overflow), recycling and retrying');
      await this.recycleAll();
      return this._doSendPrompt(message, options);
    }

    return result;
  }

  private async _doSendPrompt(
    message: string,
    options?: SendPromptOptions,
  ): Promise<SendPromptResult> {
    if (!this.queryFn || !this.isAvailable()) {
      return { text: null, meta: null };
    }

    // Acquire an available slot (marks it busy before returning)
    const slotIndex = await this.acquireSlot();
    if (slotIndex === null) {
      return { text: null, meta: null };
    }

    const slot = this.slots[slotIndex];

    // Guard: slot may have been disposed between acquireSlot and here
    if (!slot.channel || !slot.resultPromise) {
      return { text: null, meta: null };
    }

    this.logger.traceBlock('→ command sent', message);

    // Push the command into the slot's channel
    slot.channel.push(message);

    // Flag to prevent race between timeout/cancel and real result.
    // Set atomically when the winning promise resolves.
    let resolved = false;

    // Wrap slot.resultPromise to set resolved atomically on win
    const resultWithFlag = slot.resultPromise.then((result) => {
      resolved = true;
      return result;
    });

    // Build race promises
    const promises: Promise<string | null>[] = [resultWithFlag];

    // Optional timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs) {
      const timeoutPromise = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          // Timeout: deliver null to unblock, close channel to force recycle
          slot.deliverResult?.(null);
          slot.channel?.close();
          resolve(null);
        }, options.timeoutMs);
      });
      promises.push(timeoutPromise);
    }

    // Optional cancellation
    let cancelCleanup: (() => void) | undefined;
    if (options?.onCancel) {
      // Check if already aborted — clean up slot to prevent "busy forever" leak
      if (options.onCancel.aborted) {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        slot.deliverResult?.(null);
        slot.channel?.close();
        return { text: null, meta: null };
      }
      const cancelPromise = new Promise<null>((resolve) => {
        const onAbort = () => {
          if (resolved) return;
          resolved = true;
          // Clean up slot to prevent "busy forever" leak — matches timeout behavior
          slot.deliverResult?.(null);
          slot.channel?.close();
          resolve(null);
        };
        options.onCancel!.addEventListener('abort', onAbort);
        cancelCleanup = () => options.onCancel!.removeEventListener('abort', onAbort);
      });
      promises.push(cancelPromise);
    }

    // Race for the result
    const raw = await Promise.race(promises);

    // Cleanup
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    cancelCleanup?.();

    // Get metadata
    const meta = slot.lastResultMeta;
    slot.lastResultMeta = null;

    this.logger.traceBlock('← command response', raw ?? '(null)');

    return { text: raw, meta };
  }

  // --- SlotPool abstract method implementations ---

  protected getSystemPrompt(): string {
    return COMMAND_SYSTEM_PROMPT;
  }

  protected getModel(): string {
    return this.model;
  }

  protected getMaxReuses(): number {
    return MAX_COMMAND_REUSES;
  }

  protected getPoolLabel(): string {
    return 'CommandPool';
  }

  protected buildWarmupMessage(): string {
    return WARMUP_MESSAGE;
  }

  protected validateWarmupResponse(raw: string): boolean {
    return raw.trim().toLowerCase().includes('ready');
  }
}
