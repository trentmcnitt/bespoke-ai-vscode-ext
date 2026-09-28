# The `anthropic-sonnet` preset does not run (2026-09-28)

**Finding: every request from the `anthropic-sonnet` preset (`claude-sonnet-5`) is rejected with HTTP 400, so the preset has never produced a completion since it moved to Sonnet 5 in `c3234bc` (2026-07-02).** The planned sampled quality run was stopped at the 3-scenario pilot. No fix was made: one of the two causes needs a prompt-strategy change that has to be measured first, and that is Trent's decision.

## What happened

A 3-scenario Layer 1 pilot (`prose-journal-jnl-mid-paragraph`, `code-ts-function-body`, `prose-prompt-instructions-mid`) with `TEST_BACKEND=api TEST_API_PRESET=anthropic-sonnet` returned 0/3 completions, all `outcome: error`, `errorType: 400`:

```
400 {"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}
(request ids req_011CfV3RZ9eehhEgNV5yu1XB, req_011CfV3RZyktXHCCZRZzj97o, req_011CfV3RaeSSHiQCXQFaMVtU)
```

A direct probe without `temperature` then showed the second cause:

| Request to `claude-sonnet-5` (no `temperature`)  | Result                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| user message + assistant prefill `<COMPLETION>…` | 400 `This model does not support assistant message prefill. The conversation must end with a user message.` |
| user message only                                | 200                                                                                                         |

Both match the Claude API documentation: on Sonnet 5, sampling parameters (`temperature`, `top_p`, `top_k`) are removed (as on Opus 4.7 and later), and assistant prefill is removed (as on the whole 4.6-and-later family).

## What a fix involves

1. **Drop `temperature` for this model.** Mechanical.
2. **Stop using `prefill-extraction` for it.** The preset would have to move to `tag-extraction` (the CLI's strategy) or `instruction-extraction`. That is not mechanical: on the prefill path, the anchor is what keeps haiku's leading space right, and removing it (variant P1 in [2026-09-28-reasoning-leakage.md](2026-09-28-reasoning-leakage.md)) glued words 24/28. Sonnet 5 without a prefill may behave differently, but it needs a quality run across the scenario set before it ships, and the README's Tested Models row should come from that run.

Doing only step 1 leaves the preset just as broken, so neither step was taken.

**Related, not fixed:** `presets.ts` gives every custom preset whose model is Anthropic (`provider: anthropic`, or OpenRouter `anthropic/…`) the prefill strategy. A custom preset pointing at a model without prefill support hits the same 400. The built-in `openrouter-haiku` is unaffected (Haiku 4.5 supports prefill). The prefill extraction fix in `80c4324` therefore applies only to Haiku 4.5 on the direct API and OpenRouter today.

## Provenance

- Code under test: `95ce9c0` (branch `showcase/followup-extract`). 2026-09-28 02:23 UTC.
- Cost: the three 400s are not billed; the probe's successful call used 15 input and 30 output tokens (under $0.001 at $2/$10 per MTok).
- The pilot's run folder was deleted (no completions, only error records).
