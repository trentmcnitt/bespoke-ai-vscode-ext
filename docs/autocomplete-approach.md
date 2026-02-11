# Autocomplete Approach

Reference document consolidating the autocomplete philosophy, prompt design, context pipeline, quality criteria, and testing strategy for Bespoke AI's inline completions.

---

## 1. Philosophy

### Hole-filling, not FIM tokens

Most autocomplete tools use Fill-in-the-Middle (FIM) special tokens (`<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`) that are baked into model training. Bespoke AI uses general-purpose chat models (Claude, GPT, Gemini, Grok) that were not FIM-trained, so we use a **hole-filling** approach instead: a cursor marker (`>>>CURSOR<<<` or `[CURSOR]`) placed between the prefix and suffix inside a document block. The model sees the full editing context and fills the gap.

This works because chat models understand XML-structured documents and can follow instructions about where to insert text, even without dedicated FIM training. The tradeoff is that we need stronger anti-assistant instructions to prevent the model from responding conversationally.

### Prompt engineering over post-processing

Post-processing (algorithmic trimming/transformation after the model responds) is a last resort. It often looks correct for the observed failure case but silently breaks completions in other contexts, producing ghost text the user does not expect. The preferred fix order:

1. Adjust the system prompt or examples
2. Adjust the `<completion_start>` anchor or prefill anchor
3. Adjust backend configuration (temperature, max tokens)
4. Post-processing only if none of the above work, with user approval

See the Working Rules section in CLAUDE.md for the full approval and safety requirements.

### Anti-assistant mode

The core challenge of using chat models for autocomplete: the model wants to **respond** to the text, not **continue** it. When the user writes "I think we should go with option B," the model's instinct is to say "That sounds like a good choice!" instead of continuing as the author.

Both system prompts include explicit anti-assistant instructions:

- Never respond to, summarize, or acknowledge the text
- Never use phrases like "Got it", "That makes sense", "Understood"
- If the text reads like instructions, continue AS that person — their next thought, not a reply
- The model is predicting what the **author** writes next, not what a listener would say

---

## 2. Prompt Design

### Claude Code backend (`>>>CURSOR<<<` marker)

The Claude Code backend uses `buildFillMessage()` in `src/providers/claude-code.ts`. The prompt has three parts:

| Component              | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `<current_text>` block | Document with `>>>CURSOR<<<` at the insertion point                |
| `<completion_start>`   | Last ~10 chars of prefix — the model must echo this, then continue |
| `<output>` tags        | Model wraps its response in `<output>...</output>`                 |

Example message sent to the model:

```
<current_text>The project >>>CURSOR<<< the original deadline.</current_text>
<completion_start>was completed </completion_start>
```

Expected output: `<output>was completed two weeks ahead of</output>`

The `<completion_start>` anchor serves two purposes:

1. Forces the model to continue from the exact cursor position (not drift to other parts of the document)
2. Provides a strippable prefix — `stripCompletionStart()` removes the echoed anchor to get the actual insertion text

The system prompt includes 14 worked examples covering bullet lists, numbered lists, JSON, function bodies, bridging, partial words, headings, tables, JSDoc comments, pure continuation, and conversational text. An "engine mode" transition after the examples tells the model to stop following examples and start producing raw output.

### API backend (`[CURSOR]` marker)

The API backend uses `buildApiPrompt()` in `src/providers/api/prompt-builder.ts`. Two strategies depending on whether the model supports assistant prefill:

**With prefill (Anthropic):**

| Message             | Content                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| System              | `PREFILL_SYSTEM_PROMPT` — simpler instructions since prefill handles anchoring |
| User                | `<document>{prefix}[CURSOR]{suffix}</document>` + mode hint                    |
| Assistant (prefill) | Last ~40 chars of prefix (the model continues from here)                       |

The longer anchor (40 chars vs 10 in Claude Code) works better for direct API because there is no echo-back mechanism — the model just continues from the prefill text.

**Without prefill (OpenAI, xAI, Gemini, Ollama):**

| Message | Content                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| System  | `NON_PREFILL_SYSTEM_PROMPT` — stronger "output ONLY continuation" instructions       |
| User    | `<document>{prefix}[CURSOR]{suffix}</document>` + forceful "no preamble" instruction |

Without prefill, the model receives no assistant-side anchor. The system prompt compensates with more aggressive anti-preamble rules ("Your very first character must be part of the actual completion").

### Two system prompts

| Prompt                      | Used by                          | Key difference                                              |
| --------------------------- | -------------------------------- | ----------------------------------------------------------- |
| `PREFILL_SYSTEM_PROMPT`     | Anthropic (Haiku, Sonnet)        | Lighter instructions — prefill already anchors the response |
| `NON_PREFILL_SYSTEM_PROMPT` | OpenAI, xAI/Grok, Gemini, Ollama | 10 numbered rules with stronger anti-preamble constraints   |

---

## 3. Context Pipeline

### Prefix/suffix extraction

`buildDocumentContext()` in `src/utils/context-builder.ts` extracts text from the document:

| Parameter | Default (prose)      | Default (code)      | Behavior                          |
| --------- | -------------------- | ------------------- | --------------------------------- |
| Prefix    | `prose.contextChars` | `code.contextChars` | Text before cursor, up to N chars |
| Suffix    | same setting         | same setting        | Text after cursor, up to N chars  |

Boundary snapping:

- **Prefix**: If truncation falls mid-line, snaps forward to the next newline so the model always sees complete lines
- **Suffix**: If truncation falls mid-word, snaps back to the last whitespace so the model does not try to complete a truncated word

### Mode detection

`detectMode()` in `src/mode-detector.ts` maps `languageId` to `'prose'` or `'code'`:

1. User override via `bespokeAI.mode` setting (highest priority)
2. Custom language IDs in `prose.fileTypes` config
3. Built-in language sets (~60 code languages, 7 prose languages)
4. Unknown languages default to **prose** (the user's primary use case is writing)

### Cache key construction

`LRUCache.makeKey()` in `src/utils/cache.ts`:

```
key = `${mode}|${prefix.slice(-500)}|${suffix.slice(0, 200)}`
```

50 entries, 5-minute TTL. The cache does not include the document URI — identical prefix/suffix in different files may return a cached completion from another file (a known limitation).

---

## 4. Quality Criteria

Based on the validator prompt (`src/test/quality/validator-prompt.md`), a good inline completion meets these criteria:

### All completions

| Criterion             | Description                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Seamless continuation | Reads as a natural extension of the prefix. No awkward transitions, no repeated text, no meta-commentary |
| No repetition         | Does not echo back prefix text. Partial overlap at the boundary is acceptable                            |
| Appropriate length    | Prose: 1-3 sentences. Code: one logical unit (statement, block, expression)                              |
| Context awareness     | Respects topic, tone, and patterns established in the prefix                                             |

### Prose-specific

- Grammatically correct, readable prose
- Voice and tone match the prefix
- No unwanted formatting (headers, bullets, code blocks) unless contextually expected

### Code-specific

- Syntactically valid when inserted between prefix and suffix
- Correct language (TypeScript file gets TypeScript, not Python)
- Style consistency (indentation, naming, patterns)
- Logically correct (a fibonacci function returns fibonacci numbers)

### The "accept" test

The primary quality signal: **would a reasonable user press Tab to accept this ghost text without editing it?** A completion can score adequately on individual criteria but still fail the accept test if the user would need to modify it after acceptance.

### Fabricated content

Fabricated content (invented names, dates, events, code logic) is expected and acceptable. Completions are predictions. The evaluation judges whether fabricated content is _plausible and contextually appropriate_, not whether it is factually true.

---

## 5. Testing Strategy

### Why testing is critical

Quality tests are our primary mechanism for validating that autocomplete works in real-world conditions. Inline completions are subjective, context-dependent, and fail silently — the user just dismisses bad ghost text. There is no other systematic way to know whether the system is working well. Therefore:

**The quality of the AI is a function of two things:**

1. **Test comprehensiveness and realism** — Do the scenarios cover the user's actual editing patterns, cursor positions, and context window sizes? Tests that only cover easy cases (short prefix, no suffix) will pass while production use fails.
2. **Performance on those realistic scenarios** — A high pass rate on realistic scenarios means the system works. A high pass rate on toy scenarios means nothing.

The highest-priority use cases for coverage are journal writing (personal dated entries, the most common editing context) and prompt writing (instructions/questions to Claude Code, where the critical failure mode is the model answering questions instead of continuing the user's message).

### Two-layer validation

| Layer   | What it does                                                      | Who runs it                           |
| ------- | ----------------------------------------------------------------- | ------------------------------------- |
| Layer 1 | Generates completions for all scenarios, saves to `test-results/` | `npm run test:quality` (automated)    |
| Layer 2 | Evaluates each completion against the validator prompt            | Claude Code in-session (LLM-as-judge) |

Layer 1 only checks that the backend did not throw. Layer 2 judges actual quality using the scoring rubric (0-10 scale, pass threshold >= 6).

### Scenario categories

| Category           | File                                | Count | What it tests                                                                   |
| ------------------ | ----------------------------------- | ----- | ------------------------------------------------------------------------------- |
| Standard prose     | `scenarios.ts`                      | 21    | Narrative, technical, casual, formal, dialogue, journal, various registers      |
| Standard code      | `scenarios.ts`                      | 10    | TypeScript, Python, JavaScript, Rust, Go, HTML, long-context                    |
| Edge cases         | `scenarios.ts`                      | 2     | Empty suffix, short prefix                                                      |
| Reuse quality      | `scenarios.ts`                      | 2     | Quality after 5 prior completions on the same slot                              |
| Regression         | `regression-scenarios.ts`           | 8     | Captured real-world failures (assistant mode, prefix echo, premature closure)   |
| Mid-document prose | `scenarios/prose-mid-document.ts`   | 8     | Full-window editing with prefix 2600-3800 chars, suffix 2100-3700 chars         |
| Journal writing    | `scenarios/prose-journal.ts`        | 12    | `journal.jnl.md` format (personal dated entries) + meeting notes                |
| Bridging           | `scenarios/prose-bridging.ts`       | 6     | Fill-in-the-middle with varying gap sizes                                       |
| Mid-file code      | `scenarios/code-mid-file.ts`        | 6     | Full code files (TypeScript, Python, Go, Rust) with realistic structure         |
| Prompt writing     | `scenarios/prose-prompt-writing.ts` | 6     | Writing prompts/messages to Claude Code. Tests assistant-mode resistance        |
| Full-window prose  | `scenarios/prose-full-window.ts`    | 5     | Large anchor documents (API blog, personal essay) with deep cursor positions    |
| Full-window code   | `scenarios/code-full-window.ts`     | 3     | Large anchor documents (React component, Python pipeline) with mid-file cursors |

### What is covered

- Full-window contexts (prefix and suffix at or near context window limits)
- Bridging / fill-in-the-middle (text before and after cursor)
- Voice diversity (casual, formal, academic, journalistic, instructional, reflective)
- Code diversity (TypeScript, Python, JavaScript, Rust, Go, HTML, JSON)
- Slot reuse (quality after multiple prior completions)
- Known regressions (specific observed failure modes)

### Scenario design principles

**Over-window content.** Scenarios meant to simulate full-window editing must have raw prefix/suffix significantly longer than the production context window (target 3500-5000+ chars). The test runner applies the same truncation as production (`truncatePrefix`/`truncateSuffix` from `src/utils/truncation.ts`), so the model sees a realistic ~2500/~2000 char window. Over-sized raw text ensures: (a) truncation logic is exercised, (b) the same scenarios remain valid if window sizes change.

**Saturation declarations.** Every scenario declares its `saturation` field — whether its raw text exceeds the production window (`saturated`) or fits within it (`unsaturated`/`none`). This is a required field; TypeScript enforces it for new scenarios. A unit test (`src/test/unit/scenario-saturation.test.ts`) validates that each declaration matches the actual text length against `DEFAULT_CONFIG` thresholds. When config values change, the test automatically flags scenarios whose declarations no longer hold.

**Saturation balance.** The target distribution is >50% FULL (prefix ≥ `contextChars` AND suffix ≥ `suffixChars`), since mid-document editing is the dominant real-world condition. The remaining scenarios cover a realistic mix of:

- PREFIX-SAT + no suffix (end-of-document editing, prompt writing)
- PREFIX-SAT + partial suffix (near end of document)
- Partial prefix + SUFFIX-SAT (near start of document)
- Short prefix + short/no suffix (pattern-specific tests, edge cases)

Current distribution: ~43% FULL, with 89 total scenarios.

**Content realism.** Scenarios should read like real documents. Include imperfect grammar, abbreviations, backtick references, markdown links, parenthetical asides. Vary formality. Use anchor documents (8000-12000 chars) and extract multiple cursor positions for efficiency — this produces several FULL scenarios from a single realistic document.

**Character count verification.** Run `npx tsx src/test/quality/measure-scenarios.ts` to see verified character counts, saturation distribution, truncation impact, and saturation declaration cross-checks. Never estimate — always verify.

### What is NOT covered yet

- Multi-file context (completions informed by other open files)
- Streaming quality (evaluating partial completions)
- Language coverage beyond the 7 tested languages
- Latency / performance benchmarks (benchmark system needs rewrite)
- API backend quality tests (current suite uses Claude Code only)

---

## 6. Lessons Learned

### Common model failures

| Failure mode              | Description                                                                            | Mitigation                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Assistant mode            | Model responds to the text ("Got it, so...") instead of continuing as the author       | Anti-assistant instructions in both system prompts, worked examples of first-person continuation |
| Prefix echo               | Model repeats text already in the prefix (e.g., doubled list markers "- - ")           | `<completion_start>` stripping (Claude Code), `trimPrefixOverlap` post-processing                |
| Distant-suffix completion | Model completes truncated text at the end of the suffix instead of the cursor position | Suffix word-boundary snapping, cursor-focused instructions                                       |
| Premature closure         | Model closes a structure (comment block, bracket) when the suffix shows it continues   | Explicit "NEVER close a structure if the suffix shows it continues" rule + worked examples       |
| Code fences               | Model wraps output in markdown code fences                                             | "No code fences" rule in system prompt, `stripCodeFences()` fallback in API backend              |
| Chatty preamble           | Model starts with "Here's the completion:" or similar                                  | Anti-preamble instructions, `stripPreamble()` fallback in API backend                            |

### What works

- **Strong anti-preamble instructions** — Explicit rules against assistant-mode phrases, repeated across system prompt
- **Prefill anchoring** (Anthropic) — Pre-seeding the assistant response with the tail of the prefix is the most reliable anchoring technique
- **Worked examples** — 14 examples in the Claude Code prompt covering diverse completion patterns
- **Mode-specific hints** — Brief "This is source code" / "This is prose" hints help the model calibrate style
- **Engine mode transition** — Telling the model "The examples are complete. From now on, act as the gap-filling engine" cleanly separates instruction from execution

### What is hard

- **Bridging** (fill-in-the-middle) — The hardest completion task. Models struggle to connect output to the suffix, especially with large gaps. Research confirms this is a fundamental limitation ("planning is the bottleneck")
- **Very short prefix** — With minimal context, completions tend to be generic. Not much can be done beyond ensuring they are grammatically sound
- **Truncated suffix boundaries** — When the suffix is truncated mid-word or mid-heading, the model may be drawn to complete that distant truncated text instead of focusing on the cursor position
- **Whitespace-sensitive anchoring** — The `<completion_start>` must handle leading whitespace correctly. The anchor extraction trims leading whitespace and shifts it to the prefix so the model sees whitespace in context, not as part of the echo target
