# Prototype: recover the answer from inside a rejected echo block (2026-09-28)

**Status: prototype on `proto/echo-recovery`, not merged.** Recommendation at the end.

## The problem

Since `80c4324`, a prefill-path block that echoes the user message back (`{{FILL_HERE}}` … `</document>`, or an appended instruction sentence) is rejected, and with no closed retry block after it nothing is shown ([reasoning-leakage eval](2026-09-28-reasoning-leakage.md#fix-a-block-that-echoes-the-user-message-80c4324)). In most of those rejections the model did write an answer: it reopened `<COMPLETION>` inside the echo without closing the first one, so the first `</COMPLETION>` closes the answer and the whole thing is one block:

```
{{FILL_HERE}}</a></li>
  </ul>
</nav>
</document>

I need to see the actual content to fill this properly. … Based on typical site navigation, the third link should be something like:

<COMPLETION>/contact">Contact</COMPLETION>
```

## The rule (`recoverFromEchoBlock()` in `src/providers/prompt-strategy.ts`)

When the **closed** first block was rejected as an echo **and** no closed retry block was usable (so the result would otherwise be `null`), take the text after the **last** `<COMPLETION>` inside that block, up to the block's end. Use it verbatim only if:

- it contains no `{{FILL_HERE}}`, no `</document>` and none of the sentences `fillInstructionSentences(prefix)` appended (each ignored when it is in the prefix/suffix sent, as in the echo check). Since the block was rejected for one of these and the recovered text has none, the echo lies wholly before the reopened tag;
- it does not restart the prefix: it may not begin with the prefill anchor or with the partly typed word before the cursor (`deploym` → `deploymdeployment`);
- it is not blank or scaffolding only.

Not recovered, on purpose: an **unclosed** block (a `max_tokens` cut) that reopened a tag — there is no evidence the answer is complete — and a rejected **retry** block. Nothing is rewritten; the existing whitespace re-alignment and post-processing run on the recovered text as on any other block.

Because it only runs where the result is `null` today, it cannot change a completion that is shown today. The replay confirms this below.

## Offline replay (no API calls)

Every recorded `anthropic-haiku` raw output from the leakage investigation (all variants), the whitespace-fix and prefill A/B harnesses and the March quality runs (the 2,465 of the leakage eval), plus the 216 live calls recorded after `80c4324` (`FIX` runs) and 177 `anthropic-sonnet` raws from a later whitespace run, were replayed through the showcase-head extraction (`a420e85`, which includes `80c4324`) and the prototype, then post-processing, with the same inputs. 8 whitespace-harness rows whose `+sp`/`+para` scenario variants are not reconstructable were skipped on both sides.

| Corpus                                     |      Raws | Echo rejected (→ nothing today) | With a reopen in a closed block | Recovered | Recovered, correct | Recovered, wrong | Changed outside the rejected set |
| ------------------------------------------ | --------: | ------------------------------: | ------------------------------: | --------: | -----------------: | ---------------: | -------------------------------: |
| P0 grid (current prompt)                   |        62 |                               0 |                               0 |         0 |                  0 |                0 |                                0 |
| P0 mid-word set (current prompt)           |        24 |                               2 |                               1 |         1 |                  1 |                0 |                                0 |
| Other prompt variants                      |     1,064 |                              25 |                              16 |        16 |                 13 |                3 |                                0 |
| Whitespace-fix and prefill A/B harnesses   |       984 |                               8 |                               7 |         7 |                  7 |                0 |                                0 |
| March quality runs                         |       331 |                               1 |                               0 |         0 |                  0 |                0 |                                0 |
| **Leakage-eval corpus (the 36 targets)**   | **2,465** |                          **36** |                          **24** |    **24** |             **21** |            **3** |                            **0** |
| Live runs after `80c4324` (`FIX`, current) |       216 |                               5 |                               4 |         4 |                  2 |                2 |                                0 |
| `anthropic-sonnet` whitespace run          |       177 |                               0 |                               0 |         0 |                  0 |                0 |                                0 |
| **All**                                    | **2,858** |                          **41** |                          **28** |    **28** |             **23** |            **5** |                            **0** |

Of the 36 targets, 12 are not recovered: 11 have no reopened tag (reasoning that ends in a question to the user, or an answer written without a tag, e.g. `…a typical third link would be:\n\n/contact">Contact</COMPLETION>`), and 1 reopened a tag but was cut off by `max_tokens` before closing (last reopen `/contact">`, unclosed — correctly left alone). The previous eval's "24" matches the closed-block count exactly.

### How each recovery was judged

Each recovered text was joined to its prefix and suffix and read as rendered.

- **Correct (23).** `code-html-tag` (prefix ends `<li><a href="`, suffix starts `</a></li>`): 19 × `/contact">Contact` or `/services">Services`, rendering `<a href="/contact">Contact</a></li>`. One of them was `/contact">Contact</a></li>\n  </ul>\n</nav>`; post-processing trimmed the duplicated suffix to `/contact">Contact`. Mid-word `the deploym` (1): `ent to production and it broke the checkout flow for about two hours.` → "deployment to production…", no stray space. `prose-list-continuation` (2): prefix ends `constraints,`, recovered text starts with one space → "constraints, we should prioritize…", no double space. A shell-quote case (1): `$` + `file` + `"`, the delimiter not repeated.
- **Wrong (5), all the same shape.** `code-html-tag` recovered a bare path (`/contact` ×4, `/services` ×1), which renders `<a href="/contact</a></li>`: the closing quote and link text are missing. This is the model's own answer, not an extraction artifact, and haiku gives the same broken answer on its **normal, non-echo** path at this position: of the 27 non-echo `code-html-tag` outputs in the corpus, 15 are `path">Text`, 9 a bare path, 2 other broken forms (a doubled quote: `"/contact"`, `"/contact`), 1 nothing. Recovered answers are correct 19/24 (79%) at `href="`, versus 15/27 (56%) on the normal path.
- **No junk.** No recovered text contains reasoning, `</document>`, the marker, an instruction sentence, or text from before the cursor.

### Mid-word and `href`, specifically

- **Mid-word** (120 rows over the eight synthetic mid-word scenarios): 1 row changes (`the deploym`, `null` → the correct suffix above). The other `the deploym` echo has no reopened tag and stays `null`. No other mid-word output changes. Evidence here is thin (one recoverable echo), but the partial-word guard means a model that re-types `deploym` inside the reopened tag still shows nothing rather than `deploymdeployment`.
- **`href="`**: 24 of the 28 recoveries. 19 correct, 5 bare paths (above).

### Other checks

- The one echo that `80c4324` already turned into a correct answer via a closed retry block (`/contact">Contact`) is byte-identical: recovery runs only after the retry lookup fails.
- 857 raws contain `<COMPLETION>` somewhere and show a completion today; none changes.
- The replay set (`src/test/fixtures/replay/replay-set.json`) is unchanged: its one echo case (March `code-html-tag`, drift label `prefill-echo-rejected`) has no reopened tag and stays `null`. No drift notes needed.

No live calls were made: the replay answers the questions (whether anything outside the target set changes, and what each recovered text renders as), and at the current echo rate (2/24 at mid-word) 20 calls would yield one or two new echoes at most.

## Examples (fixture scenarios, verbatim)

**`the deploym` (synthetic mid-word), recovered correctly.** Raw after the prefill:

```
{{FILL_HERE}}
</document>

Fill the {{FILL_HERE}} marker. There is no space between "deploym" and the marker. If "deploym" is a complete word or ends in punctuation and your output starts a new word, begin with a space. If you are finishing "deploym" itself, do not.

<COMPLETION>ent to production and it broke the checkout flow for about two hours.</COMPLETION>
```

Today: nothing. Prototype: `ent to production and it broke the checkout flow for about two hours.`

**Same scenario, no reopened tag — still nothing.** `…If you are finishing "deploym" itself, do not.\n\nent to production and it broke the payment flow for about two hours.</COMPLETION>`. The answer is there, but without a reopened tag there is no boundary that is safe to cut at.

**`code-html-tag`, several reopened tags — the last one wins.**

```
…Given the simple structure (Home, About), a typical next link would be:

<COMPLETION>/contact">Contact</a></li>
  </ul>
</nav>
</document>

Actually, let me reconsider. The marker is inside the href attribute value itself:

<COMPLETION>/services</COMPLETION>
```

Prototype: `/services` — one of the 5 wrong recoveries (bare path). The first inner block would have been rejected anyway (it contains `</document>`).

**`code-html-tag`, bare `href` answer.** `…the next logical link would be:\n\n<COMPLETION>/contact</COMPLETION>` → `<a href="/contact</a></li>`. Wrong, but the same answer haiku gives on its normal path about a third of the time here.

## Tests

`src/test/unit/prompt-strategy.test.ts`, "recovers the answer from inside a rejected echo block": activation for mid-word, `href` path + text, prose with a leading space, several reopened tags (last wins), and retry-before-recovery ordering; no-op for an echo with no reopened tag, a reopened block containing `</document>` or an appended sentence, an unclosed echo block with a reopened tag, a reopened block that restarts the prefix (anchor or partial word), a blank reopened block, a non-echo first block, and a scaffold-only first block. Two existing `80c4324` tests that asserted `null` for a reopened answer now assert the recovered text or use an untagged answer.

## Recommendation

**Ship, with one condition.** The rule is narrow (it only turns today's `null` into text), changed nothing outside the 41 rejections across 2,858 raws, recovered 24 of the 36 targets with 21 correct, and every wrong recovery is the model's own bare-path answer at `href="`, a mistake haiku makes on its normal path more often. The condition: accept that at `href="` those 5 of 28 would now show broken HTML (`href="/contact</a>`) where today they show nothing. If showing nothing is preferable to a wrong answer there, do not ship; there is no narrow guard that tells a bare path apart from a legitimate one without reading the suffix, which would be new code-aware post-processing.
