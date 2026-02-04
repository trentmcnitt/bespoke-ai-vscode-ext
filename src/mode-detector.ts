import { CompletionMode, ExtensionConfig } from './types';

const CODE_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'scala',
  'haskell',
  'lua',
  'perl',
  'r',
  'dart',
  'elixir',
  'erlang',
  'clojure',
  'fsharp',
  'objective-c',
  'objective-cpp',
  'groovy',
  'powershell',
  'shellscript',
  'bash',
  'zsh',
  'fish',
  'sql',
  'graphql',
  'html',
  'css',
  'scss',
  'less',
  'sass',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'xml',
  'dockerfile',
  'makefile',
  'cmake',
  'vue',
  'svelte',
  'astro',
  'zig',
  'nim',
  'ocaml',
  'julia',
]);

const PROSE_LANGUAGES = new Set([
  'markdown',
  'plaintext',
  'latex',
  'restructuredtext',
  'txt',
  'asciidoc',
  'org',
]);

/**
 * Detect completion mode based on languageId and config.
 * Priority: (1) user override, (2) custom file types, (3) built-in language sets, (4) prose default.
 */
export function detectMode(languageId: string, config: ExtensionConfig): CompletionMode {
  // User override takes priority
  if (config.mode === 'prose') {
    return 'prose';
  }
  if (config.mode === 'code') {
    return 'code';
  }

  // Check additional prose file types from config
  if (config.prose.fileTypes.includes(languageId)) {
    return 'prose';
  }

  // Auto-detect
  if (PROSE_LANGUAGES.has(languageId)) {
    return 'prose';
  }
  if (CODE_LANGUAGES.has(languageId)) {
    return 'code';
  }

  // Fallback: default to prose (user's primary use case is writing)
  return 'prose';
}

/**
 * @deprecated Use detectMode() function directly instead.
 * This class wrapper is kept for backward compatibility.
 */
export class ModeDetector {
  detectMode(languageId: string, config: ExtensionConfig): CompletionMode {
    return detectMode(languageId, config);
  }
}
