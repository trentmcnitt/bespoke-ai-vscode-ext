import * as vscode from 'vscode';
import { ExtensionConfig, Backend, ProfileOverrides } from './types';
import { CompletionProvider } from './completion-provider';
import { ProviderRouter } from './providers/provider-router';
import { Logger } from './utils/logger';
import { shortenModelName } from './utils/model-name';
import { applyProfile } from './utils/profile';
import { generateCommitMessage } from './commit-message';
import { ContextOracle } from './oracle/context-oracle';
import { UsageTracker } from './utils/usage-tracker';

const MODE_LABELS = ['auto', 'prose', 'code'] as const;
type ModeLabel = (typeof MODE_LABELS)[number];
const MODE_ICONS: Record<string, string> = {
  auto: '$(symbol-misc)',
  prose: '$(book)',
  code: '$(code)',
};

function getActiveModel(config: ExtensionConfig): string {
  switch (config.backend) {
    case 'anthropic':
      return config.anthropic.model;
    case 'ollama':
      return config.ollama.model;
    case 'claude-code':
      return config.claudeCode.model;
  }
}

let statusBarItem: vscode.StatusBarItem;
let completionProvider: CompletionProvider;
let providerRouter: ProviderRouter;
let logger: Logger;
let currentProfile = '';
let activeRequests = 0;
let lastConfig: ExtensionConfig;
let oracle: ContextOracle;
let usageTracker: UsageTracker;

export function activate(context: vscode.ExtensionContext) {
  logger = new Logger('Bespoke AI');
  context.subscriptions.push(logger);

  const config = loadConfig();
  logger.setLevel(config.logLevel);
  currentProfile = config.activeProfile;
  lastConfig = config;

  usageTracker = new UsageTracker();

  oracle = new ContextOracle(config.oracle, logger);
  oracle.activate(context);
  context.subscriptions.push({ dispose: () => oracle.dispose() });

  providerRouter = new ProviderRouter(config, logger, (filePath) => oracle.getBrief(filePath));
  context.subscriptions.push({ dispose: () => providerRouter.dispose() });

  providerRouter.setTokenUsageCallback((model, input, output, cacheRead, cacheWrite) => {
    usageTracker.recordTokens(model, input, output, cacheRead, cacheWrite);
  });

  // Activate Claude Code provider with workspace root (async, non-blocking)
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  providerRouter.activateClaudeCode(workspaceRoot).catch((err) => {
    logger.error(`Claude Code activation failed: ${err}`);
  });

  completionProvider = new CompletionProvider(config, providerRouter, logger, usageTracker);

  completionProvider.setRequestCallbacks(
    () => {
      activeRequests++;
      if (activeRequests === 1) {
        updateStatusBarSpinner(true);
      }
    },
    () => {
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests === 0) {
        updateStatusBarSpinner(false);
      }
    },
  );

  // Register inline completion provider
  const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    completionProvider,
  );
  context.subscriptions.push(providerDisposable);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'bespoke-ai.showMenu';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(config);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.trigger', () => {
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.toggleEnabled', () => {
      const ws = vscode.workspace.getConfiguration('bespokeAI');
      const current = ws.get<boolean>('enabled', true);
      ws.update('enabled', !current, vscode.ConfigurationTarget.Global);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.cycleMode', () => {
      const ws = vscode.workspace.getConfiguration('bespokeAI');
      const current = ws.get<string>('mode', 'auto') as ModeLabel;
      const idx = MODE_LABELS.indexOf(current);
      const next = MODE_LABELS[(idx + 1) % MODE_LABELS.length];
      ws.update('mode', next, vscode.ConfigurationTarget.Global);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.clearCache', () => {
      completionProvider.clearCache();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.selectProfile', async () => {
      const ws = vscode.workspace.getConfiguration('bespokeAI');
      const profiles = ws.get<Record<string, ProfileOverrides>>('profiles', {})!;
      const names = Object.keys(profiles);
      if (names.length === 0) {
        vscode.window.showInformationMessage(
          'No profiles configured. Add them in bespokeAI.profiles.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(['(none)', ...names], {
        placeHolder: `Current: ${ws.get<string>('activeProfile', '') || '(none)'}`,
        title: 'Select Completion Profile',
      });
      if (picked === undefined) {
        return;
      }
      await ws.update(
        'activeProfile',
        picked === '(none)' ? '' : picked,
        vscode.ConfigurationTarget.Global,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.showMenu', async () => {
      const ws = vscode.workspace.getConfiguration('bespokeAI');
      const config = lastConfig;

      type MenuHandler = () => void | Promise<void>;
      const handlers = new Map<vscode.QuickPickItem, MenuHandler>();

      const items: vscode.QuickPickItem[] = [];

      // --- Mode section ---
      items.push({ label: 'Mode', kind: vscode.QuickPickItemKind.Separator });
      for (const m of MODE_LABELS) {
        const isCurrent = config.mode === m;
        const item: vscode.QuickPickItem = {
          label: `${MODE_ICONS[m]} ${m}`,
          description: isCurrent ? '(current)' : '',
        };
        items.push(item);
        handlers.set(item, () => {
          ws.update('mode', m, vscode.ConfigurationTarget.Global);
        });
      }

      // --- Profile section (only if profiles exist) ---
      const profiles = ws.get<Record<string, ProfileOverrides>>('profiles', {})!;
      const profileNames = Object.keys(profiles);
      if (profileNames.length > 0) {
        items.push({ label: 'Profile', kind: vscode.QuickPickItemKind.Separator });

        const noneItem: vscode.QuickPickItem = {
          label: '$(circle-slash) (none)',
          description: !config.activeProfile ? '(current)' : '',
        };
        items.push(noneItem);
        handlers.set(noneItem, () => {
          ws.update('activeProfile', '', vscode.ConfigurationTarget.Global);
        });

        for (const name of profileNames) {
          const isCurrent = config.activeProfile === name;
          const item: vscode.QuickPickItem = {
            label: `$(gear) ${name}`,
            description: isCurrent ? '(current)' : '',
          };
          items.push(item);
          handlers.set(item, () => {
            ws.update('activeProfile', name, vscode.ConfigurationTarget.Global);
          });
        }
      }

      // --- Actions section ---
      items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });

      const toggleItem: vscode.QuickPickItem = {
        label: config.enabled ? '$(debug-pause) Disable' : '$(debug-start) Enable',
      };
      items.push(toggleItem);
      handlers.set(toggleItem, () => {
        ws.update('enabled', !config.enabled, vscode.ConfigurationTarget.Global);
      });

      const clearCacheItem: vscode.QuickPickItem = {
        label: '$(trash) Clear Cache',
      };
      items.push(clearCacheItem);
      handlers.set(clearCacheItem, () => {
        completionProvider.clearCache();
      });

      const openSettingsItem: vscode.QuickPickItem = {
        label: '$(settings-gear) Open Settings',
      };
      items.push(openSettingsItem);
      handlers.set(openSettingsItem, () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'bespokeAI');
      });

      const openLogItem: vscode.QuickPickItem = {
        label: '$(output) Open Output Log',
      };
      items.push(openLogItem);
      handlers.set(openLogItem, () => {
        logger.show();
      });

      // --- Usage section ---
      const snap = usageTracker.getSnapshot();
      if (snap.totalToday > 0) {
        items.push({ label: 'Usage', kind: vscode.QuickPickItemKind.Separator });

        const icon = snap.isBurst ? '$(warning) $(pulse)' : '$(pulse)';
        const usageItem: vscode.QuickPickItem = {
          label: `${icon} ${snap.totalToday} requests today`,
          description: `${snap.ratePerMinute}/min`,
        };
        items.push(usageItem);
        handlers.set(usageItem, () => showUsageDetail());
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Bespoke AI',
        placeHolder: 'Select an option',
      });

      if (picked) {
        const handler = handlers.get(picked);
        if (handler) {
          await handler();
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.generateCommitMessage', async () => {
      await generateCommitMessage(logger);
    }),
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bespokeAI')) {
        const newConfig = loadConfig();

        if (newConfig.activeProfile !== currentProfile) {
          completionProvider.clearCache();
          logger.info(`Profile → ${newConfig.activeProfile || '(none)'} (cache cleared)`);
          currentProfile = newConfig.activeProfile;
        }

        logger.setLevel(newConfig.logLevel);
        oracle.updateConfig(newConfig.oracle);
        completionProvider.updateConfig(newConfig);
        updateStatusBar(newConfig);
        logger.info('Configuration updated');
      }
    }),
  );

  // Warn if no API key when using Anthropic (not needed for claude-code backend)
  if (config.backend === 'anthropic' && !config.anthropic.apiKey) {
    logger.info('No Anthropic API key configured');
    vscode.window.showWarningMessage(
      'Bespoke AI: No Anthropic API key configured. Set it in Settings → Bespoke AI → Anthropic: Api Key.',
    );
  }

  logger.info(
    `Activated | ${config.backend} | profile=${config.activeProfile || '(none)'} | logLevel=${config.logLevel}`,
  );
}

function loadConfig(): ExtensionConfig {
  const ws = vscode.workspace.getConfiguration('bespokeAI');

  const apiKey = ws.get<string>('anthropic.apiKey', '');

  const activeProfile = ws.get<string>('activeProfile', '')!;

  const baseConfig: ExtensionConfig = {
    enabled: ws.get<boolean>('enabled', true)!,
    backend: ws.get<Backend>('backend', 'claude-code')!,
    mode: ws.get<'auto' | 'prose' | 'code'>('mode', 'auto')!,
    debounceMs: ws.get<number>('debounceMs', 300)!,
    anthropic: {
      apiKey,
      model: ws.get<string>('anthropic.model', 'claude-haiku-4-5-20251001')!,
      models: ws.get<string[]>('anthropic.models', [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
      ])!,
      useCaching: ws.get<boolean>('anthropic.useCaching', true)!,
      apiCallsEnabled: ws.get<boolean>('anthropic.apiCallsEnabled', true)!,
    },
    ollama: {
      endpoint: ws.get<string>('ollama.endpoint', 'http://localhost:11434')!,
      model: ws.get<string>('ollama.model', 'qwen2.5:3b')!,
      models: ws.get<string[]>('ollama.models', [
        'qwen2.5:3b',
        'qwen2.5-coder:3b',
        'llama3.2:3b',
        'deepseek-coder-v2:latest',
      ])!,
      raw: ws.get<boolean>('ollama.raw', true)!,
    },
    prose: {
      maxTokens: ws.get<number>('prose.maxTokens', 100)!,
      temperature: ws.get<number>('prose.temperature', 0.7)!,
      stopSequences: ws.get<string[]>('prose.stopSequences', ['---', '##'])!,
      contextChars: ws.get<number>('prose.contextChars', 2000)!,
      suffixChars: ws.get<number>('prose.suffixChars', 2500)!,
      fileTypes: ws.get<string[]>('prose.fileTypes', ['markdown', 'plaintext'])!,
    },
    code: {
      maxTokens: ws.get<number>('code.maxTokens', 256)!,
      temperature: ws.get<number>('code.temperature', 0.2)!,
      stopSequences: ws.get<string[]>('code.stopSequences', [])!,
      contextChars: ws.get<number>('code.contextChars', 4000)!,
      suffixChars: ws.get<number>('code.suffixChars', 2500)!,
    },
    claudeCode: {
      model: ws.get<string>('claudeCode.model', 'haiku')!,
      models: ws.get<string[]>('claudeCode.models', ['haiku', 'sonnet', 'opus'])!,
    },
    logLevel: ws.get<'info' | 'debug' | 'trace'>('logLevel', 'info')!,
    activeProfile,
    oracle: {
      enabled: ws.get<boolean>('oracle.enabled', false)!,
      debounceMs: ws.get<number>('oracle.debounceMs', 2000)!,
      briefTtlMs: ws.get<number>('oracle.briefTtlMs', 300000)!,
      model: ws.get<string>('oracle.model', 'sonnet')!,
      allowedTools: ws.get<string[]>('oracle.allowedTools', ['Read', 'Grep', 'Glob'])!,
    },
  };

  if (activeProfile) {
    const profiles = ws.get<Record<string, ProfileOverrides>>('profiles', {})!;
    const profile = profiles[activeProfile];
    if (profile) {
      return applyProfile(baseConfig, profile);
    }
    logger?.info(`Profile "${activeProfile}" not found, using base settings`);
  }

  return baseConfig;
}

function updateStatusBar(config: ExtensionConfig) {
  lastConfig = config;
  if (!config.enabled) {
    statusBarItem.text = '$(circle-slash) AI Off';
    statusBarItem.tooltip = 'Bespoke AI: Disabled (click for menu)';
  } else {
    const activeModel = getActiveModel(config);
    const modelLabel = shortenModelName(activeModel);
    statusBarItem.text = `${MODE_ICONS[config.mode]} ${config.mode} | ${modelLabel}`;

    const profileInfo = config.activeProfile ? `, profile: ${config.activeProfile}` : '';
    statusBarItem.tooltip = `Bespoke AI: ${config.mode} mode, ${config.backend} (${activeModel})${profileInfo} (click for menu)`;
  }
  statusBarItem.show();
}

function updateStatusBarSpinner(spinning: boolean) {
  const config = lastConfig;
  if (!config.enabled) {
    return;
  }

  if (spinning) {
    const modelLabel = shortenModelName(getActiveModel(config));
    statusBarItem.text = `$(loading~spin) ${config.mode} | ${modelLabel}`;
  } else {
    updateStatusBar(config);
  }
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(0)}K`;
  }
  return String(count);
}

async function showUsageDetail(): Promise<void> {
  const snap = usageTracker.getSnapshot();
  const sessionDuration = formatDuration(Date.now() - snap.sessionStartTime);

  const items: vscode.QuickPickItem[] = [];

  // Session info
  items.push({ label: 'Session Info', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: `$(clock) Session: ${sessionDuration}` });
  items.push({
    label: `$(pulse) ${snap.totalToday} requests today`,
    description: `${snap.ratePerMinute}/min`,
  });
  items.push({
    label: `$(check) Cache hit rate: ${snap.cacheHitRate}%`,
    description: `${snap.cacheHits} hits / ${snap.cacheMisses} misses`,
  });
  if (snap.errors > 0) {
    items.push({ label: `$(error) ${snap.errors} errors` });
  }

  // Requests by model
  const modelEntries = Object.entries(snap.byModel);
  if (modelEntries.length > 0) {
    items.push({ label: 'Requests by Model', kind: vscode.QuickPickItemKind.Separator });
    for (const [model, count] of modelEntries.sort((a, b) => b[1] - a[1])) {
      items.push({ label: `$(server) ${model}`, description: `${count}` });
    }
  }

  // API cost
  const totalTokens =
    snap.tokens.input + snap.tokens.output + snap.tokens.cacheRead + snap.tokens.cacheWrite;
  if (totalTokens > 0) {
    items.push({ label: 'API Cost (Anthropic)', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: `$(credit-card) Tokens: ${formatTokenCount(snap.tokens.input)} in / ${formatTokenCount(snap.tokens.output)} out`,
    });
    if (snap.tokens.cacheRead > 0 || snap.tokens.cacheWrite > 0) {
      items.push({
        label: `$(credit-card) Cache: ${formatTokenCount(snap.tokens.cacheRead)} read / ${formatTokenCount(snap.tokens.cacheWrite)} write`,
      });
    }
    items.push({ label: `$(credit-card) Estimated cost: $${snap.estimatedCostUsd.toFixed(2)}` });
  }

  await vscode.window.showQuickPick(items, {
    title: 'Bespoke AI — Usage Details',
    placeHolder: 'Session usage statistics',
  });
}

export function deactivate() {
  completionProvider?.dispose();
}
