import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiCommandProvider } from '../../providers/api/api-command-provider';
import { ApiAdapterResult, Preset } from '../../providers/api/types';
import { UsageLedger } from '../../utils/usage-ledger';
import { Logger } from '../../utils/logger';
import { makeConfig, makeLogger } from '../helpers';

const mocks = vi.hoisted(() => ({
  createAdapter: vi.fn(),
}));

vi.mock('../../providers/api/adapters', () => ({
  createAdapter: mocks.createAdapter,
}));

type CompleteFn = (
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: {
    signal: AbortSignal;
    maxTokens: number;
    temperature: number;
    stopSequences?: string[];
  },
) => Promise<ApiAdapterResult>;

interface FakeAdapter {
  preset: Preset;
  complete: ReturnType<typeof vi.fn<CompleteFn>>;
  isConfigured: ReturnType<typeof vi.fn<() => boolean>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function makeResult(overrides: Partial<ApiAdapterResult> = {}): ApiAdapterResult {
  return {
    text: 'feat: add widget\n\nAdds the widget.',
    usage: { inputTokens: 2000, outputTokens: 30 },
    model: 'fake-model',
    durationMs: 800,
    ...overrides,
  };
}

let adapters: FakeAdapter[];

function lastAdapter(): FakeAdapter {
  return adapters[adapters.length - 1];
}

const SYSTEM = 'You write commit messages.';
const USER = 'diff --git a/x b/x\n+hello';

describe('ApiCommandProvider', () => {
  beforeEach(() => {
    adapters = [];
    mocks.createAdapter.mockReset();
    mocks.createAdapter.mockImplementation((preset: Preset) => {
      const adapter: FakeAdapter = {
        preset,
        complete: vi.fn<CompleteFn>().mockResolvedValue(makeResult()),
        isConfigured: vi.fn(() => true),
        dispose: vi.fn(),
      };
      adapters.push(adapter);
      return { providerId: preset.provider, ...adapter };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sendPrompt', () => {
    it('passes the caller system prompt and user message through unmodified and returns raw text', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      // Tag-like content must NOT be extracted — commands return raw text.
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: '<corrected>fixed</corrected>' }),
      );

      const result = await provider.sendPrompt(SYSTEM, USER);

      expect(result).toBe('<corrected>fixed</corrected>');
      const [system, messages] = lastAdapter().complete.mock.calls[0];
      expect(system).toBe(SYSTEM);
      expect(messages).toEqual([{ role: 'user', content: USER }]);
    });

    it('uses 4096 max tokens regardless of the preset (presets are tuned for 200-token completions)', async () => {
      const provider = new ApiCommandProvider(
        makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }),
        makeLogger(),
      );
      await provider.sendPrompt(SYSTEM, USER);
      const options = lastAdapter().complete.mock.calls[0][2];
      expect(lastAdapter().preset.maxTokens).toBe(200);
      expect(options.maxTokens).toBe(4096);
      expect(options.temperature).toBe(0.2);
    });

    it('never sends a prefill message, even for a prefill preset', async () => {
      const provider = new ApiCommandProvider(
        makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }),
        makeLogger(),
      );
      await provider.sendPrompt(SYSTEM, USER);
      expect(lastAdapter().complete.mock.calls[0][1]).toHaveLength(1);
    });

    it('uses the caller signal when provided', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      const ac = new AbortController();
      await provider.sendPrompt(SYSTEM, USER, ac.signal);
      expect(lastAdapter().complete.mock.calls[0][2].signal).toBe(ac.signal);
    });

    it('supplies its own timeout signal when the caller omits one', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      await provider.sendPrompt(SYSTEM, USER);
      const sig = lastAdapter().complete.mock.calls[0][2].signal;
      expect(sig).toBeInstanceOf(AbortSignal);
      expect(sig.aborted).toBe(false);
    });

    it('returns null (does not throw) on an aborted response', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(makeResult({ text: null, aborted: true }));
      await expect(provider.sendPrompt(SYSTEM, USER)).resolves.toBeNull();
    });

    it('propagates adapter errors', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      const err = new Error('openai API key invalid or missing');
      lastAdapter().complete.mockRejectedValue(err);
      await expect(provider.sendPrompt(SYSTEM, USER)).rejects.toBe(err);
    });
  });

  describe('usage ledger', () => {
    it('records a command entry with tokens, cached tokens, duration and char counts', async () => {
      const record = vi.fn();
      const provider = new ApiCommandProvider(makeConfig(), makeLogger(), {
        record,
      } as unknown as UsageLedger);
      lastAdapter().complete.mockResolvedValue(
        makeResult({
          text: 'fix: typo',
          model: 'gpt-4.1-nano',
          durationMs: 777,
          usage: { inputTokens: 1500, outputTokens: 5, cacheReadTokens: 1024 },
        }),
      );

      await provider.sendPrompt(SYSTEM, USER);

      expect(record).toHaveBeenCalledWith({
        source: 'command',
        model: 'gpt-4.1-nano',
        backend: 'api',
        durationMs: 777,
        inputTokens: 1500,
        outputTokens: 5,
        cacheReadTokens: 1024,
        inputChars: SYSTEM.length + USER.length,
        outputChars: 'fix: typo'.length,
      });
    });
  });

  describe('circuit breaker', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('opens after 5 consecutive failures, blocks, and recovers after 30s', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();
      adapter.complete.mockRejectedValue(new Error('503'));

      for (let i = 0; i < 5; i++) {
        await expect(provider.sendPrompt(SYSTEM, USER)).rejects.toThrow('503');
      }
      expect(provider.isAvailable()).toBe(false);
      await expect(provider.sendPrompt(SYSTEM, USER)).resolves.toBeNull();
      expect(adapter.complete).toHaveBeenCalledTimes(5);

      vi.advanceTimersByTime(30_001);
      adapter.complete.mockResolvedValue(makeResult({ text: 'ok' }));
      await expect(provider.sendPrompt(SYSTEM, USER)).resolves.toBe('ok');
      expect(provider.isAvailable()).toBe(true);
    });

    it('counts empty non-aborted responses as failures but not aborts', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();

      adapter.complete.mockResolvedValue(makeResult({ text: null, aborted: true }));
      for (let i = 0; i < 6; i++) await provider.sendPrompt(SYSTEM, USER);
      expect(provider.isAvailable()).toBe(true);

      adapter.complete.mockResolvedValue(makeResult({ text: null }));
      for (let i = 0; i < 5; i++) await provider.sendPrompt(SYSTEM, USER);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('adapter lifecycle', () => {
    it('is unavailable when the adapter reports no API key', () => {
      mocks.createAdapter.mockImplementation((preset: Preset) => ({
        providerId: preset.provider,
        complete: vi.fn(),
        isConfigured: () => false,
        dispose: vi.fn(),
      }));
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      expect(provider.isAvailable()).toBe(false);
    });

    it('unknown preset: logs an error and sendPrompt returns null', async () => {
      const error = vi.fn();
      const logger = { ...makeLogger(), error } as unknown as Logger;
      const provider = new ApiCommandProvider(
        makeConfig({ api: { preset: 'missing', customPresets: [] } }),
        logger,
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining('"missing" not found'));
      expect(provider.isAvailable()).toBe(false);
      await expect(provider.sendPrompt(SYSTEM, USER)).resolves.toBeNull();
    });

    it('adapter construction failure is logged, not thrown', async () => {
      mocks.createAdapter.mockImplementation(() => {
        throw new Error('bad adapter');
      });
      const error = vi.fn();
      const provider = new ApiCommandProvider(makeConfig(), {
        ...makeLogger(),
        error,
      } as unknown as Logger);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('bad adapter'));
      await expect(provider.sendPrompt(SYSTEM, USER)).resolves.toBeNull();
    });

    it('updateConfig reloads only when the preset changes', () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      provider.updateConfig(makeConfig({ customInstructions: 'x' }));
      expect(adapters).toHaveLength(1);

      provider.updateConfig(
        makeConfig({ api: { preset: 'openai-gpt-4o-mini', customPresets: [] } }),
      );
      expect(adapters).toHaveLength(2);
      expect(adapters[0].dispose).toHaveBeenCalledTimes(1);
      expect(lastAdapter().preset.id).toBe('openai-gpt-4o-mini');
    });

    it('dispose releases the adapter and makes sendPrompt return null', async () => {
      const provider = new ApiCommandProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();
      provider.dispose();
      expect(adapter.dispose).toHaveBeenCalledTimes(1);
      await expect(provider.sendPrompt(SYSTEM, USER)).resolves.toBeNull();
      expect(adapter.complete).not.toHaveBeenCalled();
    });
  });
});
