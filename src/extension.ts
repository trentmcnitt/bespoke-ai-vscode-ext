import * as vscode from 'vscode';
import { ExtensionConfig, Backend } from './types';
import { CompletionProvider } from './completion-provider';
import { ProviderRouter } from './providers/provider-router';
import { readApiKeyFromEnvFile } from './utils/env';

const MODE_LABELS = ['auto', 'prose', 'code'] as const;
type ModeLabel = typeof MODE_LABELS[number];

let statusBarItem: vscode.StatusBarItem;
let completionProvider: CompletionProvider;
let providerRouter: ProviderRouter;

export function activate(context: vscode.ExtensionContext) {
  const config = loadConfig();

  providerRouter = new ProviderRouter(config);
  completionProvider = new CompletionProvider(config, providerRouter);

  // Register inline completion provider
  const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    completionProvider
  );
  context.subscriptions.push(providerDisposable);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'ai-prose-completion.cycleMode';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(config);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('ai-prose-completion.trigger', () => {
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-prose-completion.toggleEnabled', () => {
      const ws = vscode.workspace.getConfiguration('aiProseCompletion');
      const current = ws.get<boolean>('enabled', true);
      ws.update('enabled', !current, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-prose-completion.cycleMode', () => {
      const ws = vscode.workspace.getConfiguration('aiProseCompletion');
      const current = ws.get<string>('mode', 'auto') as ModeLabel;
      const idx = MODE_LABELS.indexOf(current);
      const next = MODE_LABELS[(idx + 1) % MODE_LABELS.length];
      ws.update('mode', next, vscode.ConfigurationTarget.Global);
    })
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiProseCompletion')) {
        const newConfig = loadConfig();
        completionProvider.updateConfig(newConfig);
        updateStatusBar(newConfig);
      }
    })
  );

  // Warn if no API key when using Anthropic
  if (config.backend === 'anthropic' && !config.anthropic.apiKey) {
    vscode.window.showWarningMessage(
      'AI Prose Completion: No Anthropic API key configured. Set it in settings or ~/.creds/api-keys.env.'
    );
  }
}

function loadConfig(): ExtensionConfig {
  const ws = vscode.workspace.getConfiguration('aiProseCompletion');

  let apiKey = ws.get<string>('anthropic.apiKey', '');

  // Fall back to env file
  if (!apiKey) {
    apiKey = readApiKeyFromEnvFile();
  }

  return {
    enabled: ws.get<boolean>('enabled', true)!,
    backend: ws.get<Backend>('backend', 'anthropic')!,
    mode: ws.get<'auto' | 'prose' | 'code'>('mode', 'auto')!,
    debounceMs: ws.get<number>('debounceMs', 300)!,
    anthropic: {
      apiKey,
      model: ws.get<string>('anthropic.model', 'claude-haiku-4-5-20251001')!,
      useCaching: ws.get<boolean>('anthropic.useCaching', true)!,
    },
    ollama: {
      endpoint: ws.get<string>('ollama.endpoint', 'http://localhost:11434')!,
      model: ws.get<string>('ollama.model', 'qwen2.5:3b')!,
      raw: ws.get<boolean>('ollama.raw', true)!,
    },
    prose: {
      maxTokens: ws.get<number>('prose.maxTokens', 100)!,
      temperature: ws.get<number>('prose.temperature', 0.7)!,
      stopSequences: ws.get<string[]>('prose.stopSequences', ['\n\n', '---', '##'])!,
      contextChars: ws.get<number>('prose.contextChars', 2000)!,
      suffixChars: ws.get<number>('prose.suffixChars', 500)!,
      fileTypes: ws.get<string[]>('prose.fileTypes', ['markdown', 'plaintext'])!,
    },
    code: {
      maxTokens: ws.get<number>('code.maxTokens', 256)!,
      temperature: ws.get<number>('code.temperature', 0.2)!,
      stopSequences: ws.get<string[]>('code.stopSequences', ['\n\n'])!,
      contextChars: ws.get<number>('code.contextChars', 4000)!,
      suffixChars: ws.get<number>('code.suffixChars', 500)!,
    },
  };
}


function updateStatusBar(config: ExtensionConfig) {
  if (!config.enabled) {
    statusBarItem.text = '$(circle-slash) AI Off';
    statusBarItem.tooltip = 'AI Prose Completion: Disabled (click to cycle mode)';
  } else {
    const modeIcon = config.mode === 'auto' ? '$(symbol-misc)'
      : config.mode === 'prose' ? '$(book)'
      : '$(code)';
    const backendLabel = config.backend === 'anthropic' ? 'Claude' : 'Ollama';
    statusBarItem.text = `${modeIcon} ${config.mode} | ${backendLabel}`;
    statusBarItem.tooltip = `AI Prose Completion: ${config.mode} mode, ${backendLabel} backend (click to cycle mode)`;
  }
  statusBarItem.show();
}

export function deactivate() {
  completionProvider?.dispose();
}
