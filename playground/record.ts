/**
 * Record playground runs for static replay (trentmcnitt.com/agentlabs).
 *
 *   npm run playground:record                 (keys from the environment)
 *   npm run playground:record -- <scenario-id> [...]   (only these scenarios)
 *   npm run playground:record -- --preset=<id> [...]    (only these presets)
 *
 * Runs each scenario × preset below once through the real pipeline (complete.ts)
 * and writes playground/recordings/:
 *   - <scenario>__<preset>.recording.jsonl: bench recording (header + events, SPEC §3)
 *   - index.json: what the replay page needs (documents, ghost text, results)
 *
 * Only ids from the synthetic scenario list can be recorded; there is no way to
 * record typed text, because the recordings are published with content_mode "full".
 * Results are kept as they came back, failed checks included.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getPreset } from '../src/providers/api/presets';
import { complete, disposeProviders } from './complete';
import { scenarioById, checkFlagsFor } from './scenarios';

/** What the replay page's picker shows for each recorded scenario. */
export const SCENARIO_LABELS: Record<string, string> = {
  'prose-journal-jnl-personal-mix': 'Prose · personal journal',
  'prose-prompt-short-question-continue': 'Prose · writing a prompt',
  'prose-bridge-large-detail': 'Prose · mid-document paragraph',
  'code-mid-file-ts-handler-full': 'Code · TypeScript route handler',
  'code-py-class-method': 'Code · Python class method',
  'code-mid-file-go-full': 'Code · Go service method',
};

/** 3 prose (journal, prompt writing, mid-document) and 3 code, per orchestrator/Trent 2026-09-29. */
export const RECORDED_SCENARIOS = [
  'prose-journal-jnl-personal-mix',
  'prose-prompt-short-question-continue',
  'prose-bridge-large-detail',
  'code-mid-file-ts-handler-full',
  'code-py-class-method',
  'code-mid-file-go-full',
];

/** Grok first: Trent's pick for the default (2026-09-29); xai-grok is grok-4.3, reasoning off, since 0.8.17. */
export const RECORDED_PRESETS = [
  'xai-grok',
  'anthropic-sonnet',
  'anthropic-haiku',
  'openai-gpt-4.1-nano',
  'google-gemini-flash',
];

/** The editor's typing pause in the recording (the "relaxed" trigger is 2 s; eager reads better). */
const DEBOUNCE_MS = 800;
const OUT = join(__dirname, 'recordings');

export interface ReplayRun {
  id: string;
  scenarioId: string;
  presetId: string;
  presetName: string;
  model?: string;
  text: string | null;
  outcome: string;
  errorType?: string;
  latencyMs: number;
  costUsd?: number;
  checks: Array<{ id: string; pass: boolean; detail: string }>;
  recordedAt: string;
  recording: string;
}

export interface ReplayIndex {
  v: 'bespoke-replay/0';
  scenarios: Record<
    string,
    {
      label: string;
      description: string;
      mode: 'prose' | 'code';
      languageId: string;
      fileName: string;
      prefix: string;
      suffix: string;
    }
  >;
  runs: ReplayRun[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const presetArgs = args.filter((a) => a.startsWith('--preset=')).map((a) => a.slice(9));
  const only = args.filter((a) => !a.startsWith('--'));
  for (const p of presetArgs) {
    if (!RECORDED_PRESETS.includes(p)) throw new Error(`not a recorded preset: ${p}`);
  }
  const presetIds = presetArgs.length ? presetArgs : RECORDED_PRESETS;
  for (const id of [...only, ...RECORDED_SCENARIOS]) {
    if (!scenarioById.has(id)) throw new Error(`not a synthetic scenario: ${id}`);
  }
  const scenarioIds = only.length ? only : RECORDED_SCENARIOS;
  const topology = JSON.parse(readFileSync(join(__dirname, 'topology.json'), 'utf8'));
  mkdirSync(OUT, { recursive: true });

  const indexPath = join(OUT, 'index.json');
  const index: ReplayIndex = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { v: 'bespoke-replay/0', scenarios: {}, runs: [] };

  let total = 0;
  for (const scenarioId of scenarioIds) {
    const s = scenarioById.get(scenarioId)!;
    index.scenarios[scenarioId] = {
      label: SCENARIO_LABELS[scenarioId] ?? scenarioId,
      description: s.description,
      mode: s.mode,
      languageId: s.languageId,
      fileName: s.fileName,
      prefix: s.prefix,
      suffix: s.suffix,
    };
    for (const presetId of presetIds) {
      const preset = getPreset(presetId);
      if (!preset) throw new Error(`unknown preset ${presetId}`);
      const id = `${scenarioId}__${presetId}`;
      // A real typing pause before the request, so the recording's queue step is honest.
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
      const { response, events } = await complete(
        {
          presetId,
          prefix: s.prefix,
          suffix: s.suffix,
          languageId: s.languageId,
          fileName: s.fileName,
          sessionId: 'recording',
          debounceMs: DEBOUNCE_MS,
          label: `${scenarioId} · ${preset.displayName}`,
          checkFlags: checkFlagsFor(s),
        },
        AbortSignal.timeout(30_000),
      );
      const file = `${id}.recording.jsonl`;
      const header = { v: 'bench-recording/0', topology, story: null };
      writeFileSync(
        join(OUT, file),
        [header, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n',
      );
      const run: ReplayRun = {
        id,
        scenarioId,
        presetId,
        presetName: preset.displayName,
        model: response.model,
        text: response.text,
        outcome: response.outcome,
        errorType: response.errorType,
        latencyMs: response.latencyMs,
        costUsd: response.costUsd,
        checks: response.checks,
        recordedAt: new Date().toISOString(),
        recording: file,
      };
      index.runs = index.runs.filter((r) => r.id !== id).concat(run);
      total += response.costUsd ?? 0;
      const failed = response.checks.filter((c) => !c.pass).map((c) => c.id);
      console.log(
        `${id}: ${response.outcome} ${response.latencyMs}ms` +
          (failed.length ? ` FAILED ${failed.join(',')}` : '') +
          ` ${JSON.stringify((response.text ?? '').slice(0, 60))}`,
      );
    }
  }
  // Play order: the scenario list, then the preset list (flagship first).
  const rank = (list: string[], v: string) => list.indexOf(v) + 1 || list.length + 1;
  index.runs.sort(
    (a, b) =>
      rank(RECORDED_SCENARIOS, a.scenarioId) - rank(RECORDED_SCENARIOS, b.scenarioId) ||
      rank(RECORDED_PRESETS, a.presetId) - rank(RECORDED_PRESETS, b.presetId),
  );
  writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');
  console.log(`wrote ${OUT} — estimated spend $${total.toFixed(4)}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disposeProviders);
