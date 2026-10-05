/* Bespoke AI playground: the replay page's modes and what moves between them, as plain
 * functions with no DOM, so they can be tested (src/test/unit/replay-state.test.ts).
 * replay.js dispatches the visitor's actions through transition() and carries out the effects.
 *
 * Modes:
 *   replay  a recording plays (playing) or sits stopped/finished.
 *   live    the visitor types and a real model completes. Entered from "Try it yourself"
 *           (via: 'try') or by stopping a replay (via: 'stop'), which keeps the text and the
 *           cursor exactly where the replay was, so the next pause or ⌥↵ completes from there.
 *
 * Stopping a replay (the Stop button, an editing keystroke, a click in the editor while it plays)
 * goes live when live is on (a live backend answered and nothing has blocked it since). When it
 * isn't, Stop just stops and the banner says why and offers Play; a keystroke is held back.
 *
 * Effects, in order (replay.js runs each):
 *   halt       cancel the playback and hide any recorded ghost text
 *   endRun     end the run the bench is following, as aborted (bench SPEC §3a)
 *   replay     start playing the selected recording
 *   goLive     switch the page to live mode at the current text and cursor
 *   leaveLive  switch the page back to replay mode (without playing)
 *   passKey    let the keystroke through to the editor
 *   blockKey   hold the keystroke back
 *   nudge      flash the banner with typingHint()
 */
(function (root) {
  'use strict';

  function initial() {
    return {
      mode: 'replay',
      playing: false,
      playedOnce: false,
      /** The last replay was stopped by the visitor (not finished). */
      stopped: false,
      /** How live mode was entered: 'try' | 'stop' | null. */
      via: null,
      /** A live backend answered /config with enabled: true and at least one model. */
      liveAvailable: false,
      /** Why live became unavailable since (the server's words, e.g. the day's budget is used up). */
      blocked: null,
    };
  }

  const liveOn = (s) => s.liveAvailable && !s.blocked;

  function goLive(s, via) {
    return {
      state: { ...s, mode: 'live', via, playing: false, stopped: via === 'stop' },
      effects: ['halt', 'endRun', 'goLive'],
    };
  }

  /** (state, action) → { state, effects }. Never mutates state. */
  function transition(s, action) {
    const same = { state: s, effects: [] };
    switch (action.type) {
      case 'config':
        return { state: { ...s, liveAvailable: !!action.available }, effects: [] };
      case 'play':
        return {
          state: {
            ...s,
            mode: 'replay',
            via: null,
            playing: true,
            playedOnce: true,
            stopped: false,
          },
          effects:
            s.mode === 'live'
              ? ['leaveLive', 'halt', 'endRun', 'replay']
              : ['halt', 'endRun', 'replay'],
        };
      case 'finished':
        return s.mode === 'replay' ? { state: { ...s, playing: false }, effects: [] } : same;
      case 'stop':
        if (s.mode !== 'replay' || !s.playing) return same;
        if (liveOn(s)) return goLive(s, 'stop');
        return { state: { ...s, playing: false, stopped: true }, effects: ['halt', 'endRun'] };
      case 'key':
        if (s.mode === 'live') return { state: s, effects: ['passKey'] };
        if (liveOn(s)) {
          const r = goLive(s, 'stop');
          return { state: r.state, effects: [...r.effects, 'passKey'] };
        }
        return { state: s, effects: ['blockKey', 'nudge'] };
      case 'click':
        return s.mode === 'replay' && s.playing && liveOn(s) ? goLive(s, 'stop') : same;
      case 'tryLive':
        return s.mode === 'replay' && liveOn(s) ? goLive(s, 'try') : same;
      case 'liveFailed':
        return {
          state: {
            ...s,
            mode: 'replay',
            via: null,
            playing: false,
            stopped: true,
            blocked: action.reason || 'Live completions are unavailable right now.',
          },
          effects: s.mode === 'live' ? ['leaveLive'] : [],
        };
      default:
        return same;
    }
  }

  /** What the banner and its buttons say. model: the live model's display name. */
  function banner(s, model) {
    const m = model || 'the model';
    const on = liveOn(s);
    const again = '▶ Play the recording again';
    if (s.mode === 'live') {
      if (s.via !== 'stop') return { hidden: true };
      return {
        hidden: false,
        lead: 'Stopped.',
        text: 'Type or press ⌥↵ to have ' + m + ' complete from here.',
        play: { label: again, primary: false },
        tryShown: false,
      };
    }
    if (s.playing) {
      return {
        hidden: false,
        lead: 'This is a recording of a real run. ',
        text: on
          ? 'Stop it at any point, or just start typing, and ' + m + ' completes from there.'
          : 'Watch the ghost text arrive and the bench light up.',
        play: { label: '■ Stop', primary: !on },
        tryShown: on,
        tryPrimary: on,
      };
    }
    if (s.stopped) {
      return {
        hidden: false,
        lead: 'Stopped.',
        text: (s.blocked ? s.blocked + ' ' : '') + 'Press Play to watch the recording again.',
        play: { label: again, primary: true },
        tryShown: on,
        tryPrimary: false,
      };
    }
    return {
      hidden: false,
      lead: 'This is a recording of a real run. ',
      text: on
        ? 'Press Play to watch the ghost text arrive and the bench light up, or Try it yourself to type and get real completions.'
        : 'Press Play to watch the ghost text arrive and the bench light up.',
      play: { label: s.playedOnce ? again : '▶ Play the recorded completion', primary: true },
      tryShown: on,
      tryPrimary: false,
    };
  }

  /** The nudge for a keystroke that was held back (live is off). */
  function typingHint(s) {
    if (s.blocked) return 'Typing is off in a recording. ' + s.blocked;
    return 'Typing is off in a recording, which never calls a model. Press Play to watch the ghost text arrive.';
  }

  const api = { initial, transition, banner, typingHint, liveOn };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplayState = api;
})(this);
