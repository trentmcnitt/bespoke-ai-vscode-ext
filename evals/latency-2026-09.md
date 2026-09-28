# Completion latency from the usage ledger, 2026-05 to 2026-09

These are p50/p90/p95 latencies for inline completions, taken from Trent's real usage ledger (`~/.bespokeai/usage-ledger.jsonl` plus the two rotated archives, 7,743 lines). The report covers every backend and model that appears in it. It was produced by `npm run latency-report` (`src/scripts/latency-report.ts`, logic in `src/utils/latency-stats.ts`). The ledger holds no prompt or completion text. The report also leaves out the ledger's `project` field.

## What is measured

The number is **backend request→response time**: how long the backend took to answer one completion request. It is **not** keystroke-to-ghost-text latency. The full path a user feels is:

```
keystroke → debounce → [slot wait] → backend request→response → post-process/cache → VS Code renders ghost text
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^ this report
```

- **Debounce happens before, and is not included.** From `TRIGGER_PRESET_DEFAULTS` in `src/types.ts`: `relaxed` = 2000 ms (the default), `eager` = 800 ms, `on-demand` = 0 ms (Alt+Enter). An explicit Alt+Enter invoke skips debounce under any preset. Add the debounce for your preset to get time-since-last-keystroke.
- **Pool slot wait (`waitMs`) is not included.** It is reported separately below.
- **Also not included:** the pool client→server IPC hop (for non-leader windows), post-processing, and VS Code's render.

What `durationMs` means depends on the backend:

| Backend                        | `durationMs` in the ledger                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code CLI (subscription) | `duration_ms` from the Claude Agent SDK's `result` message for that turn (`ClaudeCodeProvider.getCompletion`, `SlotPool.extractMetadata`). The CLI process reports it, measuring from message received to result emitted. This is SDK-reported, not extension wall clock. |
| API (any provider)             | Adapter wall clock (`Date.now()`) around the HTTP call (`adapters/anthropic.ts`, `openai-compat.ts`, `ollama.ts`), recorded in `ApiCompletionProvider`.                                                                                                                   |

Percentiles use the nearest-rank method. Months are UTC calendar months.

## Results

**Date range:** 2026-05-14 → 2026-09-25 (UTC). **n = 5,743** completion requests, all from the Claude Code CLI backend.

### By backend and model

| Backend                        | Model                        |     n | p50 ms | p90 ms | p95 ms | Dates (UTC)             |
| ------------------------------ | ---------------------------- | ----: | -----: | -----: | -----: | ----------------------- |
| Claude Code CLI (subscription) | `claude-opus-4-5-20251101`   | 4,260 |  1,875 |  3,108 |  4,088 | 2026-05-14 → 2026-07-02 |
| Claude Code CLI (subscription) | `claude-opus-4-8`            | 1,132 |  2,573 |  4,751 |  6,123 | 2026-07-02 → 2026-07-23 |
| Claude Code CLI (subscription) | `claude-sonnet-5`            |   344 |  2,497 |  4,492 |  5,500 | 2026-07-02 → 2026-09-25 |
| Claude Code CLI (subscription) | `claude-sonnet-4-5-20250929` |   7\* |  2,004 |  5,500 |  5,500 | 2026-06-04 → 2026-06-13 |

\* n < 20. The p90/p95 values rest on one or two samples and are not meaningful.

**API backend (Anthropic / OpenAI / xAI / Gemini / OpenRouter): no rows.** **Ollama: no rows.** Trent used only the subscription CLI backend in this period. The script groups those backends automatically when their rows exist.

### By month

The model mix changed over the period. Opus 4.5 ran until early July, Opus 4.8 ran during July, and Sonnet 5 has run from July on.

| Month (UTC) | Model                        |     n | p50 ms | p90 ms | p95 ms |
| ----------- | ---------------------------- | ----: | -----: | -----: | -----: |
| 2026-05     | `claude-opus-4-5-20251101`   |   802 |  2,168 |  3,211 |  4,165 |
| 2026-06     | `claude-opus-4-5-20251101`   | 3,086 |  1,808 |  3,108 |  4,112 |
| 2026-06     | `claude-sonnet-4-5-20250929` |   7\* |  2,004 |  5,500 |  5,500 |
| 2026-07     | `claude-opus-4-8`            | 1,132 |  2,573 |  4,751 |  6,123 |
| 2026-07     | `claude-opus-4-5-20251101`   |   372 |  1,683 |  2,832 |  3,330 |
| 2026-07     | `claude-sonnet-5`            |   221 |  2,604 |  4,590 |  5,733 |
| 2026-08     | `claude-sonnet-5`            |   112 |  2,387 |  4,082 |  5,259 |
| 2026-09     | `claude-sonnet-5`            |  11\* |  2,625 |  4,628 |  4,798 |

All rows are Claude Code CLI.

### Pool slot wait (`waitMs`, CLI only)

`waitMs` first shows up in the ledger on 2026-09-14. From then on there are n = 7 completions. Three of them recorded a 1 ms wait, and four recorded none, which means 0 ms (see caveats). So p50 = 0 ms and p95 = max = 1 ms. The sample is tiny. It shows only that in these seven requests the pool never made a request wait for a slot. It does not show that this never happens.

### Excluded rows

| Reason                                                                                    |  Rows |
| ----------------------------------------------------------------------------------------- | ----: |
| Not a completion (`warmup` 1,001, `startup` 971, commit-message / suggest-edit 17)        | 1,989 |
| `model: "<synthetic>"` (SDK-generated message, not a model response)                      |     6 |
| CLI row without SDK metadata (wall-clock fallback of 1–6 ms for a null or aborted result) |     5 |

Total: 5,743 + 2,000 = 7,743 lines. No line was corrupt.

## Caveats

1. **CLI latency is what the SDK reports, not the extension's wall clock.** `durationMs` is the SDK's own per-turn `duration_ms`. The ledger falls back to extension wall clock only when SDK metadata is missing, and those 5 rows are excluded. The SDK number does not include the time for the result to travel back through the stream consumer to the provider. That gap should be small, but the ledger does not measure it.
2. **`durationApiMs` is not used.** On the CLI backend it is **cumulative per SDK session**: it rose monotonically in all 741 multi-row sessions, the same way `costUsd` / `total_cost_usd` does. One fix would be to take differences between consecutive rows within a session. That fails too: in 13.5% of rows the difference is more than 1.5× that turn's `durationMs`. The counter also absorbs turns that never get a ledger row (probably superseded latest-request-wins requests that the CLI still ran). So there is no reliable per-request API-time figure for the CLI backend.
3. **How the backend was inferred.** No row in this ledger has a `backend` field. The API providers have written `backend: 'api'` since the API backend was added (Feb 2026, before this data starts). The CLI path has never written the field. So a missing `backend` means CLI, and every model is a Claude model, which fits. The ledger does not record the API provider. The script infers Ollama only from a `name:tag` model id (a `:` and no `/`). Other API providers are listed by model id.
4. **`waitMs` is written only when it is > 0.** It was added in `5f5819a` (2026-07-21). A missing value therefore means either 0 or a build that predates the field. The installed build's date is unknown, so the wait stats start from the first row that has the field (2026-09-14) and count missing values as 0.
5. **Model aliases.** `claude-code.model` is set to an alias (`opus` / `sonnet`). The ledger records the model the SDK actually reported, so an alias moving to a new model shows up as a model change, not a settings change.
6. **Selection effects.** Only requests that reached the backend and returned are recorded. Cache hits (no backend call), requests cancelled during debounce, and requests superseded while waiting for a slot are not in the ledger. The distribution describes real backend calls, not every trigger.

Going forward, the per-request trace records in `src/utils/trace.ts` record the full path for each completion. They capture `receivedAtMs` (request entered the orchestrator, before debounce), `debounceMs`, `waitMs`, and `startTimeMs` → `endTimeMs` (request sent to the backend → post-processed ghost text returned to VS Code, before render). That makes request→ghost-text latency measurable directly, not just backend time.

## Reproduce

```bash
npm run latency-report                              # reads ~/.bespokeai/usage-ledger*.jsonl (read-only)
npm run latency-report -- path/to/ledger.jsonl ...  # explicit files
```
