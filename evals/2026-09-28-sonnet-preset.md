# The `anthropic-sonnet` preset: broken, fixed, sampled (2026-09-28)

**Finding: every request from the `anthropic-sonnet` preset (`claude-sonnet-5`) was rejected with HTTP 400 from the day the preset moved to Sonnet 5 (`c3234bc`, 2026-07-02, first released in 0.8.8).** Sonnet 5 rejects `temperature` and an assistant prefill, and the preset sent both.

**Fix (`3fe6e2a`, `ac1cf3f`): Claude-model presets now take their request shape from a capability table.** On Sonnet 5 the preset sends no `temperature`, no assistant message (it uses `tag-extraction`, the CLI backend's strategy), and `thinking: {type: "disabled"}`. Haiku 4.5 is unchanged.

**Measured on a sample, not the full suite:** 51 of the 106 quality scenarios, one sample each, Layer 2 judged. Judge pass 44/51 (86%). No glued words and no double spaces at the seam. The whitespace harness found 3 "glued" results out of 128 boundary samples, all on one scenario and all the same misreading (below).

## What was broken

A 3-scenario Layer 1 pilot (`prose-journal-jnl-mid-paragraph`, `code-ts-function-body`, `prose-prompt-instructions-mid`) returned 0/3 completions, all `outcome: error`, `errorType: 400`:

```
400 {"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}
(request ids req_011CfV3RZ9eehhEgNV5yu1XB, req_011CfV3RZyktXHCCZRZzj97o, req_011CfV3RaeSSHiQCXQFaMVtU)
```

A direct probe without `temperature` then showed the second cause:

| Request to `claude-sonnet-5` (no `temperature`)  | Result                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| user message + assistant prefill `<COMPLETION>…` | 400 `This model does not support assistant message prefill. The conversation must end with a user message.` |
| user message only                                | 200                                                                                                         |

## The fix

`src/providers/api/model-capabilities.ts` holds a small table keyed by normalised model id (`anthropic/claude-opus-4.6` → `claude-opus-4-6`), with the sources cited in the file: the [Sonnet 5 migration guide](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide) and the per-model tables in the Claude API skill.

| Model ids                                              | Prefill | `temperature` | Thinking when the field is omitted                      |
| ------------------------------------------------------ | ------- | ------------- | ------------------------------------------------------- |
| `claude-sonnet-5`, `claude-opus-5`                     | 400     | 400           | adaptive, on; `disabled` accepted → **sent**            |
| `claude-opus-5-5`, `claude-fable-*`, `claude-mythos-*` | 400     | 400           | always on; `disabled` rejected → not sent (not handled) |
| `claude-opus-4-7`, `claude-opus-4-8`                   | 400     | 400           | off → not sent                                          |
| `claude-opus-4-6`, `claude-sonnet-4-6`                 | 400     | allowed       | off → not sent                                          |
| anything else (Haiku 4.5, 4.5 and older, unknown)      | allowed | allowed       | unchanged                                               |

`withAnthropicCapabilities()` (`presets.ts`) applies it to every preset whose model is Claude — built-in and custom, `provider: anthropic` or OpenRouter `anthropic/…`. No prefill → `tag-extraction` and `features.prefill: false` (which also turns prefix-overlap trimming back on, as on the CLI). No sampling → `features.sampling: false`, and the Anthropic and OpenAI-compat adapters leave the `temperature` key out. `features.disableThinking` is set only for the direct API; OpenRouter uses its own `reasoning` field (via `extraBody`), and whether OpenRouter's Sonnet 5 thinks by default was not tested.

**Why tag extraction was expected to hold the leading space.** The earlier worry came from variant P1 in [2026-09-28-reasoning-leakage.md](2026-09-28-reasoning-leakage.md), where removing the prefill anchor glued words 24/28. P1 was haiku with `<COMPLETION>` still prefilled, just without the anchor text — a different setup. The setup used here (no prefill at all, the same `SYSTEM_PROMPT` and per-request whitespace cue) is the CLI backend's, which measured 0/132 glued on CLI sonnet and 0/87 on CLI haiku after `6c171f4` ([2026-09-28-whitespace-fix.md](2026-09-28-whitespace-fix.md)). The results below confirm it for Sonnet 5 over the API.

**The thinking fix came from the first sample.** With only `temperature` and the prefill fixed (`3fe6e2a`), the 51-scenario sample returned 3 empty completions, each with `finish_reason: max_tokens`, 200 output tokens, and no text: adaptive thinking, on by default on Sonnet 5, used up the preset's 200-token cap. Several other scenarios spent 100+ output tokens on 30–80 characters of text. `ac1cf3f` sends `thinking: {type: "disabled"}`; the same three scenarios then returned text (`end_turn`, 24–150 output tokens), and the rerun below is on that code.

## Sample results

Run `quality-2026-09-28T02-36-58-api-anthropic-sonnet`, code `ac1cf3f` (`gitDirty` only from the untracked `node_modules` symlink in the worktree), rubric sha256 `ca48268ed2b1`. 51 scenarios chosen deterministically: every k-th id within each scenario group (k = 1 for prompt writing, 2 for edge cases, journal, mid-document, bridging, code mid-file, full-window, custom instructions and regression, 3 for standard prose and code; the two reuse scenarios were left out). The same set ran before and after the thinking fix.

| Metric                                                      | `3fe6e2a` (thinking on)          | `ac1cf3f` (thinking off)      |
| ----------------------------------------------------------- | -------------------------------- | ----------------------------- |
| HTTP errors                                                 | 0/51                             | 0/51                          |
| Empty completions                                           | 3/51 (all `max_tokens`, no text) | 2/51                          |
| `finish_reason: max_tokens`                                 | 6                                | 1                             |
| `boundary-whitespace` (glued at a word boundary)            | 0/27                             | **0/29**                      |
| `double-space`                                              | 0/29                             | **0/31**                      |
| `suffix-echo`                                               | 0/26                             | 2/29                          |
| `journal-date`                                              | 0/4                              | 1/5                           |
| Text after the first `</COMPLETION>` (the "Wait, …" detour) | 0/48                             | 1/51                          |
| Output tokens (total)                                       | 4,575                            | 3,576                         |
| Latency median / p90                                        | 1.88 s / 3.12 s                  | 1.86 s / 2.68 s               |
| Judge pass (Layer 2)                                        | not judged                       | **44/51 (86%)**, accept 43/51 |

Judged by four `claude-opus-5-5` agents following `validator-prompt.md`, one verdict per scenario (`judge_model` recorded in every `validation.md`, `judge` set in `summary.json`). Scenario groups differ in size, so the pass rate is for this sample, not an estimate for the full suite; CLI sonnet's last full run was 91/106 (86%) on a different judge run.

**The 7 failures:**

- `code-mid-file-ts-handler-full`: a long handler body cut off by `max_tokens` (200) mid-expression. The only `max_tokens` finish in the run.
- `prose-full-api-pagination`: the model copied the suffix's opening words, closed the block, wrote "Wait, I need to check the text after the marker…", and opened a second block it never closed. Overlap trimming removed the copy, leaving nothing. The known suffix-regurgitation limitation.
- `prose-full-api-rest-graphql`: the completion ends by restating the suffix's first words (suffix echo, trimmed by post-processing) after inventing a new bold paragraph lead-in.
- `prose-full-essay-presence`: doubled word at the suffix seam ("quietly alert alert."). The deterministic `suffix-echo` check did not catch it.
- `prose-journal-jnl-between-topics`: inserted a new date line inside an existing entry (`journal-date`).
- `prose-mid-doc-readme-full`: added a fenced Python block, which the scenario forbids, and ran long.
- One regression scenario (content is private): judged as restating the prefix.

`code-full-py-pipeline-dispatch` returned an empty completion and passed: the scenario sets `expect_empty_ok` because the suffix already holds the next line.

**Commands.** One live `ApiCommandProvider.sendPrompt` call on the preset (commit message for a one-line diff) returned `end_turn` with a sensible message, so commit messages and Suggest Edits, which share the adapter, no longer 400 either.

## Whitespace harness

The targeted harness from [2026-09-28-whitespace-fix.md](2026-09-28-whitespace-fix.md) (same scenario selection: 44 word-boundary prose cases, 3 mid-word, 17 already-spaced; code controls off), `anthropic-sonnet` at `ac1cf3f`, 3 samples each, 192 calls:

| Check                                      | Result         |
| ------------------------------------------ | -------------- |
| Starts a word at a word boundary ("glued") | 3/128 (4 null) |
| Leading space on a mid-word completion     | 0/9            |
| Double space after a typed space           | 0/51           |
| Text after the first `</COMPLETION>`       | 4/192          |

All 3 "glued" results are one scenario, `prose-mid-doc-boundary-suffix`, whose prefix ends `…will require`. Sonnet 5 read `require` as unfinished and continued `d to use …` all three times, giving "will required to use". That is a wrong mid-word judgement, not a missing space; the harness counts any word-start at a boundary as glued. The 4 nulls are suffix regurgitation trimmed to nothing (`prose-full-essay-parallels` 3/3, `prose-full-api-pagination` 1/3), the same known limitation.

## Not fixed

- **Opus 5.5 and Fable/Mythos cannot turn thinking off.** A custom preset on those models may still spend its 200 tokens thinking and return nothing. Not measured.
- **OpenRouter `anthropic/claude-sonnet-5`** gets no prefill and no `temperature`, but no `thinking` field. Not measured.
- **`maxTokens` stays 200.** One long code completion was cut off. The trade-off is the one described in the reasoning-leakage doc.

## Cost

Sonnet 5 at $2 / $10 per MTok in / out, cache reads $0.20, cache writes $2.50. System prompt ≈1,811 tokens, cached after the first call.

| Step                     | Calls | Cost (from reported usage)                                                            |
| ------------------------ | ----- | ------------------------------------------------------------------------------------- |
| Pilot (3 scenarios)      | 3     | ≈ $0.011                                                                              |
| Sample at `3fe6e2a`      | 51    | ≈ $0.152                                                                              |
| Recheck of the 3 empties | 3     | ≈ $0.016                                                                              |
| Sample at `ac1cf3f`      | 51    | ≈ $0.147                                                                              |
| Whitespace harness       | 192   | ≈ $0.55 (estimated: the harness does not record usage; per-call cost from the sample) |
| **Total**                | 300   | **≈ $0.88**                                                                           |

About $0.003 per completion. The run folders and harness results are not committed (they contain full prompts, including private regression scenarios).
