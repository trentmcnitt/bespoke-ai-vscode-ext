import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT,
  composeSystemPrompt,
  sanitizeCustomInstructions,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  buildFillMessage,
  extractCompletion,
  tagExtraction,
  prefillExtraction,
  instructionExtraction,
  getPromptStrategy,
  fillInstructionSentences,
  FILL_INSTRUCTION,
  ENDS_WITH_SPACE_CUE,
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

    it('demonstrates both word-boundary shapes', () => {
      // Marker flush against a finished word: the completion carries the space.
      expect(SYSTEM_PROMPT).toContain('tighter but{{FILL_HERE}}\n<COMPLETION> the scope');
      // Marker inside a partly typed word: no space.
      expect(SYSTEM_PROMPT).toContain('new onboar{{FILL_HERE}}\n<COMPLETION>ding flow');
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

    describe('whitespace cue', () => {
      it('names the preceding word when the marker is flush against it', () => {
        const msg = buildFillMessage('changes that', ' seemed simple', 'markdown');
        expect(msg).toContain('There is no space between "that" and the marker.');
        expect(msg).toContain('begin with a space');
        expect(msg).toContain('If you are finishing "that" itself, do not.');
      });

      it('treats trailing punctuation as part of the preceding token', () => {
        const msg = buildFillMessage('It worked.', '');
        expect(msg).toContain('There is no space between "worked." and the marker.');
      });

      it('caps the quoted token at 30 characters', () => {
        const msg = buildFillMessage(`see ${'x'.repeat(50)}`, '');
        expect(msg).toContain(`between "${'x'.repeat(30)}" and`);
      });

      it('handles non-ASCII words', () => {
        const msg = buildFillMessage('un café', '');
        expect(msg).toContain('There is no space between "café" and the marker.');
      });

      it('adds no cue after code punctuation like a quote or open paren', () => {
        for (const prefix of ['<a href="', 'foo(', 'x = {']) {
          const msg = buildFillMessage(prefix, '', 'html');
          expect(msg.endsWith('Fill the {{FILL_HERE}} marker.')).toBe(true);
        }
      });

      it('says a space is already present when the prefix ends with one', () => {
        const msg = buildFillMessage('hello ', ' world');
        expect(msg).toContain('The text before it already ends with a space.');
        expect(msg).not.toContain('There is no space between');
      });

      it('adds no cue after a line break, indentation, or an empty prefix', () => {
        for (const prefix of ['line one\n', 'if (x) {\n    ', '']) {
          const msg = buildFillMessage(prefix, 'next');
          expect(msg.endsWith('Fill the {{FILL_HERE}} marker.')).toBe(true);
        }
      });
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

  describe('thinking-leak retry (immediate close, then a second block)', () => {
    it('uses the retry block when the first block is empty', () => {
      expect(
        prefillExtraction.extractCompletion(
          '</COMPLETION>\n\nLet me redo that.\n<COMPLETION>ok</COMPLETION>',
        ),
      ).toBe('ok');
    });

    it('uses the first block when it is substantive, even if a second block follows', () => {
      expect(
        prefillExtraction.extractCompletion('first</COMPLETION>\n<COMPLETION>second</COMPLETION>'),
      ).toBe('first');
    });

    // Recorded from claude-haiku-4-5 (quality run 2026-03-02T00-46-35, code-js-arrow-function):
    // the model echoed the placeholder, closed, then answered. The echoed marker used to
    // count as substantive, post-processing stripped it, and `user.name` was lost.
    it('treats a first block that is only the {{FILL_HERE}} marker as empty', () => {
      expect(
        prefillExtraction.extractCompletion(
          '{{FILL_HERE}}</COMPLETION>\n\n<COMPLETION>user.name</COMPLETION>',
        ),
      ).toBe('user.name');
    });

    it('returns null when there is nothing but scaffolding or whitespace', () => {
      expect(prefillExtraction.extractCompletion('</COMPLETION>')).toBeNull();
      expect(prefillExtraction.extractCompletion(' \n</COMPLETION>')).toBeNull();
      expect(prefillExtraction.extractCompletion('{{FILL_HERE}}</COMPLETION>')).toBeNull();
      expect(
        prefillExtraction.extractCompletion('</COMPLETION><COMPLETION>{{FILL_HERE}}</COMPLETION>'),
      ).toBeNull();
    });

    it('keeps a first block that contains the marker alongside real text', () => {
      // Not scaffold-only; post-processing strips the leaked marker as before.
      expect(prefillExtraction.extractCompletion('x{{FILL_HERE}}</COMPLETION>')).toBe(
        'x{{FILL_HERE}}',
      );
    });
  });

  it('falls back to raw text when no closing tag', () => {
    expect(prefillExtraction.extractCompletion('raw text without tags')).toBe(
      'raw text without tags',
    );
  });

  // Haiku sometimes re-types the rest of the user message (marker, suffix,
  // </document>, the appended instruction and whitespace cue) and reasons before
  // its first </COMPLETION>. That block is not an answer. Shapes reduced from
  // claude-haiku-4-5 raw outputs, evals/2026-09-28-reasoning-leakage.md.
  describe('rejects a block that echoes the user message', () => {
    it('the shared sentences are exactly what buildFillMessage appends', () => {
      expect(buildFillMessage('We pushed the deploym', '', 'markdown')).toBe(
        '<document language="markdown">\nWe pushed the deploym{{FILL_HERE}}\n</document>\n\n' +
          'Fill the {{FILL_HERE}} marker. There is no space between "deploym" and the marker. ' +
          'If "deploym" is a complete word or ends in punctuation and your output starts a new word, ' +
          'begin with a space. If you are finishing "deploym" itself, do not.',
      );
      expect(buildFillMessage('Total: 5 ', 'x', 'plaintext')).toBe(
        '<document language="plaintext">\nTotal: 5 {{FILL_HERE}}x\n</document>\n\n' +
          'Fill the {{FILL_HERE}} marker. The text before it already ends with a space.',
      );
    });

    const extract = (raw: string, prefix: string, suffix = '') =>
      prefillExtraction.extractCompletion(raw, prefix, suffix);
    const midWordPrefix = 'Friday was rough. We pushed the deploym';
    const hrefPrefix = '<nav>\n  <ul>\n    <li><a href="/about">About</a></li>\n    <li><a href="';
    const hrefSuffix = '</a></li>\n  </ul>\n</nav>';

    describe('activation', () => {
      it('mid-word: echoed marker, </document>, instruction and cue, then the answer, one close', () => {
        const raw =
          '{{FILL_HERE}}\n</document>\n\n' +
          fillInstructionSentences(midWordPrefix).join(' ') +
          '\n\n<COMPLETION>ent to production.</COMPLETION>';
        // The answer after the reopened tag is recovered (recoverFromEchoBlock).
        expect(extract(raw, midWordPrefix)).toBe('ent to production.');
        // Same, without the inner <COMPLETION> (the model just kept writing).
        const raw2 = raw.replace('<COMPLETION>', '');
        expect(extract(raw2, midWordPrefix)).toBeNull();
      });

      it('href: echoed suffix and </document>, reasoning, then an untagged answer, one close', () => {
        const raw =
          '{{FILL_HERE}}</a></li>\n  </ul>\n</nav>\n</document>\n\n' +
          'I need to see the actual content after the marker. A typical third link would be:\n\n' +
          '/contact">Contact</COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBeNull();
      });

      it('uses a closed retry block after a first block that echoes the document', () => {
        const raw =
          '{{FILL_HERE}}</a></li>\n  </ul>\n</nav>\n</document>\n</COMPLETION>\n\n' +
          'I need to reconsider.\n\n<COMPLETION>/contact">Contact</COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBe('/contact">Contact');
      });

      it('rejects a retry block that itself echoes the user message', () => {
        const raw =
          '</COMPLETION>\nWait.\n<COMPLETION>{{FILL_HERE}}</a></li>\n</document></COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBeNull();
      });

      it('rejects an unclosed block (max_tokens) that echoes the document', () => {
        const raw =
          '{{FILL_HERE}}</a></li>\n  </ul>\n</nav>\n</document>\n\nI need to see the actual';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBeNull();
      });

      it('fires on each appended sentence alone', () => {
        for (const sentence of fillInstructionSentences(midWordPrefix)) {
          expect(extract(`ent. ${sentence}</COMPLETION>`, midWordPrefix)).toBeNull();
        }
        const spacePrefix = 'Total: 5 ';
        expect(fillInstructionSentences(spacePrefix)).toContain(ENDS_WITH_SPACE_CUE);
        expect(extract(`items. ${ENDS_WITH_SPACE_CUE}</COMPLETION>`, spacePrefix)).toBeNull();
      });

      it('checks the fixed instruction line even without a prefix', () => {
        expect(
          prefillExtraction.extractCompletion(`x ${FILL_INSTRUCTION}</COMPLETION>`),
        ).toBeNull();
      });
    });

    describe('no-op', () => {
      it('keeps a leading marker followed by a real answer (stripLeakedTags handles it)', () => {
        expect(extract('{{FILL_HERE}}ent to production.</COMPLETION>', midWordPrefix)).toBe(
          '{{FILL_HERE}}ent to production.',
        );
      });

      it('keeps a completion that closes </document> in an XML file', () => {
        const prefix = '<document>\n  <title>Report</title>\n  <body>Q3 results';
        const raw = ' are attached.</body>\n</document></COMPLETION>';
        expect(extract(raw, prefix, '')).toBe(' are attached.</body>\n</document>');
      });

      it('keeps prose that talks about filling a marker in a document', () => {
        const prefix = 'For the form, ';
        const raw = 'fill the marker field in the document before you submit it.</COMPLETION>';
        expect(extract(raw, prefix)).toBe(raw.replace('</COMPLETION>', ''));
      });

      it('keeps a cue-like sentence about a different word', () => {
        // Only the cue actually sent for this prefix counts.
        const raw = ' There is no space between "foo" and the marker.</COMPLETION>';
        expect(extract(raw, midWordPrefix)).toBe(
          ' There is no space between "foo" and the marker.',
        );
      });

      it('ignores a signal that is already in the document (editing this extension)', () => {
        // Completing the template line in prompt-strategy.ts itself.
        const prefix = 'const doc = `<document language="${languageId}">\\n${prefix}';
        const suffix =
          "`;\nexport const FILL_INSTRUCTION = 'Fill the {{FILL_HERE}} marker.';\n// </document>";
        const raw = '{{FILL_HERE}}\\n</document>`;</COMPLETION>';
        expect(extract(raw, prefix, suffix)).toBe('{{FILL_HERE}}\\n</document>`;');
        const raw2 = `Fill the {{FILL_HERE}} marker.</COMPLETION>`;
        expect(extract(raw2, "x = '", suffix)).toBe('Fill the {{FILL_HERE}} marker.');
      });

      it('keeps reasoning that quotes nothing from the prompt (deliberate residual risk)', () => {
        const raw = ' Wait, let me reconsider the plan.</COMPLETION>';
        expect(extract(raw, 'We shipped it.')).toBe(' Wait, let me reconsider the plan.');
      });
    });
  });

  // The answer to an echo detour usually sits inside the rejected block, after a
  // <COMPLETION> the model reopened. Shapes reduced from claude-haiku-4-5 raw
  // outputs, evals/2026-09-28-echo-recovery-prototype.md.
  describe('recovers the answer from inside a rejected echo block', () => {
    const extract = (raw: string, prefix: string, suffix = '') =>
      prefillExtraction.extractCompletion(raw, prefix, suffix);
    const midWordPrefix = 'Friday was rough. We pushed the deploym';
    const hrefPrefix = '<nav>\n  <ul>\n    <li><a href="/about">About</a></li>\n    <li><a href="';
    const hrefSuffix = '</a></li>\n  </ul>\n</nav>';
    const hrefEcho = '{{FILL_HERE}}</a></li>\n  </ul>\n</nav>\n</document>\n\n';
    const proseListPrefix =
      '- Data consistency matters more than availability\n\nGiven these constraints,';

    describe('activation', () => {
      it('mid-word: echoed cue, then a reopened block finishing the word', () => {
        const raw =
          '{{FILL_HERE}}\n</document>\n\n' +
          fillInstructionSentences(midWordPrefix).join(' ') +
          '\n\n<COMPLETION>ent to production and it broke checkout.</COMPLETION>';
        expect(extract(raw, midWordPrefix)).toBe('ent to production and it broke checkout.');
      });

      it('href: echoed suffix and reasoning, then a reopened path and link text', () => {
        const raw =
          hrefEcho +
          'I need to see the actual content. A typical third link would be:\n\n' +
          '<COMPLETION>/contact">Contact</COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBe('/contact">Contact');
      });

      it('prose: keeps the leading space of the reopened block', () => {
        const raw =
          '{{FILL_HERE}}\n</document>\n\n' +
          fillInstructionSentences(proseListPrefix).join(' ') +
          '\n\n---\n\n<COMPLETION> we should favor a single-leader database.</COMPLETION>';
        expect(extract(raw, proseListPrefix)).toBe(' we should favor a single-leader database.');
      });

      it('takes the last reopened block when there are several', () => {
        const raw =
          hrefEcho +
          'A typical link would be:\n\n<COMPLETION>/contact">Contact</a></li>\n\n' +
          'Actually, let me reconsider:\n\n<COMPLETION>/services">Services</COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBe('/services">Services');
      });

      it('is reached only after a usable closed retry block is ruled out', () => {
        const raw =
          hrefEcho +
          '<COMPLETION>/contact">Contact</COMPLETION>\nWait.\n<COMPLETION>/blog">Blog</COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBe('/blog">Blog');
      });
    });

    describe('no-op', () => {
      it('an echo block without a reopened tag still shows nothing', () => {
        const raw = hrefEcho + 'Could you clarify what the third link should be?</COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBeNull();
      });

      it('a reopened block that itself contains </document> is not used', () => {
        const raw =
          '{{FILL_HERE}}\n</document>\n\nFill the {{FILL_HERE}} marker.\n\n' +
          '<COMPLETION>{{FILL_HERE}}</a></li>\n</document></COMPLETION>';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBeNull();
        const raw2 = hrefEcho + '<COMPLETION>/contact">Contact</a>\n</document></COMPLETION>';
        expect(extract(raw2, hrefPrefix, hrefSuffix)).toBeNull();
      });

      it('a reopened block that contains an appended sentence is not used', () => {
        const raw =
          '{{FILL_HERE}}\n</document>\n\n<COMPLETION>ent. ' +
          fillInstructionSentences(midWordPrefix)[1] +
          '</COMPLETION>';
        expect(extract(raw, midWordPrefix)).toBeNull();
      });

      it('an unclosed echo block (max_tokens) with a reopened tag is not recovered', () => {
        const raw = hrefEcho + 'A typical third link would be:\n\n<COMPLETION>/contact">';
        expect(extract(raw, hrefPrefix, hrefSuffix)).toBeNull();
      });

      it('a reopened block that restarts the prefix is not used', () => {
        const echo = '{{FILL_HERE}}\n</document>\n\n' + FILL_INSTRUCTION + '\n\n';
        // Re-types the partly typed word ("deploymdeployment" if shown).
        expect(
          extract(echo + '<COMPLETION>deployment to production.</COMPLETION>', midWordPrefix),
        ).toBeNull();
        // Re-types the prefill anchor.
        expect(
          extract(
            echo + '<COMPLETION>' + midWordPrefix + 'ent to production.</COMPLETION>',
            midWordPrefix,
          ),
        ).toBeNull();
      });

      it('a blank reopened block is not used', () => {
        expect(
          extract(hrefEcho + '<COMPLETION>  </COMPLETION>', hrefPrefix, hrefSuffix),
        ).toBeNull();
      });

      it('a first block that is not an echo is unchanged, reopened tag and all', () => {
        const raw = ' ship it.<COMPLETION> Or not.</COMPLETION>';
        expect(extract(raw, 'We should')).toBe(' ship it.<COMPLETION> Or not.');
      });

      it('a scaffold-only first block with no retry still shows nothing', () => {
        expect(extract('{{FILL_HERE}}<COMPLETION></COMPLETION>', midWordPrefix)).toBeNull();
      });
    });
  });

  // The prefill anchor has the prefix's trailing whitespace trimmed (the API
  // rejects it), so the model re-emits that whitespace. It is already before the
  // cursor, so extraction must drop it or the ghost text doubles it.
  describe('re-aligns whitespace trimmed off the prefill anchor', () => {
    const extract = (raw: string, prefix?: string) =>
      prefillExtraction.extractCompletion(raw, prefix);

    it('drops a re-emitted space', () => {
      expect(extract(' inadequate assertions.</COMPLETION>', 'hiding behind ')).toBe(
        'inadequate assertions.',
      );
      expect(extract(' x % 2 == 0</COMPLETION>', 'evens = [x for x in numbers if ')).toBe(
        'x % 2 == 0',
      );
    });

    it('drops re-emitted newlines and indentation', () => {
      expect(extract('\n\t\t\tresults <- processItem(s)</COMPLETION>', 'go func() {\n\t\t\t')).toBe(
        'results <- processItem(s)',
      );
      expect(extract('\n\nProper error handling</COMPLETION>', '## Error Handling\n\n')).toBe(
        'Proper error handling',
      );
    });

    it('drops only the part that matches the trimmed whitespace', () => {
      // Prefix ends with "\n\n"; the model emitted one newline then content.
      expect(extract('\nNext paragraph</COMPLETION>', 'End of heading.\n\n')).toBe(
        'Next paragraph',
      );
      // Prefix ends with a space; the model starts a new line instead — keep it.
      expect(extract('\nnew line</COMPLETION>', 'some text ')).toBe('\nnew line');
    });

    it('is a no-op when the prefix has no trailing whitespace', () => {
      expect(extract(' the scope</COMPLETION>', 'tighter but')).toBe(' the scope');
      expect(extract('ding flow</COMPLETION>', 'the new onboar')).toBe('ding flow');
    });

    it('is a no-op when the output does not start with the trimmed whitespace', () => {
      expect(extract('inadequate</COMPLETION>', 'hiding behind ')).toBe('inadequate');
    });

    it('is a no-op without a prefix (backward compatible)', () => {
      expect(extract(' inadequate</COMPLETION>')).toBe(' inadequate');
    });

    it('still returns null when nothing usable was extracted', () => {
      expect(extract('</COMPLETION>', 'text ')).toBeNull();
    });
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

describe('sanitizeCustomInstructions', () => {
  it('returns empty for undefined, empty, and whitespace', () => {
    expect(sanitizeCustomInstructions(undefined)).toBe('');
    expect(sanitizeCustomInstructions('')).toBe('');
    expect(sanitizeCustomInstructions('  \n\t ')).toBe('');
  });

  it('leaves ordinary multi-line rules untouched', () => {
    const rules = 'Follow MISRA C rules.\nAvoid dynamic memory allocation.\n\tPrefer const.';
    expect(sanitizeCustomInstructions(rules)).toBe(rules);
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(sanitizeCustomInstructions('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips C0 control characters and DEL but keeps tab and newline', () => {
    expect(sanitizeCustomInstructions('a\u0000b\u0007c\u001bd\u007fe\tf\ng')).toBe('abcde\tf\ng');
  });

  it('strips Unicode bidi overrides and isolates', () => {
    expect(sanitizeCustomInstructions('safe\u202Etxet\u202C \u2066x\u2069')).toBe('safetxet x');
  });

  it('caps at MAX_CUSTOM_INSTRUCTIONS_CHARS', () => {
    const long = 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 500);
    expect(sanitizeCustomInstructions(long)).toHaveLength(MAX_CUSTOM_INSTRUCTIONS_CHARS);
    const exact = 'y'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS);
    expect(sanitizeCustomInstructions(exact)).toBe(exact);
  });

  it('composeSystemPrompt applies the same sanitization', () => {
    const out = composeSystemPrompt('Prefer const\u0000 over let\u202E');
    expect(out).toContain('Prefer const over let');
    expect(out).not.toContain('\u0000');
    expect(out).not.toContain('\u202E');
    const capped = composeSystemPrompt('z'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS * 2));
    expect(capped.length).toBeLessThan(SYSTEM_PROMPT.length + MAX_CUSTOM_INSTRUCTIONS_CHARS + 400);
  });
});
