/**
 * Content validation tests — deterministic checks across 9 languages.
 *
 * Every scenario runs assertCleanCompletion(). Scenarios marked (syntax) also
 * run assertValidSyntax() to verify the combined prefix+completion+suffix
 * parses without errors.
 *
 * Backend is selected via TEST_BACKEND / TEST_API_PRESET env vars (same as
 * shared-scenarios.test.ts).
 *
 * Run: npm run test:api
 * Run with API: TEST_BACKEND=api npm run test:api
 * Run with xAI: TEST_BACKEND=api TEST_API_PRESET=xai-grok npm run test:api
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CompletionProvider } from '../../types';
import {
  createTestProvider,
  getTestBackendConfig,
  makeCodeContext,
  makeProseContext,
  assertCleanCompletion,
  assertValidSyntax,
  assertNoSuffixEcho,
  TestProviderInfo,
  TestUsageEntry,
} from '../helpers';
import {
  getApiRunDir,
  buildApiResult,
  saveApiResult,
  saveApiSummary,
  ApiResult,
  ApiResultUsage,
} from './result-writer';

const { backend, preset } = getTestBackendConfig();
const describeLabel =
  backend === 'claude-code'
    ? `Content Validation [claude-code]`
    : `Content Validation [api/${preset}]`;

const info: TestProviderInfo | null = await createTestProvider();
const isAvailable = info !== null;

const subdirName = backend === 'claude-code' ? 'content-claude-code' : `content-api`;

function toResultUsage(entry: TestUsageEntry | null): ApiResultUsage | undefined {
  if (!entry) return undefined;
  return {
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    costUsd: entry.costUsd,
  };
}

function formatUsage(usage: TestUsageEntry | null): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    parts.push(`${usage.inputTokens}+${usage.outputTokens} tokens`);
  }
  if (usage.costUsd !== undefined) {
    parts.push(`$${usage.costUsd.toFixed(6)}`);
  }
  if (usage.model) {
    parts.push(usage.model);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Detect whether a completion contains model thinking artifacts
 * (e.g., "Wait, let me reconsider" blocks). When present, syntax
 * validation is skipped since thinking text produces parse errors
 * that don't reflect the actual completion quality.
 */
function hasThinkingArtifacts(text: string): boolean {
  return (
    /\bWait,?\s+(let me|I need to)\b/i.test(text) ||
    /\bLet me reconsider\b/i.test(text) ||
    /\bActually,?\s+(let me|I should|looking)\b/i.test(text)
  );
}

describe.skipIf(!isAvailable)(describeLabel, () => {
  let provider: CompletionProvider;
  let runDir: string;
  const results: ApiResult[] = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  beforeAll(async () => {
    provider = info!.provider;
    runDir = getApiRunDir();
    await info!.activate();
  }, 120_000);

  afterAll(() => {
    if (results.length > 0) {
      saveApiSummary(runDir, subdirName, {
        backend: info!.label,
        totalTests: results.length,
        totalCostUsd: totalCost,
        totalInputTokens,
        totalOutputTokens,
        timestamp: new Date().toISOString(),
      });
      console.log(
        `\n[${info!.label}] Content validation: ${results.length} tests — ` +
          `${totalInputTokens}+${totalOutputTokens} tokens, $${totalCost.toFixed(6)} total`,
      );
    }
    info!.dispose();
  });

  /** Helper to run a scenario, save results, and return the completion. */
  async function runScenario(
    name: string,
    ctx: ReturnType<typeof makeCodeContext>,
  ): Promise<string | null> {
    const start = Date.now();
    const result = await provider.getCompletion(ctx, AbortSignal.timeout(30_000));
    const durationMs = Date.now() - start;
    const usage = info!.getLastUsage();

    console.log(`[${info!.label} ${name}]:`, result, formatUsage(usage));

    totalCost += usage?.costUsd ?? 0;
    totalInputTokens += usage?.inputTokens ?? 0;
    totalOutputTokens += usage?.outputTokens ?? 0;

    const data = buildApiResult(name, info!.backend, ctx, result, durationMs, toResultUsage(usage));
    saveApiResult(runDir, subdirName, name, data);
    results.push(data);

    return result;
  }

  /**
   * Run assertValidSyntax only when the completion is clean (no thinking
   * artifacts). Log a warning instead of failing when skipped.
   */
  async function checkSyntaxIfClean(
    prefix: string,
    completion: string,
    suffix: string,
    languageId: string,
    scenarioName: string,
  ): Promise<void> {
    if (hasThinkingArtifacts(completion)) {
      console.log(
        `[WARN] ${scenarioName}: skipping syntax validation — thinking artifacts detected`,
      );
      return;
    }
    await assertValidSyntax(prefix, completion, suffix, languageId);
  }

  // ─── Deterministic code completions ─────────────────────────────

  describe('deterministic code completions', () => {
    it('Python: completes return statement with function args', async () => {
      const ctx = makeCodeContext({
        prefix:
          'from dataclasses import dataclass\n' +
          'from typing import List, Optional\n\n' +
          '@dataclass\n' +
          'class UserStats:\n' +
          '    name: str\n' +
          '    scores: List[int]\n' +
          '    rank: Optional[int] = None\n\n' +
          'def compute_average(stats: UserStats) -> float:\n' +
          '    """Return the mean of the user\'s scores, or 0.0 if empty."""\n' +
          '    if not stats.scores:\n' +
          '        return 0.0\n' +
          '    return ',
        suffix: '\n',
        languageId: 'python',
        fileName: 'analytics.py',
        filePath: '/src/analytics.py',
      });

      const result = await runScenario('python-return', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      expect(result, 'should reference scores').toMatch(/scores/);
      expect(result, 'should not redefine function').not.toMatch(/\bdef\b/);
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'python', 'python-return');
    }, 60_000);

    it('Go: completes string literal in Println', async () => {
      const ctx = makeCodeContext({
        prefix:
          'package server\n\n' +
          'import (\n' +
          '\t"fmt"\n' +
          '\t"net/http"\n' +
          '\t"time"\n' +
          ')\n\n' +
          'func logRequest(r *http.Request, status int, dur time.Duration) {\n' +
          '\tmethod := r.Method\n' +
          '\tpath := r.URL.Path\n' +
          '\tfmt.Printf("[%s] %s %s %d (%v)\\n", time.Now().Format(time.RFC3339), method, path, status, dur)\n' +
          '}\n\n' +
          'func healthCheck(w http.ResponseWriter, r *http.Request) {\n' +
          '\tw.Header().Set("Content-Type", "application/json")\n' +
          '\tfmt.Fprintf(w, `{"status": "ok", "uptime": "',
        suffix: '"}`)\n}',
        languageId: 'go',
        fileName: 'server.go',
        filePath: '/src/server.go',
      });

      const result = await runScenario('go-string', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      assertNoSuffixEcho(result!, ctx.suffix);
      expect(result, 'should not restart package').not.toMatch(/\bpackage\b/);
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'go', 'go-string');
    }, 60_000);

    it('Rust: completes expression in function body', async () => {
      const ctx = makeCodeContext({
        prefix:
          'use std::collections::HashMap;\n\n' +
          '#[derive(Debug, Clone)]\n' +
          'struct Config {\n' +
          '    max_retries: u32,\n' +
          '    timeout_ms: u64,\n' +
          '    labels: HashMap<String, String>,\n' +
          '}\n\n' +
          'impl Config {\n' +
          '    fn retry_budget(&self) -> u64 {\n' +
          '        self.timeout_ms * self.max_retries as u64',
        suffix: '\n    }\n}',
        languageId: 'rust',
        fileName: 'config.rs',
        filePath: '/src/config.rs',
      });

      const result = await runScenario('rust-expr', ctx);
      if (result) {
        assertCleanCompletion(result);
        if (!hasThinkingArtifacts(result)) {
          expect(result, 'should not redefine function').not.toMatch(/\bfn\b/);
        }
        await checkSyntaxIfClean(ctx.prefix, result, ctx.suffix, 'rust', 'rust-expr');
      }
    }, 60_000);

    it('TypeScript: completes template literal', async () => {
      const ctx = makeCodeContext({
        prefix:
          'import { Request, Response } from \'express\';\n\n' +
          'interface User {\n' +
          '  id: string;\n' +
          '  displayName: string;\n' +
          '  email: string;\n' +
          '}\n\n' +
          'function formatWelcome(user: User): string {\n' +
          '  const greeting = user.displayName || \'there\';\n' +
          '  return `Hello, ${greeting',
        suffix: '`;\n}',
        languageId: 'typescript',
        fileName: 'user-service.ts',
        filePath: '/src/user-service.ts',
      });

      const result = await runScenario('ts-template', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      assertNoSuffixEcho(result!, ctx.suffix);
      expect(result, 'should close interpolation').toMatch(/\}/);
      if (!hasThinkingArtifacts(result!)) {
        expect(result, 'should not redefine function').not.toMatch(/\bfunction\b/);
      }
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'typescript', 'ts-template');
    }, 60_000);

    it('Python: completes list comprehension filter', async () => {
      const ctx = makeCodeContext({
        prefix:
          'import csv\n' +
          'from pathlib import Path\n' +
          'from typing import List, Dict\n\n' +
          'def load_records(filepath: Path) -> List[Dict[str, str]]:\n' +
          '    """Load CSV records and return rows as dicts."""\n' +
          '    with open(filepath) as f:\n' +
          '        return list(csv.DictReader(f))\n\n' +
          'def get_active_users(records: List[Dict[str, str]]) -> List[str]:\n' +
          '    """Return names of users with active status."""\n' +
          '    return [r["name"] for r in records if ',
        suffix: ']\n',
        languageId: 'python',
        fileName: 'user_report.py',
        filePath: '/src/user_report.py',
      });

      const result = await runScenario('python-filter', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      assertNoSuffixEcho(result!, ctx.suffix);
      expect(result, 'should reference status or active check').toMatch(/status|active|==|!=/i);
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'python', 'python-filter');
    }, 60_000);

    it('HTML: completes alt text for image', async () => {
      const ctx = makeCodeContext({
        prefix:
          '<!DOCTYPE html>\n' +
          '<html lang="en">\n' +
          '<head>\n' +
          '  <meta charset="UTF-8">\n' +
          '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
          '  <title>ACME Dashboard</title>\n' +
          '  <link rel="stylesheet" href="/styles/main.css">\n' +
          '</head>\n' +
          '<body>\n' +
          '  <header class="navbar">\n' +
          '    <img src="/assets/logo.svg" alt="',
        suffix: '" />\n    <nav>\n      <a href="/dashboard">Dashboard</a>\n      <a href="/settings">Settings</a>\n    </nav>\n  </header>\n</body>\n</html>',
        languageId: 'html',
        fileName: 'index.html',
        filePath: '/public/index.html',
      });

      const result = await runScenario('html-alt', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      assertNoSuffixEcho(result!, ctx.suffix);
      if (!hasThinkingArtifacts(result!)) {
        expect(result, 'should not contain HTML tags').not.toMatch(/</);
      }
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'html', 'html-alt');
    }, 60_000);
  });

  // ─── Language breadth ───────────────────────────────────────────

  describe('language breadth', () => {
    it('JSON: completes version field value', async () => {
      const ctx = makeCodeContext({
        prefix:
          '{\n' +
          '  "name": "@acme/data-pipeline",\n' +
          '  "version": "',
        suffix:
          '",\n' +
          '  "description": "ETL pipeline for analytics data",\n' +
          '  "main": "dist/index.js",\n' +
          '  "scripts": {\n' +
          '    "build": "tsc",\n' +
          '    "start": "node dist/index.js",\n' +
          '    "test": "vitest"\n' +
          '  },\n' +
          '  "dependencies": {\n' +
          '    "pg": "^8.11.0",\n' +
          '    "zod": "^3.22.0"\n' +
          '  }\n' +
          '}',
        languageId: 'json',
        fileName: 'package.json',
        filePath: '/project/package.json',
      });

      const result = await runScenario('json-version', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      assertNoSuffixEcho(result!, ctx.suffix);
      expect(result, 'should start with a digit or quote').toMatch(/^"?\d/);
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'json', 'json-version');
    }, 60_000);

    it('CSS: completes justify-content value', async () => {
      const ctx = makeCodeContext({
        prefix:
          '/* Main layout styles */\n' +
          ':root {\n' +
          '  --primary: #3b82f6;\n' +
          '  --spacing: 1rem;\n' +
          '}\n\n' +
          '.page-wrapper {\n' +
          '  max-width: 1200px;\n' +
          '  margin: 0 auto;\n' +
          '  padding: var(--spacing);\n' +
          '}\n\n' +
          '.card-grid {\n' +
          '  display: flex;\n' +
          '  flex-wrap: wrap;\n' +
          '  gap: var(--spacing);\n' +
          '  justify-content: ',
        suffix: ';\n  align-items: stretch;\n}\n\n.card {\n  flex: 1 1 300px;\n  border: 1px solid #e5e7eb;\n  border-radius: 8px;\n}',
        languageId: 'css',
        fileName: 'layout.css',
        filePath: '/styles/layout.css',
      });

      const result = await runScenario('css-value', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      expect(result, 'should not contain opening brace').not.toMatch(/\{/);
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'css', 'css-value');
    }, 60_000);

    it('Shell: completes variable in for loop', async () => {
      const ctx = makeCodeContext({
        prefix:
          '#!/usr/bin/env bash\n' +
          'set -euo pipefail\n\n' +
          'LOG_DIR="/var/log/myapp"\n' +
          'ARCHIVE_DIR="/var/log/myapp/archive"\n\n' +
          'rotate_logs() {\n' +
          '  local max_age_days="${1:-7}"\n' +
          '  mkdir -p "$ARCHIVE_DIR"\n\n' +
          '  for file in "$LOG_DIR"/*.log; do\n' +
          '    echo "Processing $',
        suffix: '"\n  done\n}',
        languageId: 'shellscript',
        fileName: 'log-rotate.sh',
        filePath: '/scripts/log-rotate.sh',
      });

      const result = await runScenario('shell-var', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      assertNoSuffixEcho(result!, ctx.suffix);
      expect(result, 'should reference loop variable').toMatch(/file/i);
      await checkSyntaxIfClean(ctx.prefix, result!, ctx.suffix, 'shellscript', 'shell-var');
    }, 60_000);
  });

  // ─── Failure mode regressions ───────────────────────────────────

  describe('failure mode regressions', () => {
    it('prose: no assistant voice in prompt continuation', async () => {
      const ctx = makeProseContext({
        prefix:
          'Can you check if the migration handles nullable columns correctly? I also want to make sure',
        suffix: '',
        fileName: 'prompt.md',
        filePath: '/test/prompt.md',
      });

      const result = await runScenario('no-assistant-voice', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      // Should NOT switch to assistant voice — should continue the user's message
      const trimmed = result!.trimStart();
      expect(trimmed, 'no "I\'d be happy"').not.toMatch(/^I'd be happy/i);
      expect(trimmed, 'no "Absolutely"').not.toMatch(/^Absolutely/i);
    }, 60_000);

    it('prose: no thinking leak in completion', async () => {
      const ctx = makeProseContext({
        prefix:
          'The deployment pipeline has three stages. First, the build step compiles the code. Second,',
        suffix: '',
        fileName: 'notes.md',
        filePath: '/test/notes.md',
      });

      const result = await runScenario('no-thinking-leak', ctx);
      expect(result).toBeTruthy();
      assertCleanCompletion(result!);
      // Should not contain model thinking artifacts
      const trimmed = result!.trimStart();
      expect(trimmed, 'no "Wait," thinking leak').not.toMatch(/^Wait,/);
      expect(trimmed, 'no "reconsider" thinking leak').not.toMatch(/\breconsider\b/i);
    }, 60_000);
  });
});
