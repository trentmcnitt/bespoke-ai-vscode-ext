import { CompletionContext, CompletionProvider, ExtensionConfig } from '../../types';
import { Logger } from '../../utils/logger';
import { UsageLedger } from '../../utils/usage-ledger';
import { postProcessCompletion } from '../../utils/post-process';
import { ApiAdapter, Preset } from './types';
import { buildApiPrompt } from './prompt-builder';
import { getPreset, calculateCost } from './presets';
import { AnthropicAdapter } from './adapters/anthropic';
import { OpenAICompatAdapter } from './adapters/openai-compat';
import { GeminiAdapter } from './adapters/gemini';

/** Strip markdown code fences that models sometimes wrap output in. */
function stripCodeFences(text: string): string {
  // Match ```language\n...\n``` or ```\n...\n```
  const fenceMatch = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) return fenceMatch[1];

  // Match inline backticks
  const inlineMatch = text.match(/^`([\s\S]*?)`$/);
  if (inlineMatch) return inlineMatch[1];

  return text;
}

/**
 * Strip [CURSOR] markers and document echoes from model output.
 *
 * Models with prefill sometimes echo the document structure from the prompt,
 * including the [CURSOR] marker and suffix text. When this happens, the real
 * continuation comes after the echoed suffix. This function:
 * 1. Strips [CURSOR] and everything before it
 * 2. If the remaining text starts with the suffix, strips that echo too
 */
function stripCursorAndSuffixEcho(text: string, suffix: string): string {
  const idx = text.indexOf('[CURSOR]');
  if (idx < 0) return text;

  let result = text.slice(idx + '[CURSOR]'.length);

  // After stripping [CURSOR], the result may start with the suffix text
  // (the model echoed the full document). Strip that leading echo.
  if (suffix.trim()) {
    const normSuffix = suffix.trimStart();
    const normResult = result.trimStart();
    if (normResult.startsWith(normSuffix)) {
      result = normResult.slice(normSuffix.length);
    }
  }

  return result;
}

/** Strip common chat-style preambles from model output. */
function stripPreamble(text: string): string {
  // Common preamble patterns — case-insensitive, strip up to the first newline
  const patterns = [
    /^(?:Here(?:'s| is)(?: the)?(?:\s+(?:the|your|my))?\s*(?:completion|continuation|text|code)?[:\s]*\n)/i,
    /^(?:Sure[!,.]?\s*(?:Here(?:'s| is))?\s*[:\s]*\n)/i,
    /^(?:(?:Got it|Understood|Absolutely|Right)[!,.]?\s*\n)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return text.slice(match[0].length);
    }
  }

  return text;
}

export class ApiCompletionProvider implements CompletionProvider {
  private config: ExtensionConfig;
  private logger: Logger;
  private ledger?: UsageLedger;
  private adapter: ApiAdapter | null = null;
  private activePreset: Preset | null = null;

  constructor(config: ExtensionConfig, logger: Logger, ledger?: UsageLedger) {
    this.config = config;
    this.logger = logger;
    this.ledger = ledger;
    this.loadAdapter();
  }

  isAvailable(): boolean {
    return this.adapter?.isConfigured() ?? false;
  }

  updateConfig(config: ExtensionConfig): void {
    const presetChanged = config.api.activePreset !== this.config.api.activePreset;
    this.config = config;
    if (presetChanged) {
      this.loadAdapter();
    }
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (!this.adapter || !this.activePreset) return null;

    const preset = this.activePreset;
    const { system, messages } = buildApiPrompt(context, preset);

    this.logger.traceBlock('api → system', system);
    this.logger.traceBlock('api → messages', JSON.stringify(messages, null, 2));

    const result = await this.adapter.complete(system, messages, {
      signal,
      maxTokens: preset.maxTokens,
      temperature: preset.temperature,
      stopSequences: preset.stopSequences,
    });

    // Record to ledger
    this.ledger?.record({
      source: 'completion',
      model: result.model,
      backend: 'api',
      durationMs: result.durationMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      costUsd: calculateCost(preset, result.usage),
      inputChars: context.prefix.length + context.suffix.length,
      outputChars: result.text?.length ?? 0,
    } as Parameters<UsageLedger['record']>[0]);

    if (!result.text) return null;

    this.logger.traceBlock('api ← raw', result.text);

    // API-specific post-processing
    let processed = stripCursorAndSuffixEcho(result.text, context.suffix);
    processed = stripCodeFences(processed);
    processed = stripPreamble(processed);

    if (processed !== result.text) {
      this.logger.traceBlock('api ← cleaned', processed);
    }

    // Shared post-processing (suffix overlap, etc.)
    // For prefill models, the prefix overlap is handled by the prefill anchor,
    // so we don't pass prefix for trimPrefixOverlap.
    const hasPrefill = preset.features?.prefill === true;
    const final = postProcessCompletion(
      processed,
      hasPrefill ? undefined : context.prefix,
      context.suffix,
    );

    if (final !== processed) {
      this.logger.traceBlock('api ← processed', final ?? '(null)');
    }

    return final;
  }

  async recycleAll(): Promise<void> {
    // API adapters are stateless — just reload the adapter
    this.loadAdapter();
  }

  dispose(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;
  }

  /** Get the currently active preset (for status display). */
  getActivePreset(): Preset | null {
    return this.activePreset;
  }

  private loadAdapter(): void {
    this.adapter?.dispose();
    this.adapter = null;
    this.activePreset = null;

    const presetId = this.config.api.activePreset;
    const preset = getPreset(presetId);
    if (!preset) {
      this.logger.error(`API: preset "${presetId}" not found`);
      return;
    }

    this.activePreset = preset;

    switch (preset.provider) {
      case 'anthropic':
        this.adapter = new AnthropicAdapter(preset);
        break;
      case 'openai':
      case 'xai':
      case 'ollama':
        this.adapter = new OpenAICompatAdapter(preset);
        break;
      case 'gemini':
        this.adapter = new GeminiAdapter(preset);
        break;
    }

    if (this.adapter) {
      this.logger.info(`API: loaded ${preset.displayName} (${preset.modelId})`);
    }
  }
}
