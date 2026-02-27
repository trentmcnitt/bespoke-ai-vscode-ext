import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { PoolClient } from '../pool-server/client';
import { SendPromptOptions, SendPromptResult, COMMAND_SYSTEM_PROMPT } from './command-pool';
import { ApiCompletionProvider } from './api/api-provider';
import { ApiCommandProvider } from './api/api-command-provider';

/**
 * Routes completion and command requests to the active backend.
 *
 * Implements CompletionProvider so the existing orchestrator needs no changes.
 * Also provides sendCommand() for commit messages and suggest-edits.
 */
export class BackendRouter implements CompletionProvider {
  private poolClient: PoolClient;
  private apiCompletion: ApiCompletionProvider | null;
  private apiCommand: ApiCommandProvider | null;
  private config: ExtensionConfig;

  constructor(
    poolClient: PoolClient,
    apiCompletion: ApiCompletionProvider | null,
    apiCommand: ApiCommandProvider | null,
    config: ExtensionConfig,
  ) {
    this.poolClient = poolClient;
    this.apiCompletion = apiCompletion;
    this.apiCommand = apiCommand;
    this.config = config;
  }

  // --- CompletionProvider interface ---

  isAvailable(): boolean {
    if (this.config.backend === 'api') {
      return this.apiCompletion?.isAvailable() ?? false;
    }
    return this.poolClient.isAvailable();
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (this.config.backend === 'api') {
      return this.apiCompletion?.getCompletion(context, signal) ?? null;
    }
    return this.poolClient.getCompletion(context, signal);
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.poolClient.updateConfig?.(config);
    this.apiCompletion?.updateConfig(config);
    this.apiCommand?.updateConfig(config);
  }

  async recycleAll(): Promise<void> {
    await this.poolClient.recycleAll?.();
    await this.apiCompletion?.recycleAll();
  }

  // --- Command interface for commit-message and suggest-edit ---

  async sendCommand(message: string, options?: SendPromptOptions): Promise<SendPromptResult> {
    if (this.config.backend === 'api' && this.apiCommand) {
      const text = await this.apiCommand.sendPrompt(
        COMMAND_SYSTEM_PROMPT,
        message,
        options?.onCancel,
      );
      return { text, meta: null };
    }
    return this.poolClient.sendCommand(message, options);
  }

  isCommandAvailable(): boolean {
    if (this.config.backend === 'api') {
      return this.apiCommand?.isAvailable() ?? false;
    }
    return this.poolClient.isCommandPoolAvailable();
  }

  getCurrentModel(): string {
    if (this.config.backend === 'api') {
      return this.apiCompletion?.getActivePreset()?.displayName ?? this.config.api.preset;
    }
    return this.poolClient.getCurrentModel();
  }

  /** Get the active backend name. */
  getBackend(): 'claude-code' | 'api' {
    return this.config.backend;
  }

  /** Get the API completion provider (for preset display). */
  getApiProvider(): ApiCompletionProvider | null {
    return this.apiCompletion;
  }

  dispose(): void {
    this.poolClient.dispose();
    this.apiCompletion?.dispose();
    this.apiCommand?.dispose();
  }
}
