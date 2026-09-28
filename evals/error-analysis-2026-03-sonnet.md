# Error analysis: quality run 2026-03-26, Claude Code CLI / sonnet

This is an error analysis of an existing Layer 1 + Layer 2 quality run. No new model calls were made. The analyst ("I" below) was an AI agent (Claude, in a Claude Code session), not a person; its verdicts have not been checked against a human. I read each failed scenario (prefix tail, suffix head, completion, the raw model response, and the judge's reasoning), wrote a short note on each, grouped the notes into failure classes, and counted them. I did not read every passing output: I spot-checked 14 passes and ran a mechanical check over all 99 completions. That check found a class of defect the judge had missed.

> **Correction (2026-09-28).** This analysis originally counted `code-java-mid-file` as a judge false fail, calling the trimmed result valid Java. It is not: the prefix ends `.filter(user -> `, so after `)` was trimmed the suffix's `)` closes `isActive(` and `.filter(` is never closed. The judge was right, and the trim was a post-processing bug (fixed on this branch: the code-mode overlap trim no longer removes a closer of a scope the completion opened itself). Figures below are corrected: analyst pass 69/99, judge disagreements 19, false fails 3.

Per-scenario records: [`data/2026-03-26-claude-code-sonnet.json`](data/2026-03-26-claude-code-sonnet.json).

## Provenance

| Item              | Value                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run               | `test-results/quality-2026-03-26T21-32-33-claude-code-sonnet/` (gitignored, main checkout)                                                                                                                                                                      |
| Generated         | 2026-03-26 21:32–21:49 UTC (per-scenario `generatedAt`)                                                                                                                                                                                                         |
| Backend / model   | `claude-code` / `claude-code/sonnet` (tag-extraction strategy)                                                                                                                                                                                                  |
| Scenarios         | 99 (standard, category files, regression). 97 non-null, 2 null                                                                                                                                                                                                  |
| Judge             | Claude Code, in-session (Layer 2 per AGENTS.md). **Judge model: not recorded.** Neither `validation.md` nor `layer2-summary.md` names it.                                                                                                                       |
| Git commit of run | **Not recorded** in `summary.json` / `metadata.json`. The nearest commit before the run is `3cda335` (2026-03-26 12:50 -0500, a merge on `fix/bundled-node-spawn`). That is only the nearest commit, not a confirmed one.                                       |
| Rubric            | `src/test/quality/validator-prompt.md` at `538840e` (2026-02-01, the last change before the run). The current version is `68c6483` (2026-07-10), which adds only the custom-instructions section (+18/−1).                                                      |
| Comparison run    | `quality-2026-03-26T20-54-50-claude-code-sonnet`, the same backend about 40 min earlier. It has 84 `validation.md` files, but its `layer2-summary.md` covers only 20. It is used here for judge-consistency checks.                                             |
| Other runs        | The March API/Ollama runs (`03-01`–`03-04`) have Layer 1 output but no validations. The 07-10 runs cover only the 5–7 custom-instructions scenarios. I used the Layer 1 output of some of them for one mechanical cross-run check (boundary whitespace, below). |

## Headline numbers

|                                                          | Count   | Rate  |
| -------------------------------------------------------- | ------- | ----- |
| Judge pass (from the 99 `validation.md` files)           | 82 / 99 | 82.8% |
| `layer2-summary.md` claims                               | 83 / 99 | 83.8% |
| Analyst pass, all classes                                | 69 / 99 | 69.7% |
| Analyst pass, not counting the boundary-whitespace class | 86 / 99 | 86.9% |

The summary is off by one. Its failure list names 15 scenarios. It leaves out `code-java-mid-file` (score 3) and `prose-full-api-pagination` (score 2), and it includes `prose-journal-medium-current`. The validation files contain 17 fails. The summary's "Prose (full-doc) 2/5" row should read 3/5.

**Judge disagreements: 19 of 99.**

- **3 false fails.** Details below.
- **16 false passes.** 15 of them are the boundary-whitespace defect. The other is `regression-prose-distant-suffix-completion`.
- **2 fails where I agree with the verdict but not the reason:** `prose-long-prefix-technical` and `prose-journal-chronological-notes`. The judge objected to length and wording. The actual defect is a missing leading space.

**The judge is not stable.** Three byte-identical completions got opposite verdicts in the two same-day runs:

| Scenario                               | Completion                                          | 20:54 run | 21:32 run |
| -------------------------------------- | --------------------------------------------------- | --------- | --------- |
| `code-java-mid-file`                   | `user.isActive(`                                    | 9 pass    | 3 fail    |
| `prose-journal-jnl-after-bold-heading` | `Finally checked out the new ramen place downtown…` | 7 pass    | 4 fail    |
| `prose-journal-jnl-between-topics`     | `02-08-26\n\n`                                      | 6 pass    | 3 fail    |

Two more near-identical completions also flipped: `regression-prose-list-marker-echo` (9 → 2) and `prose-journal-chronological-notes` (6 → 3).

## Failure taxonomy (analyst-confirmed failures, n = 30)

Each failure is counted once, under its primary class.

| #   | Class                                                                                                                                                                                                                                                            | Count                                                             | Judge caught                                 | Scenario categories                                       | Regression coverage                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Boundary whitespace**: completion starts with a word character, prefix ends with a word or punctuation and no space, so the inserted text runs two words together (`behindinadequate`).                                                                        | 17 primary; 21 of 43 prose completions at a word boundary have it | 0 (the 2 judge fails were for other reasons) | mid-doc 5, bridge 4, full-window 3, standard 3, journal 2 | None. `partial-word-newline-suffix` tests the opposite case (a mid-word continuation must _not_ add a separator).                                     |
| 2   | **Over-generation / drift**: writes paragraphs, sections or code blocks where a clause or heading was needed, sometimes from another part of the document.                                                                                                       | 4                                                                 | 4                                            | full-window 1, journal 1, mid-doc 1, regression 1         | Partial. `partial-date-not-continued` fails for this reason now, although its original bug is fixed.                                                  |
| 3   | **Tight-gap collision**: the suffix already continues the sentence, and the completion fills a slot the suffix fills or inserts text that clashes with it (`looks way so much better`).                                                                          | 3                                                                 | 3                                            | journal 2, full-window 1                                  | None for prose. The three `suffix-echo` regressions cover single code delimiters only.                                                                |
| 4   | **Journal structure**: invented or duplicated date heading, or a date out of order in a reverse-chronological file.                                                                                                                                              | 2 (+1 secondary in `full-new-entry`)                              | 2                                            | journal 2                                                 | None. `partial-date` covers typing a date, not its placement.                                                                                         |
| 5   | **Suffix regurgitation**: the raw output rewrites the suffix verbatim and keeps going. Post-processing trims it to a stray token, so the judge only sees a near-null.                                                                                            | 1                                                                 | 1 (as "near-null")                           | standard 1                                                | None.                                                                                                                                                 |
| 6   | **Under-generation**: a gap needs content, but the model returns only whitespace (the pipeline then reports null).                                                                                                                                               | 1                                                                 | 1                                            | bridge 1                                                  | None.                                                                                                                                                 |
| 7   | **Distant-suffix completion**: continues text at the far end of the suffix (a truncated bullet list) instead of the text at the cursor.                                                                                                                          | 1                                                                 | 0 (false pass)                               | regression 1                                              | Covered in intent by `regression-prose-distant-suffix-completion`. Its `must_not_include` targets an old truncation point, so this recurrence passes. |
| 8   | **Post-processing bracket trim** (added with the 2026-09-28 correction): the code-mode suffix-overlap trim removed a `)` that closed a scope the completion itself opened, leaving `.filter(` unclosed (`code-java-mid-file`). The raw model output was correct. | 1                                                                 | 1                                            | code 1                                                    | Fixed in `5e2a20e`; the replay set now pins the untrimmed `user.isActive()`.                                                                          |

**Per scenario category** (judge fails / analyst fails / analyst fails without class 1):

| Category                                                    | n   | Judge fail | Analyst fail | Analyst fail excl. whitespace |
| ----------------------------------------------------------- | --- | ---------- | ------------ | ----------------------------- |
| journal (`prose-journal.ts`)                                | 12  | 7          | 7            | 5                             |
| prose-full-window                                           | 5   | 2          | 5            | 2                             |
| prose-mid-doc                                               | 8   | 1          | 6            | 1                             |
| prose-bridge                                                | 6   | 1          | 5            | 1                             |
| prose-standard (`scenarios.ts`)                             | 23  | 2          | 4            | 1                             |
| regression-prose                                            | 5   | 2          | 2            | 2                             |
| prompt-writing                                              | 6   | 0          | 0            | 0                             |
| code (standard 19, mid-file 6, full-window 3, regression 6) | 34  | 2          | 1            | 1                             |

- **Code:** one real code failure, and it was not the model's: post-processing trimmed a bracket the completion needed (`code-java-mid-file`, fixed in `5e2a20e`). The other code fail (`code-full-py-pipeline-dispatch`) was a judge error.
- **Prompt writing:** there were no failures. The "answers the question instead of continuing" failure did not appear in any of the 6 prompt-writing scenarios or in `regression-prose-assistant-mode-response`.
- **Journal:** this is where the real failures concentrate once whitespace is set aside. All prompt-writing scenarios are prefix-only; the journal and bridge scenarios with a close suffix are where the model struggles.

## Judge false fails (3)

| Scenario                               | Why the verdict is wrong                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `regression-prose-list-marker-echo`    | The completion does not start with `- `. The literal `must_not_include: ["- "]` matched the inline `-` separator that every item in the list uses. The judge's own notes call this a false positive and fail it anyway. This is a bug in the spec.                                        |
| `code-full-py-pipeline-dispatch`       | The gap is empty: the prefix ends after a complete line and the suffix begins with the next line. The raw output was `"\n"`, which post-processing turned into null. A blank fill is correct here. The harness cannot express "empty is acceptable", and AGENTS.md treats null as a fail. |
| `prose-journal-jnl-after-bold-heading` | "Finally checked out the new ramen place downtown that everyone's been talking about. " followed by "Sarah and I went for dinner." reads naturally. The same completion passed at 7 in the earlier run.                                                                                   |

## Examples (trimmed; synthetic scenarios only)

`⟦…⟧` marks the inserted completion.

**Tight-gap collision plus missing space**, `prose-full-api-pagination` (score 2):

```
…was one of those changes that⟦looked⟧ seemed simple on paper but turned into a three-month project.
```

**Suffix regurgitation hidden by post-processing**, `prose-long-prefix-narrative` (score 2). Raw model output:

```
 — so pale on such a fine morning.\n\nMargaret Ellerby had run the Thornfield post office for as long as anyone could remember. … (≈2,000 chars)
```

The suffix begins with ` so pale on such a fine morning.\n\nMargaret Ellerby had run the Thornfield post office…`. The model re-wrote the suffix from the cursor onward, and the final ghost text was ` —`.

**Over-generation / drift**, `prose-full-api-versioning` (score 1):

````
…can be reframed as additions if you think carefully⟦they are being rate-limited. 500 means the server screwed up. Do not use 200 for errors … ```json { "error": { "code": "VALIDATION_FAILED", … (≈1,300 chars)⟧ about deprecation timelines and migration paths.
````

**Journal structure**, `prose-journal-jnl-between-topics` (score 3). The file is reverse-chronological: the prefix entry is `02-07-26` and the next date in the suffix is `02-06-26`.

```
…Need more practice.\n\n---\n\n⟦02-08-26\n\n⟧**Reading — Designing Data-Intensive Applications**
```

**Boundary whitespace, false pass**, `prose-journal-full-mid-entry` (score 8):

```
**Lesson:** Flaky tests are almost never timing issues. They're usually bugs hiding behind⟦inadequate assertions or error handling that swallows evidence.⟧
```

This renders as `behindinadequate`. The judge quoted it with the space mentally inserted.

The regression-scenario prefixes were captured from real usage, so no text from them is reproduced here or in the JSON. Their judge reasons are paraphrased in the JSON.

## Boundary whitespace across runs

This is a mechanical check. A case is flagged when the prefix ends in `[A-Za-z0-9,;:.!?]` and the prose completion starts with `[A-Za-z0-9`]`. The three legitimate mid-word scenarios are excluded.

| Run                                 | Prose completions at a word boundary | Missing space |
| ----------------------------------- | ------------------------------------ | ------------- |
| 03-26 21:32 CLI sonnet (this run)   | 43                                   | 21            |
| 03-26 20:54 CLI sonnet              | 43                                   | 18            |
| 03-02 CLI haiku                     | 42                                   | 33            |
| 03-02 API anthropic-haiku (prefill) | 27                                   | 5             |
| 03-02 API xai-grok                  | 40                                   | 11            |
| 03-02 API gpt-4.1-nano              | 44                                   | 44            |

- **This is model-side, not pipeline-side.** In the raw responses the space is missing inside the `<COMPLETION>` tags. Tag extraction and `post-process.ts` keep leading whitespace. `completion-provider.ts` inserts the text verbatim at the cursor.
- **The prompt gives no cue.** It shows the cursor as `that{{FILL_HERE}} seemed` and does not say whether a leading space is needed.
- **It is stochastic.** The same scenario sometimes gets ` looked` (20:54 run) and sometimes `looked` (21:32 run).

## Proposed targeted evals

"Det." means the check can be deterministic code. "Judge" means it needs a narrow judge criterion.

| Class                          | Proposed eval                                                                                                                                                                                                                                                                                                                                                                                           | Type                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1 Boundary whitespace          | Fail if the prefix ends in a word or punctuation character and the completion starts with a word character, or if the completion ends with a word character and the suffix starts with one. Add a `mid_word: true` scenario flag to exempt the partial-word cases. Add it to `rapid-test.ts` `checkCompletion()` and as a Layer 1 auto-check. It can be re-run on every existing run folder at no cost. | Det.                   |
| 5 Suffix regurgitation         | Run on `raw-response.txt`, not `completion.txt`. Fail if a whitespace-normalized prefix of the suffix (≥ 30 chars) appears in the raw completion. Also flag when post-processing removes more than 50% of the raw length.                                                                                                                                                                               | Det.                   |
| 3 Tight-gap collision          | Add `expected_gap: { max_chars }` to bridge-style scenarios and enforce the length cap in code. Give the judge the rendered join (`…prefix tail⟦completion⟧suffix head…`) built by the harness, not three separate fields, with one question: "Is this joined sentence grammatical, with no duplicated word or meaning at either seam?"                                                                 | Det. cap + judge       |
| 2 Over-generation              | Per-scenario `max_completion_chars`, plus no new heading lines (`^#{1,6} `) or code fences unless expected. The existing `must_not_include: ["```"]` already caught `readme-full`.                                                                                                                                                                                                                      | Det.                   |
| 4 Journal structure            | Parse `MM-DD-YY` headings across prefix + completion + suffix. Fail on a duplicate date or a break in the file's existing order (ascending or descending).                                                                                                                                                                                                                                              | Det.                   |
| 6 Under-generation / empty gap | Record whitespace-only raw output separately from provider errors. Add `expect_empty_ok: true` for scenarios where no gap exists (`code-full-py-pipeline-dispatch`). Scenarios that need content fail on whitespace-only output.                                                                                                                                                                        | Det.                   |
| 7 Distant-suffix completion    | Fail if the completion's first line continues the last line of the suffix (normalized overlap or matching list-item shape) while the prefix's last line is not a list item. Narrow judge criterion: "Does the completion continue the text at the cursor, or text elsewhere in the document?"                                                                                                           | Det. heuristic + judge |

**Judge and harness fixes that follow from the false fails and flips:**

1. Tell the judge that suffix overlap has already been trimmed, and show it the rendered join.
2. Replace `must_not_include: ["- "]` in `list-marker-echo` with a `must_not_start_with` check.
3. Fix `prose-journal-jnl-mid-paragraph`, whose `quality_notes` says "No suffix" while a 1,999-char suffix is present.
4. Write the judge model and git commit into each `validation.md` / `layer2-summary.md`.
5. Take a majority of 2–3 judge samples for scores in the 3–7 band. Three byte-identical completions flipped verdicts between two same-day runs.

## Method notes

- A scenario counts as judge-failed if its `validation.md` JSON says `pass: false`. Five files needed a `\'` escape fix to parse. All 99 parsed.
- Categories come from the scenario source file (`scenarios.ts`, `scenarios/*.ts`, `regression-scenarios.ts`). They differ slightly from the category labels in the summary.
- Spot-checked passes: `jnl-new-date`, `jnl-full-window` (borderline: the judge ticked `appropriate_length: false` and still passed a 636-char two-paragraph entry), `full-mid-entry`, two prompt-writing scenarios, `assistant-mode-response`, `bridge-small-clause`, `short-prefix`, `instructional-recipe`, `mid-doc-tutorial-full`, `partial-word-newline-suffix`, `essay-presence`, `distant-suffix-completion`, and `mid-doc-blog-full`. Apart from the whitespace class, the only false pass found was `distant-suffix-completion`.
- The whitespace class is my judgment of how the inserted text renders. A reader who counts only what the judge could see should use the 86.9% figure.
