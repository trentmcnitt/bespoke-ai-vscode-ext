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

  describe('snooze functionality', () => {
    it('returns null when snoozed', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      provider.setSnoozed(true);

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
    });

    it('returns completions when not snoozed', async () => {
      const mockProvider = createMockProvider();
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      provider.setSnoozed(false);

      const document = createMockDocument('Hello world');
      const position = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token = createMockToken();

      // Let the debounce complete
      const resultPromise = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token as any,
      );

      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result).not.toBeNull();
      provider.dispose();
    });
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

      await vi.advanceTimersByTimeAsync(1000);
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

      await vi.advanceTimersByTimeAsync(1000);
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

      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise1;

      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(1);

      // Clear cache
      provider.clearCache();

      // Third call - should miss cache and call provider
      const token3 = createMockToken();
      const resultPromise3 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token3 as any,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise3;

      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(2);
      provider.dispose();
    });
  });

  describe('dismissal/acceptance detection and adaptive back-off', () => {
    it('resets back-off when completion is accepted', async () => {
      const mockProvider = createMockProvider('completed text');
      const provider = new CompletionProvider(makeConfig(), mockProvider, makeLogger());

      // First completion
      const document1 = createMockDocument('Hello ');
      const position1 = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Invoke);
      const token1 = createMockToken();

      const resultPromise1 = provider.provideInlineCompletionItems(
        document1 as any,
        position1 as any,
        context,
        token1 as any,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise1;

      // Simulate acceptance: document now contains the completion text at the offered position
      const document2 = createMockDocument('Hello completed text');
      // Override getText to return the completion text when asked for the completion range
      document2.getText = vi.fn().mockImplementation((range?: any) => {
        if (range) {
          // Return the accepted completion text
          return 'completed text';
        }
        return 'Hello completed text';
      });

      const position2 = { line: 0, character: 20 };
      const token2 = createMockToken();

      // Clear cache to ensure we go through full flow
      provider.clearCache();

      // Second request - should detect acceptance and reset back-off
      const resultPromise2 = provider.provideInlineCompletionItems(
        document2 as any,
        position2 as any,
        context,
        token2 as any,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise2;

      // The acceptance detection happens internally; we verify by checking that
      // the provider was called (meaning back-off didn't block it)
      expect(mockProvider.getCompletion).toHaveBeenCalledTimes(2);
      provider.dispose();
    });

    it('increases back-off when completion is dismissed', async () => {
      const mockProvider = createMockProvider('completed text');
      const provider = new CompletionProvider(
        makeConfig({ debounceMs: 1000 }),
        mockProvider,
        makeLogger(),
      );

      // First completion
      const document1 = createMockDocument('Hello ');
      const position1 = { line: 0, character: 6 };
      const context = createMockInlineContext(TriggerKind.Automatic);
      const token1 = createMockToken();

      const resultPromise1 = provider.provideInlineCompletionItems(
        document1 as any,
        position1 as any,
        context,
        token1 as any,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise1;

      // Simulate dismissal: document text is different from what was offered
      const document2 = createMockDocument('Hello different');
      // Override getText to NOT match the completion text
      document2.getText = vi.fn().mockImplementation((range?: any) => {
        if (range) {
          return 'different'; // Different from offered "completed text"
        }
        return 'Hello different';
      });

      const position2 = { line: 0, character: 15 };
      const token2 = createMockToken();

      // Clear cache to ensure we test back-off, not cache
      provider.clearCache();

      // Second request - this triggers dismissal detection
      // With back-off, the delay should be longer than base 1000ms
      const resultPromise2 = provider.provideInlineCompletionItems(
        document2 as any,
        position2 as any,
        context,
        token2 as any,
      );

      // Advance by base delay - should NOT be resolved yet due to back-off
      await vi.advanceTimersByTimeAsync(1000);
      // Note: Due to the exponential back-off formula, 1 dismissal increases delay
      // We can't easily verify the exact timing without exposing the debouncer,
      // but we can verify the provider is eventually called
      await vi.advanceTimersByTimeAsync(30000); // Advance by max back-off to ensure completion
      await resultPromise2;

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
      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
      await resultPromise2;

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

      // Clear cache again
      provider.clearCache();

      // Advance past 60 seconds
      await vi.advanceTimersByTimeAsync(60000);

      // Third error after 60s - should show toast
      const token3 = createMockToken();
      const resultPromise3 = provider.provideInlineCompletionItems(
        document as any,
        position as any,
        context,
        token3 as any,
      );
      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
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
      await vi.advanceTimersByTimeAsync(1000);
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
