# Playground

A local browser page for trying Bespoke AI's inline completions without VS Code, wired to the bench (`~/working_dir/agent-lab-bench`) so every completion shows up as a traced run. It is dev tooling: nothing here ships in the VSIX (`.vscodeignore` is an allowlist).

## Run it

```bash
# 1. the bench (optional; the playground works without it)
cd ~/working_dir/agent-lab-bench && uv run uvicorn bench.server:app --host 127.0.0.1 --port 8790

# 2. the playground, with API keys in its environment
uv run ~/hub-store/capabilities/credentials/credentials.py run \
  --need XAI_API_KEY,ANTHROPIC_API_KEY,OPENAI_API_KEY,GEMINI_API_KEY -- npm run playground
```

Open <http://127.0.0.1:8791/>, or side by side with the bench:
`http://127.0.0.1:8790/shell/?app=http://127.0.0.1:8791/&appid=bespoke-playground`.

Env: `PLAYGROUND_PORT` (8791), `BENCH_URL` (`http://127.0.0.1:8790`), `PLAYGROUND_DAILY_CAP_USD` (5).

## What runs

- **Real pipeline:** `ApiCompletionProvider` from `src/` (prompt strategy, adapter, extraction, post-processing), the extension's truncation and mode detection, and the eval suite's deterministic checks on every result. Not reused: `completion-provider.ts` (VS Code types). The page debounces (eager 0.8 s / relaxed 2 s / on demand, Alt+Enter) and there is no cache, so every request reaches the model.
- **API backend only.** The Claude Code backend is not offered.
- **Scenarios:** the synthetic quality scenarios (`src/test/quality/scenarios*.ts`); never `regression-scenarios.ts`, which is captured from private use. Custom-instruction scenarios are left out.
- **Presets offered:** built-in API presets with a key in the environment and a price in `prices.ts` (or local Ollama). No ledger: playground traffic stays out of `~/.bespokeai/usage-ledger.jsonl`.

## Bench events

`bench.ts` maps one completion to `bench/0` events against `topology.json` (`queue → prompt_build → model_call → extract → post_process → checks`) and registers the map at startup (`PUT /apps/bespoke-playground`). Every event carries the page's `?bench_session=` id.

- **Step timing:** the provider runs the pipeline in one call, so the only interior time it reports is the HTTP round trip (`durationApiMs`). `model_call` spans exactly that. `prompt_build` is the time before it, and `extract` / `post_process` sit at its end; those in-process steps take well under a millisecond and are not timed individually. `queue` is the page's debounce.
- **Cost:** `cost_source: "estimated"` from `prices.ts` (dated, per provider page), with the table in `cost_basis`. The daily cap counts the same estimates, persisted in `playground/.data/spend.json`. It counts usage the provider returned, so a request aborted after it reached the provider may bill without being counted: a local safety net, not a meter.
- **Content:** sent in full (`content_mode: "full"`): prompts, raw output, ghost text. Fine for a local bench and synthetic scenarios; anything public must redact typed text first.

## Replay (static)

`replay.html` plays recorded runs with no server and no model calls: it types the last few words of a scenario, waits out the recorded debounce, shows the recorded ghost text as Monaco ghost text, and accepts it. Inside the bench shell (`?sync=1`) it sends the run's recorded bench events to the bench in step (bench SPEC §3a: `bench:register` once, then `bench:events`, `ts` rewritten to now, `session_id` from `?bench_session=`, posted only to `?bench_origin=` or the referrer's origin).

- `npm run playground:record` (keys in the env): runs the 6 scenarios × 4 presets in `record.ts` once each and writes `recordings/` (`index.json` + one `*.recording.jsonl` per run, self-contained for the bench). Only synthetic scenario ids can be recorded, and results are kept as they came back, failed checks included. About $0.04 for all 24.
- `npm run playground:export [-- <dir>]`: writes `dist/playground/` (entry `index.html`, plus `replay.js`, `style.css`, `topology.json`, `recordings/`). Every path is relative, so it serves from any subpath; Monaco loads from cdn.jsdelivr.net.
- Try it: `python3 -m http.server 8792 --directory dist/playground`, then `http://127.0.0.1:8790/shell/?sync=1&app=http://127.0.0.1:8792/`. `?run=<scenario>__<preset>` picks the first run.
- `src/test/unit/playground-recordings.test.ts` fails if a recording holds anything but an unchanged synthetic scenario, or a file is stray.

## Live mode (“Try it yourself”)

The replay page opens on a replay; **Try it yourself** switches to live completions from a small model picker (Grok, Haiku 4.5, GPT-4.1 nano, Gemini Flash; Grok is the default). The page only shows the switch when `api/live/config` (relative to the page, set by the `bespoke-live-api` meta tag) answers `enabled: true`, so a plain static copy stays replay-only.

`live.ts` holds the logic, platform-neutral; `server.ts` serves it locally at `/api/live/*` (on by default, no Turnstile, in-memory limits: try `http://127.0.0.1:8791/replay.html`), and `serverless.ts` is the Vercel adapter, bundled by `npm run playground:build-api` to `dist/playground-api/live.js` (one file, no runtime dependencies).

Protections:

- **Per visitor:** 100 completions an hour and 200 a day (Trent, 2026-09-29), keyed on a salted hash of the IP (the raw IP is never stored).
- **Global daily cap:** estimated spend (`prices.ts`), `LIVE_DAILY_CAP_USD` (default 5). Over any limit, the page drops back to replay with the reason.
- **Bots:** Cloudflare Turnstile once per visit, then a signed session token for an hour.
- **Size:** 20k characters each side of the cursor accepted; the pipeline then uses the extension's window. `max_tokens` is the preset's (200). Request timeout 20 s.
- **Privacy:** the page says the text goes to the model provider and is not stored; nothing logs content, and bench events stay in the visitor's browser.
- **Backstop:** a dedicated API key per provider with a spend limit set at the provider. The counts above include requests the visitor's next keystroke cancelled, but the spend tally only counts usage the provider returned, so a cancelled request that still billed is missed; the provider-side limit covers that.

Deploy env: `LIVE_ENABLED=1`, `LIVE_SESSION_SECRET` (≥32 chars), `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`, `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (without them the limiter is per instance, which is wrong on serverless), `LIVE_DAILY_CAP_USD`, and `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`. Route `…/api/live/:route` to the function (it reads `req.query.route`, else the last path segment).

## Not yet

Suite mode, streaming. The live mode is built but not deployed (needs Trent's accounts).
