import { execFile, spawn } from 'child_process';
import { resolveClaudeExecutable } from '../utils/claude-executable';
import { Logger } from '../utils/logger';
import { createMessageChannel, MessageChannel } from '../utils/message-channel';
import { UsageLedger } from '../utils/usage-ledger';

/**
 * Subprocess Lifecycle Notes:
 *
 * Each slot spawns a Claude Code subprocess via the SDK. The subprocess lifecycle is:
 * 1. initSlot() calls query() which spawns a subprocess
 * 2. The subprocess stays alive, handling multiple requests via the message channel
 * 3. channel.close() signals the subprocess to exit gracefully
 * 4. The SDK handles subprocess termination internally
 *
 * Cleanup relies on channel.close() working correctly. The extension does NOT track
 * subprocess PIDs and cannot force-kill orphaned processes. If VS Code crashes or
 * is force-killed, subprocesses may remain until they timeout or are manually cleaned:
 *   pkill -f "claude.*dangerously-skip-permissions"
 */
export type SlotState = 'initializing' | 'available' | 'busy' | 'dead';

/**
 * Detect the Anthropic pay-per-token billing error in a warmup response.
 *
 * When the CLI authenticates against an API account with no credit balance
 * (e.g. a stray ANTHROPIC_API_KEY overriding a subscription login), the
 * assistant "response" is the plain-text API error "Credit balance is too low"
 * rather than a valid warmup reply. That string is never legitimate warmup
 * content, so matching it is safe. Retrying won't help (the balance won't
 * change), so callers surface it as a distinct, actionable failure instead of
 * the generic "warmup failed" path.
 */
export function isCreditBalanceError(text: string): boolean {
  return /credit balance is too low/i.test(text);
}

/**
 * Env vars the Claude CLI treats as auth sources that take precedence over a
 * claude.ai subscription login.
 */
const CLI_AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Report which CLI auth env vars are present in the given environment.
 *
 * The CLI subprocess inherits the extension host's environment, which can
 * contain an auth var the user's system environment (and terminal) does not —
 * e.g. another extension in the shared extension host process setting
 * `process.env.ANTHROPIC_API_KEY` at runtime (observed in #14: system env
 * clean, terminal clean, but the spawned CLI still billed a creditless API
 * key until VS Code was restarted). Returns names only — never values.
 */
export function detectCliAuthEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return CLI_AUTH_ENV_VARS.filter((name) => !!env[name]);
}

/**
 * Env vars that keep a slot's CLI session from loading the host's Claude Code
 * customizations. `settingSources: []` only skips settings.json files: with it
 * alone, a CLI 2.1.283 slot still received the user's claude.ai connectors
 * (~145 MCP tools and their server instructions, ~96k tokens written to the
 * prompt cache per session), the auto-memory MEMORY.md, CLAUDE.md content,
 * and user agents (verified 2026-09-27 via the SDK's `system/init` message
 * and by asking the model what it received). `strictMcpConfig` drops the MCP
 * servers, connectors included; these cover the rest.
 *
 * Env vars rather than CLI flags on purpose: an older `claude` ignores an
 * env var it doesn't know, but exits on an unknown flag, which would fail
 * warmup and degrade the pool. Auth is unaffected (safe mode keeps the
 * subscription login; verified). Do not use `--bare`: it never reads OAuth.
 */
export const SLOT_ISOLATION_ENV: Readonly<Record<string, string>> = {
  /** Disables CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents, output styles. */
  CLAUDE_CODE_SAFE_MODE: '1',
  /** For CLIs without safe mode (the bundled 2.0.77 cli.js has these two). */
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

/** The environment for a slot's CLI subprocess: the host's, plus the isolation vars. */
export function slotEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return { ...base, ...SLOT_ISOLATION_ENV };
}

export interface SlotStats {
  state: SlotState;
  requestCount: number;
  maxRequests: number;
}

export interface PoolStats {
  label: string;
  available: boolean;
  slots: SlotStats[];
  /** Timestamp when pool was activated (ms since epoch). */
  activatedAt: number | null;
  /** Uptime in milliseconds (null if not activated). */
  uptimeMs: number | null;
  /** Total requests served across all slot recycles. */
  totalRequests: number;
  /** Total times slots have been recycled. */
  totalRecycles: number;
  /** Timestamp of last completed request (ms since epoch). */
  lastRequestAt: number | null;
  /** Cumulative token usage. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /**
   * Total cost in USD of the requests served since activation (excluding warmups),
   * summed from per-turn costs — not from the SDK's cumulative per-session totals.
   */
  totalCostUsd: number;
  /** Full model ID reported by the CLI, resolving aliases like `sonnet`. Null until the first response. */
  resolvedModel: string | null;
}

export interface ResultMetadata {
  /** Wall time of this turn inside the CLI (the SDK's `duration_ms` is already per turn). */
  durationMs: number;
  /**
   * API time attributed to this turn. The SDK's `duration_api_ms` is cumulative for the
   * slot's session, so `consumeStream()` replaces it with the delta from the previous
   * result on the same stream. Approximate: the CLI may count API time spent between
   * turns, so a delta can exceed `durationMs`.
   */
  durationApiMs: number;
  /**
   * Cost of THIS turn in USD. The SDK's `total_cost_usd` is cumulative for the slot's
   * session, so `consumeStream()` replaces it with the per-turn delta (0 when the SDK
   * reported no cost). Usage-ledger rows and pool stats sum this.
   */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionId: string;
  /** The model that actually generated this response (from the SDK assistant message). */
  model: string;
  /** `stop_reason` from the final assistant message, when the SDK reports one. */
  stopReason?: string;
  /**
   * Cost of THIS turn, set only when the SDK actually reported `total_cost_usd` (traces
   * must never show a fabricated 0). Same value as `costUsd` otherwise. The SDK total is
   * cumulative per session (verified against usage-ledger data: it grows monotonically
   * across a slot's requests), so this is the delta from the previous result on the same
   * stream; a new stream (recycle) is a new session and starts from 0.
   */
  turnCostUsd?: number;
}

/**
 * Why a request got no answer from the model although nobody cancelled it.
 * Recorded as the trace's `error.type`, so a pool kill is not mistaken for a
 * user-superseded (`aborted`) or model-empty (`empty`) request.
 *
 * - `pool_recycled`: the pool was recycled or restarted (config change, Restart Pools).
 * - `pool_warmup_failed`: a slot failed warmup, which kills every slot.
 * - `slot_stream_error`: the CLI session's stream threw.
 * - `slot_stream_ended`: the CLI session's stream ended (e.g. the process exited)
 *   without a result for the request.
 * - `slot_unavailable`: the pool is degraded, or the slot lost its session after acquisition.
 * - `pool_circuit_open`: the rapid-recycle circuit breaker killed every slot; nothing was sent.
 * - `cli_<subtype>`: the CLI returned a non-success result (e.g. `cli_error_during_execution`).
 */
export type SlotFailure =
  | 'pool_recycled'
  | 'pool_warmup_failed'
  | 'slot_stream_error'
  | 'slot_stream_ended'
  | 'slot_unavailable'
  | 'pool_circuit_open'
  | `cli_${string}`;

/**
 * Why a request ended without a slot or a result. `superseded` (a newer request
 * took the single waiter place), `cancelled` (the caller's signal aborted while it
 * waited for a slot) and `disposed` (shutdown) are cancellations; everything else
 * is a {@link SlotFailure}.
 */
export type SlotDenial = 'superseded' | 'cancelled' | 'disposed' | SlotFailure;

/**
 * How a denial is recorded: `superseded` / `cancelled` / `disposed` are cancellations
 * (`aborted`); anything else is a failure whose type becomes the trace's `error.type`.
 */
export function denialOutcome(denial: SlotDenial): { aborted: true } | { errorType: SlotFailure } {
  return denial === 'superseded' || denial === 'cancelled' || denial === 'disposed'
    ? { aborted: true }
    : { errorType: denial };
}

/** What a slot's result promise resolves with. `failure` is set only when `text` is null. */
export interface SlotResult {
  text: string | null;
  failure?: SlotDenial;
}

/** Reasons `killAllSlots()` passes to waiting and in-flight requests. */
type KillReason = 'pool_recycled' | 'pool_warmup_failed' | 'disposed';

export interface Slot {
  state: SlotState;
  channel: MessageChannel | null;
  /**
   * Resolves with the next result from the stream consumer. The reason for a
   * null travels in the value, not on the slot: a kill resets the slot's fields
   * and a recycle reuses the object before the caller's continuation runs.
   */
  resultPromise: Promise<SlotResult> | null;
  /** Call to deliver a result from the background consumer. */
  deliverResult: ((value: SlotResult) => void) | null;
  /** Number of completions delivered by this slot (excludes warmup). */
  resultCount: number;
  /** Monotonically increasing generation — incremented on killAllSlots to invalidate stale consumers. */
  generation: number;
  /** Timestamp of the last recycleSlot call (for circuit breaker). */
  lastRecycleTime: number;
  /** Count of rapid consecutive recycles (resets when gap exceeds threshold). */
  rapidRecycleCount: number;
  /**
   * Set when the caller gave up on the request in flight (`cancel` or `timeout`) and
   * the slot's input was closed ({@link SlotPool.abandonRequest}). The session is
   * retired: a late result for that turn is dropped and the slot recycles instead of
   * being handed to the next request. Cleared on recycle.
   */
  abandoned?: 'cancel' | 'timeout' | null;
  /** SDK metadata from the most recent result message, read by callers. */
  lastResultMeta: ResultMetadata | null;
  /** Model from the most recent assistant message in the stream. */
  lastAssistantModel: string | null;
  /** stop_reason from the most recent assistant message in the stream. */
  lastAssistantStopReason?: string | null;
  /** Buffered stderr output from the CLI subprocess for diagnostics. */
  stderrChunks: string[];
}

/** Circuit breaker: max rapid recycles before marking a slot dead. */
const RAPID_RECYCLE_LIMIT = 5;
/** Circuit breaker: time window (ms) for counting rapid recycles. */
const RAPID_RECYCLE_WINDOW_MS = 5_000;
/** Maximum turns per query (SDK limit). */
const MAX_TURNS = 50;
/** Thinking tokens disabled for autocomplete (immediate response preferred). */
const MAX_THINKING_TOKENS = 0;
/** Warmup timeout — if subprocess produces no output within this window, treat as failure. */
const WARMUP_TIMEOUT_MS = 30_000;
/** Max stderr chunks to buffer per slot (prevent unbounded memory if CLI is unexpectedly chatty). */
const MAX_STDERR_CHUNKS = 100;

export abstract class SlotPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected queryFn: ((...args: any[]) => any) | null = null;
  protected sdkAvailable: boolean | null = null;
  protected slots: Slot[];
  protected nextSlot = 0;
  protected logger: Logger;
  protected readonly poolSize: number;
  protected ledger: UsageLedger | null = null;
  /** Single-waiter queue: only one request can wait for a slot at a time. */
  protected pendingWaiter: ((result: number | SlotDenial) => void) | null = null;
  /** Deduplicates overlapping recycleAll calls. */
  private _recyclePromise: Promise<void> | null = null;
  protected _warmupResolvers: (((ok: boolean) => void) | null)[];
  private _warmupFailureCount = 0;
  private _warmupFailureHandled = false;
  /** Set when the CLI prints a plain-text config error to stdout (see consumeStream). */
  private _cliConfigCorrupted = false;
  /** Set when warmup returns the API "Credit balance is too low" error (see consumeStream). */
  private _cliBillingError = false;
  /** Set by dispose(); a disposed pool never hands out a slot again. */
  private _disposed = false;
  /**
   * Set when the rapid-recycle circuit breaker has killed every slot. Nothing
   * respawns them on its own; killAllSlots() (restart, recycleAll) clears it.
   */
  private _circuitOpen = false;
  /** Full model ID reported by the CLI (e.g. what the `sonnet` alias resolved to). */
  private _resolvedModel: string | null = null;

  // --- Pool-level statistics ---
  private _activatedAt: number | null = null;
  private _totalRequests = 0;
  private _totalRecycles = 0;
  private _lastRequestAt: number | null = null;
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _totalCacheReadTokens = 0;
  private _totalCacheCreationTokens = 0;
  private _totalCostUsd = 0;

  /** Called when the pool is fully degraded (all warmup retries exhausted). */
  onPoolDegraded: ((reason: string) => void) | null = null;

  constructor(logger: Logger, poolSize: number) {
    this.logger = logger;
    this.poolSize = poolSize;
    this.slots = Array.from({ length: poolSize }, () => ({
      state: 'dead' as SlotState,
      channel: null,
      resultPromise: null,
      deliverResult: null,
      resultCount: 0,
      generation: 0,
      lastRecycleTime: 0,
      rapidRecycleCount: 0,
      lastResultMeta: null,
      lastAssistantModel: null,
      stderrChunks: [],
    }));
    this._warmupResolvers = Array.from({ length: poolSize }, () => null);
  }

  // --- Abstract methods subclasses must implement ---

  protected abstract getSystemPrompt(): string;
  protected abstract getModel(): string;
  protected abstract getMaxReuses(): number;
  protected abstract getPoolLabel(): string;
  protected abstract buildWarmupMessage(): string;
  protected abstract validateWarmupResponse(raw: string): boolean;

  // --- Public API ---

  setLedger(ledger: UsageLedger): void {
    this.ledger = ledger;
  }

  isAvailable(): boolean {
    return this.sdkAvailable === true && !this._disposed && !this._circuitOpen;
  }

  /**
   * Why a request arriving now cannot get a slot, or null if it may acquire one
   * (possibly after waiting for a slot that is busy or warming up).
   * `disposed` is a cancellation (the window is shutting down); the rest are failures.
   */
  unavailableReason(): SlotDenial | null {
    if (this._disposed) return 'disposed';
    if (this._circuitOpen) return 'pool_circuit_open';
    // Degraded (warmup retries exhausted): no slot will ever come.
    if (this.sdkAvailable === false) return 'slot_unavailable';
    return null;
  }

  /** Get pool statistics for status display. */
  getStats(): PoolStats {
    return {
      label: this.getPoolLabel(),
      available: this.isAvailable(),
      slots: this.slots.map((slot) => ({
        state: slot.state,
        requestCount: slot.resultCount,
        maxRequests: this.getMaxReuses(),
      })),
      activatedAt: this._activatedAt,
      uptimeMs: this._activatedAt ? Date.now() - this._activatedAt : null,
      totalRequests: this._totalRequests,
      totalRecycles: this._totalRecycles,
      lastRequestAt: this._lastRequestAt,
      totalInputTokens: this._totalInputTokens,
      totalOutputTokens: this._totalOutputTokens,
      totalCacheReadTokens: this._totalCacheReadTokens,
      totalCacheCreationTokens: this._totalCacheCreationTokens,
      totalCostUsd: this._totalCostUsd,
      resolvedModel: this._resolvedModel,
    };
  }

  /** Initialize all slots in parallel. */
  protected async initAllSlots(): Promise<void> {
    // Record activation time on first init
    if (this._activatedAt === null) {
      this._activatedAt = Date.now();
    }
    await Promise.all(Array.from({ length: this.poolSize }, (_, i) => this.initSlot(i)));
  }

  /** Close all slots and reinitialize them. Used when the model changes.
   *  Serialized: overlapping calls return the same promise. */
  async recycleAll(): Promise<void> {
    if (!this.sdkAvailable) {
      this.logger.debug(`${this.getPoolLabel()}: recycleAll skipped (SDK not available)`);
      return;
    }

    // Deduplicate overlapping recycleAll calls
    if (this._recyclePromise) {
      return this._recyclePromise;
    }

    this._recyclePromise = this._doRecycleAll();
    try {
      await this._recyclePromise;
    } finally {
      this._recyclePromise = null;
    }
  }

  /**
   * Restart the pool from scratch. Resets warmup failure tracking and
   * re-initializes all slots. Use after the pool has been degraded.
   * Fires onPoolDegraded if the SDK is unavailable on restart.
   */
  async restart(): Promise<void> {
    this.killAllSlots('pool_recycled');
    this._warmupFailureCount = 0;
    this._warmupFailureHandled = false;
    this._cliConfigCorrupted = false;
    this._cliBillingError = false;
    this._resolvedModel = null;
    this.sdkAvailable = null;

    await this.loadSdk();
    if (!this.sdkAvailable) {
      this.logger.error(`${this.getPoolLabel()}: SDK not available on restart`);
      this.onPoolDegraded?.('SDK not available');
      return;
    }

    this.logger.info(`${this.getPoolLabel()}: restarting pool...`);
    await this.initAllSlots();
    this.logger.info(`${this.getPoolLabel()}: pool restarted`);
  }

  dispose(): void {
    this._disposed = true;
    this.killAllSlots('disposed');
    this.sdkAvailable = false;
    this.queryFn = null;
    this.logger.info(`${this.getPoolLabel()} provider: disposed`);
  }

  // --- Protected pool infrastructure ---

  protected async loadSdk(): Promise<void> {
    try {
      if (this.sdkAvailable === false) {
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdk = await (import('@anthropic-ai/claude-agent-sdk') as Promise<any>);
      const queryFn = sdk.query ?? sdk.default?.query;
      if (!queryFn) {
        this.logger.error(`${this.getPoolLabel()}: Agent SDK does not export query()`);
        this.sdkAvailable = false;
        return;
      }

      this.queryFn = queryFn;
      this.sdkAvailable = true;
      this.logger.debug(
        `${this.getPoolLabel()}: SDK loaded (fallback runtime: Node ${process.version} at ${process.execPath})`,
      );
    } catch (err) {
      this.sdkAvailable = false;
      this.logger.error(
        `${this.getPoolLabel()}: Agent SDK not available — provider disabled (${err instanceof Error ? (err.stack ?? err.message) : err})`,
      );
    }
  }

  protected async initSlot(index: number): Promise<void> {
    const slot = this.slots[index];
    try {
      slot.state = 'initializing';
      slot.resultCount = 0;

      const channel = createMessageChannel();
      slot.channel = channel;

      // Push a warmup message to prime the session
      const warmup = this.buildWarmupMessage();
      channel.push(warmup);
      this.logger.debug(`${this.getPoolLabel()}: slot ${index} warming up...`);
      this.logger.traceBlock(`warmup → sent (slot ${index})`, warmup);

      // Start streaming query — it consumes messages from the channel.
      // The SDK resolves cli.js via import.meta.url, which is undefined when
      // loaded via require() in a CJS bundle. Pass the path explicitly.
      //
      // Prefer a native Claude binary when available: the bundled cli.js is a
      // Node script the SDK runs as `node cli.js`, which fails when `node` is
      // not on PATH (common on Windows). A native binary spawns directly.
      const executable = resolveClaudeExecutable();
      if (index === 0) {
        this.logger.debug(
          `${this.getPoolLabel()}: using ${executable.source} executable: ${executable.path}`,
        );
      }
      const sdkCliPath = executable.path;
      slot.stderrChunks = [];
      const stream = this.queryFn!({
        prompt: channel.iterable,
        options: {
          model: this.getModel(),
          tools: [],
          allowedTools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: this.getSystemPrompt(),
          // Isolation from the host's Claude Code configuration — see SLOT_ISOLATION_ENV.
          settingSources: [],
          strictMcpConfig: true,
          env: slotEnv(),
          maxThinkingTokens: MAX_THINKING_TOKENS,
          maxTurns: MAX_TURNS,
          persistSession: false,
          pathToClaudeCodeExecutable: sdkCliPath,
          // Own the spawn so we (a) never depend on a system `node` on PATH and
          // (b) can capture stderr for diagnostics. The SDK hands us the command
          // and args it would have used:
          //   - Native binary: `opts.command` IS the binary — spawn it directly.
          //   - Bundled cli.js: `opts.command` is a system `node` we may not have,
          //     so substitute VS Code's own Node (Electron via process.execPath +
          //     ELECTRON_RUN_AS_NODE=1). Guarantees Node 18+ regardless of PATH —
          //     the same pattern vscode-languageclient uses.
          spawnClaudeCodeProcess: (opts: {
            command: string;
            args: string[];
            cwd?: string;
            env: Record<string, string | undefined>;
            signal: AbortSignal;
          }) => {
            const command = executable.native ? opts.command : process.execPath;
            const env = executable.native ? opts.env : { ...opts.env, ELECTRON_RUN_AS_NODE: '1' };
            const child = spawn(command, opts.args, {
              cwd: opts.cwd,
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
              signal: opts.signal,
              windowsHide: true,
            });
            // Capture stderr for diagnostics (replaces the SDK's stderr callback,
            // which only fires on the SDK's own default spawn path).
            child.stderr?.on('data', (data: Buffer) => {
              if (slot.stderrChunks.length < MAX_STDERR_CHUNKS) {
                slot.stderrChunks.push(data.toString());
              }
            });
            return child;
          },
        },
      });

      // Set up promise that callers will await
      this.resetResultPromise(slot);

      // Start background consumer (eats warmup, then delivers real results)
      this.consumeStream(stream, index);

      // Wait for warmup to establish the subprocess and validate
      const warmupOk = await this.waitForWarmup(index);

      this.logger.traceBlock('system prompt (slot ' + index + ')', this.getSystemPrompt());

      if (!warmupOk) {
        this.handleWarmupFailure(index);
        return;
      }

      // Guard: handleWarmupFailure from a sibling slot may have killed this slot.
      // Re-read from this.slots[] to bypass TypeScript's narrowing of the local.
      if (this.slots[index].state === 'dead') {
        return;
      }

      slot.state = 'available';
      this.logger.debug(`${this.getPoolLabel()}: slot ${index} ready`);

      // Record startup in ledger
      this.ledger?.record({
        source: 'startup',
        model: this.getModel(),
        durationMs: 0,
        inputChars: 0,
        outputChars: 0,
        slotIndex: index,
      });

      // If a request is already waiting, claim this slot for it
      this.notifyWaiter(index);
    } catch (err) {
      slot.state = 'dead';
      this.logger.error(
        `${this.getPoolLabel()}: slot ${index} init failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
    }
  }

  /**
   * Acquire an available slot. Returns the slot index (already marked busy)
   * or null if no slot was handed out. {@link acquireSlotOrDenial} says why.
   */
  protected async acquireSlot(): Promise<number | null> {
    const result = await this.acquireSlotOrDenial();
    return typeof result === 'number' ? result : null;
  }

  /**
   * Acquire an available slot. Returns the slot index (already marked busy),
   * or why none was handed out: `superseded` by a newer waiter, `disposed`,
   * or a {@link SlotFailure} when the pool was killed while this request waited.
   *
   * Fast path: find any available slot, mark busy, return.
   * Slow path: register as single waiter. A new arrival cancels the previous
   * waiter ('superseded'), so only the most recent request waits.
   */
  protected async acquireSlotOrDenial(signal?: AbortSignal): Promise<number | SlotDenial> {
    // Disposed or degraded: no slot will ever come, so don't park as a waiter.
    const denied = this.unavailableReason();
    if (denied) return denied;

    // Fast path: find an available slot
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.nextSlot + i) % this.slots.length;
      if (this.slots[idx].state === 'available') {
        this.slots[idx].state = 'busy';
        this.nextSlot = (idx + 1) % this.slots.length;
        return idx;
      }
    }

    // Slow path: cancel existing waiter and register self
    if (this.pendingWaiter) {
      this.pendingWaiter('superseded');
    }

    this.logger.trace(
      `waiting for slot (${this.slots.map((s, i) => `slot${i}=${s.state}`).join(', ')})`,
    );

    // An already-aborted signal would never fire its abort listener.
    if (signal?.aborted) return 'cancelled';

    return new Promise<number | SlotDenial>((resolve) => {
      // `signal` aborting while this request is still the waiter ends the wait
      // (`cancelled`); once a slot was handed over the caller owns it.
      const onAbort = () => {
        if (this.pendingWaiter !== waiter) return;
        this.pendingWaiter = null;
        waiter('cancelled');
      };
      const waiter = (result: number | SlotDenial) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      this.pendingWaiter = waiter;
      signal?.addEventListener('abort', onAbort);
    });
  }

  /**
   * Give back a slot that was acquired but never sent anything (the caller cancelled
   * in between). The session is untouched, so it is reused, not recycled.
   */
  protected releaseSlot(slotIndex: number): void {
    const slot = this.slots[slotIndex];
    if (slot.state !== 'busy') return;
    slot.state = 'available';
    this.notifyWaiter(slotIndex);
  }

  /**
   * End the request in flight on `slot` without its answer (the caller cancelled or
   * timed out) and retire the session: settle the caller with a null, close the input
   * so the CLI exits, and mark the slot so the stream consumer recycles it rather than
   * handing it on when the CLI still delivers the abandoned turn's result.
   */
  protected abandonRequest(slot: Slot, why: 'cancel' | 'timeout'): void {
    slot.abandoned = why;
    this.settleResult(slot, { text: null });
    try {
      slot.channel?.close();
    } catch (err) {
      this.logger.error(
        `${this.getPoolLabel()}: failed to close channel: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Notify the pending waiter that a slot is available. Called by consumeStream
   * after delivering a result (slot reuse) and by initSlot after warmup (fresh slot).
   * The slot is marked busy before notifying the waiter.
   */
  protected notifyWaiter(slotIndex: number): boolean {
    if (!this.pendingWaiter) {
      return false;
    }
    const waiter = this.pendingWaiter;
    this.pendingWaiter = null;
    this.slots[slotIndex].state = 'busy';
    waiter(slotIndex);
    return true;
  }

  /** Extract SDK metadata from a result message. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected extractMetadata(message: any, assistantModel?: string): ResultMetadata {
    const usage = message.usage;
    return {
      durationMs: message.duration_ms ?? 0,
      durationApiMs: message.duration_api_ms ?? 0,
      costUsd: message.total_cost_usd ?? 0,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
      sessionId: message.session_id ?? '',
      model: assistantModel || '',
    };
  }

  /** Drain and log any buffered stderr from a slot's subprocess. */
  protected drainStderr(slotIndex: number, level: 'error' | 'debug'): void {
    const slot = this.slots[slotIndex];
    if (slot.stderrChunks.length === 0) return;
    const stderr = slot.stderrChunks.join('').trim();
    slot.stderrChunks = [];
    if (!stderr) return;
    const msg = `${this.getPoolLabel()}: subprocess stderr (slot ${slotIndex}):\n${stderr}`;
    if (level === 'error') {
      this.logger.error(msg);
    } else {
      this.logger.debug(msg);
    }
  }

  protected resetResultPromise(slot: Slot): void {
    slot.resultPromise = new Promise<SlotResult>((resolve) => {
      slot.deliverResult = resolve;
    });
  }

  /**
   * Deliver `result` to the request holding the slot, then clear the callback so
   * no later path (stream end, recycle, kill) can deliver a second outcome.
   * No-op when nothing is pending.
   */
  protected settleResult(slot: Slot, result: SlotResult): void {
    const deliver = slot.deliverResult;
    slot.deliverResult = null;
    deliver?.(result);
  }

  /** End the pending request, if any, with `failure` (see {@link settleResult}). */
  protected failPending(slot: Slot, failure: SlotDenial): void {
    this.settleResult(slot, { text: null, failure });
  }

  protected waitForWarmup(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Timeout fired — subprocess never produced warmup output
        this._warmupResolvers[index] = null;
        this.logger.error(
          `${this.getPoolLabel()}: warmup timed out on slot ${index} after ${WARMUP_TIMEOUT_MS / 1000}s — subprocess may be unresponsive`,
        );
        resolve(false);
      }, WARMUP_TIMEOUT_MS);

      // Wrap the resolver so it clears the timeout when called normally
      // (by consumeStream or killAllSlots).
      this._warmupResolvers[index] = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
    });
  }

  /**
   * Background consumer loop. Eats the warmup result, then loops delivering
   * real completion results. After getMaxReuses() completions or on stream error,
   * recycles the slot (finally block).
   */
  protected async consumeStream(stream: AsyncIterable<unknown>, slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    const myGeneration = slot.generation;
    this.logger.debug(`${this.getPoolLabel()}: slot ${slotIndex} stream consumer started`);
    // Keep reference to iterator for cleanup on early return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iterator = (stream as AsyncIterable<any>)[Symbol.asyncIterator]();
    try {
      let resultCount = 0;
      // total_cost_usd and duration_api_ms are cumulative per session (this stream);
      // track them to derive per-turn values. A new stream is a new session: reset.
      let prevCumulativeCost = 0;
      let prevCumulativeApiMs = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let iterResult: IteratorResult<any>;
      while (!(iterResult = await iterator.next()).done) {
        const message = iterResult.value;
        if (message.type === 'assistant') {
          slot.lastAssistantModel = message.message?.model ?? null;
          slot.lastAssistantStopReason = message.message?.stop_reason ?? null;
          if (slot.lastAssistantModel) {
            this._resolvedModel = slot.lastAssistantModel;
          }
        }
        if (message.type === 'result') {
          resultCount++;
          const text: string | null =
            message.subtype === 'success' ? (message.result ?? null) : null;

          // Extract SDK metadata from every result message
          const assistantModel = slot.lastAssistantModel ?? undefined;
          slot.lastAssistantModel = null;
          const meta = this.extractMetadata(message, assistantModel);
          const stopReason = message.stop_reason ?? slot.lastAssistantStopReason;
          slot.lastAssistantStopReason = null;
          if (stopReason) meta.stopReason = stopReason;
          // Only when the SDK actually reported a cost — never invent a 0.
          if (typeof message.total_cost_usd === 'number') {
            meta.turnCostUsd = Math.max(0, message.total_cost_usd - prevCumulativeCost);
            prevCumulativeCost = message.total_cost_usd;
            meta.costUsd = meta.turnCostUsd;
          }
          if (typeof message.duration_api_ms === 'number') {
            meta.durationApiMs = Math.max(0, message.duration_api_ms - prevCumulativeApiMs);
            prevCumulativeApiMs = message.duration_api_ms;
          }

          if (resultCount === 1) {
            // Warmup result — validate, then signal initSlot
            this.logger.traceBlock(`warmup ← recv (slot ${slotIndex})`, text ?? '(null)');

            // Record warmup in ledger
            this.ledger?.record({
              source: 'warmup',
              model: meta.model || this.getModel(),
              durationMs: meta.durationMs,
              durationApiMs: meta.durationApiMs,
              inputTokens: meta.inputTokens,
              outputTokens: meta.outputTokens,
              cacheReadTokens: meta.cacheReadTokens,
              cacheCreationTokens: meta.cacheCreationTokens,
              costUsd: meta.costUsd,
              inputChars: 0,
              outputChars: text?.length ?? 0,
              slotIndex,
              sessionId: meta.sessionId,
            });

            let warmupOk = false;
            if (text) {
              warmupOk = this.validateWarmupResponse(text);
              if (!warmupOk) {
                this.logger.error(
                  `${this.getPoolLabel()}: warmup validation failed on slot ${slotIndex}: got "${text.slice(0, 200)}"`,
                );
                // A "Credit balance is too low" reply means the CLI is billing an
                // API account with no credit instead of a subscription. Retrying
                // won't refill the balance — flag it so handleWarmupFailure skips
                // retry and surfaces an actionable message.
                if (isCreditBalanceError(text)) {
                  this._cliBillingError = true;
                }
              }
            } else {
              this.logger.error(`warmup returned null on slot ${slotIndex}, recycling`);
            }

            this._warmupResolvers[slotIndex]?.(warmupOk);
            this._warmupResolvers[slotIndex] = null;

            if (!warmupOk) {
              break; // exits for-await, triggering recycleSlot in finally
            }
            continue;
          }

          // Stale consumer guard — slot was recycled while we were iterating
          if (this.slots[slotIndex].generation !== myGeneration) {
            return; // skip deliverResult and finally-block recycleSlot
          }

          // Store metadata for callers to read
          slot.lastResultMeta = meta;

          // Real completion result — deliver to the waiting caller. A non-success
          // result (e.g. error_during_execution) is the CLI failing, not the model
          // returning nothing.
          slot.resultCount++;
          this.settleResult(
            slot,
            message.subtype === 'success' || text !== null
              ? { text }
              : { text: null, failure: `cli_${String(message.subtype ?? 'error')}` },
          );

          // Update pool-level statistics
          this._totalRequests++;
          this._lastRequestAt = Date.now();
          if (meta) {
            this._totalInputTokens += meta.inputTokens;
            this._totalOutputTokens += meta.outputTokens;
            this._totalCacheReadTokens += meta.cacheReadTokens;
            this._totalCacheCreationTokens += meta.cacheCreationTokens;
            this._totalCostUsd += meta.costUsd;
          }

          // Stop if disposed or hit reuse limit
          if (slot.state === 'dead') {
            break;
          }
          // The caller gave up on this turn and the input is closed: recycle rather
          // than hand a session that is exiting to the next request.
          if (slot.abandoned) {
            break;
          }
          if (slot.resultCount >= this.getMaxReuses()) {
            this.logger.debug(
              `slot ${slotIndex} reached max reuses (${this.getMaxReuses()}), recycling`,
            );
            break;
          }

          // Reuse: reset the result promise and mark available for next request
          this.resetResultPromise(slot);
          slot.state = 'available';

          // If a request is already waiting, claim this slot immediately
          this.notifyWaiter(slotIndex);
        }
      }
      // The stream ended on its own (the CLI exited, or the SDK closed it) without
      // a result for whoever holds the slot. The breaks above land here too, after
      // the result was delivered and the callback cleared, so this only fires for
      // a request (or warmup) that was genuinely left waiting. Without it the
      // finally block's recycleSlot() dropped the callback and the request's
      // promise never settled — the completion path has no timeout.
      if (this.slots[slotIndex].generation !== myGeneration) {
        return;
      }
      // A request (busy) or warmup left waiting is a failure worth the stderr; an
      // idle session exiting is only a recycle.
      if ((slot.deliverResult && slot.state === 'busy') || this._warmupResolvers[slotIndex]) {
        this.logger.error(
          `${this.getPoolLabel()}: slot ${slotIndex} stream ended without a result${
            this._warmupResolvers[slotIndex] ? ' (during warmup)' : ''
          }`,
        );
        this.drainStderr(slotIndex, 'error');
      }
      this.failPending(slot, 'slot_stream_ended');
      this._warmupResolvers[slotIndex]?.(false);
      this._warmupResolvers[slotIndex] = null;
    } catch (err) {
      // Stale consumer guard — don't touch the new slot's state.
      // The finally block handles iterator cleanup, so just return here.
      if (this.slots[slotIndex].generation !== myGeneration) {
        return;
      }
      this.logger.error(
        `${this.getPoolLabel()}: stream error on slot ${slotIndex}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
      // The CLI prints plain-text errors to stdout when ~/.claude.json is missing
      // or corrupted (e.g., UTF-8 BOM); the SDK then JSON.parses that line and
      // throws SyntaxError. Retrying won't help — flag it so handleWarmupFailure
      // skips retry and surfaces an actionable message. Only checked while this
      // slot's warmup is pending: config corruption always surfaces at process
      // startup, and gating avoids a mid-session parse error that happens to
      // contain "Claude " mis-flagging the config.
      if (this._warmupResolvers[slotIndex]) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('Unexpected token') && /\bClaude\s/.test(errMsg)) {
          this._cliConfigCorrupted = true;
        }
      }
      this.drainStderr(slotIndex, 'error');
      this.failPending(slot, 'slot_stream_error');
      // Also resolve warmup if still pending (failure)
      this._warmupResolvers[slotIndex]?.(false);
      this._warmupResolvers[slotIndex] = null;
    } finally {
      // Stale consumer guard — if the slot generation changed, a recycleAll
      // (or similar) already replaced this slot. Don't touch the new one.
      if (this.slots[slotIndex].generation !== myGeneration) {
        // Clean up the iterator before returning to release resources
        await iterator.return?.();
        return;
      }
      this.recycleSlot(slotIndex);
    }
  }

  /**
   * Kill all slots immediately. Cancels pending waiters, resolves in-flight
   * deliverResult and warmup promises, closes channels, marks all slots dead.
   * `reason` tells the waiting and in-flight requests why they got no result.
   */
  protected killAllSlots(reason: KillReason): void {
    // Every caller (restart, recycleAll, warmup failure, dispose) replaces or ends
    // the slots, so the breaker's all-dead state no longer applies.
    this._circuitOpen = false;
    if (this.pendingWaiter) {
      const waiter = this.pendingWaiter;
      this.pendingWaiter = null;
      waiter(reason);
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.generation++;
      this.failPending(slot, reason);
      slot.state = 'dead';
      try {
        slot.channel?.close();
      } catch (err) {
        this.logger.error(
          `Failed to close channel for slot ${i}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
        );
      }
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;
      slot.resultCount = 0;
      slot.lastResultMeta = null;
      slot.lastAssistantModel = null;
      slot.stderrChunks = [];
      slot.abandoned = null;
      // Reset circuit breaker so intentional recycles (recycleAll) don't count
      slot.lastRecycleTime = 0;
      slot.rapidRecycleCount = 0;
      // Unblock any pending initSlot awaiting warmup
      this._warmupResolvers[i]?.(false);
      this._warmupResolvers[i] = null;
    }
  }

  // --- Private helpers ---

  private async _doRecycleAll(): Promise<void> {
    this._warmupFailureCount = 0;
    this._warmupFailureHandled = false;
    this._cliConfigCorrupted = false;
    this._cliBillingError = false;
    // Recycles follow model changes — the new warmup will repopulate this.
    this._resolvedModel = null;
    this.logger.info(`${this.getPoolLabel()}: recycling all slots`);
    this.killAllSlots('pool_recycled');

    // Reinitialize all slots
    await this.initAllSlots();
    this.logger.info(`${this.getPoolLabel()}: pool recycled`);
  }

  private recycleSlot(index: number): void {
    const slot = this.slots[index];
    if (slot.state === 'dead') {
      return;
    } // already disposed

    this._totalRecycles++;

    // A user cancel ended this session on purpose — not a crash — so it does not
    // count toward the rapid-recycle breaker.
    const cancelled = slot.abandoned === 'cancel';
    slot.abandoned = null;

    // Circuit breaker: detect rapid consecutive recycles
    if (!cancelled) {
      const now = Date.now();
      if (now - slot.lastRecycleTime < RAPID_RECYCLE_WINDOW_MS) {
        slot.rapidRecycleCount++;
      } else {
        slot.rapidRecycleCount = 1;
      }
      slot.lastRecycleTime = now;
    }

    if (slot.rapidRecycleCount >= RAPID_RECYCLE_LIMIT) {
      this.logger.error(
        `${this.getPoolLabel()}: slot ${index} recycled ${slot.rapidRecycleCount} times in < ${RAPID_RECYCLE_WINDOW_MS}ms — marking dead (circuit breaker)`,
      );
      slot.generation++;
      slot.state = 'dead';
      try {
        slot.channel?.close();
      } catch (err) {
        this.logger.error(
          `Failed to close channel for slot ${index}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
        );
      }
      slot.channel = null;
      slot.resultPromise = null;
      slot.deliverResult = null;

      // All slots dead → the pool is unavailable until restart or recycleAll.
      // Fail the parked request now: no slot will free up to wake it, so it
      // would otherwise wait until a newer request superseded it.
      if (this.slots.every((s) => s.state === 'dead')) {
        this._circuitOpen = true;
        this.logger.error(
          `${this.getPoolLabel()}: all slots dead (circuit breaker), pool degraded`,
        );
        if (this.pendingWaiter) {
          const waiter = this.pendingWaiter;
          this.pendingWaiter = null;
          waiter('pool_circuit_open');
        }
        this.onPoolDegraded?.('circuit breaker: all slots dead after rapid recycles');
      }
      return;
    }

    slot.state = 'initializing';

    // Log any stderr warnings from the completed subprocess before recycling
    this.drainStderr(index, 'debug');

    // Close old channel (kills subprocess)
    try {
      slot.channel?.close();
    } catch (err) {
      this.logger.error(
        `Failed to close channel for slot ${index}: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
    }
    slot.channel = null;
    slot.resultPromise = null;
    slot.deliverResult = null;
    slot.resultCount = 0;

    // Spawn fresh session in background. setTimeout breaks the microtask chain
    // so consumeStream → recycleSlot → initSlot → consumeStream doesn't recurse
    // synchronously through promise resolution.
    setTimeout(() => {
      if (this.slots[index].state === 'dead') {
        return;
      }
      this.initSlot(index).catch((err) => {
        this.logger.error(`${this.getPoolLabel()}: slot ${index} recycle failed: ${err}`);
      });
    }, 0);
  }

  /**
   * Run CLI diagnostics after warmup exhaustion. Fire-and-forget — appends
   * results to the log so a single log dump captures everything needed to
   * debug "exit code 1" failures without asking the user to run commands.
   */
  private logCliDiagnostics(): void {
    const DIAG_TIMEOUT_MS = 10_000;
    const label = this.getPoolLabel();

    const executable = resolveClaudeExecutable();
    this.logger.info(`${label}: running CLI diagnostics...`);
    this.logger.info(`${label}: resolved ${executable.source} executable: ${executable.path}`);

    // The spawned CLI inherits *this* process's environment, which can differ
    // from the system environment the user checks in a terminal (another
    // extension can set auth vars in the shared extension host at runtime).
    // Log names only, never values.
    const authVars = detectCliAuthEnvVars();
    this.logger.info(
      `${label}: CLI auth env vars in extension host process: ${
        authVars.length > 0 ? authVars.join(', ') : 'none'
      }`,
    );

    // Probe the executable the SDK actually spawns, the same way it is spawned,
    // so diagnostics reflect how completions are really invoked — not bare
    // `claude`/`node` that may not be on the extension host's PATH (the failure
    // this fixes). A native binary runs directly; the bundled cli.js runs via
    // VS Code's own Node (Electron), matching initSlot's spawn.
    const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const probes: {
      label: string;
      file: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }[] = executable.native
      ? [
          { label: 'claude --version', file: executable.path, args: ['--version'] },
          { label: 'claude auth status', file: executable.path, args: ['auth', 'status'] },
        ]
      : [
          { label: 'node --version', file: process.execPath, args: ['--version'], env: nodeEnv },
          {
            label: 'claude --version',
            file: process.execPath,
            args: [executable.path, '--version'],
            env: nodeEnv,
          },
          {
            label: 'claude auth status',
            file: process.execPath,
            args: [executable.path, 'auth', 'status'],
            env: nodeEnv,
          },
        ];

    for (const probe of probes) {
      execFile(
        probe.file,
        probe.args,
        { timeout: DIAG_TIMEOUT_MS, env: probe.env },
        (err, stdout, stderr) => {
          const out = (stdout || '').trim();
          const errOut = (stderr || '').trim();
          if (err) {
            const reason = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
              ? `timed out after ${DIAG_TIMEOUT_MS / 1000}s`
              : err.message;
            this.logger.error(
              `${label}: diagnostic \`${probe.label}\` failed: ${reason}${errOut ? `\n${errOut}` : ''}`,
            );
          } else {
            this.logger.info(
              `${label}: diagnostic \`${probe.label}\`:\n${out}${errOut ? `\nstderr: ${errOut}` : ''}`,
            );
          }
        },
      );
    }
  }

  /**
   * Handle a warmup validation failure. Kills the entire pool immediately.
   * On first failure: retries all slots. On second failure: shuts down and
   * notifies the host via onPoolDegraded.
   */
  private handleWarmupFailure(failedSlot: number): void {
    // Guard: another slot's failure may have already triggered this
    if (this._warmupFailureHandled) {
      return;
    }
    this._warmupFailureHandled = true;
    this._warmupFailureCount++;

    this.logger.error(
      `${this.getPoolLabel()}: warmup failed on slot ${failedSlot} (attempt ${this._warmupFailureCount}/2)`,
    );

    // Drain stderr before killAllSlots resets the buffers
    for (let i = 0; i < this.slots.length; i++) {
      this.drainStderr(i, 'error');
    }

    this.killAllSlots('pool_warmup_failed');

    if (this._warmupFailureCount >= 2 || this._cliConfigCorrupted || this._cliBillingError) {
      // Exhausted retries (or a retry-won't-help failure) — shut down
      this.sdkAvailable = false;
      const authVars = detectCliAuthEnvVars();
      const reason = this._cliConfigCorrupted
        ? 'cli config file corrupted'
        : this._cliBillingError
          ? authVars.length > 0
            ? `credit balance too low (${authVars.join(', ')} set in the extension host process)`
            : 'credit balance too low'
          : 'warmup failed after retry';
      this.logger.error(`${this.getPoolLabel()}: ${reason}, autocomplete disabled`);
      this.logCliDiagnostics();
      this.onPoolDegraded?.(reason);
    } else {
      // Retry once
      this.logger.info(`${this.getPoolLabel()}: retrying all slots after warmup failure...`);
      setTimeout(() => {
        this._warmupFailureHandled = false;
        this.initAllSlots().catch((err) => {
          this.logger.error(`${this.getPoolLabel()}: warmup retry failed: ${err}`);
        });
      }, 0);
    }
  }
}
