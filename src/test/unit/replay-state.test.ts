import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// The replay page's state machine is plain browser JS (no build step); it exports for Node too.
const RS = createRequire(__filename)('../../../playground/client/replay-state.js') as {
  initial(): State;
  transition(s: State, a: Record<string, unknown>): { state: State; effects: string[] };
  banner(s: State, model?: string): Record<string, any>;
  typingHint(s: State): string;
};
type State = {
  mode: 'replay' | 'live';
  playing: boolean;
  playedOnce: boolean;
  stopped: boolean;
  via: 'try' | 'stop' | null;
  liveAvailable: boolean;
  blocked: string | null;
};

/** Runs actions from the initial state; returns the final state and every effect in order. */
function run(...actions: Array<Record<string, unknown>>) {
  let s = RS.initial();
  const effects: string[][] = [];
  for (const a of actions) {
    const r = RS.transition(s, a);
    s = r.state;
    effects.push(r.effects);
  }
  return { s, effects, last: effects[effects.length - 1] };
}
const LIVE = { type: 'config', available: true };
const NO_LIVE = { type: 'config', available: false };
const PLAY = { type: 'play' };

describe('replay state: stopping a replay goes live where it stopped', () => {
  it('Stop while playing, with live on: ends the bench run and goes live, no replay', () => {
    const { s, last } = run(LIVE, PLAY, { type: 'stop' });
    expect(s).toMatchObject({ mode: 'live', via: 'stop', playing: false, stopped: true });
    expect(last).toEqual(['halt', 'endRun', 'goLive']);
    const b = RS.banner(s, 'Grok 4.3');
    expect(b.lead).toBe('Stopped.');
    expect(b.text).toBe('Type or press ⌥↵ to have Grok 4.3 complete from here.');
    expect(b.play.label).toBe('▶ Play the recording again');
  });

  it('a keystroke while playing stops it, goes live, and lets the key through', () => {
    const { s, last } = run(LIVE, PLAY, { type: 'key' });
    expect(s.mode).toBe('live');
    expect(last).toEqual(['halt', 'endRun', 'goLive', 'passKey']);
  });

  it('a keystroke after a replay finished also goes live (text kept)', () => {
    const { s, last } = run(LIVE, PLAY, { type: 'finished' }, { type: 'key' });
    expect(s).toMatchObject({ mode: 'live', via: 'stop' });
    expect(last).toContain('passKey');
    expect(last).not.toContain('replay');
  });

  it('a click while playing stops it and goes live; a click when not playing does nothing', () => {
    expect(run(LIVE, PLAY, { type: 'click' }).s.mode).toBe('live');
    const idle = run(LIVE, PLAY, { type: 'finished' }, { type: 'click' });
    expect(idle.s.mode).toBe('replay');
    expect(idle.last).toEqual([]);
  });

  it('in live mode keys pass and Stop/click do nothing', () => {
    expect(run(LIVE, PLAY, { type: 'stop' }, { type: 'key' }).last).toEqual(['passKey']);
    expect(run(LIVE, PLAY, { type: 'stop' }, { type: 'stop' }).last).toEqual([]);
    expect(run(LIVE, PLAY, { type: 'stop' }, { type: 'click' }).last).toEqual([]);
  });

  it('Play from live leaves live, ends any run and replays', () => {
    const { s, last } = run(LIVE, PLAY, { type: 'stop' }, PLAY);
    expect(s).toMatchObject({ mode: 'replay', playing: true, via: null, stopped: false });
    expect(last).toEqual(['leaveLive', 'halt', 'endRun', 'replay']);
  });

  it('Try it yourself from the start goes live with the banner hidden', () => {
    const { s, last } = run(LIVE, { type: 'tryLive' });
    expect(s).toMatchObject({ mode: 'live', via: 'try' });
    expect(last).toEqual(['halt', 'endRun', 'goLive']);
    expect(RS.banner(s).hidden).toBe(true);
  });

  it('while playing with live on, the banner says it can be stopped and completed', () => {
    const b = RS.banner(run(LIVE, PLAY).s, 'Grok 4.3');
    expect(b.play.label).toBe('■ Stop');
    expect(b.text).toContain('Grok 4.3 completes from there');
    expect(b.tryShown).toBe(true);
  });
});

describe('replay state: live unavailable', () => {
  it('Stop just stops, explains, and offers Play', () => {
    const { s, last } = run(NO_LIVE, PLAY, { type: 'stop' });
    expect(s).toMatchObject({ mode: 'replay', playing: false, stopped: true });
    expect(last).toEqual(['halt', 'endRun']);
    const b = RS.banner(s);
    expect(b.lead).toBe('Stopped.');
    expect(b.play).toEqual({ label: '▶ Play the recording again', primary: true });
    expect(b.tryShown).toBe(false);
  });

  it('a keystroke is held back with a nudge, and the replay keeps playing', () => {
    const { s, last } = run(NO_LIVE, PLAY, { type: 'key' });
    expect(s.playing).toBe(true);
    expect(last).toEqual(['blockKey', 'nudge']);
    expect(run(NO_LIVE, PLAY, { type: 'click' }).last).toEqual([]);
    expect(run(NO_LIVE, { type: 'tryLive' }).s.mode).toBe('replay');
  });

  it('a cap hit in live returns to a stopped replay that says why, without auto-playing', () => {
    const reason = "Today's live budget is used up. Replays still work.";
    const { s, last } = run(LIVE, PLAY, { type: 'stop' }, { type: 'liveFailed', reason });
    expect(s).toMatchObject({ mode: 'replay', playing: false, stopped: true, blocked: reason });
    expect(last).toEqual(['leaveLive']);
    const b = RS.banner(s);
    expect(b.text).toBe(reason + ' Press Play to watch the recording again.');
    expect(b.play.primary).toBe(true);
    expect(b.tryShown).toBe(false);
    // From then on, stopping or typing no longer goes live.
    const after = run(LIVE, PLAY, { type: 'liveFailed', reason }, PLAY, { type: 'stop' });
    expect(after.s.mode).toBe('replay');
    const key = RS.transition(after.s, { type: 'key' });
    expect(key.effects).toEqual(['blockKey', 'nudge']);
    expect(RS.typingHint(after.s)).toContain(reason);
  });
});
