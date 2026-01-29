import * as vscode from 'vscode';
import { CompletionContext, ExtensionConfig } from './types';
import { ModeDetector } from './mode-detector';
import { ProviderRouter } from './providers/provider-router';
import { buildDocumentContext } from './utils/context-builder';
import { LRUCache } from './utils/cache';
import { Debouncer } from './utils/debouncer';
import { Logger } from './utils/logger';

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private modeDetector: ModeDetector;
  private router: ProviderRouter;
  private cache: LRUCache;
  private debouncer: Debouncer;
  private config: ExtensionConfig;
  private logger: Logger;
  private onRequestStart?: () => void;
  private onRequestEnd?: () => void;

  constructor(config: ExtensionConfig, router: ProviderRouter, logger: Logger) {
    this.config = config;
    this.modeDetector = new ModeDetector();
    this.router = router;
    this.cache = new LRUCache();
    this.debouncer = new Debouncer(config.debounceMs);
    this.logger = logger;
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

    // Check cache
    const cacheKey = LRUCache.makeKey(mode, docContext.prefix, docContext.suffix);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${mode} completion`);
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

    this.logger.debug(`Request: mode=${mode} backend=${this.config.backend} lang=${docContext.languageId} file=${docContext.fileName} prefix_chars=${docContext.prefix.length} suffix_chars=${docContext.suffix.length}`);
    this.logger.trace(`Prefix (first 200): ${docContext.prefix.slice(0, 200)}`);
    this.logger.trace(`Prefix (last 200): ${docContext.prefix.slice(-200)}`);
    if (docContext.suffix) {
      this.logger.trace(`Suffix (first 200): ${docContext.suffix.slice(0, 200)}`);
    }

    this.onRequestStart?.();
    try {
      const result = await provider.getCompletion(completionContext, signal);

      if (!result || token.isCancellationRequested) {
        this.logger.debug(`Result: ${result === null ? 'null' : 'cancelled'}`);
        return null;
      }

      this.logger.debug(`Result: length=${result.length}`);

      // Cache and return
      this.cache.set(cacheKey, result);
      return [new vscode.InlineCompletionItem(result, new vscode.Range(position, position))];
    } catch (err: unknown) {
      this.logger.error(`${this.config.backend} completion failed`, err);
      return null;
    } finally {
      this.onRequestEnd?.();
    }
  }

  dispose(): void {
    this.debouncer.dispose();
  }
}
