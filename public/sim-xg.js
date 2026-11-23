/**
 * Mobile-only simulated goal probability (demo).
 *
 * This estimates the chance that a shot from the current ball pose, aim and
 * power would send the *whole* ball through a valid opening, under a fixed
 * kick-execution error model. Every trial is a real integration in an
 * *isolated* Rapier world built with the same factory and constants as the
 * playable game (`createWorld` in physics-rapier.js). The game world is
 * never stepped, reset, or written by this module.
 *
 * This is NOT a match-statistics expected-goals (xG) model. There is no
 * goalkeeper. The ten-cell lattice, bar collisions, gravity, drag, mass and
 * restitution are exactly this site's physics; a rebound that later crosses
 * an opening counts, because that is the game rule.
 *
 * Method references (coefficients are NOT taken from the papers):
 *   - Jelle Kok, Remco de Boer, Frank C. A. Groen, Nikos Vlassis, Frans
 *     Voorbraak, and Matthijs Spaan. "Towards an optimal scoring policy
 *     for simulated soccer agents." RoboCup / IAS technical report, 2001.
 *     Idea used: a scoring probability from an intended shot plus execution
 *     error, judged against the opening. Their RoboCup sigmas and 2-D
 *     simulator parameters are not used.
 *   - Ethan Baron, Nathan Sandholtz, Devin Pleuler, and Timothy C. Y. Chan.
 *     "Miss It Like Messi: Fitting a two-dimensional expected-goals model
 *     to estimate shot quality and finishing skill." arXiv:2308.01523, 2024.
 *     Idea used: execution error is two-dimensional (horizontal and vertical),
 *     not a single-axis miss. Their match-calibrated landing-location
 *     sigmas are not used.
 *
 * Demo error model, fixed for this site (independent zero-mean Gaussians):
 *   yaw   σ = 2.5°     horizontal heading about the intended direction
 *   pitch σ = 2.5°     elevation about the intended direction
 *   speed σ = 4 %      relative error on the intended launch speed
 *
 * A seeded PRNG plus quantized inputs keep the same (pose, velocity)
 * returning the same estimate, so the percentage does not flicker.
 */

import { RESTING } from './config.js?v=2026.11.23-r10';
import { H } from './physics-rapier.js?v=2026.11.23-r10';

export const XG_ERROR = Object.freeze({
  yawSigmaRad: (2.5 * Math.PI) / 180,
  pitchSigmaRad: (2.5 * Math.PI) / 180,
  speedRelSigma: 0.04,
  minSpeed: 0.05,
});

export const XG_SIM = Object.freeze({
  /** Monte Carlo trials per estimate. */
  trials: 128,
  /** Simulated seconds before a trial is declared a miss. */
  maxTime: 4,
  /** Trials between optional yield / progress hooks. */
  chunk: 8,
  /** Position quantization, metres, for a stable seed and nominal pose. */
  quantizePos: 0.01,
  /** Velocity quantization, m/s, for a stable seed and nominal launch. */
  quantizeVel: 0.02,
  /** Salt mixed into the seed so estimates are site-specific, not portable xG. */
  seedSalt: 0x51e0601,
});

const UNITS = {
  pos: XG_SIM.quantizePos,
  vel: XG_SIM.quantizeVel,
};

export function quantize(value, step) {
  const s = Number(step);
  if (!(s > 0) || !Number.isFinite(value)) return value;
  return Math.round(value / s) * s;
}

export function quantizeVec(vec, step) {
  if (!vec) return vec;
  const out = {};
  for (const key of Object.keys(vec)) {
    const n = vec[key];
    out[key] = Number.isFinite(n) ? quantize(n, step) : n;
  }
  return out;
}

export function shotInputKey(pos, vel) {
  const qPos = quantizeVec({ x: pos.x, y: pos.y, z: pos.z }, UNITS.pos);
  const source = vel || {};
  const qVel = quantizeVec({
    vx: Number.isFinite(source.vx) ? source.vx : source.x,
    vy: Number.isFinite(source.vy) ? source.vy : source.y,
    vz: Number.isFinite(source.vz) ? source.vz : source.z,
  }, UNITS.vel);
  return `${qPos.x},${qPos.y},${qPos.z}|${qVel.vx},${qVel.vy},${qVel.vz}`;
}


export function snapshotPhysics(state) {
  if (!state) return null;
  const copy = (p) => (p && Number.isFinite(p.x) ? { x: p.x, y: p.y, z: p.z } : p);
  const quat = state.quat;
  return {
    pos: copy(state.pos),
    vel: copy(state.vel),
    spin: copy(state.spin),
    quat: quat ? { x: quat.x, y: quat.y, z: quat.z, w: quat.w } : null,
    time: state.time,
    shotId: state.shotId,
    goals: Array.isArray(state.goals) ? [...state.goals] : [],
    reds: Array.isArray(state.reds) ? [...state.reds] : [],
    awake: state.awake,
    supported: state.supported,
  };
}

export function samePhysicsSnapshot(a, b, eps = 1e-9) {
  if (a === b) return true;
  if (!a || !b) return false;
  const near = (p, q) => {
    if (p == null && q == null) return true;
    if (!p || !q) return false;
    const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
    for (const k of keys) {
      if (Math.abs((p[k] ?? 0) - (q[k] ?? 0)) > eps) return false;
    }
    return true;
  };
  return near(a.pos, b.pos)
    && near(a.vel, b.vel)
    && near(a.spin, b.spin)
    && near(a.quat, b.quat)
    && Math.abs((a.time ?? 0) - (b.time ?? 0)) <= eps
    && a.shotId === b.shotId
    && a.awake === b.awake
    && a.supported === b.supported
    && JSON.stringify(a.goals) === JSON.stringify(b.goals)
    && JSON.stringify(a.reds) === JSON.stringify(b.reds);
}

/** Small, well-known 32-bit PRNG. */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed) {
  const unit = mulberry32(seed);
  let spare = null;
  return {
    unit,
    gauss() {
      if (spare != null) {
        const g = spare;
        spare = null;
        return g;
      }
      let u = 0;
      let v = 0;
      while (u === 0) u = unit();
      while (v === 0) v = unit();
      const mag = Math.sqrt(-2 * Math.log(u));
      const z0 = mag * Math.cos(2 * Math.PI * v);
      spare = mag * Math.sin(2 * Math.PI * v);
      return z0;
    },
  };
}

export function hashSeed(parts) {
  const text = typeof parts === 'string' ? parts : JSON.stringify(parts);
  let h = XG_SIM.seedSalt >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function seedFromShot(pos, vel) {
  const p = quantizeVec({ x: pos.x, y: pos.y, z: pos.z }, UNITS.pos);
  const v = quantizeVec({ vx: vel.vx, vy: vel.vy, vz: vel.vz }, UNITS.vel);
  return hashSeed({ p, v });
}

/**
 * Apply the demo execution error to an intended launch velocity.
 * yaw is heading about +Y with 0 looking toward −Z (the goal).
 */
export function perturbVelocity(vel, rng, error = XG_ERROR) {
  const vx = vel.vx;
  const vy = vel.vy;
  const vz = vel.vz;
  const speed = Math.hypot(vx, vy, vz);
  if (!(speed > 1e-8)) return { vx, vy, vz };
  const horiz = Math.hypot(vx, vz);
  const yaw = Math.atan2(vx, -vz);
  const pitch = Math.atan2(vy, horiz);
  const yaw2 = yaw + rng.gauss() * error.yawSigmaRad;
  const pitch2 = pitch + rng.gauss() * error.pitchSigmaRad;
  let speed2 = speed * (1 + rng.gauss() * error.speedRelSigma);
  if (!(speed2 > error.minSpeed)) speed2 = error.minSpeed;
  const flat = Math.cos(pitch2) * speed2;
  return {
    vx: Math.sin(yaw2) * flat,
    vy: Math.sin(pitch2) * speed2,
    vz: -Math.cos(yaw2) * flat,
  };
}

function placeIsolated(world, pos) {
  const x = Number.isFinite(pos.x) ? pos.x : RESTING.x;
  const z = Number.isFinite(pos.z) ? pos.z : RESTING.z;
  world.reset({ x, z });
  const y = Number.isFinite(pos.y) ? pos.y : RESTING.y;
  if (world.body && Math.abs(y - RESTING.y) > 1e-6) {
    const t = world.body.translation();
    world.body.setTranslation({ x: t.x, y, z: t.z }, true);
  }
}

/** One silent trial. Returns true iff the whole ball crossed a valid opening. */
export function simulateOne(world, pos, vel, opts = {}) {
  const maxTime = opts.maxTime ?? XG_SIM.maxTime;
  placeIsolated(world, pos);
  world.launch(vel);
  let t = 0;
  while (t < maxTime) {
    const events = world.step(H) || [];
    t += H;
    const state = world.state();
    if ((state.goals && state.goals.length > 0) || events.some((e) => e.type === 'goal')) {
      return true;
    }
    if (events.some((e) => e.type === 'settled') || state.awake === false) {
      return false;
    }
  }
  return false;
}

function yieldSlice() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Run `trials` noisy shots in `world` (reused, reset each time).
 * `hooks.shouldCancel()` may abort a stale request; `hooks.onProgress`
 * receives partial counts. The game world must not be passed here.
 */
export async function simulateBatch(world, spec, hooks = {}) {
  const pos = spec.pos;
  const vel = spec.vel;
  const trials = Math.max(1, Math.floor(spec.trials ?? XG_SIM.trials));
  const seed = spec.seed ?? seedFromShot(pos, vel);
  const chunk = Math.max(1, Math.floor(spec.chunk ?? XG_SIM.chunk));
  const error = spec.error ?? XG_ERROR;
  const maxTime = spec.maxTime ?? XG_SIM.maxTime;
  const rng = createRng(seed);
  let hits = 0;
  for (let i = 0; i < trials; i += 1) {
    if (hooks.shouldCancel?.()) {
      return { cancelled: true, hits, trials: i, probability: null, seed };
    }
    const noisy = spec.noise === false ? { ...vel } : perturbVelocity(vel, rng, error);
    if (simulateOne(world, pos, noisy, { maxTime })) hits += 1;
    const done = i + 1;
    if (done % chunk === 0 || done === trials) {
      hooks.onProgress?.({ hits, trials: done, total: trials, probability: hits / done, seed });
      if (hooks.yield !== false && done < trials) await yieldSlice();
    }
  }
  return {
    cancelled: false,
    hits,
    trials,
    probability: hits / trials,
    seed,
  };
}

export function formatPercent(probability) {
  if (!Number.isFinite(probability)) return '—';
  const pct = Math.round(probability * 100);
  const clamped = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  return `${clamped}%`;
}

export function announceText(probability) {
  if (!Number.isFinite(probability)) {
    return 'No aim yet. Simulated goal probability is not shown.';
  }
  return `Simulated goal probability ${formatPercent(probability)}. Monte Carlo using this site's physics and a fixed kick-execution error; no goalkeeper. Not match-statistics expected goals (xG).`;
}

export function isPhoneViewport(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  return w / h < 1;
}

export function freeWorld(world) {
  try {
    world?.world?.free?.();
  } catch {
    // Rapier versions that do not expose free() are simply dropped.
  }
}

/**
 * Monotonic job ids for Worker requests. A cancelled or superseded job
 * bumps the current id; a late `done` / `progress` with the old id is
 * discarded and must never paint over a newer estimate.
 */
export function createJobMailbox() {
  let currentId = 0;
  const accepted = [];
  const discarded = [];
  return {
    next() {
      currentId += 1;
      return currentId;
    },
    get id() {
      return currentId;
    },
    cancel() {
      currentId += 1;
      return currentId;
    },
    accept(msg) {
      const id = msg?.id;
      if (id !== currentId) {
        discarded.push({ id, type: msg?.type ?? null });
        return { ok: false, reason: 'stale' };
      }
      accepted.push({ id, type: msg?.type ?? null });
      return { ok: true };
    },
    snapshot() {
      return {
        id: currentId,
        accepted: accepted.length,
        discarded: discarded.length,
        discardedIds: discarded.map((d) => d.id),
      };
    },
  };
}
