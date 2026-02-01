import { describe, it, expect } from 'vitest';
import { formatBriefForPrompt } from '../../oracle/brief-formatter';
import { ContextBrief } from '../../oracle/types';

function makeBrief(overrides: Partial<ContextBrief> = {}): ContextBrief {
  return {
    filePath: '/test/file.ts',
    generatedAt: Date.now(),
    language: 'typescript',
    imports: [],
    typeContext: [],
    patterns: [],
    relatedSymbols: [],
    projectSummary: '',
    ...overrides,
  };
}

describe('formatBriefForPrompt', () => {
  it('returns empty string for null', () => {
    expect(formatBriefForPrompt(null)).toBe('');
  });

  it('returns empty string for a brief with no content', () => {
    expect(formatBriefForPrompt(makeBrief())).toBe('');
  });

  it('formats imports', () => {
    const result = formatBriefForPrompt(
      makeBrief({
        imports: [
          { module: './utils', provides: 'helper functions' },
          { module: 'vscode', provides: 'VS Code API' },
        ],
      }),
    );
    expect(result).toContain('<project-context>');
    expect(result).toContain('</project-context>');
    expect(result).toContain('- ./utils: helper functions');
    expect(result).toContain('- vscode: VS Code API');
  });

  it('formats type context', () => {
    const result = formatBriefForPrompt(
      makeBrief({
        typeContext: [{ name: 'Foo', signature: 'interface Foo { bar: string }' }],
      }),
    );
    expect(result).toContain('Types in scope:');
    expect(result).toContain('- Foo: interface Foo { bar: string }');
  });

  it('formats patterns', () => {
    const result = formatBriefForPrompt(
      makeBrief({
        patterns: ['camelCase naming', 'errors return null'],
      }),
    );
    expect(result).toContain('Patterns:');
    expect(result).toContain('- camelCase naming');
    expect(result).toContain('- errors return null');
  });

  it('formats related symbols', () => {
    const result = formatBriefForPrompt(
      makeBrief({
        relatedSymbols: [{ name: 'doStuff', description: 'does stuff', signature: '() => void' }],
      }),
    );
    expect(result).toContain('Related symbols:');
    expect(result).toContain('- doStuff: does stuff');
  });

  it('includes project summary', () => {
    const result = formatBriefForPrompt(
      makeBrief({
        projectSummary: 'A VS Code extension',
      }),
    );
    expect(result).toContain('Project: A VS Code extension');
  });

  it('formats a full brief with all sections', () => {
    const result = formatBriefForPrompt(
      makeBrief({
        imports: [{ module: './types', provides: 'type definitions' }],
        typeContext: [{ name: 'Config', signature: 'interface Config { key: string }' }],
        patterns: ['error handling returns null'],
        relatedSymbols: [
          { name: 'init', description: 'initializer', signature: '() => Promise<void>' },
        ],
        projectSummary: 'AI toolkit',
      }),
    );
    expect(result).toMatch(/^<project-context>/);
    expect(result).toMatch(/<\/project-context>$/);
    expect(result).toContain('Imports:');
    expect(result).toContain('Types in scope:');
    expect(result).toContain('Patterns:');
    expect(result).toContain('Related symbols:');
    expect(result).toContain('Project: AI toolkit');
  });
});
