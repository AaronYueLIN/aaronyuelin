/**
 * Main-thread controller for the simulated-goal-probability readout.
 *
 * Scheduling (must not fight first-screen decode, the ~10 s light guide, or
 * drag / lights on the game thread):
 *   - A visible Loading/Ready/Unavailable readout exists from initial HTML.
 *     The isolated Worker warms after ball-ready; Monte Carlo starts only
 *     for a real aimed shot. No viewport/device visibility gate.
 *   - Simulation runs only in a same-origin module Web Worker with its own
 *     Rapier world. The playable world's bodies, timestep, clock and RNG
 *     are never touched.
 *   - If a Worker cannot start or later fails (for example production CSP
 *     `worker-src 'none'`), estimation STOPS for that attempt, the readout
 *     goes back to "—", and the main thread does not run Monte Carlo.
 *     A later charge gesture may retry a new Worker; a stuck/stale
 *     percentage is never kept. Drag, lights and shot feedback keep the
 *     game thread.
 *   - Aim updates are coalesced on one 120 ms window. The timer is not
 *     restarted when the quantized key changes or stays the same, so a
 *     rising charge still flushes the latest sample. A new key immediately
 *     invalidates the painted value and expires the in-flight job id so a
 *     late `done` cannot be attributed to the new aim. Results are paired
 *     with the immutable key of the job that produced them. The frozen
 *     launch key uses that same format.
 *   - tick() only queues work and returns; it never steps physics on the
 *     calling frame. One cancellable rAF chain runs only while
 *     phase === 'charging' and a Worker is available. tick() inside that
 *     callback must not register a second frame.
 *   - Seed, error model and trial count are fixed in sim-xg.js.
 */
import {
  XG_SIM,
  announceText,
  createJobMailbox,
  formatPercent,
  isPhoneViewport,
  seedFromShot,
  shotInputKey,
} from './sim-xg.js?v=2026.11.23-r10';
import { launchFromAim } from './shot.js?v=2026.11.23-r10';

// Original programmable 5x7 LED glyphs, never baked probabilities.
const SCOREBOARD_GLYPHS = {"X":["10001","10001","01010","00100","01010","10001","10001"],"G":["01110","10001","10000","10111","10001","10001","01110"],"-":["00000","00000","00000","11111","00000","00000","00000"],"0":["01110","10001","10011","10101","11001","10001","01110"],"1":["00100","01100","00100","00100","00100","00100","01110"],"2":["01110","10001","00001","00010","00100","01000","11111"],"3":["11110","00001","00001","01110","00001","00001","11110"],"4":["00010","00110","01010","10010","11111","00010","00010"],"5":["11111","10000","10000","11110","00001","00001","11110"],"6":["01110","10000","10000","11110","10001","10001","01110"],"7":["11111","00001","00010","00100","01000","01000","01000"],"8":["01110","10001","10001","01110","10001","10001","01110"],"9":["01110","10001","10001","01111","00001","00001","01110"]," ":["00000","00000","00000","00000","00000","00000","00000"],"P":["11110","10001","10001","11110","10000","10000","10000"],"u":["00000","00000","10001","10001","10001","10011","01101"],"l":["01100","00100","00100","00100","00100","00100","01110"],"b":["10000","10000","10110","11001","10001","10001","11110"],"a":["00000","00000","01110","00001","01111","10001","01111"],"t":["00100","00100","11111","00100","00100","00101","00010"],"o":["00000","00000","01110","10001","10001","10001","01110"],"k":["10000","10000","10010","10100","11000","10100","10010"],"i":["00100","00000","01100","00100","00100","00100","01110"],"c":["00000","00000","01110","10001","10000","10001","01110"]};
export function renderScoreboardGlyphs(element, text) {
  if (!element || element.dataset.value === text) return;
  const fragment = document.createDocumentFragment();
  const ns = 'http://www.w3.org/2000/svg';
  const firstSlot = element.hasAttribute('data-scoreboard-label') ? 0 : 2;
  const compact = firstSlot === 2 && text === '100';
  const groups = compact ? ['10', '0'] : [...text.padEnd(2, '-').slice(0, 2)];
  groups.forEach((characters, index) => {
    const cell = document.createElement('span');
    cell.className = 'scoreboard__slot';
    cell.dataset.slot = String(firstSlot + index);
    if (compact) cell.dataset.compact = 'true';
    for (const character of characters) {
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 5 7');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const rows = SCOREBOARD_GLYPHS[character] ?? SCOREBOARD_GLYPHS['-'];
      rows.forEach((row, y) => [...row].forEach((on, x) => {
        if (on !== '1') return;
        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', String(x + 0.5));
        dot.setAttribute('cy', String(y + 0.5));
        dot.setAttribute('r', '0.32');
        dot.setAttribute('fill', 'currentColor');
        svg.appendChild(dot);
      }));
      cell.appendChild(svg);
    }
    fragment.appendChild(cell);
  });
  element.replaceChildren(fragment);
  element.dataset.value = text;
}

export const THROTTLE_MS = 120;
const MAX_RETRYABLE_FAILURES = 3;

function scheduleTimeout(fn, ms) {
  const set = (typeof window !== 'undefined' && window.setTimeout) ? window.setTimeout : setTimeout;
  return set(fn, ms);
}

function unscheduleTimeout(id) {
  const clear = (typeof window !== 'undefined' && window.clearTimeout) ? window.clearTimeout : clearTimeout;
  clear(id);
}

export function createSimXgClient({
  play,
  host,
  world,
  interaction,
}) {
  const root = play?.querySelector('[data-sim-xg]');
  const valueEl = root?.querySelector('[data-sim-xg-value]');
  const srEl = root?.querySelector('[data-sim-xg-sr]');
  if (!root || !valueEl) {
    return { tick() {}, dispose() {}, inspect: () => ({ available: false }) };
  }

  const jobs = createJobMailbox();
  let worker = null;
  let workerReady = false;
  let workerUsable = true;
  let unavailableReason = null;
  let consecutiveFailures = 0;
  let timer = 0;
  let disposed = false;
  let lastKey = '';
  let lastShownKey = '';
  let pending = null; // { key, pos, vel }
  let inFlight = null; // { id, key }
  let frozen = null;
  let lastPhase = 'idle';
  let visibleProbability = null;
  let chargeWatch = 0;
  let chargeLoopActive = false;
  let lastAction = 'idle';
  let suspended = false;
  let guideMessage = null;
  let lastPaintLive = false;

  function formIsPhone() {
    const marked = play.dataset.form;
    if (marked === 'phone') return true;
    if (marked === 'desktop') return false;
    const box = host?.getBoundingClientRect?.();
    return isPhoneViewport(box?.width ?? play.clientWidth, box?.height ?? play.clientHeight);
  }

  function setEngine(name, reason = null) {
    root.dataset.engine = name;
    if (reason) root.dataset.engineReason = reason;
    else delete root.dataset.engineReason;
  }

  function paint(probability, { live = false } = {}) {
    visibleProbability = Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : null;
    lastPaintLive = live;
    if (Number.isFinite(visibleProbability)) root.dataset.ready = live ? 'live' : 'frozen';
    else delete root.dataset.ready;
    if (guideMessage) return; // buffer actual estimates; guide alone owns all four cells
    const state = (unavailableReason && !worker) || play.dataset.ball === 'error'
      ? 'Unavailable'
      : play.dataset.ball !== 'ready' ? 'Loading…'
        : (pending || inFlight) ? 'Calculating…'
          : workerReady ? 'Ready' : 'Loading…';
    const digits = Number.isFinite(visibleProbability) ? String(Math.round(visibleProbability * 100)).padStart(2, '0') : '--';
    renderScoreboardGlyphs(valueEl, digits);
    renderScoreboardGlyphs(root.querySelector('[data-scoreboard-label]'), (root.dataset.label || 'XG').toUpperCase().slice(0, 2).padEnd(2, '-'));
    root.title = Number.isFinite(visibleProbability) ? `Simulated goal probability: ${Number(digits)} percent` : `Simulated goal probability: ${state}`;
    root.dataset.displayState = Number.isFinite(visibleProbability) ? (live ? 'live' : 'frozen') : state;

    if (srEl) srEl.textContent = Number.isFinite(visibleProbability)
      ? announceText(visibleProbability)
      : `Simulated goal probability: ${state}. Hold the football to aim; release to freeze the shot estimate.`;
  }

  function updateGuideMessage(elapsed = 0) {
    if (!guideMessage) return;
    const { text, reduced } = guideMessage;
    const sequence = reduced ? text : `    ${text}    `;
    const offset = reduced ? Math.floor(elapsed / 2000) * 4
      : Math.floor(elapsed / 400) % Math.max(1, sequence.length - 3);
    const cells = sequence.slice(offset, offset + 4).padEnd(4, ' ');
    renderScoreboardGlyphs(root.querySelector('[data-scoreboard-label]'), cells.slice(0, 2));
    renderScoreboardGlyphs(valueEl, cells.slice(2, 4));
  }

  function beginGuideMessage(text = 'Pull ball to kick', reduced = false) {
    guideMessage = { text, reduced };
    root.dataset.displayState = 'guide';
    root.title = text;
    if (srEl) srEl.textContent = text;
    updateGuideMessage(0);
  }

  function endGuideMessage() {
    if (!guideMessage) return;
    guideMessage = null;
    paint(visibleProbability, { live: lastPaintLive });
  }

  function showIdle() {
    lastKey = '';
    pending = null;
    lastShownKey = '';
    paint(null);
  }

  function invalidatePaint(reason) {
    lastShownKey = '';
    lastAction = reason || 'invalidated';
    paint(null);
  }

  function expireInFlight() {
    jobs.cancel();
    inFlight = null;
    if (worker && workerUsable) {
      try { worker.postMessage({ type: 'cancel', id: jobs.id }); } catch { /* ignore */ }
    }
  }

  function handleWorkerFailure(reason, { retryable = true } = {}) {
    expireInFlight();
    if (timer) {
      unscheduleTimeout(timer);
      timer = 0;
    }
    pending = null;
    invalidatePaint('worker-error');
    lastAction = 'worker-error';
    unavailableReason = reason || 'worker-error';
    workerReady = false;
    if (worker) {
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }
    if (retryable) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_RETRYABLE_FAILURES) {
        workerUsable = false;
        setEngine('unavailable', unavailableReason);
      } else {
        setEngine('idle', unavailableReason);
      }
    } else {
      workerUsable = false;
      setEngine('unavailable', unavailableReason);
    }
    paint(null);
  }

  function allowRetryAfterGesture() {
    if (workerUsable) return;
    if (consecutiveFailures <= 0 && unavailableReason && /construct|constructor-missing/i.test(unavailableReason)) {
      return;
    }
    workerUsable = true;
    consecutiveFailures = 0;
    unavailableReason = null;
    setEngine('idle');
  }

  function ensureWorker() {
    if (!workerUsable || disposed) return null;
    if (worker) return worker;
    if (typeof Worker !== 'function') {
      handleWorkerFailure('worker-constructor-missing', { retryable: false });
      return null;
    }
    try {
      worker = new Worker(new URL('./sim-xg-worker.js?v=2026.11.23-r10', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'ready') {
          workerReady = true;
          unavailableReason = null;
          paint(visibleProbability, { live: !frozen });
          return;
        }
        if (msg.type === 'init-error') {
          handleWorkerFailure(msg.message || 'worker-init-failed', { retryable: true });
          return;
        }
        if (msg.type === 'error') {
          const verdict = jobs.accept(msg);
          if (!verdict.ok) {
            lastAction = 'discarded-stale';
            return;
          }
          handleWorkerFailure(msg.message || 'worker-error', { retryable: true });
          return;
        }
        const verdict = jobs.accept(msg);
        if (!verdict.ok) {
          lastAction = 'discarded-stale';
          return;
        }
        if (msg.type === 'done' && Number.isFinite(msg.result?.probability)) {
          const resultKey = inFlight && inFlight.id === msg.id ? inFlight.key : null;
          if (!resultKey) {
            lastAction = 'discarded-unpaired';
            return;
          }
          lastShownKey = resultKey;
          inFlight = null;
          consecutiveFailures = 0;
          lastAction = 'accepted-done';
          const isFrozen = Boolean(frozen && frozen.key === resultKey);
          paint(msg.result.probability, { live: !isFrozen });
        }
      };
      worker.onerror = () => {
        handleWorkerFailure('worker-error', { retryable: true });
      };
      worker.onmessageerror = () => {
        handleWorkerFailure('worker-message-error', { retryable: true });
      };
      unavailableReason = null;
      workerReady = false;
      setEngine('worker');
      worker.postMessage({ type: 'init' });
    } catch {
      handleWorkerFailure('worker-construct-failed', { retryable: false });
      return null;
    }
    return worker;
  }

  function cancelWork() {
    expireInFlight();
    pending = null;
    if (timer) {
      unscheduleTimeout(timer);
      timer = 0;
    }
    if (chargeWatch) {
      cancelAnimationFrame(chargeWatch);
      chargeWatch = 0;
    }
  }

  function flushPending() {
    timer = 0;
    if (disposed || !pending) return;
    const job = pending;
    pending = null;
    startJob(job.pos, job.vel, job.key);
  }

  function requestEstimate(pos, vel) {
    if (disposed || !workerUsable || suspended) return;
    const key = shotInputKey(pos, vel);

    if (key === lastShownKey) return;
    if (inFlight && inFlight.key === key) return;
    if (pending && pending.key === key && timer) return;

    const keyChanged = key !== lastKey;
    lastKey = key;
    pending = { key, pos, vel };

    if (keyChanged) {
      invalidatePaint('input-changed');
      expireInFlight();
    }

    if (timer) return;
    timer = scheduleTimeout(flushPending, THROTTLE_MS);
  }

  function startJob(pos, vel, key) {
    if (disposed || !workerUsable || lastKey !== key) return;
    const id = jobs.next();
    inFlight = { id, key };
    const seed = seedFromShot(pos, vel);
    const spec = { pos, vel, seed, trials: XG_SIM.trials, chunk: XG_SIM.chunk };
    const wk = ensureWorker();
    if (!wk) return;
    lastAction = 'run';
    wk.postMessage({ type: 'run', id, spec });
  }

  function liveShot() {
    const phase = interaction?.phase;
    if (phase !== 'charging') return null;
    const aim = interaction?.aim;
    const pos = world?.state?.().pos;
    if (!aim || !pos) return null;
    const vel = launchFromAim(pos, aim, interaction.charge ?? 0, 0);
    if (!vel) return null;
    return { pos, vel };
  }

  function armChargeWatch() {
    if (disposed || suspended || !workerUsable || chargeWatch || chargeLoopActive) return;
    const loop = () => {
      chargeWatch = 0;
      if (disposed || suspended) return;
      chargeLoopActive = true;
      try {
        tick();
      } finally {
        chargeLoopActive = false;
      }
      if (disposed || suspended || !workerUsable || chargeWatch) return;
      if (interaction?.phase === 'charging') {
        chargeWatch = requestAnimationFrame(loop);
      }
    };
    chargeWatch = requestAnimationFrame(loop);
  }

  function tick() {
    if (disposed || suspended) return;
    const ballReady = play.dataset.ball === 'ready';
    if (!ballReady) {
      cancelWork();
      frozen = null;
      lastPhase = interaction?.phase ?? 'idle';
      showIdle();
      return;
    }
    // Warm the isolated Worker after the assets are ready, not after a hidden gesture.
    if (workerUsable) ensureWorker();
    const phase = interaction?.phase ?? 'idle';
    if (phase === 'charging' && lastPhase !== 'charging') {
      allowRetryAfterGesture();
    }
    if (!workerUsable) {
      lastPhase = phase;
      return;
    }
    if (phase === 'charging') armChargeWatch();
    if (phase === 'flying' && lastPhase !== 'flying') {
      const s = world?.state?.();
      const vel = s?.vel;
      if (vel && (Number.isFinite(vel.x) || Number.isFinite(vel.vx))) {
        const pos = s.pos;
        const launchVel = {
          vx: Number.isFinite(vel.vx) ? vel.vx : vel.x,
          vy: Number.isFinite(vel.vy) ? vel.vy : vel.y,
          vz: Number.isFinite(vel.vz) ? vel.vz : vel.z,
        };
        const key = shotInputKey(pos, launchVel);
        frozen = { key };
        if (lastShownKey === key && Number.isFinite(visibleProbability)) {
          paint(visibleProbability, { live: false });
        } else {
          requestEstimate(pos, launchVel);
        }
      }
    }
    if (phase === 'idle' || phase === 'pressing' || phase === 'dragging') {
      if (phase !== 'flying' && phase !== 'settled') {
        frozen = null;
        cancelWork();
        showIdle();
      }
    } else if (phase === 'charging') {
      frozen = null;
      const shot = liveShot();
      if (!shot) {
        cancelWork();
        showIdle();
      } else {
        requestEstimate(shot.pos, shot.vel);
      }
    } else if (phase === 'flying' || phase === 'settled') {
      if (!Number.isFinite(visibleProbability)) {
        /* still computing the frozen shot, leave — or last paint */
      }
    } else {
      cancelWork();
      showIdle();
    }
    lastPhase = phase;
  }

  function suspend() {
    suspended = true;
    cancelWork();
  }

  function resume() {
    if (disposed) return;
    suspended = false;
  }

  function dispose() {
    disposed = true;
    suspended = false;
    cancelWork();
    if (worker) {
      try { worker.postMessage({ type: 'dispose' }); } catch { /* ignore */ }
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }
  }

  paint(null);
  setEngine('idle');
  return {
    beginGuideMessage,
    updateGuideMessage,
    endGuideMessage,
    tick,
    dispose,
    suspend,
    resume,
    isDisposed: () => disposed,
    inspect: () => ({
      available: true,
      disposed,
      suspended,
      engine: workerUsable ? (worker ? 'worker' : 'idle') : 'unavailable',
      reason: unavailableReason,
      phone: formIsPhone(),
      lastKey,
      lastShownKey,
      frozenKey: frozen?.key ?? null,
      inFlight,
      pendingKey: pending?.key ?? null,
      lastAction,
      probability: visibleProbability,
      ready: root.dataset.ready ?? null,
      worker: Boolean(worker),
      workerUsable,
      mainThreadFallback: false,
      consecutiveFailures,
      jobs: jobs.snapshot(),
    }),
  };
}
