/**
 * HTML + client script for the "Recent Completions" webview. No `vscode` import so the
 * markup, CSP, and rendering can be unit-tested.
 *
 * Security model:
 *  - Strict CSP: `default-src 'none'`; the one <style> and one <script> carry a per-load nonce.
 *    No remote resources, no inline event handlers, no `style=` attributes (CSP would block them).
 *  - The HTML string contains NO record data. Records arrive via `postMessage` after the script
 *    reports `ready`, and every value is rendered with `textContent` — never `innerHTML`.
 */

import { TraceRecord, totalInputTokens } from './trace';

/** Flat, display-ready shape posted to the webview. */
export interface TraceViewItem {
  id: string;
  requestId: string;
  time: number;
  outcome: TraceRecord['outcome'];
  source: TraceRecord['source'];
  mode: string;
  languageId: string;
  backend: string;
  provider: string;
  model: string;
  requestModel: string;
  latencyMs: number;
  debounceMs: number | null;
  waitMs: number | null;
  apiMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  finishReason: string;
  errorType: string;
  errorMessage: string;
  content: {
    system: string | null;
    user: string | null;
    prefill: string | null;
    raw: string | null;
    extracted: string | null;
    final: string | null;
  } | null;
}

const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export function toTraceViewItem(r: TraceRecord): TraceViewItem {
  const d = r.detail;
  const c = d?.content;
  const hasContent = c !== undefined || r.finalText !== undefined;
  return {
    id: r.spanId,
    requestId: r.requestId,
    time: r.receivedAtMs,
    outcome: r.outcome,
    source: r.source,
    mode: r.mode ?? '',
    languageId: r.languageId ?? '',
    backend: r.backend,
    provider: d?.providerName || r.providerName,
    model: d?.responseModel || d?.requestModel || r.requestModel,
    requestModel: d?.requestModel || r.requestModel,
    latencyMs: Math.max(0, r.endTimeMs - r.startTimeMs),
    debounceMs: orNull(r.debounceMs),
    waitMs: orNull(d?.waitMs),
    apiMs: orNull(d?.durationApiMs),
    inputTokens: d ? orNull(totalInputTokens(d)) : null,
    outputTokens: orNull(d?.outputTokens),
    cacheReadTokens: orNull(d?.cacheReadTokens),
    cacheWriteTokens: orNull(d?.cacheWriteTokens),
    costUsd: orNull(d?.costUsd),
    finishReason: d?.finishReason ?? '',
    errorType: r.errorType ?? d?.errorType ?? '',
    errorMessage: r.errorMessage ?? d?.errorMessage ?? '',
    content: hasContent
      ? {
          system: orNull(c?.systemPrompt),
          user: orNull(c?.userMessage),
          prefill: orNull(c?.prefill),
          raw: c?.rawOutput ?? null,
          extracted: c?.extracted ?? null,
          final: r.finalText ?? null,
        }
      : null,
  };
}

/** Messages the host posts to the webview. */
export type TraceViewHostMessage =
  | { type: 'snapshot'; items: TraceViewItem[]; captureContent: boolean }
  | { type: 'append'; item: TraceViewItem };

/** Messages the webview posts to the host. */
export type TraceViewClientMessage = { type: 'ready' } | { type: 'clear' };

export function isTraceViewClientMessage(m: unknown): m is TraceViewClientMessage {
  const t = (m as { type?: unknown } | null)?.type;
  return t === 'ready' || t === 'clear';
}

/** Max rows kept in the DOM (matches the recorder's ring). */
export const TRACE_VIEW_MAX_ROWS = 200;

const STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0; padding: 0 16px 24px;
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
}
header {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px;
  padding: 10px 0; background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
header h1 { font-size: 1.1em; font-weight: 600; margin: 0; flex: 1; }
.muted { color: var(--vscode-descriptionForeground); }
button {
  font: inherit; color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground); border: none; padding: 3px 10px;
  border-radius: 2px; cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.notice {
  margin: 10px 0 0; padding: 6px 10px; border-left: 3px solid var(--vscode-editorInfo-foreground);
  background: var(--vscode-textBlockQuote-background);
}
.empty { margin-top: 24px; }
details { border-bottom: 1px solid var(--vscode-panel-border); }
summary {
  display: grid; align-items: center; gap: 10px; padding: 6px 4px; cursor: pointer; list-style: none;
  grid-template-columns: 7ch 9ch 5ch minmax(8ch, 1fr) 7ch 24ch 8ch;
  font-variant-numeric: tabular-nums;
}
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--vscode-list-hoverBackground); }
details[open] > summary { background: var(--vscode-list-inactiveSelectionBackground); }
.num { text-align: right; white-space: nowrap; }
.model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 0.85em; text-align: center;
  border: 1px solid currentColor;
}
.o-ok { color: var(--vscode-testing-iconPassed); }
.o-cache_hit { color: var(--vscode-charts-blue); }
.o-empty { color: var(--vscode-descriptionForeground); }
.o-aborted { color: var(--vscode-editorWarning-foreground); }
.o-error { color: var(--vscode-errorForeground); }
.body { padding: 4px 4px 14px 12px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 6px 0 10px; }
.facts dt { color: var(--vscode-descriptionForeground); }
.facts dd { margin: 0; word-break: break-word; font-variant-numeric: tabular-nums; }
h2 { font-size: 0.95em; font-weight: 600; margin: 12px 0 4px; }
pre {
  margin: 0; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
  background: var(--vscode-textCodeBlock-background); border-radius: 3px; max-height: 320px; overflow-y: auto;
}
.error-text { color: var(--vscode-errorForeground); }
@media (max-width: 560px) {
  summary { grid-template-columns: 7ch 9ch 5ch 1fr 7ch; }
  .wide { display: none; }
}
`;

/**
 * Client script. Plain ES2019 — runs in the webview. Uses only createElement / textContent /
 * appendChild / insertBefore / removeChild / className so it can be exercised with a tiny fake
 * DOM in unit tests.
 */
export const TRACE_VIEW_SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var MAX_ROWS = ${TRACE_VIEW_MAX_ROWS};
  var list = document.getElementById('list');
  var count = document.getElementById('count');
  var notice = document.getElementById('notice');
  var empty = document.getElementById('empty');
  var clearBtn = document.getElementById('clear');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function fmtMs(v) { return v === null || v === undefined ? '—' : Math.round(v) + ' ms'; }
  function fmtNum(v) { return v === null || v === undefined ? '—' : String(v); }
  function fmtCost(v) { return v === null || v === undefined ? '—' : '$' + v.toFixed(v < 0.01 ? 5 : 4); }
  function fmtTime(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  var OUTCOME_LABEL = { ok: 'shown', cache_hit: 'cached', empty: 'empty', aborted: 'aborted', error: 'error' };
  function kind(item) {
    if (item.source === 'completion') return item.mode || 'text';
    return item.source === 'commit-message' ? 'commit' : item.source === 'suggest-edit' ? 'edit' : 'cmd';
  }
  function tokens(item) {
    if (item.inputTokens === null && item.outputTokens === null) return '—';
    var s = fmtNum(item.inputTokens) + ' → ' + fmtNum(item.outputTokens);
    if (item.cacheReadTokens) s += ' (' + item.cacheReadTokens + ' cached)';
    return s;
  }
  function fact(dl, label, value) {
    if (value === null || value === undefined || value === '') return;
    dl.appendChild(el('dt', null, label));
    dl.appendChild(el('dd', null, value));
  }
  function block(parent, title, text) {
    if (text === null || text === undefined) return;
    parent.appendChild(el('h2', null, title));
    parent.appendChild(el('pre', null, text === '' ? '(empty)' : text));
  }

  function renderBody(item, body) {
    var dl = el('dl', 'facts');
    fact(dl, 'Outcome', OUTCOME_LABEL[item.outcome] || item.outcome);
    if (item.errorType) fact(dl, 'Error', item.errorType + (item.errorMessage ? ': ' + item.errorMessage : ''));
    fact(dl, 'Backend', item.backend);
    fact(dl, 'Provider', item.provider);
    fact(dl, 'Requested model', item.requestModel);
    fact(dl, 'Response model', item.model !== item.requestModel ? item.model : '');
    fact(dl, 'Language', item.languageId);
    fact(dl, 'Finish reason', item.finishReason);
    fact(dl, 'Tokens in', fmtNum(item.inputTokens) + (item.inputTokens !== null ? ' (incl. ' + (item.cacheReadTokens || 0) + ' cache read, ' + (item.cacheWriteTokens || 0) + ' cache write)' : ''));
    fact(dl, 'Tokens out', fmtNum(item.outputTokens));
    fact(dl, 'Cost', item.costUsd === null ? '' : fmtCost(item.costUsd));
    fact(dl, 'Debounce', item.debounceMs === null ? '' : fmtMs(item.debounceMs));
    fact(dl, 'Slot wait', item.waitMs === null ? '' : fmtMs(item.waitMs));
    fact(dl, 'Model time', item.apiMs === null ? '' : fmtMs(item.apiMs));
    fact(dl, 'Request total', fmtMs(item.latencyMs));
    fact(dl, 'Request id', '#' + item.requestId);
    body.appendChild(dl);
    var c = item.content;
    if (!c) {
      body.appendChild(el('p', 'muted', 'Content not captured.'));
      return;
    }
    block(body, 'Ghost text shown', c.final);
    block(body, 'System instructions', c.system);
    block(body, 'Message sent', c.user);
    block(body, 'Assistant prefill', c.prefill);
    block(body, 'Raw model output', c.raw);
    if (c.extracted !== c.raw) block(body, 'Extracted', c.extracted);
  }

  function renderRow(item) {
    var details = el('details');
    var summary = el('summary');
    summary.appendChild(el('span', 'muted', fmtTime(item.time)));
    var badge = el('span', 'badge o-' + (OUTCOME_LABEL[item.outcome] ? item.outcome : 'empty'), OUTCOME_LABEL[item.outcome] || item.outcome);
    summary.appendChild(badge);
    summary.appendChild(el('span', 'muted', kind(item)));
    summary.appendChild(el('span', 'model', item.model));
    summary.appendChild(el('span', 'num', fmtMs(item.latencyMs)));
    summary.appendChild(el('span', 'num wide', tokens(item)));
    summary.appendChild(el('span', 'num wide', fmtCost(item.costUsd)));
    details.appendChild(summary);
    var body = el('div', 'body');
    details.appendChild(body);
    var rendered = false;
    // Render the (potentially large) body lazily, on first expand.
    details.addEventListener('toggle', function () {
      if (!rendered && details.open) { rendered = true; renderBody(item, body); }
    });
    return details;
  }

  function updateCount() {
    var n = list.children.length;
    count.textContent = n + (n === 1 ? ' request' : ' requests');
    empty.hidden = n > 0;
  }

  function prepend(item) {
    list.insertBefore(renderRow(item), list.firstChild);
    while (list.children.length > MAX_ROWS) list.removeChild(list.lastChild);
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'snapshot') {
      while (list.firstChild) list.removeChild(list.firstChild);
      var items = Array.isArray(msg.items) ? msg.items : [];
      for (var i = items.length - 1; i >= 0; i--) prepend(items[i]);
      notice.hidden = msg.captureContent !== false;
      updateCount();
    } else if (msg.type === 'append' && msg.item) {
      prepend(msg.item);
      updateCount();
    }
  });
  clearBtn.addEventListener('click', function () { vscode.postMessage({ type: 'clear' }); });
  vscode.postMessage({ type: 'ready' });
})();
`;

/** Build the webview HTML. Contains no record data (records arrive via postMessage). */
export function buildTraceViewHtml(nonce: string): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error('invalid nonce');
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recent Completions</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
  <h1>Recent Completions</h1>
  <span id="count" class="muted">0 requests</span>
  <button id="clear" type="button" title="Clear the in-memory list for this window">Clear</button>
</header>
<p id="notice" class="notice" hidden>Content capture is off (<code>bespokeAI.trace.captureContent</code>). Prompts and outputs are not recorded; timing, tokens, and outcomes still are.</p>
<p id="empty" class="muted empty">No requests yet in this window. Records appear here as completions are requested.</p>
<main id="list"></main>
<script nonce="${nonce}">${TRACE_VIEW_SCRIPT}</script>
</body>
</html>`;
}
