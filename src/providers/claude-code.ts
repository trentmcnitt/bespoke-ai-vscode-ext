import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { createMessageChannel, MessageChannel } from '../utils/message-channel';
import { postProcessCompletion } from '../utils/post-process';

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

/** Build the per-request message from prefix + suffix context. */
export function buildFillMessage(prefix: string, suffix: string): string {
  return suffix.trim()
    ? `<incomplete_text>${prefix}>>>GAP_TO_FILL<<<${suffix}</incomplete_text>`
    : `<incomplete_text>${prefix}>>>GAP_TO_FILL<<<</incomplete_text>`;
}

export const SYSTEM_PROMPT = `You are a hole filling tool. You receive <incomplete_text> containing a >>>GAP_TO_FILL<<< marker. You respond with the replacement text wrapped in <output> tags.

In each example below, <incomplete_text> is the input and <output> is your response. Pay attention to new lines and spacing. The examples show correct output for the provided input:

Example 1:
What you receive:
<incomplete_text>I'm a fan of pangrams. Let me list some of my favorites:

- The quick brown fox jumps over the lazy dog.
- >>>GAP_TO_FILL<<<
- Five quacking zephyrs jolt my wax bed.</incomplete_text>
What you should output:
<output>Pack my box with five dozen liquor jugs.</output>

Example 2:
What you receive:
<incomplete_text>{
  "name": "my-project",
  "dependencies": {>>>GAP_TO_FILL<<<
  }
}</incomplete_text>
What you should output:
<output>
    "lodash": "^4.17.21"</output>

Example 3:
What you receive:
<incomplete_text>function add(a, b) {>>>GAP_TO_FILL<<<
}</incomplete_text>
What you should output:
<output>
  return a + b;</output>

Example 4:
What you receive:
<incomplete_text>The quic>>>GAP_TO_FILL<<< fox jumps over the lazy dog.</incomplete_text>
What you should output:
<output>k brown</output>

Example 5:
What you receive:
<incomplete_text>The project was completed >>>GAP_TO_FILL<<< the original deadline.</incomplete_text>
What you should output:
<output>two weeks ahead of</output>

Example 6:
What you receive:
<incomplete_text>## Getting Started

>>>GAP_TO_FILL<<<

### Prerequisites</incomplete_text>
What you should output:
<output>This guide walks you through the initial setup process.</output>

Example 7:
What you receive:
<incomplete_text>Steps to deploy:
1. Build the project
2. Run the tests
3. >>>GAP_TO_FILL<<<
4. Verify the deployment</incomplete_text>
What you should output:
<output>Push to production</output>

Example 8:
What you receive:
<incomplete_text>The results show >>>GAP_TO_FILL<<<

| Name  | Score |
| Alice | 95    |</incomplete_text>
What you should output:
<output>the following data:</output>

Example 9:
What you receive:
<incomplete_text>The quick brown fox jum>>>GAP_TO_FILL<<<

The lazy dog slept.</incomplete_text>
What you should output:
<output>ps over the fence.</output>

Match the voice, style, and content of the document. Use judgment to decide how much to output, ranging from: no output (there is no gap), just a small gap fill, or several sentences. Use your judgement.

Rules:
- Always wrap your fill text in <output> tags — nothing outside these tags is used
- Do not include code fences, commentary, or meta-text inside <output>
- Never repeat structural markers (like "- ", "* ", "1. ") that already appear before >>>GAP_TO_FILL<<< (see example 1 for correct behavior)
- Do not duplicate or elaborate on content that already exists after >>>GAP_TO_FILL<<< — provide only the bridging text needed (see example 8)
- You are not in a chat. You are part of a tool pipeline.
- Be helpful, not disruptive.
- Always output in the prescribed format.

Mistakes to avoid:
- Outting anything besides just the gap filling text wrapped with <output>
- Outputting something that doesn't naturally continue the >>>GAP_TO_FILL<<<

You are now starting your job as a gap filler, do not respond as a chat agent - only respond as a gap filler with no extraneous output:
`;

type SlotState = 'initializing' | 'ready' | 'busy' | 'recycling' | 'dead';

interface Slot {
  state: SlotState;
  channel: MessageChannel | null;
  /** Resolves with the next result from the stream consumer. */
  resultPromise: Promise<string | null> | null;
  /** Call to deliver a result from the background consumer. */
  deliverResult: ((value: string | null) => void) | null;
}

export class ClaudeCodeProvider implements CompletionProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryFn: ((...args: any[]) => any) | null = null;
  private sdkAvailable: boolean | null = null;
  private slots: [Slot, Slot] = [
    { state: 'dead', channel: null, resultPromise: null, deliverResult: null },
    { state: 'dead', channel: null, resultPromise: null, deliverResult: null },
  ];
  private nextSlot = 0;
  private workspaceRoot = '';

  constructor(private config: ExtensionConfig, private logger: Logger) {}

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
    await Promise.all([
      this.initSlot(0),
      this.initSlot(1),
    ]);

    this.logger.info('Claude Code: pool ready (2 slots)');
  }

  isAvailable(): boolean {
    return this.sdkAvailable === true;
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (!this.queryFn) { return null; }

    // Pick a ready slot: try preferred first, then the other, then wait
    const slotIndex = await this.acquireSlot(signal);
    if (slotIndex === null) { return null; }

    const slot = this.slots[slotIndex];

    const message = buildFillMessage(context.prefix, context.suffix);

    this.logger.traceInline('slot', String(slotIndex));
    this.logger.traceBlock('→ sent', message);

    slot.state = 'busy';

    try {
      // Push the completion request into the slot's channel
      slot.channel!.push(message);

      // Race the result against the abort signal
      const raw = await raceAbort(slot.resultPromise!, signal);

      this.logger.traceBlock('← raw', raw ?? '(null)');

      if (!raw) { return null; }

      // Extract content from <output> tags, then run standard post-processing
      const extracted = extractOutput(raw);
      if (extracted !== raw) {
        this.logger.traceBlock('← extracted', extracted);
      }
      const result = postProcessCompletion(extracted, undefined, context.suffix);

      if (result !== extracted) {
        this.logger.traceBlock('← processed', result ?? '(null)');
      }

      return result;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { return null; }
      throw err;
    } finally {
      // Always recycle the slot after use (fire-and-forget)
      slot.state = 'recycling';
      this.recycleSlot(slotIndex);
    }
  }

  /**
   * Try to acquire a ready slot. Checks preferred slot first (alternating),
   * then the other slot. If neither is ready, polls every 100ms up to 15s
   * for either slot to become ready. Returns null on abort or timeout.
   */
  private async acquireSlot(signal: AbortSignal): Promise<number | null> {
    const preferred = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % 2;

    // Fast path: preferred slot ready
    if (this.slots[preferred].state === 'ready') { return preferred; }
    // Fast path: other slot ready
    const other = (preferred + 1) % 2;
    if (this.slots[other].state === 'ready') { return other; }

    // Both busy/recycling — wait for one to become ready
    this.logger.trace(`waiting for slot (slot0=${this.slots[0].state}, slot1=${this.slots[1].state})`);
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      if (signal.aborted) { return null; }

      await new Promise(r => setTimeout(r, 100));

      // States change asynchronously via recycleSlot → initSlot
      if ((this.slots[preferred].state as SlotState) === 'ready') { return preferred; }
      if ((this.slots[other].state as SlotState) === 'ready') { return other; }
    }

    this.logger.debug('Claude Code: slot acquisition timed out (15s)');
    return null;
  }

  dispose(): void {
    for (let i = 0; i < 2; i++) {
      const slot = this.slots[i];
      slot.state = 'dead';
      slot.channel?.close();
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;
    }
    this.sdkAvailable = false;
    this.queryFn = null;
    this.logger.info('Claude Code provider: disposed');
  }

  private async loadSdk(): Promise<void> {
    try {
      if (this.sdkAvailable === false) { return; }

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
      this.logger.error(`Claude Code: Agent SDK not available — provider disabled (${err instanceof Error ? err.stack ?? err.message : err})`);
    }
  }

  private async initSlot(index: number): Promise<void> {
    const slot = this.slots[index];
    try {
      slot.state = 'initializing';

      const channel = createMessageChannel();
      slot.channel = channel;

      // Push a real fill-the-blank warmup to prime the session into the
      // text-filling pattern (response is discarded, but sets conversation history)
      const warmup = buildFillMessage('Two plus two equals ', '.');
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

      // Start background consumer (eats warmup, then delivers real result)
      this.consumeStream(stream, index);

      // Wait briefly for warmup to establish the subprocess
      // The consumer will eat the warmup result and the slot stays ready
      // for the real completion message
      await this.waitForWarmup(index);

      this.logger.traceBlock('system prompt (slot ' + index + ')', SYSTEM_PROMPT);
      slot.state = 'ready';
    } catch (err) {
      slot.state = 'dead';
      this.logger.error(`Claude Code: slot ${index} init failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
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

  private async consumeStream(stream: AsyncIterable<unknown>, slotIndex: number): Promise<void> {
    try {
      let resultCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const message of stream as AsyncIterable<any>) {
        if (message.type === 'result') {
          resultCount++;
          const text: string | null = message.subtype === 'success' ? (message.result ?? null) : null;

          if (resultCount === 1) {
            // Warmup result — discard, signal that slot is warm
            this.logger.traceBlock(`warmup ← recv (slot ${slotIndex})`, text ?? '(null)');
            this._warmupResolvers[slotIndex]?.();
            this._warmupResolvers[slotIndex] = null;
            continue;
          }

          // Real completion result — deliver to the waiting getCompletion caller
          this.slots[slotIndex].deliverResult?.(text);
          break;
        }
      }
    } catch (err) {
      this.logger.error(`Claude Code: stream error on slot ${slotIndex}: ${err instanceof Error ? err.stack ?? err.message : err}`);
      this.slots[slotIndex].deliverResult?.(null);
      // Also resolve warmup if still pending
      this._warmupResolvers[slotIndex]?.();
      this._warmupResolvers[slotIndex] = null;
    }
  }

  private recycleSlot(index: number): void {
    const slot = this.slots[index];
    // Close old channel (kills subprocess)
    slot.channel?.close();
    slot.channel = null;
    slot.resultPromise = null;
    slot.deliverResult = null;

    // Spawn fresh session in background
    this.initSlot(index).catch((err) => {
      this.logger.error(`Claude Code: slot ${index} recycle failed: ${err}`);
    });
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener('abort', onAbort); resolve(val); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
