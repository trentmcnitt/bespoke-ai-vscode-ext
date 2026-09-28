import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { BackendRouter } from '../../providers/backend-router';
import { registerCustomPresets } from '../../providers/api/presets';
import { makeConfig, makeLogger, makeProseContext, makeCodeContext } from '../helpers';

// BackendRouter.isAvailable(mode) with the real ApiCompletionProvider, its real
// per-preset breakers, and the real `openai` SDK against a local server (nothing
// leaves the machine). `x-mode: fail` gets a 400 (not retried by the SDK), anything else a completion.

const MAIN_KEY_VAR = 'BESPOKE_AVAIL_TEST_MAIN_KEY';
const OVER_KEY_VAR = 'BESPOKE_AVAIL_TEST_OVER_KEY';

let server: http.Server;
let base = '';

beforeAll(async () => {
  process.env[MAIN_KEY_VAR] = 'k';
  process.env[OVER_KEY_VAR] = 'k';
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.headers['x-mode'] === 'fail') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"overloaded"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '<COMPLETION>x</COMPLETION>' }, finish_reason: 'stop' }],
          model: 'm',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  registerCustomPresets([]);
  delete process.env[MAIN_KEY_VAR];
  delete process.env[OVER_KEY_VAR];
  server.closeAllConnections();
  server.close();
});

/** Main preset `custom-main`, code override to `custom-over`; `failing` picks which one fails. */
function build(failing: 'main' | 'over') {
  const preset = (name: string, keyVar: string) => ({
    name,
    provider: 'openai-compat' as const,
    modelId: `${name}-model`,
    baseUrl: base,
    apiKeyEnvVar: keyVar,
    extraHeaders: { 'x-mode': failing === name ? 'fail' : 'ok' },
  });
  registerCustomPresets([preset('main', MAIN_KEY_VAR), preset('over', OVER_KEY_VAR)]);
  const cfg = makeConfig({
    backend: 'api',
    codeOverride: { backend: 'api', model: 'custom-over' },
  });
  const config = { ...cfg, api: { ...cfg.api, preset: 'custom-main' } };
  const api = new ApiCompletionProvider(config, makeLogger());
  const pool = { updateConfig: () => {}, dispose: () => {}, isAvailable: () => false };
  return new BackendRouter(pool as any, api, null, config);
}

async function failFiveTimes(router: BackendRouter, mode: 'prose' | 'code') {
  const ctx = mode === 'code' ? makeCodeContext() : makeProseContext();
  for (let i = 0; i < 5; i++) {
    await router.getCompletionWithDetail(ctx, new AbortController().signal).catch(() => {});
  }
}

describe('BackendRouter.isAvailable(mode) with a code override', () => {
  it('main breaker open, override healthy: code available, prose not', async () => {
    const router = build('main');
    await failFiveTimes(router, 'prose');
    expect(router.isAvailable()).toBe(false); // no-arg: the primary backend, as before
    expect(router.isAvailable('prose')).toBe(false);
    expect(router.isAvailable('code')).toBe(true);
    const code = await router.getCompletionWithDetail(
      makeCodeContext(),
      new AbortController().signal,
    );
    expect(code.text).toBe('x');
    router.dispose();
  }, 60_000);

  it('override breaker open: code unavailable, prose available', async () => {
    const router = build('over');
    await failFiveTimes(router, 'code');
    expect(router.isAvailable()).toBe(true);
    expect(router.isAvailable('prose')).toBe(true);
    expect(router.isAvailable('code')).toBe(false);
    // Had the orchestrator not checked, the provider itself declines it.
    const code = await router.getCompletionWithDetail(
      makeCodeContext(),
      new AbortController().signal,
    );
    expect(code.detail?.errorType).toBe('circuit_open');
    router.dispose();
  }, 60_000);

  it('an override with no API key stays available, so its request surfaces the key error', async () => {
    const router = build('main');
    delete process.env[OVER_KEY_VAR];
    try {
      expect(router.isAvailable('code')).toBe(true);
      await expect(
        router.getCompletionWithDetail(makeCodeContext(), new AbortController().signal),
      ).rejects.toThrow(/API key/);
    } finally {
      process.env[OVER_KEY_VAR] = 'k';
      router.dispose();
    }
  });

  it('an unknown override preset is unavailable for code only', () => {
    const router = build('over');
    router.updateConfig({
      ...makeConfig({ backend: 'api', codeOverride: { backend: 'api', model: 'nope' } }),
      api: { ...makeConfig().api, preset: 'custom-main' },
    });
    expect(router.isAvailable('code')).toBe(false);
    expect(router.isAvailable('prose')).toBe(true);
    router.dispose();
  });
});
