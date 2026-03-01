import { CompletionContext, CompletionProvider, ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { UsageLedger } from '../../utils/usage-ledger';
import { postProcessCompletion } from '../../utils/post-process';
import {
  getPromptStrategy,
  PromptStrategy,
  SYSTEM_PROMPT,
  buildFillMessage,
} from '../prompt-strategy';
import { ApiAdapter, Preset } from './types';
import { getPreset } from './presets';
import { createAdapter } from './adapters';

/** Circuit breaker constants. */
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

export class ApiCompletionProvider implements CompletionProvider {
  private config: ExtensionConfig;
  private logger: Logger;
  private ledger?: UsageLedger;
  private adapter: ApiAdapter | null = null;
  private activePreset: Preset | null = null;
  private strategy: PromptStrategy | null = null;

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

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (!this.adapter || !this.activePreset || !this.strategy) return null;
    if (this.isCircuitOpen()) return null;

    const preset = this.activePreset;
    const messages = this.strategy.buildMessages(
      context.prefix,
      context.suffix,
      context.languageId,
    );

    // Build adapter messages array
    const adapterMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: messages.user },
    ];
    if (messages.assistantPrefill) {
      adapterMessages.push({ role: 'assistant', content: messages.assistantPrefill });
    }

    this.logger.traceBlock('api → system', messages.system);
    this.logger.traceBlock('api → user', messages.user);
    if (messages.assistantPrefill) {
      this.logger.traceBlock('api → prefill', messages.assistantPrefill);
    }

    let result;
    try {
      result = await this.adapter.complete(messages.system, adapterMessages, {
        signal,
        maxTokens: preset.maxTokens,
        temperature: preset.temperature,
        stopSequences: preset.stopSequences,
      });
    } catch (err) {
      this.recordFailure();
      throw err;
    }

    // Record to ledger
    this.ledger?.record({
      source: 'completion',
      model: result.model,
      backend: 'api',
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      inputChars: context.prefix.length + context.suffix.length,
      outputChars: result.text?.length ?? 0,
    });

    if (!result.text) {
      if (!result.aborted) this.recordFailure();
      return null;
    }

    // Reset circuit breaker on success
    this.consecutiveFailures = 0;

    this.logger.traceBlock('api ← raw', result.text);

    // Extract completion using the strategy
    const extracted = this.strategy.extractCompletion(result.text);
    if (!extracted) return null;

    if (extracted !== result.text) {
      this.logger.traceBlock('api ← extracted', extracted);
    }

    // Shared post-processing (prefix/suffix overlap trimming).
    // For prefill models, skip prefix overlap since the prefill anchor handles it.
    const hasPrefill = preset.features?.prefill === true;
    const final = postProcessCompletion(
      extracted,
      hasPrefill ? undefined : context.prefix,
      context.suffix,
    );

    if (final !== extracted) {
      this.logger.traceBlock('api ← processed', final ?? '(null)');
    }

    return final;
  }

  async recycleAll(): Promise<void> {
    this.loadAdapter();
  }

  dispose(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;
    this.strategy = null;
  }

  /** Get the currently active preset (for status display). */
  getActivePreset(): Preset | null {
    return this.activePreset;
  }

  /** Send a minimal test request to verify API connectivity and key validity. */
  async testConnection(): Promise<{
    ok: boolean;
    model: string;
    durationMs: number;
    error?: string;
  }> {
    if (!this.adapter || !this.activePreset || !this.strategy) {
      return { ok: false, model: '', durationMs: 0, error: 'No adapter loaded' };
    }

    const preset = this.activePreset;
    const userMessage = buildFillMessage('Two plus two equals ', '.');
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: userMessage },
    ];

    try {
      const result = await this.adapter.complete(SYSTEM_PROMPT, messages, {
        signal: AbortSignal.timeout(15_000),
        maxTokens: 20,
        temperature: 0,
      });

      if (result.text) {
        return { ok: true, model: result.model, durationMs: result.durationMs };
      }
      return {
        ok: false,
        model: result.model,
        durationMs: result.durationMs,
        error: 'No response received',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, model: preset.modelId, durationMs: 0, error: msg };
    }
  }

  private isCircuitOpen(): boolean {
    if (this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) return false;
    // Auto-recover after cooldown
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
        `API: circuit breaker open after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
      );
    }
  }

  /** Run a completion using a specific preset (for code override routing). */
  async getCompletionWithPreset(
    presetId: string,
    context: CompletionContext,
    signal: AbortSignal,
  ): Promise<string | null> {
    const prevPreset = this.activePreset;
    const prevAdapter = this.adapter;
    const prevStrategy = this.strategy;

    // Null out so loadAdapter doesn't dispose the saved adapter
    this.adapter = null;
    this.loadAdapter(presetId);
    try {
      return await this.getCompletion(context, signal);
    } finally {
      this.adapter = prevAdapter;
      this.activePreset = prevPreset;
      this.strategy = prevStrategy;
    }
  }

  private loadAdapter(presetId?: string): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;
    this.strategy = null;

    const id = presetId ?? this.config.api.preset;
    const preset = getPreset(id);
    if (!preset) {
      this.logger.error(`API: preset "${id}" not found`);
      return;
    }

    this.activePreset = preset;
    this.strategy = getPromptStrategy(preset.promptStrategy);
    this.adapter = createAdapter(preset);
    this.consecutiveFailures = 0;

    this.logger.info(`API: loaded ${preset.displayName} (${preset.modelId})`);
  }
}
