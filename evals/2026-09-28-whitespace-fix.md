# Word-boundary whitespace: before and after (2026-09-28)

The [March error analysis](error-analysis-2026-03-sonnet.md) found that the most common real failure was a missing leading space where the completion meets the text before the cursor (`hiding behind` + `inadequate` → `behindinadequate`). The raw model output was already missing the space, so this was model behaviour, not a pipeline bug. The LLM judge had passed 15 of those 17 cases.

Two fixes followed:

1. **Prompt (`6c171f4`).** The prompt never told the model that its output is inserted verbatim, and every prose example had a space before the `{{FILL_HERE}}` marker, which taught the model never to lead with one. The fix adds that rule, rewrites two examples so the marker sits flush against the text, adds one mid-word example, and adds a per-request cue naming the last word when there is no space before the cursor. No post-processing was added.
2. **Prefill extraction (`16a90c9`).** A separate, code-level bug on the Anthropic API path: the assistant prefill must not end in whitespace, so the anchor is trimmed; the model re-emits the trimmed whitespace, which is already in the document, so the ghost text doubled it. Extraction now drops exactly the leading output that reproduces what was trimmed.

## Full quality suite, same day, same judge

Each run is the full scenario set (104–106 scenarios), generated once with the old prompt and once with the new one. Every run was judged by its own `claude-opus-5-5` agent, following [`validator-prompt.md`](../src/test/quality/validator-prompt.md) (sha256 `ca48268ed2b1`), without seeing the other runs or knowing which prompt produced it. The judge reads the rendered join (`…prefix⟦completion⟧suffix…`) and the deterministic check results, and any failed deterministic check fails the scenario.

| Model                  | Judge pass, before | Judge pass, after  | Missing space at a word boundary (before → after) | Suffix echo (before → after) | Empty (before → after) |
| ---------------------- | ------------------ | ------------------ | ------------------------------------------------- | ---------------------------- | ---------------------- |
| Claude Code CLI sonnet | 70/106 (66.0%)     | **91/106 (85.8%)** | 27/65 → **0/63**                                  | 1 → 2                        | 0 → 2                  |
| xAI `xai-grok`         | 46/104 (44.2%)     | **82/104 (78.8%)** | 36/59 → **1/56**                                  | 7 → 9                        | 5 → 7                  |
| OpenAI `gpt-4.1-nano`  | 34/104 (32.7%)     | 31/104 (29.8%)     | 44/63 → 43/61                                     | 2 → 4                        | 1 → 3                  |

"Missing space" counts are `failed/applied` for the `boundary-ws` check, which applies to prose completions whose prefix ends in a word or punctuation character with no trailing whitespace.

**gpt-4.1-nano did not respond to the fix.** Five prompt variants were tried — the rule alone, flush examples, a generic cue, the last-word cue, and a literal "start with `<COMPLETION> `" instruction — and nano emitted a leading space about 3% of the time in all of them. Its score change is within run-to-run noise.

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
- **The judge found a post-processing bug unrelated to this fix**: in code, the suffix-overlap trim sometimes removes a closing brace the suffix does not actually supply. It appears in all three models' runs, before and after. Being investigated separately.
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
