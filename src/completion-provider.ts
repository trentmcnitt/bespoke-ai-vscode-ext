import * as vscode from 'vscode';
import {
  CompletionContext,
  CompletionProvider as ICompletionProvider,
  ExpandResult,
  ExtensionConfig,
} from './types';
import { detectMode } from './mode-detector';
import { buildDocumentContext } from './utils/context-builder';
import { LRUCache } from './utils/cache';
import { Debouncer } from './utils/debouncer';
import { Logger, generateRequestId } from './utils/logger';
import { UsageTracker } from './utils/usage-tracker';

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
  private expandResult: ExpandResult | null = null;
  private onRequestStart?: () => void;
  private onRequestEnd?: () => void;
  private lastErrorToastTime = 0;

  constructor(
    config: ExtensionConfig,
    provider: ICompletionProvider,
    logger: Logger,
    tracker?: UsageTracker,
  ) {
    this.config = config;
    this.provider = provider;
    this.cache = new LRUCache();
    this.debouncer = new Debouncer(this.getDebounceDelay(config));
    this.logger = logger;
    this.tracker = tracker;
  }

  setRequestCallbacks(onStart: () => void, onEnd: () => void): void {
    this.onRequestStart = onStart;
    this.onRequestEnd = onEnd;
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.debouncer.setDelay(this.getDebounceDelay(config));
    this.provider.updateConfig?.(config);
  }

  /** Resolve the effective debounce delay based on active backend. */
  private getDebounceDelay(config: ExtensionConfig): number {
    if (config.backend === 'api') {
      return config.api.debounceMs;
    }
    return config.debounceMs;
  }

  setExpandResult(result: ExpandResult): void {
    this.expandResult = result;
  }

  clearCache(): void {
    this.cache.clear();
    this.expandResult = null;
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

    // Consume pending expand result (one-shot injection from the expand command)
    if (this.expandResult) {
      const result = this.expandResult;
      this.expandResult = null;
      const range = new vscode.Range(
        result.range.startLine,
        result.range.startCharacter,
        result.range.endLine,
        result.range.endCharacter,
      );
      return result.suggestions.map((text) => new vscode.InlineCompletionItem(text, range));
    }

    // In manual mode, only respond to explicit triggers (Ctrl+L / command palette)
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
    // Explicit triggers (Ctrl+L) bypass suppression — the user explicitly asked for a completion
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

    // Check cache
    const cacheKey = LRUCache.makeKey(mode, docContext.prefix, docContext.suffix);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.cacheHit(reqId, cached.length);
      this.logger.traceBlock('← cached value', cached);
      this.tracker?.recordCacheHit();
      const item = new vscode.InlineCompletionItem(cached, new vscode.Range(position, position));
      this.logger.trace(
        `returning cache hit: insertText=${JSON.stringify(cached.slice(0, 50))}... range=${position.line}:${position.character}`,
      );
      return [item];
    }

    // Debounce — explicit triggers fire immediately (zero delay)
    const signal = await this.debouncer.debounce(token, isExplicitTrigger ? 0 : undefined);
    if (!signal || token.isCancellationRequested) {
      this.logger.trace(`#${reqId} debounce cancelled`);
      return null;
    }

    // Check provider availability
    if (!this.provider.isAvailable()) {
      return null;
    }

    // Get completion from provider
    const startTime = Date.now();

    // Log request start with structured format
    this.logger.requestStart(reqId, {
      mode,
      backend: this.config.backend,
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
    try {
      const result = await this.provider.getCompletion(completionContext, signal);
      const durationMs = Date.now() - startTime;

      if (!result) {
        this.logger.requestEnd(reqId, {
          durationMs,
          resultLen: null,
          cancelled: token.isCancellationRequested,
        });
        this.logger.trace(
          `#${reqId} returning null: result=${result === null ? 'null' : 'empty'}, cancelled=${token.isCancellationRequested}`,
        );
        return null;
      }

      this.logger.requestEnd(reqId, {
        durationMs,
        resultLen: result.length,
      });

      // Record successful completion in usage tracker
      const inputChars = docContext.prefix.length + docContext.suffix.length;
      const modelLabel =
        this.config.backend === 'api' ? this.config.api.activePreset : this.config.claudeCode.model;
      this.tracker?.record(modelLabel, inputChars, result.length);

      // Cache and return
      this.cache.set(cacheKey, result);
      const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
      this.logger.trace(
        `returning completion: insertText=${JSON.stringify(result.slice(0, 50))}... range=${position.line}:${position.character}`,
      );
      return [item];
    } catch (err: unknown) {
      this.logger.error(`✗ #${reqId} | ${this.config.backend} error`, err);
      this.tracker?.recordError();
      const now = Date.now();
      if (now - this.lastErrorToastTime > 60_000) {
        this.lastErrorToastTime = now;
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Bespoke AI: ${this.config.backend} error — ${msg}`);
      }
      return null;
    } finally {
      this.onRequestEnd?.();
    }
  }

  dispose(): void {
    this.expandResult = null;
    this.debouncer.dispose();
  }
}
