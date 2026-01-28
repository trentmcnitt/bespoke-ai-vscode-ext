import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { PromptBuilder } from '../prompt-builder';
import { postProcessCompletion } from '../utils/post-process';

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

export class OllamaProvider implements CompletionProvider {
  private promptBuilder: PromptBuilder;

  constructor(private config: ExtensionConfig) {
    this.promptBuilder = new PromptBuilder();
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  isAvailable(): boolean {
    // Ollama availability is checked at request time
    return true;
  }

  async getCompletion(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    const prompt = this.promptBuilder.buildPrompt(context, this.config);
    const endpoint = this.config.ollama.endpoint.replace(/\/$/, '');
    const url = `${endpoint}/api/generate`;

    // Decide whether to use raw mode:
    // - Code mode with suffix: use raw=false so Ollama handles FIM via the suffix param
    // - Prose mode or no suffix: use the user's raw setting (default true for base models)
    const hasFimSuffix = context.mode === 'code' && prompt.suffix;
    const useRaw = hasFimSuffix ? false : this.config.ollama.raw;

    // For FIM (non-raw with suffix), send raw prefix — Ollama wraps it with FIM tokens.
    // For all other cases, send the formatted userMessage from the prompt builder.
    const promptText = (hasFimSuffix) ? context.prefix : prompt.userMessage;

    const body: Record<string, unknown> = {
      model: this.config.ollama.model,
      prompt: promptText,
      stream: false,
      keep_alive: '30m',
      options: {
        num_predict: prompt.maxTokens,
        temperature: prompt.temperature,
        stop: prompt.stopSequences,
      },
    };

    if (useRaw) {
      // Raw mode: bypass chat template, send prefix directly as prompt.
      // system/suffix params are ignored in raw mode.
      body.raw = true;
    } else {
      // Non-raw mode: Ollama applies the model's template.
      // Include system prompt for instructional context.
      body.system = prompt.system;

      // If we have a suffix, pass it for native FIM support.
      // Ollama formats the FIM tokens per-model (e.g. Qwen2.5 uses
      // <|fim_prefix|>/<|fim_suffix|>/<|fim_middle|> automatically).
      if (hasFimSuffix) {
        body.suffix = prompt.suffix;
      }
    }

    try {
      // Combine caller's abort signal with a 30s timeout.
      // Ollama model loading can take 5-15s; 30s covers that plus generation.
      const timeoutSignal = AbortSignal.timeout(30_000);
      const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!response.ok) {
        console.error(`[AI Prose] Ollama returned ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      if (!data.response) { return null; }

      return postProcessCompletion(data.response, prompt);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { return null; }
      console.error('[AI Prose] Ollama error:', err);
      return null;
    }
  }
}
