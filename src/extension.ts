import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_MODEL, ExtensionConfig } from './types';
import { CompletionProvider } from './completion-provider';
import { PoolClient } from './pool-server/client';
import { Logger } from './utils/logger';
import { shortenModelName } from './utils/model-name';
import { generateCommitMessage } from './commit-message';
import { suggestEdit, originalContentProvider, correctedContentProvider } from './suggest-edit';
import { explainSelection, fixSelection, doSelection } from './commands/context-menu';
import { UsageTracker } from './utils/usage-tracker';
import { UsageLedger } from './utils/usage-ledger';

const MODE_LABELS = ['auto', 'prose', 'code'] as const;
type ModeLabel = (typeof MODE_LABELS)[number];
const MODE_ICONS: Record<string, string> = {
  auto: '$(symbol-misc)',
  prose: '$(book)',
  code: '$(code)',
};

let statusBarItem: vscode.StatusBarItem;
let completionProvider: CompletionProvider;
let poolClient: PoolClient;
let logger: Logger;
let activeRequests = 0;
let lastConfig: ExtensionConfig;
let usageTracker: UsageTracker;
let usageLedger: UsageLedger;

export function activate(context: vscode.ExtensionContext) {
  logger = new Logger('Bespoke AI');
  context.subscriptions.push(logger);

  const config = loadConfig();
  logger.setLevel(config.logLevel);
  lastConfig = config;

  usageTracker = new UsageTracker();

  usageLedger = new UsageLedger(
    path.join(os.homedir(), '.bespokeai', 'usage-ledger.jsonl'),
    logger,
  );
  context.subscriptions.push({ dispose: () => usageLedger.dispose() });

  // Generate unique client ID for this VS Code window
  const clientId = `vscode-${process.pid}-${Date.now().toString(36)}`;

  // Create global pool client
  poolClient = new PoolClient({
    config,
    logger,
    ledger: usageLedger,
    clientId,
    onPoolDegraded: async (pool) => {
      if (pool === 'completion') {
        const action = await vscode.window.showErrorMessage(
          'Bespoke AI: Autocomplete unavailable — warmup validation failed after retry.',
          'Restart',
        );
        if (action === 'Restart') {
          poolClient.restart().catch((err) => {
            logger.error(`Pool restart failed: ${err}`);
          });
        }
      } else {
        logger.error('CommandPool degraded');
      }
    },
    onRoleChange: (role) => {
      logger.info(`Pool client role changed to: ${role}`);
    },
  });
  context.subscriptions.push({ dispose: () => poolClient.dispose() });

  // Only start pools if enabled — disabled = hard kill (no subprocesses)
  if (config.enabled) {
    poolClient.activate().catch((err) => {
      logger.error(`Pool client activation failed: ${err}`);
    });
  } else {
    logger.info('Extension disabled at startup — pools not started');
  }

  completionProvider = new CompletionProvider(config, poolClient, logger, usageTracker);
  context.subscriptions.push({ dispose: () => completionProvider.dispose() });

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

      // --- Model section ---
      items.push({ label: 'Model', kind: vscode.QuickPickItemKind.Separator });
      for (const model of config.claudeCode.models) {
        const isCurrent = config.claudeCode.model === model;
        const item: vscode.QuickPickItem = {
          label: `$(server) ${model}`,
          description: isCurrent ? '(current)' : '',
        };
        items.push(item);
        handlers.set(item, () => {
          ws.update('claudeCode.model', model, vscode.ConfigurationTarget.Global);
        });
      }

      // --- Actions section ---
      items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });

      const triggerItem: vscode.QuickPickItem = {
        label: config.triggerMode === 'auto' ? '$(zap) Auto-trigger' : '$(zap) On-demand',
        description:
          config.triggerMode === 'auto'
            ? 'click to switch to on-demand'
            : 'click to switch to auto',
      };
      items.push(triggerItem);
      handlers.set(triggerItem, () => {
        const next = config.triggerMode === 'auto' ? 'manual' : 'auto';
        ws.update('triggerMode', next, vscode.ConfigurationTarget.Global);
      });

      const toggleItem: vscode.QuickPickItem = {
        label: config.enabled ? '$(debug-pause) Disable' : '$(debug-start) Enable',
        description: config.enabled ? 'shuts down all AI features' : 'starts pools back up',
      };
      items.push(toggleItem);
      handlers.set(toggleItem, () => {
        ws.update('enabled', !config.enabled, vscode.ConfigurationTarget.Global);
      });

      const suggestEditItem: vscode.QuickPickItem = {
        label: '$(edit) Suggest Edits',
      };
      items.push(suggestEditItem);
      handlers.set(suggestEditItem, () => {
        vscode.commands.executeCommand('bespoke-ai.suggestEdit');
      });

      const restartPoolsItem: vscode.QuickPickItem = {
        label: '$(refresh) Restart Pools',
        description: 'terminate and respawn all subprocesses',
      };
      items.push(restartPoolsItem);
      handlers.set(restartPoolsItem, () => {
        vscode.commands.executeCommand('bespoke-ai.restartPools');
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

      // --- Log Level section ---
      items.push({ label: 'Log Level', kind: vscode.QuickPickItemKind.Separator });
      const logLevels = ['info', 'debug', 'trace'] as const;
      for (const level of logLevels) {
        const isCurrent = config.logLevel === level;
        const icon = level === 'info' ? '$(info)' : level === 'debug' ? '$(bug)' : '$(list-tree)';
        const item: vscode.QuickPickItem = {
          label: `${icon} ${level}`,
          description: isCurrent ? '(current)' : '',
        };
        items.push(item);
        handlers.set(item, () => {
          ws.update('logLevel', level, vscode.ConfigurationTarget.Global);
        });
      }

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

      // --- Pool Status section ---
      if (config.enabled) {
        const poolStatus = await poolClient.getPoolStatus();
        if (poolStatus) {
          items.push({ label: 'Pool Status', kind: vscode.QuickPickItemKind.Separator });

          // Role and uptime
          const roleLabel = poolStatus.role === 'server' ? '$(broadcast) Server' : '$(plug) Client';
          const uptimeStr = poolStatus.completionPool?.uptimeMs
            ? formatDuration(poolStatus.completionPool.uptimeMs)
            : 'starting...';
          const roleItem: vscode.QuickPickItem = {
            label: roleLabel,
            description: `uptime: ${uptimeStr}`,
          };
          items.push(roleItem);

          // Helper to format slot state
          const slotIcon = (state: string) =>
            state === 'available'
              ? '$(check)'
              : state === 'busy'
                ? '$(sync~spin)'
                : state === 'initializing'
                  ? '$(loading~spin)'
                  : '$(error)';

          // Show completion pool stats
          if (poolStatus.completionPool) {
            const cp = poolStatus.completionPool;
            const slot = cp.slots[0];
            const item: vscode.QuickPickItem = {
              label: `${slotIcon(slot?.state ?? 'dead')} Completion`,
              description: `request slot ${slot?.requestCount ?? 0}/${slot?.maxRequests ?? 8} • ${cp.totalRequests} total requests • ${cp.totalRecycles} restarts`,
            };
            items.push(item);
          }

          // Show command pool stats
          if (poolStatus.commandPool) {
            const cmdPool = poolStatus.commandPool;
            const slot = cmdPool.slots[0];
            const item: vscode.QuickPickItem = {
              label: `${slotIcon(slot?.state ?? 'dead')} Command`,
              description: `request slot ${slot?.requestCount ?? 0}/${slot?.maxRequests ?? 8} • ${cmdPool.totalRequests} total requests • ${cmdPool.totalRecycles} restarts`,
            };
            items.push(item);
          }

          // Token breakdown
          const cp = poolStatus.completionPool;
          const cmd = poolStatus.commandPool;
          const totalIn = (cp?.totalInputTokens ?? 0) + (cmd?.totalInputTokens ?? 0);
          const totalOut = (cp?.totalOutputTokens ?? 0) + (cmd?.totalOutputTokens ?? 0);
          const totalCache = (cp?.totalCacheReadTokens ?? 0) + (cmd?.totalCacheReadTokens ?? 0);
          if (totalIn > 0 || totalOut > 0) {
            const cacheStr = totalCache > 0 ? ` • cache: ${totalCache.toLocaleString()}` : '';
            const tokensItem: vscode.QuickPickItem = {
              label: '$(symbol-number) Tokens',
              description: `in: ${totalIn.toLocaleString()} • out: ${totalOut.toLocaleString()}${cacheStr}`,
            };
            items.push(tokensItem);
          }

          // Cost
          const totalCost = (cp?.totalCostUsd ?? 0) + (cmd?.totalCostUsd ?? 0);
          if (totalCost > 0) {
            const costItem: vscode.QuickPickItem = {
              label: '$(credit-card) Cost',
              description: `$${totalCost.toFixed(4)} this session`,
            };
            items.push(costItem);
          }
        }
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
      if (!lastConfig.enabled) {
        vscode.window.showWarningMessage('Bespoke AI is disabled. Enable it first.');
        return;
      }
      await generateCommitMessage(poolClient, logger, usageLedger);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'bespoke-edit-original',
      originalContentProvider,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      'bespoke-edit-corrected',
      correctedContentProvider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.suggestEdit', async () => {
      if (!lastConfig.enabled) {
        vscode.window.showWarningMessage('Bespoke AI is disabled. Enable it first.');
        return;
      }
      await suggestEdit(poolClient, logger, usageLedger);
    }),
  );

  // Context menu commands (open Claude CLI in terminal)
  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.explainSelection', () =>
      explainSelection(lastConfig.contextMenu.permissionMode),
    ),
    vscode.commands.registerCommand('bespoke-ai.fixSelection', () =>
      fixSelection(lastConfig.contextMenu.permissionMode),
    ),
    vscode.commands.registerCommand('bespoke-ai.doSelection', () =>
      doSelection(lastConfig.contextMenu.permissionMode),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.restartPools', async () => {
      if (!lastConfig.enabled) {
        vscode.window.showWarningMessage('Bespoke AI is disabled. Enable it first.');
        return;
      }
      try {
        await poolClient.restart();
        completionProvider.clearCache();
        vscode.window.showInformationMessage('Bespoke AI: Pools restarted.');
      } catch (err) {
        logger.error(`Pool restart failed: ${err}`);
        vscode.window.showErrorMessage(`Bespoke AI: Pool restart failed — ${err}`);
      }
    }),
  );

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('bespokeAI')) {
        const newConfig = loadConfig();
        const prevConfig = lastConfig;
        lastConfig = newConfig;

        // Propagate config before recycling so initSlot uses the new model
        logger.setLevel(newConfig.logLevel);
        completionProvider.updateConfig(newConfig);

        // Hard kill / restart pools when enabled changes
        const enabledChanged = newConfig.enabled !== prevConfig.enabled;
        if (enabledChanged) {
          if (!newConfig.enabled) {
            logger.info('Disabled — shutting down pools');
            poolClient.dispose();
          } else {
            logger.info('Enabled — restarting pools');
            // Re-activate the same client instance to preserve references
            poolClient.updateConfig(newConfig);
            poolClient.activate().catch((err) => {
              logger.error(`Pool client activation failed: ${err}`);
            });
          }
        }

        // Recycle pools when model changes (skip if we just restarted — restart picks up new model)
        if (
          newConfig.enabled &&
          !enabledChanged &&
          newConfig.claudeCode.model !== prevConfig.claudeCode.model
        ) {
          logger.info(`Model → ${newConfig.claudeCode.model} (recycling pools + clearing cache)`);
          completionProvider.clearCache();
          poolClient.updateConfig(newConfig);
        }

        updateStatusBar(newConfig);
        logger.info('Configuration updated');
      }
    }),
  );

  // Cleanup handlers for unexpected termination (crash, SIGTERM, etc.)
  const cleanup = () => {
    poolClient?.dispose();
  };

  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Remove signal handlers on deactivate to avoid double-cleanup
  context.subscriptions.push({
    dispose: () => {
      process.removeListener('exit', cleanup);
      process.removeListener('SIGTERM', cleanup);
      process.removeListener('SIGINT', cleanup);
    },
  });

  logger.info(`Activated | logLevel=${config.logLevel}`);
}

function loadConfig(): ExtensionConfig {
  const ws = vscode.workspace.getConfiguration('bespokeAI');

  return {
    enabled: ws.get<boolean>('enabled', true)!,
    mode: ws.get<'auto' | 'prose' | 'code'>('mode', 'auto')!,
    triggerMode: ws.get<'auto' | 'manual'>('triggerMode', 'auto')!,
    debounceMs: ws.get<number>('debounceMs', 8000)!,
    prose: {
      contextChars: ws.get<number>('prose.contextChars', 2500)!,
      suffixChars: ws.get<number>('prose.suffixChars', 2000)!,
      fileTypes: ws.get<string[]>('prose.fileTypes', [])!,
    },
    code: {
      contextChars: ws.get<number>('code.contextChars', 2500)!,
      suffixChars: ws.get<number>('code.suffixChars', 2000)!,
    },
    claudeCode: {
      model: ws.get<string>('claudeCode.model', DEFAULT_MODEL)!,
      models: ws.get<string[]>('claudeCode.models', ['haiku', 'sonnet', 'opus'])!,
    },
    contextMenu: {
      permissionMode: ws.get<'default' | 'acceptEdits' | 'bypassPermissions'>(
        'contextMenu.permissionMode',
        'default',
      )!,
    },
    logLevel: ws.get<'info' | 'debug' | 'trace'>('logLevel', 'info')!,
  };
}

function updateStatusBar(config: ExtensionConfig) {
  if (!config.enabled) {
    statusBarItem.text = '$(circle-slash) AI Off';
    statusBarItem.tooltip = 'Bespoke AI: Disabled (click for menu)';
  } else {
    const modelLabel = shortenModelName(config.claudeCode.model);
    const triggerIcon = config.triggerMode === 'auto' ? '$(zap)' : '$(hand)';
    statusBarItem.text = `${triggerIcon} ${config.mode} | ${modelLabel}`;

    const triggerLabel = config.triggerMode === 'auto' ? 'auto' : 'manual';
    statusBarItem.tooltip = `Bespoke AI: ${config.mode} mode, ${triggerLabel} trigger, ${config.claudeCode.model} (click for menu)`;
  }
  statusBarItem.show();
}

function updateStatusBarSpinner(spinning: boolean) {
  const config = lastConfig;
  if (!config.enabled) {
    return;
  }

  if (spinning) {
    const modelLabel = shortenModelName(config.claudeCode.model);
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

function formatCharCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return String(count);
}

function formatCost(usd: number): string {
  if (usd === 0) {
    return '$0.00';
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

async function showUsageDetail(): Promise<void> {
  const snap = usageTracker.getSnapshot();
  const sessionDuration = formatDuration(Date.now() - snap.sessionStartTime);
  const ledgerSummary = usageLedger.getSummary();

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

  // Requests by model (session)
  const modelEntries = Object.entries(snap.byModel);
  if (modelEntries.length > 0) {
    items.push({ label: 'Requests by Model', kind: vscode.QuickPickItemKind.Separator });
    for (const [model, count] of modelEntries.sort((a, b) => b[1] - a[1])) {
      items.push({ label: `$(server) ${model}`, description: `${count}` });
    }
  }

  // Character counts (session)
  const totalChars = snap.totalInputChars + snap.totalOutputChars;
  if (totalChars > 0) {
    items.push({ label: 'Characters', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: `$(file) Input: ${formatCharCount(snap.totalInputChars)}`,
      description: `Output: ${formatCharCount(snap.totalOutputChars)}`,
    });
  }

  // Persistent stats from ledger
  const { today, thisWeek, thisMonth } = ledgerSummary;
  if (today.requests > 0 || thisWeek.requests > 0 || thisMonth.requests > 0) {
    items.push({ label: 'Persistent Stats', kind: vscode.QuickPickItemKind.Separator });

    items.push({
      label: `$(calendar) Today: ${today.requests} requests`,
      description: today.startups > 0 ? `${today.startups} startups` : '',
    });
    if (today.inputTokens > 0 || today.outputTokens > 0) {
      items.push({
        label: `  $(arrow-up) ${formatCharCount(today.inputTokens)} in`,
        description: `$(arrow-down) ${formatCharCount(today.outputTokens)} out`,
      });
    }
    if (today.costUsd > 0) {
      items.push({ label: `  $(credit-card) ${formatCost(today.costUsd)}` });
    }

    items.push({
      label: `$(calendar) This week: ${thisWeek.requests} requests`,
      description: thisWeek.startups > 0 ? `${thisWeek.startups} startups` : '',
    });
    if (thisWeek.costUsd > 0) {
      items.push({ label: `  $(credit-card) ${formatCost(thisWeek.costUsd)}` });
    }

    items.push({
      label: `$(calendar) This month: ${thisMonth.requests} requests`,
      description: thisMonth.startups > 0 ? `${thisMonth.startups} startups` : '',
    });
    if (thisMonth.costUsd > 0) {
      items.push({ label: `  $(credit-card) ${formatCost(thisMonth.costUsd)}` });
    }
  }

  // Per-model breakdown from ledger
  const ledgerModels = Object.entries(ledgerSummary.byModel);
  if (ledgerModels.length > 0) {
    items.push({
      label: 'All-Time by Model',
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const [model, stats] of ledgerModels.sort((a, b) => b[1].requests - a[1].requests)) {
      const desc = [
        stats.inputTokens > 0 ? `${formatCharCount(stats.inputTokens)} in` : '',
        stats.outputTokens > 0 ? `${formatCharCount(stats.outputTokens)} out` : '',
        stats.costUsd > 0 ? formatCost(stats.costUsd) : '',
      ]
        .filter(Boolean)
        .join(' | ');
      items.push({
        label: `$(server) ${model}: ${stats.requests} requests`,
        description: desc,
      });
    }
  }

  await vscode.window.showQuickPick(items, {
    title: 'Bespoke AI — Usage Details',
    placeHolder: 'Session and persistent usage statistics',
  });
}

export function deactivate() {
  // Explicit cleanup — these may be no-ops if already disposed via subscriptions,
  // but ensures cleanup if subscription disposal fails
  completionProvider?.dispose();
  poolClient?.dispose();
  logger?.dispose();
}
