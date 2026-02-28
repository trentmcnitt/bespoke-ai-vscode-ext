import * as vscode from 'vscode';
import * as path from 'path';
import {
  DEFAULT_MODEL,
  ExtensionConfig,
  CustomPreset,
  TriggerPreset,
  resolvePreset,
} from './types';
import { CompletionProvider } from './completion-provider';
import { PoolClient } from './pool-server/client';
import { BackendRouter } from './providers/backend-router';
import { ApiCompletionProvider } from './providers/api/api-provider';
import { ApiCommandProvider } from './providers/api/api-command-provider';
import { getPreset, getAllPresets, registerCustomPresets, slugify } from './providers/api/presets';
import { Logger } from './utils/logger';
import { shortenModelName } from './utils/model-name';
import { generateCommitMessage } from './commit-message';
import { suggestEdit, originalContentProvider, correctedContentProvider } from './suggest-edit';
import { explainSelection, fixSelection, doSelection } from './commands/context-menu';
import { UsageTracker } from './utils/usage-tracker';
import { UsageLedger } from './utils/usage-ledger';
import {
  initSecretStorage,
  loadSecretKey,
  storeSecretKey,
  removeSecretKey,
  resolveApiKeySource,
  type ApiKeySource,
} from './utils/api-key-store';
import { STATE_DIR } from './pool-server';

const MODE_LABELS = ['auto', 'prose', 'code'] as const;
type ModeLabel = (typeof MODE_LABELS)[number];
const MODE_ICONS: Record<string, string> = {
  auto: '$(symbol-misc)',
  prose: '$(book)',
  code: '$(code)',
};

const PRESET_LABELS: TriggerPreset[] = ['relaxed', 'eager', 'on-demand'];
const PRESET_ICONS: Record<TriggerPreset, string> = {
  relaxed: '$(watch)',
  eager: '$(zap)',
  'on-demand': '$(hand)',
};
const PRESET_DESCRIPTIONS: Record<TriggerPreset, string> = {
  relaxed: 'auto, ~2s delay',
  eager: 'auto, ~800ms delay',
  'on-demand': 'Alt+Enter only',
};

type StatusBarState = 'initializing' | 'ready' | 'setup-needed' | 'disabled';

const SETUP_URL = 'https://docs.anthropic.com/en/docs/claude-code/setup';
const WELCOME_SHOWN_KEY = 'bespokeAI.welcomeShown';
const API_WELCOME_SHOWN_KEY = 'bespokeAI.apiWelcomeShown';

let statusBarItem: vscode.StatusBarItem;
let statusBarState: StatusBarState = 'initializing';
let completionProvider: CompletionProvider;
let poolClient: PoolClient;
let backendRouter: BackendRouter;
let logger: Logger;
let activeRequests = 0;
let lastConfig: ExtensionConfig;
let usageTracker: UsageTracker;
let usageLedger: UsageLedger;
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  logger = new Logger('Bespoke AI');
  context.subscriptions.push(logger);

  const config = loadConfig();
  logger.setLevel(config.logLevel);
  lastConfig = config;

  usageTracker = new UsageTracker();
  registerCustomPresets(config.api.customPresets);

  usageLedger = new UsageLedger(path.join(STATE_DIR, 'usage-ledger.jsonl'), logger);
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
        updateStatusBar(lastConfig, 'setup-needed');
        const action = await vscode.window.showErrorMessage(
          'Bespoke AI: Autocomplete unavailable. Claude Code may need authentication — run `claude` in your terminal to log in.',
          'Restart',
          'Open Terminal',
        );
        if (action === 'Restart') {
          poolClient.restart().catch((err) => {
            logger.error(`Pool restart failed: ${err}`);
          });
        } else if (action === 'Open Terminal') {
          const terminal = vscode.window.createTerminal('Claude Login');
          terminal.show();
          terminal.sendText('claude');
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

  // Initialize SecretStorage for secure API key management
  initSecretStorage(context.secrets);
  // Eagerly load known API keys so resolveApiKey() stays synchronous.
  // Includes built-in env vars and any custom preset env vars.
  const knownApiKeyVars = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']);
  for (const cp of config.api.customPresets) {
    if (cp.apiKeyEnvVar) knownApiKeyVars.add(cp.apiKeyEnvVar);
  }
  Promise.all([...knownApiKeyVars].map(loadSecretKey)).catch((err) => {
    logger.error(`Failed to load API keys from SecretStorage: ${err}`);
  });

  // Create API providers (lightweight — no subprocess, just hold config)
  const apiCompletion = new ApiCompletionProvider(config, logger, usageLedger);
  const apiCommand = new ApiCommandProvider(config, logger, usageLedger);

  // BackendRouter wraps both backends
  backendRouter = new BackendRouter(poolClient, apiCompletion, apiCommand, config);
  context.subscriptions.push({ dispose: () => backendRouter.dispose() });

  // Set context for context menu visibility (CLI-only commands)
  vscode.commands.executeCommand(
    'setContext',
    'bespokeAI.cliAvailable',
    config.backend === 'claude-code',
  );

  // Status bar — must be created before any code path calls updateStatusBar()
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'bespoke-ai.showMenu';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(config, config.enabled ? 'initializing' : 'disabled');

  // Only start Claude Code pools if enabled and backend is claude-code
  if (config.enabled && config.backend === 'claude-code') {
    activateWithPreflight(config, context).catch((err) => {
      logger.error(`Pool activation failed: ${err}`);
    });
  } else if (config.enabled && config.backend === 'api') {
    // API backend — ready immediately (no subprocess startup needed)
    const apiAvailable = apiCompletion.isAvailable();
    updateStatusBar(config, apiAvailable ? 'ready' : 'setup-needed');
    if (!apiAvailable) {
      showApiSetupGuidance(config);
    }
  } else {
    logger.info('Extension disabled at startup — pools not started');
  }

  completionProvider = new CompletionProvider(config, backendRouter, logger, usageTracker);
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

      // --- Backend section ---
      items.push({ label: 'Backend', kind: vscode.QuickPickItemKind.Separator });
      const backends = [
        {
          id: 'claude-code' as const,
          label: '$(terminal) Claude Code CLI',
          description: 'requires Claude subscription',
        },
        { id: 'api' as const, label: '$(globe) Direct API', description: 'requires API key' },
      ];
      for (const b of backends) {
        const isCurrent = config.backend === b.id;
        const item: vscode.QuickPickItem = {
          label: b.label,
          description: `${b.description}${isCurrent ? ' (current)' : ''}`,
        };
        items.push(item);
        handlers.set(item, () => {
          ws.update('backend', b.id, vscode.ConfigurationTarget.Global);
        });
      }

      // --- Model section (Claude Code) or API Model section ---
      if (config.backend === 'api') {
        items.push({ label: 'Model', kind: vscode.QuickPickItemKind.Separator });
        const allPresets = getAllPresets();
        for (const preset of allPresets) {
          const isCurrent = config.api.preset === preset.id;
          const isCustom = preset.id.startsWith('custom-');
          const descParts: string[] = [];
          if (preset.description) descParts.push(preset.description);
          if (isCustom) descParts.push(preset.modelId);
          // Show key status per preset
          if (preset.apiKeyEnvVar) {
            const keySource = resolveApiKeySource(preset.apiKeyEnvVar);
            descParts.push(formatKeySource(keySource));
          } else {
            descParts.push('no key needed');
          }
          if (isCurrent) descParts.push('(current)');

          const item: vscode.QuickPickItem = {
            label: `$(server) ${preset.displayName}`,
            description: descParts.join(' · '),
          };
          items.push(item);
          handlers.set(item, () => {
            ws.update('api.preset', preset.id, vscode.ConfigurationTarget.Global);
          });
        }

        // "Add Custom Model" at the end of the Model section
        const addModelItem: vscode.QuickPickItem = {
          label: '$(add) Add Custom Model...',
          description: '',
        };
        items.push(addModelItem);
        handlers.set(addModelItem, () => {
          vscode.commands.executeCommand('bespoke-ai.addCustomModel');
        });
      } else {
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
      }

      // --- Trigger Preset section ---
      items.push({ label: 'Trigger', kind: vscode.QuickPickItemKind.Separator });
      for (const preset of PRESET_LABELS) {
        const isCurrent = config.triggerPreset === preset;
        const item: vscode.QuickPickItem = {
          label: `${PRESET_ICONS[preset]} ${preset}`,
          description: `${PRESET_DESCRIPTIONS[preset]}${isCurrent ? ' (current)' : ''}`,
        };
        items.push(item);
        handlers.set(item, () => {
          ws.update('triggerPreset', preset, vscode.ConfigurationTarget.Global);
        });
      }

      // --- Actions section ---
      items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });

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

      if (config.backend === 'api') {
        const activePreset = getPreset(config.api.preset);
        const keyEnvVar = activePreset?.apiKeyEnvVar;
        const keySource = keyEnvVar ? resolveApiKeySource(keyEnvVar) : null;
        const keyDesc = keySource ? formatKeySource(keySource) : 'not set — required';
        const keyItem: vscode.QuickPickItem = {
          label: '$(key) Enter API Key',
          description: keyEnvVar ? keyDesc : 'no key needed',
        };
        items.push(keyItem);
        handlers.set(keyItem, () => {
          vscode.commands.executeCommand('bespoke-ai.setApiKey');
        });

        // Show "Remove Custom Model" when custom presets exist
        if (config.api.customPresets.length > 0) {
          const removeModelItem: vscode.QuickPickItem = {
            label: '$(trash) Remove Custom Model',
            description: '',
          };
          items.push(removeModelItem);
          handlers.set(removeModelItem, () => {
            vscode.commands.executeCommand('bespoke-ai.removeCustomModel');
          });
        }
      } else {
        const restartPoolsItem: vscode.QuickPickItem = {
          label: '$(refresh) Restart Pools',
          description: 'terminate and respawn all subprocesses',
        };
        items.push(restartPoolsItem);
        handlers.set(restartPoolsItem, () => {
          vscode.commands.executeCommand('bespoke-ai.restartPools');
        });
      }

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
      const ledgerSummary = usageLedger.getSummary();
      if (snap.totalToday > 0 || ledgerSummary.today.requests > 0) {
        items.push({ label: 'Usage', kind: vscode.QuickPickItemKind.Separator });

        const icon = snap.isBurst ? '$(warning) $(pulse)' : '$(pulse)';
        const requestCount = Math.max(snap.totalToday, ledgerSummary.today.requests);
        const usageItem: vscode.QuickPickItem = {
          label: `${icon} ${requestCount} requests today`,
          description: `${snap.ratePerMinute}/min`,
        };
        items.push(usageItem);
        handlers.set(usageItem, () => showUsageDetail());

        // Show API cost if any
        if (ledgerSummary.today.costUsd > 0) {
          const costItem: vscode.QuickPickItem = {
            label: `$(credit-card) ${formatCost(ledgerSummary.today.costUsd)} today`,
            description: config.backend === 'api' ? 'API usage' : '',
          };
          items.push(costItem);
          handlers.set(costItem, () => showUsageDetail());
        }
      }

      // --- Pool Status section (CLI backend only) ---
      if (config.enabled && config.backend === 'claude-code') {
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
              description: `${formatCost(totalCost)} this session`,
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
      await generateCommitMessage(backendRouter, logger, usageLedger);
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
      await suggestEdit(backendRouter, logger, usageLedger);
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

  // API key management commands — dynamically built from registered presets
  const PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    xai: 'xAI',
    ollama: 'Ollama',
  };

  function getApiKeyProviderItems(): vscode.QuickPickItem[] {
    const seen = new Set<string>();
    const items: vscode.QuickPickItem[] = [];
    for (const preset of getAllPresets()) {
      if (!preset.apiKeyEnvVar || seen.has(preset.apiKeyEnvVar)) continue;
      seen.add(preset.apiKeyEnvVar);
      items.push({
        label: PROVIDER_LABELS[preset.provider] ?? preset.displayName,
        description: preset.apiKeyEnvVar,
        detail: preset.apiKeyEnvVar,
      });
    }
    return items;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.setApiKey', async () => {
      const providerItems = getApiKeyProviderItems();
      if (providerItems.length === 0) {
        vscode.window.showInformationMessage('No API presets require an API key.');
        return;
      }
      const provider = await vscode.window.showQuickPick(providerItems, {
        title: 'Bespoke AI: Enter API Key',
        placeHolder: 'Select a provider',
      });
      if (!provider) return;

      const key = await vscode.window.showInputBox({
        title: `Enter ${provider.label} API Key`,
        prompt: `Paste your ${provider.label} API key (${provider.detail})`,
        password: true,
        placeHolder: 'sk-...',
        ignoreFocusOut: true,
      });
      if (!key) return;

      await storeSecretKey(provider.detail!, key);
      // Note: don't call clearApiKeyCache() here — storeSecretKey already
      // updated the in-memory cache, and clearing would wipe it out.
      logger.info(`API key stored for ${provider.label}`);
      vscode.window.showInformationMessage(
        `Bespoke AI: API key saved for ${provider.label} (stored in OS keychain).`,
      );

      // If we were in setup-needed state, re-check availability and update
      if (lastConfig.backend === 'api' && statusBarState === 'setup-needed') {
        // Re-initialize adapter to pick up the new key
        backendRouter.updateConfig(lastConfig);
        const apiAvailable = backendRouter.getApiProvider()?.isAvailable() ?? false;
        if (apiAvailable) {
          updateStatusBar(lastConfig, 'ready');
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.removeApiKey', async () => {
      const providerItems = getApiKeyProviderItems();
      if (providerItems.length === 0) {
        vscode.window.showInformationMessage('No API presets require an API key.');
        return;
      }
      const provider = await vscode.window.showQuickPick(providerItems, {
        title: 'Bespoke AI: Remove API Key',
        placeHolder: 'Select a provider',
      });
      if (!provider) return;

      await removeSecretKey(provider.detail!);
      // Note: don't call clearApiKeyCache() here — removeSecretKey already
      // removes this key from the in-memory cache, and clearing would wipe
      // other eagerly-loaded secret keys (e.g., removing OpenAI key would
      // also evict the Anthropic key until next restart).
      logger.info(`API key removed for ${provider.label}`);
      vscode.window.showInformationMessage(`Bespoke AI: API key removed for ${provider.label}.`);
    }),
  );

  // Add Custom Model wizard
  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.addCustomModel', async () => {
      // Step 1: Provider
      const providerPick = await vscode.window.showQuickPick(
        [
          {
            label: 'Anthropic',
            description: 'Claude models via api.anthropic.com',
            id: 'anthropic' as const,
          },
          {
            label: 'OpenAI-Compatible',
            description: 'OpenAI, xAI, Together, Ollama, LM Studio, etc.',
            id: 'openai-compat' as const,
          },
        ],
        { title: 'Add Custom Model (1/4)', placeHolder: 'Select API provider' },
      );
      if (!providerPick) return;
      const providerType = providerPick.id;
      const totalSteps = providerType === 'openai-compat' ? 5 : 4;
      let step = 1;

      // Step: Model ID
      step++;
      const modelPlaceholder =
        providerType === 'anthropic'
          ? 'claude-haiku-4-5-20251001'
          : 'llama3.2, gpt-4o, gemma2, etc.';
      const modelId = await vscode.window.showInputBox({
        title: `Add Custom Model (${step}/${totalSteps})`,
        prompt: 'Model identifier sent to the API',
        placeHolder: modelPlaceholder,
        ignoreFocusOut: true,
      });
      if (!modelId) return;

      // Step: Display name
      step++;
      const displayName = await vscode.window.showInputBox({
        title: `Add Custom Model (${step}/${totalSteps})`,
        prompt: 'Display name shown in the menu',
        value: modelId,
        ignoreFocusOut: true,
      });
      if (!displayName) return;

      // Step: Base URL (OpenAI-compat only)
      let baseUrl: string | undefined;
      if (providerType === 'openai-compat') {
        step++;
        baseUrl =
          (await vscode.window.showInputBox({
            title: `Add Custom Model (${step}/${totalSteps})`,
            prompt: 'API base URL (leave blank for OpenAI default)',
            placeHolder: 'http://localhost:11434/v1',
            ignoreFocusOut: true,
          })) || undefined;
      }

      // Step: API key env var
      step++;
      let apiKeyEnvVar: string | undefined;
      const defaultKeyVar = providerType === 'anthropic' ? 'ANTHROPIC_API_KEY' : '';
      const keyVarInput = await vscode.window.showInputBox({
        title: `Add Custom Model (${step}/${totalSteps})`,
        prompt: 'API key environment variable name (leave blank for local/keyless models)',
        placeHolder: defaultKeyVar || 'OPENAI_API_KEY, TOGETHER_API_KEY, etc.',
        value: defaultKeyVar,
        ignoreFocusOut: true,
      });
      if (keyVarInput === undefined) return; // cancelled
      apiKeyEnvVar = keyVarInput || undefined;

      // Build the custom preset
      const newPreset: CustomPreset = {
        name: displayName,
        provider: providerType,
        modelId,
      };
      if (baseUrl) newPreset.baseUrl = baseUrl;
      if (apiKeyEnvVar) newPreset.apiKeyEnvVar = apiKeyEnvVar;

      // Read current custom presets and append
      const ws = vscode.workspace.getConfiguration('bespokeAI');
      const current = ws.get<CustomPreset[]>('api.customPresets', []);
      await ws.update(
        'api.customPresets',
        [...current, newPreset],
        vscode.ConfigurationTarget.Global,
      );

      // Set as active preset and ensure backend is API
      await ws.update('api.preset', slugify(displayName), vscode.ConfigurationTarget.Global);
      if (ws.get<string>('backend') !== 'api') {
        await ws.update('backend', 'api', vscode.ConfigurationTarget.Global);
      }

      logger.info(`Custom model added: ${displayName} (${modelId})`);
      vscode.window.showInformationMessage(
        `Bespoke AI: Custom model "${displayName}" added and activated.`,
      );

      // Offer to enter API key if needed and not already stored
      if (apiKeyEnvVar && !resolveApiKeySource(apiKeyEnvVar)) {
        const action = await vscode.window.showInformationMessage(
          `API key required (${apiKeyEnvVar}). Enter it now?`,
          'Enter API Key',
          'Later',
        );
        if (action === 'Enter API Key') {
          const key = await vscode.window.showInputBox({
            title: `Enter API Key for ${displayName}`,
            prompt: `Paste your API key (${apiKeyEnvVar})`,
            password: true,
            placeHolder: 'sk-...',
            ignoreFocusOut: true,
          });
          if (key) {
            await storeSecretKey(apiKeyEnvVar, key);
            vscode.window.showInformationMessage(
              `Bespoke AI: API key saved for ${displayName} (stored in OS keychain).`,
            );
          }
        }
      }
    }),
  );

  // Remove Custom Model
  context.subscriptions.push(
    vscode.commands.registerCommand('bespoke-ai.removeCustomModel', async () => {
      const ws = vscode.workspace.getConfiguration('bespokeAI');
      const current = ws.get<CustomPreset[]>('api.customPresets', []);
      if (current.length === 0) {
        vscode.window.showInformationMessage('No custom models to remove.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        current.map((p) => ({
          label: p.name,
          description: `${p.provider} · ${p.modelId}`,
          detail: p.baseUrl,
        })),
        { title: 'Remove Custom Model', placeHolder: 'Select a custom model to remove' },
      );
      if (!pick) return;

      const updated = current.filter((p) => p.name !== pick.label);
      await ws.update('api.customPresets', updated, vscode.ConfigurationTarget.Global);

      // If the removed model was active, switch to default
      const activePreset = ws.get<string>('api.preset');
      if (activePreset === slugify(pick.label)) {
        await ws.update('api.preset', 'anthropic-haiku', vscode.ConfigurationTarget.Global);
      }

      logger.info(`Custom model removed: ${pick.label}`);
      vscode.window.showInformationMessage(`Bespoke AI: Custom model "${pick.label}" removed.`);
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
        registerCustomPresets(newConfig.api.customPresets);
        // Eagerly load any new custom preset API keys into SecretStorage cache
        for (const cp of newConfig.api.customPresets) {
          if (cp.apiKeyEnvVar) loadSecretKey(cp.apiKeyEnvVar).catch(() => {});
        }
        backendRouter.updateConfig(newConfig);
        completionProvider.updateConfig(newConfig);

        // Update context menu visibility when backend changes
        if (newConfig.backend !== prevConfig.backend) {
          vscode.commands.executeCommand(
            'setContext',
            'bespokeAI.cliAvailable',
            newConfig.backend === 'claude-code',
          );
        }

        // Hard kill / restart pools when enabled changes
        const enabledChanged = newConfig.enabled !== prevConfig.enabled;
        const backendChanged = newConfig.backend !== prevConfig.backend;

        if (enabledChanged) {
          if (!newConfig.enabled) {
            logger.info('Disabled — shutting down pools');
            poolClient.dispose();
            vscode.window.showInformationMessage('Bespoke AI: Disabled.');
          } else {
            logger.info('Enabled — restarting');
            vscode.window.showInformationMessage('Bespoke AI: Enabled.');
            if (newConfig.backend === 'claude-code') {
              updateStatusBar(newConfig, 'initializing');
              poolClient.updateConfig(newConfig);
              poolClient
                .activate()
                .then(() => {
                  updateStatusBar(newConfig, 'ready');
                })
                .catch((err) => {
                  logger.error(`Pool client activation failed: ${err}`);
                  updateStatusBar(newConfig, 'setup-needed');
                });
            } else {
              // API mode — ready immediately
              const apiAvailable = backendRouter.getApiProvider()?.isAvailable() ?? false;
              updateStatusBar(newConfig, apiAvailable ? 'ready' : 'setup-needed');
              if (!apiAvailable) {
                showApiSetupGuidance(newConfig);
              }
            }
          }
        }

        // Handle backend switch (without enable/disable change)
        if (backendChanged && !enabledChanged && newConfig.enabled) {
          completionProvider.clearCache();
          if (newConfig.backend === 'claude-code') {
            logger.info(`Backend: api → claude-code`);
            vscode.window.showInformationMessage('Bespoke AI: Switched to Claude Code CLI.');
            // Switching to CLI — may need to start pools
            updateStatusBar(newConfig, 'initializing');
            poolClient.updateConfig(newConfig);
            poolClient
              .activate()
              .then(() => {
                updateStatusBar(newConfig, 'ready');
              })
              .catch((err) => {
                logger.error(`Pool client activation failed: ${err}`);
                updateStatusBar(newConfig, 'setup-needed');
              });
          } else {
            logger.info(`Backend: claude-code → api (CLI pools idled)`);
            // Switching to API — ready immediately
            const apiAvailable = backendRouter.getApiProvider()?.isAvailable() ?? false;
            if (apiAvailable) {
              vscode.window.showInformationMessage('Bespoke AI: Switched to Direct API.');
            } else {
              showApiSetupGuidance(newConfig);
            }
            updateStatusBar(newConfig, apiAvailable ? 'ready' : 'setup-needed');
          }
        }

        // Recycle pools when CLI model changes
        if (
          newConfig.enabled &&
          !enabledChanged &&
          newConfig.backend === 'claude-code' &&
          newConfig.claudeCode.model !== prevConfig.claudeCode.model
        ) {
          logger.info(`Model → ${newConfig.claudeCode.model} (recycling pools + clearing cache)`);
          completionProvider.clearCache();
          poolClient.updateConfig(newConfig);
        }

        // Clear cache on API preset change
        if (
          newConfig.enabled &&
          newConfig.backend === 'api' &&
          newConfig.api.preset !== prevConfig.api.preset
        ) {
          const preset = getPreset(newConfig.api.preset);
          const presetLabel = preset?.displayName ?? newConfig.api.preset;
          logger.info(`API model → ${presetLabel} (clearing cache)`);
          completionProvider.clearCache();
          vscode.window.showInformationMessage(`Bespoke AI: Model changed to ${presetLabel}.`);
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

  const isExplicit = <T>(key: string) => {
    const i = ws.inspect<T>(key);
    return (
      i?.globalValue !== undefined ||
      i?.workspaceValue !== undefined ||
      i?.workspaceFolderValue !== undefined
    );
  };

  const { triggerPreset, triggerMode, debounceMs } = resolvePreset({
    presetExplicitlySet: isExplicit<string>('triggerPreset'),
    presetValue: ws.get<string>('triggerPreset', 'relaxed')!,
    triggerModeExplicitlySet: isExplicit<string>('triggerMode'),
    triggerModeValue: ws.get<string>('triggerMode', 'auto')!,
    debounceExplicitlySet: isExplicit<number>('debounceMs'),
    debounceValue: ws.get<number>('debounceMs', 2000)!,
  });

  return {
    enabled: ws.get<boolean>('enabled', true)!,
    mode: ws.get<'auto' | 'prose' | 'code'>('mode', 'auto')!,
    backend: ws.get<'claude-code' | 'api'>('backend', 'claude-code')!,
    triggerPreset,
    triggerMode,
    debounceMs,
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
    api: {
      preset: ws.get<string>('api.preset', 'anthropic-haiku')!,
      customPresets: ws.get<CustomPreset[]>('api.customPresets', [])!,
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

function updateStatusBar(config: ExtensionConfig, state?: StatusBarState) {
  if (state) statusBarState = state;

  if (!config.enabled) {
    statusBarItem.text = '$(circle-slash) AI Off';
    statusBarItem.tooltip = 'Bespoke AI: Disabled (click for menu)';
  } else if (statusBarState === 'initializing') {
    statusBarItem.text = '$(loading~spin) Starting...';
    statusBarItem.tooltip = 'Bespoke AI: Initializing pools...';
  } else if (statusBarState === 'setup-needed') {
    statusBarItem.text = '$(warning) Setup needed';
    if (config.backend === 'api') {
      const apiPreset = getPreset(config.api.preset);
      const provider = apiPreset?.apiKeyEnvVar ?? 'API';
      statusBarItem.tooltip = `Bespoke AI: API key missing for ${provider} — click to enter key`;
    } else {
      statusBarItem.tooltip = 'Bespoke AI: Claude Code CLI not found — click for help';
    }
  } else {
    const presetIcon = PRESET_ICONS[config.triggerPreset] ?? '$(zap)';
    if (config.backend === 'api') {
      const apiPreset = getPreset(config.api.preset);
      const modelLabel = apiPreset?.displayName ?? config.api.preset;
      statusBarItem.text = `${presetIcon} ${config.mode} | ${modelLabel} (API)`;
      statusBarItem.tooltip = `Bespoke AI: ${config.mode} mode, ${config.triggerPreset} trigger, ${modelLabel} via API (click for menu)`;
    } else {
      const modelLabel = shortenModelName(config.claudeCode.model);
      statusBarItem.text = `${presetIcon} ${config.mode} | ${modelLabel}`;
      statusBarItem.tooltip = `Bespoke AI: ${config.mode} mode, ${config.triggerPreset} trigger, ${config.claudeCode.model} (click for menu)`;
    }
  }
  statusBarItem.show();
}

function showApiSetupGuidance(config: ExtensionConfig) {
  const preset = getPreset(config.api.preset);
  const keyName = preset?.apiKeyEnvVar;
  if (!keyName) {
    // Ollama or preset without key requirement — no guidance needed
    return;
  }

  const isFirstRun = !extensionContext.globalState.get<boolean>(API_WELCOME_SHOWN_KEY);
  if (isFirstRun) {
    extensionContext.globalState.update(API_WELCOME_SHOWN_KEY, true);
  }

  const showFn = isFirstRun
    ? vscode.window.showInformationMessage
    : vscode.window.showWarningMessage;
  const msg = isFirstRun
    ? 'Bespoke AI: Welcome to API mode! Enter your API key to get started.'
    : `Bespoke AI: API key required (${keyName}). Enter your key to get started.`;

  showFn(msg, 'Enter API Key', 'Open Settings').then((action) => {
    if (action === 'Enter API Key') {
      vscode.commands.executeCommand('bespoke-ai.setApiKey');
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'bespokeAI.api');
    }
  });
}

function updateStatusBarSpinner(spinning: boolean) {
  const config = lastConfig;
  if (!config.enabled) {
    return;
  }

  if (spinning) {
    if (config.backend === 'api') {
      const apiPreset = getPreset(config.api.preset);
      const modelLabel = apiPreset?.displayName ?? config.api.preset;
      statusBarItem.text = `$(loading~spin) ${config.mode} | ${modelLabel} (API)`;
    } else {
      const modelLabel = shortenModelName(config.claudeCode.model);
      statusBarItem.text = `$(loading~spin) ${config.mode} | ${modelLabel}`;
    }
  } else {
    updateStatusBar(config);
  }
}

function formatKeySource(source: ApiKeySource): string {
  switch (source) {
    case 'keychain':
      return 'configured (keychain)';
    case 'env':
      return 'configured (env var)';
    case 'file':
      return 'configured (~/.creds)';
    case null:
      return 'not set';
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

async function runPreflightCheck(): Promise<'ok' | 'no-sdk'> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as any;
    const queryFn = sdk.query ?? sdk.default?.query;
    if (!queryFn) return 'no-sdk';
    return 'ok';
  } catch {
    return 'no-sdk';
  }
}

async function activateWithPreflight(
  config: ExtensionConfig,
  context: vscode.ExtensionContext,
): Promise<void> {
  // Status bar is already set to 'initializing' by the caller before statusBarItem is created.

  const preflight = await runPreflightCheck();
  if (preflight === 'no-sdk') {
    logger.error('Pre-flight: Claude Code CLI not found');
    updateStatusBar(config, 'setup-needed');
    vscode.window
      .showErrorMessage(
        'Bespoke AI: Claude Code CLI not found. Install Claude Code to get started.',
        'Open Install Guide',
      )
      .then((action) => {
        if (action === 'Open Install Guide') {
          vscode.env.openExternal(vscode.Uri.parse(SETUP_URL));
        }
      });
    return;
  }

  // SDK available — activate pools
  try {
    await poolClient.activate();
    updateStatusBar(config, 'ready');
  } catch (err) {
    logger.error(`Pool client activation failed: ${err}`);
    updateStatusBar(config, 'setup-needed');
    return;
  }

  // First-run welcome notification
  if (!context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
    context.globalState.update(WELCOME_SHOWN_KEY, true);
    vscode.window
      .showInformationMessage(
        'Bespoke AI is ready! Press Alt+Enter to trigger a completion anytime.',
        'Open Settings',
      )
      .then((action) => {
        if (action === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'bespokeAI');
        }
      });
  }
}

export function deactivate() {
  // Explicit cleanup — these may be no-ops if already disposed via subscriptions,
  // but ensures cleanup if subscription disposal fails
  completionProvider?.dispose();
  backendRouter?.dispose();
  logger?.dispose();
}
