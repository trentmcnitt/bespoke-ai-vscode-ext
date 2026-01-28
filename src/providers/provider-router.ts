import { Backend, CompletionProvider, ExtensionConfig } from '../types';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';

export class ProviderRouter {
  private anthropic: AnthropicProvider;
  private ollama: OllamaProvider;

  constructor(config: ExtensionConfig) {
    this.anthropic = new AnthropicProvider(config);
    this.ollama = new OllamaProvider(config);
  }

  updateConfig(config: ExtensionConfig): void {
    this.anthropic.updateConfig(config);
    this.ollama.updateConfig(config);
  }

  getProvider(backend: Backend): CompletionProvider {
    switch (backend) {
      case 'anthropic':
        return this.anthropic;
      case 'ollama':
        return this.ollama;
    }
  }

  isBackendAvailable(backend: Backend): boolean {
    if (backend === 'anthropic') {
      return this.anthropic.isAvailable();
    }
    // Ollama availability is checked at request time
    return true;
  }
}
