import { ApiAdapter, Preset } from '../types';
import { AnthropicAdapter } from './anthropic';
import { OpenAICompatAdapter } from './openai-compat';

export { AnthropicAdapter } from './anthropic';
export { OpenAICompatAdapter } from './openai-compat';

/** Create the appropriate adapter for a given preset. */
export function createAdapter(preset: Preset): ApiAdapter {
  switch (preset.provider) {
    case 'anthropic':
      return new AnthropicAdapter(preset);
    case 'openai':
    case 'xai':
    case 'ollama':
      return new OpenAICompatAdapter(preset);
    default:
      throw new Error(`Unknown provider: ${preset.provider}`);
  }
}
