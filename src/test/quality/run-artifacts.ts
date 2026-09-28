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
