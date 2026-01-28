import * as vscode from 'vscode';
import { CompletionContext, ExtensionConfig } from './types';
import { ModeDetector } from './mode-detector';
import { ProviderRouter } from './providers/provider-router';
import { buildDocumentContext } from './utils/context-builder';
import { LRUCache } from './utils/cache';
import { Debouncer } from './utils/debouncer';

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private modeDetector: ModeDetector;
  private router: ProviderRouter;
  private cache: LRUCache;
  private debouncer: Debouncer;
  private config: ExtensionConfig;

  constructor(config: ExtensionConfig, router: ProviderRouter) {
    this.config = config;
    this.modeDetector = new ModeDetector();
    this.router = router;
    this.cache = new LRUCache();
    this.debouncer = new Debouncer(config.debounceMs);
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.debouncer.setDelay(config.debounceMs);
    this.router.updateConfig(config);
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
    const docContext = buildDocumentContext(document, position, contextChars);

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
    const result = await provider.getCompletion(completionContext, signal);

    if (!result || token.isCancellationRequested) { return null; }

    // Cache and return
    this.cache.set(cacheKey, result);
    return [new vscode.InlineCompletionItem(result, new vscode.Range(position, position))];
  }

  dispose(): void {
    this.debouncer.dispose();
  }
}
