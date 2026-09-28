import * as vscode from 'vscode';
import {
  CompletionContext,
  CompletionProvider as ICompletionProvider,
  ExtensionConfig,
} from './types';
import { detectMode } from './mode-detector';
import { buildDocumentContext } from './utils/context-builder';
import { LRUCache } from './utils/cache';
import { Debouncer } from './utils/debouncer';
import { Logger, generateRequestId } from './utils/logger';
import { UsageTracker } from './utils/usage-tracker';
import { getPreset } from './providers/api/presets';
import {
  CompletionWithDetail,
  GenerationDetail,
  TraceOutcome,
  TraceRecorder,
  detailFromError,
  errorTypeOf,
  genAiProviderName,
  newSpanId,
  nullResultOutcome,
  newTraceId,
} from './utils/trace';

/** Provider/model the config would route a request to — used when no detail is available. */
export function configuredTraceModel(
  config: ExtensionConfig,
  mode: 'prose' | 'code',
): { backend: 'claude-code' | 'api'; providerName: string; requestModel: string } {
  const override = mode === 'code' && config.codeOverride.backend ? config.codeOverride : null;
  const backend = (override?.backend || config.backend) as 'claude-code' | 'api';
  if (backend === 'api') {
    const presetId = override?.model || config.api.preset;
    const preset = getPreset(presetId);
    return {
      backend,
      providerName: preset ? genAiProviderName(preset.provider) : 'unknown',
      requestModel: preset?.modelId ?? presetId,
    };
  }
  return {
    backend,
    providerName: 'anthropic',
    requestModel: override?.model || config.claudeCode.model,
  };
}

/** Characters that suppress auto-completion when they are the last typed character.
 * In prose mode, these typically end a thought or open a new context where triggering
 * is unwanted. In code mode, many of these (., (, {, :, etc.) are useful trigger points
 * so only a conservative subset is suppressed. */
const PROSE_SUPPRESS_AFTER = new Set(['.', '?', '!', ';', '(', '[', '{', '"', "'", '`', ':', ',']);
const CODE_SUPPRESS_AFTER = new Set([';']);

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private provider: ICompletionProvider;
  private cache: LRUCache;
  private debouncer: Debouncer;
  private config: ExtensionConfig;
  private logger: Logger;
  private tracker?: UsageTracker;
  private onRequestStart?: () => void;
  private onRequestEnd?: () => void;
  private lastErrorToastTime = 0;
  private tracer?: TraceRecorder;

  constructor(
    config: ExtensionConfig,
    provider: ICompletionProvider,
    logger: Logger,
    tracker?: UsageTracker,
  ) {
    this.config = config;
    this.provider = provider;
    this.cache = new LRUCache();
    this.debouncer = new Debouncer(config.debounceMs);
    this.logger = logger;
    this.tracker = tracker;
  }

  /** Attach the per-request trace recorder (see utils/trace.ts). */
  setTraceRecorder(recorder: TraceRecorder | undefined): void {
    this.tracer = recorder;
  }

  setRequestCallbacks(onStart: () => void, onEnd: () => void): void {
    this.onRequestStart = onStart;
    this.onRequestEnd = onEnd;
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.debouncer.setDelay(config.debounceMs);
    this.provider.updateConfig?.(config);
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.info('Cache cleared');
  }

  async recyclePool(): Promise<void> {
    await this.provider.recycleAll?.();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    inlineContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (!this.config.enabled) {
      return null;
    }

    // In manual mode, only respond to explicit triggers (Alt+Enter / command palette)
    if (
      this.config.triggerMode === 'manual' &&
      inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
    ) {
      return null;
    }

    // Explicit triggers use zero delay
    const isExplicitTrigger =
      inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

    // Detect mode
    const mode = detectMode(document.languageId, this.config);

    // Build document context
    const contextChars =
      mode === 'code' ? this.config.code.contextChars : this.config.prose.contextChars;
    const suffixChars =
      mode === 'code' ? this.config.code.suffixChars : this.config.prose.suffixChars;
    const docContext = buildDocumentContext(document, position, contextChars, suffixChars);

    // Skip if no prefix content
    if (!docContext.prefix.trim()) {
      return null;
    }

    // Suppress after punctuation that typically ends a thought or opens a new context
    // Explicit triggers (Alt+Enter) bypass suppression — the user explicitly asked for a completion
    if (!isExplicitTrigger) {
      const suppressSet = mode === 'code' ? CODE_SUPPRESS_AFTER : PROSE_SUPPRESS_AFTER;
      const lastChar = docContext.prefix.slice(-1);
      if (suppressSet.has(lastChar)) {
        return null;
      }
    }

    const completionContext: CompletionContext = {
      ...docContext,
      mode,
    };

    // Generate request ID for log correlation
    const reqId = generateRequestId();
    const receivedAtMs = Date.now();

    // Check cache
    const cacheKey = LRUCache.makeKey(mode, docContext.prefix, docContext.suffix);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.cacheHit(reqId, cached.length);
      this.logger.traceBlock('← cached value', cached);
      this.tracker?.recordCacheHit();
      this.recordTrace(reqId, completionContext, 'cache_hit', receivedAtMs, receivedAtMs, {
        finalText: cached,
      });
      const item = new vscode.InlineCompletionItem(cached, new vscode.Range(position, position));
      this.logger.trace(
        `returning cache hit: insertText=${JSON.stringify(cached.slice(0, 50))}... range=${position.line}:${position.character}`,
      );
      return [item];
    }

    // Debounce — explicit triggers fire immediately (zero delay)
    const signal = await this.debouncer.debounce(token, isExplicitTrigger ? 0 : undefined);
    if (!signal || token.isCancellationRequested) {
      // Cancelled before anything was sent — not recorded (it would be pure noise).
      this.logger.trace(`#${reqId} debounce cancelled`);
      return null;
    }

    // Get completion from provider
    const startTime = Date.now();

    // Check provider availability
    // Mode-aware: a code-override preset has its own backend/breaker.
    if (!this.provider.isAvailable(mode)) {
      this.recordTrace(reqId, completionContext, 'error', receivedAtMs, startTime, {
        errorType: 'backend_unavailable',
      });
      return null;
    }

    // Log request start with structured format
    this.logger.requestStart(reqId, {
      mode,
      backend: this.config.backend ?? 'claude-code',
      file: docContext.fileName,
      prefixLen: docContext.prefix.length,
      suffixLen: docContext.suffix.length,
    });

    // Trace: input context
    this.logger.traceBlock('prefix', docContext.prefix);
    if (docContext.suffix) {
      this.logger.traceBlock('suffix', docContext.suffix);
    }

    this.tracker?.recordCacheMiss();
    this.onRequestStart?.();
    let detail: GenerationDetail | undefined;
    try {
      const response: CompletionWithDetail = this.provider.getCompletionWithDetail
        ? await this.provider.getCompletionWithDetail(completionContext, signal, {
            captureContent: this.tracer !== undefined && this.config.trace.captureContent,
          })
        : { text: await this.provider.getCompletion(completionContext, signal) };
      const result = response.text;
      detail = response.detail;
      const durationMs = Date.now() - startTime;

      if (!result) {
        const cancelled = token.isCancellationRequested || signal.aborted;
        this.logger.requestEnd(reqId, {
          durationMs,
          resultLen: null,
          cancelled: token.isCancellationRequested,
        });
        this.logger.trace(
          `#${reqId} returning null: result=${result === null ? 'null' : 'empty'}, cancelled=${token.isCancellationRequested}`,
        );
        const outcome: TraceOutcome = nullResultOutcome(detail, cancelled);
        this.recordTrace(reqId, completionContext, outcome, receivedAtMs, startTime, {
          detail,
          finalText: result,
        });
        return null;
      }

      this.logger.requestEnd(reqId, {
        durationMs,
        resultLen: result.length,
      });

      // Record successful completion in usage tracker
      const inputChars = docContext.prefix.length + docContext.suffix.length;
      const modelLabel =
        this.config.backend === 'api' ? this.config.api.preset : this.config.claudeCode.model;
      this.tracker?.record(modelLabel, inputChars, result.length);

      this.recordTrace(reqId, completionContext, 'ok', receivedAtMs, startTime, {
        detail,
        finalText: result,
      });

      // Cache and return
      this.cache.set(cacheKey, result);
      const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
      this.logger.trace(
        `returning completion: insertText=${JSON.stringify(result.slice(0, 50))}... range=${position.line}:${position.character}`,
      );
      return [item];
    } catch (err: unknown) {
      this.logger.error(`✗ #${reqId} | error`, err);
      this.tracker?.recordError();
      this.recordTrace(reqId, completionContext, 'error', receivedAtMs, startTime, {
        detail: detail ?? detailFromError(err),
        errorType: errorTypeOf(err),
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      const now = Date.now();
      if (now - this.lastErrorToastTime > 60_000) {
        this.lastErrorToastTime = now;
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Bespoke AI: error — ${msg}`);
      }
      return null;
    } finally {
      this.onRequestEnd?.();
    }
  }

  /**
   * Hand one record to the trace recorder. Synchronous and cheap (object assembly only);
   * the recorder never throws and its sinks never block this path.
   */
  private recordTrace(
    requestId: string,
    context: CompletionContext,
    outcome: TraceOutcome,
    receivedAtMs: number,
    startTimeMs: number,
    extra: {
      detail?: GenerationDetail;
      finalText?: string | null;
      errorType?: string;
      errorMessage?: string;
    },
  ): void {
    const tracer = this.tracer;
    if (!tracer) return;
    try {
      const configured = configuredTraceModel(this.config, context.mode);
      tracer.record({
        traceId: newTraceId(),
        spanId: newSpanId(),
        requestId,
        source: 'completion',
        operation: 'text_completion',
        backend: configured.backend,
        mode: context.mode,
        languageId: context.languageId,
        outcome,
        providerName: extra.detail?.providerName ?? configured.providerName,
        requestModel: extra.detail?.requestModel ?? configured.requestModel,
        receivedAtMs,
        startTimeMs,
        endTimeMs: outcome === 'cache_hit' ? startTimeMs : Date.now(),
        debounceMs: startTimeMs - receivedAtMs,
        detail: extra.detail,
        finalText: extra.finalText,
        errorType: extra.errorType,
        errorMessage: extra.errorMessage,
      });
    } catch {
      // Tracing must never affect completions.
    }
  }

  dispose(): void {
    this.debouncer.dispose();
  }
}
