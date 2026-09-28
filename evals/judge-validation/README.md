# Judge validation

The quality eval's Layer 2 is an LLM judge (`src/test/quality/validator-prompt.md`). Its pass rates are only as trustworthy as the judge. The [error analysis](../error-analysis-2026-03-sonnet.md) already found it misses a whole defect class (missing space at the seam) and flips its verdict on byte-identical completions. This folder is the setup for measuring how often the judge agrees with a human, following the practice Hamel Husain and Shreya Shankar describe: label a sample by hand, then measure the judge against those labels. The labels do not exist yet, so **no agreement rate is claimed anywhere yet.**

## What is measured

For each item, a human (Trent) answers one question without seeing the judge's verdict: _would I accept this ghost text?_ Then `npm run judge:score` compares the human labels with the verdicts. Pass is the positive class.

| Metric    | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| TPR       | Of the completions the human passed, the share the judge also passed. |
| TNR       | Of the completions the human failed, the share the judge also failed. |
| Agreement | Share of items where judge and human give the same verdict.           |

Each metric is reported twice: once for the judge alone, and once for "judge AND every applicable deterministic check" (`src/test/quality/deterministic-checks.ts`), which is how Layer 1 + Layer 2 now combine. Each rate has a 95% Wilson interval.

TPR and TNR are reported separately, not only agreement, because the two errors cost different things. A low TNR means bad completions pass (the eval flatters the model). A low TPR means good completions fail (prompt changes get rejected for no reason).

## The sample

`npm run judge:sample` builds 100 items from the existing quality runs in `../bespoke-ai-vscode-ext/test-results/quality-*` (gitignored). No model calls are made.

- **Only judged items.** An item needs a `validation.md` whose verdict parses, or there is nothing to compare.
- **Only synthetic scenarios.** Every `regression-*` scenario is excluded, because those were captured from real use.
- **Only healthy runs.** The `quality-2026-03-04T01-22-51-api-ollama-qwen35-9b` run is left out of the pool (`EXCLUDED_RUNS` in `build-sample.ts`). It was half-broken, with 54 of 97 completions empty, and its judged items were mostly trivial.
- **Deduplicated** on (scenario, completion text). When the same completion was judged in several runs, the most recent verdict is the primary one. All verdicts are kept in `judge-verdicts.json`, and `judge_disagreement` marks the ones where runs disagreed.
- **Stratified.** Items are spread across the five models, prose and code, twelve scenario categories, and at most two items per scenario.
- **A small, deliberate "empty" category.** Null or whitespace-only completions are capped at three (`MAX_NULLS`). They are easy to label and say little about the judge, but three keeps the case covered.
- **Enriched for failures.** A random draw would be about 80% judge passes. The sample instead takes 30 judge fails, 25 judge passes that a deterministic check fails, and 45 judge passes where every check passes, which aims for a roughly even human pass/fail split. This oversamples the cases where the judge is most likely wrong, so **the rates describe the judge on this sample, not the judge's error rate on a typical run.** A population estimate would need reweighting by bucket.

The build prints the composition. The current sample (seed 20260927, drawn from 500 candidates):

| Bucket                         | dev | test | total |
| ------------------------------ | --- | ---- | ----- |
| judge fail                     | 12  | 18   | 30    |
| judge pass, a det. check fails | 10  | 15   | 25    |
| judge pass, all checks pass    | 18  | 27   | 45    |
| **total**                      | 40  | 60   | 100   |

| Also by                                | dev | test | total |
| -------------------------------------- | --- | ---- | ----- |
| empty completion (all in "judge fail") | 2   | 1    | 3     |
| prose                                  | 27  | 40   | 67    |
| code                                   | 13  | 20   | 33    |
| api/openai-gpt-4.1-nano                | 9   | 16   | 25    |
| api/xai-grok                           | 10  | 13   | 23    |
| claude-code/haiku                      | 7   | 14   | 21    |
| claude-code/sonnet                     | 10  | 10   | 20    |
| claude-code/opus                       | 4   | 7    | 11    |

This table is copied from the build output. Update it if the sample is rebuilt.

## Why a held-out split

Each item is assigned to `dev` (40) or `test` (60), stratified by bucket, mode and model, with a fixed seed. If the judge prompt is changed to fix disagreements, those changes must be made while looking at `dev` only. The number to quote is the one on `test`, which the tuning never saw. Tuning on the same items used for the score would overstate the judge. `judge:score` refuses to report `test` until at least 50 of its 60 items have a pass or fail label. Unsure labels do not count, so mark no more than 10 `test` items unsure.

## How to label

1. Open `label.html` in a browser (it works from `file://`, and the sample is inlined).
2. For each item, read the join: the end of the prefix, the completion highlighted between two blue bars, then the start of the suffix. Whitespace inside the completion and at both seams is drawn (`·` space, `↵` newline, `→` tab), so a missing space at the seam is visible.
3. Press `p` (pass) or `f` (fail). The page moves to the next item. Use `u` for unsure (excluded from the score), `n` to add a note, `←`/`→` to move, and `j` to jump to the next unlabeled item. Progress is saved in the browser.
4. Click **Export labels.csv** and save it over `evals/judge-validation/labels.csv`.
5. Run `npm run judge:score`.

The page does not show the judge's verdict, the check results or the run. Those are in `judge-verdicts.json`, which should stay unopened until labeling is done. The page also hides the model name. The "Intent" line is the scenario's `quality_notes`, which is what the judge was also given.

Judge each completion as ghost text you would accept with Tab. Invented names, dates and code are expected, so judge whether they fit, not whether they are true. Budget about 20 minutes for 100 items.

## What will and will not be claimed

After labeling, the claims will be TPR, TNR and agreement on the `test` split, with their intervals, for the judge alone and combined with the deterministic checks, on this enriched sample, against one human labeler.

The following will not be claimed:

- Any rate before the labels exist.
- A tighter number than the data supports. With about 30 items per class in `test`, each of TPR and TNR has an interval of roughly ±15 percentage points.
- That these rates hold for a typical run's mix, for the regression scenarios, or for a judge model or rubric other than those that produced the verdicts. The historical runs did not record which judge model wrote the `validation.md` files (see the rescore notes), so the "judge" measured here is those recorded verdicts.
- Inter-rater reliability. There is one labeler.

## Files

| File                                                | What it is                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sample.json`                                       | The 100 items as shown to the labeler. No verdicts.                                                                              |
| `judge-verdicts.json`                               | Judge verdict, score, all run instances, bucket and deterministic checks per id.                                                 |
| `labels.csv`                                        | `id,split,human_pass,notes`. `human_pass` is `pass`, `fail`, `unsure` or blank.                                                  |
| `label.html`                                        | The labeling page (generated from `label.template.html`).                                                                        |
| `src/test/quality/judge-validation/build-sample.ts` | Builds everything above. Refuses to run once `labels.csv` has labels (`--force` rebuilds the rest and still keeps `labels.csv`). |
| `src/test/quality/judge-validation/score.ts`        | Prints the metrics table. Writes no files.                                                                                       |
