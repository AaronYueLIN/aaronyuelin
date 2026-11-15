/**
 * Pure shot model shared by pointer input, keyboard input and the Node tests.
 *
 * The gesture is deliberately simple and physical:
 *   hold  → charge grows 0..1 over SHOT.chargeMs
 *   aim   → the pointer ray meets the goal plane z = 0 at an aim point
 *   release → launch velocity = direction(ball → aim) × speed(charge)
 *
 * There is no target solving and no randomness: the launch is one real
 * velocity, and `physics.js` decides whether that trajectory passes an
 * aperture or strikes a bar. Clamping the elevation is the only shaping; a
 * very high swipe cannot fire the ball through the ceiling.
 *
 * No DOM and no clocks live here so `node --test` can exercise the same code
 * the browser runs.
 */

import { GOAL_HEIGHT, GOAL_WIDTH, SHOT, openingRect } from './config.js';

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

/** Charge 0..1 for milliseconds since charging began (after the long press). */
export function chargeForElapsed(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return clamp01(elapsedMs / SHOT.chargeMs);
}

/** Smoothstep so the first millimetres of charge are controllable. */
export function easeCharge(charge) {
  const c = clamp01(charge);
  return c * c * (3 - 2 * c);
}

/** Launch speed in m/s for a 0..1 charge plus a 0..1 measured flick boost. */
export function shotSpeed(charge, release = 0) {
  const base = SHOT.minSpeed + (SHOT.maxSpeed - SHOT.minSpeed) * easeCharge(charge);
  return base * (1 + SHOT.releaseBoost * clamp01(release));
}

/**
 * Pointer velocity in px/ms over the trailing release window.
 * Samples are `{ x, y, t }` in CSS px and `performance.now()` ms.
 * Returns 0 without real movement; never invents speed.
 */
export function releaseVelocityFromSamples(samples, windowMs = SHOT.releaseWindowMs) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (!Number.isFinite(last?.t)) return 0;
  const cutoff = last.t - Math.max(1, windowMs);
  let first = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i];
    if (!Number.isFinite(s?.t) || !Number.isFinite(s?.x) || !Number.isFinite(s?.y)) continue;
    first = s;
    if (s.t <= cutoff) break;
  }
  if (!first || first === last) return 0;
  const dt = last.t - first.t;
  if (!(dt > 0)) return 0;
  return Math.hypot(last.x - first.x, last.y - first.y) / dt;
}

/**
 * Turn a measured pointer speed into a 0..1 release boost. `referencePx` is
 * the shorter viewport side, which makes the gesture feel the same on a phone
 * and a desktop screen.
 */
export function releaseRatioFromSamples(samples, referencePx, windowMs = SHOT.releaseWindowMs) {
  const pxPerMs = releaseVelocityFromSamples(samples, windowMs);
  const ref = Number(referencePx) > 0 ? Number(referencePx) : 1;
  const screenPerSec = (pxPerMs / ref) * 1000;
  return clamp01(screenPerSec / SHOT.releaseFullScreenPerSec);
}

/** Centre of an opening in the goal plane, the keyboard's default aim. */
export function defaultAimPoint(cell = SHOT.defaultAimCell) {
  const rect = openingRect(cell);
  return { x: rect.cx, y: rect.cy, z: 0 };
}

/** Move a keyboard aim point by metres on the goal plane. */
export function moveAim(aim, dx, dy, fine = false) {
  const step = fine ? SHOT.aimFineStep : SHOT.aimStep;
  return {
    x: aim.x + dx * step,
    y: aim.y + dy * step,
    z: 0,
  };
}

/**
 * World aim point under a screen point, given the projected goal rectangle in
 * the same CSS-pixel space. Used when no WebGL camera is available (the PNG
 * fallback); with WebGL the caller passes the exact ray/plane intersection.
 */
export function aimFromGoalRect(screenX, screenY, goalRect) {
  if (!goalRect || !(goalRect.width > 0) || !(goalRect.height > 0)) return null;
  const fx = (screenX - goalRect.left) / goalRect.width;
  const fy = (goalRect.top + goalRect.height - screenY) / goalRect.height;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  return {
    x: (fx - 0.5) * (goalRect.worldWidth ?? GOAL_WIDTH),
    y: fy * (goalRect.worldHeight ?? GOAL_HEIGHT),
    z: 0,
  };
}

/**
 * Launch velocity from a resting ball toward an aim point on the goal plane.
 * The horizontal heading is exact; the elevation is clamped to
 * SHOT.maxElevation and to a small downward limit, so a swipe below the ball
 * becomes a low rolling shot rather than a bounce off the floor at the
 * player's feet.
 *
 * @returns {{vx:number, vy:number, vz:number}|null}
 */
export function launchFromAim(ball, aim, charge, release = 0) {
  if (!ball || !aim) return null;
  const dx = aim.x - ball.x;
  const dy = aim.y - ball.y;
  const dz = aim.z - ball.z;
  const horiz = Math.hypot(dx, dz);
  if (!(horiz > 1e-6)) return null;
  const speed = shotSpeed(charge, release);
  // Ballistic aim: solve for the launch angle that actually reaches the chosen
  // point under gravity, instead of pointing straight at it and undershooting.
  // Prefer the flatter of the two physical solutions; clamp to the shot limit.
  const a = (0.5 * 9.81 * horiz * horiz) / (speed * speed);
  const b = -horiz;
  const c = dy + a;
  const disc = b * b - 4 * a * c;
  let elevation = clamp(Math.atan2(dy, horiz), -0.32, SHOT.maxElevation);
  if (disc >= 0 && a > 1e-9) {
    const sq = Math.sqrt(disc);
    const roots = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]
      .filter((u) => Number.isFinite(u) && u > 0)
      .map((u) => Math.atan(u))
      .filter((angle) => angle >= -0.32 && angle <= SHOT.maxElevation)
      .sort((x, y) => x - y);
    if (roots.length) elevation = roots[0];
  }
  elevation = clamp(elevation, -0.32, SHOT.maxElevation);
  const flat = Math.cos(elevation) * speed;
  return {
    vx: (dx / horiz) * flat,
    vy: Math.sin(elevation) * speed,
    vz: (dz / horiz) * flat,
  };
}
