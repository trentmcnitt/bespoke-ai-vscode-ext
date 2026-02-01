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

  let prefixStart = Math.max(0, offset - prefixChars);
  // Snap to line boundary: if we cut mid-line, move forward to the next
  // newline so the model always sees complete lines. Skip if already at
  // a line boundary (offset 0 or preceded by \n).
  if (prefixStart > 0 && fullText[prefixStart - 1] !== '\n') {
    const nextNewline = fullText.indexOf('\n', prefixStart);
    if (nextNewline !== -1 && nextNewline < offset) {
      prefixStart = nextNewline + 1;
    }
  }
  const prefix = fullText.slice(prefixStart, offset);

  const suffixEnd = Math.min(fullText.length, offset + suffixChars);
  let suffix = fullText.slice(offset, suffixEnd);

  // Snap to word boundary: if we cut mid-word at the end, trim back to the
  // last whitespace so the model doesn't try to complete a truncated word.
  // Only do this if we actually truncated (didn't reach end of document).
  if (suffixEnd < fullText.length && suffix.length > 0) {
    // Check if we cut mid-word (next char in document is not whitespace)
    const nextChar = fullText[suffixEnd];
    if (nextChar && !/\s/.test(nextChar)) {
      // Find the last whitespace in the suffix and trim there
      const lastWhitespace = suffix.search(/\s[^\s]*$/);
      if (lastWhitespace !== -1) {
        suffix = suffix.slice(0, lastWhitespace + 1);
      }
    }
  }

  return {
    prefix,
    suffix,
    languageId: document.languageId,
    fileName: path.basename(document.fileName) || 'untitled',
    filePath: document.fileName || 'untitled',
  };
}
