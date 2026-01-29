import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { OracleConfig, OracleStatus, ContextBrief } from './types';
import { ContextBriefStore } from './context-brief-store';

const ORACLE_SYSTEM_PROMPT = `You are a code analysis assistant that outputs structured JSON. You MUST output ONLY valid JSON with no other text, no markdown fences, no explanation.

You have access to Read, Grep, and Glob tools to explore the project.

Your output MUST match this EXACT schema — use these EXACT field names:

{
  "filePath": "<the file path given>",
  "generatedAt": <Date.now() timestamp>,
  "language": "<language ID>",
  "imports": [{ "module": "<import path>", "provides": "<what it provides>" }],
  "typeContext": [{ "name": "<type name>", "signature": "<type signature>" }],
  "patterns": ["<observed coding pattern>"],
  "relatedSymbols": [{ "name": "<symbol name>", "description": "<what it does>", "signature": "<type signature>" }],
  "projectSummary": "<one-sentence project description>"
}

Rules:
- imports: List each import/require with the module path and a brief description of what it provides
- typeContext: List type/interface signatures that are used or referenced in this file
- patterns: Note naming conventions, error handling patterns, architectural patterns
- relatedSymbols: List exported functions/classes from imported modules that this file uses
- projectSummary: One sentence describing the project based on what you can see
- ALL arrays must be present (use empty arrays if nothing found)
- Output ONLY the JSON object, nothing else`;

function buildAnalysisPrompt(filePath: string, fileContent: string, languageId: string): string {
  return `Analyze this file for inline completion context. The file content is below — do NOT re-read it.
Only use tools to look up imported modules' type signatures (Read the specific files referenced in imports). Do not explore broadly — be targeted.
Limit yourself to at most 3 tool calls total.

File: ${filePath}
Language: ${languageId}

\`\`\`${languageId}
${fileContent}
\`\`\`

Now output ONLY the ContextBrief JSON. No other text.`;
}

function parseResponse(text: string, filePath: string): ContextBrief | null {
  try {
    // Strip markdown fences if the model included them despite instructions
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(cleaned);

    // The model may use our exact schema or its own preferred structure.
    // Extract what we can from either format.
    return {
      filePath: parsed.filePath ?? filePath,
      generatedAt: parsed.generatedAt ?? Date.now(),
      language: parsed.language ?? '',
      imports: extractImports(parsed),
      typeContext: extractTypeContext(parsed),
      patterns: extractPatterns(parsed),
      relatedSymbols: extractRelatedSymbols(parsed),
      projectSummary: extractSummary(parsed),
    };
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImports(parsed: any): ContextBrief['imports'] {
  if (Array.isArray(parsed.imports) && parsed.imports.length > 0 && parsed.imports[0]?.module) {
    return parsed.imports;
  }
  const deps: ContextBrief['imports'] = [];
  for (const key of ['dependencies', 'internalDependencies', 'externalDependencies', 'requiredModules']) {
    const val = parsed[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') {
          deps.push({ module: item, provides: '' });
        } else if (item && (item.module || item.name || item.path || item.source)) {
          deps.push({
            module: item.module ?? item.path ?? item.source ?? item.name ?? '',
            provides: item.provides ?? item.description ?? item.purpose ?? item.usage ?? '',
          });
        }
      }
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      for (const subArr of Object.values(val)) {
        if (Array.isArray(subArr)) {
          for (const item of subArr) {
            if (typeof item === 'string') {
              deps.push({ module: item, provides: '' });
            } else if (item && (item.module || item.name || item.path)) {
              deps.push({
                module: item.module ?? item.path ?? item.name ?? '',
                provides: item.provides ?? item.description ?? item.purpose ?? '',
              });
            }
          }
        }
      }
    }
  }
  return deps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTypeContext(parsed: any): ContextBrief['typeContext'] {
  if (Array.isArray(parsed.typeContext) && parsed.typeContext.length > 0 && parsed.typeContext[0]?.name) {
    return parsed.typeContext;
  }
  const types: ContextBrief['typeContext'] = [];
  for (const key of ['keyTypes', 'keyComponents', 'types', 'primaryExports', 'mainExports', 'exports', 'codeStructure']) {
    const val = parsed[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') {
          types.push({ name: item, signature: '' });
        } else if (item && item.name) {
          types.push({
            name: item.name,
            signature: item.signature ?? item.type ?? item.kind ?? item.description ?? '',
          });
        }
      }
    }
  }
  return types;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPatterns(parsed: any): string[] {
  if (Array.isArray(parsed.patterns)) {
    return parsed.patterns.map(itemToString);
  }
  for (const key of ['notes', 'conventions', 'usagePatterns', 'keyDetails', 'notableImplementationDetails']) {
    if (Array.isArray(parsed[key])) {
      return parsed[key].map(itemToString);
    }
  }
  return [];
}

function itemToString(p: unknown): string {
  if (typeof p === 'string') { return p; }
  if (p && typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    return String(obj.name ?? obj.pattern ?? obj.description ?? JSON.stringify(p));
  }
  return JSON.stringify(p);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRelatedSymbols(parsed: any): ContextBrief['relatedSymbols'] {
  if (Array.isArray(parsed.relatedSymbols) && parsed.relatedSymbols.length > 0 && parsed.relatedSymbols[0]?.name) {
    return parsed.relatedSymbols;
  }
  const symbols: ContextBrief['relatedSymbols'] = [];
  for (const key of ['usedBy', 'relatedContext', 'relatedFiles', 'configSurface', 'testCoverage', 'architecture']) {
    const val = parsed[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') {
          symbols.push({ name: item, description: '', signature: '' });
        } else if (item && (item.name || item.file)) {
          symbols.push({
            name: item.name ?? item.file ?? '',
            description: item.description ?? item.purpose ?? item.role ?? '',
            signature: item.signature ?? item.type ?? '',
          });
        }
      }
    } else if (typeof val === 'string') {
      symbols.push({ name: key, description: val, signature: '' });
    }
  }
  return symbols;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSummary(parsed: any): string {
  if (typeof parsed.projectSummary === 'string') { return parsed.projectSummary; }
  if (typeof parsed.summary === 'string') { return parsed.summary; }
  if (typeof parsed.purpose === 'string') { return parsed.purpose; }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFn = (params: { prompt: string; options?: any }) => AsyncGenerator<any, void>;

export class ContextOracle {
  private store: ContextBriefStore;
  private queryFn: QueryFn | null = null;
  private status: OracleStatus;
  private config: OracleConfig;
  private logger: Logger;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private initPromise: Promise<void> | null = null;
  private sdkAvailable: boolean | null = null;
  private workspaceRoot: string = '';

  constructor(config: OracleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.store = new ContextBriefStore(config.briefTtlMs);
    this.status = config.enabled ? 'initializing' : 'disabled';
  }

  activate(context: vscode.ExtensionContext): void {
    if (!this.config.enabled) {
      this.status = 'disabled';
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    this.workspaceRoot = workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // Register file event listeners
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        this.onFileEvent(doc.uri.fsPath, doc.getText(), doc.languageId);
      })
    );
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.onFileEvent(doc.uri.fsPath, doc.getText(), doc.languageId);
      })
    );
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          const doc = editor.document;
          this.onFileEvent(doc.uri.fsPath, doc.getText(), doc.languageId);
        }
      })
    );

    // Load SDK in background
    this.initPromise = this.loadSdk();
  }

  private async loadSdk(): Promise<void> {
    try {
      if (this.sdkAvailable === false) {
        this.status = 'unavailable';
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = await (import('@anthropic-ai/claude-agent-sdk') as Promise<any>);
      const queryFn = sdk.query ?? sdk.default?.query;
      if (!queryFn) {
        this.logger.error('Oracle: Agent SDK does not export query()');
        this.status = 'unavailable';
        this.sdkAvailable = false;
        return;
      }

      this.queryFn = queryFn;
      this.sdkAvailable = true;
      this.status = 'ready';
      this.logger.info('Oracle: SDK loaded, ready');
    } catch (err) {
      this.sdkAvailable = false;
      this.status = 'unavailable';
      this.logger.info(`Oracle: Agent SDK not available — oracle disabled (${err})`);
    }
  }

  private async runQuery(prompt: string, signal: AbortSignal): Promise<string> {
    if (!this.queryFn) { throw new Error('No SDK'); }

    const ac = new AbortController();
    // Forward external abort to query's AbortController
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort);

    try {
      const stream = this.queryFn({
        prompt,
        options: {
          model: this.config.model,
          tools: this.config.allowedTools,
          allowedTools: this.config.allowedTools,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: ORACLE_SYSTEM_PROMPT,
          cwd: this.workspaceRoot,
          settingSources: [],
          maxThinkingTokens: 1024,
          maxTurns: 15,
          abortController: ac,
        },
      });

      let result = '';
      for await (const message of stream) {
        if (signal.aborted) { break; }
        if (message.type === 'result' && message.subtype === 'success') {
          result = message.result ?? '';
        }
      }
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private onFileEvent(filePath: string, fileContent: string, languageId: string): void {
    if (!this.config.enabled || this.status === 'unavailable' || this.status === 'disabled') {
      return;
    }
    this.debouncedAnalyze(filePath, fileContent, languageId);
  }

  private debouncedAnalyze(filePath: string, fileContent: string, languageId: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.analyzeFile(filePath, fileContent, languageId);
    }, this.config.debounceMs);
  }

  async analyzeFile(filePath: string, fileContent: string, languageId: string): Promise<void> {
    // Abort any in-flight analysis
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Wait for SDK to load if still initializing
    if (this.initPromise && this.status === 'initializing') {
      await this.initPromise;
    }

    if (!this.queryFn || this.status === 'unavailable') {
      return;
    }

    this.status = 'analyzing';
    this.logger.debug(`Oracle: Analyzing ${filePath}`);

    try {
      const prompt = buildAnalysisPrompt(filePath, fileContent, languageId);

      // Race the analysis against a 30s timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Oracle analysis timeout')), 30000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });

      const responseText = await Promise.race([
        this.runQuery(prompt, signal),
        timeoutPromise,
      ]);

      if (signal.aborted) { return; }

      const brief = parseResponse(responseText, filePath);
      if (brief) {
        this.store.set(filePath, brief);
        this.logger.debug(`Oracle: Brief generated for ${filePath} (${brief.imports.length} imports, ${brief.typeContext.length} types, ${brief.relatedSymbols.length} symbols)`);
      } else {
        this.logger.debug(`Oracle: Failed to parse response for ${filePath}`);
      }

      this.status = 'ready';
    } catch (err) {
      if (signal.aborted) { return; }

      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Oracle analysis timeout') {
        this.logger.debug(`Oracle: Analysis timed out for ${filePath}`);
      } else {
        this.logger.error(`Oracle: Analysis failed for ${filePath}: ${message}`);
      }
      this.status = 'error';
    }
  }

  getBrief(filePath: string): ContextBrief | null {
    return this.store.get(filePath);
  }

  getStatus(): OracleStatus {
    return this.status;
  }

  updateConfig(config: OracleConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = config;
    this.store.updateTtl(config.briefTtlMs);

    if (!config.enabled && wasEnabled) {
      this.dispose();
      this.status = 'disabled';
    } else if (config.enabled && !wasEnabled) {
      this.status = 'initializing';
      this.initPromise = this.loadSdk();
    }
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.queryFn = null;
    this.store.clear();
    this.initPromise = null;
  }
}
