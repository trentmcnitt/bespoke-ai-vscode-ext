import { describe, it, expect } from 'vitest';
import {
  buildApiPrompt,
  extractPrefillAnchor,
  PREFILL_SYSTEM_PROMPT,
  NON_PREFILL_SYSTEM_PROMPT,
} from '../../providers/api/prompt-builder';
import { makeProseContext, makeCodeContext } from '../helpers';
import { Preset } from '../../providers/api/types';

const prefillPreset: Preset = {
  id: 'test-prefill',
  displayName: 'Test Prefill',
  provider: 'anthropic',
  modelId: 'test-model',
  apiKeyEnvVar: 'TEST_KEY',
  maxTokens: 200,
  temperature: 0.2,
  features: { prefill: true },
};

const noPrefillPreset: Preset = {
  id: 'test-no-prefill',
  displayName: 'Test No Prefill',
  provider: 'openai',
  modelId: 'test-model',
  apiKeyEnvVar: 'TEST_KEY',
  maxTokens: 200,
  temperature: 0.2,
};

describe('extractPrefillAnchor', () => {
  it('returns full prefix when shorter than maxLength', () => {
    expect(extractPrefillAnchor('hello', 40)).toBe('hello');
  });

  it('extracts last N characters for long prefix', () => {
    const prefix = 'a'.repeat(100);
    const anchor = extractPrefillAnchor(prefix, 40);
    expect(anchor.length).toBeLessThanOrEqual(40);
  });

  it('snaps to word boundary when possible', () => {
    const prefix = 'The quick brown fox jumped over the lazy dog and more words here';
    const anchor = extractPrefillAnchor(prefix, 20);
    // Should start at a word boundary (after a space)
    expect(anchor[0]).not.toBe(' ');
  });

  it('handles prefix with newlines', () => {
    const prefix = 'line one\nline two\nline three here is longer text';
    const anchor = extractPrefillAnchor(prefix, 20);
    expect(anchor.length).toBeLessThanOrEqual(20);
  });

  it('handles empty prefix', () => {
    expect(extractPrefillAnchor('')).toBe('');
  });

  it('handles prefix exactly at maxLength', () => {
    const prefix = 'a'.repeat(40);
    expect(extractPrefillAnchor(prefix, 40)).toBe(prefix);
  });
});

describe('buildApiPrompt', () => {
  describe('with prefill (Anthropic)', () => {
    it('uses PREFILL_SYSTEM_PROMPT', () => {
      const context = makeProseContext();
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.system).toBe(PREFILL_SYSTEM_PROMPT);
    });

    it('includes assistant message with anchor', () => {
      const context = makeProseContext();
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
    });

    it('user message contains document with CURSOR marker', () => {
      const context = makeProseContext({ prefix: 'Hello world', suffix: ' and more' });
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages[0].content).toContain('<document>');
      expect(result.messages[0].content).toContain('[CURSOR]');
      expect(result.messages[0].content).toContain('Hello world');
      expect(result.messages[0].content).toContain('and more');
    });

    it('assistant message contains anchor from prefix', () => {
      const context = makeProseContext({
        prefix: 'The quick brown fox jumped over the lazy dog and then',
      });
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages[1].content.length).toBeGreaterThan(0);
      expect(context.prefix).toContain(result.messages[1].content);
    });

    it('includes mode hint for prose', () => {
      const context = makeProseContext();
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages[0].content).toContain('prose/text');
    });

    it('includes mode hint for code', () => {
      const context = makeCodeContext();
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages[0].content).toContain('source code');
    });

    it('handles empty suffix', () => {
      const context = makeProseContext({ suffix: '' });
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages[0].content).toContain('[CURSOR]');
    });
  });

  describe('without prefill (OpenAI, xAI, Gemini, Ollama)', () => {
    it('uses NON_PREFILL_SYSTEM_PROMPT', () => {
      const context = makeCodeContext();
      const result = buildApiPrompt(context, noPrefillPreset);
      expect(result.system).toBe(NON_PREFILL_SYSTEM_PROMPT);
    });

    it('has only a user message', () => {
      const context = makeCodeContext();
      const result = buildApiPrompt(context, noPrefillPreset);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('user message instructs direct output', () => {
      const context = makeCodeContext();
      const result = buildApiPrompt(context, noPrefillPreset);
      expect(result.messages[0].content).toContain('Output ONLY the raw text');
    });

    it('includes document context', () => {
      const context = makeCodeContext({ prefix: 'const x = ', suffix: ';\n' });
      const result = buildApiPrompt(context, noPrefillPreset);
      expect(result.messages[0].content).toContain('const x = ');
      expect(result.messages[0].content).toContain('[CURSOR]');
    });

    it('includes mode hint for code', () => {
      const context = makeCodeContext();
      const result = buildApiPrompt(context, noPrefillPreset);
      expect(result.messages[0].content).toContain('source code');
    });
  });

  describe('edge cases', () => {
    it('handles empty prefix with prefill', () => {
      const context = makeProseContext({ prefix: '' });
      const result = buildApiPrompt(context, prefillPreset);
      expect(result.messages[0].content).toContain('[CURSOR]');
      expect(result.messages[1].content).toBe('');
    });

    it('handles empty suffix with no-prefill', () => {
      const context = makeCodeContext({ suffix: '' });
      const result = buildApiPrompt(context, noPrefillPreset);
      expect(result.messages[0].content).toContain('[CURSOR]');
    });

    it('handles very long prefix', () => {
      const context = makeProseContext({ prefix: 'word '.repeat(500) });
      const result = buildApiPrompt(context, prefillPreset);
      // Anchor should be truncated
      expect(result.messages[1].content.length).toBeLessThanOrEqual(40);
    });
  });
});
