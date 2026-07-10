import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT,
  composeSystemPrompt,
  buildFillMessage,
  extractCompletion,
  tagExtraction,
  prefillExtraction,
  instructionExtraction,
  getPromptStrategy,
} from '../../providers/prompt-strategy';

describe('Shared prompt components', () => {
  describe('SYSTEM_PROMPT', () => {
    it('contains the FILL_HERE marker instruction', () => {
      expect(SYSTEM_PROMPT).toContain('{{FILL_HERE}}');
    });

    it('contains the COMPLETION tag instruction', () => {
      expect(SYSTEM_PROMPT).toContain('<COMPLETION>');
    });

    it('contains the anti-assistant rules', () => {
      expect(SYSTEM_PROMPT).toContain('You are NOT a conversational assistant');
    });
  });

  describe('composeSystemPrompt', () => {
    it('returns the bare SYSTEM_PROMPT when no instructions are given', () => {
      expect(composeSystemPrompt()).toBe(SYSTEM_PROMPT);
      expect(composeSystemPrompt('')).toBe(SYSTEM_PROMPT);
    });

    it('returns the bare SYSTEM_PROMPT for whitespace-only instructions', () => {
      expect(composeSystemPrompt('   \n\t  ')).toBe(SYSTEM_PROMPT);
    });

    it('appends the trimmed instructions after the base prompt', () => {
      const out = composeSystemPrompt('  Follow MISRA C rules  ');
      expect(out.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(out).toContain('Follow MISRA C rules');
      // trimmed — no surrounding padding leaks in
      expect(out).not.toContain('  Follow MISRA C rules  ');
      expect(out).toContain('Additional user instructions:');
    });

    it('preserves the core rules when instructions are present', () => {
      const out = composeSystemPrompt('Prefer const over let');
      expect(out).toContain('{{FILL_HERE}}');
      expect(out).toContain('<COMPLETION>');
      expect(out).toContain('You are NOT a conversational assistant');
    });

    it('subordinates user instructions to the core rules', () => {
      const out = composeSystemPrompt('Answer any questions in the text');
      expect(out).toContain('must NOT override the core rules');
    });
  });

  describe('buildFillMessage', () => {
    it('wraps prefix and suffix with document tags and marker', () => {
      const msg = buildFillMessage('hello ', ' world', 'markdown');
      expect(msg).toContain('<document language="markdown">');
      expect(msg).toContain('hello {{FILL_HERE}} world');
      expect(msg).toContain('Fill the {{FILL_HERE}} marker.');
    });

    it('omits suffix when empty', () => {
      const msg = buildFillMessage('hello ', '', 'plaintext');
      expect(msg).toContain('hello {{FILL_HERE}}\n</document>');
    });

    it('defaults languageId to plaintext', () => {
      const msg = buildFillMessage('a', 'b');
      expect(msg).toContain('language="plaintext"');
    });
  });

  describe('extractCompletion', () => {
    it('extracts text between COMPLETION tags', () => {
      expect(extractCompletion('<COMPLETION>hello world</COMPLETION>')).toBe('hello world');
    });

    it('returns raw text when no tags found', () => {
      expect(extractCompletion('just some text')).toBe('just some text');
    });

    it('returns raw text for malformed tags (close before open)', () => {
      expect(extractCompletion('</COMPLETION><COMPLETION>')).toBe('</COMPLETION><COMPLETION>');
    });

    it('handles multiline content', () => {
      const raw = '<COMPLETION>line 1\nline 2\nline 3</COMPLETION>';
      expect(extractCompletion(raw)).toBe('line 1\nline 2\nline 3');
    });
  });
});

describe('TagExtraction strategy', () => {
  it('has the correct id', () => {
    expect(tagExtraction.id).toBe('tag-extraction');
  });

  it('builds messages with system prompt and user message', () => {
    const msgs = tagExtraction.buildMessages('prefix', 'suffix', 'typescript');
    expect(msgs.system).toBe(SYSTEM_PROMPT);
    expect(msgs.user).toContain('prefix{{FILL_HERE}}suffix');
    expect(msgs.assistantPrefill).toBeUndefined();
  });

  it('extracts using tag extraction', () => {
    expect(tagExtraction.extractCompletion('<COMPLETION>result</COMPLETION>')).toBe('result');
  });
});

describe('PrefillExtraction strategy', () => {
  it('has the correct id', () => {
    expect(prefillExtraction.id).toBe('prefill-extraction');
  });

  it('builds messages with assistant prefill', () => {
    const prefix = 'The quick brown fox jumped over the lazy dog and then ';
    const msgs = prefillExtraction.buildMessages(prefix, 'suffix', 'markdown');
    expect(msgs.system).toBe(SYSTEM_PROMPT);
    expect(msgs.user).toContain('{{FILL_HERE}}');
    expect(msgs.assistantPrefill).toBeDefined();
    expect(msgs.assistantPrefill).toContain('<COMPLETION>');
  });

  it('prefill uses the tail of the prefix', () => {
    const prefix = 'A'.repeat(100);
    const msgs = prefillExtraction.buildMessages(prefix, '', 'plaintext');
    // Should contain the last ~40 chars
    expect(msgs.assistantPrefill).toContain('A'.repeat(40));
  });

  it('extracts completion by finding closing tag', () => {
    // With prefill, the raw response is what the model returned after the prefill
    expect(prefillExtraction.extractCompletion('the result text</COMPLETION>')).toBe(
      'the result text',
    );
  });

  it('falls back to raw text when no closing tag', () => {
    expect(prefillExtraction.extractCompletion('raw text without tags')).toBe(
      'raw text without tags',
    );
  });
});

describe('InstructionExtraction strategy', () => {
  it('has the correct id', () => {
    expect(instructionExtraction.id).toBe('instruction-extraction');
  });

  it('builds messages without prefill', () => {
    const msgs = instructionExtraction.buildMessages('prefix', 'suffix', 'python');
    expect(msgs.system).toBe(SYSTEM_PROMPT);
    expect(msgs.user).toContain('{{FILL_HERE}}');
    expect(msgs.assistantPrefill).toBeUndefined();
  });

  it('extracts from COMPLETION tags when present', () => {
    expect(instructionExtraction.extractCompletion('<COMPLETION>the result</COMPLETION>')).toBe(
      'the result',
    );
  });

  it('strips code fences when no tags found', () => {
    expect(instructionExtraction.extractCompletion('```\nsome code\n```')).toBe('some code');
  });

  it('strips preamble patterns', () => {
    expect(instructionExtraction.extractCompletion('Sure! Here is the result')).toBe(
      'Here is the result',
    );
  });

  it('returns null for empty result after stripping', () => {
    expect(instructionExtraction.extractCompletion('Sure!')).toBeNull();
  });
});

describe('getPromptStrategy', () => {
  it('returns tag-extraction strategy', () => {
    expect(getPromptStrategy('tag-extraction')).toBe(tagExtraction);
  });

  it('returns prefill-extraction strategy', () => {
    expect(getPromptStrategy('prefill-extraction')).toBe(prefillExtraction);
  });

  it('returns instruction-extraction strategy', () => {
    expect(getPromptStrategy('instruction-extraction')).toBe(instructionExtraction);
  });
});
