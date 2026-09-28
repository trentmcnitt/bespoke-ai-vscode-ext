import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { ApiCommandProvider } from '../../providers/api/api-command-provider';
import { BackendRouter } from '../../providers/backend-router';
import { registerCustomPresets } from '../../providers/api/presets';
import { TraceRecorder } from '../../utils/trace';
import { makeConfig, makeLogger } from '../helpers';

// A command's `timeoutMs` on the API backend, with the real `openai` SDK against
// a local server that never answers (nothing leaves the machine). Before the fix
// the router passed only the cancel signal, so these requests hung until the
// SDK's own 10-minute timeout.

const KEY_VAR = 'BESPOKE_CMD_TIMEOUT_TEST_KEY';

let server: http.Server;
let base = '';
let hits = 0;

beforeAll(async () => {
  process.env[KEY_VAR] = 'k';
  server = http.createServer((req) => {
    req.resume();
    hits++; // never answer
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(() => {
  server.closeAllConnections();
  hits = 0;
});

afterAll(() => {
  registerCustomPresets([]);
  delete process.env[KEY_VAR];
  server.close();
});

function build() {
  registerCustomPresets([
    {
      name: 'hang',
      provider: 'openai-compat',
      modelId: 'hang-model',
      baseUrl: base,
      apiKeyEnvVar: KEY_VAR,
    },
  ]);
  const cfg = makeConfig({ backend: 'api', trace: { captureContent: false, file: false } });
  const config = { ...cfg, api: { ...cfg.api, preset: 'custom-hang' } };
  const apiCommand = new ApiCommandProvider(config, makeLogger());
  const pool = { updateConfig: () => {}, dispose: () => {}, isCommandPoolAvailable: () => false };
  const router = new BackendRouter(pool as any, null, apiCommand, config);
  const recorder = new TraceRecorder({ captureContent: false });
  router.setTraceRecorder(recorder);
  return { router, recorder };
}

describe('BackendRouter.sendCommand timeoutMs on the API backend', () => {
  it('ends a hung request at timeoutMs even though a cancel signal is passed', async () => {
    const { router, recorder } = build();
    const cancel = new AbortController(); // never aborted, as in commit-message / suggest-edit
    const start = Date.now();
    const result = await router.sendCommand('diff', {
      timeoutMs: 300,
      onCancel: cancel.signal,
      traceSource: 'commit-message',
    });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.text).toBeNull();
    // On the result itself, as the CLI path reports it, not only in trace detail.
    expect(result.errorType).toBe('timeout');
    expect(result.aborted).toBeUndefined();
    expect(result.detail?.aborted).toBeUndefined();
    const [r] = recorder.getRecent();
    expect(r).toMatchObject({ outcome: 'error', errorType: 'timeout' });
    expect(r.detail?.errorType).toBe('timeout');
  }, 10_000);

  it('counts timeouts toward the command breaker; user cancels do not', async () => {
    const { router, recorder } = build();
    for (let i = 0; i < 4; i++) {
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 50);
      const r = await router.sendCommand('diff', { timeoutMs: 5000, onCancel: cancel.signal });
      expect(r).toMatchObject({ text: null, aborted: true });
      expect(r.errorType).toBeUndefined();
      expect(recorder.getRecent()[0].outcome).toBe('aborted');
    }
    expect(router.isCommandAvailable()).toBe(true);

    hits = 0;
    for (let i = 0; i < 5; i++) {
      await router.sendCommand('diff', { timeoutMs: 100, onCancel: new AbortController().signal });
    }
    expect(router.isCommandAvailable()).toBe(false);
    expect(hits).toBe(5); // one request each: the SDK did not retry a timed-out request
  }, 20_000);
});
