import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeConfig, makeLogger, createMockToken } from '../helpers';
import { ExtensionConfig, CompletionProvider as ICompletionProvider } from '../../types';

// Mock vscode module - must define classes inside the factory to avoid hoisting issues
vi.mock('vscode', () => {
  class MockInlineCompletionItem {
    insertText: string;
    range: any;
    constructor(text: string, range: any) {
      this.insertText = text;
      this.range = range;
    }
  }

  class MockRange {
    start: any;
    end: any;
    constructor(start: any, end: any) {
      this.start = start;
      this.end = end;
    }
  }

  class MockPosition {
    line: number;
    character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  }

  return {
    InlineCompletionItem: MockInlineCompletionItem,
    InlineCompletionTriggerKind: { Invoke: 1, Automatic: 0 },
    Range: MockRange,
    Position: MockPosition,
    window: {
      showErrorMessage: vi.fn(),
      setStatusBarMessage: vi.fn(),
    },
  };
});

// Import after mock is set up
import { CompletionProvider } from '../../completion-provider';
import { TraceRecorder, attachDetailToError, buildSpanAttributes } from '../../utils/trace';
import * as vscode from 'vscode';

// Create a mock document
function createMockDocument(content: string, languageId = 'markdown') {
  const lines = content.split('\n');
  return {
    getText: vi
      .fn()
      .mockImplementation(
        (range?: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        }) => {
          if (!range) return content;
          // Simple extraction for testing
          const startOffset =
            lines.slice(0, range.start.line).join('\n').length +
            (range.start.line > 0 ? 1 : 0) +
            range.start.character;
          const endOffset =
            lines.slice(0, range.end.line).join('\n').length +
            (range.end.line > 0 ? 1 : 0) +
            range.end.character;
          return content.slice(startOffset, endOffset);
        },
      ),
    offsetAt: vi.fn().mockImplementation((pos: { line: number; character: number }) => {
      let offset = 0;
      for (let i = 0; i < pos.line; i++) {
        offset += lines[i].length + 1;
      }
      return offset + pos.character;
    }),
    positionAt: vi.fn().mockImplementation((offset: number) => {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        if (remaining <= lines[line].length) {
          return { line, character: remaining };
        }
        remaining -= lines[line].length + 1;
      }
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    }),
    lineAt: vi.fn().mockImplementation((line: number) => ({
      text: lines[line] || '',
    })),
    lineCount: lines.length,
    languageId,
    fileName: 'test.md',
    uri: { fsPath: '/test/test.md' },
  };
}

// Create a mock inline completion context
function createMockInlineContext(triggerKind: number) {
  return {
    triggerKind,
    selectedCompletionInfo: undefined,
  };
}

// Trigger kind constants
const TriggerKind = { Invoke: 1, Automatic: 0 };

// Create a mock completion provider
function createMockProvider(
  getCompletionResult: string | null = 'test completion',
): ICompletionProvider & {
  updateConfig?: (config: ExtensionConfig) => void;
  recycleAll?: () => Promise<void>;
} {
  return {
    getCompletion: vi.fn().mockResolvedValue(getCompletionResult),
    isAvailable: vi.fn().mockReturnValue(true),
    updateConfig: vi.fn(),
    recycleAll: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CompletionProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('trigger mode handling', () => {
    it('ignores automatic triggers in manual mode', async () => {
      const mockProvider = createMockProvider();
      const config = makeConfig({ triggerMode: 'manual' });
      const provider = new CompletionProvider(config, mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const result = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });

    it('responds to explicit triggers in manual mode', async () => {
      const mockProvider = createMockProvider();
      const config = makeConfig({ triggerMode: 'manual' });
      const provider = new CompletionProvider(config, mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      // Manual trigger uses zero delay
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      provider.dispose();
    });

    it('responds to automatic triggers in auto mode', async () => {
      const mockProvider = createMockProvider();
      const config = makeConfig({ triggerMode: 'auto' });
      const provider = new CompletionProvider(config, mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      await vi.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      provider.dispose();
    });

    it('explicit trigger fires with zero delay', async () => {
      const mockProvider = createMockProvider();
      const config = makeConfig({ triggerMode: 'auto' });
      const provider = new CompletionProvider(config, mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      // Zero delay for explicit trigger
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      provider.dispose();
    });
  });

  describe('punctuation suppression', () => {
    it('suppresses completion after period in prose mode', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world.');
      const position = { line: 0, character: 12 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const result = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });

    it('suppresses completion after question mark in prose mode', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world?');
      const position = { line: 0, character: 12 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const result = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });

    it('suppresses completion after semicolon in code mode', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('const x = 1;', 'typescript');
      const position = { line: 0, character: 12 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const result = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });

    it('does not suppress after period in code mode', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('object.', 'typescript');
      const position = { line: 0, character: 7 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      provider.dispose();
    });
  });

  describe('cache behavior', () => {
    it('returns cached result without calling provider', async () => {
      const mockProvider = createMockProvider('cached result');
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      // First call - fills the cache
      const resultPromise1 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise1;

      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(1);

      // Second call - should hit cache
      const token2 = createMockToken();
      const result2 = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token2 as any,
      );

      // Provider should not be called again
      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(1);
      expect(result2).not.toBeNull();
      expect((result2 as any)[0].insertText).toBe('cached result');
      provider.dispose();
    });

    it('clears cache via clearCache()', async () => {
      const mockProvider = createMockProvider('cached result');
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      // First call - fills the cache
      const resultPromise1 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise1;

      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(1);

      // Clear cache
      provider.clearCache();

      // Second call - should miss cache and call provider
      const token3 = createMockToken();
      const resultPromise3 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token3 as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise3;

      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(2);
      provider.dispose();
    });
  });

  describe('error handling and toast throttling', () => {
    it('shows error toast on provider error', async () => {
      const mockProvider = createMockProvider();
      (mockProvider.getCompletion as any).mockRejectedValue(new Error('Test error'));

      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Test error'),
      );
      provider.dispose();
    });

    it('throttles error toasts to 60-second intervals', async () => {
      const mockProvider = createMockProvider();
      (mockProvider.getCompletion as any).mockRejectedValue(new Error('Test error'));

      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);

      // First error - shows toast
      const token1 = createMockToken();
      const resultPromise1 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token1 as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise1;

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

      // Clear cache to force another provider call
      provider.clearCache();

      // Second error within 60s - should NOT show toast
      const token2 = createMockToken();
      const resultPromise2 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token2 as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise2;

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

      // Clear cache again
      provider.clearCache();

      // Advance past 60 seconds (must be > 60000, not ==)
      await vi.advanceTimersByTimeAsync(61000);

      // Third error after 60s - should show toast
      const token3 = createMockToken();
      const resultPromise3 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token3 as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise3;

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
      provider.dispose();
    });
  });

  describe('disabled state', () => {
    it('returns null when disabled', async () => {
      const mockProvider = createMockProvider();
      const config = makeConfig({ enabled: false });
      const provider = new CompletionProvider(config, mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const result = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });
  });

  describe('empty prefix handling', () => {
    it('returns null when prefix is empty/whitespace', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('   ');
      const position = { line: 0, character: 3 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token = createMockToken();

      const result = await provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });
  });

  describe('provider unavailability', () => {
    it('returns null when provider is not available', async () => {
      const mockProvider = createMockProvider();
      (mockProvider.isAvailable as any).mockReturnValue(false);

      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      expect(result).toBeNull();
      expect(mockProvider.getCompletion).not.toHaveBeenCalled();
      provider.dispose();
    });
  });

  describe('request callbacks', () => {
    it('calls onRequestStart and onRequestEnd', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const onStart = vi.fn();
      const onEnd = vi.fn();
      provider.setRequestCallbacks(onStart, onEnd);

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      provider.dispose();
    });

    it('calls onRequestEnd even on error', async () => {
      const mockProvider = createMockProvider();
      (mockProvider.getCompletion as any).mockRejectedValue(new Error('Test error'));

      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const onStart = vi.fn();
      const onEnd = vi.fn();
      provider.setRequestCallbacks(onStart, onEnd);

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      provider.dispose();
    });
  });

  describe('updateConfig', () => {
    it('propagates config to underlying provider', () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      const newConfig = makeConfig({ debounceMs: 500 });
      provider.updateConfig(newConfig);

      expect(mockProvider.updateConfig).toHaveBeenCalledWith(newConfig);
      provider.dispose();
    });
  });

  describe('recyclePool', () => {
    it('calls recycleAll on underlying provider', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      await provider.recyclePool();

      expect(mockProvider.recycleAll).toHaveBeenCalled();
      provider.dispose();
    });
  });
});

describe('CompletionProvider — trace outcomes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const detail = {
    providerName: 'anthropic',
    requestModel: 'sonnet',
    responseModel: 'claude-sonnet-4-5',
    inputTokens: 2,
    outputTokens: 7,
    cacheReadTokens: 1000,
    content: { systemPrompt: 'SYS', userMessage: 'MSG', rawOutput: '<COMPLETION>x</COMPLETION>' },
  };

  function setup(
    impl: (ctx: unknown, signal: AbortSignal, opts?: { captureContent?: boolean }) => unknown,
    configOverrides: Parameters<typeof makeConfig>[0] = {},
  ) {
    const mockProvider = {
      ...createMockProvider(),
      getCompletionWithDetail: vi.fn().mockImplementation(impl),
    };
    const provider = new CompletionProvider(
      makeConfig(configOverrides),
      mockProvider,
      makeLogger(),
    );
    const recorder = new TraceRecorder({ captureContent: true });
    provider.setTraceRecorder(recorder);
    return { mockProvider, provider, recorder };
  }

  async function invoke(
    provider: CompletionProvider,
    text = 'Hello world',
    token = createMockToken(),
  ) {
    const p = provider.provideInlineCompletionItems(
      createMockDocument(text) as any,
      { line: 0, character: text.length } as any,
      createMockInlineContext(TriggerKind.Invoke),
      token as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    return p;
  }

  it('records ok with detail, final text, timing, and requests content capture', async () => {
    const { mockProvider, provider, recorder } = setup(async () => ({
      text: ' there',
      detail,
    }));
    await invoke(provider);
    const [r] = recorder.getRecent();
    expect(r.outcome).toBe('ok');
    expect(r.operation).toBe('text_completion');
    expect(r.source).toBe('completion');
    expect(r.mode).toBe('prose');
    expect(r.languageId).toBe('markdown');
    expect(r.finalText).toBe(' there');
    expect(r.detail?.outputTokens).toBe(7);
    expect(r.requestId).toMatch(/^[0-9a-f]{4}$/);
    expect(r.endTimeMs).toBeGreaterThanOrEqual(r.startTimeMs);
    expect(r.startTimeMs).toBeGreaterThanOrEqual(r.receivedAtMs);
    expect(mockProvider.getCompletionWithDetail.mock.calls[0][2]).toEqual({ captureContent: true });
    provider.dispose();
  });

  it('asks providers not to capture content when the setting is off', async () => {
    const { mockProvider, provider, recorder } = setup(async () => ({ text: 'x', detail }), {
      trace: { captureContent: false, file: false },
    });
    await invoke(provider);
    expect(mockProvider.getCompletionWithDetail.mock.calls[0][2]).toEqual({
      captureContent: false,
    });
    // The recorder strips anything a provider returned anyway.
    recorder.setCaptureContent(false);
    await invoke(provider, 'Another line');
    expect(recorder.getRecent()[0].detail?.content).toBeUndefined();
    provider.dispose();
  });

  it('records cache_hit without calling the backend again', async () => {
    const { mockProvider, provider, recorder } = setup(async () => ({ text: ' there', detail }));
    await invoke(provider);
    await invoke(provider);
    expect(mockProvider.getCompletionWithDetail).toHaveBeenCalledTimes(1);
    const [hit, ok] = recorder.getRecent();
    expect(ok.outcome).toBe('ok');
    expect(hit.outcome).toBe('cache_hit');
    expect(hit.finalText).toBe(' there');
    expect(hit.detail).toBeUndefined();
    expect(hit.requestModel).toBe('sonnet');
    expect(hit.providerName).toBe('anthropic');
    provider.dispose();
  });

  it('records empty when the model returns nothing', async () => {
    const { provider, recorder } = setup(async () => ({ text: null, detail }));
    await invoke(provider);
    expect(recorder.getRecent()[0].outcome).toBe('empty');
    provider.dispose();
  });

  it('records aborted when the request was superseded or cancelled after sending', async () => {
    const { provider, recorder } = setup(async () => ({
      text: null,
      detail: { ...detail, aborted: true },
    }));
    await invoke(provider);
    expect(recorder.getRecent()[0].outcome).toBe('aborted');

    const token = createMockToken();
    const cancelling = setup(async () => {
      token.cancel();
      return { text: null, detail };
    });
    await invoke(cancelling.provider, 'Hello world', token);
    expect(cancelling.recorder.getRecent()[0].outcome).toBe('aborted');
    provider.dispose();
    cancelling.provider.dispose();
  });

  it('records error (with detail) when the provider throws, and still shows the toast', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    attachDetailToError(err, detail);
    const { provider, recorder } = setup(async () => {
      throw err;
    });
    await invoke(provider);
    const [r] = recorder.getRecent();
    expect(r.outcome).toBe('error');
    expect(r.errorType).toBe('429');
    expect(r.errorMessage).toBe('rate limited');
    expect(r.detail?.requestModel).toBe('sonnet');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    provider.dispose();
  });

  it('records error when a swallowed backend failure is reported in detail', async () => {
    const { provider, recorder } = setup(async () => ({
      text: null,
      detail: { providerName: 'anthropic', requestModel: 'sonnet', errorType: 'pool_error' },
    }));
    await invoke(provider);
    expect(recorder.getRecent()[0].outcome).toBe('error');
    provider.dispose();
  });

  it('records a pool kill as error with its type, not as aborted', async () => {
    const { provider, recorder } = setup(async () => ({
      text: null,
      detail: { providerName: 'anthropic', requestModel: 'sonnet', errorType: 'pool_recycled' },
    }));
    await invoke(provider);
    const [r] = recorder.getRecent();
    expect(r.outcome).toBe('error');
    expect(r.detail?.errorType).toBe('pool_recycled');
    expect(buildSpanAttributes(r, false)['error.type']).toBe('pool_recycled');
    provider.dispose();
  });

  it('records error when the backend is unavailable', async () => {
    const { mockProvider, provider, recorder } = setup(async () => ({ text: 'x' }));
    (mockProvider.isAvailable as any).mockReturnValue(false);
    await invoke(provider);
    const [r] = recorder.getRecent();
    expect(r.outcome).toBe('error');
    expect(r.errorType).toBe('backend_unavailable');
    provider.dispose();
  });

  it('does not record debounce-cancelled requests', async () => {
    const { provider, recorder } = setup(async () => ({ text: 'x' }));
    const token = createMockToken();
    const p = provider.provideInlineCompletionItems(
      createMockDocument('Hello world') as any,
      { line: 0, character: 11 } as any,
      createMockInlineContext(TriggerKind.Automatic),
      token as any,
    );
    token.cancel();
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(recorder.getRecent()).toHaveLength(0);
    provider.dispose();
  });

  it('falls back to getCompletion for providers without detail support', async () => {
    const mockProvider = createMockProvider('plain');
    const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());
    const recorder = new TraceRecorder({ captureContent: true });
    provider.setTraceRecorder(recorder);
    await invoke(provider);
    const [r] = recorder.getRecent();
    expect(r.outcome).toBe('ok');
    expect(r.detail).toBeUndefined();
    expect(r.finalText).toBe('plain');
    provider.dispose();
  });

  it('labels API-backend records with the preset model and provider', async () => {
    const { provider, recorder } = setup(async () => ({ text: null }), {
      backend: 'api',
      api: { preset: 'xai-grok', customPresets: [] },
    });
    await invoke(provider);
    const [r] = recorder.getRecent();
    expect(r.backend).toBe('api');
    expect(r.providerName).toBe('x_ai');
    provider.dispose();
  });
});
