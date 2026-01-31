import * as vscode from 'vscode';
import { CompletionContext, ExtensionConfig } from './types';
import { ModeDetector } from './mode-detector';
import { ProviderRouter } from './providers/provider-router';
import { buildDocumentContext } from './utils/context-builder';
import { LRUCache } from './utils/cache';
import { Debouncer } from './utils/debouncer';
import { Logger, generateRequestId } from './utils/logger';
import { UsageTracker } from './utils/usage-tracker';

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private modeDetector: ModeDetector;
  private router: ProviderRouter;
  private cache: LRUCache;
  private debouncer: Debouncer;
  private config: ExtensionConfig;
  private logger: Logger;
  private tracker?: UsageTracker;
  private onRequestStart?: () => void;
  private onRequestEnd?: () => void;
  private lastErrorToastTime = 0;

  constructor(config: ExtensionConfig, router: ProviderRouter, logger: Logger, tracker?: UsageTracker) {
    this.config = config;
    this.modeDetector = new ModeDetector();
    this.router = router;
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
    this.router.updateConfig(config);
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.info('Cache cleared');
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _inlineContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | null> {
    if (!this.config.enabled) { return null; }

    // Detect mode
    const mode = this.modeDetector.detectMode(document.languageId, this.config);

    // Build document context
    const contextChars = mode === 'code' ? this.config.code.contextChars : this.config.prose.contextChars;
    const suffixChars = mode === 'code' ? this.config.code.suffixChars : this.config.prose.suffixChars;
    const docContext = buildDocumentContext(document, position, contextChars, suffixChars);

    // Skip if no prefix content
    if (!docContext.prefix.trim()) { return null; }

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
      this.tracker?.recordCacheHit();
      return [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))];
    }

    // Debounce
    const signal = await this.debouncer.debounce(token);
    if (!signal || token.isCancellationRequested) { return null; }

    // Check backend availability
    if (!this.router.isBackendAvailable(this.config.backend)) {
      return null;
    }

    // Get completion from provider
    const provider = this.router.getProvider(this.config.backend);
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
      const result = await provider.getCompletion(completionContext, signal);
      const durationMs = Date.now() - startTime;

      if (!result || token.isCancellationRequested) {
        this.logger.requestEnd(reqId, {
          durationMs,
          resultLen: null,
          cancelled: token.isCancellationRequested,
        });
        return null;
      }

      this.logger.requestEnd(reqId, {
        durationMs,
        resultLen: result.length,
      });

      // Cache and return
      this.cache.set(cacheKey, result);
      return [new vscode.InlineCompletionItem(result, new vscode.Range(position, position))];
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
    this.debouncer.dispose();
  }
}
