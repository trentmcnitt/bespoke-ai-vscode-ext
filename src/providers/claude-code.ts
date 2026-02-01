import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { createMessageChannel, MessageChannel } from '../utils/message-channel';
import { postProcessCompletion } from '../utils/post-process';

/** How many characters to extract from the end of the prefix as the completion start.
 * Kept short so <current_text> retains maximum context — the model needs to see most
 * of the prefix to understand the cursor position and generate relevant text. */
const COMPLETION_START_LENGTH = 10;

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
- No unnecssary code fences, commentary, or meta-text
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

interface Slot {
  state: SlotState;
  channel: MessageChannel | null;
  /** Resolves with the next result from the stream consumer. */
  resultPromise: Promise<string | null> | null;
  /** Call to deliver a result from the background consumer. */
  deliverResult: ((value: string | null) => void) | null;
  /** Number of completions delivered by this slot (excludes warmup). */
  resultCount: number;
}

export class ClaudeCodeProvider implements CompletionProvider {
  /** Recycle a slot after this many completions (warmup=1, maxTurns=50, leaves headroom). */
  static readonly MAX_REUSES = 24;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryFn: ((...args: any[]) => any) | null = null;
  private sdkAvailable: boolean | null = null;
  private slots: [Slot, Slot] = [
    { state: 'dead', channel: null, resultPromise: null, deliverResult: null, resultCount: 0 },
    { state: 'dead', channel: null, resultPromise: null, deliverResult: null, resultCount: 0 },
  ];
  private nextSlot = 0;
  private workspaceRoot = '';
  /** Single-waiter queue: only one request can wait for a slot at a time. */
  private pendingWaiter: ((index: number | null) => void) | null = null;

  constructor(
    private config: ExtensionConfig,
    private logger: Logger,
  ) {}

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
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
    await Promise.all([this.initSlot(0), this.initSlot(1)]);

    this.logger.info('Claude Code: pool ready (2 slots)');
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
    const raw = await slot.resultPromise;

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

    // Run standard post-processing
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
    for (let i = 0; i < 2; i++) {
      const idx = (this.nextSlot + i) % 2;
      if (this.slots[idx].state === 'available') {
        this.slots[idx].state = 'busy';
        this.nextSlot = (idx + 1) % 2;
        return idx;
      }
    }

    // Slow path: cancel existing waiter and register self
    if (this.pendingWaiter) {
      this.pendingWaiter(null);
    }

    this.logger.trace(
      `waiting for slot (slot0=${this.slots[0].state}, slot1=${this.slots[1].state})`,
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

  dispose(): void {
    // Cancel pending waiter
    if (this.pendingWaiter) {
      this.pendingWaiter(null);
      this.pendingWaiter = null;
    }
    for (let i = 0; i < 2; i++) {
      const slot = this.slots[i];
      slot.state = 'dead';
      slot.channel?.close();
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;
      slot.resultCount = 0;
    }
    this.sdkAvailable = false;
    this.queryFn = null;
    this.logger.info('Claude Code provider: disposed');
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
      const { message: warmup } = buildFillMessage('Two plus two equals ', '.');
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

      // Wait briefly for warmup to establish the subprocess
      await this.waitForWarmup(index);

      this.logger.traceBlock('system prompt (slot ' + index + ')', SYSTEM_PROMPT);
      slot.state = 'available';

      // If a request is already waiting, claim this slot for it
      this.notifyWaiter(index);
    } catch (err) {
      slot.state = 'dead';
      this.logger.error(
        `Claude Code: slot ${index} init failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
    }
  }

  private resetResultPromise(slot: Slot): void {
    slot.resultPromise = new Promise<string | null>((resolve) => {
      slot.deliverResult = resolve;
    });
  }

  private waitForWarmup(index: number): Promise<void> {
    return new Promise((resolve) => {
      // Store a callback that the consumer calls after eating the warmup result
      this._warmupResolvers[index] = resolve;
    });
  }

  private _warmupResolvers: ((() => void) | null)[] = [null, null];

  /**
   * Background consumer loop. Eats the warmup result, then loops delivering
   * real completion results. After MAX_REUSES completions or on stream error,
   * recycles the slot (finally block).
   */
  private async consumeStream(stream: AsyncIterable<unknown>, slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    try {
      let resultCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const message of stream as AsyncIterable<any>) {
        if (message.type === 'result') {
          resultCount++;
          const text: string | null =
            message.subtype === 'success' ? (message.result ?? null) : null;

          if (resultCount === 1) {
            // Warmup result — discard, signal that slot is warm
            this.logger.traceBlock(`warmup ← recv (slot ${slotIndex})`, text ?? '(null)');
            this._warmupResolvers[slotIndex]?.();
            this._warmupResolvers[slotIndex] = null;
            continue;
          }

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
      this.logger.error(
        `Claude Code: stream error on slot ${slotIndex}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
      slot.deliverResult?.(null);
      // Also resolve warmup if still pending
      this._warmupResolvers[slotIndex]?.();
      this._warmupResolvers[slotIndex] = null;
    } finally {
      this.recycleSlot(slotIndex);
    }
  }

  private recycleSlot(index: number): void {
    const slot = this.slots[index];
    if (slot.state === 'dead') {
      return;
    } // already disposed

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
}
