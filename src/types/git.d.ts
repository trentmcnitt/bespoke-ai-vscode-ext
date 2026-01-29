/**
 * Minimal type definitions for VS Code's built-in Git extension API.
 * Only the interfaces actually used by commit-message.ts.
 * See: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */

import { Uri } from 'vscode';

export interface InputBox {
  value: string;
}

export interface Repository {
  readonly inputBox: InputBox;
  readonly rootUri: Uri;
  diff(cached?: boolean): Promise<string>;
}

export interface GitAPI {
  readonly repositories: Repository[];
}

export interface GitExtension {
  getAPI(version: 1): GitAPI;
}
