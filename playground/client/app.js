/* Bespoke AI playground client: Monaco with an inline completions provider that
 * calls the local playground server. No build step; plain browser JS. */
'use strict';

// VS Code language id (sent to the server, drives prose/code mode) → Monaco language.
const LANGUAGES = [
  ['markdown', 'markdown', 'notes.md'],
  ['plaintext', 'plaintext', 'notes.txt'],
  ['typescript', 'typescript', 'main.ts'],
  ['javascript', 'javascript', 'main.js'],
  ['python', 'python', 'main.py'],
  ['go', 'go', 'main.go'],
  ['rust', 'rust', 'main.rs'],
  ['java', 'java', 'Main.java'],
  ['json', 'json', 'data.json'],
  ['html', 'html', 'index.html'],
  ['css', 'css', 'style.css'],
  ['shellscript', 'shell', 'run.sh'],
];

const params = new URLSearchParams(location.search);
// The bench shell passes ?bench_session=<id>; standalone, make one up.
const sessionId = params.get('bench_session') || 'pg-' + Math.random().toString(16).slice(2, 8);

const $ = (id) => document.getElementById(id);
const state = { scenarios: [], scenario: null, languageId: 'markdown', fileName: 'notes.md' };

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  Object.assign(e, attrs || {});
  if (text !== undefined) e.textContent = text;
  return e;
}

function setStatus(parts) {
  const footer = $('status');
  footer.replaceChildren();
  for (const p of parts) footer.append(p);
}

function span(text, cls) {
  return el('span', cls ? { className: cls } : {}, text);
}

function kv(k, v, cls) {
  const s = el('span');
  s.append(k + ' ', el('b', cls ? { className: cls } : {}, v));
  return s;
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    token.onCancellationRequested(() => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function showResult(r) {
  const parts = [];
  const cls = r.outcome === 'ok' ? 'ok' : r.outcome === 'error' ? 'bad' : '';
  parts.push(kv('outcome', r.outcome + (r.errorType ? ' (' + r.errorType + ')' : ''), cls));
  if (r.model) parts.push(kv('model', r.model));
  parts.push(kv('latency', r.latencyMs + ' ms'));
  if (r.costUsd !== undefined) parts.push(kv('cost', '$' + r.costUsd.toFixed(5)));
  const checks = el('span', { className: 'checks' });
  for (const c of r.checks || []) {
    const s = span((c.pass ? '✓ ' : '✗ ') + c.id, c.pass ? 'ok' : 'bad');
    s.title = c.detail;
    checks.append(s);
  }
  parts.push(checks);
  if (r.spend) {
    parts.push(kv('today', '$' + r.spend.usd.toFixed(4) + ' / $' + r.spend.capUsd));
  }
  setStatus(parts);
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
  return res.json();
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
    placeholder:
      'Start typing here — pause and Bespoke suggests the next words in gray. Tab accepts, Alt+Enter asks right away. Or pick a scenario above.',
  });

  const [info, presets, scenarios] = await Promise.all([
    getJson('/api/info'),
    getJson('/api/presets'),
    getJson('/api/scenarios'),
  ]);

  $('bench').href =
    info.benchUrl +
    '/?app=' +
    encodeURIComponent(info.appId) +
    '&session=' +
    encodeURIComponent(sessionId);

  const presetSel = $('preset');
  for (const p of presets) {
    const o = el(
      'option',
      { value: p.id, disabled: !p.usable },
      p.name + (p.usable ? '' : ' — ' + p.why),
    );
    presetSel.append(o);
  }
  // Default: the extension's default preset (xai-grok), else the first usable one.
  const firstUsable =
    presets.find((p) => p.usable && p.id === 'xai-grok') || presets.find((p) => p.usable);
  if (firstUsable) presetSel.value = firstUsable.id;

  const langSel = $('language');
  for (const [id] of LANGUAGES) langSel.append(el('option', { value: id }, id));

  state.scenarios = scenarios;
  const scenSel = $('scenario');
  scenSel.append(el('option', { value: '' }, '(blank — type your own)'));
  for (const group of ['prose', 'code']) {
    const og = el('optgroup', { label: group });
    for (const s of scenarios.filter((x) => x.mode === group)) {
      og.append(el('option', { value: s.id }, s.id));
    }
    scenSel.append(og);
  }

  function setLanguage(languageId, fileName) {
    const row = LANGUAGES.find((l) => l[0] === languageId);
    if (!row) {
      LANGUAGES.push([languageId, 'plaintext', fileName || 'file']);
      langSel.append(el('option', { value: languageId }, languageId));
    }
    const monacoLang = row ? row[1] : 'plaintext';
    state.languageId = languageId;
    state.fileName = fileName || (row ? row[2] : 'file');
    langSel.value = languageId;
    monaco.editor.setModelLanguage(editor.getModel(), monacoLang);
  }

  function loadScenario(id) {
    const s = state.scenarios.find((x) => x.id === id) || null;
    state.scenario = s;
    if (!s) {
      $('desc').textContent =
        'Type in the editor below; after a pause the suggestion appears in gray. Tab accepts.';
      editor.focus();
      return;
    }
    setLanguage(s.languageId, s.fileName);
    editor.setValue(s.prefix + s.suffix);
    const pos = editor.getModel().getPositionAt(s.prefix.length);
    editor.setPosition(pos);
    editor.revealPositionInCenter(pos);
    editor.focus();
    $('desc').textContent = s.description + ' — cursor is at the gap; press Alt+Enter to ask.';
  }

  scenSel.addEventListener('change', () => loadScenario(scenSel.value));
  langSel.addEventListener('change', () => {
    state.scenario = null;
    scenSel.value = '';
    setLanguage(langSel.value);
  });
  loadScenario('');
  setLanguage('markdown', 'notes.md');

  const trigger = () => {
    editor.focus();
    editor.trigger('playground', 'editor.action.inlineSuggest.trigger', {});
  };
  $('ask').addEventListener('click', trigger);
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, trigger);

  // Any edit away from the loaded scenario's text makes the checks' scenario flags stale.
  editor.onDidChangeModelContent((e) => {
    if (!e.isFlush) state.scenario = null;
  });

  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      async provideInlineCompletions(model, position, context, token) {
        const explicit =
          context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
        const mode = $('trigger').value;
        if (!explicit && mode === 'manual') return { items: [] };
        const debounceMs = explicit ? 0 : Number(mode);
        if (debounceMs && !(await sleep(debounceMs, token))) return { items: [] };

        const offset = model.getOffsetAt(position);
        const text = model.getValue();
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        setStatus([span('asking ' + presetSel.value + '…')]);
        let r;
        try {
          const res = await fetch('/api/complete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: ac.signal,
            body: JSON.stringify({
              presetId: presetSel.value,
              prefix: text.slice(0, offset),
              suffix: text.slice(offset),
              languageId: state.languageId,
              fileName: state.fileName,
              sessionId,
              debounceMs,
              scenarioId: state.scenario ? state.scenario.id : '',
            }),
          });
          r = await res.json();
          if (!res.ok) {
            setStatus([span(r.error || 'HTTP ' + res.status, 'bad')]);
            return { items: [] };
          }
        } catch (err) {
          if (!ac.signal.aborted) setStatus([span(String(err), 'bad')]);
          return { items: [] };
        }
        showResult(r);
        if (!r.text || token.isCancellationRequested) return { items: [] };
        return {
          items: [
            {
              insertText: r.text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        };
      },
      disposeInlineCompletions() {},
    },
  );

  setStatus([
    kv('session', sessionId),
    kv('today', '$' + info.spend.usd.toFixed(4) + ' / $' + info.spend.capUsd),
  ]);
});
