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

/**
 * Everything one completion request needs, resolved from a single preset.
 *
 * A request captures its slot synchronously before its first `await` and reads
 * only from it, so a preset switch or an overlapping request cannot change the
 * adapter, strategy or breaker a request is using halfway through.
 */
interface PresetSlot {
  preset: Preset;
  strategy: PromptStrategy;
  adapter: ApiAdapter;
  breaker: CircuitBreaker;
}

export class ApiCompletionProvider implements CompletionProvider {
  private config: ExtensionConfig;
  private logger: Logger;
  private ledger?: UsageLedger;
  private adapter: ApiAdapter | null = null;
  private activePreset: Preset | null = null;
  private strategy: PromptStrategy | null = null;
  private breaker: CircuitBreaker;
  /**
   * Code-override presets, each with its own cached adapter (so its client and
   * xAI conv id persist), strategy and breaker (so its failures back off without
   * touching the main preset's count). Keyed by preset id; a custom preset is
   * rebuilt on every settings change, so a slot whose preset object is no longer
   * the registered one is evicted.
   */
  private overrides = new Map<string, PresetSlot>();
  private onOverrideBreakerChange?: (preset: Preset, open: boolean) => void;

  /**
   * `onBreakerOpen` / `onBreakerClose` follow the main preset's breaker (they drive
   * the status bar). `onOverrideBreakerChange` follows each code-override preset's
   * breaker, so the extension can tell the user an override is paused.
   */
  constructor(
    config: ExtensionConfig,
    logger: Logger,
    ledger?: UsageLedger,
    onBreakerOpen?: () => void,
    onBreakerClose?: () => void,
    onOverrideBreakerChange?: (preset: Preset, open: boolean) => void,
  ) {
    this.config = config;
    this.onOverrideBreakerChange = onOverrideBreakerChange;
    this.logger = logger;
    this.ledger = ledger;
    this.breaker = new CircuitBreaker(5, 30_000, logger, 'API', onBreakerOpen, onBreakerClose);
    this.loadAdapter();
  }

  isAvailable(): boolean {
    if (this.breaker.isOpen()) return false;
    return this.adapter?.isConfigured() ?? false;
  }

  /**
   * Availability of a code-override preset: its own slot and breaker, independent
   * of the main preset's. Creates the slot if needed (the request that follows
   * would create it anyway). Unknown preset or unbuildable adapter → false.
   *
   * A missing API key is deliberately not checked: the request then throws "API
   * key invalid or missing", which the orchestrator shows the user. The main
   * preset has the status bar's setup state for that; the override has nothing else.
   */
  isPresetAvailable(presetId: string): boolean {
    const slot = this.getOverrideSlot(presetId);
    if ('unavailable' in slot) return false;
    return !slot.breaker.isOpen();
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
      // (The orchestrator's isAvailable() check normally stops the request first.)
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
    // Snapshot before any await: the request keeps this preset's adapter and
    // strategy even if the preset changes while it is in flight.
    return this.runCompletion(
      {
        preset: this.activePreset,
        strategy: this.strategy,
        adapter: this.adapter,
        breaker: this.breaker,
      },
      context,
      signal,
      options,
    );
  }

  private async runCompletion(
    slot: PresetSlot,
    context: CompletionContext,
    signal: AbortSignal,
    options?: GenerationOptions,
  ): Promise<CompletionWithDetail> {
    const { preset, strategy, adapter, breaker } = slot;
    if (breaker.isOpen()) {
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

    const messages = strategy.buildMessages(context.prefix, context.suffix, context.languageId);

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
      result = await adapter.complete(system, adapterMessages, {
        signal,
        maxTokens: preset.maxTokens,
        temperature: preset.temperature,
        stopSequences: preset.stopSequences,
      });
    } catch (err) {
      breaker.recordFailure();
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
      if (emptyResultIsBackendFailure(result)) breaker.recordFailure();
      else if (!result.aborted) breaker.recordSuccess(); // the backend answered
      return { text: null, detail };
    }

    breaker.recordSuccess();

    this.logger.traceBlock('api ← raw', result.text);

    // Extract completion using the strategy
    const extracted = strategy.extractCompletion(result.text, context.prefix, context.suffix);
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
    this.disposeOverrides();
    this.loadAdapter();
  }

  dispose(): void {
    this.disposeOverrides();
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
    const slot = this.getOverrideSlot(presetId);
    if ('unavailable' in slot) {
      // Unknown preset id, or its adapter could not be built. Nothing was sent;
      // report it so the null is not recorded as an empty reply (the
      // orchestrator's isAvailable() check does not cover the override path).
      const preset = slot.unavailable;
      return {
        text: null,
        detail: {
          providerName: preset ? genAiProviderName(preset.provider) : '_OTHER',
          requestModel: preset?.modelId ?? '',
          errorType: 'backend_unavailable',
        },
      };
    }
    return this.runCompletion(slot, context, signal, options);
  }

  /**
   * The cached slot for a code-override preset, created on first use.
   * Synchronous, so two overlapping requests cannot both create one.
   */
  private getOverrideSlot(presetId: string): PresetSlot | { unavailable: Preset | null } {
    const preset = getPreset(presetId);
    const cached = this.overrides.get(presetId);
    // Built-in presets keep their identity; custom presets are rebuilt on every
    // settings change, so a different object means the cached slot is stale.
    if (cached && cached.preset === preset) return cached;
    if (cached) {
      cached.adapter.dispose();
      this.overrides.delete(presetId);
    }
    if (!preset) {
      this.logger.error(`API: code override preset "${presetId}" not found`);
      return { unavailable: null };
    }
    let adapter: ApiAdapter;
    try {
      adapter = createAdapter(preset);
    } catch (err) {
      this.logger.error(`API: failed to create adapter for "${preset.displayName}": ${err}`);
      return { unavailable: preset };
    }
    const slot: PresetSlot = {
      preset,
      strategy: getPromptStrategy(preset.promptStrategy),
      adapter,
      // Its own callback, not the main breaker's: those drive the status bar,
      // which describes the main preset.
      breaker: new CircuitBreaker(
        5,
        30_000,
        this.logger,
        `API code override (${preset.displayName})`,
        () => this.onOverrideBreakerChange?.(preset, true),
        () => this.onOverrideBreakerChange?.(preset, false),
      ),
    };
    this.overrides.set(presetId, slot);
    this.logger.debug(`API: code override adapter ready (${preset.modelId})`);
    return slot;
  }

  private disposeOverrides(): void {
    for (const slot of this.overrides.values()) slot.adapter.dispose();
    this.overrides.clear();
  }

  private loadAdapter(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;
    this.strategy = null;

    const id = this.config.api.preset;
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
