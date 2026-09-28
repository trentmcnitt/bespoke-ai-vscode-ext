import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { registerCustomPresets } from '../../providers/api/presets';
import { makeConfig, makeLogger, makeProseContext, makeCodeContext } from '../helpers';

// ApiCompletionProvider with the real adapters and the real `openai` SDK, pointed
// at a local HTTP server through custom presets. Nothing leaves the machine.
// The server accepts only `Bearer good`; everything else gets a 401.

const MAIN_KEY_VAR = 'BESPOKE_HTTP_TEST_MAIN_KEY';
const OVER_KEY_VAR = 'BESPOKE_HTTP_TEST_OVER_KEY';

let server: http.Server;
let base = '';
const seen: Array<{ auth: string; mode: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const auth = String(req.headers['authorization'] ?? '');
      const mode = String(req.headers['x-mode'] ?? '');
      seen.push({ auth, mode });
      if (mode === '503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"overloaded"}}');
        return;
      }
      if (auth !== 'Bearer good') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"bad key"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '<COMPLETION>x</COMPLETION>' }, finish_reason: 'stop' }],
          model: `served-${mode}`,
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

beforeEach(() => {
  seen.length = 0;
});

/** Registers `custom-main` (and `custom-over`, answering in `overMode`) and returns a config using main. */
function mainConfig(overMode = 'over') {
  registerCustomPresets([
    {
      name: 'main',
      provider: 'openai-compat',
      modelId: 'main-model',
      baseUrl: base,
      apiKeyEnvVar: MAIN_KEY_VAR,
      extraHeaders: { 'x-mode': 'main' },
    },
    {
      name: 'over',
      provider: 'openai-compat',
      modelId: 'over-model',
      baseUrl: base,
      apiKeyEnvVar: OVER_KEY_VAR,
      extraHeaders: { 'x-mode': overMode },
    },
  ]);
  const cfg = makeConfig({ backend: 'api' });
  return { ...cfg, api: { ...cfg.api, preset: 'custom-main' } };
}

describe('ApiCompletionProvider over HTTP — API key replacement', () => {
  it('main preset: a bad key replaced with a good one takes effect without reloading', async () => {
    process.env[MAIN_KEY_VAR] = 'bad';
    const config = mainConfig();
    const provider = new ApiCompletionProvider(config, makeLogger());

    await expect(
      provider.getCompletion(makeProseContext(), new AbortController().signal),
    ).rejects.toThrow(/API key invalid/);
    const before = await provider.testConnection();
    expect(before.ok).toBe(false);

    // What `setApiKey` amounts to: the key resolves differently, and the router
    // passes the (unchanged-preset) config along.
    process.env[MAIN_KEY_VAR] = 'good';
    provider.updateConfig(config);

    const after = await provider.testConnection();
    expect(after).toMatchObject({ ok: true, model: 'served-main' });
    await expect(
      provider.getCompletion(makeProseContext(), new AbortController().signal),
    ).resolves.toBe('x');
    expect(seen.map((s) => s.auth)).toEqual([
      'Bearer bad',
      'Bearer bad',
      'Bearer good',
      'Bearer good',
    ]);
  });

  it('code override: a bad key replaced with a good one takes effect on the next request', async () => {
    process.env[MAIN_KEY_VAR] = 'good';
    process.env[OVER_KEY_VAR] = 'bad';
    const provider = new ApiCompletionProvider(mainConfig(), makeLogger());

    await expect(
      provider.getCompletionWithPreset(
        'custom-over',
        makeCodeContext(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/API key invalid/);

    process.env[OVER_KEY_VAR] = 'good';
    await expect(
      provider.getCompletionWithPreset(
        'custom-over',
        makeCodeContext(),
        new AbortController().signal,
      ),
    ).resolves.toBe('x');
  });
});

describe('ApiCompletionProvider over HTTP — overlapping requests', () => {
  // The SDK's retry backoff ignores the abort signal, so an override request
  // aborted during a 5xx retry stays in flight after the next request starts.
  // The old code had swapped the provider's adapter/preset fields for the
  // override's duration, so the main preset was replaced during that window.
  it('an override request stuck in retry backoff after its abort does not displace the main preset', async () => {
    process.env[MAIN_KEY_VAR] = 'good';
    process.env[OVER_KEY_VAR] = 'good';
    const provider = new ApiCompletionProvider(mainConfig('503'), makeLogger());

    const ac = new AbortController();
    const override = provider.getCompletionWithPreset('custom-over', makeCodeContext(), ac.signal);
    await new Promise((r) => setTimeout(r, 150)); // first 503 answered; SDK is in its retry sleep
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));

    expect(provider.getActivePreset()?.id).toBe('custom-main');
    await expect(
      provider.getCompletion(makeProseContext(), new AbortController().signal),
    ).resolves.toBe('x');
    expect(seen.at(-1)?.mode).toBe('main');

    await override.catch(() => null);
    expect(provider.getActivePreset()?.id).toBe('custom-main');
  }, 15_000);
});
