import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { PromptBuilder } from '../prompt-builder';

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

    // For raw mode, send the prefix as the prompt directly.
    // For chat mode, combine system + user message.
    let rawPrompt: string;
    if (this.config.ollama.raw) {
      rawPrompt = prompt.userMessage;
    } else {
      rawPrompt = `${prompt.system}\n\n${prompt.userMessage}`;
    }

    const body = {
      model: this.config.ollama.model,
      prompt: rawPrompt,
      raw: this.config.ollama.raw,
      stream: false,
      options: {
        num_predict: prompt.maxTokens,
        temperature: prompt.temperature,
        stop: prompt.stopSequences,
      },
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        console.error(`[AI Prose] Ollama returned ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      return data.response || null;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') { return null; }
      console.error('[AI Prose] Ollama error:', err);
      return null;
    }
  }
}
