import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../../prompt-builder';
import { CompletionContext } from '../../types';
import { makeConfig } from '../helpers';

describe('PromptBuilder', () => {
  const builder = new PromptBuilder();

  describe('prose mode', () => {
    const proseContext: CompletionContext = {
      prefix: 'The quick brown fox jumped over the lazy dog.',
      suffix: '',
      languageId: 'markdown',
      fileName: 'essay.md',
      filePath: '/test/essay.md',
      mode: 'prose',
    };

    it('uses prose system prompt', () => {
      const result = builder.buildPrompt(proseContext, makeConfig());
      expect(result.system).toContain('Continue the text naturally');
    });

    it('sets prose-specific parameters', () => {
      const result = builder.buildPrompt(proseContext, makeConfig());
      expect(result.maxTokens).toBe(100);
      expect(result.temperature).toBe(0.7);
      expect(result.stopSequences).toEqual(['---', '##']);
    });

    it('extracts last 4 words as assistant prefill', () => {
      const result = builder.buildPrompt(proseContext, makeConfig());
      expect(result.assistantPrefill).toBe('over the lazy dog.');
    });

    it('includes prefix as user message', () => {
      const result = builder.buildPrompt(proseContext, makeConfig());
      expect(result.userMessage).toContain('The quick brown fox');
    });

    it('includes suffix hint when suffix is present', () => {
      const ctx: CompletionContext = {
        ...proseContext,
        suffix: 'The end of the story was surprising.',
      };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.userMessage).toContain('The document continues after the cursor with:');
      expect(result.userMessage).toContain('The end of the story');
      expect(result.userMessage).toContain('Do not regenerate or overlap');
    });

    it('omits suffix hint when suffix is empty/whitespace', () => {
      const ctx: CompletionContext = { ...proseContext, suffix: '   ' };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.userMessage).not.toContain('The document continues after the cursor with:');
    });

    it('skips prefill for very short prefix (< 3 words)', () => {
      const ctx: CompletionContext = { ...proseContext, prefix: 'Hello' };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.assistantPrefill).toBeUndefined();
    });

    it('includes prefill for prefix with 3+ words', () => {
      const ctx: CompletionContext = { ...proseContext, prefix: 'The quick fox' };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.assistantPrefill).toBe('The quick fox');
    });

    it('does not include trailing whitespace in prefill (API rejects it)', () => {
      const ctx: CompletionContext = {
        ...proseContext,
        prefix: 'You can use ',
      };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.assistantPrefill).toBe('You can use');
    });

    it('handles empty prefix gracefully', () => {
      const ctx: CompletionContext = { ...proseContext, prefix: '' };
      const result = builder.buildPrompt(ctx, makeConfig());
      // Empty prefix -> split produces [''] (length 1, < 3) -> prefill undefined
      expect(result.assistantPrefill).toBeUndefined();
    });
  });

  describe('code mode', () => {
    const codeContext: CompletionContext = {
      prefix: 'function hello() {\n  ',
      suffix: '\n}',
      languageId: 'typescript',
      fileName: 'index.ts',
      filePath: '/test/index.ts',
      mode: 'code',
    };

    it('uses code system prompt', () => {
      const result = builder.buildPrompt(codeContext, makeConfig());
      expect(result.system).toContain('Complete the code at the cursor position');
    });

    it('includes filename and language in system prompt', () => {
      const result = builder.buildPrompt(codeContext, makeConfig());
      expect(result.system).toContain('index.ts');
      expect(result.system).toContain('typescript');
    });

    it('sets code-specific parameters', () => {
      const result = builder.buildPrompt(codeContext, makeConfig());
      expect(result.maxTokens).toBe(256);
      expect(result.temperature).toBe(0.2);
      expect(result.stopSequences).toEqual([]);
    });

    it('does not set assistant prefill for code', () => {
      const result = builder.buildPrompt(codeContext, makeConfig());
      expect(result.assistantPrefill).toBeUndefined();
    });

    it('formats prefix + suffix as cursor-position prompt', () => {
      const result = builder.buildPrompt(codeContext, makeConfig());
      expect(result.userMessage).toContain('Code before cursor:');
      expect(result.userMessage).toContain('Code after cursor:');
      expect(result.userMessage).toContain('Insert ONLY the code that belongs at the cursor position');
    });

    it('uses plain prefix when no suffix', () => {
      const ctx: CompletionContext = { ...codeContext, suffix: '' };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.userMessage).not.toContain('Code before cursor:');
      expect(result.userMessage).toBe('function hello() {\n  ');
    });

    it('passes raw suffix in BuiltPrompt for FIM-capable providers', () => {
      const result = builder.buildPrompt(codeContext, makeConfig());
      expect(result.suffix).toBe('\n}');
    });

    it('omits suffix from BuiltPrompt when suffix is empty', () => {
      const ctx: CompletionContext = { ...codeContext, suffix: '' };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.suffix).toBeUndefined();
    });

    it('omits suffix from BuiltPrompt when suffix is whitespace-only', () => {
      const ctx: CompletionContext = { ...codeContext, suffix: '   ' };
      const result = builder.buildPrompt(ctx, makeConfig());
      expect(result.suffix).toBeUndefined();
    });
  });

  describe('respects config overrides', () => {
    it('uses custom maxTokens from config', () => {
      const config = makeConfig();
      config.prose.maxTokens = 50;
      const ctx: CompletionContext = {
        prefix: 'test', suffix: '', languageId: 'markdown', fileName: 'test.md', filePath: '/test/test.md', mode: 'prose',
      };
      expect(builder.buildPrompt(ctx, config).maxTokens).toBe(50);
    });

    it('uses custom temperature from config', () => {
      const config = makeConfig();
      config.code.temperature = 0.5;
      const ctx: CompletionContext = {
        prefix: 'test', suffix: '', languageId: 'typescript', fileName: 'test.ts', filePath: '/test/test.ts', mode: 'code',
      };
      expect(builder.buildPrompt(ctx, config).temperature).toBe(0.5);
    });
  });
});
