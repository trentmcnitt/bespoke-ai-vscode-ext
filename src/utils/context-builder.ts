import * as vscode from 'vscode';
import * as path from 'path';

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
  suffixChars: number
): DocumentContext {
  const offset = document.offsetAt(position);
  const fullText = document.getText();

  const prefixStart = Math.max(0, offset - prefixChars);
  const prefix = fullText.slice(prefixStart, offset);

  const suffixEnd = Math.min(fullText.length, offset + suffixChars);
  const suffix = fullText.slice(offset, suffixEnd);

  return {
    prefix,
    suffix,
    languageId: document.languageId,
    fileName: path.basename(document.fileName) || 'untitled',
    filePath: document.fileName || 'untitled',
  };
}
