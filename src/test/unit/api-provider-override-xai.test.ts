import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { makeConfig, makeLogger, makeCodeContext } from '../helpers';

// The real provider and real OpenAI-compat adapter, with only the `openai` SDK
// and key resolution mocked, so the headers the client is built with (the ones
// every request sends) are observable without a network.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  ctor: vi.fn(),
  resolveApiKey: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mocks.create } };
    constructor(opts: unknown) {
      mocks.ctor(opts);
    }
  },
}));

vi.mock('../../utils/api-key-store', () => ({
  resolveApiKey: mocks.resolveApiKey,
}));

const convIdOfClient = (i: number) =>
  (mocks.ctor.mock.calls[i][0] as { defaultHeaders?: Record<string, string> }).defaultHeaders?.[
    'x-grok-conv-id'
  ];

describe('code override to an xAI preset — cache affinity', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.ctor.mockReset();
    mocks.resolveApiKey.mockReset();
    mocks.resolveApiKey.mockReturnValue('xai-key');
    mocks.create.mockResolvedValue({
      choices: [{ message: { content: '<COMPLETION>x</COMPLETION>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
      model: 'grok',
    });
  });

  function makeProvider() {
    // Main preset is not xAI, so every xAI client built here belongs to the override.
    return new ApiCompletionProvider(
      makeConfig({ backend: 'api', api: { preset: 'openai-gpt-4.1-nano', customPresets: [] } }),
      makeLogger(),
    );
  }

  it('sends the same x-grok-conv-id on every override request while the key is unchanged', async () => {
    const provider = makeProvider();
    for (let i = 0; i < 3; i++) {
      await provider.getCompletionWithPreset('xai-grok-code', makeCodeContext(), signal());
    }
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.ctor).toHaveBeenCalledTimes(1);
    expect(convIdOfClient(0)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the conv id when a replaced key rebuilds the client', async () => {
    const provider = makeProvider();
    await provider.getCompletionWithPreset('xai-grok-code', makeCodeContext(), signal());
    mocks.resolveApiKey.mockReturnValue('xai-key-2');
    await provider.getCompletionWithPreset('xai-grok-code', makeCodeContext(), signal());
    expect(mocks.ctor).toHaveBeenCalledTimes(2);
    expect(convIdOfClient(1)).toBe(convIdOfClient(0));
  });
});

function signal() {
  return new AbortController().signal;
}
