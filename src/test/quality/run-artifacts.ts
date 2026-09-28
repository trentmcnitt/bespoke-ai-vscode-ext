/**
 * Per-scenario check artifacts and run provenance for quality runs.
 *
 * Shared by the Layer 1 runner (completion-quality.test.ts) and the
 * rescore script, so both write identical files. No vitest imports.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  CheckInput,
  CheckResult,
  renderJoin,
  runDeterministicChecks,
} from './deterministic-checks';
import {
  CompletionWithDetail,
  GenerationDetail,
  detailFromError,
  errorTypeOf,
  nullResultOutcome,
} from '../../utils/trace';

export const RUBRIC_PATH = path.join(__dirname, 'validator-prompt.md');

/**
 * Run the deterministic checks for one scenario and write `checks.json`
 * and `rendered.txt` (the join the judge must read) into its folder.
 */
export function writeCheckArtifacts(scenarioDir: string, input: CheckInput): CheckResult[] {
  const checks = runDeterministicChecks(input);
  fs.writeFileSync(
    path.join(scenarioDir, 'checks.json'),
    JSON.stringify({ pass: checks.every((c) => c.pass), checks }, null, 2),
  );
  fs.writeFileSync(
    path.join(scenarioDir, 'rendered.txt'),
    renderJoin(input.prefix, input.completion, input.suffix),
  );
  return checks;
}

/** sha256 of a file, first 12 hex chars; null if unreadable. */
export function fileHash12(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export interface GitProvenance {
  commit: string | null;
  dirty: boolean | null;
}

export function gitProvenance(cwd: string): GitProvenance {
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const commit = git('rev-parse', 'HEAD');
    let dirty: boolean | null = null;
    try {
      dirty = git('status', '--porcelain').length > 0;
    } catch {
      /* leave null */
    }
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

export interface RunProvenance {
  gitCommit: string | null;
  gitDirty: boolean | null;
  date: string;
  backend: string;
  model: string;
  preset: string | null;
  rubricSha256: string | null;
}

export function collectProvenance(opts: {
  repoRoot: string;
  backend: string;
  model: string;
  preset: string | null;
  rubricPath?: string;
  now?: Date;
}): RunProvenance {
  const git = gitProvenance(opts.repoRoot);
  return {
    gitCommit: git.commit,
    gitDirty: git.dirty,
    date: (opts.now ?? new Date()).toISOString(),
    backend: opts.backend,
    model: opts.model,
    preset: opts.preset,
    rubricSha256: fileHash12(opts.rubricPath ?? RUBRIC_PATH),
  };
}

export type RunOutcome = 'ok' | 'empty' | 'error' | 'aborted';

export interface RunAttribution {
  outcome: RunOutcome;
  errorType?: string;
  /** Set for thrown AND swallowed failures, so the scenario is not scored as an empty completion. */
  error?: string;
}

/**
 * Fill outcome / errorType / error from a provider result, the same way the
 * orchestrator attributes a null (see nullResultOutcome). Before this, the
 * runner called getCompletion() and a swallowed 429 was saved as an ordinary
 * empty completion with `error: null`.
 */
export function attributeResult(res: CompletionWithDetail): RunAttribution {
  if (res.text !== null) return { outcome: 'ok' };
  const outcome = nullResultOutcome(res.detail);
  if (outcome === 'empty') return { outcome };
  const errorType = res.detail?.errorType ?? 'aborted';
  return {
    outcome,
    errorType,
    error: `no completion: ${outcome} (${errorType}) swallowed by the provider`,
  };
}

export function attributeThrown(err: unknown): RunAttribution {
  return {
    outcome: 'error',
    errorType: detailFromError(err)?.errorType ?? errorTypeOf(err),
    error: err instanceof Error ? err.message : String(err),
  };
}

/** The provider fields worth keeping per scenario (no content). */
export function detailSummary(d: GenerationDetail | undefined) {
  if (!d) return null;
  return {
    responseModel: d.responseModel ?? null,
    finishReason: d.finishReason ?? null,
    inputTokens: d.inputTokens ?? null,
    outputTokens: d.outputTokens ?? null,
    cacheReadTokens: d.cacheReadTokens ?? null,
    durationApiMs: d.durationApiMs ?? null,
  };
}
