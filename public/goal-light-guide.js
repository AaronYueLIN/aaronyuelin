/**
 * First-visit goal light guide.
 *
 * A short, one-time light show on the real Blender diffuser bars: the whole
 * 2x5 goal glows green, then red, then green, then red, then green over about
 * ten seconds of foreground-visible time. It reuses the existing green/red
 * strip materials through `scene.setGuide()`, so a real goal or bar hit keeps
 * the authored colour and full intensity.
 *
 * The module is deliberately inert until `start()` is called. `app.js` calls
 * `start()` only after the room/goal GLB has loaded, drawn and painted —
 * never from DOMContentLoaded — and loads this file with a dynamic import
 * after first paint so it never joins the first-paint request graph.
 *
 * Real feedback always wins: `interrupt()` clears the overlay and the scene
 * re-applies its *live* per-cell light state. Nothing is snapshotted at start,
 * so a goal or bar hit that happened during the show cannot be overwritten.
 *
 * Accessibility: with `prefers-reduced-motion: reduce` the green/red
 * alternation is replaced by one gentle green fade (no switching), and any
 * real interaction, goal or bar event stops the show immediately.
 */

/** localStorage key for the one-time "already watched" flag. */
export const STORAGE_KEY = 'aaronyuelin:goal-light-guide:v2';

/** Foreground-visible duration of the full green/red alternation. */
export const GUIDE_DURATION_MS = 10_000;
/** Foreground-visible duration of the reduced-motion single fade. */
export const REDUCED_GUIDE_DURATION_MS = 10_000;

/** One colour phase. Five phases make exactly GUIDE_DURATION_MS. */
export const GUIDE_PHASE_MS = 2_000;
/** Colour order: green → red → green → red → green. */
export const GUIDE_COLORS = ['green', 'red', 'green', 'red', 'green'];

const FADE_IN_MS = 650;
const HOLD_MS = 700;
const FADE_OUT_MS = 650; // 650 + 700 + 650 === GUIDE_PHASE_MS

const REDUCED_FADE_IN_MS = 2_000;
const REDUCED_HOLD_MS = 6_000;
const REDUCED_FADE_OUT_MS = 2_000; // total === REDUCED_GUIDE_DURATION_MS

/** A single stall longer than this is treated as time the user did not see. */
const MAX_FRAME_MS = 250;
/**
 * Repaint cadence for the guide. The fades are sub-hertz, so ~30 fps is
 * visually identical to 60 fps while halving the WebGL draws on a phone.
 */
const PAINT_INTERVAL_MS = 30;

/**
 * Session-level fallback for when localStorage is unavailable (private mode,
 * quota, blocked storage). A page load has one guide instance, so this only
 * prevents a second instance in the same document from replaying.
 */
const sessionMemory = { watched: false };

function smoothstep(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

/** Ease-in, hold, ease-out over one 2 s colour phase. */
function phaseLevel(t) {
  if (t < FADE_IN_MS) return smoothstep(t / FADE_IN_MS);
  if (t < FADE_IN_MS + HOLD_MS) return 1;
  return 1 - smoothstep((t - FADE_IN_MS - HOLD_MS) / FADE_OUT_MS);
}

/**
 * Pure timeline. Returns `{ state: 'green' | 'red', level: 0..1 }`, or `null`
 * once the show is over. Exported so the timing can be tested without a DOM.
 */
export function guideAt(elapsedMs, { reduced = false } = {}) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (reduced) {
    if (elapsedMs >= REDUCED_GUIDE_DURATION_MS) return null;
    let level;
    if (elapsedMs < REDUCED_FADE_IN_MS) {
      level = smoothstep(elapsedMs / REDUCED_FADE_IN_MS);
    } else if (elapsedMs < REDUCED_FADE_IN_MS + REDUCED_HOLD_MS) {
      level = 1;
    } else {
      level = 1 - smoothstep(
        (elapsedMs - REDUCED_FADE_IN_MS - REDUCED_HOLD_MS) / REDUCED_FADE_OUT_MS,
      );
    }
    return { state: 'green', level };
  }
  if (elapsedMs >= GUIDE_DURATION_MS) return null;
  const phase = Math.min(
    GUIDE_COLORS.length - 1,
    Math.floor(elapsedMs / GUIDE_PHASE_MS),
  );
  return {
    state: GUIDE_COLORS[phase],
    level: phaseLevel(elapsedMs - phase * GUIDE_PHASE_MS),
  };
}

/**
 * Create the guide controller.
 *
 * Only `setLights` is required:
 *   setLights(state, level)  paint the guide overlay (level 0..1)
 *   setLights(null, 0)       clear it and re-apply live real feedback
 *
 * The remaining options exist so the timeline can be unit-tested with fake
 * storage, visibility, frame scheduling and reduced-motion state.
 */
export function createGoalLightGuide({
  setLights = null,
  reduceMotion = () => false,
  storage = null,
  doc = typeof document !== 'undefined' ? document : null,
  requestFrame = typeof requestAnimationFrame === 'function'
    ? (fn) => requestAnimationFrame(fn)
    : null,
  cancelFrame = typeof cancelAnimationFrame === 'function'
    ? (id) => cancelAnimationFrame(id)
    : null,
  memory = sessionMemory,
  onWatched = null,
  manual = false,
  onStart = null,
  onFrame = null,
  onFinish = null,
} = {}) {
  let phase = 'idle'; // idle | running | finished
  let frame = 0;
  let elapsed = 0;
  let last = 0;
  let lastPaint = -1;
  let painted = false;
  let reduced = false;

  function store() {
    if (storage) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null; // access itself can throw in some privacy modes
    }
  }

  function watchedBefore() {
    if (memory.watched) return true;
    const target = store();
    if (!target) return false;
    try {
      return target.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function rememberWatched() {
    memory.watched = true;
    const target = store();
    try {
      target?.setItem(STORAGE_KEY, '1');
    } catch {
      // Storage unavailable: the in-memory flag still stops a replay.
    }
    onWatched?.();
  }

  function schedule() {
    if (phase !== 'running' || frame || !requestFrame) return;
    frame = requestFrame(tick);
  }

  function onVisibility() {
    if (phase !== 'running') return;
    if (doc?.visibilityState === 'hidden') {
      // Stop the frame loop outright; hidden time is never counted.
      last = 0;
      if (frame && cancelFrame) cancelFrame(frame);
      frame = 0;
      return;
    }
    // Back in the foreground: re-baseline so the hidden gap is not added.
    last = 0;
    schedule();
  }

  function tick(timestamp) {
    frame = 0;
    if (phase !== 'running') return;
    if (doc?.visibilityState === 'hidden') {
      // A race with the visibility listener: do not paint or consume time.
      last = 0;
      return;
    }
    const now = typeof timestamp === 'number'
      ? timestamp
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!last) {
      // First visible frame, or the first frame after a resume.
      last = now;
      schedule();
      return;
    }
    const delta = now - last;
    last = now;
    if (!(delta > 0)) {
      schedule();
      return;
    }
    if (delta > MAX_FRAME_MS) {
      // A long main-thread stall is time the visitor did not see; skip it
      // rather than fast-forwarding the show.
      schedule();
      return;
    }
    elapsed += delta;
    const state = guideAt(elapsed, { reduced });
    if (!state) {
      finish();
      return;
    }
    if (elapsed - lastPaint >= PAINT_INTERVAL_MS) {
      lastPaint = elapsed;
      try {
        setLights(state.state, state.level);
        onFrame?.(elapsed);
        painted = true;
      } catch {
        // Cosmetic only: never leave a broken rAF loop or a listener behind.
        finish();
        return;
      }
    }
    schedule();
  }

  function finish() {
    if (phase !== 'running') return false;
    phase = 'finished';
    if (frame && cancelFrame) cancelFrame(frame);
    frame = 0;
    doc?.removeEventListener('visibilitychange', onVisibility);
    try {
      // Clear the overlay only. The scene re-applies whatever real per-cell
      // light state is current, so no stale snapshot can win.
      setLights(null, 0);
    } catch {
      // A cosmetic guide must never break the playable page.
    }
    try { onFinish?.(); } catch { /* cosmetic readout only */ }
    if (painted && !manual) rememberWatched();
    return true;
  }

  /** Stop early because real feedback or a real interaction took over. */
  function interrupt() {
    return finish();
  }

  /** Arm the show. Does no work and grants no storage read before this call. */
  function start() {
    if (phase !== 'idle') return false;
    if (typeof setLights !== 'function' || !requestFrame) {
      phase = 'finished';
      return false;
    }
    if (!manual && watchedBefore()) {
      phase = 'finished';
      return false;
    }
    reduced = Boolean(reduceMotion());
    phase = 'running';
    try { onStart?.(); } catch { /* cosmetic readout only */ }
    doc?.addEventListener('visibilitychange', onVisibility);
    schedule();
    return true;
  }

  return {
    start,
    interrupt,
    isRunning: () => phase === 'running',
    isFinished: () => phase === 'finished',
    /** Foreground-visible milliseconds accumulated so far (diagnostics/tests). */
    elapsed: () => elapsed,
  };
}

/**
 * Start the guide behind a sticky cancellation gate.
 *
 * `load` is the async module import (or a test double). `isCancelled` is read
 * before the load and again after it resolves, so real feedback or a real
 * interaction can win the import race even though no controller exists yet.
 * When the gate closes, no controller is created or started, and therefore no
 * "already watched" flag is written.
 *
 * Returns the started controller, or null when the start was abandoned.
 */
export async function startGoalLightGuideWhenReady({
  load,
  isCancelled = () => false,
  ...options
}) {
  if (isCancelled()) return null;
  const module = await load();
  if (isCancelled()) return null;
  const guide = module.createGoalLightGuide(options);
  // No await since the second check, but keep the final gate explicit.
  if (isCancelled()) return null;
  return guide.start() ? guide : null;
}
