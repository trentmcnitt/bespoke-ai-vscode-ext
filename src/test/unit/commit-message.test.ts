import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeLogger } from '../helpers';

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    setStatusBarMessage: vi.fn(),
    showQuickPick: vi.fn(),
    withProgress: vi.fn(async (_opts: unknown, task: any) =>
      task({ report: vi.fn() }, { onCancellationRequested: vi.fn() }),
    ),
  },
  extensions: { getExtension: vi.fn() },
  workspace: { workspaceFolders: [{ uri: { fsPath: '/home/u/my-project' } }] },
}));

import * as vscode from 'vscode';
import { generateCommitMessage } from '../../commit-message';
import type { BackendRouter } from '../../providers/backend-router';
import type { Logger } from '../../utils/logger';
import {
  buildFullCommitPrompt,
  parseCommitMessage,
  truncateDiff,
  MAX_COMMIT_DIFF_CHARS,
} from '../../utils/commit-message-utils';

describe('parseCommitMessage', () => {
  it('returns trimmed stdout', () => {
    expect(parseCommitMessage('  fix: add logging\n\n')).toBe('fix: add logging');
  });

  it('preserves multi-line messages with internal whitespace', () => {
    const msg = 'feat: add foo\n\nAdds foo to the bar module.';
    expect(parseCommitMessage(msg)).toBe(msg);
  });

  it('returns null for empty string', () => {
    expect(parseCommitMessage('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseCommitMessage('   \n\n  ')).toBeNull();
  });

  it('strips markdown code fences', () => {
    expect(parseCommitMessage('```\nfeat: add foo\n```')).toBe('feat: add foo');
  });

  it('strips markdown code fences with language tag', () => {
    expect(parseCommitMessage('```text\nfix: bar\n```')).toBe('fix: bar');
  });

  it('preserves text that is not fully wrapped in fences', () => {
    expect(parseCommitMessage('feat: add foo\n```\ndetails\n```')).toBe(
      'feat: add foo\n```\ndetails\n```',
    );
  });
});

describe('buildFullCommitPrompt', () => {
  const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+console.log('hello');`;

  it('wraps diff in tags with instructions', () => {
    const result = buildFullCommitPrompt(sampleDiff);
    expect(result).toContain('<instructions>');
    expect(result).toContain('</instructions>');
    expect(result).toContain('<diff>');
    expect(result).toContain('</diff>');
    expect(result).toContain(sampleDiff);
  });

  it('includes commit message generation instructions', () => {
    const result = buildFullCommitPrompt(sampleDiff);
    expect(result).toContain('commit message generator');
    expect(result).toContain('conventional commit');
    expect(result).toContain('imperative mood');
  });
});

describe('truncateDiff', () => {
  it('returns short diffs unchanged', () => {
    const d = 'diff --git a/x b/x\n+hello\n';
    expect(truncateDiff(d)).toBe(d);
    expect(truncateDiff(d, 10_000)).toBe(d);
  });

  it('returns a diff exactly at the limit unchanged', () => {
    const d = 'a'.repeat(100);
    expect(truncateDiff(d, 100)).toBe(d);
  });

  it('cuts at a line boundary and appends an omission marker', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `line ${String(i).padStart(3, '0')} ${'#'.repeat(20)}`,
    );
    const d = lines.join('\n');
    const out = truncateDiff(d, 300);
    const [body, marker] = out.split('\n\n[diff truncated: ');
    expect(marker).toMatch(/^[\d,]+ more characters omitted\]$/);
    expect(body.length).toBeLessThanOrEqual(300);
    expect(body.endsWith('#')).toBe(true); // ended on a complete line, not mid-line
    expect(d.startsWith(body)).toBe(true);
  });

  it('falls back to a hard cut when there is no newline before the limit', () => {
    const d = 'x'.repeat(1000);
    const out = truncateDiff(d, 200);
    expect(out.startsWith('x'.repeat(200))).toBe(true);
    expect(out).toContain('800 more characters omitted');
  });

  it('default limit is the exported constant', () => {
    const d = 'y\n'.repeat(MAX_COMMIT_DIFF_CHARS);
    expect(truncateDiff(d).length).toBeLessThan(MAX_COMMIT_DIFF_CHARS + 100);
  });
});

describe('generateCommitMessage — error handling', () => {
  const win = vscode.window as unknown as {
    showErrorMessage: ReturnType<typeof vi.fn>;
    setStatusBarMessage: ReturnType<typeof vi.fn>;
  };
  const getExtension = vscode.extensions.getExtension as unknown as ReturnType<typeof vi.fn>;

  function makeRouter(sendCommand: () => Promise<unknown>) {
    return {
      isCommandAvailable: vi.fn(() => true),
      getCurrentModel: vi.fn(() => 'sonnet'),
      sendCommand: vi.fn(sendCommand),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const repo = {
      rootUri: { fsPath: '/home/u/my-project' },
      diff: vi.fn(async (staged: boolean) => (staged ? 'diff --git a/x b/x\n+hello\n' : '')),
      inputBox: { value: '' },
    };
    getExtension.mockReturnValue({
      isActive: true,
      exports: { getAPI: () => ({ repositories: [repo] }) },
    });
  });

  it('logs and toasts a backend error (resolving, not rejecting) and releases the in-flight guard', async () => {
    // The toast never settles; the wrapper must not await it.
    win.showErrorMessage.mockReturnValueOnce(new Promise(() => {}));
    const error = vi.fn();
    const logger = { ...makeLogger(), error } as unknown as Logger;
    const err = new Error('401 invalid x-api-key');
    const failing = makeRouter(async () => {
      throw err;
    });

    await expect(
      generateCommitMessage(failing as unknown as BackendRouter, logger),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Commit message generation failed', err);
    expect(win.showErrorMessage).toHaveBeenCalledWith(
      'Bespoke AI: Commit message generation failed — 401 invalid x-api-key',
    );

    // A subsequent invocation is not blocked by a stuck in-flight flag.
    const next = makeRouter(async () => ({ text: null, meta: null }));
    await generateCommitMessage(next as unknown as BackendRouter, makeLogger());
    expect(next.sendCommand).toHaveBeenCalledOnce();
    expect(win.setStatusBarMessage).not.toHaveBeenCalledWith(
      'Bespoke AI: Request already in progress',
      2000,
    );
  });

  it('toasts and logs a pool failure (null text with an errorType), naming the cause', async () => {
    win.showErrorMessage.mockReturnValueOnce(new Promise(() => {})); // never dismissed
    const error = vi.fn();
    const logger = { ...makeLogger(), error } as unknown as Logger;
    const router = makeRouter(async () => ({
      text: null,
      meta: null,
      errorType: 'pool_circuit_open',
    }));
    await generateCommitMessage(router as unknown as BackendRouter, logger);
    expect(error).toHaveBeenCalledWith('Commit message generation failed: pool_circuit_open');
    expect(win.showErrorMessage).toHaveBeenCalledOnce();
    const msg = win.showErrorMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/^Bespoke AI: Commit message generation failed — /);
    expect(msg).toContain('crashing repeatedly');
    // The unsettled toast does not hold the in-flight guard.
    const next = makeRouter(async () => ({ text: null, meta: null }));
    await generateCommitMessage(next as unknown as BackendRouter, makeLogger());
    expect(next.sendCommand).toHaveBeenCalledOnce();
  });

  it('stays silent on an aborted (superseded / shutdown) command', async () => {
    const error = vi.fn();
    const logger = { ...makeLogger(), error } as unknown as Logger;
    const router = makeRouter(async () => ({ text: null, meta: null, aborted: true }));
    await generateCommitMessage(router as unknown as BackendRouter, logger);
    expect(win.showErrorMessage).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('stays silent on a bare null (the user cancelled)', async () => {
    const router = makeRouter(async () => ({ text: null, meta: null }));
    await generateCommitMessage(router as unknown as BackendRouter, makeLogger());
    expect(win.showErrorMessage).not.toHaveBeenCalled();
  });
});
