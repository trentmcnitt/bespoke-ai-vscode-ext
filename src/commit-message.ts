import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { Logger } from './utils/logger';
import { buildCommitPrompt, getSystemPrompt, parseCommitMessage } from './utils/commit-message-utils';
import type { GitExtension, Repository } from './types/git';

const TIMEOUT_MS = 60_000;

let inFlight = false;

export async function generateCommitMessage(logger: Logger): Promise<void> {
  if (inFlight) { return; }
  inFlight = true;
  try {
    await doGenerateCommitMessage(logger);
  } finally {
    inFlight = false;
  }
}

async function doGenerateCommitMessage(logger: Logger): Promise<void> {
  logger.info('Commit message generation started');

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
    if (!picked) { return; }
    repo = picked.repo;
  }

  // 3. Fetch diffs
  let staged: string;
  let unstaged: string;
  try {
    [staged, unstaged] = await Promise.all([
      repo.diff(true),
      repo.diff(false),
    ]);
  } catch (err) {
    logger.error('Failed to read git diff', err);
    vscode.window.showWarningMessage('Bespoke AI: Failed to read git diff. Check Output log for details.');
    return;
  }

  const hasStaged = staged.trim().length > 0;
  const hasUnstaged = unstaged.trim().length > 0;

  logger.debug(`Commit message: staged=${hasStaged} (${staged.length} chars), unstaged=${hasUnstaged} (${unstaged.length} chars)`);

  if (!hasStaged && !hasUnstaged) {
    vscode.window.showInformationMessage('Bespoke AI: No changes to generate a commit message for.');
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
    if (!choice) { return; }
    diff = choice.diff;
  } else {
    diff = hasStaged ? staged : unstaged;
  }

  // 5. Build system prompt and user prompt separately
  const customSystemPrompt = vscode.workspace
    .getConfiguration('bespokeAI')
    .get<string>('commitMessage.systemPrompt', '');

  const systemPrompt = getSystemPrompt(customSystemPrompt);
  const userPrompt = buildCommitPrompt(diff);

  logger.debug(`Commit message: diff source=${hasStaged && hasUnstaged ? 'user choice' : hasStaged ? 'staged' : 'unstaged'}, diff chars=${diff.length}, custom prompt=${!!customSystemPrompt?.trim()}`);
  logger.trace(`Commit message system prompt:\n${systemPrompt}`);
  logger.trace(`Commit message user prompt:\n${userPrompt}`);

  // 6. Spawn claude with progress
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Bespoke AI: Generating commit message...',
      cancellable: true,
    },
    (_progress, token) => {
      return new Promise<string | null>((resolve) => {
        const child = spawn('claude', [
          '-p',
          '--output-format', 'text',
          '--max-turns', '1',
          '--no-session-persistence',
          '--tools', '',              // No tools needed — diff is piped via stdin
          '--system-prompt', systemPrompt, // Replace default ~33K token prompt with focused one
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: repo.rootUri.fsPath,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const settle = (value: string | null): void => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };

        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.stdin.on('error', () => {});

        const timeout = setTimeout(() => {
          child.kill();
          vscode.window.showWarningMessage('Bespoke AI: Commit message generation timed out.');
          logger.error('claude process timed out');
          settle(null);
        }, TIMEOUT_MS);

        token.onCancellationRequested(() => {
          child.kill();
          settle(null);
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            vscode.window.showWarningMessage(
              'Bespoke AI: "claude" CLI not found. Install Claude Code and ensure it is in your PATH.',
            );
          } else {
            vscode.window.showWarningMessage(`Bespoke AI: Failed to spawn claude: ${err.message}`);
          }
          logger.error('Failed to spawn claude', err);
          settle(null);
        });

        child.on('close', (code) => {
          if (code !== 0 && code !== null) {
            logger.error(`claude exited with code ${code}: ${stderr}`);
            vscode.window.showWarningMessage(
              `Bespoke AI: claude exited with code ${code}. Check Output log for details.`,
            );
            settle(null);
            return;
          }
          settle(stdout);
        });

        // Write user prompt (diff) to stdin and close
        child.stdin.write(userPrompt);
        child.stdin.end();
      });
    },
  );

  if (result === null) { return; }

  logger.trace(`Commit message raw response:\n${result}`);

  const message = parseCommitMessage(result);
  if (!message) {
    vscode.window.showInformationMessage('Bespoke AI: Claude returned an empty response.');
    return;
  }

  // 7. Write to SCM input box
  repo.inputBox.value = message;
  logger.debug(`Commit message: result chars=${message.length}`);
  logger.info('Commit message generated');
}
