import { describe, it, expect } from 'vitest';
import { BackendRouter } from '../../providers/backend-router';
import { CompletionProvider, CompletionContext, ExtensionConfig } from '../../types';
import { makeConfig, makeProseContext } from '../helpers';

function makeMockProvider(name: string): CompletionProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isAvailable: () => {
      calls.push(`${name}:isAvailable`);
      return true;
    },
    getCompletion: async (ctx: CompletionContext, signal: AbortSignal) => {
      calls.push(`${name}:getCompletion`);
      return `result-from-${name}`;
    },
    updateConfig: (config: ExtensionConfig) => {
      calls.push(`${name}:updateConfig`);
    },
    recycleAll: async () => {
      calls.push(`${name}:recycleAll`);
    },
  };
}

describe('BackendRouter', () => {
  it('delegates to claude-code by default', async () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig({ backend: 'claude-code' });
    const router = new BackendRouter(claudeCode, api, config);

    const result = await router.getCompletion(makeProseContext(), new AbortController().signal);
    expect(result).toBe('result-from-claude-code');
    expect(claudeCode.calls).toContain('claude-code:getCompletion');
    expect(api.calls).not.toContain('api:getCompletion');
  });

  it('delegates to api when backend is api', async () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig({ backend: 'api' });
    const router = new BackendRouter(claudeCode, api, config);

    const result = await router.getCompletion(makeProseContext(), new AbortController().signal);
    expect(result).toBe('result-from-api');
    expect(api.calls).toContain('api:getCompletion');
    expect(claudeCode.calls).not.toContain('claude-code:getCompletion');
  });

  it('isAvailable reflects active backend', () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig({ backend: 'api' });
    const router = new BackendRouter(claudeCode, api, config);

    router.isAvailable();
    expect(api.calls).toContain('api:isAvailable');
    expect(claudeCode.calls).not.toContain('claude-code:isAvailable');
  });

  it('updateConfig switches backend', async () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig({ backend: 'claude-code' });
    const router = new BackendRouter(claudeCode, api, config);

    // Initially routes to claude-code
    let result = await router.getCompletion(makeProseContext(), new AbortController().signal);
    expect(result).toBe('result-from-claude-code');

    // Switch to API
    router.updateConfig(makeConfig({ backend: 'api' }));
    result = await router.getCompletion(makeProseContext(), new AbortController().signal);
    expect(result).toBe('result-from-api');
  });

  it('updateConfig propagates to both backends', () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig();
    const router = new BackendRouter(claudeCode, api, config);

    router.updateConfig(makeConfig());
    expect(claudeCode.calls).toContain('claude-code:updateConfig');
    expect(api.calls).toContain('api:updateConfig');
  });

  it('recycleAll propagates to both backends', async () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig();
    const router = new BackendRouter(claudeCode, api, config);

    await router.recycleAll();
    expect(claudeCode.calls).toContain('claude-code:recycleAll');
    expect(api.calls).toContain('api:recycleAll');
  });

  it('falls back to claude-code when api provider is null', async () => {
    const claudeCode = makeMockProvider('claude-code');
    const config = makeConfig({ backend: 'api' });
    const router = new BackendRouter(claudeCode, null, config);

    // Should fall back to claude-code since api is null
    const result = await router.getCompletion(makeProseContext(), new AbortController().signal);
    expect(result).toBe('result-from-claude-code');
  });

  it('getBackend returns the current backend', () => {
    const claudeCode = makeMockProvider('claude-code');
    const api = makeMockProvider('api');
    const config = makeConfig({ backend: 'api' });
    const router = new BackendRouter(claudeCode, api, config);

    expect(router.getBackend()).toBe('api');
    router.updateConfig(makeConfig({ backend: 'claude-code' }));
    expect(router.getBackend()).toBe('claude-code');
  });
});
