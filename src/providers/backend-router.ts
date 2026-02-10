import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';

/**
 * Routes inline completion requests to the active backend.
 * Implements the CompletionProvider interface so the existing
 * CompletionProvider orchestrator needs no changes.
 */
export class BackendRouter implements CompletionProvider {
  private claudeCode: CompletionProvider;
  private api: CompletionProvider | null;
  private backend: 'claude-code' | 'api';

  constructor(
    claudeCode: CompletionProvider,
    api: CompletionProvider | null,
    config: ExtensionConfig,
  ) {
    this.claudeCode = claudeCode;
    this.api = api;
    this.backend = config.backend;
  }

  private get active(): CompletionProvider {
    if (this.backend === 'api' && this.api) return this.api;
    return this.claudeCode;
  }

  isAvailable(): boolean {
    return this.active.isAvailable();
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    return this.active.getCompletion(context, signal);
  }

  updateConfig(config: ExtensionConfig): void {
    this.backend = config.backend;
    this.claudeCode.updateConfig?.(config);
    this.api?.updateConfig?.(config);
  }

  async recycleAll(): Promise<void> {
    await this.claudeCode.recycleAll?.();
    await this.api?.recycleAll?.();
  }

  /** Get the active backend name. */
  getBackend(): 'claude-code' | 'api' {
    return this.backend;
  }

  dispose(): void {
    (this.claudeCode as { dispose?(): void }).dispose?.();
    (this.api as { dispose?(): void } | null)?.dispose?.();
  }
}
