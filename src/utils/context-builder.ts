import * as vscode from 'vscode';
import * as path from 'path';
import { truncatePrefix, truncateSuffix } from './truncation';

export interface DocumentContext {
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  filePath: string;
}

export function buildDocumentContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  prefixChars: number,
  suffixChars: number,
): DocumentContext {
  const offset = document.offsetAt(position);
  const fullText = document.getText();

  const rawPrefix = fullText.slice(0, offset);
  const rawSuffix = fullText.slice(offset);

  const prefix = truncatePrefix(rawPrefix, prefixChars);
  const suffix = truncateSuffix(rawSuffix, suffixChars);

  return {
    prefix,
    suffix,
    languageId: document.languageId,
    fileName: path.basename(document.fileName) || 'untitled',
    filePath: document.fileName || 'untitled',
  };
}
