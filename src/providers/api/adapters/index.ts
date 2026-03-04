import { ApiAdapter, Preset } from '../types';
import { AnthropicAdapter } from './anthropic';
import { OllamaAdapter } from './ollama';
import { OpenAICompatAdapter } from './openai-compat';

export { AnthropicAdapter } from './anthropic';
export { OllamaAdapter } from './ollama';
export { OpenAICompatAdapter } from './openai-compat';

/** Create the appropriate adapter for a given preset. */
export function createAdapter(preset: Preset): ApiAdapter {
  switch (preset.provider) {
    case 'anthropic':
      return new AnthropicAdapter(preset);
    case 'ollama':
      return new OllamaAdapter(preset);
    case 'openai':
    case 'xai':
    case 'google':
    case 'openrouter':
      return new OpenAICompatAdapter(preset);
    default:
      throw new Error(`Unknown provider: ${preset.provider}`);
  }
}
