# Replay set

The replay set is a collection of real model outputs recorded during quality runs. `src/test/unit/replay.test.ts` feeds each one through the **current** client-side pipeline (strategy extraction, then `postProcessCompletion`) and the deterministic checks. It runs under `npm run test:unit`, so CI runs it too. It needs no backend, network or secrets, and it finishes in well under a second.

It is a change detector, not a correctness oracle. Each case pins what the pipeline does today, including any bugs it has today. When the pipeline changes, the test fails and someone has to decide whether the new output is better or worse. For example, the set originally pinned `code-java-mid-file` at `user.isActive(`, the output of a trim bug, and listed the removal of that `)` as a `must_avoid` invariant; when that bug was fixed (`5e2a20e`) the case failed, and its expectation was updated to `user.isActive()` with a drift note.

| File                                          | Role                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/test/fixtures/replay/replay-set.json`    | The cases (checked in)                                                                      |
| `src/test/unit/replay.test.ts`                | Replays every case and asserts on the results                                               |
| `src/test/quality/replay/replay-pipeline.ts`  | `replayPipeline()`, the CLI and API glue shared by the test and the builder, plus the types |
| `src/test/quality/replay/build-replay-set.ts` | Selects cases from `test-results/quality-*` and writes the fixture                          |

## What each case asserts

1. **`expected_final`**: the ghost text the pipeline produces from `raw` must match exactly (`null` means no completion). If you change extraction or post-processing in a way that alters a real output, this assertion fails and shows the diff.
2. **`expected_checks`**: `runDeterministicChecks()` on the replayed output must return exactly these results, detail strings included. This keeps known-bad raw outputs flagged. One example is `prose-long-prefix-narrative`, where the model regurgitates the suffix and post-processing cuts it down to a stray `" —"`. The `suffix-echo` check reads the raw output, so it has to keep failing.
3. **`must_avoid`**: named invariants that duplicate the exact-match assertion on purpose. They keep guarding a case even after someone deliberately updates `expected_final`. The kinds are:
   - `tag-leak`: scaffolding such as `<COMPLETION>` or `{{FILL_HERE}}` must not appear in the output.
   - `preamble`: the output must not start with a chat preamble.
   - `prefix-echo`: the output must not start with the echoed line fragment.
   - `suffix-overlap`: the output must not end with the suffix text that was trimmed off. In `code-py-list-comprehension` the raw output is ` x % 2 == 0]` and the suffix starts with `]`, so the ghost text must be `x % 2 == 0`.
   - `whitespace-final`: whitespace-only output must come back as `null`.
   - `check-stays-failing`: the named check must keep failing.

   Every case is also checked for leaked scaffolding and whitespace-only output.

## How the set was built

- **Source.** The source is the gitignored `test-results/quality-*` folders in the main checkout. Each scenario folder contributes `input.json` (the truncated prefix and suffix the model saw, plus mode and languageId), `raw-response.txt`, `completion.txt` and `metadata.json` (backend and preset). The strategy and the `prefill` flag come from the preset, and CLI runs use `tag-extraction`.
- **Only synthetic scenarios.** Every `regression-*` scenario is excluded because those come from real usage. Scenarios that are no longer defined in the source are skipped too, since their check flags cannot be looked up.
- **Which runs.**
  - Runs from `2026-03-02T01-43` onward (the `CURRENT_ERA_FROM` cutoff) reproduce exactly: the current pipeline returns the recorded `completion.txt` for every one of them. These runs supply all the ordinary cases and all the non-drift cases.
  - The `02-11` and `02-12` runs are excluded. They used an earlier prompt protocol (`<output>` tags), so their raw responses are not valid input for today's extraction.
  - The `02-28T02-59` and `03-01T19-57` CLI runs use the current protocol but predate `f0edfc3`. They are excluded because the current-era runs already cover tag extraction on haiku and sonnet.
  - The `2026-03-01T20–22` API runs predate two commits: `f0edfc3` (prefill "thinking leak" handling, a 1-char code-mode suffix overlap, and skipping trailing whitespace in the suffix trim) and `ad1839e` (`stripLeakedTags`). When today's output differs from the recorded one, the case is kept only if the difference is explained by one of those commits. Such a case gets `drift` (the explanation and the commit), `recorded_final` (what shipped at the time) and `expected_final` (today's output). The builder reports and drops any difference it cannot explain. None remained when the set was built.
- **Selection.** Selection is deterministic. Each candidate is tagged with what happened to it: `prefix-trim`, `suffix-trim`, `tag-strip`, `extract-null`, `extract-whitespace`, `prefill-immediate-close`, `prefill-retry-used`, `raw-text-after-close`, `final-null`, `check-fail:<id>`, `drift:<kind>`, or `ordinary`. The builder then:
  1. takes a short hand-picked list (`MUST_INCLUDE`: the error-analysis cases and one drift case per distinct pre-fix failure);
  2. adds one more case per drift kind;
  3. takes up to 4 cases per interesting tag, spread across strategies and deduplicated on (scenario, strategy);
  4. fills the rest, up to about 52 cases, with ordinary cases taken round-robin across strategy, mode and model.
- **Trimmed context.** To keep the fixture small, each case stores a line-aligned tail of the prefix and head of the suffix. The window starts at 300 chars of prefix and at `max(300, extracted length + 100)` chars of suffix. It doubles until the replayed output **and** every check's (id, pass) equal the full-context result, with the full context as the upper limit. The window has to cover what the pipeline reads: `trimPrefixOverlap` reads the last prefix line, and only if it is 150 chars or shorter; `trimSuffixOverlap` reads up to the completion's length of normalized suffix. It also has to cover what the checks read: `suffix-echo` needs at least 30 normalized chars, the boundary check reads the characters at both seams, and `journal-date` reads every date heading, so journal cases keep most of their context. `prefix_omitted_chars` and `suffix_omitted_chars` record how much was dropped.
- `scenario_flags` (`mid_word`, `max_completion_chars`, `expect_empty_ok`, `must_not_start_with`) are copied from the current scenario source when the set is built, so the test does not import the scenario files.

## Refreshing

```bash
npx tsx src/test/quality/replay/build-replay-set.ts                     # default: ~/working_dir/bespoke-ai-vscode-ext/test-results
npx tsx src/test/quality/replay/build-replay-set.ts <results-root> [--out file]
npx prettier --write src/test/fixtures/replay/replay-set.json
```

The builder prints the composition (by strategy, model, mode and tag), plus a warning for every case it drops as `UNEXPECTED DRIFT` or `UNEXPLAINED DRIFT`.

**When the test fails after a pipeline change**, work out whether the new output is what you intended:

- **Intended.** Rebuild the set, or edit that case's `expected_final` and `expected_checks` by hand. Set `recorded_final` to the old value and add a `drift` note that cites the commit.
- **Not intended.** You have a regression. Fix the code. Do not update the fixture to match it.

Adding new quality runs to the source folder and rebuilding can change which cases are selected. Review the diff to the fixture before you commit it.

## What it covers, and what it doesn't

**Covers:** the deterministic client code that sits between the model and the ghost text, run on real outputs from 8 model configurations across all three strategies:

- **Tag** (CLI haiku and sonnet).
- **Prefill** (Anthropic haiku through the API).
- **Instruction** (xAI Grok and Grok Code, GPT-4.1 nano, Gemini Flash, Qwen 3.5 9B on Ollama).

**Does not cover:**

- **Model quality.** A case passes when the pipeline behaves the same as before, not when the completion is good. Many cases pin known-bad outputs on purpose, and quality still takes `npm run test:quality` plus Layer 2.
- **Prompt construction.** `SYSTEM_PROMPT` and `buildFillMessage()` are not exercised, and changes to them never touch this test.
- **Instruction-extraction fallbacks.** The code-fence and chat-preamble stripping paths have no recorded example: no model in the current-era runs answered without `<COMPLETION>` tags. The unit tests in `prompt-strategy.test.ts` cover those paths.
- **Everything outside the extraction and post-processing path.** That includes the cache, debounce, pool and IPC, adapters and the HTTP layer.
