/* Bespoke AI playground, replay mode: plays recorded runs (recordings/index.json)
 * in Monaco with no server and no model calls, and, inside the bench shell, sends
 * each run's recorded bench events to the bench in step (bench SPEC §3a).
 * Plain browser JS, no build step; every path is relative so it works from any subpath. */
'use strict';

// VS Code language id → Monaco language.
const MONACO_LANG = {
  markdown: 'markdown',
  plaintext: 'plaintext',
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'javascript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  html: 'html',
  yaml: 'yaml',
  latex: 'plaintext',
};

/** Characters typed live before each request (the rest of the document is preloaded). */
const TYPED_CHARS = 48;
const TYPE_MS = 45;
/** How long the ghost text stays up before it is accepted. */
const GHOST_HOLD_MS = 2200;
/** Gaps in the recorded timeline longer than this are shortened (a slow model still reads as slow). */
const MAX_GAP_MS = 9000;
const ADVANCE_PAUSE_MS = 3500;

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ─── Bench sync (only inside the shell) ─────────────────────────────

const embedded = window.self !== window.top;
const benchSession = params.get('bench_session') || null;
const benchOrigin = (() => {
  const o = params.get('bench_origin');
  if (o) return o;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
})();

function toBench(msg) {
  if (!embedded || !benchOrigin) return;
  window.parent.postMessage(msg, benchOrigin);
}

// ─── Small DOM helpers ──────────────────────────────────────────────

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  Object.assign(e, attrs || {});
  if (text !== undefined) e.textContent = text;
  return e;
}
function kv(k, v, cls) {
  const s = el('span');
  s.append(k + ' ', el('b', cls ? { className: cls } : {}, v));
  return s;
}
function setStatus(parts) {
  $('status').replaceChildren(...parts);
}

function showResult(run) {
  const cls = run.outcome === 'ok' ? 'ok' : run.outcome === 'error' ? 'bad' : '';
  const parts = [kv('outcome', run.outcome, cls)];
  if (run.model) parts.push(kv('model', run.model));
  parts.push(kv('latency', run.latencyMs + ' ms'));
  if (run.costUsd !== undefined) parts.push(kv('est. cost', '$' + run.costUsd.toFixed(5)));
  const checks = el('span', { className: 'checks' });
  for (const c of run.checks) {
    const s = el('span', { className: c.pass ? 'ok' : 'bad' }, (c.pass ? '✓ ' : '✗ ') + c.id);
    s.title = c.detail;
    checks.append(s);
  }
  parts.push(checks);
  setStatus(parts);
}

// ─── Playback ───────────────────────────────────────────────────────

let playToken = 0; // bumped to cancel whatever is playing
let playCount = 0; // makes run ids unique when a recording is played twice

function wait(ms, token) {
  return new Promise((resolve) => setTimeout(() => resolve(token === playToken), ms));
}

function parseRecording(text) {
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const header = rows.length && rows[0].v === 'bench-recording/0' ? rows.shift() : null;
  return { header, events: rows };
}

/** Where the live-typed part starts: TYPED_CHARS back, moved forward to a word start. */
function typedStart(prefix) {
  let i = Math.max(0, prefix.length - TYPED_CHARS);
  while (i > 0 && i < prefix.length && !/\s/.test(prefix[i - 1])) i++;
  return i;
}

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/min/vs' } });
require(['vs/editor/editor.main'], async function () {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const editor = monaco.editor.create($('editor'), {
    value: '',
    language: 'markdown',
    theme: dark ? 'vs-dark' : 'vs',
    automaticLayout: true,
    wordWrap: 'on',
    minimap: { enabled: false },
    fontSize: 14,
    inlineSuggest: { enabled: true },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    autoClosingBrackets: 'never',
    autoClosingQuotes: 'never',
    autoIndent: 'none',
    // No cursor mark in the scrollbar gutter (it reads as a stray dash).
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
  });

  const [index, topology] = await Promise.all([
    fetch('recordings/index.json').then((r) => r.json()),
    fetch('topology.json').then((r) => r.json()),
  ]);
  toBench({ type: 'bench:register', app_id: topology.app.id, topology, story: null });

  // The ghost text the provider hands Monaco while a replay is at that point.
  let ghost = null;
  // Live mode state (null while replaying).
  let live = null;
  let liveCfg = null; // GET api/live/config, when this copy has a live backend
  // The document the editor holds, so live mode sends its language.
  let lastDoc = { languageId: 'markdown', fileName: 'notes.md' };
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      async provideInlineCompletions(model, position, context, token) {
        const at = new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        );
        if (live) {
          const text = await liveComplete(model, position, context, token);
          return text ? { items: [{ insertText: text, range: at }] } : { items: [] };
        }
        if (!ghost || model.getOffsetAt(position) !== ghost.offset) return { items: [] };
        return { items: [{ insertText: ghost.text, range: at }] };
      },
      disposeInlineCompletions() {},
    },
  );

  // Reveal a position, then round the scroll to a whole line so the top line isn't cut in half.
  function revealWholeLines(pos, center) {
    if (center) editor.revealPositionInCenter(pos);
    else editor.revealPositionInCenterIfOutsideViewport(pos);
    const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
    editor.setScrollTop(Math.round(editor.getScrollTop() / lh) * lh);
  }

  // ── pickers ──
  const scenSel = $('scenario');
  const presetSel = $('preset');
  const scenarioIds = [...new Set(index.runs.map((r) => r.scenarioId))];
  for (const id of scenarioIds) {
    scenSel.append(el('option', { value: id }, index.scenarios[id].label || id));
  }
  const presets = [...new Map(index.runs.map((r) => [r.presetId, r.presetName]))];
  for (const [id, name] of presets) presetSel.append(el('option', { value: id }, name));
  const findRun = () =>
    index.runs.find((r) => r.scenarioId === scenSel.value && r.presetId === presetSel.value);

  function advance() {
    const pi = presetSel.selectedIndex + 1;
    if (pi < presetSel.options.length) {
      presetSel.selectedIndex = pi;
    } else {
      presetSel.selectedIndex = 0;
      scenSel.selectedIndex = (scenSel.selectedIndex + 1) % scenSel.options.length;
    }
  }

  // ── what the bench has been told ──
  // The run the bench is following, until its run_finished: { runId, open } (open: the step
  // started and not finished). A replay that stops mid-run must end it (bench SPEC §3a), or the
  // bench keeps that step running by the wall clock.
  let inflight = null;
  function sendEvent(out) {
    if (out.event_type === 'run_started') inflight = { runId: out.run_id, open: null, last: out };
    if (inflight && out.run_id === inflight.runId) {
      inflight.last = out;
      if (out.event_type === 'step_started') inflight.open = out;
      else if (out.event_type === 'step_finished') inflight.open = null;
      else if (out.event_type === 'run_finished') inflight = null;
    }
    toBench({ type: 'bench:events', events: [out] });
  }
  /** Ends the run the bench is following, if any: the open step and the run as aborted. */
  function endRun() {
    if (!inflight) return;
    const { runId, open, last } = inflight;
    inflight = null;
    // Stamped like the run's own events, numbered on after its last one.
    let seq = typeof last.seq === 'number' ? last.seq : 0;
    const base = {
      v: 'bench/0',
      session_id: last.session_id,
      run_id: runId,
      ts: Math.max(Date.now() / 1000, last.ts),
      content_mode: last.content_mode,
    };
    const events = [];
    if (open) {
      events.push({
        ...base,
        seq: ++seq,
        event_type: 'step_finished',
        node: open.node,
        step_id: open.step_id,
        data: { status: 'aborted' },
      });
    }
    events.push({
      ...base,
      seq: ++seq,
      event_type: 'run_finished',
      node: '_run',
      data: { status: 'aborted', outcome: 'aborted' },
    });
    toBench({ type: 'bench:events', events });
  }

  // ── the replay's state, shown in the banner and on the Play buttons ──
  let playing = false;
  let playedOnce = false;
  function showReplayState(text) {
    const liveOn = !!(liveCfg && liveCfg.enabled);
    $('play').textContent = playing ? '■ Stop' : '▶ Play';
    $('bigPlay').textContent = playing
      ? '■ Stop'
      : playedOnce
        ? '▶ Play the recording again'
        : '▶ Play the recorded completion';
    $('bigPlay').classList.toggle('primary', !playing || !liveOn);
    $('bigTry').hidden = !liveOn;
    $('bigTry').classList.toggle('primary', liveOn && playing);
    const lead = el('b', {}, 'This is a recording of a real run. ');
    $('bannerText').replaceChildren(
      lead,
      text ||
        (liveOn
          ? 'Press Play to watch the ghost text arrive and the bench light up, or Try it yourself to type and get real completions.'
          : 'Press Play to watch the ghost text arrive and the bench light up.'),
    );
  }
  let nudgeTimer = 0;
  function nudge(text) {
    showReplayState(text);
    const b = $('banner');
    b.classList.remove('nudge');
    void b.offsetWidth;
    b.classList.add('nudge');
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => showReplayState(), 6000);
  }

  /** Stops whatever is playing and ends the bench's run with it. */
  function stop(message) {
    playToken++;
    ghost = null;
    endRun();
    playing = false;
    showReplayState();
    if (message) setStatus([el('span', {}, message)]);
  }

  async function play(run) {
    document.body.classList.add('replaying');
    endRun();
    const token = ++playToken;
    ghost = null;
    playing = true;
    playedOnce = true;
    showReplayState();
    const sc = index.scenarios[run.scenarioId];
    const recorded = new Date(run.recordedAt).toISOString().slice(0, 10);
    $('desc').replaceChildren(
      el('span', {}, sc.description + ' · ' + run.presetName),
      el(
        'span',
        { className: 'note' },
        '— replay of a real run recorded ' +
          recorded +
          '; the ghost text and checks are what came back.',
      ),
    );
    setStatus([el('span', {}, 'typing…')]);

    const recText = await fetch('recordings/' + run.recording).then((r) => r.text());
    if (token !== playToken) return;
    const { events } = parseRecording(recText);

    // Preload the document with the cursor TYPED_CHARS back, then type the rest.
    const cut = typedStart(sc.prefix);
    const model = editor.getModel();
    monaco.editor.setModelLanguage(model, MONACO_LANG[sc.languageId] || 'plaintext');
    lastDoc = { languageId: sc.languageId, fileName: sc.fileName };
    editor.setValue(sc.prefix.slice(0, cut) + sc.suffix);
    let offset = cut;
    editor.setPosition(model.getPositionAt(offset));
    revealWholeLines(model.getPositionAt(offset), true);
    for (const ch of sc.prefix.slice(cut)) {
      if (!(await wait(TYPE_MS, token))) return;
      const pos = model.getPositionAt(offset);
      editor.executeEdits('replay', [
        {
          range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
          text: ch,
        },
      ]);
      offset += ch.length;
      const next = model.getPositionAt(offset);
      editor.setPosition(next);
      revealWholeLines(next, false);
    }

    // Typing stopped: play the recorded run on its own clock, starting now.
    const runId = events[0].run_id + '-p' + ++playCount;
    const t0 = events[0].ts;
    let shift = 0; // ms removed from long gaps so far
    let prevTs = t0;
    const start = performance.now();
    setStatus([el('span', {}, 'waiting for a pause, then asking ' + run.presetName + '…')]);
    for (const ev of events) {
      const gap = (ev.ts - prevTs) * 1000;
      if (gap > MAX_GAP_MS) shift += gap - MAX_GAP_MS;
      prevTs = ev.ts;
      const due = (ev.ts - t0) * 1000 - shift;
      const delay = due - (performance.now() - start);
      if (delay > 0 && !(await wait(delay, token))) return;
      if (token !== playToken) return;
      const out = {
        ...ev,
        run_id: runId,
        ts: Date.now() / 1000,
        session_id: benchSession || ev.session_id,
      };
      if (ev.step_id) out.step_id = ev.step_id.replace(ev.run_id, runId);
      sendEvent(out);

      if (ev.node === 'post_process' && ev.event_type === 'step_finished' && run.text) {
        ghost = { text: run.text, offset };
        editor.focus();
        editor.trigger('replay', 'editor.action.inlineSuggest.trigger', {});
      }
      if (ev.event_type === 'run_finished') showResult(run);
    }
    toBench({ type: 'bench:replay_done', run_id: runId });

    if (ghost) {
      if (!(await wait(GHOST_HOLD_MS, token))) return;
      editor.trigger('replay', 'editor.action.inlineSuggest.commit', {});
      ghost = null;
    }
    if ($('auto').checked) {
      if (!(await wait(ADVANCE_PAUSE_MS, token))) return;
      advance();
      play(findRun());
      return;
    }
    playing = false;
    showReplayState();
  }

  const playSelected = () => {
    const run = findRun();
    if (run) play(run);
  };
  const playOrStop = () =>
    playing ? stop('Stopped. Press ▶ Play to watch the recording again.') : playSelected();
  $('play').addEventListener('click', playOrStop);
  $('bigPlay').addEventListener('click', playOrStop);
  scenSel.addEventListener('change', playSelected);
  presetSel.addEventListener('change', playSelected);
  // A replay is a recording: typing doesn't edit it (it would orphan the run on the bench and
  // never ask a model). A keystroke that would edit is held back, and the banner says what to do.
  const NAV_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Escape',
    'Tab',
    'Shift',
    'Control',
    'Alt',
    'Meta',
    'CapsLock',
  ]);
  const typingHint = () =>
    liveCfg && liveCfg.enabled
      ? 'Typing is off in a recording. Press Try it yourself to type and get real completions.'
      : 'Typing is off in a recording, which never calls a model. Press Play to watch the ghost text arrive.';
  editor.onKeyDown((e) => {
    if (live) return;
    const be = e.browserEvent;
    if (NAV_KEYS.has(be.key)) return;
    if ((be.metaKey || be.ctrlKey) && ['c', 'a', 'f'].includes(be.key.toLowerCase())) return;
    e.preventDefault();
    e.stopPropagation();
    nudge(typingHint());
  });
  for (const type of ['paste', 'cut', 'drop']) {
    $('editor').addEventListener(
      type,
      (e) => {
        if (live) return;
        e.preventDefault();
        e.stopPropagation();
        nudge(typingHint());
      },
      true,
    );
  }

  // ── live mode ──
  const LIVE_API = document.querySelector('meta[name="bespoke-live-api"]').content;
  // A static copy has no live API: the export empties the meta tag, so don't probe.
  liveCfg = !LIVE_API
    ? null
    : await fetch(LIVE_API + 'config', { signal: AbortSignal.timeout(4000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
  const liveSel = $('liveModel');
  if (liveCfg && liveCfg.enabled && liveCfg.presets.length) {
    for (const p of liveCfg.presets) liveSel.append(el('option', { value: p.id }, p.name));
    if (liveCfg.presets.some((p) => p.id === liveCfg.defaultPreset)) {
      liveSel.value = liveCfg.defaultPreset;
    }
    // In replay mode the banner carries the way in (bigTry); the header button is the way back.
    $('bigTry').hidden = false;
  }
  showReplayState();

  let session = null;
  async function getSession(renew) {
    if (session && !renew) return session;
    let turnstileToken = '';
    if (liveCfg.turnstileSiteKey) turnstileToken = await turnstile();
    const r = await fetch(LIVE_API + 'session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || 'could not start live mode');
    session = body.session;
    return session;
  }

  // Cloudflare Turnstile, loaded only when a visitor turns live mode on.
  function turnstile() {
    return new Promise((resolve, reject) => {
      const render = () => {
        $('turnstile').replaceChildren();
        window.turnstile.render('#turnstile', {
          sitekey: liveCfg.turnstileSiteKey,
          callback: (t) => {
            resolve(t);
            setTimeout(() => $('turnstile').replaceChildren(), 800);
          },
          'error-callback': () => reject(new Error('verification failed')),
        });
      };
      if (window.turnstile) return render();
      const sc = el('script', {
        src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        async: true,
      });
      sc.onload = render;
      sc.onerror = () => reject(new Error('could not load verification'));
      document.head.append(sc);
    });
  }

  function liveDesc(remaining) {
    const left = remaining
      ? ' ' + remaining.hour + ' left this hour, ' + remaining.day + ' today.'
      : '';
    $('desc').replaceChildren(
      el('span', {}, 'Live: type anywhere. After a pause the model suggests in gray; Tab accepts.'),
      el(
        'span',
        { className: 'note' },
        'Your text goes to the model provider to make the suggestion and is not stored.' + left,
      ),
    );
  }

  async function enterLive() {
    stop();
    $('mode').disabled = true;
    try {
      await getSession(false);
    } catch (err) {
      setStatus([el('span', { className: 'bad' }, String(err.message || err))]);
      $('mode').disabled = false;
      return;
    }
    live = { debounceMs: 800, ...lastDoc };
    document.body.classList.remove('replaying');
    $('banner').hidden = true;
    $('mode').hidden = false;
    $('mode').disabled = false;
    $('mode').textContent = '▶ Back to replay';
    $('replayControls').hidden = true;
    $('liveControls').hidden = false;
    liveDesc(null);
    setStatus([el('span', {}, 'Live · ' + liveSel.selectedOptions[0].textContent)]);
    editor.focus();
  }

  function exitLive(message) {
    live = null;
    $('banner').hidden = false;
    $('mode').hidden = true;
    $('mode').textContent = '✎ Try it yourself';
    $('replayControls').hidden = false;
    $('liveControls').hidden = true;
    playSelected();
    if (message) setTimeout(() => setStatus([el('span', { className: 'bad' }, message)]), 50);
  }

  $('mode').addEventListener('click', () => (live ? exitLive() : enterLive()));
  $('bigTry').addEventListener('click', () => enterLive());
  const askNow = () => {
    editor.focus();
    editor.trigger('live', 'editor.action.inlineSuggest.trigger', {});
  };
  $('ask').addEventListener('click', askNow);
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => live && askNow());

  function sleep(ms, token) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(true), ms);
      token.onCancellationRequested(() => {
        clearTimeout(t);
        resolve(false);
      });
    });
  }

  async function liveComplete(model, position, context, token) {
    const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
    const debounceMs = explicit ? 0 : live.debounceMs;
    if (debounceMs && !(await sleep(debounceMs, token))) return null;
    const offset = model.getOffsetAt(position);
    const text = model.getValue();
    if (!text.trim()) return null;
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const request = (sess) =>
      fetch(LIVE_API + 'complete', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-live-session': sess },
        body: JSON.stringify({
          presetId: liveSel.value,
          prefix: text.slice(0, offset),
          suffix: text.slice(offset),
          languageId: live.languageId || 'markdown',
          fileName: live.fileName || 'notes.md',
          sessionId: benchSession || 'live',
          debounceMs,
        }),
      });
    setStatus([el('span', {}, 'asking ' + liveSel.selectedOptions[0].textContent + '…')]);
    let r, body;
    try {
      r = await request(await getSession(false));
      if (r.status === 401) r = await request(await getSession(true));
      body = await r.json();
    } catch (err) {
      if (!ac.signal.aborted) setStatus([el('span', { className: 'bad' }, String(err))]);
      return null;
    }
    if (!r.ok) {
      if (body.fallback === 'replay') exitLive(body.error);
      else setStatus([el('span', { className: 'bad' }, body.error || 'HTTP ' + r.status)]);
      return null;
    }
    if (body.events && body.events.length) toBench({ type: 'bench:events', events: body.events });
    showResult(body);
    liveDesc(body.remaining);
    if (token.isCancellationRequested) return null;
    return body.text || null;
  }

  const first = params.get('run') && index.runs.find((r) => r.id === params.get('run'));
  if (first) {
    scenSel.value = first.scenarioId;
    presetSel.value = first.presetId;
  }
  playSelected();
});
