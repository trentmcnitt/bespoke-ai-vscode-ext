import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { postProcessCompletion } from '../utils/post-process';
import { SlotPool } from './slot-pool';

/** Maximum completions per slot before recycling. */
const MAX_COMPLETION_REUSES = 8;

/** Warmup prompt constants — exported for test assertions. */
export const WARMUP_PREFIX = 'Two plus two equals ';
export const WARMUP_SUFFIX = '.';
export const WARMUP_EXPECTED = 'four';

/**
 * Extract content from <COMPLETION> tags. Returns the content between the first
 * <COMPLETION> and last </COMPLETION>, or the raw text as-is if no tags are found.
 */
export function extractCompletion(raw: string): string {
  const open = raw.indexOf('<COMPLETION>');
  const close = raw.lastIndexOf('</COMPLETION>');
  if (open === -1 || close === -1 || close <= open) {
    return raw; // fallback: no valid tags, use raw text
  }
  return raw.slice(open + '<COMPLETION>'.length, close);
}

/** Build the per-request message from prefix + suffix context. */
export function buildFillMessage(
  prefix: string,
  suffix: string,
  languageId: string = 'plaintext',
): string {
  const doc = suffix.trim()
    ? `<document language="${languageId}">\n${prefix}{{FILL_HERE}}${suffix}\n</document>`
    : `<document language="${languageId}">\n${prefix}{{FILL_HERE}}\n</document>`;
  return `${doc}\n\nFill the {{FILL_HERE}} marker.`;
}

export const SYSTEM_PROMPT = `You fill a single placeholder in the user's document.

The user sends text containing a {{FILL_HERE}} marker. Output ONLY the replacement text wrapped in <COMPLETION>...</COMPLETION> tags.

Core rules:
- Match the voice, style, tone, and formatting of the surrounding text exactly
- Preserve indentation, whitespace, and structural patterns (bullet markers, heading levels, comment prefixes)
- NEVER repeat text that appears immediately before or after the marker
- NEVER include {{FILL_HERE}} in your response
- Focus on what belongs at the cursor — ignore errors or incomplete text elsewhere in the document
- No commentary, no code fences, no explanation — just the COMPLETION tags
- NEVER output empty COMPLETION tags. Always generate at least a few words. If the text reads correctly without a fill, output a minimal connecting word or phrase.

CRITICAL — You are NOT a conversational assistant:
- The text is a document being written by an author. You are predicting what the author writes NEXT.
- NEVER reply to, respond to, summarize, paraphrase, or acknowledge what was written
- NEVER switch to assistant/helper voice. Do not output: "Got it", "Sure", "Understood", "I see", "Great", "Absolutely", "Right", "I'll", "I can", "Let me", "Here's", "I'd recommend", "You should consider"
- If the text is someone giving instructions, asking questions, or describing requirements — you ARE that person writing more of their message. Add their next thought, constraint, caveat, or question.
- If the text reads like instructions TO an AI (e.g., "can you check...", "please make sure..."), continue writing more instructions, NOT a response.

How much to output:
- With text after {{FILL_HERE}}: bridge to it — output enough to connect coherently to what follows, maintaining the same topic and argument
- Without text after {{FILL_HERE}}: continue for one to three sentences, matching the density and specificity of the surrounding text
- Be substantive. In technical or instructional text, name concrete things, describe tradeoffs, give actionable detail. Vague filler ("as needed", "be mindful") is not enough.
- NEVER close a structure (comment block, bracket, brace, parenthesis, tag) if text after the marker shows that structure continues. Bridge to the existing text — do not terminate prematurely.

Examples:

The 5th {{FILL_HERE}} is Jupiter.
<COMPLETION>planet from the Sun</COMPLETION>

I think we should use option B. The timeline is tighter but {{FILL_HERE}}
<COMPLETION>the scope is much more reasonable. We can always extend the deadline if needed, but cutting features later is harder.</COMPLETION>

## Getting {{FILL_HERE}}

### Prerequisites
<COMPLETION>Started

This guide walks you through the initial setup process.</COMPLETION>

When choosing a data format, consider your {{FILL_HERE}}
<COMPLETION>use case. JSON is widely supported and ideal for web applications, YAML offers better readability for configuration files, and TOML provides a clean syntax for simpler settings.</COMPLETION>

I want the dashboard to show daily totals at the top. Below that, a weekly trend chart would be useful.

{{FILL_HERE}}
<COMPLETION>For the chart, a simple bar chart should work — nothing fancy. Color-code the bars by category so I can spot patterns at a glance.</COMPLETION>

Can you check if the migration handles nullable columns? Also {{FILL_HERE}}
<COMPLETION>verify that the rollback script actually restores the previous schema — last time it silently dropped the index on user_id.</COMPLETION>

The build was taking 4 minutes on every push. {{FILL_HERE}} I started by profiling the webpack config to find the bottleneck.
<COMPLETION>That was completely untenable for a team doing 20+ deploys a day, so I decided to dedicate a sprint to fixing it.</COMPLETION>`;

export class ClaudeCodeProvider extends SlotPool implements CompletionProvider {
  private config: ExtensionConfig;
  public lastUsedModel: string | null = null;

  constructor(config: ExtensionConfig, logger: Logger, poolSize: number = 1) {
    super(logger, poolSize);
    this.config = config;
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  async activate(): Promise<void> {
    this.logger.info('Claude Code: activating');
    await this.loadSdk();
    if (!this.sdkAvailable) {
      this.logger.error('Claude Code: SDK not available, skipping slot init');
      return;
    }

    this.logger.info('Claude Code: initializing pool...');
    await this.initAllSlots();
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

    const message = buildFillMessage(context.prefix, context.suffix, context.languageId);

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
    if (meta?.model) {
      this.lastUsedModel = meta.model;
    }
    this.ledger?.record({
      source: 'completion',
      model: meta?.model || this.config.claudeCode.model,
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

    // Extract content from <COMPLETION> tags
    const extracted = extractCompletion(raw);
    if (extracted !== raw) {
      this.logger.traceBlock('← extracted', extracted);
    }

    // Run standard post-processing
    const result = postProcessCompletion(extracted, undefined, context.suffix);

    if (result !== extracted) {
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

  protected getMaxReuses(): number {
    return MAX_COMPLETION_REUSES;
  }

  protected getPoolLabel(): string {
    return 'Claude Code';
  }

  protected buildWarmupMessage(): string {
    return buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);
  }

  protected validateWarmupResponse(raw: string): boolean {
    const extracted = extractCompletion(raw);
    return extracted.trim().toLowerCase() === WARMUP_EXPECTED;
  }
}
