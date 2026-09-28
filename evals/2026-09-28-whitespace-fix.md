# Word-boundary whitespace: before and after (2026-09-28)

The [March error analysis](error-analysis-2026-03-sonnet.md) found that the most common real failure was a missing leading space where the completion meets the text before the cursor (`hiding behind` + `inadequate` → `behindinadequate`). The raw model output was already missing the space, so this was model behaviour, not a pipeline bug. The LLM judge had passed 15 of those 17 cases.

**Likely origin.** Every Feb 11–12 quality run (21 runs, all CLI opus) used the older prompt protocol: the cursor was marked `>>>CURSOR<<<`, the prompt gave the last few characters before the cursor in a `<completion_start>` block, and the model began its `<output>` by repeating them. The extension then stripped that echo, so the whitespace at the seam came from the document, not from the model. None of those runs has a single `boundary-ws` failure (see the [rescore table](rescore-existing-runs.md#table)). Commit `da68e0f` (Feb 11 21:09 CST, i.e. 03:09 UTC Feb 12, after the last of those runs; run folder names are UTC) replaced that protocol with the `{{FILL_HERE}}` marker and `<COMPLETION>` tags, and removed the echo stripping and its lenient whitespace matching. From then on the model had to produce the leading space itself. Every judged run after it has the defect at a high rate: CLI haiku 28/60 on 02-28, 25/60 on 03-01, CLI sonnet 18/61 and 21/61 on 03-26. The comparison is confounded, because the model also changed (opus before, haiku and sonnet after). The judge passed most of these cases, so the defect sat through about six weeks of judged runs (02-28 to 03-26) and was only found on 2026-09-27, by the mechanical check described in the error analysis.

Two fixes followed:

1. **Prompt (`6c171f4`).** The prompt never told the model that its output is inserted verbatim, and every prose example had a space before the `{{FILL_HERE}}` marker, which taught the model never to lead with one. The fix adds that rule, rewrites two examples so the marker sits flush against the text, adds one mid-word example, and adds a per-request cue naming the last word when there is no space before the cursor. No post-processing was added.
2. **Prefill extraction (`16a90c9`).** A separate, code-level bug on the Anthropic API path: the assistant prefill must not end in whitespace, so the anchor is trimmed; the model re-emits the trimmed whitespace, which is already in the document, so the ghost text doubled it. Extraction now drops exactly the leading output that reproduces what was trimmed.

## Full quality suite, same day, same judge

Each run is the full scenario set (104–106 scenarios), generated once with the old prompt and once with the new one. Every run was judged by its own `claude-opus-5-5` agent (the same model family as the Claude generators), one judge sample per scenario, following [`validator-prompt.md`](../src/test/quality/validator-prompt.md) (sha256 `ca48268ed2b1`). Each judge was run separately and was not shown the other runs or told which prompt produced its run. The run folders do contain the sent messages, though, and the "after" messages include the new last-word cue, so a judge could in principle infer which prompt it was looking at. The judge reads the rendered join (`…prefix⟦completion⟧suffix…`) and the deterministic check results, and any failed deterministic check fails the scenario.

The direct measure of the fix is the `boundary-ws` column: missing spaces went from 27 to 0 (sonnet) and 36 to 1 (grok). The judge pass rate moved mostly because of that column, since the rubric fails every scenario whose deterministic check fails. The second table separates the two.

| Model                  | Judge pass, before | Judge pass, after | Missing space at a word boundary (before → after) | Suffix echo (before → after) | Empty (before → after) |
| ---------------------- | ------------------ | ----------------- | ------------------------------------------------- | ---------------------------- | ---------------------- |
| Claude Code CLI sonnet | 70/106 (66.0%)     | 91/106 (85.8%)    | 27/65 → **0/63**                                  | 1 → 2                        | 0 → 2                  |
| xAI `xai-grok`         | 46/104 (44.2%)     | 82/104 (78.8%)    | 36/59 → **1/56**                                  | 7 → 9                        | 5 → 7                  |
| OpenAI `gpt-4.1-nano`  | 34/104 (32.7%)     | 31/104 (29.8%)    | 44/63 → 43/61                                     | 2 → 4                        | 1 → 3                  |

"Missing space" counts are `failed/applied` for the `boundary-ws` check, which applies to prose completions whose prefix ends in a word or punctuation character with no trailing whitespace.

**Judge pass inside and outside the scenarios the fix targets.** Per scenario, same scenarios before and after. "Targeted" means the `boundary-ws` check applied in either run; "not targeted" means it applied in neither. A judge-only failure is a scenario the judge failed while every deterministic check passed.

| Model        | Judge pass, targeted (before → after) | Judge pass, not targeted (before → after) | Judge-only failures (before → after) |
| ------------ | ------------------------------------- | ----------------------------------------- | ------------------------------------ |
| CLI sonnet   | 33/65 → 56/65                         | 37/41 → 35/41                             | 8 → 11                               |
| xai-grok     | 18/60 → 48/60                         | 28/44 → 34/44                             | 14 → 11                              |
| gpt-4.1-nano | 9/63 → 10/63                          | 25/41 → 21/41                             | not computed                         |

Sonnet's whole gain is inside the targeted subset; on the scenarios the fix does not target, its judge pass went slightly down (37 → 35) and its judge-only failures went up (8 → 11). Grok improved on both subsets. Differences of a few scenarios should not be read as real: each scenario was judged once, and the March analysis found the judge giving opposite verdicts to identical completions.

**gpt-4.1-nano did not respond to the fix.** Five prompt variants were tried — the rule alone, flush examples, a generic cue, the last-word cue, and a literal "start with `<COMPLETION> `" instruction — and nano emitted a leading space about 3% of the time in all of them. Its judge pass showed no meaningful change (34 → 31); run-to-run noise was not measured.

## Targeted harness (more samples, word-boundary scenarios only)

45 prose scenarios whose prefix ends in `[A-Za-z0-9,;:.!?]`, 2–3 samples each, plus mid-word and already-spaced controls.

| Model                         | Glued, before | Glued, after  |
| ----------------------------- | ------------- | ------------- |
| CLI sonnet (3×)               | 78/132 (59%)  | **0/132**     |
| CLI haiku (2×)                | 60/85 (71%)   | **0/87**      |
| xai-grok (3×)                 | 104/116 (90%) | **0/115**     |
| anthropic-haiku, prefill (2×) | 10/68 (15%)   | **0/79**      |
| gpt-4.1-nano (3×)             | 129/132 (98%) | 126/130 (97%) |

Controls: no leading space was added to any mid-word completion (`implementa` → `tion`), no double space when the prefix already ends in a space (27 runs, all models), and no leading space in code at positions such as `user.` or `os.path.`. The 30-second rapid test (tag and marker leaks, preamble, null, length) passed 7/7 for every model.

## Prefill extraction fix (anthropic-haiku)

87 scenarios × 4 samples = 348 calls per arm; A is the prompt fix with the old extraction, B adds `16a90c9`.

| Metric                                          | A (old extraction) | B (new extraction) |
| ----------------------------------------------- | ------------------ | ------------------ |
| Double space, prose (prefix ends in a space)    | 25/33 (76%)        | 4/32 (12%)         |
| Double space, code                              | 20/28 (71%)        | 4/28 (14%)         |
| Extra blank line after a paragraph break, prose | 19/19 (100%)       | 0/16               |
| Extra blank line after a paragraph break, code  | 24/24 (100%)       | 0/24               |
| Leading newline after a single `\n`, code       | 12/12 (100%)       | 0/12               |
| Glued words at a word boundary                  | 0/159              | 0/159              |
| Empty result                                    | 54/348 (16%)       | 59/348 (17%)       |

Applying B's rule to A's own outputs gives the same numbers, so the difference is the fix, not sampling noise. The remaining double spaces come from two scenarios where the model itself writes two or three spaces (after `4.` and in a JSDoc `*`); the fix removes only the whitespace that was trimmed from the anchor.

## What got worse, and what is still open

- **Grok regurgitates the suffix more often** (suffix echo 7 → 9, empties 5 → 7). Post-processing trims the copied suffix, which leaves an empty completion. `prose-full-essay-parallels` went from 0/3 to 3/3 empty in the targeted harness. Listed under Known issues in the README.
- **The judge found a post-processing bug unrelated to this fix**: in code, the suffix-overlap trim sometimes removed a closing bracket that closed a scope the completion itself opened. It appears in all three models' runs, before and after. Fixed in `5e2a20e` (the trim no longer removes a closer of the completion's own scope).
- **The judge still disagrees with itself.** The March analysis found byte-identical completions with opposite verdicts on the same day. Before any judge pass rate is claimed as accurate, the judge is being checked against human labels — see [`judge-validation/`](judge-validation/).

## Provenance

| Run                                                   | Prompt | Code                                                                                                                                                           | Judge           |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `quality-2026-09-28T00-46-47-claude-code-sonnet`      | before | source copy with `prompt-strategy.ts` and `post-process.ts` byte-identical to `6c171f4~1`; run with the older runner, so no provenance block in `summary.json` | claude-opus-5-5 |
| `quality-2026-09-28T00-46-04-api-xai-grok`            | before | source copy with `prompt-strategy.ts` and `post-process.ts` byte-identical to `6c171f4~1`; run with the older runner, so no provenance block in `summary.json` | claude-opus-5-5 |
| `quality-2026-09-28T00-46-25-api-openai-gpt-4.1-nano` | before | source copy with `prompt-strategy.ts` and `post-process.ts` byte-identical to `6c171f4~1`; run with the older runner, so no provenance block in `summary.json` | claude-opus-5-5 |
| `quality-2026-09-28T00-44-56-claude-code-sonnet`      | after  | `93fc1aa` + the uncommitted prompt diff later committed as `6c171f4` (`gitDirty: true`)                                                                        | claude-opus-5-5 |
| `quality-2026-09-28T00-45-01-api-openai-gpt-4.1-nano` | after  | same                                                                                                                                                           | claude-opus-5-5 |
| `quality-2026-09-28T00-45-02-api-xai-grok`            | after  | same                                                                                                                                                           | claude-opus-5-5 |

The run folders themselves are not committed (they contain full prompts); the per-run `summary.json` files record commit, rubric hash, and judge. One judge sample per scenario; no majority voting.

**What can and cannot be reproduced from the repo.** The "before" run folders, the targeted-harness script and the prefill A/B script are not in the repo: the run folders contain full prompts, and the two scripts were ad-hoc. The tables above are therefore reported results, not something a reader can regenerate from this checkout. The before/after split by targeted subset was computed per scenario from the six run folders listed above.
