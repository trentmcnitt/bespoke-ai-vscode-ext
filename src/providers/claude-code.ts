import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { postProcessCompletion } from '../utils/post-process';
import { SlotPool } from './slot-pool';
import { composeSystemPrompt, buildFillMessage, extractCompletion } from './prompt-strategy';
import {
  CompletionWithDetail,
  GenerationContent,
  GenerationDetail,
  GenerationOptions,
} from '../utils/trace';

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

    this.logger.debug('Claude Code: initializing pool...');
    await this.initAllSlots();
    this.logger.info(`Claude Code: pool ready (${this.poolSize} slots)`);
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    return (await this.getCompletionWithDetail(context, signal)).text;
  }

  async getCompletionWithDetail(
    context: CompletionContext,
    _signal: AbortSignal,
    options?: GenerationOptions,
  ): Promise<CompletionWithDetail> {
    const detail: GenerationDetail = {
      providerName: 'anthropic',
      requestModel: this.config.claudeCode.model,
    };
    if (!this.queryFn) {
      return { text: null, detail: { ...detail, errorType: 'sdk_unavailable' } };
    }

    // Acquire an available slot (marks it busy before returning)
    const acquireStart = Date.now();
    const slotIndex = await this.acquireSlot();
    if (slotIndex === null) {
      // Superseded by a newer request (latest-request-wins) or the pool was disposed.
      return { text: null, detail: { ...detail, aborted: true } };
    }
    // Time spent waiting for the pool (busy slot or recycle-in-progress), as
    // distinct from inference time — keeps speed reports diagnosable (#22).
    const waitMs = Date.now() - acquireStart;
    detail.waitMs = waitMs;
    if (waitMs > 100) {
      this.logger.debug(
        `Claude Code: waited ${waitMs}ms for a slot (pool busy or recycling) before sending request`,
      );
    }

    const slot = this.slots[slotIndex];

    const message = buildFillMessage(context.prefix, context.suffix, context.languageId);
    const content: GenerationContent | undefined = options?.captureContent
      ? { systemPrompt: this.getSystemPrompt(), userMessage: message }
      : undefined;
    if (content) detail.content = content;

    this.logger.traceInline('slot', String(slotIndex));
    this.logger.traceBlock('→ sent', message);

    // Guard: slot may have been disposed between acquireSlot and here
    if (!slot.channel || !slot.resultPromise) {
      return { text: null, detail: { ...detail, aborted: true } };
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
      waitMs: waitMs > 0 ? waitMs : undefined,
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

    if (meta) {
      detail.responseModel = meta.model || undefined;
      detail.inputTokens = meta.inputTokens;
      detail.outputTokens = meta.outputTokens;
      detail.cacheReadTokens = meta.cacheReadTokens;
      detail.cacheWriteTokens = meta.cacheCreationTokens;
      detail.costUsd = meta.turnCostUsd;
      detail.durationApiMs = meta.durationApiMs;
      detail.finishReason = meta.stopReason;
    } else {
      detail.durationApiMs = wallDuration;
    }
    if (content) content.rawOutput = raw;

    this.logger.traceBlock('← raw', raw ?? '(null)');

    if (!raw) {
      return { text: null, detail };
    }

    // Extract content from <COMPLETION> tags
    const extracted = extractCompletion(raw);
    if (extracted !== raw) {
      this.logger.traceBlock('← extracted', extracted);
    }
    if (content) content.extracted = extracted;

    // Run standard post-processing (prefix enables overlap trimming if model echoes the line fragment)
    const result = postProcessCompletion(extracted, context.prefix, context.suffix, context.mode);

    if (result !== extracted) {
      this.logger.traceBlock('← processed', result ?? '(null)');
    }

    return { text: result, detail };
  }

  // --- SlotPool abstract method implementations ---

  protected getSystemPrompt(): string {
    return composeSystemPrompt(this.config.customInstructions);
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
