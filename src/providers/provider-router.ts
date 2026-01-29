import { Backend, CompletionProvider, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { ClaudeCodeProvider } from './claude-code';
import { ContextBrief } from '../oracle/types';

export class ProviderRouter {
  private anthropic: AnthropicProvider;
  private ollama: OllamaProvider;
  private claudeCode: ClaudeCodeProvider;

  constructor(config: ExtensionConfig, logger: Logger, getBrief?: (filePath: string) => ContextBrief | null) {
    this.anthropic = new AnthropicProvider(config, logger, getBrief);
    this.ollama = new OllamaProvider(config, logger);
    this.claudeCode = new ClaudeCodeProvider(config, logger);
  }

  updateConfig(config: ExtensionConfig): void {
    this.anthropic.updateConfig(config);
    this.ollama.updateConfig(config);
    this.claudeCode.updateConfig(config);
  }

  async activateClaudeCode(workspaceRoot: string): Promise<void> {
    await this.claudeCode.activate(workspaceRoot);
  }

  getProvider(backend: Backend): CompletionProvider {
    switch (backend) {
      case 'anthropic':
        return this.anthropic;
      case 'ollama':
        return this.ollama;
      case 'claude-code':
        return this.claudeCode;
    }
  }

  isBackendAvailable(backend: Backend): boolean {
    if (backend === 'anthropic') {
      return this.anthropic.isAvailable();
    }
    if (backend === 'claude-code') {
      return this.claudeCode.isAvailable();
    }
    // Ollama availability is checked at request time
    return true;
  }

  dispose(): void {
    this.claudeCode.dispose();
  }
}
