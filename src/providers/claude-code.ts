import * as path from 'path';
import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { createMessageChannel, MessageChannel } from '../utils/message-channel';
import { postProcessCompletion } from '../utils/post-process';
import { UsageLedger } from '../utils/usage-ledger';

/** How many characters to extract from the end of the prefix as the completion start.
 * Kept short so <current_text> retains maximum context — the model needs to see most
 * of the prefix to understand the cursor position and generate relevant text. */
const COMPLETION_START_LENGTH = 10;

/** Warmup prompt constants — exported for test assertions. */
export const WARMUP_PREFIX = 'Two plus two equals ';
export const WARMUP_SUFFIX = '.';
export const WARMUP_EXPECTED = 'four';

/**
 * Extract content from <output> tags. Returns the content between the first
 * <output> and last </output>, or the raw text as-is if no tags are found.
 */
export function extractOutput(raw: string): string {
  const open = raw.indexOf('<output>');
  const close = raw.lastIndexOf('</output>');
  if (open === -1 || close === -1 || close <= open) {
    return raw; // fallback: no valid tags, use raw text
  }
  return raw.slice(open + '<output>'.length, close);
}

/**
 * Extract the completion start from the end of the prefix.
 * Returns the truncated prefix (for display) and the completion start text.
 */
export function extractCompletionStart(prefix: string): {
  truncatedPrefix: string;
  completionStart: string;
} {
  if (prefix.length <= COMPLETION_START_LENGTH) {
    return { truncatedPrefix: '', completionStart: prefix };
  }
  // Search forward from the ideal cut point for a word boundary (space or
  // newline) so <current_text> ends at a complete word before >>>CURSOR<<<.
  // Forward search keeps completion_start ≤ COMPLETION_START_LENGTH chars,
  // which is easier for the model to echo back reliably.
  const idealCut = prefix.length - COMPLETION_START_LENGTH;
  let cutPoint = idealCut;
  for (let i = idealCut; i < Math.min(prefix.length, idealCut + COMPLETION_START_LENGTH); i++) {
    if (prefix[i] === ' ' || prefix[i] === '\n') {
      cutPoint = i;
      break;
    }
  }
  return {
    truncatedPrefix: prefix.slice(0, cutPoint),
    completionStart: prefix.slice(cutPoint),
  };
}

/**
 * Strip the completion start from the model's output.
 * The model is instructed to begin its output with the completion start text.
 * We remove it to get the actual text to insert at the cursor.
 */
export function stripCompletionStart(output: string, completionStart: string): string | null {
  if (!completionStart) {
    return output;
  }
  if (output.startsWith(completionStart)) {
    return output.slice(completionStart.length);
  }
  // Model didn't follow instruction - return null to indicate failure
  return null;
}

/** Build the per-request message from prefix + suffix context. */
export function buildFillMessage(
  prefix: string,
  suffix: string,
): { message: string; completionStart: string } {
  const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);

  const currentText = suffix.trim()
    ? `<current_text>${truncatedPrefix}>>>CURSOR<<<${suffix}</current_text>`
    : `<current_text>${truncatedPrefix}>>>CURSOR<<<</current_text>`;

  const message = `${currentText}\n<completion_start>${completionStart}</completion_start>`;

  return { message, completionStart };
}

export const SYSTEM_PROMPT = `You are an autocomplete tool.

You receive:
1. <current_text> with a >>>CURSOR<<< marker showing the insertion point
2. <completion_start> containing text that your output MUST begin with

Your task: Generate <output> containing text that:
- Starts EXACTLY with the text in <completion_start> (character-for-character)
- Continues naturally from there
- Fits the context and style of the document

Rules:
- Your <output> MUST begin with the exact <completion_start> text
- Continue naturally based on surrounding context
- If no continuation makes sense, output just the <completion_start> text unchanged
- Match voice, style, and format of the existing text
- Focus on what belongs at the cursor — ignore errors or incomplete text elsewhere

Output Requirements:
- Wrap response in <output> tags
- No unnecessary code fences, commentary, or meta-text
- Preserve whitespace exactly — <completion_start> may include spaces or newlines

How much to output:
- If the text is already complete, output just the <completion_start> text unchanged
- If there is a clear gap to bridge to the text after >>>CURSOR<<<, output just enough to bridge it
- If there is no text after >>>CURSOR<<<, continue naturally for a sentence or two (or a few lines of code)

---

Examples:

### Continuing a bullet list
<current_text>My favorite pangrams:

- The quick brown fox jumps over the lazy dog.
>>>CURSOR<<<
- Five quacking zephyrs jolt my wax bed.</current_text>
<completion_start>- </completion_start>
<output>- Pack my box with five dozen liquor jugs.</output>

### Continuing a numbered list
<current_text>Steps to deploy:
1. Build the project
2. Run the tests
>>>CURSOR<<<
4. Verify the deployment</current_text>
<completion_start>3. </completion_start>
<output>3. Push to production</output>

### Filling in JSON
<current_text>{
  "name": "my-project",
  "dependencies>>>CURSOR<<<
  }
}</current_text>
<completion_start>": {</completion_start>
<output>": {
    "lodash": "^4.17.21"</output>

### Filling in a code function
<current_text>function add(a, b>>>CURSOR<<<
}</current_text>
<completion_start>) {</completion_start>
<output>) {
  return a + b;</output>

### Bridging text
<current_text>The project >>>CURSOR<<< the original deadline.</current_text>
<completion_start>was completed </completion_start>
<output>was completed two weeks ahead of</output>

### Completing a partial word
<current_text>>>>CURSOR<<< fox jumps over the lazy dog.</current_text>
<completion_start>The quic</completion_start>
<output>The quick brown</output>

### Adding content between headings
<current_text>## Getting >>>CURSOR<<<

### Prerequisites</current_text>
<completion_start>Started

</completion_start>
<output>Started

This guide walks you through the initial setup process.</output>

### Introducing content before a table
<current_text>The >>>CURSOR<<<

| Name  | Score |
| Alice | 95    |</current_text>
<completion_start>results show </completion_start>
<output>results show the following data:</output>

### Filling in a table row
<current_text>| Name  | Score |
| Alice | 95    |
>>>CURSOR<<<
| Carol | 88    |</current_text>
<completion_start>
</completion_start>
<output>
| Bob   | 91    |</output>

### Completing a partial word with unrelated content below
<current_text>The quick brown >>>CURSOR<<<

---
## Next Section</current_text>
<completion_start>fox jum</completion_start>
<output>fox jumped over the lazy dog.</output>

### Pure continuation (no suffix)
<current_text>The benefits of this approach include:

>>>CURSOR<<<</current_text>
<completion_start>- </completion_start>
<output>- Improved performance and reduced complexity.</output>

### No continuation needed
<current_text>She finished her >>>CURSOR<<< and left.</current_text>
<completion_start>coffee</completion_start>
<output>coffee</output>

### Ignoring incomplete content elsewhere
<current_text>## Configuration

All settings are >>>CURSOR<<<

## API Reference

The response includes (e.g., \`user.json\`,</current_text>
<completion_start>now configured.</completion_start>
<output>now configured.</output>

### Continuing despite errors elsewhere
<current_text>Key benefits:

- Improved performance
>>>CURSOR<<<
- Reduced complxity and maintainability</current_text>
<completion_start>- </completion_start>
<output>- Enhanced reliability</output>

---

Now output only <output> tags:
`;

type SlotState = 'initializing' | 'available' | 'busy' | 'dead';

interface ResultMetadata {
  durationMs: number;
  durationApiMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionId: string;
}

interface Slot {
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
  /** SDK metadata from the most recent result message, read by getCompletion(). */
  lastResultMeta: ResultMetadata | null;
}

export class ClaudeCodeProvider implements CompletionProvider {
  /** Recycle a slot after this many completions to keep sessions fresh.
   * Intentionally lower than the SDK's maxTurns (50) to limit drift. */
  static readonly MAX_REUSES = 8;
  /** Circuit breaker: max rapid recycles before marking a slot dead. */
  static readonly RAPID_RECYCLE_LIMIT = 5;
  /** Circuit breaker: time window (ms) for counting rapid recycles. */
  static readonly RAPID_RECYCLE_WINDOW_MS = 5_000;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryFn: ((...args: any[]) => any) | null = null;
  private sdkAvailable: boolean | null = null;
  private slots: Slot[];
  private nextSlot = 0;
  private workspaceRoot = '';
  private ledger: UsageLedger | null = null;
  /** Single-waiter queue: only one request can wait for a slot at a time. */
  private pendingWaiter: ((index: number | null) => void) | null = null;
  /** Deduplicates overlapping recycleAll calls. */
  private _recyclePromise: Promise<void> | null = null;
  private _warmupResolvers: (((ok: boolean) => void) | null)[];
  private _warmupFailureCount = 0;
  private _warmupFailureHandled = false;

  /** Called when the pool is fully degraded (all warmup retries exhausted). */
  onPoolDegraded: (() => void) | null = null;

  constructor(
    private config: ExtensionConfig,
    private logger: Logger,
    private poolSize: number = 2,
  ) {
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

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  setLedger(ledger: UsageLedger): void {
    this.ledger = ledger;
  }

  async activate(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    this.logger.info(`Claude Code: activating (cwd=${workspaceRoot})`);
    await this.loadSdk();
    if (!this.sdkAvailable) {
      this.logger.error('Claude Code: SDK not available, skipping slot init');
      return;
    }

    this.logger.info('Claude Code: initializing pool...');
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));

    this.logger.info(`Claude Code: pool ready (${this.poolSize} slots)`);
  }

  isAvailable(): boolean {
    return this.sdkAvailable === true;
  }

  async getCompletion(context: CompletionContext, _signal: AbortSignal): Promise<string | null> {
    if (!this.queryFn) {
      return null;
    }

    // Acquire an available slot (marks it busy before returning)
    const slotIndex = await this.acquireSlot();
    if (slotIndex === null) {
      return null;
    }

    const slot = this.slots[slotIndex];

    const { message, completionStart } = buildFillMessage(context.prefix, context.suffix);

    this.logger.traceInline('slot', String(slotIndex));
    this.logger.traceBlock('→ sent', message);

    // Guard: slot may have been disposed between acquireSlot and here
    if (!slot.channel || !slot.resultPromise) {
      return null;
    }

    // Push the completion request into the slot's channel
    slot.channel.push(message);

    // Await the result unconditionally — the consumer owns the slot lifecycle
    const startTime = Date.now();
    const raw = await slot.resultPromise;
    const wallDuration = Date.now() - startTime;

    // Record completion in ledger
    const meta = slot.lastResultMeta;
    slot.lastResultMeta = null;
    this.ledger?.record({
      source: 'completion',
      model: this.config.claudeCode.model,
      project: this.projectName,
      durationMs: meta?.durationMs ?? wallDuration,
      durationApiMs: meta?.durationApiMs,
      inputTokens: meta?.inputTokens,
      outputTokens: meta?.outputTokens,
      cacheReadTokens: meta?.cacheReadTokens,
      cacheCreationTokens: meta?.cacheCreationTokens,
      costUsd: meta?.costUsd,
      inputChars: context.prefix.length + context.suffix.length,
      outputChars: raw?.length ?? 0,
      slotIndex,
      sessionId: meta?.sessionId,
    });

    this.logger.traceBlock('← raw', raw ?? '(null)');

    if (!raw) {
      return null;
    }

    // Extract content from <output> tags
    const extracted = extractOutput(raw);
    if (extracted !== raw) {
      this.logger.traceBlock('← extracted', extracted);
    }

    // Strip the completion start from the output
    const stripped = stripCompletionStart(extracted, completionStart);
    if (stripped === null) {
      this.logger.debug(
        `completion start mismatch: expected "${completionStart.slice(0, 20)}...", got "${extracted.slice(0, 20)}..."`,
      );
      return null;
    }
    if (stripped !== extracted) {
      this.logger.traceBlock('← stripped', stripped);
    }

    // Run standard post-processing. Prefix is undefined because the completion start
    // has already been stripped — trimPrefixOverlap has no prefix to compare against.
    const result = postProcessCompletion(stripped, undefined, context.suffix);

    if (result !== stripped) {
      this.logger.traceBlock('← processed', result ?? '(null)');
    }

    return result;
  }

  /**
   * Acquire an available slot. Returns the slot index (already marked busy)
   * or null if cancelled by a newer waiter.
   *
   * Fast path: find any available slot, mark busy, return.
   * Slow path: register as single waiter. A new arrival cancels the previous
   * waiter (resolve(null)), so only the most recent request waits.
   */
  private async acquireSlot(): Promise<number | null> {
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
  private notifyWaiter(slotIndex: number): boolean {
    if (!this.pendingWaiter) {
      return false;
    }
    const waiter = this.pendingWaiter;
    this.pendingWaiter = null;
    this.slots[slotIndex].state = 'busy';
    waiter(slotIndex);
    return true;
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

  private async _doRecycleAll(): Promise<void> {
    this._warmupFailureCount = 0;
    this._warmupFailureHandled = false;
    this.logger.info('Claude Code: recycling all slots');
    this.killAllSlots();

    // Reinitialize all slots
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));
    this.logger.info('Claude Code: pool recycled');
  }

  dispose(): void {
    this.killAllSlots();
    this.sdkAvailable = false;
    this.queryFn = null;
    this.logger.info('Claude Code provider: disposed');
  }

  /**
   * Kill all slots immediately. Cancels pending waiters, resolves in-flight
   * deliverResult and warmup promises, closes channels, marks all slots dead.
   */
  private killAllSlots(): void {
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

  private async loadSdk(): Promise<void> {
    try {
      if (this.sdkAvailable === false) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = await (import('@anthropic-ai/claude-agent-sdk') as Promise<any>);
      const queryFn = sdk.query ?? sdk.default?.query;
      if (!queryFn) {
        this.logger.error('Claude Code: Agent SDK does not export query()');
        this.sdkAvailable = false;
        return;
      }

      this.queryFn = queryFn;
      this.sdkAvailable = true;
      this.logger.info('Claude Code: SDK loaded');
    } catch (err) {
      this.sdkAvailable = false;
      this.logger.error(
        `Claude Code: Agent SDK not available — provider disabled (${err instanceof Error ? (err.stack ?? err.message) : err})`,
      );
    }
  }

  private async initSlot(index: number): Promise<void> {
    const slot = this.slots[index];
    try {
      slot.state = 'initializing';
      slot.resultCount = 0;

      const channel = createMessageChannel();
      slot.channel = channel;

      // Push a warmup using the new format to prime the session
      const { message: warmup } = buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);
      channel.push(warmup);
      this.logger.traceBlock(`warmup → sent (slot ${index})`, warmup);

      // Start streaming query — it consumes messages from the channel.
      // The SDK resolves cli.js via import.meta.url, which is undefined when
      // loaded via require() in a CJS bundle. Pass the path explicitly.
      const sdkCliPath = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
      const stream = this.queryFn!({
        prompt: channel.iterable,
        options: {
          model: this.config.claudeCode.model,
          tools: [],
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: SYSTEM_PROMPT,
          cwd: this.workspaceRoot,
          settingSources: [],
          maxThinkingTokens: 0,
          maxTurns: 50,
          persistSession: false,
          pathToClaudeCodeExecutable: sdkCliPath,
        },
      });

      // Set up promise that the getCompletion caller will await
      this.resetResultPromise(slot);

      // Start background consumer (eats warmup, then delivers real results)
      this.consumeStream(stream, index);

      // Wait for warmup to establish the subprocess and validate
      const warmupOk = await this.waitForWarmup(index);

      this.logger.traceBlock('system prompt (slot ' + index + ')', SYSTEM_PROMPT);

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
        model: this.config.claudeCode.model,
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
        `Claude Code: slot ${index} init failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
    }
  }

  /** Extract SDK metadata from a result message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractMetadata(message: any): ResultMetadata {
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
  private get projectName(): string {
    return this.workspaceRoot ? path.basename(this.workspaceRoot) : '';
  }

  private resetResultPromise(slot: Slot): void {
    slot.resultPromise = new Promise<string | null>((resolve) => {
      slot.deliverResult = resolve;
    });
  }

  private waitForWarmup(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      // Store a callback that the consumer calls after validating the warmup result.
      // Resolves true on success, false on validation failure.
      this._warmupResolvers[index] = resolve;
    });
  }

  /**
   * Background consumer loop. Eats the warmup result, then loops delivering
   * real completion results. After MAX_REUSES completions or on stream error,
   * recycles the slot (finally block).
   */
  private async consumeStream(stream: AsyncIterable<unknown>, slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    const myGeneration = slot.generation;
    try {
      let resultCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const message of stream as AsyncIterable<any>) {
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
              model: this.config.claudeCode.model,
              project: this.projectName,
              durationMs: meta.durationMs,
              durationApiMs: meta.durationApiMs,
              inputTokens: meta.inputTokens,
              outputTokens: meta.outputTokens,
              cacheReadTokens: meta.cacheReadTokens,
              cacheCreationTokens: meta.cacheCreationTokens,
              costUsd: meta.costUsd,
              inputChars: WARMUP_PREFIX.length + WARMUP_SUFFIX.length,
              outputChars: text?.length ?? 0,
              slotIndex,
              sessionId: meta.sessionId,
            });

            let warmupOk = false;
            if (text) {
              const { completionStart: warmupCS } = buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);
              const extracted = extractOutput(text);
              const stripped = stripCompletionStart(extracted, warmupCS);
              const normalized = stripped?.trim().toLowerCase() ?? '';
              if (normalized === WARMUP_EXPECTED) {
                warmupOk = true;
              } else {
                this.logger.error(
                  `warmup validation failed on slot ${slotIndex}: expected "${WARMUP_EXPECTED}", got "${normalized}" (raw: "${text.slice(0, 100)}")`,
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

          // Store metadata for getCompletion() to read
          slot.lastResultMeta = meta;

          // Real completion result — deliver to the waiting getCompletion caller
          slot.resultCount++;
          slot.deliverResult?.(text);

          // Stop if disposed or hit reuse limit
          if (slot.state === 'dead') {
            break;
          }
          if (slot.resultCount >= ClaudeCodeProvider.MAX_REUSES) {
            this.logger.debug(
              `slot ${slotIndex} reached max reuses (${ClaudeCodeProvider.MAX_REUSES}), recycling`,
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
        `Claude Code: stream error on slot ${slotIndex}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
      slot.deliverResult?.(null);
      // Also resolve warmup if still pending (failure)
      this._warmupResolvers[slotIndex]?.(false);
      this._warmupResolvers[slotIndex] = null;
    } finally {
      // Stale consumer guard — if the slot generation changed, a recycleAll
      // (or similar) already replaced this slot. Don't touch the new one.
      if (this.slots[slotIndex].generation !== myGeneration) {
        return;
      }
      this.recycleSlot(slotIndex);
    }
  }

  private recycleSlot(index: number): void {
    const slot = this.slots[index];
    if (slot.state === 'dead') {
      return;
    } // already disposed

    // Circuit breaker: detect rapid consecutive recycles
    const now = Date.now();
    if (now - slot.lastRecycleTime < ClaudeCodeProvider.RAPID_RECYCLE_WINDOW_MS) {
      slot.rapidRecycleCount++;
    } else {
      slot.rapidRecycleCount = 1;
    }
    slot.lastRecycleTime = now;

    if (slot.rapidRecycleCount >= ClaudeCodeProvider.RAPID_RECYCLE_LIMIT) {
      this.logger.error(
        `Claude Code: slot ${index} recycled ${slot.rapidRecycleCount} times in < ${ClaudeCodeProvider.RAPID_RECYCLE_WINDOW_MS}ms — marking dead (circuit breaker)`,
      );
      slot.generation++;
      slot.state = 'dead';
      slot.channel?.close();
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;

      // Check if all slots are now dead → fire onPoolDegraded
      if (this.slots.every((s) => s.state === 'dead')) {
        this.logger.error('Claude Code: all slots dead (circuit breaker), pool degraded');
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
        this.logger.error(`Claude Code: slot ${index} recycle failed: ${err}`);
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
      `Claude Code: warmup failed on slot ${failedSlot} (attempt ${this._warmupFailureCount}/2)`,
    );

    this.killAllSlots();

    if (this._warmupFailureCount >= 2) {
      // Exhausted retries — shut down
      this.sdkAvailable = false;
      this.logger.error('Claude Code: warmup failed after retry, autocomplete disabled');
      this.onPoolDegraded?.();
    } else {
      // Retry once
      this.logger.info('Claude Code: retrying all slots after warmup failure...');
      setTimeout(() => {
        this._warmupFailureHandled = false;
        Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i))).catch(
          (err) => {
            this.logger.error(`Claude Code: warmup retry failed: ${err}`);
          },
        );
      }, 0);
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
      this.logger.error('Claude Code: SDK not available on restart');
      return;
    }

    this.logger.info('Claude Code: restarting pool...');
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));
    this.logger.info('Claude Code: pool restarted');
  }
}
