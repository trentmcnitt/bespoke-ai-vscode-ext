import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { PoolClient } from '../pool-server/client';
import { SendPromptOptions, SendPromptResult, COMMAND_SYSTEM_PROMPT } from './command-pool';
import { ApiCompletionProvider } from './api/api-provider';
import { ApiCommandProvider } from './api/api-command-provider';
import { getPreset } from './api/presets';
import { shortenModelName } from '../utils/model-name';

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
    const effective = this.resolveEffectiveBackend(context.mode);

    if (effective.backend === 'api') {
      if (!this.apiCompletion) return null;
      if (effective.model && effective.model !== this.config.api.preset) {
        return this.apiCompletion.getCompletionWithPreset(effective.model, context, signal);
      }
      return this.apiCompletion.getCompletion(context, signal);
    }

    // CLI path
    if (effective.model && effective.model !== this.config.claudeCode.model) {
      const origModel = this.config.claudeCode.model;
      this.config.claudeCode.model = effective.model;
      this.poolClient.updateConfig?.(this.config);
      const result = await this.poolClient.getCompletion(context, signal);
      this.config.claudeCode.model = origModel;
      this.poolClient.updateConfig?.(this.config);
      return result;
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

  /** Get the display model info for a specific completion mode (accounts for code override). */
  getCurrentModelForMode(mode: 'prose' | 'code'): {
    backend: 'claude-code' | 'api';
    label: string;
  } {
    const effective = this.resolveEffectiveBackend(mode);
    if (effective.backend === 'api') {
      const presetId = effective.model || this.config.api.preset;
      const preset = getPreset(presetId);
      return { backend: 'api', label: preset?.displayName ?? presetId };
    }
    const model = effective.model || this.config.claudeCode.model;
    return { backend: 'claude-code', label: shortenModelName(model) };
  }

  /** Get the active backend name. */
  getBackend(): 'claude-code' | 'api' {
    return this.config.backend;
  }

  /** Get the API completion provider (for preset display). */
  getApiProvider(): ApiCompletionProvider | null {
    return this.apiCompletion;
  }

  /** Test the active API connection (API backend only). */
  async testApiConnection(): Promise<{
    ok: boolean;
    model: string;
    durationMs: number;
    error?: string;
  }> {
    if (!this.apiCompletion) {
      return { ok: false, model: '', durationMs: 0, error: 'API backend not loaded' };
    }
    return this.apiCompletion.testConnection();
  }

  /** Resolve the effective backend + model for a given completion mode. */
  private resolveEffectiveBackend(mode: 'prose' | 'code'): {
    backend: 'claude-code' | 'api';
    model: string;
  } {
    if (mode === 'code' && this.config.codeOverride.backend) {
      return {
        backend: this.config.codeOverride.backend as 'claude-code' | 'api',
        model: this.config.codeOverride.model,
      };
    }
    return { backend: this.config.backend, model: '' };
  }

  dispose(): void {
    this.poolClient.dispose();
    this.apiCompletion?.dispose();
    this.apiCommand?.dispose();
  }
}
