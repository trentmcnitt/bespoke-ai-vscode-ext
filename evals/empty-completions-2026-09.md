# Empty completions with `error: null` (2026-09)

The March 2026 Anthropic-API quality runs have 26–36 empty completions each, every one recorded with `error: null`. An empty result looks like "the model had nothing to say", but it can also be a request that never got an answer. This analysis sorts every such empty into one of four causes:

- **(a) model** — the model returned nothing usable: an immediate `</COMPLETION>`, whitespace, only the `{{FILL_HERE}}` placeholder, reasoning that never reached an answer, or only text that already sits after the cursor (which post-processing correctly trims away).
- **(b) pipeline dropped content** — the raw output held a real answer and extraction or post-processing lost it.
- **(c) swallowed failure** — the provider failed (HTTP 429/529, timeout) and the adapter returned null instead of throwing, so the runner saved it as an empty completion.
- **(d) harness artifact** — something about how the run was made, not about the model or the extension.

## Method

For every scenario whose `completion.txt` is null or whitespace:

1. **No `raw-response.txt`.** In the March code the raw output was logged only after the `if (!result.text) return null` check, so a missing raw file means the adapter returned no text at all: a swallowed 429/529, an abort, or a response with no text. No status code was recorded, so which of these it was is inferred, from three signals that agree on a swallowed 429/529 for every missing-raw case except those of the stop-sequence run (item 3):
   - **Prompt size, in all five runs.** They are the larger prompts: median context ~4,300 characters against a run median of 2,000–2,600. Rate limits on input tokens hit large prompts first. The 03-01 runs also had six API runs started within 20 s of each other at concurrency 10.
   - **Duration.** Successful requests took a median of 1.0–1.5 s (haiku) and 3.8 s (sonnet); the missing-raw cases took 3.7–12 s. That is consistent with the SDK retrying a 429/529 twice (`maxRetries: 2`, waiting for `retry-after`) before the adapter swallowed it. An offline check (below) confirms the three-requests-per-call shape; the 5–12 s magnitude depends on the `retry-after` values Anthropic sent, which were not recorded.
   - **Reproduction.** Run alone on current code, 30 of the 40 scenarios affected in March completed normally (below).
2. **Raw present.** It was replayed through the current extraction and post-processing (`replayPipeline`, the same code the replay set uses) and checked at each stage: extraction empty, extraction non-empty but post-processing trimmed everything (then: is what was extracted just the start of the suffix?), or the current code now produces text.
3. **The `2026-03-02T00-43-23` haiku run is different.** None of its 57 raw outputs contain `</COMPLETION>`. In the other haiku runs, including one started three minutes later, 60–71 of 65–75 do. The sent messages for all 87 scenarios are byte-identical to that later run's. The run was made with an uncommitted `</COMPLETION>` stop sequence (no commit ever added `stopSequences` to these presets), and the API does not return stop text. So an immediate close came back as empty text (no raw file, 420–650 ms), and `\n\n</COMPLETION>` came back as `\n\n`.

`regression-*` scenarios come from real use. They are counted here, never quoted.

## Classification per run

Counts are scenarios, with how many of them are `regression-*` in parentheses.

| Run (preset)                      | Scenarios | Empty | (a) model                                                            | (b) dropped | (c) swallowed failure | (d) harness                                            |
| --------------------------------- | --------: | ----: | -------------------------------------------------------------------- | ----------: | --------------------- | ------------------------------------------------------ |
| 03-01T22-26-45 `anthropic-haiku`  |        87 |    26 | 14: 11 immediate close (2), 3 suffix echo                            |           0 | 12, 5.0–8.6 s         | —                                                      |
| 03-01T22-26-49 `anthropic-sonnet` |        87 |    33 | 7 immediate close (1)                                                |           0 | 26 (4), 7.5–12.1 s    | —                                                      |
| 03-02T00-43-23 `anthropic-haiku`  |        87 |    36 | 17: 13 immediate close (3), 3 suffix echo, 1 placeholder only        |           0 | 19, 3.7–8.6 s         | the 13 immediate closes were hidden by a stop sequence |
| 03-02T00-46-35 `anthropic-haiku`  |        87 |    32 | 9: 6 immediate close (2), 3 suffix echo                              |       **1** | 22, 5.5–9.9 s         | —                                                      |
| 03-02T01-51-23 `anthropic-haiku`  |        97 |    34 | 10: 8 immediate close (2), 1 reasoning without answer, 1 suffix echo |           0 | 24 (2), 4.6–9.9 s     | —                                                      |

An earlier count for 03-01T22-26-45, "11 whitespace-only, 15 with no raw", differs here in two ways. The 11 are the immediate closes (raw `</COMPLETION>`, which is whitespace once the tag is removed). Of the 15, 12 have no raw file and are class (c); the other 3 do have raw output, and it is a suffix echo.

**The swallowed failures (presumed rate limits) skewed the March results.** 12–26 scenarios per Anthropic-API run were never measured, and they were mostly the large-context scenarios (`*-full`, `prose-bridge-large-*`, `prose-journal-jnl-*`). Those are the journal and full-window cases the testing philosophy ranks highest. In the March summaries they looked like empty completions from the model.

**The same class shows up in other March runs.** These were not broken down further:

- `03-01T20-13-58 xai-grok-code`: 11 empty, all exactly 30.0 s. The runner's 30 s `AbortSignal.timeout` fired, and the adapter returned an aborted null (c).
- The Ollama runs (`ollama-default` 7/87; `qwen3-4b` 87/87; `qwen3-8b` 86/87; `qwen35-9b` 96/97): no raw and `error: null` for almost every scenario. These are 30 s timeouts plus sub-30 s nulls, probably thinking models returning no answer text (these runs predate the native Ollama adapter, which sends `think: false`). They are mostly (c), and the extreme case of it. The `03-04 qwen35-9b` run threw its timeouts instead (56 with `error` set), so those were already visible.

### The one (b): a placeholder echo hid the real answer

`03-02T00-46-35` haiku, `code-js-arrow-function`. The prefix is `users.map(user => ` and the suffix is `);`. The raw output was:

```
{{FILL_HERE}}</COMPLETION>

<COMPLETION>user.name</COMPLETION>
```

Prefill extraction has a rule for the model closing immediately and then answering in a second block. The rule only fired when the first block was blank. `{{FILL_HERE}}` is not blank, so extraction returned it, `stripLeakedTags()` removed it, and `user.name` was lost. **Fixed in `ef272ad`.** "Blank" now ignores prompt scaffolding. This corrects the precondition of an existing rule and adds no new transformation. One replay-set case with the same raw output (`2026-03-01T22-26-45 haiku/code-js-arrow-function`) moves from `null` to `user.name` and carries a drift note.

### Fresh runs (2026-09-28, before this change)

| Run                        | Scenarios | Empty | Cause                                                                                                                     |
| -------------------------- | --------: | ----: | ------------------------------------------------------------------------------------------------------------------------- |
| `claude-code-sonnet` (CLI) |       106 |     2 | 1 suffix echo (a). 1 never sent (c/d): no `sent-message.txt` and no raw after 9.7 s, so the pool never handed out a slot. |
| `openai-gpt-4.1-nano`      |       104 |     3 | 3 suffix echo (a)                                                                                                         |
| `xai-grok`                 |       104 |     8 | 8 suffix echo (a)                                                                                                         |

## What the current code reports for each class

**Before this change**, the runner called `getCompletion()`, which returns only the text. The adapters already distinguished a swallowed 429/529 (`errorType`) and an abort (`aborted`), and the orchestrator already traced them as `error` / `aborted`. The runner threw that information away, so every class was saved as `error: null`. **Fixed in `5bbdd7b`.** The runner now calls `getCompletionWithDetail()` and uses the same `nullResultOutcome()` rule as the orchestrator. `metadata.json` and the summary rows carry `outcome`, `errorType`, the finish reason and token counts, and `summary.json` has `nullsByOutcome` / `nullsByErrorType`. A swallowed failure also sets `error`, so it fails Layer 1, and `rescore.ts` and judge sampling treat it as a provider error rather than an empty completion. This is a deliberate behaviour change: a 429 during `npm run test:quality` now fails that scenario's test, which stops the chained "run all tests" command. A rate-limited scenario is not a measurement, so it should not pass silently. A missing `raw-response.txt` still means the adapter returned no text, but `metadata.json` now says why (`outcome`, `errorType`, finish reason), and on the API path `metadata.extracted` holds the extraction result, so a reply that post-processing trimmed to nothing is visible without a replay.

**Verified offline, end to end.** The real Anthropic SDK, `AnthropicAdapter`, `ApiCompletionProvider` and the runner's attribution were run against a local server that returns each case. No real API calls.

| Server behaviour                                | HTTP requests | Trace outcome / runner record                               |
| ----------------------------------------------- | ------------: | ----------------------------------------------------------- |
| `\n\n</COMPLETION>` (immediate close)           |             1 | `empty`, `error: null`, finish `end_turn`, raw kept         |
| no content blocks / empty text on stop sequence |             1 | `empty`, `error: null`, finish `end_turn` / `stop_sequence` |
| 429 with `retry-after`                          |         **3** | `error`, `errorType: 429`, `error` set                      |
| 429 `x-should-retry: false`                     |             1 | `error`, `errorType: 429`                                   |
| 529                                             |             1 | `error`, `errorType: 529`                                   |
| 500                                             |             1 | thrown → `error`, `errorType: 500`                          |
| no response before the timeout                  |             1 | `aborted`, `error` set                                      |

The 429-with-`retry-after` row shows the shape behind the March class (c) durations: one call to the provider is three HTTP requests, with the SDK waiting between them.

**Two more nulls were reported as `empty` when nothing had been sent.** Both are on the code-override path, which the orchestrator's `isAvailable()` check does not cover. A call blocked by the open circuit breaker now reports `circuit_open` (`5bbdd7b`), and an override preset id that does not resolve now reports `backend_unavailable` (`e0ac3ac`). The second was found while setting up the offline run above: the provider returned a bare null.

### Reproduction on current code

The full runner was run with `anthropic-haiku` on the 52 scenarios that were empty in any March haiku run (4 of them `regression-*`), at the runner's concurrency of 10 and with no other runs in parallel. That is 52 API calls.

| Outcome                       | Count | Detail                                                                                                       |
| ----------------------------- | ----: | ------------------------------------------------------------------------------------------------------------ |
| `ok`                          |    38 | 30 of the 40 scenarios that were class (c) in some March run now complete                                    |
| `empty`, immediate close      |     7 | finish `end_turn`, 7–8 output tokens, raw `</COMPLETION>` or whitespace + `</COMPLETION>` (2 `regression-*`) |
| `empty`, suffix echo          |     5 | two of them came after a reasoning detour and a second block, and one after an echoed `{{FILL_HERE}}`        |
| `empty`, reasoning, no answer |     2 | finish `max_tokens`: "Wait, let me reconsider…" used the 200-token budget before a second block closed       |
| `error` / `aborted`           |     0 | no rate limiting this time                                                                                   |

Every empty now carries `outcome: empty` with a finish reason, token counts, the raw output and the extraction result. That separates "closed immediately" (`end_turn`, ~8 tokens), "echoed the suffix" (`extracted` equals the start of the suffix) and "ran out of budget reasoning" (`max_tokens`) without replaying anything. None of the 14 is a pipeline loss.

## What remains (findings, not fixed)

1. **Haiku reasons out loud about the whitespace cue.** 16 of the 52 raw outputs contain a "Wait, let me reconsider…" detour, and 10 of those quote the per-request whitespace cue added in `6c171f4` ("The instruction says there is no space between…"). Most recover in a second `<COMPLETION>` block. Two used up the 200-token `maxTokens` before closing a second block, and two recovered only to echo the suffix. The same detour appeared in March before the cue existed (6–7 per run on this scenario set in three of the four haiku runs), so the cue gives it a topic rather than creating it; whether it is now more frequent is not established by one run. Changing the cue is a prompt change and needs the reference-model protocol. The [whitespace-fix eval](2026-09-28-whitespace-fix.md) also shows empties rising slightly after the fix (sonnet 0→2, grok 5→7, nano 1→3). In those after-runs 12 of the 13 are suffix echoes and the other is the CLI slot case below.
2. **A retry block cut off by `max_tokens` is discarded.** In `code-ts-partial-word`, the second block held a real (truncated) answer with no closing tag. Extraction requires a closed second block, so nothing was shown. Using an unclosed retry would be a new behaviour (showing truncated code), not a bug fix, so it was left alone.
3. **The CLI path labels a pool kill as `aborted`.** When warmup fails, `killAllSlots()` resolves the waiting request with null, and it is traced as `aborted`, the same as being superseded by a newer keystroke. The 09-28 CLI sonnet "never sent" empty is probably this. The runner now records it as `aborted` with `error` set, so it is visible, but the type does not say "warmup failed".
4. **The CLI subprocess saw an unrelated system instruction.** One 09-28 CLI sonnet raw output starts with "This is a plain document-fill task, not a request to create a Claude Doc". The spawned Claude Code session appears to inherit connector instructions from the host's configuration. That is a test-harness (and possibly user-environment) contamination risk, seen once.
5. **A genuinely empty reply counts toward the circuit breaker.** `ApiCompletionProvider` calls `recordFailure()` whenever the adapter returns no text and the request was not aborted. That includes a healthy `end_turn` with an empty or stop-sequence-cut body. Five of those in a row would open the breaker for 30 s. This did not happen in these runs (the runner uses a fresh provider per scenario).
6. **The replay-set builder no longer runs.** `build-replay-set.ts` stops with "must-include case missing: …2026-03-26T21-32-33-claude-code-sonnet/code-java-mid-file". That case now drifts because of the bracket guard (`5e2a20e`), and the builder refuses drift in current-era runs. The fixture has been hand-maintained since then, and that is how this change updated it too.
