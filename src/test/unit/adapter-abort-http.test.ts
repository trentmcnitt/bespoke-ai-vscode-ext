import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { OpenAICompatAdapter } from '../../providers/api/adapters/openai-compat';
import { AnthropicAdapter } from '../../providers/api/adapters/anthropic';
import { ApiAdapter, Preset } from '../../providers/api/types';

// Abort classification in both SDK adapters, with the real `openai` and
// `@anthropic-ai/sdk` clients against a local HTTP server (nothing leaves the
// machine). The `x-mode` header picks the server's behaviour.

const KEY_VAR = 'BESPOKE_ABORT_TEST_KEY';

let server: http.Server;
let base = '';

beforeAll(async () => {
  process.env[KEY_VAR] = 'k';
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const mode = req.headers['x-mode'];
      if (mode === 'hang') return; // never answer
      if (mode === 'err-aborted') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream request was aborted by provider' } }));
        return;
      }
      if (mode === 'reset-midbody') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        res.write('{"choices":[');
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"unexpected mode"}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  delete process.env[KEY_VAR];
  server.closeAllConnections();
  server.close();
});

const messages = [{ role: 'user' as const, content: 'hi' }];
const opts = (signal: AbortSignal) => ({ signal, maxTokens: 10, temperature: 0 });

const makers: Record<string, (mode: string) => ApiAdapter> = {
  'openai-compat': (mode) =>
    new OpenAICompatAdapter({
      id: 'abort-test',
      displayName: 'abort test',
      provider: 'openai',
      modelId: 'm',
      apiKeyEnvVar: KEY_VAR,
      baseUrl: `${base}/v1`,
      extraHeaders: { 'x-mode': mode },
      maxTokens: 10,
      temperature: 0,
      promptStrategy: 'instruction-extraction',
    } as Preset),
  anthropic: (mode) =>
    new AnthropicAdapter({
      id: 'abort-test',
      displayName: 'abort test',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      apiKeyEnvVar: KEY_VAR,
      baseUrl: base,
      extraHeaders: { 'x-mode': mode },
      maxTokens: 10,
      temperature: 0,
      promptStrategy: 'prefill-extraction',
    } as Preset),
};

describe.each(Object.entries(makers))('%s adapter abort classification (real SDK)', (_, make) => {
  it('our own abort of a hung request is an abort (null, not thrown)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const result = await make('hang').complete('s', messages, opts(ac.signal));
    expect(result).toMatchObject({ text: null, aborted: true });
  });

  it('a server error whose message contains "aborted" is thrown, not swallowed as an abort', async () => {
    await expect(
      make('err-aborted').complete('s', messages, opts(new AbortController().signal)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('a connection reset mid-body is thrown', async () => {
    await expect(
      make('reset-midbody').complete('s', messages, opts(new AbortController().signal)),
    ).rejects.toThrow();
  });
});
