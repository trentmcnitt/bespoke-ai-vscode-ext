/* Bespoke AI playground, live mode: when a completion request may go out, and how a live run's bench
 * events are put together. Pure (no DOM, no timers, no fetch): replay.js drives it, and the unit tests
 * load it with require(). Loads as a browser global (window.LiveRequests) or a CommonJS module.
 *
 * Requests (Trent, 10-05: a request only on a real edit and a pause, or ⌥↵):
 *   - the same document, cursor and model as the last answer never asks again: the answer is reused;
 *   - Monaco also asks on its own (it re-asks when the pointer rests on the ghost text, after a
 *     command): an automatic ask goes out only if the visitor edited since the last request;
 *   - ⌥↵ (an explicit ask) always may, unless the answer for that exact spot is already in hand.
 *
 * Bench events (bench SPEC §3a: send each boundary when it happens). The page owns the start of a live
 * run: run_started and the debounce (queue) step when the visitor pauses, the debounce's end and
 * prompt_build's start when the request leaves. The server sends the rest as it happens (its first
 * events the moment the request goes to the model, the remainder with the answer). adopt() folds the
 * server's events into the page's run: its run id, its own sequence numbers, and the page's clock. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveRequests = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function key(presetId, prefix, suffix) {
    return presetId + '\u0000' + prefix.length + '\u0000' + prefix + '\u0000' + suffix;
  }

  /** The request gate: decide() before an ask, sent() when a request leaves, answered() with its text. */
  function createGate() {
    let last = null; // { key, text }: the last answer
    let armed = false; // the visitor edited since the last request
    return {
      /** The document changed by the visitor's hand (typing, paste, delete, an accepted suggestion). */
      edited() {
        armed = true;
      },
      /** Entering live mode: nothing asks until the visitor edits or presses ⌥↵. */
      reset() {
        armed = false;
      },
      /** 'reuse' (return the last answer), 'skip' (no edit since the last request) or 'request'. */
      decide(k, explicit) {
        if (last && last.key === k) return 'reuse';
        if (!explicit && !armed) return 'skip';
        return 'request';
      },
      lastText() {
        return last ? last.text : null;
      },
      sent() {
        armed = false;
      },
      answered(k, text) {
        if (text) last = { key: k, text };
      },
    };
  }

  /** The page's side of one live run. ts in seconds (page clock). */
  function newRun(runId, sessionId) {
    return { runId, sessionId, seq: 0, lastTs: 0, offset: null };
  }

  function stamp(run, ev) {
    const ts = Math.max(ev.ts, run.lastTs);
    run.lastTs = ts;
    return Object.assign({}, ev, {
      v: 'bench/0',
      session_id: run.sessionId,
      run_id: run.runId,
      seq: ++run.seq,
      ts,
      content_mode: ev.content_mode || 'full',
    });
  }

  /** An event the page itself sends for the run. */
  function own(run, node, eventType, tsSec, data) {
    const ev = { node, event_type: eventType, ts: tsSec, data: data || {} };
    if (node !== '_run') ev.step_id = run.runId + ':' + node + ':1';
    return stamp(run, ev);
  }

  /**
   * The server's events, as this run's: the page already sent run_started (the server's arrives as
   * run_updated, carrying what the server knows, e.g. "prose · xai-grok"), the debounce step and
   * prompt_build's start. Times move onto the page's clock: the first batch is placed so its newest
   * event lands when it arrived (nowSec), so durations between server events stay exactly as measured
   * and nothing from the server can look earlier than what the page already sent.
   */
  function adopt(run, events, nowSec) {
    if (!events || !events.length) return [];
    if (run.offset === null) {
      const newest = Math.max.apply(
        null,
        events.map((e) => e.ts),
      );
      run.offset = nowSec - newest;
    }
    const out = [];
    for (const ev of events) {
      if (ev.node === 'queue') continue;
      if (ev.node === 'prompt_build' && ev.event_type === 'step_started') continue;
      if (ev.event_type === 'run_started') {
        out.push(
          stamp(run, {
            node: '_run',
            event_type: 'run_updated',
            ts: run.lastTs,
            data: { input: ev.data && ev.data.input },
          }),
        );
        continue;
      }
      const moved = Object.assign({}, ev, { ts: ev.ts + run.offset });
      if (ev.step_id) moved.step_id = ev.step_id.replace(ev.run_id, run.runId);
      out.push(stamp(run, moved));
    }
    return out;
  }

  /** Splits a streamed response body (NDJSON) into whole lines, keeping a partial last line. */
  function lines(buffer) {
    const parts = buffer.split('\n');
    const rest = parts.pop();
    return { lines: parts.filter((l) => l.trim()), rest };
  }

  return { key, createGate, newRun, own, adopt, lines };
});
