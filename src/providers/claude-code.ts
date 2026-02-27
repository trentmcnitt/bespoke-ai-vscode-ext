import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { postProcessCompletion } from '../utils/post-process';
import { SlotPool } from './slot-pool';
import { SYSTEM_PROMPT, buildFillMessage, extractCompletion } from './prompt-strategy';

// Re-export for backward compatibility — consumers that import from this module
// (tests, dump-prompts, prompt-variants) continue to work without changes.
export { SYSTEM_PROMPT, buildFillMessage, extractCompletion };

/** Maximum completions per slot before recycling. */
const MAX_COMPLETION_REUSES = 8;

/** Warmup prompt constants — exported for test assertions. */
export const WARMUP_PREFIX = 'Two plus two equals ';
export const WARMUP_SUFFIX = '.';
export const WARMUP_EXPECTED = 'four';

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

    // Run standard post-processing (prefix enables overlap trimming if model echoes the line fragment)
    const result = postProcessCompletion(extracted, context.prefix, context.suffix);

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
