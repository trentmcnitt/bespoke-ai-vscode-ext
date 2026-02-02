import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { UsageLedger } from './utils/usage-ledger';
import { CommandPool } from './providers/command-pool';
import { buildFullCommitPrompt, parseCommitMessage } from './utils/commit-message-utils';
import { getWorkspaceRoot } from './utils/workspace';
import type { GitExtension, Repository } from './types/git';

const TIMEOUT_MS = 60_000;

let inFlight = false;

export async function generateCommitMessage(
  commandPool: CommandPool,
  logger: Logger,
  ledger?: UsageLedger,
): Promise<void> {
  if (inFlight) {
    vscode.window.setStatusBarMessage('Bespoke AI: Request already in progress', 2000);
    return;
  }
  inFlight = true;
  try {
    await doGenerateCommitMessage(commandPool, logger, ledger);
  } finally {
    inFlight = false;
  }
}

async function doGenerateCommitMessage(
  commandPool: CommandPool,
  logger: Logger,
  ledger?: UsageLedger,
): Promise<void> {
  logger.info('Commit message generation started');

  // Check pool availability
  if (!commandPool.isAvailable()) {
    vscode.window.showWarningMessage('Bespoke AI: Command pool not ready. Try again in a moment.');
    return;
  }

  // 1. Get Git API
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) {
    vscode.window.showWarningMessage('Bespoke AI: Git extension not found.');
    return;
  }
  const git = gitExtension.isActive
    ? gitExtension.exports.getAPI(1)
    : (await gitExtension.activate()).getAPI(1);

  // 2. Pick repository
  let repo: Repository;
  if (git.repositories.length === 0) {
    vscode.window.showWarningMessage('Bespoke AI: No git repositories found.');
    return;
  } else if (git.repositories.length === 1) {
    repo = git.repositories[0];
  } else {
    const items = git.repositories.map((r) => ({
      label: r.rootUri.fsPath,
      repo: r,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a repository',
      title: 'Bespoke AI: Generate Commit Message',
    });
    if (!picked) {
      return;
    }
    repo = picked.repo;
  }

  // 3. Fetch diffs
  let staged: string;
  let unstaged: string;
  try {
    [staged, unstaged] = await Promise.all([repo.diff(true), repo.diff(false)]);
  } catch (err) {
    logger.error('Failed to read git diff', err);
    vscode.window.showWarningMessage(
      'Bespoke AI: Failed to read git diff. Check Output log for details.',
    );
    return;
  }

  const hasStaged = staged.trim().length > 0;
  const hasUnstaged = unstaged.trim().length > 0;

  logger.debug(
    `Commit message: staged=${hasStaged} (${staged.length} chars), unstaged=${hasUnstaged} (${unstaged.length} chars)`,
  );

  if (!hasStaged && !hasUnstaged) {
    vscode.window.showInformationMessage(
      'Bespoke AI: No changes to generate a commit message for.',
    );
    return;
  }

  // 4. Choose diff
  let diff: string;
  if (hasStaged && hasUnstaged) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Staged changes', diff: staged },
        { label: 'All uncommitted changes', diff: staged + '\n' + unstaged },
      ],
      {
        placeHolder: 'You have both staged and unstaged changes',
        title: 'Bespoke AI: Generate Commit Message',
      },
    );
    if (!choice) {
      return;
    }
    diff = choice.diff;
  } else {
    diff = hasStaged ? staged : unstaged;
  }

  // 5. Build full prompt (instructions + diff in one message)
  const customSystemPrompt = vscode.workspace
    .getConfiguration('bespokeAI')
    .get<string>('commitMessage.systemPrompt', '');

  const fullMessage = buildFullCommitPrompt(diff, customSystemPrompt);

  logger.debug(
    `Commit message: diff source=${hasStaged && hasUnstaged ? 'user choice' : hasStaged ? 'staged' : 'unstaged'}, diff chars=${diff.length}, custom prompt=${!!customSystemPrompt?.trim()}`,
  );
  logger.trace(`Commit message full prompt:\n${fullMessage}`);

  // 6. Send to command pool with progress
  const startTime = Date.now();
  const { text, meta } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Bespoke AI: Generating commit message...',
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      return commandPool.sendPrompt(fullMessage, {
        timeoutMs: TIMEOUT_MS,
        onCancel: controller.signal,
      });
    },
  );

  const durationMs = Date.now() - startTime;

  if (text === null) {
    return;
  }

  // Record in ledger with SDK metadata when available
  const workspaceRoot = getWorkspaceRoot();
  const project = workspaceRoot ? path.basename(workspaceRoot) : '';
  ledger?.record({
    source: 'commit-message',
    model: commandPool.getCurrentModel(),
    project,
    durationMs: meta?.durationMs ?? durationMs,
    durationApiMs: meta?.durationApiMs,
    inputTokens: meta?.inputTokens,
    outputTokens: meta?.outputTokens,
    cacheReadTokens: meta?.cacheReadTokens,
    cacheCreationTokens: meta?.cacheCreationTokens,
    costUsd: meta?.costUsd,
    inputChars: fullMessage.length,
    outputChars: text.length,
    sessionId: meta?.sessionId,
  });

  logger.trace(`Commit message raw response:\n${text}`);

  const message = parseCommitMessage(text);
  if (!message) {
    vscode.window.showInformationMessage('Bespoke AI: Claude returned an empty response.');
    return;
  }

  // 7. Write to SCM input box
  repo.inputBox.value = message;
  logger.debug(`Commit message: result chars=${message.length}`);
  logger.info('Commit message generated');
}
