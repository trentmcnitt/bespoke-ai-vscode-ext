import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { PoolClient } from '../pool-server/client';
import { SendPromptOptions, SendPromptResult, COMMAND_SYSTEM_PROMPT } from './command-pool';
import { ApiCompletionProvider } from './api/api-provider';
import { ApiCommandProvider } from './api/api-command-provider';
import { getPreset } from './api/presets';
import { shortenModelName } from '../utils/model-name';
import {
  CompletionWithDetail,
  GenerationDetail,
  GenerationOptions,
  TraceOutcome,
  TraceRecorder,
  detailFromError,
  errorTypeOf,
  newShortRequestId,
  newSpanId,
  newTraceId,
} from '../utils/trace';

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
  private tracer: TraceRecorder | null = null;

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

    // CLI path — use a shallow copy to avoid mutating shared config across an await boundary
    if (effective.model && effective.model !== this.config.claudeCode.model) {
      const overrideConfig = {
        ...this.config,
        claudeCode: { ...this.config.claudeCode, model: effective.model },
      };
      this.poolClient.updateConfig?.(overrideConfig);
      const result = await this.poolClient.getCompletion(context, signal);
      this.poolClient.updateConfig?.(this.config);
      return result;
    }

    return this.poolClient.getCompletion(context, signal);
  }

  /** Same routing as `getCompletion`, returning generation detail for trace records. */
  async getCompletionWithDetail(
    context: CompletionContext,
    signal: AbortSignal,
    options?: GenerationOptions,
  ): Promise<CompletionWithDetail> {
    const effective = this.resolveEffectiveBackend(context.mode);

    if (effective.backend === 'api') {
      if (!this.apiCompletion) return { text: null };
      if (effective.model && effective.model !== this.config.api.preset) {
        return this.apiCompletion.getCompletionWithPresetDetail(
          effective.model,
          context,
          signal,
          options,
        );
      }
      return this.apiCompletion.getCompletionWithDetail(context, signal, options);
    }

    if (effective.model && effective.model !== this.config.claudeCode.model) {
      const overrideConfig = {
        ...this.config,
        claudeCode: { ...this.config.claudeCode, model: effective.model },
      };
      this.poolClient.updateConfig?.(overrideConfig);
      try {
        return await this.poolClient.getCompletionWithDetail(context, signal, options);
      } finally {
        this.poolClient.updateConfig?.(this.config);
      }
    }

    return this.poolClient.getCompletionWithDetail(context, signal, options);
  }

  /** Attach the trace recorder used for command (commit message / suggest edit) records. */
  setTraceRecorder(recorder: TraceRecorder | null): void {
    this.tracer = recorder;
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
    const tracer = this.tracer;
    if (!tracer) return this.sendCommandUntraced(message, options);

    const backend = this.config.backend === 'api' && this.apiCommand ? 'api' : 'claude-code';
    const startTimeMs = Date.now();
    let result: SendPromptResult | undefined;
    let thrown: unknown;
    try {
      result = await this.sendCommandUntraced(message, options);
      return result;
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      this.recordCommand(tracer, backend, message, options, startTimeMs, result, thrown);
    }
  }

  private async sendCommandUntraced(
    message: string,
    options?: SendPromptOptions,
  ): Promise<SendPromptResult> {
    if (this.config.backend === 'api' && this.apiCommand) {
      const { text, detail } = await this.apiCommand.sendPromptWithDetail(
        COMMAND_SYSTEM_PROMPT,
        message,
        options?.onCancel,
      );
      return { text, meta: null, detail };
    }
    return this.poolClient.sendCommand(message, options);
  }

  /** Build and record a `chat` trace record for a command. Never throws. */
  private recordCommand(
    tracer: TraceRecorder,
    backend: 'claude-code' | 'api',
    message: string,
    options: SendPromptOptions | undefined,
    startTimeMs: number,
    result: SendPromptResult | undefined,
    thrown: unknown,
  ): void {
    try {
      const endTimeMs = Date.now();
      let detail: GenerationDetail | undefined = result?.detail ?? detailFromError(thrown);
      if (!detail && backend === 'claude-code') {
        // CLI: everything but the model-side numbers is known in this window, so no
        // content needs to cross the pool socket for commands.
        const meta = result?.meta;
        detail = {
          providerName: 'anthropic',
          requestModel: this.config.claudeCode.model,
          responseModel: meta?.model || undefined,
          inputTokens: meta?.inputTokens,
          outputTokens: meta?.outputTokens,
          cacheReadTokens: meta?.cacheReadTokens,
          cacheWriteTokens: meta?.cacheCreationTokens,
          costUsd: meta?.turnCostUsd,
          durationApiMs: meta?.durationApiMs,
          finishReason: meta?.stopReason,
          ...(result?.errorType ? { errorType: result.errorType } : {}),
          ...(result?.aborted ? { aborted: true } : {}),
        };
      }
      if (detail && this.config.trace.captureContent) {
        detail = {
          ...detail,
          content: {
            systemPrompt: COMMAND_SYSTEM_PROMPT,
            userMessage: message,
            rawOutput: result?.text ?? null,
          },
        };
      }

      const cancelled = options?.onCancel?.aborted === true || detail?.aborted === true;
      const timedOut =
        !result?.text &&
        !cancelled &&
        options?.timeoutMs !== undefined &&
        endTimeMs - startTimeMs >= options.timeoutMs;
      let outcome: TraceOutcome;
      let errorType: string | undefined;
      let errorMessage: string | undefined;
      if (thrown !== undefined) {
        outcome = 'error';
        errorType = errorTypeOf(thrown);
        errorMessage = thrown instanceof Error ? thrown.message : String(thrown);
      } else if (result?.text) {
        outcome = 'ok';
      } else if (cancelled) {
        outcome = 'aborted';
      } else if (timedOut) {
        outcome = 'error';
        errorType = 'timeout';
      } else if (detail?.errorType) {
        outcome = 'error';
      } else {
        outcome = 'empty';
      }

      const requestModel = detail?.requestModel ?? this.config.claudeCode.model;
      tracer.record({
        traceId: newTraceId(),
        spanId: newSpanId(),
        requestId: newShortRequestId(),
        source: options?.traceSource ?? 'command',
        operation: 'chat',
        backend,
        outcome,
        providerName: detail?.providerName ?? 'anthropic',
        requestModel,
        receivedAtMs: startTimeMs,
        startTimeMs,
        endTimeMs,
        detail,
        errorType,
        errorMessage,
      });
    } catch {
      // Tracing must never affect the command path.
    }
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
