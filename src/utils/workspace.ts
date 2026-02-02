import * as vscode from 'vscode';

/**
 * Returns the filesystem path of the first workspace folder, or empty string if none.
 * Use this as the canonical way to get the workspace root across the extension.
 */
export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}
