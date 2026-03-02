import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { expect } from 'vitest';
import * as ts from 'typescript';
import { CompletionContext, CompletionProvider, DEFAULT_MODEL, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { UsageLedger } from '../utils/usage-ledger';
import { extractCompletion, WARMUP_EXPECTED } from '../providers/claude-code';

const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  mode: 'auto',
  backend: 'claude-code',
  triggerPreset: 'relaxed',
  triggerMode: 'auto',
  debounceMs: 2000,
  prose: {
    contextChars: 2500,
    suffixChars: 2000,
    fileTypes: [],
  },
  code: {
    contextChars: 2500,
    suffixChars: 2000,
  },
  claudeCode: { model: DEFAULT_MODEL, models: ['haiku', 'sonnet', 'opus'] },
  api: {
    preset: 'anthropic-haiku',
    customPresets: [],
  },
  codeOverride: { backend: '', model: '' },
  contextMenu: { permissionMode: 'default' },
  logLevel: 'info',
};

export function makeConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    claudeCode: { ...DEFAULT_CONFIG.claudeCode, ...overrides.claudeCode },
    api: { ...DEFAULT_CONFIG.api, ...overrides.api },
    codeOverride: { ...DEFAULT_CONFIG.codeOverride, ...overrides.codeOverride },
    prose: { ...DEFAULT_CONFIG.prose, ...overrides.prose },
    code: { ...DEFAULT_CONFIG.code, ...overrides.code },
    contextMenu: { ...DEFAULT_CONFIG.contextMenu, ...overrides.contextMenu },
  };
}

/** No-op Logger for unit tests (avoids vscode dependency) */
export function makeLogger(): Logger {
  return {
    setLevel: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    error: () => {},
    requestStart: () => {},
    requestEnd: () => {},
    cacheHit: () => {},
    traceBlock: () => {},
    traceInline: () => {},
    show: () => {},
    dispose: () => {},
  } as unknown as Logger;
}

/** Logger that captures traceBlock calls for inspecting raw provider output */
export function makeCapturingLogger(): {
  logger: Logger;
  getTrace: (label: string) => string | undefined;
} {
  const traces = new Map<string, string>();
  const logger = {
    ...makeLogger(),
    traceBlock: (label: string, content: string) => {
      traces.set(label, content);
    },
  } as unknown as Logger;
  return { logger, getTrace: (label) => traces.get(label) };
}

export function makeProseContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    prefix: 'The quick brown fox jumped over the lazy dog and then',
    suffix: '',
    languageId: 'markdown',
    fileName: 'story.md',
    filePath: '/test/story.md',
    mode: 'prose',
    ...overrides,
  };
}

export function makeCodeContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    prefix: 'function add(a: number, b: number) {\n  return ',
    suffix: '\n}',
    languageId: 'typescript',
    fileName: 'math.ts',
    filePath: '/test/math.ts',
    mode: 'code',
    ...overrides,
  };
}

interface MockToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

/** Minimal mock TextDocument for unit tests. */
export interface MockDocument {
  getText: (range?: unknown) => string;
  lineAt: (line: number) => { text: string; range: { end: { line: number; character: number } } };
  positionAt: (offset: number) => { line: number; character: number };
  offsetAt: (position: { line: number; character: number }) => number;
  lineCount: number;
  languageId: string;
  fileName: string;
}

/**
 * Creates a mock TextDocument for unit tests.
 * Supports getText, lineAt, positionAt, offsetAt, and common properties.
 */
export function makeDocument(
  content: string,
  options?: { languageId?: string; fileName?: string },
): MockDocument {
  const lines = content.split('\n');
  const languageId = options?.languageId ?? 'plaintext';
  const fileName = options?.fileName ?? 'test.txt';

  return {
    getText: (range?: unknown) => {
      if (!range) return content;
      // Cast to expected range type
      const r = range as {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      const startOffset =
        lines.slice(0, r.start.line).reduce((acc, l) => acc + l.length + 1, 0) + r.start.character;
      const endOffset =
        lines.slice(0, r.end.line).reduce((acc, l) => acc + l.length + 1, 0) + r.end.character;
      return content.slice(startOffset, endOffset);
    },
    lineAt: (line: number) => ({
      text: lines[line] ?? '',
      range: { end: { line, character: (lines[line] ?? '').length } },
    }),
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return { line: i, character: remaining };
        }
        remaining -= lines[i].length + 1; // +1 for newline
      }
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    },
    offsetAt: (position: { line: number; character: number }) => {
      let offset = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1;
      }
      return offset + position.character;
    },
    lineCount: lines.length,
    languageId,
    fileName,
  };
}

export function createMockToken(): MockToken & { cancel: () => void } {
  let listener: (() => void) | null = null;
  return {
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => {
      listener = cb;
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
    cancel() {
      this.isCancellationRequested = true;
      listener?.();
    },
  };
}

/** Create a UsageLedger backed by a temp directory. Returns the ledger and its file path. */
export function makeLedger(dir?: string): { ledger: UsageLedger; filePath: string } {
  const tmpDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bespoke-ledger-'));
  const filePath = path.join(tmpDir, 'usage-ledger.jsonl');
  const ledger = new UsageLedger(filePath, makeLogger());
  return { ledger, filePath };
}

/**
 * Assert that warmup responses captured by a capturing logger are valid.
 * Checks slot 0 trace — skips if not captured.
 */
export function assertWarmupValid(getTrace: (label: string) => string | undefined): void {
  const slotIndex = 0;
  const raw = getTrace(`warmup ← recv (slot ${slotIndex})`);
  if (raw === undefined) {
    return;
  }
  const extracted = extractCompletion(raw);
  expect(
    extracted.trim().toLowerCase(),
    `warmup slot ${slotIndex}: expected "${WARMUP_EXPECTED}"`,
  ).toBe(WARMUP_EXPECTED);
}

/** Type for fake stream returned by makeFakeStream */
export interface FakeStream {
  stream: AsyncIterable<unknown>;
  signalPush: () => void;
  terminate: () => void;
}

/**
 * Creates a fake async iterable stream that yields a warmup result,
 * then N real results. Each result after the warmup blocks
 * until signalPush() is called. After all messages are consumed, blocks
 * indefinitely (like the real SDK stream) until terminate() is called.
 */
export function makeFakeStream(
  resultTexts: string | string[],
  warmupResponse: string,
  activeStreams?: FakeStream[],
): FakeStream {
  const texts = Array.isArray(resultTexts) ? resultTexts : [resultTexts];
  const messages = [
    { type: 'result', subtype: 'success', result: warmupResponse },
    ...texts.map((t) => ({ type: 'result', subtype: 'success', result: t })),
  ];

  let index = 0;
  const waitQueue: (() => void)[] = [];
  // Start at -1 to absorb the warmup signalPush from consumeIterable
  let pushCount = -1;
  let terminated = false;

  function resolveNextWaiter() {
    const waiter = waitQueue.shift();
    if (waiter) {
      waiter();
    }
  }

  const fakeStream: FakeStream = {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (terminated) {
              return { value: undefined, done: true };
            }

            if (index >= messages.length) {
              await new Promise<void>((r) => {
                waitQueue.push(r);
              });
              return { value: undefined, done: true };
            }

            if (index >= 1) {
              if (pushCount <= 0) {
                await new Promise<void>((r) => {
                  waitQueue.push(r);
                });
                if (terminated) {
                  return { value: undefined, done: true };
                }
              }
              pushCount--;
            }

            const value = messages[index++];
            return { value, done: false };
          },
          async return(): Promise<IteratorResult<unknown>> {
            terminated = true;
            return { value: undefined, done: true };
          },
        };
      },
    },
    /** Signal that a message was pushed (unblocks the stream for the next result) */
    signalPush() {
      pushCount++;
      resolveNextWaiter();
    },
    /** Terminate the stream (unblocks any waiting next() calls) */
    terminate() {
      terminated = true;
      while (waitQueue.length > 0) {
        resolveNextWaiter();
      }
    },
  };

  activeStreams?.push(fakeStream);
  return fakeStream;
}

/** Return the model to use in integration/quality tests.
 *  Precedence: TEST_MODEL > QUALITY_TEST_MODEL (backward compat) > DEFAULT_MODEL. */
export function getTestModel(): string {
  return (
    process.env.TEST_MODEL || process.env.QUALITY_TEST_MODEL || DEFAULT_CONFIG.claudeCode.model
  );
}

/** Assert that the provider's lastUsedModel matches the expected test model.
 *  Skips silently when no completion was made (activation-only tests). */
export function assertModelMatch(
  provider: { lastUsedModel: string | null },
  expectedModel?: string,
): void {
  const expected = expectedModel ?? getTestModel();
  const actual = provider.lastUsedModel;
  if (!actual) return; // no completion was made
  expect(actual.toLowerCase()).toContain(expected.toLowerCase());
}

/** Helper: consume async iterable in background, signaling the fake stream on each message */
export function consumeIterable(iterable: AsyncIterable<unknown>, fakeStream: FakeStream): void {
  (async () => {
    for await (const _msg of iterable) {
      fakeStream.signalPush();
    }
  })().catch(() => {
    /* channel closed */
  });
}

// ─── Backend-agnostic test provider factory ─────────────────────

/** Usage data from the last provider request, read from the temp ledger. */
export interface TestUsageEntry {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** Info returned by createTestProvider(). */
export interface TestProviderInfo {
  provider: CompletionProvider;
  /** Human-readable label, e.g. "claude-code/haiku" or "api/anthropic-haiku". */
  label: string;
  backend: 'claude-code' | 'api';
  /** Call in beforeAll — activates Claude Code pool (no-op for API). */
  activate: () => Promise<void>;
  /** Call in afterAll — cleans up resources. */
  dispose: () => void;
  /** Read the last usage entry recorded by the provider. Returns null if no entry. */
  getLastUsage: () => TestUsageEntry | null;
}

/**
 * Read the test backend configuration from environment variables.
 *
 * - `TEST_BACKEND` — `claude-code` (default) or `api`
 * - `TEST_API_PRESET` — preset ID when using API backend (default: `anthropic-haiku`)
 */
export function getTestBackendConfig(): { backend: 'claude-code' | 'api'; preset: string } {
  const raw = process.env.TEST_BACKEND ?? 'claude-code';
  if (raw !== 'claude-code' && raw !== 'api') {
    throw new Error(`Invalid TEST_BACKEND="${raw}". Must be "claude-code" or "api".`);
  }
  const preset = process.env.TEST_API_PRESET ?? 'anthropic-haiku';
  return { backend: raw, preset };
}

/**
 * Create a CompletionProvider for integration tests based on env vars.
 *
 * Returns `null` when the required backend is unavailable (missing SDK or API key).
 *
 * Usage:
 *   const info = await createTestProvider();
 *   if (!info) return;  // skip
 *   await info.activate();  // no-op for API
 *   const result = await info.provider.getCompletion(ctx, signal);
 *   info.dispose();
 */
/** Read the last JSONL line from a ledger file and extract usage fields. */
function readLastLedgerEntry(filePath: string): TestUsageEntry | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    const entry = JSON.parse(lines[lines.length - 1]);
    return {
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      costUsd: entry.costUsd,
      durationMs: entry.durationMs,
    };
  } catch {
    return null;
  }
}

export async function createTestProvider(logger?: Logger): Promise<TestProviderInfo | null> {
  const { backend, preset } = getTestBackendConfig();
  const log = logger ?? makeLogger();

  if (backend === 'claude-code') {
    // Dynamic import — module may not be installed
    let sdkAvailable = false;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const queryFn = sdk.query ?? sdk.default?.query;
      sdkAvailable = typeof queryFn === 'function';
    } catch {
      sdkAvailable = false;
    }
    if (!sdkAvailable) return null;

    const { ClaudeCodeProvider } = await import('../providers/claude-code');
    const config = makeConfig({
      claudeCode: { model: getTestModel(), models: ['haiku', 'sonnet', 'opus'] },
    });
    const provider = new ClaudeCodeProvider(config, log);
    const { ledger, filePath: ledgerPath } = makeLedger();
    provider.setLedger(ledger);

    return {
      provider,
      label: `claude-code/${getTestModel()}`,
      backend: 'claude-code',
      activate: () => provider.activate(),
      dispose: () => provider.dispose(),
      getLastUsage: () => readLastLedgerEntry(ledgerPath),
    };
  }

  if (backend === 'api') {
    const { clearApiKeyCache } = await import('../utils/api-key-store');
    const { ApiCompletionProvider } = await import('../providers/api/api-provider');
    clearApiKeyCache();

    const { ledger, filePath: ledgerPath } = makeLedger();
    const config = makeConfig({
      backend: 'api',
      api: { preset, customPresets: [] },
    });
    const provider = new ApiCompletionProvider(config, log, ledger);

    if (!provider.isAvailable()) return null;

    return {
      provider,
      label: `api/${preset}`,
      backend: 'api',
      activate: async () => {}, // API providers are ready immediately
      dispose: () => provider.dispose(),
      getLastUsage: () => readLastLedgerEntry(ledgerPath),
    };
  }

  return null;
}

// ─── Content validation helpers ─────────────────────────────────

/**
 * Scaffolding patterns — these are prompt construction artifacts that
 * should NEVER appear in user-facing completions. Checked across the
 * entire completion string.
 */
const SCAFFOLDING_PATTERNS = [
  { pattern: /<\/?COMPLETION>/, label: '<COMPLETION> tag' },
  { pattern: /\{\{FILL_HERE\}\}/, label: '{{FILL_HERE}} marker' },
  { pattern: /<\/?document>/, label: '<document> tag' },
];

/**
 * Preamble phrases that indicate the model switched to assistant voice.
 * Only checked at the very start of the completion (after trimming
 * whitespace) to avoid false positives from model thinking artifacts
 * that appear later in the output.
 */
const PREAMBLE_PHRASES = [
  /^Sure[,!.]/i,
  /^Here'?s\b/i,
  /^Here is\b/i,
  /^Absolutely[,!.]/i,
  /^Of course[,!.]/i,
  /^Got it[,!.]/i,
  /^Understood[,!.]/i,
  /^I'd be happy\b/i,
  /^Let me\b/i,
  /^I can\b/i,
  /^I'll\b/i,
];

/**
 * Assert completion has no tag leaks, scaffolding, or leading preambles.
 *
 * - Scaffolding tags (COMPLETION, FILL_HERE, document) are checked across
 *   the entire string — these are always bugs.
 * - Code fences are checked only at the very start — fences within model
 *   thinking text deeper in the completion are not flagged.
 * - Assistant preambles are checked only against the trimmed start — this
 *   avoids false positives from "Wait, let me reconsider" thinking blocks
 *   that some models produce after the actual completion content.
 */
export function assertCleanCompletion(result: string): void {
  for (const { pattern, label } of SCAFFOLDING_PATTERNS) {
    expect(result, `Leaked scaffolding: ${label}`).not.toMatch(pattern);
  }
  // Fence check: only at the very start of the completion
  expect(result, 'Completion starts with code fence').not.toMatch(/^```/);
  // Preamble check: only at the trimmed start
  const trimmed = result.trimStart();
  for (const pattern of PREAMBLE_PHRASES) {
    expect(trimmed, `Assistant preamble at start: ${pattern}`).not.toMatch(pattern);
  }
}

// ─── Tree-sitter language loaders (lazy, cached) ────────────────

type TreeSitterParser = {
  setLanguage(lang: unknown): void;
  parse(input: string): { rootNode: { toString(): string } };
};

/** Cache of loaded tree-sitter language grammars. */
const treeSitterCache = new Map<string, unknown>();

/**
 * Dynamically load a tree-sitter language grammar.
 * Returns null if the package isn't installed.
 */
async function loadTreeSitterLang(languageId: string): Promise<unknown | null> {
  if (treeSitterCache.has(languageId)) return treeSitterCache.get(languageId)!;

  const pkgMap: Record<string, string> = {
    python: 'tree-sitter-python',
    go: 'tree-sitter-go',
    rust: 'tree-sitter-rust',
    html: 'tree-sitter-html',
    css: 'tree-sitter-css',
    shellscript: 'tree-sitter-bash',
    bash: 'tree-sitter-bash',
  };

  const pkg = pkgMap[languageId];
  if (!pkg) return null;

  try {
    const mod = await import(pkg);
    const lang = mod.default ?? mod;
    treeSitterCache.set(languageId, lang);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Parse prefix + completion + suffix and check for syntax errors.
 *
 * Uses tree-sitter for Python/Go/Rust/HTML/CSS/Bash/Shell,
 * TypeScript compiler API for TS/JS, JSON.parse for JSON.
 *
 * Call only on scenarios where the combined text is expected to be
 * syntactically valid — not all prefix+suffix combos form complete files.
 */
export async function assertValidSyntax(
  prefix: string,
  completion: string,
  suffix: string,
  languageId: string,
): Promise<void> {
  const full = prefix + completion + suffix;

  // TypeScript / JavaScript — use the TS compiler parser
  if (languageId === 'typescript' || languageId === 'javascript') {
    const scriptKind = languageId === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(
      'test.ts',
      full,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const msgs = diagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
        .join('; ');
      expect.fail(`TypeScript parse errors: ${msgs}\n\nFull text:\n${full}`);
    }
    return;
  }

  // JSON — use built-in JSON.parse
  if (languageId === 'json' || languageId === 'jsonc') {
    try {
      JSON.parse(full);
    } catch (e) {
      expect.fail(`JSON parse error: ${(e as Error).message}\n\nFull text:\n${full}`);
    }
    return;
  }

  // Tree-sitter languages
  const lang = await loadTreeSitterLang(languageId);
  if (!lang) {
    // Language not supported — skip silently
    return;
  }

  const Parser = (await import('tree-sitter')).default ?? (await import('tree-sitter'));
  const parser = new Parser() as TreeSitterParser;
  parser.setLanguage(lang);

  const tree = parser.parse(full);
  const sExpr = tree.rootNode.toString();

  if (sExpr.includes('ERROR') || sExpr.includes('MISSING')) {
    expect.fail(
      `Syntax errors in ${languageId} parse tree.\n\nS-expression (first 500 chars):\n${sExpr.slice(0, 500)}\n\nFull text:\n${full}`,
    );
  }
}
