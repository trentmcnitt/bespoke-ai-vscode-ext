# Haiku's "Wait, let me reconsider…" detour (2026-09-28)

**Decision: no prompt change.** None of the 14 variants tested against the current prompt reduced the detour without making something the user sees worse. The detour is mostly a prefill-path behaviour, and at some cursor positions it is how the model recovers from the prefill. The variants that suppressed it produced spaces inside words (`implementa` → ` tion`) and put the model's reasoning into the ghost text.

## The problem

In the [empty-completions reproduction](empty-completions-2026-09.md#what-remains-findings-not-fixed), 16 of 52 `anthropic-haiku` raw outputs closed `</COMPLETION>`, wrote a reasoning paragraph ("Wait, let me reconsider. The instruction says there is no space between…"), and then opened a second block. 10 of the 16 quoted the per-request whitespace cue added in `6c171f4`. The detour costs tokens and latency. Two of the 16 used up the 200-token budget before the second block closed, so nothing was shown. It also appeared in March, before the cue existed.

**It happens on the prefill path.** Re-reading the raw outputs of the [whitespace-fix harness](2026-09-28-whitespace-fix.md#targeted-harness-more-samples-word-boundary-scenarios-only) (same scenarios for every model; prompt text identical to `6c171f4`, but the cue was applied to any non-space tail, not only word-like ones). "Text after the first `</COMPLETION>`" means any non-whitespace output after the first block closes:

| Backend (strategy)                     | Before the cue | After the cue |
| -------------------------------------- | -------------- | ------------- |
| `anthropic-haiku` (prefill extraction) | 31/122 (25%)   | 57/122 (47%)  |
| CLI haiku (tag extraction)             | 1/122          | 0/122         |
| CLI sonnet (tag extraction)            | —              | 6/183         |
| `xai-grok` (instruction extraction)    | —              | 0/183         |
| `gpt-4.1-nano` (instruction)           | —              | 0/183         |

The same model, haiku, detours about half the time with a prefill and almost never without one. The cue roughly doubled the rate on the prefill path, but it did not start the behaviour.

## Hypotheses

1. **The cue is a conditional puzzle.** "If X is a complete word … begin with a space. If you are finishing X itself, do not." It asks for a decision, and the model works through the decision in its reply. (prompt-writing rule 5, describe the target rather than give conditional commands, and llm-biases #6, performability, both predict this.)
2. **Instructions after the document invite discussion.** The cue is the last thing in the user message.
3. **The prefill anchor conflicts with the rules.** The API path prefills the reply with `<COMPLETION>` plus the last ≤40 characters before the cursor, trailing whitespace trimmed. From the model's side, its answer therefore starts by repeating the text before the marker, which the system prompt says never to do, and it does not start with the space the cue asks for. After the first block, it checks its answer against those rules and "corrects" it. Nothing in the prompt says the reply was started for it. (prompt-writing rule 2: what the model has in context at that moment.)
4. **The anchor can end in the middle of a word or token.** `…the implementa` has to continue as `tion`, which is not a natural token boundary. The detour, which closes the block and starts a fresh one, may be how the model gets out of that position.

## Method

A harness (not committed; see Provenance) calls the real `ApiCompletionProvider` for each variant, using a copy of `src/` in which only `prompt-strategy.ts` differs, and records the raw output, extracted text, final ghost text, finish reason and output tokens. Scenarios come from the quality suite, truncated the way production truncates them.

- **Grid:** 31 scenarios chosen by the kind of text before the cursor (14 word boundary, 4 mid-word, 5 ending in a space, 4 code, 4 ending in a newline), 2 samples each, `anthropic-haiku`.
- **Synthetic mid-word set:** 8 prefixes cut inside a word (`implementa`, `This sol`, `the deploym`, `the configur`, `the new auth`, `handleSu`, `api.getUs`, `retu`), 3 samples each. `the new auth` turned out to be ambiguous (`auth system` is a fine completion), so it is excluded from the failure counts below.

Metrics per variant: text after the first `</COMPLETION>` (the detour), the output quoting the cue, empty result, `max_tokens`, glued words at a word boundary, double space, a leading space on a mid-word completion, reasoning or prompt text (`</document>`, "Fill the", "I need to", "Let me", "Wait,") in the final ghost text, invisible characters (U+200B etc.) in the ghost text, mean output tokens, and median latency.

## Variants

All variants except S1 change only the prefill strategy's messages. `SYSTEM_PROMPT` and the tag and instruction strategies' messages are byte-identical to the current code, so the other backends are unaffected by construction.

| Variant | Change (prefill path only unless noted)                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0      | Current code (`f0d1c8a`)                                                                                                                                                                                                                                                                             |
| P1      | Prefill `<COMPLETION>` only, no anchor (and no anchor-whitespace dedup)                                                                                                                                                                                                                              |
| P2a     | Adds after "Fill the marker.": "Your reply is already started for you: it opens with `<COMPLETION>` followed by the text just before the marker, repeated so you can continue from it. That repeated text is not inserted twice. Continue from exactly where it stops, then close the tag." Cue kept |
| P2b     | P2a's explanation, and the cue replaced with a prefill-position one ("Your next character goes directly after X: a space if you start a new word, a letter if you are finishing X")                                                                                                                  |
| P3      | No per-request cue                                                                                                                                                                                                                                                                                   |
| Q1      | A shorter explanation ("Your reply has been started for you with the last few characters before the marker…"), and a cue that states only the fact ("The marker directly follows X with no space")                                                                                                   |
| Q2      | Q1's explanation, current cue                                                                                                                                                                                                                                                                        |
| Q3      | The fact-only cue, no explanation                                                                                                                                                                                                                                                                    |
| S1      | The fact-only cue **for every strategy** (shared change)                                                                                                                                                                                                                                             |
| R2      | P2a without "That repeated text is not inserted twice"                                                                                                                                                                                                                                               |
| R3      | P2a reworded ("Only what you write after that is inserted into the document")                                                                                                                                                                                                                        |
| R4      | P2a plus "It may stop partway through a word, in which case your first characters finish that word"                                                                                                                                                                                                  |
| R5      | P2a's explanation, no cue                                                                                                                                                                                                                                                                            |
| R6      | P2a's explanation moved before the `<document>` (prompt-writing rule 3, set the stage first), cue in place                                                                                                                                                                                           |
| H       | P2a, but the explanation only when the prefix does not end in a letter, digit or `_` (so never at a mid-word position)                                                                                                                                                                               |

## Results

### Grid (`anthropic-haiku`, 31 scenarios × 2 samples; P2a and R5 were run twice, pooled)

| Variant |   n | Detour | Quotes cue | Empty | `max_tokens` | Glued | Double space | Mid-word leading space | Reasoning/prompt in ghost text | Invisible char | Out tokens (mean) | p50 ms |
| ------- | --: | -----: | ---------: | ----: | -----------: | ----: | -----------: | ---------------------: | -----------------------------: | -------------: | ----------------: | -----: |
| **P0**  |  62 |     27 |          9 |     7 |            2 |  0/28 |          0/8 |                    0/5 |                              0 |              0 |              68.4 |   1185 |
| P1      |  62 |      1 |          1 |     0 |            1 | 24/28 |         0/10 |                    0/8 |                              0 |              0 |              32.7 |    798 |
| P2a     | 124 |      9 |          7 |     4 |            4 |  0/56 |         0/20 |                   2/12 |                              4 |              1 |              54.9 |    851 |
| P2b     |  62 |      9 |          6 |     7 |            3 |  0/24 |         0/10 |                    2/5 |                              2 |              0 |              57.8 |   1024 |
| P3      |  62 |     21 |          1 |     8 |            2 |  0/28 |          0/8 |                    0/4 |                              1 |              0 |              57.2 |   1032 |
| Q1      |  62 |     17 |          2 |     9 |            5 |  0/26 |          0/8 |                    0/4 |                              2 |              0 |              64.5 |   1087 |
| Q2      |  62 |     20 |          9 |     5 |            2 |  0/27 |          0/9 |                    0/5 |                              2 |              0 |              68.9 |   1084 |
| Q3      |  62 |     25 |          2 |    12 |            6 |  2/28 |          0/8 |                    0/2 |                              1 |              0 |              69.0 |   1139 |
| S1      |  62 |     26 |          4 |    10 |            5 |  4/27 |          0/8 |                    0/4 |                              1 |              0 |              71.4 |   1142 |
| R2      |  62 |      7 |          7 |     2 |            0 |  0/28 |         0/10 |                    4/6 |                              2 |              0 |              53.2 |    944 |
| R3      |  62 |      5 |          4 |     2 |            6 |  0/28 |         0/10 |                    2/6 |                              1 |              0 |              64.2 |    851 |
| R4      |  62 |      5 |          4 |     3 |            3 |  0/28 |          0/9 |                    2/6 |                              2 |              0 |              57.2 |    904 |
| R5      | 124 |      8 |          7 |     6 |            8 |  0/56 |         0/18 |                   7/12 |                              4 |              0 |              54.3 |    918 |
| R6      |  62 |      8 |          3 |     7 |            6 |  0/28 |          0/6 |                    4/5 |                              2 |              0 |              64.1 |   1015 |
| H       |  62 |     16 |          9 |     5 |            8 |  0/27 |          0/9 |                    0/5 |                              2 |              0 |              70.4 |   1058 |

Glued, double space and mid-word columns count non-empty completions of that kind. "Reasoning/prompt in ghost text" is almost entirely one scenario, `code-html-tag` (cursor inside `href="`), described below.

### Synthetic mid-word set (21 unambiguous samples per variant)

| Variant | Detour | Mid-word failures (leading space, empty, or invisible char) | Out tokens (mean) |
| ------- | -----: | ----------------------------------------------------------: | ----------------: |
| **P0**  |  22/24 |                                                    **2/21** |              85.3 |
| P2a     |  10/24 |                                                       10/21 |              48.4 |
| R6      |   8/24 |                                                       18/21 |              44.0 |
| H       |  24/24 |                                                        0/21 |              75.2 |

P0's two failures are both `the deploym`. The model echoed `{{FILL_HERE}}` and then the rest of the user message (`</document>`, "Fill the marker. There is no space between "deploym"…"), then wrote the real answer and closed the tag once. Extraction takes everything before the first `</COMPLETION>`, post-processing strips the marker and tags, and the echoed prompt became ghost text in front of the answer.

## What the data says

- **Hypothesis 3 (the unexplained anchor) is the main driver; hypothesis 1 (the cue as a puzzle) is a minor one.** Removing the cue entirely (P3) took the detour from 27 to 21 and cue quotes from 9 to 1. Stating only the fact (Q3, and S1 for all backends) did not reduce the detour (25, 26) and brought back glued words (2/28, 4/27). Every variant using P2a's wording (which names `<COMPLETION>` and says the repeated text is there to continue from) cut the detour to 3–9 per 62-call run. The shorter Q1/Q2 wording reached only 17–20, and H, which adds P2a's wording only when the cursor is not flush against a word, reached 16.
- **Hypothesis 4 holds, and it is why none of those variants can ship.** On the mid-word set the current prompt detours on 22 of 24 samples and still gets the word right on 19 of 21: the detour is how it recovers from a prefill that ends inside a token. With the explanation it stops detouring and writes ` tion`, ` bmit`, ` ved` (10/21 failures for P2a, 18/21 when the explanation comes first, R6). One P2a sample started with a zero-width space (`​ved`), an invisible character in the document.
- **The explanation also makes haiku run past the fill without closing the block.** At `href="` (`code-html-tag`) the current prompt closes, detours and recovers (`/contact">Contact`). With any of the explanations, haiku instead writes `{{FILL_HERE}}`, copies the suffix and `</document>`, reasons ("I need to see the actual content after the marker…"), and only then writes its answer and the first `</COMPLETION>`. Everything before that tag is the first block, so all of it became ghost text. This happened in 1–2 of 2 samples for every explanation variant, including H. It is the same mechanism as P0's `the deploym` failures, just more frequent.
- **H (explanation only when the cursor is not flush against a word) keeps mid-word correct**, but it has the `code-html-tag` problem, hits `max_tokens` more often (8 vs 2), and saves no tokens (70.4 vs 68.4). It is not clearly better, so it was not taken to the multi-model confirmation.
- **P1 (no anchor) removes the detour and halves the tokens, but glues words 24/28.** The anchor is what keeps haiku's leading space right on this path.

With no clean candidate, the confirmation run across the five reference models and the Layer 1 full-suite runs were not done: no prompt text changed, so there is nothing to confirm.

### How the prompt-writing guidance was applied

The variants were checked against `prompt-writing.md` and `llm-biases.md`. Q1–Q3 and S1 follow rule 5 (state the fact, not the decision). R6 follows rule 3 (set the stage before the rules). The explanation itself follows rule 2 (tell the model what it actually has in context). P2a, P2b and R2–R5 break rule 3 by putting the explanation after the document, and P2a's "That repeated text is not inserted twice" is a defensive line that the model sometimes quoted. The guidance produced the hypotheses and the variants. The decision not to change the prompt came from the data: the variants that followed the guidance most closely (Q3/S1, R6) did worse on glued words and mid-word completions than those that did not.

## Possible next steps (not done; each needs Trent's approval)

- **End the prefill anchor at a word boundary** (drop the partial last word from the anchor), so the model never continues from inside a token. Extraction would then have to remove the re-typed partial word, which extends the `16a90c9` rule from whitespace to text. That is new post-processing: it goes wrong when the model finishes the word differently.
- ~~**Reject a first block that contains prompt scaffolding beyond a leading `{{FILL_HERE}}`**~~ Done in `80c4324`, see [Fix: a block that echoes the user message](#fix-a-block-that-echoes-the-user-message-80c4324).
- **Raise `maxTokens` on the Anthropic presets** so a detour has room to finish its second block. This is cheaper than the two above, but it accepts the detour rather than removing it.

## Fix: a block that echoes the user message (`80c4324`)

**Rule.** On the prefill path, a block is not an answer when, besides being scaffolding only (`ef272ad`), it echoes the user message back:

- it starts with `{{FILL_HERE}}` (after optional whitespace) **and** contains `</document>` — the model copying the document from the marker to the wrapper's closing tag; or
- it contains one of the exact sentences `buildFillMessage()` appended for this request: "Fill the {{FILL_HERE}} marker.", the three whitespace-cue sentences with the author's last word quoted, or "The text before it already ends with a space." The sentences now come from one function, `fillInstructionSentences(prefix)`, used by both the builder and the check, so the check keys on exactly what was sent. The sent messages are byte-identical to before (1,248 strategy × scenario × prefix combinations compared).

A signal that also appears in the prefix or suffix sent is ignored, so editing this repo's `prompt-strategy.ts` (which contains the marker, `</document>` and the instruction line) is not affected; extraction now receives the suffix for this. A rejected first block falls through to the existing retry: a closed second block is used, otherwise nothing is shown. The retry block and the no-closing-tag fallback get the same check. Nothing is stripped or rewritten; a block is either used whole or not at all.

Neither half of the first signal is enough alone: `</document>` is a real closing tag in XML, and a leading marker followed by a real answer (`{{FILL_HERE}}ent to production.`) is still handled by `stripLeakedTags()` as before. Both are covered by no-op tests, along with prose about "filling the marker field in the document", a cue-shaped sentence naming a different word, and reasoning that quotes nothing from the prompt.

**Not caught, on purpose.** Reasoning written before the first `</COMPLETION>` that quotes nothing from the prompt ("Wait, let me reconsider…", "I need to see…") is still shown. That wording can be legitimate prose, so it is not a safe trigger. In every recorded leak so far the reasoning came after an echoed `{{FILL_HERE}}…</document>`, so the echo carried it out, but a leak without the echo would get through. A related shape seen once in the live runs is also untouched: a first block that stops at the model's own `{{FILL_HERE}}` mid-sentence (`…it is {{FILL_HERE}}</COMPLETION>`, then a detour cut off by `max_tokens`). It shows the fragment before the marker; it is not an echo of the prompt.

**Recovery is rare.** Only 1 of the 37 changed cases below had a closed second block to fall back to. In 24 of the other 36, the answer is inside the rejected block, after an inner `<COMPLETION>` the model reopened without closing the first (`…</document> I need to see… <COMPLETION>/contact">Contact</COMPLETION>`). Taking the text after the last inner `<COMPLETION>` would recover most of them. That is a further extraction change and was not made.

### Offline replay (no API calls)

Every recorded `anthropic-haiku` raw output from this investigation (all 15 variants), the whitespace-fix harness, the prefill A/B harness and the five March quality runs was replayed through the old and the new prefill extraction plus post-processing, with the same inputs. For P0 the old replay reproduces the recorded ghost text exactly (86/86).

| Corpus                                           |      Raws | Ghost text changed | Echo leak → nothing | Echo leak → correct answer | Other changes |
| ------------------------------------------------ | --------: | -----------------: | ------------------: | -------------------------: | ------------: |
| P0 grid (current prompt)                         |        62 |                  0 |                   0 |                          0 |             0 |
| P0 mid-word set (current prompt)                 |        24 |                  2 |                   2 |                          0 |             0 |
| Other variants, 2026-09-28                       |     1,064 |                 26 |                  25 |                          1 |             0 |
| Whitespace-fix and prefill A/B harnesses         |       984 |                  8 |                   8 |                          0 |             0 |
| March quality runs (`anthropic-haiku`/`-sonnet`) |       331 |                  1 |                   1 |                          0 |             0 |
| **Total**                                        | **2,465** |             **37** |              **36** |                      **1** |         **0** |

All 37 changes are echo leaks: 32 at `code-html-tag` (`href="`), 2 `the deploym`, and 3 in the whitespace-fix and prefill A/B harnesses (`prose-list-continuation` ×2, `regression-code-suffix-echo-shell-quote`), one of them under an older cue wording that the sentence check does not know; the marker-plus-`</document>` signal caught it. No completion that was not an echo changed. The replay set (`src/test/fixtures/replay/replay-set.json`) is unchanged, so no drift notes were needed; the builder gained a `prefill-echo-rejected` drift label for the March `code-html-tag` case should it be rebuilt. After the fix, no ghost text in the corpus contains `</document>`, "Fill the", the cue, or reasoning phrases (one legitimate "when I need to edit files" in prose).

### Live confirmation (fixed code, `anthropic-haiku`)

| Set                         | Calls | Echo leaks in ghost text | Would have leaked (old extraction, same raws) | Glued | Double space | Mid-word failures | `code-html-tag` result                             |
| --------------------------- | ----: | -----------------------: | --------------------------------------------: | ----: | -----------: | ----------------: | -------------------------------------------------- |
| P0, grid (recorded)         |    62 |                        0 |                                             — |  0/28 |          0/8 |               3/8 | 2/2 `/contact">Contact` via the detour             |
| Fixed, grid ×3              |   186 |                        0 |                                             4 |  0/84 |         0/24 |     4/8, 4/8, 5/8 | 2/6 correct, 4/6 nothing (all 4 echo rejections)   |
| P0, mid-word set (recorded) |    24 |                        2 |                                             — |     — |            — |              2/24 | —                                                  |
| Fixed, mid-word set         |    24 |                        0 |                                             0 |     — |            — |              0/24 | —                                                  |
| Fixed, `code-html-tag` ×6   |     6 |                        0 |                                             1 |     — |            — |                 — | 5/6 `/contact` or `/contact">Contact`, 1/6 nothing |

Mid-word failures count a leading space, empty or invisible character; in the grid they are the four mid-word scenarios, and the changes between runs are sampling (none of those raws was touched by the new rule). `the deploym` did not echo in this run's 3 samples, so the mid-word improvement is the replay's 2 → 0, not the live 2/24 → 0/24. At `href="`, the old code showed the echo (suffix, `</document>`, reasoning) as ghost text whenever haiku took that path; it now shows nothing. Empty results in the fixed grid runs were 10, 8 and 11 of 62 (P0: 7); 1–2 per run are the rejected echoes, the rest are the existing immediate-close and `code-ts-partial-word` `max_tokens` cases.

## Decision for Trent: `maxTokens` (not changed)

The Anthropic presets cap output at 200 tokens. On the current prompt (P0 and the fixed runs, 302 calls), 13 hit the cap (4%). 8 of those showed nothing: 7 are `code-ts-partial-word`, which detours and then runs out inside its second block every time (6/6 in the fixed grid runs), and 1 is an echo at `href="`. The other 5 still showed an answer (a closed retry before the cut, or a long first block passed through the no-closing-tag fallback, truncated). Across all 1,366 saved calls (1,150 variant calls whose results were kept, plus the 216 fixed-code calls), 72 hit the cap: 39 were a first block that never closed (shown as-is, truncated), 31 a second block cut off (26 of them after a blank first block, which shows nothing unless an earlier retry had closed).

Raising the cap to 400 would let most cut-off retry blocks close, so `code-ts-partial-word`-type cases would get an answer instead of nothing. It would cost little: only the ~4% of calls that hit the cap run longer, by up to 200 output tokens (about $0.001 each on Haiku at $5/MTok, $0.002 on Sonnet 5 at $10/MTok, though the Sonnet preset currently cannot run at all, see [2026-09-28-sonnet-preset.md](2026-09-28-sonnet-preset.md)), and those calls take roughly a second longer. It would also make the no-closing-tag fallback show up to twice as much truncated text when a first block runs on. It does not reduce the detour itself, and the fixed rule already keeps echoed prompt text out of the ghost text regardless of the cap. Recommendation: leave it at 200 unless the empty `code-ts-partial-word`-type results matter in daily use; if raised, raise it together with a cap on how much of an unclosed first block is shown.

## Task 2: a retry block cut off by `max_tokens`

**Question.** When haiku closes the first block empty, reasons, opens a second `<COMPLETION>`, and runs out of tokens, extraction returns null. Is using that unclosed retry block an extraction bug fix, or new behaviour?

**Evidence.**

- `f0edfc3` (Mar 1) introduced the retry rule. Its comment says "look for a second `<COMPLETION>...</COMPLETION>` pair", and its tests cover closed pairs only. `ef272ad` changed what counts as a blank first block and kept the closed-pair requirement. No commit or test ever took an unclosed retry block.
- The "no closing tag → return raw" fallback is older (`420b060`, "fallback: no closing tag, use raw text", no reason given) and applies only when the output has **no** `</COMPLETION>` at all, for example a stop sequence (the API does not return the stop text) or a `max_tokens` cut. It never looked at retry blocks.
- In this session's 1,181 calls, all 13 unclosed retry blocks had finish reason `max_tokens` (11 after a blank first block, 2 after a non-blank one). An unclosed retry block is truncated output by definition: the example in the empty-completions doc (`code-ts-partial-word`) stops mid-statement.

**Decision: (ii), new behaviour, not implemented.** Showing a block the model did not finish would put truncated code into the document as ghost text. That is a product decision, not a missing close tag.

**Two paths already behave differently.** When the **first** block is unclosed, the fallback shows it: 38 of the 38 unclosed first blocks in this session were `max_tokens` truncations, and the fallback passed each one on as the completion. When a **retry** block is unclosed, it is discarded. Separately, a closed first block is shown whole: of the 28 completions in this session whose ghost text contained echoed prompt text or reasoning, 26 came through a closed first block (echo and reasoning written before the first `</COMPLETION>`) and 2 through the no-closing-tag fallback. **Proposed Known Limitation** (not added to AGENTS.md; for Trent to decide):

> **Prefill extraction treats an unclosed block two ways.** If the model never writes `</COMPLETION>`, the raw output is shown as-is, including text cut off by `maxTokens` (200). If the model closes a blank first block and its retry block is cut off by `maxTokens`, nothing is shown. Using the truncated retry would show truncated code, so it is left alone. The lever is `maxTokens` on the Anthropic presets. Separately, anything haiku writes before its first `</COMPLETION>` is shown, so an echoed prompt line or reasoning written before the answer reaches the ghost text (2 of 24 mid-word samples under the current prompt). (Since `80c4324`, a block that echoes the user message is rejected; reasoning that quotes nothing from the prompt is still shown.)

## Provenance

- Code under test: `f0d1c8a` (P0), with each variant differing only in `src/providers/prompt-strategy.ts`. Run 2026-09-28 01:52–02:02 UTC.
- 1,181 `anthropic-haiku` calls (about 71k output tokens and roughly 3M input tokens, so on the order of $3–4 at Haiku list prices; input tokens were not recorded per call). No calls to the other models: the other backends' messages are byte-identical to the current code for every variant except S1, and S1 was dropped after it failed on `anthropic-haiku`. The cross-model detour rates above were re-read from the raw outputs of the 2026-09-28 whitespace-fix harness runs, so they cost no new calls.
- The harness (`harness.ts`, `analyze.py`, variant source trees) and the per-call results (full prompts) live in the session scratchpad and are not committed, so the tables are reported results, not something a reader can regenerate from this checkout. The same is true of the whitespace-fix harness runs used for the cross-model table.
- One sample per call and no judge. Every metric is a mechanical check on the raw or final text.
- Fix follow-up (`80c4324`): 216 live `anthropic-haiku` calls on the fixed code (grid ×3, mid-word ×3, `code-html-tag` ×6), 2026-09-28 02:20 UTC: 357k input and 14k output tokens, $0.43 at $1/$5 per MTok (no cache hits). The grid ran three times instead of once because of a harness invocation mistake; all three are reported. The offline replay made no calls. The harness copy (`harness-fix.ts`), the replay script and the per-call results are in the session scratchpad and not committed.
