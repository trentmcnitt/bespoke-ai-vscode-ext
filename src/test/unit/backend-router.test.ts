import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendRouter } from '../../providers/backend-router';
import { makeConfig, makeProseContext } from '../helpers';
import { TraceRecorder } from '../../utils/trace';

// Create mock objects
function makeMockPoolClient() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    getCompletion: vi.fn().mockResolvedValue('cli completion'),
    updateConfig: vi.fn(),
    recycleAll: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({ text: 'cli command result', meta: null }),
    isCommandPoolAvailable: vi.fn().mockReturnValue(true),
    getCurrentModel: vi.fn().mockReturnValue('haiku'),
    dispose: vi.fn(),
  };
}

function makeMockApiCompletion() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    getCompletion: vi.fn().mockResolvedValue('api completion'),
    updateConfig: vi.fn(),
    recycleAll: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getActivePreset: vi.fn().mockReturnValue({ displayName: 'Haiku 4.5' }),
  };
}

function makeMockApiCommand() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    sendPrompt: vi.fn().mockResolvedValue('api command result'),
    sendPromptWithDetail: vi.fn().mockResolvedValue({
      text: 'api command result',
      detail: { providerName: 'x_ai', requestModel: 'grok-4', outputTokens: 12 },
    }),
    updateConfig: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('BackendRouter', () => {
  let mockPoolClient: ReturnType<typeof makeMockPoolClient>;
  let mockApiCompletion: ReturnType<typeof makeMockApiCompletion>;
  let mockApiCommand: ReturnType<typeof makeMockApiCommand>;

  beforeEach(() => {
    mockPoolClient = makeMockPoolClient();
    mockApiCompletion = makeMockApiCompletion();
    mockApiCommand = makeMockApiCommand();
  });

  describe('with claude-code backend', () => {
    it('delegates getCompletion to poolClient', async () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      const ctx = makeProseContext();
      const result = await router.getCompletion(ctx, new AbortController().signal);
      expect(result).toBe('cli completion');
      expect(mockPoolClient.getCompletion).toHaveBeenCalled();
      expect(mockApiCompletion.getCompletion).not.toHaveBeenCalled();
    });

    it('delegates isAvailable to poolClient', () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      expect(router.isAvailable()).toBe(true);
      expect(mockPoolClient.isAvailable).toHaveBeenCalled();
    });

    it('delegates sendCommand to poolClient', async () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      const result = await router.sendCommand('test message');
      expect(result.text).toBe('cli command result');
      expect(mockPoolClient.sendCommand).toHaveBeenCalledWith('test message', undefined);
    });

    it('reports backend as claude-code', () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      expect(router.getBackend()).toBe('claude-code');
    });

    it('returns CLI model name', () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      expect(router.getCurrentModel()).toBe('haiku');
    });
  });

  describe('with api backend', () => {
    it('delegates getCompletion to apiCompletion', async () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      const ctx = makeProseContext();
      const result = await router.getCompletion(ctx, new AbortController().signal);
      expect(result).toBe('api completion');
      expect(mockApiCompletion.getCompletion).toHaveBeenCalled();
      expect(mockPoolClient.getCompletion).not.toHaveBeenCalled();
    });

    it('delegates isAvailable to apiCompletion', () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      expect(router.isAvailable()).toBe(true);
      expect(mockApiCompletion.isAvailable).toHaveBeenCalled();
    });

    it('delegates sendCommand to apiCommand', async () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      const result = await router.sendCommand('test message');
      expect(result.text).toBe('api command result');
      expect(mockApiCommand.sendPromptWithDetail).toHaveBeenCalledWith(
        expect.any(String),
        'test message',
        undefined,
        undefined,
      );
    });

    it('reports backend as api', () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      expect(router.getBackend()).toBe('api');
    });

    it('returns API preset display name', () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      expect(router.getCurrentModel()).toBe('Haiku 4.5');
    });
  });

  describe('config updates', () => {
    it('propagates updateConfig to all providers', () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      const newConfig = makeConfig({ backend: 'api' });
      router.updateConfig(newConfig);

      expect(mockPoolClient.updateConfig).toHaveBeenCalledWith(newConfig);
      expect(mockApiCompletion.updateConfig).toHaveBeenCalledWith(newConfig);
      expect(mockApiCommand.updateConfig).toHaveBeenCalledWith(newConfig);
    });

    it('switches backend on config update', async () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      // Initially uses CLI
      expect(router.getBackend()).toBe('claude-code');

      // Switch to API
      router.updateConfig(makeConfig({ backend: 'api' }));
      expect(router.getBackend()).toBe('api');

      // Now completions go to API
      const ctx = makeProseContext();
      await router.getCompletion(ctx, new AbortController().signal);
      expect(mockApiCompletion.getCompletion).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('disposes all providers', () => {
      const config = makeConfig({ backend: 'claude-code' });
      const router = new BackendRouter(
        mockPoolClient as any,
        mockApiCompletion as any,
        mockApiCommand as any,
        config,
      );

      router.dispose();
      expect(mockPoolClient.dispose).toHaveBeenCalled();
      expect(mockApiCompletion.dispose).toHaveBeenCalled();
      expect(mockApiCommand.dispose).toHaveBeenCalled();
    });
  });

  describe('null API providers', () => {
    it('returns null for API completions when no provider', async () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(mockPoolClient as any, null, null, config);

      const ctx = makeProseContext();
      const result = await router.getCompletion(ctx, new AbortController().signal);
      expect(result).toBeNull();
    });

    it('reports unavailable when no API provider', () => {
      const config = makeConfig({ backend: 'api' });
      const router = new BackendRouter(mockPoolClient as any, null, null, config);

      expect(router.isAvailable()).toBe(false);
    });
  });
});

describe('BackendRouter — command trace records', () => {
  function build(
    backend: 'claude-code' | 'api',
    captureContent = true,
  ): {
    router: BackendRouter;
    recorder: TraceRecorder;
    pool: ReturnType<typeof makeMockPoolClient>;
    api: ReturnType<typeof makeMockApiCommand>;
  } {
    const pool = makeMockPoolClient();
    const api = makeMockApiCommand();
    const router = new BackendRouter(
      pool as any,
      makeMockApiCompletion() as any,
      api as any,
      makeConfig({ backend, trace: { captureContent, file: false } }),
    );
    const recorder = new TraceRecorder({ captureContent });
    router.setTraceRecorder(recorder);
    return { router, recorder, pool, api };
  }

  it('records a chat span for a CLI command, rebuilding detail from pool metadata', async () => {
    const { router, recorder, pool } = build('claude-code');
    pool.sendCommand.mockResolvedValue({
      text: 'feat: add tracing',
      meta: {
        model: 'claude-sonnet-4-5',
        durationMs: 900,
        durationApiMs: 850,
        costUsd: 0.5,
        turnCostUsd: 0.01,
        inputTokens: 3,
        outputTokens: 20,
        cacheReadTokens: 4000,
        cacheCreationTokens: 0,
        sessionId: 's',
        stopReason: 'end_turn',
      },
    });
    await router.sendCommand('DIFF', { traceSource: 'commit-message' });
    const [r] = recorder.getRecent();
    expect(r).toMatchObject({
      operation: 'chat',
      source: 'commit-message',
      backend: 'claude-code',
      outcome: 'ok',
      providerName: 'anthropic',
    });
    expect(r.detail).toMatchObject({
      requestModel: 'sonnet',
      responseModel: 'claude-sonnet-4-5',
      costUsd: 0.01,
      finishReason: 'end_turn',
      content: { userMessage: 'DIFF', rawOutput: 'feat: add tracing' },
    });
    // The prompt was not sent over the pool socket for the trace's sake.
    expect(pool.sendCommand).toHaveBeenCalledWith('DIFF', { traceSource: 'commit-message' });
  });

  it('records API command detail and omits content when capture is off', async () => {
    const { router, recorder } = build('api', false);
    await router.sendCommand('FIX THIS', { traceSource: 'suggest-edit' });
    const [r] = recorder.getRecent();
    expect(r.source).toBe('suggest-edit');
    expect(r.backend).toBe('api');
    expect(r.providerName).toBe('x_ai');
    expect(r.detail?.outputTokens).toBe(12);
    expect(JSON.stringify(r)).not.toContain('FIX THIS');
  });

  it('records a CLI command the pool ended as error with its type, or aborted', async () => {
    const { router, recorder, pool } = build('claude-code');
    pool.sendCommand.mockResolvedValue({ text: null, meta: null, errorType: 'pool_recycled' });
    await router.sendCommand('x');
    const [r] = recorder.getRecent();
    expect(r.outcome).toBe('error');
    expect(r.detail?.errorType).toBe('pool_recycled');

    pool.sendCommand.mockResolvedValue({ text: null, meta: null, aborted: true });
    await router.sendCommand('x');
    expect(recorder.getRecent()[0].outcome).toBe('aborted');
  });

  it("records the backend's own reason over the wall-clock timeout guess", async () => {
    const { router, recorder, pool } = build('claude-code');
    pool.sendCommand.mockResolvedValue({ text: null, meta: null, errorType: 'timeout' });
    await router.sendCommand('x', { timeoutMs: 60_000 });
    expect(recorder.getRecent()[0]).toMatchObject({ outcome: 'error', errorType: 'timeout' });

    // A slow pool failure is not relabelled a timeout.
    pool.sendCommand.mockResolvedValue({ text: null, meta: null, errorType: 'pool_recycled' });
    await router.sendCommand('x', { timeoutMs: 0 });
    expect(recorder.getRecent()[0]).toMatchObject({ outcome: 'error', errorType: 'pool_recycled' });
  });

  it('passes timeoutMs to the API command provider', async () => {
    const { router, api } = build('api');
    const cancel = new AbortController();
    await router.sendCommand('x', { timeoutMs: 1234, onCancel: cancel.signal });
    expect(api.sendPromptWithDetail).toHaveBeenCalledWith(
      expect.any(String),
      'x',
      cancel.signal,
      1234,
    );
  });

  it('classifies cancelled, timed-out, and thrown commands', async () => {
    const { router, recorder, pool } = build('claude-code');
    pool.sendCommand.mockResolvedValue({ text: null, meta: null });

    const controller = new AbortController();
    controller.abort();
    await router.sendCommand('x', { onCancel: controller.signal });
    expect(recorder.getRecent()[0].outcome).toBe('aborted');

    await router.sendCommand('x', { timeoutMs: 0 });
    expect(recorder.getRecent()[0]).toMatchObject({ outcome: 'error', errorType: 'timeout' });

    await router.sendCommand('x');
    expect(recorder.getRecent()[0].outcome).toBe('empty');

    pool.sendCommand.mockRejectedValue(new TypeError('bad'));
    await expect(router.sendCommand('x')).rejects.toThrow('bad');
    expect(recorder.getRecent()[0]).toMatchObject({ outcome: 'error', errorType: 'TypeError' });
  });

  it('routes getCompletionWithDetail like getCompletion (incl. code override)', async () => {
    const pool = makeMockPoolClient();
    const apiCompletion = {
      ...makeMockApiCompletion(),
      getCompletionWithDetail: vi.fn().mockResolvedValue({ text: 'api', detail: undefined }),
      getCompletionWithPresetDetail: vi.fn().mockResolvedValue({ text: 'override' }),
    };
    const poolWithDetail = {
      ...pool,
      getCompletionWithDetail: vi.fn().mockResolvedValue({ text: 'cli' }),
    };
    const router = new BackendRouter(
      poolWithDetail as any,
      apiCompletion as any,
      makeMockApiCommand() as any,
      makeConfig({ codeOverride: { backend: 'api', model: 'openai-gpt-4.1-nano' } }),
    );
    const opts = { captureContent: true };
    expect(
      (await router.getCompletionWithDetail(makeProseContext(), new AbortController().signal, opts))
        .text,
    ).toBe('cli');
    expect(poolWithDetail.getCompletionWithDetail.mock.calls[0][2]).toBe(opts);
    const code = { ...makeProseContext(), mode: 'code' as const };
    expect(
      (await router.getCompletionWithDetail(code, new AbortController().signal, opts)).text,
    ).toBe('override');
    expect(apiCompletion.getCompletionWithPresetDetail.mock.calls[0][0]).toBe(
      'openai-gpt-4.1-nano',
    );
  });
});
