import { CompletionContext, CompletionProvider, ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { UsageLedger } from '../../utils/usage-ledger';
import { CircuitBreaker } from '../../utils/circuit-breaker';
import { postProcessCompletion } from '../../utils/post-process';
import {
  getPromptStrategy,
  PromptStrategy,
  SYSTEM_PROMPT,
  composeSystemPrompt,
  buildFillMessage,
} from '../prompt-strategy';
import { ApiAdapter, Preset } from './types';
import { getPreset } from './presets';
import { createAdapter } from './adapters';
import {
  CompletionWithDetail,
  GenerationContent,
  GenerationDetail,
  GenerationOptions,
  attachDetailToError,
  genAiProviderName,
  serverAddressFor,
} from '../../utils/trace';
import { ApiAdapterResult } from './types';

/** Copy an adapter result's model-side numbers onto a generation detail. */
export function applyAdapterResult(detail: GenerationDetail, result: ApiAdapterResult): void {
  detail.responseModel = result.model;
  detail.inputTokens = result.usage.inputTokens;
  detail.outputTokens = result.usage.outputTokens;
  if (result.usage.cacheReadTokens !== undefined) {
    detail.cacheReadTokens = result.usage.cacheReadTokens;
  }
  if (result.usage.cacheWriteTokens !== undefined) {
    detail.cacheWriteTokens = result.usage.cacheWriteTokens;
  }
  detail.durationApiMs = result.durationMs;
  if (result.finishReason) detail.finishReason = result.finishReason;
  if (result.aborted) detail.aborted = true;
  if (result.errorType) detail.errorType = result.errorType;
}

/**
 * Whether an adapter result with no text should count toward the circuit breaker.
 *
 * The breaker exists to stop hammering a backend that is failing. An empty reply
 * the backend delivered normally (an immediate `</COMPLETION>`, a stop-sequence
 * cut, a `max_tokens` finish) is the model deciding, not the backend failing,
 * and five of those in a row used to block completions for 30 s.
 *
 * Empties were counted originally (420b060) because adapters then swallowed
 * 429/529 and connection errors as a bare null, so "no text" was the only
 * failure signal. Adapters now report those as `errorType`, which is what
 * counts here. A reply with no text, no output tokens, and no finish reason
 * also counts: nothing was generated and nothing explains why, which is the
 * shape of a broken endpoint or proxy rather than a model decision.
 */
export function emptyResultIsBackendFailure(result: ApiAdapterResult): boolean {
  if (result.aborted) return false;
  if (result.errorType) return true;
  return result.usage.outputTokens === 0 && !result.finishReason;
}

export class ApiCompletionProvider implements CompletionProvider {
  private config: ExtensionConfig;
  private logger: Logger;
  private ledger?: UsageLedger;
  private adapter: ApiAdapter | null = null;
  private activePreset: Preset | null = null;
  private strategy: PromptStrategy | null = null;
  private breaker: CircuitBreaker;

  constructor(
    config: ExtensionConfig,
    logger: Logger,
    ledger?: UsageLedger,
    onBreakerOpen?: () => void,
    onBreakerClose?: () => void,
  ) {
    this.config = config;
    this.logger = logger;
    this.ledger = ledger;
    this.breaker = new CircuitBreaker(5, 30_000, logger, 'API', onBreakerOpen, onBreakerClose);
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

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    return (await this.getCompletionWithDetail(context, signal)).text;
  }

  async getCompletionWithDetail(
    context: CompletionContext,
    signal: AbortSignal,
    options?: GenerationOptions,
  ): Promise<CompletionWithDetail> {
    if (!this.adapter || !this.activePreset || !this.strategy) {
      // No usable preset/adapter (unknown preset id, adapter construction failed).
      // Nothing was sent; report it so the null is not recorded as an empty reply.
      // The orchestrator's isAvailable() check catches this for the primary preset,
      // but not for a code-override preset.
      return {
        text: null,
        detail: {
          providerName: this.activePreset
            ? genAiProviderName(this.activePreset.provider)
            : '_OTHER',
          requestModel: this.activePreset?.modelId ?? '',
          errorType: 'backend_unavailable',
        },
      };
    }
    const preset = this.activePreset;
    if (this.breaker.isOpen()) {
      // Nothing was sent. Say why, so the null is not recorded as the model
      // having returned nothing (the code-override path reaches here without
      // the orchestrator's isAvailable() check).
      return {
        text: null,
        detail: {
          providerName: genAiProviderName(preset.provider),
          requestModel: preset.modelId,
          errorType: 'circuit_open',
        },
      };
    }

    const messages = this.strategy.buildMessages(
      context.prefix,
      context.suffix,
      context.languageId,
    );

    // Append the user's standing instructions (if any) to the strategy's
    // base system prompt. Read per-request from config, so changes apply
    // without recycling anything.
    const system = composeSystemPrompt(this.config.customInstructions);

    // Build adapter messages array
    const adapterMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: messages.user },
    ];
    if (messages.assistantPrefill) {
      adapterMessages.push({ role: 'assistant', content: messages.assistantPrefill });
    }

    this.logger.traceBlock('api → system', system);
    this.logger.traceBlock('api → user', messages.user);
    if (messages.assistantPrefill) {
      this.logger.traceBlock('api → prefill', messages.assistantPrefill);
    }

    const detail: GenerationDetail = {
      providerName: genAiProviderName(preset.provider),
      requestModel: preset.modelId,
      serverAddress: serverAddressFor(preset.provider, preset.baseUrl),
      maxTokens: preset.maxTokens,
    };
    const content: GenerationContent | undefined = options?.captureContent
      ? {
          systemPrompt: system,
          userMessage: messages.user,
          ...(messages.assistantPrefill ? { prefill: messages.assistantPrefill } : {}),
        }
      : undefined;
    if (content) detail.content = content;

    let result;
    try {
      result = await this.adapter.complete(system, adapterMessages, {
        signal,
        maxTokens: preset.maxTokens,
        temperature: preset.temperature,
        stopSequences: preset.stopSequences,
      });
    } catch (err) {
      this.breaker.recordFailure();
      attachDetailToError(err, detail);
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

    applyAdapterResult(detail, result);
    if (content) content.rawOutput = result.text;

    if (!result.text) {
      if (emptyResultIsBackendFailure(result)) this.breaker.recordFailure();
      else if (!result.aborted) this.breaker.recordSuccess(); // the backend answered
      return { text: null, detail };
    }

    this.breaker.recordSuccess();

    this.logger.traceBlock('api ← raw', result.text);

    // Extract completion using the strategy
    const extracted = this.strategy.extractCompletion(result.text, context.prefix);
    if (content) content.extracted = extracted;
    if (!extracted) return { text: null, detail };

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
      context.mode,
    );

    if (final !== extracted) {
      this.logger.traceBlock('api ← processed', final ?? '(null)');
    }

    return { text: final, detail };
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

  /** Run a completion using a specific preset (for code override routing). */
  async getCompletionWithPreset(
    presetId: string,
    context: CompletionContext,
    signal: AbortSignal,
  ): Promise<string | null> {
    return (await this.getCompletionWithPresetDetail(presetId, context, signal)).text;
  }

  /** `getCompletionWithPreset` plus generation detail for trace records. */
  async getCompletionWithPresetDetail(
    presetId: string,
    context: CompletionContext,
    signal: AbortSignal,
    options?: GenerationOptions,
  ): Promise<CompletionWithDetail> {
    const prevPreset = this.activePreset;
    const prevAdapter = this.adapter;
    const prevStrategy = this.strategy;

    // Null out so loadAdapter doesn't dispose the saved adapter
    this.adapter = null;
    this.loadAdapter(presetId);
    try {
      return await this.getCompletionWithDetail(context, signal, options);
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
    try {
      this.adapter = createAdapter(preset);
    } catch (err) {
      this.logger.error(`API: failed to create adapter for "${preset.displayName}": ${err}`);
      return;
    }
    this.breaker.reset();

    if (this.config.backend === 'api') {
      this.logger.info(`API: adapter ready (${preset.modelId})`);
    } else {
      this.logger.debug(`API (standby): adapter ready (${preset.modelId})`);
    }
  }
}
