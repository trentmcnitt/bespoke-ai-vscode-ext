import * as vscode from 'vscode';
import {
  CompletionContext,
  CompletionProvider as ICompletionProvider,
  ExtensionConfig,
} from './types';
import { ModeDetector } from './mode-detector';
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
  private modeDetector: ModeDetector;
  private provider: ICompletionProvider;
  private cache: LRUCache;
  private debouncer: Debouncer;
  private config: ExtensionConfig;
  private logger: Logger;
  private tracker?: UsageTracker;
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
    this.modeDetector = new ModeDetector();
    this.provider = provider;
    this.cache = new LRUCache();
    this.debouncer = new Debouncer(config.debounceMs);
    this.logger = logger;
    this.tracker = tracker;
  }

  setRequestCallbacks(onStart: () => void, onEnd: () => void): void {
    this.onRequestStart = onStart;
    this.onRequestEnd = onEnd;
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.debouncer.setDelay(config.debounceMs);
    if ('updateConfig' in this.provider) {
      (this.provider as { updateConfig(c: ExtensionConfig): void }).updateConfig(config);
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.info('Cache cleared');
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _inlineContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (!this.config.enabled) {
      return null;
    }

    // Detect mode
    const mode = this.modeDetector.detectMode(document.languageId, this.config);

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
    const suppressSet = mode === 'code' ? CODE_SUPPRESS_AFTER : PROSE_SUPPRESS_AFTER;
    const lastChar = docContext.prefix.slice(-1);
    if (suppressSet.has(lastChar)) {
      return null;
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

    // Debounce
    const signal = await this.debouncer.debounce(token);
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
      backend: 'claude-code',
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

      if (!result || token.isCancellationRequested) {
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
      this.tracker?.record(this.config.claudeCode.model, inputChars, result.length);

      // Cache and return
      this.cache.set(cacheKey, result);
      const item = new vscode.InlineCompletionItem(result, new vscode.Range(position, position));
      this.logger.trace(
        `returning completion: insertText=${JSON.stringify(result.slice(0, 50))}... range=${position.line}:${position.character}`,
      );
      return [item];
    } catch (err: unknown) {
      this.logger.error(`✗ #${reqId} | claude-code error`, err);
      this.tracker?.recordError();
      const now = Date.now();
      if (now - this.lastErrorToastTime > 60_000) {
        this.lastErrorToastTime = now;
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Bespoke AI: claude-code error — ${msg}`);
      }
      return null;
    } finally {
      this.onRequestEnd?.();
    }
  }

  dispose(): void {
    this.debouncer.dispose();
  }
}
