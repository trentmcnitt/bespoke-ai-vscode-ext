import { ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { UsageLedger } from '../../utils/usage-ledger';
import { ApiAdapter, Preset } from './types';
import { getPreset } from './presets';
import { createAdapter } from './adapters';

/** Max output tokens for commands (commit messages, suggest-edits need much
 *  more than the 200 tokens used for inline completions). */
const COMMAND_MAX_TOKENS = 4096;

/** Circuit breaker constants. */
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

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

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;

  constructor(config: ExtensionConfig, logger: Logger, ledger?: UsageLedger) {
    this.config = config;
    this.logger = logger;
    this.ledger = ledger;
    this.loadAdapter();
  }

  isAvailable(): boolean {
    if (this.isCircuitOpen()) return false;
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
    if (!this.adapter || !this.activePreset) return null;
    if (this.isCircuitOpen()) return null;

    const preset = this.activePreset;
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: userMessage },
    ];

    this.logger.traceBlock('api-cmd → system', systemPrompt);
    this.logger.traceBlock('api-cmd → user', userMessage);

    let result;
    try {
      result = await this.adapter.complete(systemPrompt, messages, {
        signal: signal ?? AbortSignal.timeout(60_000),
        maxTokens: COMMAND_MAX_TOKENS,
        temperature: preset.temperature,
        stopSequences: preset.stopSequences,
      });
    } catch (err) {
      this.recordFailure();
      throw err;
    }

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
      this.recordFailure();
      return null;
    }

    this.consecutiveFailures = 0;
    this.logger.traceBlock('api-cmd ← raw', result.text);
    return result.text;
  }

  dispose(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;
  }

  private isCircuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
    if (Date.now() - this.circuitOpenedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenedAt = Date.now();
      this.logger.error(
        `API command: circuit breaker open after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
      );
    }
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
    this.adapter = createAdapter(preset);
    this.consecutiveFailures = 0;

    this.logger.info(`API command: loaded ${preset.displayName} (${preset.modelId})`);
  }
}
