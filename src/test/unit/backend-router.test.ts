import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendRouter } from '../../providers/backend-router';
import { makeConfig, makeProseContext } from '../helpers';

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
      expect(mockApiCommand.sendPrompt).toHaveBeenCalled();
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
