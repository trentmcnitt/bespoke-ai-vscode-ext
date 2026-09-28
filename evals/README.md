# Evals

How completion quality is measured in this repo, and what the measurements found. Everything here is derived from real model outputs; the raw run folders (full prompts and completions) stay out of git, and the committed files carry the numbers, method, and provenance.

## The loop

1. **Generate** (`npm run test:quality`). ~105 scenarios — journal entries, prompts to Claude, mid-document edits, bridging gaps, code in several languages, custom instructions, and regression cases captured from real use — are run through the production prompt and extraction code at realistic context sizes. Each scenario folder gets the raw model output, the final ghost text, and `rendered.txt`: the text exactly as the user would see it, with the completion marked.
2. **Check deterministically.** Six code checks run on every scenario ([`deterministic-checks.ts`](../src/test/quality/deterministic-checks.ts)): missing space at a word boundary, the model copying the text after the cursor, journal date order, length caps, empty output, and forbidden openings. Each check exists because a real failure was found by reading outputs.
3. **Judge.** An LLM judge scores each scenario against [`validator-prompt.md`](../src/test/quality/validator-prompt.md). A failed deterministic check fails the scenario. Each run records the commit, the rubric hash, and the judge model.
4. **Read the failures.** Error analysis by hand, then new checks or scenarios for any new failure class.

## What it found

| Date       | Document                                                             | Finding                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-27 | [error-analysis-2026-03-sonnet.md](error-analysis-2026-03-sonnet.md) | Reading all 99 outputs of the last full run by hand: the judge said 82.8%, the analyst 70.7%. The judge disagreed with the analyst on 20 of 99, passed 15 completions that glued words together, and gave opposite verdicts to byte-identical completions on the same day.                                     |
| 2026-09-27 | [rescore-existing-runs.md](rescore-existing-runs.md)                 | The deterministic checks applied to 48 earlier runs. Judge-only vs judge-and-checks: CLI sonnet 82.8% → 67.7%, CLI haiku 91.0% → 64.0%, gpt-4.1-nano 63.2% → 26.4%, CLI opus 88.2% → 88.2%.                                                                                                                    |
| 2026-09-28 | [2026-09-28-whitespace-fix.md](2026-09-28-whitespace-fix.md)         | The prompt fix for the missing space, same scenarios and judge before and after: CLI sonnet 66.0% → 85.8%, xai-grok 44.2% → 78.8%, gpt-4.1-nano 32.7% → 29.8% (no effect). A separate prefill extraction bug doubled whitespace on the Anthropic API path; fixing it took doubled blank lines from 100% to 0%. |
| 2026-09-28 | [latency-2026-09.md](latency-2026-09.md)                             | Backend response time from the local usage ledger (5,743 real completions, Claude Code backend): p50 1.9–2.6 s, p95 4.1–6.1 s depending on model. This is request-to-response time, reported separately from the deliberate debounce.                                                                          |

## What is not established yet

- **Whether the judge agrees with a human.** [`judge-validation/`](judge-validation/) holds 100 blind samples (40 dev, 60 held-out) and a labelling page. Until they are labelled, judge pass rates are the judge's opinion, useful for before/after comparisons on the same set and not as absolute quality numbers.
- **Acceptance in real use.** Nothing measures how often ghost text is accepted and kept in the editor. That would need user telemetry, which this extension deliberately does not collect.

## Also here

- [`replay/`](replay/) — 52 recorded model outputs replayed through the current extraction and post-processing in CI, so client-side changes show up as fixture diffs without calling a model.
- [`data/`](data/) — per-scenario records behind the March analysis (no prompt text).
