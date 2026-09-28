import { ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { UsageLedger } from '../../utils/usage-ledger';
import { CircuitBreaker } from '../../utils/circuit-breaker';
import { ApiAdapter, Preset } from './types';
import { getPreset } from './presets';
import { createAdapter } from './adapters';
import { applyAdapterResult, emptyResultIsBackendFailure } from './api-provider';
import {
  CompletionWithDetail,
  GenerationDetail,
  attachDetailToError,
  genAiProviderName,
  serverAddressFor,
} from '../../utils/trace';

/** Max output tokens for commands (commit messages, suggest-edits need much
 *  more than the 200 tokens used for inline completions). */
const COMMAND_MAX_TOKENS = 4096;

/**
 * API-based command provider for commit messages and suggest-edits.
 *
 * Unlike ApiCompletionProvider, this handles generic prompt→response commands
 * (not fill-in-the-middle completions). The system prompt and user message
 * are passed directly by the caller (commit-message.ts, suggest-edit.ts).
 */
export class ApiCommandProvider {
  private config: ExtensionConfig;
  private logger: Logger;
  private ledger?: UsageLedger;
  private adapter: ApiAdapter | null = null;
  private activePreset: Preset | null = null;
  private breaker: CircuitBreaker;

  constructor(config: ExtensionConfig, logger: Logger, ledger?: UsageLedger) {
    this.config = config;
    this.logger = logger;
    this.ledger = ledger;
    this.breaker = new CircuitBreaker(5, 30_000, logger, 'API command');
    this.loadAdapter();
  }

  isAvailable(): boolean {
    if (this.breaker.isOpen()) return false;
    return this.adapter?.isConfigured() ?? false;
  }

  updateConfig(config: ExtensionConfig): void {
    const presetChanged = config.api.preset !== this.config.api.preset;
    this.config = config;
    if (presetChanged) {
      this.loadAdapter();
    }
  }

  async sendPrompt(
    systemPrompt: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return (await this.sendPromptWithDetail(systemPrompt, userMessage, signal)).text;
  }

  /** `sendPrompt` plus generation detail for trace records (content included; caller gates it). */
  async sendPromptWithDetail(
    systemPrompt: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<CompletionWithDetail> {
    if (!this.adapter || !this.activePreset) return { text: null };
    if (this.breaker.isOpen()) return { text: null };

    const preset = this.activePreset;
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: userMessage },
    ];

    this.logger.traceBlock('api-cmd → system', systemPrompt);
    this.logger.traceBlock('api-cmd → user', userMessage);

    const detail: GenerationDetail = {
      providerName: genAiProviderName(preset.provider),
      requestModel: preset.modelId,
      serverAddress: serverAddressFor(preset.provider, preset.baseUrl),
      maxTokens: COMMAND_MAX_TOKENS,
    };

    let result;
    try {
      result = await this.adapter.complete(systemPrompt, messages, {
        signal: signal ?? AbortSignal.timeout(60_000),
        maxTokens: COMMAND_MAX_TOKENS,
        temperature: preset.temperature,
        stopSequences: preset.stopSequences,
      });
    } catch (err) {
      this.breaker.recordFailure();
      attachDetailToError(err, detail);
      throw err;
    }
    applyAdapterResult(detail, result);

    // Record to ledger
    this.ledger?.record({
      source: 'command',
      model: result.model,
      backend: 'api',
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      inputChars: systemPrompt.length + userMessage.length,
      outputChars: result.text?.length ?? 0,
    });

    if (!result.text) {
      if (emptyResultIsBackendFailure(result)) this.breaker.recordFailure();
      else if (!result.aborted) this.breaker.recordSuccess(); // the backend answered
      return { text: null, detail };
    }

    this.breaker.recordSuccess();
    this.logger.traceBlock('api-cmd ← raw', result.text);
    return { text: result.text, detail };
  }

  dispose(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;
  }

  private loadAdapter(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;

    const presetId = this.config.api.preset;
    const preset = getPreset(presetId);
    if (!preset) {
      this.logger.error(`API command: preset "${presetId}" not found`);
      return;
    }

    this.activePreset = preset;
    try {
      this.adapter = createAdapter(preset);
    } catch (err) {
      this.logger.error(
        `API command: failed to create adapter for "${preset.displayName}": ${err}`,
      );
      return;
    }
    this.breaker.reset();
  }
}
