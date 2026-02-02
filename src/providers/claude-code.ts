import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { postProcessCompletion } from '../utils/post-process';
import { SlotPool } from './slot-pool';

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

export class ClaudeCodeProvider extends SlotPool implements CompletionProvider {
  private config: ExtensionConfig;
  private workspaceRoot = '';

  constructor(config: ExtensionConfig, logger: Logger, poolSize: number = 2) {
    super(logger, poolSize);
    this.config = config;
  }

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
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));

    this.logger.info(`Claude Code: pool ready (${this.poolSize} slots)`);
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

  // --- SlotPool abstract method implementations ---

  protected getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  protected getModel(): string {
    return this.config.claudeCode.model;
  }

  protected getCwd(): string {
    return this.workspaceRoot;
  }

  protected getMaxReuses(): number {
    return 8;
  }

  protected getPoolLabel(): string {
    return 'Claude Code';
  }

  protected buildWarmupMessage(): string {
    return buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX).message;
  }

  protected validateWarmupResponse(raw: string): boolean {
    const { completionStart: warmupCS } = buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);
    const extracted = extractOutput(raw);
    const stripped = stripCompletionStart(extracted, warmupCS);
    const normalized = stripped?.trim().toLowerCase() ?? '';
    return normalized === WARMUP_EXPECTED;
  }
}
