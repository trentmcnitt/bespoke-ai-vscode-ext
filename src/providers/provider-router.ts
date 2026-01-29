import { Backend, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { ContextBrief } from '../oracle/types';

export class ProviderRouter {
  private anthropic: AnthropicProvider;
  private ollama: OllamaProvider;

  constructor(config: ExtensionConfig, logger: Logger, getBrief?: (filePath: string) => ContextBrief | null) {
    this.anthropic = new AnthropicProvider(config, logger, getBrief);
    this.ollama = new OllamaProvider(config, logger);
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
