import { describe, it, expect } from 'vitest';
import {
  TRACE_VIEW_MAX_ROWS,
  TRACE_VIEW_SCRIPT,
  TraceViewItem,
  buildTraceViewHtml,
  isTraceViewClientMessage,
  toTraceViewItem,
} from '../../utils/trace-view-html';
import { TraceRecord } from '../../utils/trace';

const NONCE = 'abcdefghijklmnopqrstuvwx';
const HOSTILE = '<img src=x onerror="alert(1)"></pre><script>alert(2)</script>&amp;';

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: '0'.repeat(32),
    spanId: '1'.repeat(16),
    requestId: 'beef',
    source: 'completion',
    operation: 'text_completion',
    backend: 'api',
    mode: 'prose',
    languageId: 'markdown',
    outcome: 'ok',
    providerName: 'anthropic',
    requestModel: 'claude-haiku-4-5',
    receivedAtMs: 1_000,
    startTimeMs: 3_000,
    endTimeMs: 3_450,
    debounceMs: 2_000,
    detail: {
      providerName: 'anthropic',
      requestModel: 'claude-haiku-4-5',
      responseModel: 'claude-haiku-4-5-20251001',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 90,
      durationApiMs: 400,
      finishReason: 'end_turn',
      content: {
        systemPrompt: HOSTILE,
        userMessage: HOSTILE,
        rawOutput: HOSTILE,
        extracted: HOSTILE,
      },
    },
    finalText: HOSTILE,
    ...overrides,
  };
}

// ── Minimal fake DOM: just the surface the client script uses. innerHTML throws. ──
class FakeEl {
  className = '';
  hidden = false;
  open = false;
  children: FakeEl[] = [];
  private text = '';
  private listeners = new Map<string, Array<() => void>>();
  constructor(public tagName: string) {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  set innerHTML(_v: string) {
    throw new Error('innerHTML must never be used');
  }
  get innerHTML(): string {
    throw new Error('innerHTML must never be used');
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  get lastChild(): FakeEl | null {
    return this.children[this.children.length - 1] ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c: FakeEl): FakeEl {
    this.children.splice(this.children.indexOf(c), 1);
    return c;
  }
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  fire(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  findAll(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      out.push(...c.findAll(pred));
    }
    return out;
  }
}

function runScript() {
  const byId: Record<string, FakeEl> = {
    list: new FakeEl('main'),
    count: new FakeEl('span'),
    notice: new FakeEl('p'),
    empty: new FakeEl('p'),
    clear: new FakeEl('button'),
  };
  const posted: unknown[] = [];
  let onMessage: (e: { data: unknown }) => void = () => {};
  const document = {
    getElementById: (id: string) => byId[id],
    createElement: (tag: string) => new FakeEl(tag),
  };
  const window = {
    addEventListener: (type: string, cb: (e: { data: unknown }) => void) => {
      if (type === 'message') onMessage = cb;
    },
  };
  const api = () => ({ postMessage: (m: unknown) => posted.push(m) });
  new Function('acquireVsCodeApi', 'document', 'window', TRACE_VIEW_SCRIPT)(api, document, window);
  return { byId, posted, send: (data: unknown) => onMessage({ data }) };
}

describe('trace view — HTML', () => {
  it('declares a strict nonce-based CSP with no remote sources', () => {
    const html = buildTraceViewHtml(NONCE);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    expect(csp).toBe(`default-src 'none'; style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}'`);
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).toContain(`<style nonce="${NONCE}">`);
    // Exactly one script and one style element, both nonce'd; no inline handlers/styles.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle="/i);
  });

  it('rejects a nonce that could break out of the attribute', () => {
    expect(() => buildTraceViewHtml('x" onload="alert(1)')).toThrow();
  });

  it('the client script never touches innerHTML / outerHTML / insertAdjacentHTML', () => {
    expect(TRACE_VIEW_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('trace view — client rendering', () => {
  it('announces ready, then renders hostile content as plain text', () => {
    const { byId, posted, send } = runScript();
    expect(posted).toEqual([{ type: 'ready' }]);

    send({ type: 'snapshot', items: [toTraceViewItem(makeRecord())], captureContent: true });
    const list = byId.list;
    expect(list.children).toHaveLength(1);
    expect(byId.count.textContent).toBe('1 request');
    expect(byId.empty.hidden).toBe(true);
    expect(byId.notice.hidden).toBe(true);

    const row = list.children[0];
    expect(row.tagName).toBe('details');
    const summary = row.children[0].textContent;
    expect(summary).toContain('shown');
    expect(summary).toContain('claude-haiku-4-5-20251001');
    expect(summary).toContain('450 ms');
    expect(summary).toContain('100 → 4 (90 cached)');

    // Body renders lazily on expand.
    row.open = true;
    row.fire('toggle');
    const pres = row.findAll((e) => e.tagName === 'pre');
    expect(pres.length).toBeGreaterThanOrEqual(4);
    for (const pre of pres) expect(pre.textContent).toBe(HOSTILE);
    // Hostile markup produced text, not elements.
    expect(row.findAll((e) => e.tagName === 'img' || e.tagName === 'script')).toHaveLength(0);
    expect(row.textContent).toContain('Model time');
  });

  it('prepends live records newest-first and caps the list', () => {
    const { byId, send } = runScript();
    send({ type: 'snapshot', items: [], captureContent: false });
    expect(byId.notice.hidden).toBe(false);
    expect(byId.empty.hidden).toBe(false);
    for (let i = 0; i < TRACE_VIEW_MAX_ROWS + 5; i++) {
      send({ type: 'append', item: toTraceViewItem(makeRecord({ requestId: `r${i}` })) });
    }
    expect(byId.list.children).toHaveLength(TRACE_VIEW_MAX_ROWS);
    const first = byId.list.children[0];
    first.open = true;
    first.fire('toggle');
    expect(first.textContent).toContain(`#r${TRACE_VIEW_MAX_ROWS + 4}`);
  });

  it('shows "content not captured" when records have no content', () => {
    const { byId, send } = runScript();
    const rec = makeRecord({ finalText: undefined });
    delete rec.detail!.content;
    send({ type: 'snapshot', items: [toTraceViewItem(rec)], captureContent: false });
    const row = byId.list.children[0];
    row.open = true;
    row.fire('toggle');
    expect(row.textContent).toContain('Content not captured.');
    expect(row.textContent).not.toContain('<img');
  });

  it('clear button posts a clear request; malformed messages are ignored', () => {
    const { byId, posted, send } = runScript();
    send(null);
    send({ type: 42 });
    send({ type: 'append' });
    expect(byId.list.children).toHaveLength(0);
    byId.clear.fire('click');
    expect(posted).toContainEqual({ type: 'clear' });
  });
});

describe('trace view — host helpers', () => {
  it('toTraceViewItem computes totals and timings', () => {
    const item: TraceViewItem = toTraceViewItem(makeRecord());
    expect(item.inputTokens).toBe(100);
    expect(item.latencyMs).toBe(450);
    expect(item.debounceMs).toBe(2000);
    expect(item.apiMs).toBe(400);
    expect(item.costUsd).toBeNull();
    expect(item.model).toBe('claude-haiku-4-5-20251001');
    expect(item.content?.final).toBe(HOSTILE);
  });

  it('cache hits without detail still render', () => {
    const item = toTraceViewItem(
      makeRecord({ outcome: 'cache_hit', detail: undefined, finalText: 'x' }),
    );
    expect(item.model).toBe('claude-haiku-4-5');
    expect(item.inputTokens).toBeNull();
    expect(item.content?.final).toBe('x');
  });

  it('validates client messages', () => {
    expect(isTraceViewClientMessage({ type: 'ready' })).toBe(true);
    expect(isTraceViewClientMessage({ type: 'clear' })).toBe(true);
    expect(isTraceViewClientMessage({ type: 'eval' })).toBe(false);
    expect(isTraceViewClientMessage(null)).toBe(false);
  });
});
