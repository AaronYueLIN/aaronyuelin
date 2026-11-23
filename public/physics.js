/**
 * Pure physics: one sphere against a finite static room and a real goal frame.
 * No DOM, no three.js, no randomness, no clocks. The same calls produce
 * identical results, so a shot replayed in Node lands where it did in the
 * browser.
 *
 * Model
 *   • Fixed substep H = 1/120 s. `step(h)` splits h into substeps of at most
 *     H. Each substep advances in short "chunks": fly a chunk with the exact
 *     constant-acceleration update, look for the earliest swept time of
 *     impact (TOI) against every collider, and truncate the chunk at that
 *     TOI (≤ CHUNK seconds, so contacts are found at ~1 ms resolution and a
 *     20 m/s ball moves ≤ 2 cm between looks — it cannot tunnel through a
 *     7 cm bar). Nothing is resolved by discrete overlap.
 *   • Colliders: axis-aligned boxes (goal bars; the solid walls beside the
 *     rear room behind the goal) and planes: floor, ceiling, side walls, the
 *     INVISIBLE front boundary and the deep rear wall. There is no per-opening
 *     net: the ball crosses an opening and keeps going into the same finite
 *     room behind the goal (same floor, side walls, ceiling, rear wall).
 *   • The rear room shares this room's floor, ceiling and rear wall; behind
 *     the goal's outer posts stand two solid, never-drawn walls (side and
 *     rear-room faces at |x| = GOAL_WIDTH/2 + BAR, z ∈ [minZ, 0]) that close
 *     it. Their faces are ball-surface offsets (box.radius = 0: no extra
 *     inflation), so contacts and resting spots are measured on the real
 *     ledge. An in-goal sphere touching the floor lies wholly behind either
 *     wall, giving a ball on the far side a contact shadow (scene.js).
 *   • Goal sensor: a forward centre crossing of the goal plane z = 0 at which
 *     the WHOLE sphere is inside one opening (clearance ≥ R on all four
 *     sides). A bar box reached at or before that instant is a physical
 *     bounce and a red event instead (ties → bar). A bar hit never consumes a
 *     later real pass; a goal is emitted at most once per opening per shot.
 *
 * Units: metres, seconds. +X right, +Y up, +Z toward the camera.
 */

import {
  BALL_RADIUS as R,
  BAR,
  BAR_DEPTH,
  CELLS_X,
  CELLS_Y,
  FRAME,
  GOAL,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  FLOOR_Y,
  OPENING,
  REAR_DEPTH,
  REAR_Z,
  ROOM,
  RESTING,
  openingRect,
} from './config.js?v=2026.11.23-r10';
import { framePlanes } from './camera.js?v=2026.11.23-r10';

/** Backwards-compatible alias: the rear room ends at NET_DEPTH behind the goal. */
export const NET_DEPTH = REAR_DEPTH;
export { ROOM, GOAL, CELLS_X, CELLS_Y, OPENING, BAR, GOAL_WIDTH, GOAL_HEIGHT, BAR_DEPTH, REAR_DEPTH, REAR_Z, openingRect };
export const BALL_RADIUS = R;
export const G = 9.81;
export const H = 1 / 120;
export const MAX_SPEED = 20;
/** Internal flight chunk length for TOI detection. */
const CHUNK = 0.004;
/** Tolerance for the swept-sphere radius (absolute, metres). */
const TOL = 1e-6;
/** Velocity below which a bar/net contact is not treated as an event. */
const MIN_BAR_SPEED = 0.02;
/** Maximum collision resolves per substep before flying free. */
const MAX_RESOLVE = 24;
/** Flight chunks per substep (1/120 s / 4 ms = 6, plus slack). */
const MAX_CHUNKS = 8;

export const MATERIAL = {
  // Restitution is a measured material property, not a feel knob. The ball is
  // a 22 cm leather football (~0.43 kg) on an indoor court: floor e≈0.55,
  // steel/wood frame e≈0.60, painted room walls e≈0.50, the invisible front
  // plane is backed by the same room (e≈0.90 so a shot rarely dies on it).
  // `friction` removes this share of the tangential speed per contact.
  bars: { restitution: 0.6, friction: 0.08 },
  walls: { restitution: 0.5, friction: 0.1 },
  front: { restitution: 0.9, friction: 0.05 },
  floor: { restitution: 0.55, friction: 0.12 },
  // The visible viewport edge: a firm, quiet return into the frame.
  frame: { restitution: FRAME.restitution, friction: FRAME.friction },
};

/**
 * Realistic motion losses, SI units.
 *
 * AIR_DRAG is the quadratic drag coefficient k in a = −k·|v|·v for a smooth
 * sphere: k = ½·ρ·C_d·A/m ≈ ½·1.2·0.47·π·0.11²/0.43 ≈ 0.025 1/m. It is only
 * significant at shot speed, so a slow roll settles without feeling sticky.
 *
 * ROLLING_RESISTANCE is the dimensionless coefficient μ_r for a football on a
 * hard indoor floor (≈0.02–0.035); the deceleration is μ_r·g = 0.29 m/s². A
 * ball on the floor therefore slows linearly with distance instead of the old
 * exponential "grip" that stopped it like it was in sand.
 *
 * Frame-rate independence: the world integrates fixed H = 1/120 s substeps,
 * so 60 Hz (two substeps) and 120 Hz (one) consume the same physical time and
 * produce bit-identical state for the same launch. Air drag is solved exactly,
 * rolling resistance removes a constant Δv per second, and spin damping is an
 * exponential `exp(-SPIN_AIR·dt)`; no loss term is a per-frame multiplier.
 */
const AIR_DRAG = 0.025; // 1/m
export const ROLLING_RESISTANCE = 0.03; // μ_r, dimensionless
const SPIN_AIR = 0.15; // 1/s
const SLIP_GAIN = 0.9; // share of slip folded into spin per substep band
const MICRO_BOUNCE = 0.3; // m/s: slower floor contacts are rest contacts
const SLEEP_SPEED = 0.07; // m/s
const SLEEP_SPIN = 0.6; // rad/s
const SLEEP_HOLD = 0.3; // s
const SURFACE_BAND = 2e-3; // m, "touching the floor" band
/** Clearance kept between the sphere and every surface, metres. */
const SKIN = 2e-4;

// ---------------------------------------------------------------- maths

/** Smallest u ≥ 0 solving a·u² + b·u + c = 0, or NaN. Cancellation-free. */
function firstRoot(a, b, c) {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return NaN;
    const u = -c / b;
    return u >= 0 ? u : NaN;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return NaN;
  const sq = Math.sqrt(disc);
  let u1;
  let u2;
  if (b >= 0) {
    const q = -0.5 * (b + sq);
    u1 = q / a;
    u2 = q !== 0 ? c / q : NaN;
  } else {
    const q = sq - b;
    u1 = c / q;
    u2 = -q / (2 * a);
  }
  let best = Math.min(u1 >= 0 ? u1 : Infinity, u2 >= 0 ? u2 : Infinity);
  if (!Number.isFinite(best)) return NaN;
  // A root that is only rounding noise (the start sits on the surface) is a
  // t = 0 contact, not a hit a few microseconds into the chunk.
  if (best <= 1e-9) best = 0;
  return best;
}

const len = (v) => Math.hypot(v.x, v.y, v.z);

function clampSpeed(v, max = MAX_SPEED) {
  const sp = len(v);
  if (sp > max) {
    const k = max / sp;
    v.x *= k;
    v.y *= k;
    v.z *= k;
  }
}

/**
 * Swept sphere vs axis-aligned box. Starts at centre p with velocity v under
 * vertical acceleration gy for h seconds. Returns the earliest contact
 * u ∈ [0, 1] with the outward normal and the centre at impact, or null.
 */
export function sweepBox(p, v, gy, box, h, radius = R) {
  // A box may state its own inflation (rear walls: faces already on the ball
  // surface) so clearances are measured on the real geometry.
  const inflate = box.radius ?? radius;
  const mins = [box.minX - inflate, box.minY - inflate, box.minZ - inflate];
  const maxs = [box.maxX + inflate, box.maxY + inflate, box.maxZ + inflate];
  const pos = [p.x, p.y, p.z];
  const mov = [v.x, v.y, v.z];
  // strictly inside every inflated slab at t = 0 → already overlapping
  if (p.x > mins[0] && p.x < maxs[0] && p.y > mins[1] && p.y < maxs[1] && p.z > mins[2] && p.z < maxs[2]) {
    const face = shallowFace(p, box, inflate);
    return { u: 0, t: 0, ...face, overlap: true, cx: p.x, cy: p.y, cz: p.z };
  }
  let tIn = -Infinity;
  let tOut = Infinity;
  let enterAxis = -1;
  let enterSign = 0;
  for (let a = 0; a < 3; a += 1) {
    const q = pos[a];
    const m = mov[a];
    if (a === 1) {
      // y with gravity: first times the path reaches the lower and upper bound
      const acc = 0.5 * gy;
      const lo = firstRoot(acc, m, mins[1] - q);
      const hi = firstRoot(acc, m, maxs[1] - q);
      if (q < mins[1]) {
        // below the slab: it can only enter through the lower bound
        if (Number.isNaN(lo) || lo > h) return null;
        if (lo > tIn) {
          tIn = lo;
          enterAxis = 1;
          enterSign = -1;
        }
        if (!Number.isNaN(hi) && hi < tOut) tOut = hi;
      } else if (q > maxs[1]) {
        // Above the slab: a downward path enters through the upper bound.
        const hi = firstRoot(acc, m, maxs[1] - q);
        if (Number.isNaN(hi) || hi > h) return null;
        if (hi > tIn) {
          tIn = hi;
          enterAxis = 1;
          enterSign = 1;
        }
        const loOut = firstRoot(acc, m, mins[1] - q);
        if (!Number.isNaN(loOut) && loOut < tOut) tOut = loOut;
      } else {
        // Already within this slab: this axis cannot be the entry face. Record
        // only the (positive) exit time. Treating the exit as a new entry was
        // the old bug that let a sphere slide past a bar face.
        if (!Number.isNaN(lo) && lo >= 0 && lo < tOut) tOut = lo;
        if (!Number.isNaN(hi) && hi >= 0 && hi < tOut) tOut = hi;
      }
    } else if (Math.abs(m) < 1e-12) {
      if (q < mins[a] || q > maxs[a]) return null;
    } else {
      let t1 = (mins[a] - q) / m;
      let t2 = (maxs[a] - q) / m;
      let sign = -1;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
        sign = 1;
      }
      if (q < mins[a] || q > maxs[a]) {
        if (t1 > tIn) {
          tIn = t1;
          enterAxis = a;
          enterSign = sign;
        }
      }
      if (t2 < tOut) tOut = t2;
    }
    if (tIn > tOut) return null;
  }
  // If the entry interval is entirely in the past the box is behind the
  // sphere (moving away); never turn that into a t = 0 contact.
  if (tIn < -1e-9) return null;
  const enter = Math.max(tIn, 0);
  if (enter > h) return null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  if (enterAxis === 0) nx = enterSign;
  else if (enterAxis === 1) ny = enterSign;
  else if (enterAxis === 2) nz = enterSign;
  else {
    // centre begins inside the inflated box: exit through the shallowest face
    let depth = Infinity;
    for (let a = 0; a < 3; a += 1) {
      const lo = pos[a] - mins[a];
      const hi = maxs[a] - pos[a];
      const d = Math.min(lo, hi);
      if (d < depth) {
        depth = d;
        nx = 0; ny = 0; nz = 0;
        if (a === 0) nx = lo < hi ? -1 : 1;
        else if (a === 1) ny = lo < hi ? -1 : 1;
        else nz = lo < hi ? -1 : 1;
      }
    }
  }
  return {
    u: enter / h,
    t: enter,
    nx,
    ny,
    nz,
    cx: p.x + v.x * enter,
    cy: p.y + v.y * enter + 0.5 * gy * enter * enter,
    cz: p.z + v.z * enter,
  };
}

/**
 * Earliest contact of a sphere with a plane in dt seconds.
 * plane = { axis, coord, normal }: the centre collides at coordinate `coord`
 * while moving along `normal` (coord already includes the radius).
 */
function planeTOI(p, v, gy, plane, dt) {
  if (plane.axis === 1 && Math.abs(v.y) < 1e-9) v = { x: v.x, y: 0, z: v.z };
  const q = plane.axis === 0 ? p.x : plane.axis === 1 ? p.y : p.z;
  const m = plane.axis === 0 ? v.x : plane.axis === 1 ? v.y : v.z;
  // signed distance to the surface, positive inside the room
  const rel = (q - plane.coord) * plane.normal;
  if (m * plane.normal >= 0) return NaN;
  if (rel <= 0) return 0; // touching: resolve the zero-time contact now
  // a·t² + m'·t + rel = 0 with a = ½ g·n (n = normal), m' = m·n > 0
  const acc = plane.axis === 1 && gy ? 0.5 * gy * plane.normal : 0;
  const t = firstRoot(acc, m * plane.normal, rel);
  if (Number.isNaN(t) || t > dt) return NaN;
  return t;
}

/**
 * Earliest contact of the ball with a *slanted* frame plane
 * `{ nx, ny, nz, d, edge }` (inside: n·p ≤ d; d already includes the ball
 * radius). Used for the viewport's left/right/top edges, which are not
 * axis-aligned because they converge at the lens on the near face.
 */
function sweepFramePlane(p, v, gy, plane, dt) {
  const rel = plane.d - (plane.nx * p.x + plane.ny * p.y + plane.nz * p.z);
  if (rel <= 1e-9) return 0; // touching or already outside: resolve now
  const vn = plane.nx * v.x + plane.ny * v.y + plane.nz * v.z;
  if (vn <= 1e-12) return NaN; // parallel or moving back inside
  const acc = 0.5 * gy * plane.ny;
  const t = firstRoot(acc, vn, -rel);
  if (Number.isNaN(t) || t > dt) return NaN;
  return t;
}

function reflect(v, nx, ny, nz, mat) {
  const vn = v.x * nx + v.y * ny + v.z * nz;
  if (vn >= 0) return false;
  const e = mat.restitution;
  const keep = 1 - mat.friction;
  const rx = v.x - vn * nx;
  const ry = v.y - vn * ny;
  const rz = v.z - vn * nz;
  v.x = rx * keep + nx * -vn * e;
  v.y = ry * keep + ny * -vn * e;
  v.z = rz * keep + nz * -vn * e;
  return true;
}

// ------------------------------------------------------------- geometry

export function makeBox(minX, minY, minZ, maxX, maxY, maxZ) {
  return { kind: 'box', minX, minY, minZ, maxX, maxY, maxZ };
}

/** Contract helper: a solid axis-aligned box collider. */
export function createBox(minX, minY, minZ, maxX, maxY, maxZ) {
  return makeBox(minX, minY, minZ, maxX, maxY, maxZ);
}

/**
 * The rear-room walls beside the goal corridor as solid boxes (not drawn):
 * one on each side of the goal frame's outer posts. They close the rear room
 * (which is the full room, with the goal across its front) behind the goal so
 * that (a) a rear-room sphere never leaves the rear room through the thin
 * frame bars, and (b) each wall face carries its own contact shadow, so a
 * ball on the far side of a wall reads without the room being drawn.
 * Never red/green; they bounce like any other room wall.
 */
export function rearWalls(room = ROOM, radius = R) {
  const floorY = room.floorY ?? 0;
  const ledge = GOAL_WIDTH / 2 + BAR;
  const walls = [
    makeBox(room.minX - 1, floorY - radius - SKIN, REAR_Z, -ledge, room.maxY + radius + 1, 0),
    makeBox(ledge, floorY - radius - SKIN, REAR_Z, room.maxX + 1, room.maxY + radius + 1, 0),
  ];
  for (const wall of walls) wall.radius = 0; // faces already on the ball surface
  return walls;
}

/** The finite room's colliders: its planes and the two rear-room walls. */
export function createRoom(opts = {}) {
  const room = { ...ROOM, ...(opts.room ?? {}) };
  const radius = opts.radius ?? R;
  return { room, radius, planes: roomPlanes(room, radius), boxes: rearWalls(room, radius) };
}

/** Ball-surfacing planes of the room (offsets already include the radius). */
export function roomPlanes(room = ROOM, radius = R) {
  return {
    floor: { axis: 1, coord: (room.floorY ?? 0) + radius + SKIN, normal: 1, tag: 'floor' },
    ceil: { axis: 1, coord: room.maxY - radius - SKIN, normal: -1, tag: 'ceil' },
    left: { axis: 0, coord: room.minX + radius + SKIN, normal: 1, tag: 'left' },
    right: { axis: 0, coord: room.maxX - radius - SKIN, normal: -1, tag: 'right' },
    back: { axis: 2, coord: room.minZ + radius + SKIN, normal: 1, tag: 'back' },
    front: { axis: 2, coord: room.maxZ - radius - SKIN, normal: -1, tag: 'front' },
  };
}

/** The goal frame: bar boxes (frame + dividers) and the ten openings. */
export function createGoal(opts = {}) {
  const t = opts.bar ?? BAR;
  const s = opts.opening ?? OPENING;
  const depth = opts.barDepth ?? BAR_DEPTH;
  const rearDepth = opts.rearDepth ?? REAR_DEPTH;
  const width = (CELLS_X + 1) * t + CELLS_X * s;
  const height = (CELLS_Y + 1) * t + CELLS_Y * s;
  const half = width / 2;
  const bars = [];
  const barInfo = [];
  const addBar = (minX, minY, maxX, maxY, bar) => {
    bars.push(makeBox(minX, minY, -depth, maxX, maxY, 0));
    // Keep the face rectangle so the view can light the struck bar/post
    // itself, not the opening beside it.
    barInfo.push({ bar, minX, minY, maxX, maxY });
  };
  for (let row = 0; row <= CELLS_Y; row += 1) {
    const y = row * (s + t);
    addBar(-half, y, half, y + t, row === 0 ? 'bottom' : row === CELLS_Y ? 'top' : 'divider-h');
  }
  for (let col = 0; col <= CELLS_X; col += 1) {
    const x = -half + col * (s + t);
    addBar(x, t, x + t, t + CELLS_Y * (s + t), col === 0 ? 'left' : col === CELLS_X ? 'right' : 'divider-v');
  }
  const openings = [];
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) openings.push({ index: i, ...openingRect(i) });
  return { bars, barInfo, openings, width, height, half, t, s, barDepth: depth, rearDepth };
}

/** Opening containing a whole sphere (centre x, y of the goal plane). */
export function openingContaining(x, y, radius = R) {
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) {
    const c = openingRect(i);
    if (x - radius >= c.left - 1e-9 && x + radius <= c.right + 1e-9
      && y - radius >= c.bottom - 1e-9 && y + radius <= c.top + 1e-9) return i;
  }
  return -1;
}

/** Opening whose centre is nearest to (x, y). */
export function nearestOpeningCentre(x, y) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) {
    const c = openingRect(i);
    const d = (c.cx - x) ** 2 + (c.cy - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Velocity from `from` reaching `target` at time `time` under gravity. */
export function solveLaunch(from, target, time, gravity = G) {
  const h = Math.max(1e-3, time);
  return {
    vx: (target.x - from.x) / h,
    vy: (target.y - from.y - 0.5 * gravity * h * h) / h,
    vz: (target.z - from.z) / h,
  };
}

// ---------------------------------------------------------------- world

/**
 * @param {object} [opts]
 * @param {object} [opts.room] room overrides
 * @param {boolean} [opts.goal] include the goal (default true)
 * @param {object} [opts.goalOptions] forwarded to createGoal
 * @param {boolean} [opts.viewport] add the visible viewport's hard frame
 *   (the playable wedge inside the camera crop). Off by default so the pure
 *   room contract can be tested on its own; the site turns it on.
 */
export function createWorld(opts = {}) {
  const room = { ...ROOM, ...(opts.room ?? {}) };
  const radius = opts.radius ?? R;
  const planes = roomPlanes(room, radius);
  const goal = opts.goal === false ? null : createGoal(opts.goalOptions);
  /** Centre height of a resting, unsupported ball (on the floor). */
  const restY = (room.floorY ?? 0) + radius + SKIN;
  const bars = goal ? goal.bars : [];
  const barInfo = goal ? goal.barInfo : [];
  const planeList = [planes.floor, planes.ceil, planes.left, planes.right, planes.back, planes.front];
  // The room behind the goal: solid walls beside the mouth corridor, in the
  // same room (one floor, one ceiling, one rear wall). Never drawn.
  const walls = goal ? rearWalls(room, radius) : [];
  /**
   * First hard boundary: the visible viewport projected into the room. It is
   * a truncated pyramid — left/right/top screen edges plus a near cap where
   * the bottom edge meets the floor. `framePlanes()` includes the ball radius
   * in every offset, so a non-goal ball can never leave the frame.
   */
  const viewport = opts.viewport ? framePlanes(radius) : null;

  const w = {
    radius,
    room,
    frontZ: room.maxZ,
    goal,
    viewport,
    time: 0,
    shotId: 0,
    substeps: 0,
    pos: { x: 0, y: restY, z: RESTING.z },
    vel: { x: 0, y: 0, z: 0 },
    spin: { x: 0, y: 0, z: 0 },
    prev: { x: 0, y: restY, z: RESTING.z },
    awake: true,
    supported: true,
    sleepTimer: 0,
    goals: [],
    reds: [],
    lastGoal: null,
    lastBar: null,
  };

  const clampTo = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

  /** Push a point back inside the visible frame wedge (2 passes: corners). */
  function clampToFrame(pos) {
    if (!viewport) return pos;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const plane of viewport) {
        const outside = plane.nx * pos.x + plane.ny * pos.y + plane.nz * pos.z - plane.d;
        if (outside > 0) {
          pos.x -= plane.nx * outside;
          pos.y -= plane.ny * outside;
          pos.z -= plane.nz * outside;
        }
      }
    }
    return pos;
  }

  /** Physics-only: zero velocity in place (input placement; no launch). */
  function hold(init = {}) {
    const x = Number.isFinite(init.x) ? clampTo(init.x, room.minX + radius, room.maxX - radius) : w.pos.x;
    const y = Number.isFinite(init.y) ? clampTo(init.y, restY, room.maxY - radius) : restY;
    const z = Number.isFinite(init.z) ? clampTo(init.z, room.minZ + radius, room.maxZ - radius) : w.pos.z;
    w.pos = clampToFrame({ x, y: Math.max(y, restY), z });
    w.vel = { x: 0, y: 0, z: 0 };
    w.spin = { x: 0, y: 0, z: 0 };
    // Placement within a millimetre of the floor snaps onto it, so the rest
    // offset in config (RESTING) can never leave the ball hovering.
    w.supported = w.pos.y <= restY + 1e-3;
    if (w.supported) w.pos.y = restY;
    w.awake = true;
    w.sleepTimer = 0;
    w.prev = { ...w.pos };
    w._acc = 0;
    return state();
  }

  function reset(init = {}) {
    const x = Number.isFinite(init.x) ? clampTo(init.x, room.minX + radius, room.maxX - radius) : 0;
    const y = Number.isFinite(init.y) ? clampTo(init.y, restY, room.maxY - radius) : restY;
    const z = Number.isFinite(init.z) ? clampTo(init.z, room.minZ + radius, room.maxZ - radius) : RESTING.z;
    const vx = init.vx ?? 0;
    const vy = init.vy ?? 0;
    const vz = init.vz ?? 0;
    w.pos = clampToFrame({ x, y, z });
    w.vel = { x: vx, y: vy, z: vz };
    w.spin = { x: init.wx ?? 0, y: init.wy ?? 0, z: init.wz ?? 0 };
    w.awake = true;
    w.supported = y <= restY + 1e-9 && vy === 0;
    if (w.supported) w.pos.y = restY;
    w.sleepTimer = 0;
    w.goals = [];
    w.reds = [];
    w.lastGoal = null;
    w.lastBar = null;
    w.prev = { ...w.pos };
    w._acc = 0;
    return state();
  }

  function launch(l) {
    w.shotId += 1;
    w.goals = [];
    w.reds = [];
    w.lastGoal = null;
    w.lastBar = null;
    // A launch is always airborne: the normal force of the floor does not
    // apply to a pushed ball, even one pushed straight forward.
    if (w.pos.y < restY) w.pos.y = restY;
    w.vel = { x: l.vx ?? 0, y: l.vy ?? 0, z: l.vz ?? 0 };
    if (Math.abs(w.vel.y) < 1e-12) w.vel.y = 0;
    w.spin = {
      x: l.wx ?? (-(l.vz ?? 0) / radius) * 0.3,
      y: l.wy ?? 0,
      z: l.wz ?? ((l.vx ?? 0) / radius) * 0.3,
    };
    clampSpeed(w.vel);
    // A push along the floor is a roll, not a tiny fall: keep the normal
    // support when the centre is on the floor and the launch has no upward
    // component. Any upward component makes the shot airborne.
    const atFloor = w.pos.y <= restY + 1e-6;
    if (atFloor) w.pos.y = restY;
    w.supported = atFloor && (w.vel.y <= 1e-9)
      && (len(w.vel) > 0 || w.supported);
    w.awake = true;
    w.sleepTimer = 0;
    return state();
  }

  function state() {
    return {
      pos: { ...w.pos },
      vel: { ...w.vel },
      spin: { ...w.spin },
      awake: w.awake,
      supported: w.supported,
      goals: [...w.goals],
      reds: [...w.reds],
      lastGoal: w.lastGoal ? { ...w.lastGoal } : null,
      lastBar: w.lastBar ? { ...w.lastBar } : null,
      shotId: w.shotId,
      time: w.time,
    };
  }

  /** Quadratic air drag: a = −k·|v|·v, solved over dt without overshoot. */
  function airDrag(dt) {
    const sp = len(w.vel);
    if (!(sp > 1e-9)) return;
    const scale = 1 / (1 + AIR_DRAG * sp * dt);
    w.vel.x *= scale;
    w.vel.y *= scale;
    w.vel.z *= scale;
  }

  /**
   * Floor losses while the sphere is rolling. Rolling resistance is a
   * constant deceleration μ_r·g (linear speed loss in time), not the old
   * exponential grip; the spin is then relaxed toward rolling without
   * slipping (ω = (−vz, 0, vx)/R).
   */
  function surfaceDrag(dt) {
    if (!w.supported) {
      // Exponential decay: the same physical damping per second at 60, 120 or
      // any render rate. A first-order `1 - k·dt` would lose different amounts
      // of spin depending on how the frame happened to be sliced.
      const k = Math.exp(-SPIN_AIR * dt);
      w.spin.x *= k;
      w.spin.y *= k;
      w.spin.z *= k;
      return;
    }
    const roll = Math.hypot(w.vel.x, w.vel.z);
    if (roll > 1e-9) {
      const drop = Math.min(roll, ROLLING_RESISTANCE * G * dt);
      const keep = (roll - drop) / roll;
      w.vel.x *= keep;
      w.vel.z *= keep;
    }
    // rolling without slipping: ω = (−vz, 0, vx)/R
    const a = Math.min(1, SLIP_GAIN * dt);
    w.spin.x += (-w.vel.z / radius - w.spin.x) * a;
    w.spin.z += (w.vel.x / radius - w.spin.z) * a;
  }

  /** Opening a struck bar belongs to. */
  function barCell(info, point) {
    const { x, y } = point;
    const nearRow = nearestOpeningCentre(x, y) >= CELLS_X ? 1 : 0;
    const nearCol = nearestOpeningCentre(x, y) % CELLS_X;
    switch (info.bar) {
      case 'top':
        return nearestOpeningCentre(x, y - 1);
      case 'bottom':
        return nearestOpeningCentre(x, y + 1);
      case 'divider-h':
        return (w.pos.y >= y ? 1 : 0) * CELLS_X + nearCol;
      case 'divider-v':
        return nearRow * CELLS_X + clampTo(nearCol + (w.pos.x < x ? -1 : 1), 0, CELLS_X - 1);
      case 'left':
        return nearRow * CELLS_X;
      case 'right':
        return nearRow * CELLS_X + CELLS_X - 1;
      default:
        return nearestOpeningCentre(x, y);
    }
  }

  /**
   * Fly for at most `dt` seconds. Stops at the earliest bar TOI, plane TOI or
   * whole-sphere goal crossing; returns the seconds consumed.
   *
   * Order: a bar found by sweeping that begins strictly before the goal-plane
   * crossing wins (it was reached first); a goal crossing that begins strictly
   * before every contact is emitted; an overlap that was already there at the
   * start of the chunk (a corner between surfaces) is pushed out silently.
   */
  const dts = [];
  function chunk(dt, events) {
    const p0 = { x: w.pos.x, y: w.pos.y, z: w.pos.z };
    const v0 = { x: w.vel.x, y: w.vel.y, z: w.vel.z };
    const gy = w.supported ? 0 : -G;
    let bestBarU = 1;
    let bestBar = -1;
    let bestHit = null;
    for (let i = 0; i < bars.length; i += 1) {
      const hit = sweepBox(p0, v0, gy, bars[i], dt, radius);
      if (hit && (bestHit === null || hit.u < bestBarU)) {
        bestBarU = hit.u;
        bestBar = i;
        bestHit = hit;
      }
    }
    // Rear-room walls: real sides of the space behind the goal, never red/green.
    // (Box index = bars.length + wall index; -1 = no box contact.)
    for (let i = 0; i < walls.length; i += 1) {
      const hit = sweepBox(p0, v0, gy, walls[i], dt, radius);
      if (hit && hit.u < bestBarU) {
        bestBarU = hit.u;
        bestBar = bars.length + i;
        bestHit = hit;
      }
    }
    let bestPlaneT = dt;
    let bestPlane = -1;
    for (let i = 0; i < planeList.length; i += 1) {
      const plane = planeList[i];
      if (plane.tag === 'floor' && (w.supported || w.vel.y >= 0)) continue; // held or rising
      const t = planeTOI(p0, v0, gy, plane, dt);
      if (!Number.isNaN(t) && t < bestPlaneT) {
        bestPlaneT = t;
        bestPlane = i;
      }
    }
    let bestFrameT = dt;
    let bestFrame = -1;
    if (viewport) {
      for (let i = 0; i < viewport.length; i += 1) {
        const t = sweepFramePlane(p0, v0, gy, viewport[i], dt);
        if (!Number.isNaN(t) && t < bestFrameT) {
          bestFrameT = t;
          bestFrame = i;
        }
      }
    }
    let crossing = null;
    if (v0.z < -1e-9 && p0.z > 0) {
      const t = -p0.z / v0.z;
      if (t <= dt) {
        const cx = p0.x + v0.x * t;
        const cy = p0.y + v0.y * t + 0.5 * gy * t * t;
        if (cy > -radius && cy < room.maxY) {
          const cell = openingContaining(cx, cy, radius);
          if (cell >= 0 && !w.goals.includes(cell)) crossing = { t, cell, cx, cy };
        }
      }
    }
    const barT = bestBarU * dt;
    const flightEnd = () => {
      // fly the rest of the chunk free (gravity only when airborne)
      const rest = Math.max(0, dt - consumed);
      return rest;
    };
    let consumed = dt;

    // (1) goal crossing first?
    if (crossing && crossing.t < barT - TOL && crossing.t < bestPlaneT - TOL
      && crossing.t < bestFrameT - TOL && !(bestHit && bestHit.u === 0)) {
      const rest = dt - crossing.t;
      const vyAt = v0.y + gy * crossing.t;
      const gReal = w.supported ? -G : gy;
      w.pos = {
        x: crossing.cx + v0.x * rest,
        y: crossing.cy + vyAt * rest + 0.5 * gReal * rest * rest,
        z: v0.z * rest,
      };
      w.vel = { x: v0.x, y: vyAt + gReal * rest, z: v0.z };
      w.goals.push(crossing.cell);
      w.lastGoal = { cell: crossing.cell, t: w.time + crossing.t };
      events.push({
        type: 'goal',
        cell: crossing.cell,
        point: { x: crossing.cx, y: crossing.cy, z: 0 },
        speed: len(w.vel),
      });
      return Math.max(crossing.t, 1e-9);
    }

    // (2) the visible frame is closer than any bar/room contact: the ball
    // bounces back into the viewport. This is the first hard boundary; it
    // never lights red/green and never opens a page.
    if (bestFrame >= 0 && bestFrameT < barT - TOL && bestFrameT < bestPlaneT - TOL) {
      const plane = viewport[bestFrame];
      const t = bestFrameT;
      const gReal = w.supported ? -G : gy;
      w.pos = {
        x: p0.x + v0.x * t,
        y: p0.y + v0.y * t + 0.5 * gy * t * t,
        z: p0.z + v0.z * t,
      };
      w.vel = { x: v0.x, y: v0.y + gy * t, z: v0.z };
      // Put the centre exactly on the (radius-offset) surface; a ball that was
      // already past it is pushed back instead of bouncing from outside.
      const signed = plane.nx * w.pos.x + plane.ny * w.pos.y + plane.nz * w.pos.z - plane.d;
      if (signed > 0) {
        w.pos.x -= plane.nx * signed;
        w.pos.y -= plane.ny * signed;
        w.pos.z -= plane.nz * signed;
      }
      const speed = len(w.vel);
      if (reflect(w.vel, plane.nx, plane.ny, plane.nz, MATERIAL.frame)
        && speed >= MIN_BAR_SPEED) {
        events.push({
          type: 'wall',
          kind: 'frame',
          edge: plane.edge,
          speed,
          point: { ...w.pos },
          normal: { x: plane.nx, y: plane.ny, z: plane.nz },
        });
      }
      // The remainder of the chunk after the bounce (same convention as the
      // room planes): a solved contact consumes no extra sim time.
      const rest = Math.max(0, dt - t);
      if (rest > 1e-12) {
        w.pos.x += w.vel.x * rest;
        w.pos.y += w.vel.y * rest + 0.5 * gReal * rest * rest;
        w.pos.z += w.vel.z * rest;
        w.vel.y += gReal * rest;
      }
      return Math.max(t, 1e-9);
    }

    if (bestBar >= 0) {
      const isWall = bestBar >= bars.length;
      const box = isWall ? walls[bestBar - bars.length] : bars[bestBar];
      if (bestHit.u === 0) {
        // already overlapping at the chunk start: push out, no bounce, no red;
        // the rest of the substep then re-tests against every collider from
        // the corrected position. A shot sphere cannot straddle a room
        // boundary, so a real bounce is never dropped to a silent push-out.
        const inflation = box.radius ?? radius;
        const face = bestHit.overlap ? { nx: bestHit.nx, ny: bestHit.ny, nz: bestHit.nz } : shallowFace(p0, box, inflation);
        const from = { ...p0 };
        w.pos = { ...p0 };
        fixBox(w.pos, box, face.nx, face.ny, face.nz, inflation);
        w.vel = { x: v0.x, y: v0.y, z: v0.z };
        const moved = Math.hypot(w.pos.x - from.x, w.pos.y - from.y, w.pos.z - from.z);
        return moved > 1e-12 ? 0 : Math.max(dt - TOL, 1e-9);
      }
      const { nx, ny, nz } = bestHit;
      w.pos = { x: bestHit.cx, y: bestHit.cy, z: bestHit.cz };
      if (nx < 0) w.pos.x = box.minX - radius - TOL;
      else if (nx > 0) w.pos.x = box.maxX + radius + TOL;
      if (ny < 0) w.pos.y = box.minY - radius - TOL;
      else if (ny > 0) w.pos.y = box.maxY + radius + TOL;
      if (nz < 0) w.pos.z = box.minZ - radius - TOL;
      else if (nz > 0) w.pos.z = box.maxZ + radius + TOL;
      w.vel = { x: v0.x, y: v0.y + gy * barT, z: v0.z };
      const speed = len(w.vel);
      reflect(w.vel, nx, ny, nz, MATERIAL.bars);
      consumed = barT;
      if (isWall) {
        // the room behind the goal: a plain wall rebound, no red, no green
        if (speed >= MIN_BAR_SPEED) {
          events.push({ type: 'wall', kind: 'rear', speed, point: { ...w.pos }, normal: { x: nx, y: ny, z: nz } });
        }
      } else {
        const cell = barCell(barInfo[bestBar], w.pos);
        if (!w.reds.includes(cell)) w.reds.push(cell);
        w.lastBar = { cell, bar: barInfo[bestBar].bar, t: w.time + barT, speed };
        const repeated = events.some((e) => e.type === 'bar' && e.cell === cell && e.bar === barInfo[bestBar].bar);
        if (speed >= MIN_BAR_SPEED && !repeated) {
          events.push({
            type: 'bar',
            cell,
            bar: barInfo[bestBar].bar,
            barRect: {
              minX: barInfo[bestBar].minX,
              minY: barInfo[bestBar].minY,
              maxX: barInfo[bestBar].maxX,
              maxY: barInfo[bestBar].maxY,
            },
            point: { ...w.pos },
            speed,
            normal: { x: nx, y: ny, z: nz },
          });
        }
      }
      const rest = flightEnd();
      if (rest > 1e-12) {
        const gReal = w.supported ? -G : gy;
        w.pos.x += w.vel.x * rest;
        w.pos.y += w.vel.y * rest + 0.5 * gReal * rest * rest;
        w.pos.z += w.vel.z * rest;
        w.vel.y += gReal * rest;
      }
      return Math.max(consumed, 1e-9);
    }

    if (bestPlane >= 0) {
      const plane = planeList[bestPlane];
      if (bestPlaneT === 0) {
        const q = plane.axis === 0 ? p0.x : plane.axis === 1 ? p0.y : p0.z;
        const vn = (plane.axis === 0 ? v0.x : plane.axis === 1 ? v0.y : v0.z) * plane.normal;
        const touching = (q - plane.coord) * plane.normal <= 1e-9;
        if (touching && vn > -MICRO_BOUNCE) {
          // rest contact: supported for the rest of the substep
          if (plane.axis === 1 && plane.normal > 0) {
            w.pos.y = restY;
            w.vel.y = 0;
            w.supported = true;
          }
          return Infinity;
        }
        if (touching && !w.supported) {
          // impact of a descent that ended exactly on the plane: bounce now
          w.pos.x = p0.x;
          w.pos.y = p0.y;
          w.pos.z = p0.z;
          w.vel = { x: v0.x, y: v0.y, z: v0.z };
          if (plane.axis === 0) w.pos.x = plane.coord;
          else if (plane.axis === 1) w.pos.y = plane.coord;
          else w.pos.z = plane.coord;
          const nx = plane.axis === 0 ? plane.normal : 0;
          const ny = plane.axis === 1 ? plane.normal : 0;
          const nz = plane.axis === 2 ? plane.normal : 0;
          const mat = plane.tag === 'floor' ? MATERIAL.floor : plane.tag === 'front' ? MATERIAL.front : MATERIAL.walls;
          const speed = len(w.vel);
          if (reflect(w.vel, nx, ny, nz, mat) && speed >= MIN_BAR_SPEED) {
            events.push({ type: 'wall', kind: plane.tag, speed, point: { ...w.pos }, normal: { x: nx, y: ny, z: nz } });
          }
          if (ny > 0.5 && w.vel.y < MICRO_BOUNCE) {
            w.vel.y = 0;
            w.pos.y = restY;
            w.supported = true;
            return Infinity;
          }
          return 1e-6; // the remainder of the substep continues after the bounce
        }
        return dt - TOL; // overlap correction already done: no time consumed
      }
      const t = bestPlaneT;
      w.pos = {
        x: p0.x + v0.x * t,
        y: p0.y + v0.y * t + 0.5 * gy * t * t,
        z: p0.z + v0.z * t,
      };
      w.vel = { x: v0.x, y: v0.y + gy * t, z: v0.z };
      if (plane.axis === 0) w.pos.x = plane.coord;
      else if (plane.axis === 1) w.pos.y = plane.coord;
      else w.pos.z = plane.coord;
      const speed = len(w.vel);
      const nx = plane.axis === 0 ? plane.normal : 0;
      const ny = plane.axis === 1 ? plane.normal : 0;
      const nz = plane.axis === 2 ? plane.normal : 0;
      w.supported = false;
      const vn = w.vel.x * nx + w.vel.y * ny + w.vel.z * nz;
      const slipX = w.vel.x - vn * nx;
      const slipZ = w.vel.z - vn * nz;
      const mat = plane.tag === 'front' ? MATERIAL.front
        : plane.tag === 'floor' ? MATERIAL.floor
          : MATERIAL.walls;
      const bounced = reflect(w.vel, nx, ny, nz, mat);
      if (bounced && ny > 0.5) {
        w.spin.x += -slipZ * 6;
        w.spin.z += slipX * 6;
        // a weak landing is a rest contact (only the remainder of this substep
        // follows a solved contact, so it is never real flight)
        if (w.vel.y < MICRO_BOUNCE) {
          w.vel.y = 0;
          w.pos.y = restY;
          w.supported = true;
        }
      }
      consumed = t;
      if (bounced && speed >= MIN_BAR_SPEED) {
        events.push({ type: 'wall', kind: plane.tag, speed, point: { ...w.pos }, normal: { x: nx, y: ny, z: nz } });
      }
      const rest = flightEnd();
      if (rest > 1e-12) {
        const gReal = w.supported ? -G : gy;
        w.pos.x += w.vel.x * rest;
        w.pos.y += w.vel.y * rest + 0.5 * gReal * rest * rest;
        w.pos.z += w.vel.z * rest;
        w.vel.y += gReal * rest;
      }
      if (w.pos.y < restY && !w.supported) {
        w.pos.y = restY;
        if (w.vel.y < 0) w.vel.y = 0;
      }
      return Math.max(consumed, 1e-9);
    }

    // fly free for the whole chunk. The integral must stay the exact sum of
    // this substep's chunks, so the result never depends on how a caller
    // groups substeps: after a contact, the rest of the chunk (consumed was
    // set to the contact time) continues from the corrected position.
    const rest = consumed < dt ? dt - consumed : dt;
    w.pos = {
      x: w.pos.x + v0.x * rest,
      y: w.pos.y + v0.y * rest + 0.5 * gy * rest * rest,
      z: w.pos.z + v0.z * rest,
    };
    w.vel = { x: v0.x, y: v0.y + gy * rest, z: v0.z };
    if (gy === 0 && rest > 0) w.vel.y = v0.y; // held on the floor: no gravity in the integral
    // a slow descent onto the floor becomes a rest contact, not a landing
    if (w.pos.y <= restY + 1e-6 && w.vel.y <= MICRO_BOUNCE) {
      w.vel.y = 0;
      w.pos.y = restY;
      w.supported = true;
    }
    if (gy !== 0 && w.pos.y < restY) {
      w.pos.y = restY;
      if (w.vel.y < 0) w.vel.y = 0;
    }
    return dt;
  }

  /**
   * Safety net for the first hard boundary. The swept tests resolve a real
   * contact; after a contact's free-flight remainder the centre can still be a
   * fraction of a millimetre outside a slanted frame plane. This projects it
   * back onto the surface and reflects any outward velocity, so the invariant
   * "a non-goal ball never leaves the frame" holds exactly at every substep.
   */
  function guardViewport(events) {
    if (!viewport) return;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const plane of viewport) {
        const out = plane.nx * w.pos.x + plane.ny * w.pos.y + plane.nz * w.pos.z - plane.d;
        if (out <= 1e-9) continue;
        w.pos.x -= plane.nx * out;
        w.pos.y -= plane.ny * out;
        w.pos.z -= plane.nz * out;
        const vn = plane.nx * w.vel.x + plane.ny * w.vel.y + plane.nz * w.vel.z;
        if (vn > 0) {
          const speed = len(w.vel);
          reflect(w.vel, plane.nx, plane.ny, plane.nz, MATERIAL.frame);
          if (speed >= MIN_BAR_SPEED) {
            events.push({
              type: 'wall',
              kind: 'frame',
              edge: plane.edge,
              speed,
              point: { ...w.pos },
              normal: { x: plane.nx, y: plane.ny, z: plane.nz },
            });
          }
        }
      }
    }
  }

  /** One fixed substep: rate drag, then alternate chunks until dt is spent. */
  function substep(dt, events) {
    if (!w.awake) return;
    w.prev = { ...w.pos };
    airDrag(dt);
    clampSpeed(w.vel);
    let remaining = dt;
    for (let n = 0; n < MAX_CHUNKS && remaining > 1e-12; n += 1) {
      if (n === 0) surfaceDrag(dt);
      const asked = Math.min(remaining, CHUNK);
      const cons = chunk(asked, events);
      if (cons === Infinity) {
        // resting on a contact plane: nothing else happens this substep
        w.vel.y = 0;
        w.pos.y = restY;
        w.supported = true;
        break;
      }
      remaining = Math.max(0, remaining - Math.max(Math.min(cons, asked), 1e-12));
      clampSpeed(w.vel);
      guardBounds(room, radius, w.pos);
      guardViewport(events);
    }
    // A free-flight chunk consumed the whole substep; anything left after
    // MAX_CHUNKS is flown without collision resolution (never left behind:
    // the position must be the exact integral of the velocity).
    if (remaining > 1e-12 && !w.supported) {
      const gy2 = -G;
      w.pos.x += w.vel.x * remaining;
      w.pos.y += w.vel.y * remaining + 0.5 * gy2 * remaining * remaining;
      w.pos.z += w.vel.z * remaining;
      w.vel.y += gy2 * remaining;
    }
    guardViewport(events);
    w.time += dt;
    w.substeps += 1;
    sleepCheck(dt, events);
  }

  function sleepCheck(dt, events) {
    const roll = Math.hypot(w.vel.x, w.vel.z);
    const slow = roll < SLEEP_SPEED && Math.abs(w.vel.y) < 0.02 && len(w.spin) < SLEEP_SPIN
      && w.pos.y <= restY + 2 * SKIN + 1e-3;
    if (slow) {
      w.sleepTimer += dt;
      if (w.sleepTimer >= SLEEP_HOLD) {
        w.awake = false;
        w.vel = { x: 0, y: 0, z: 0 };
        w.spin = { x: 0, y: 0, z: 0 };
        w.pos.y = restY;
        events.push({ type: 'settled' });
      }
    } else {
      w.sleepTimer = 0;
    }
  }

  w.reset = reset;
  w.hold = hold;
  w.launch = launch;
  w.state = state;

  /**
   * Fixed-substep clock. Every call advances whole H = 1/120 s substeps and
   * carries the remainder, so `step(0.05)` and `5 × step(0.01)` and
   * `6 × step(1/120)` integrate exactly the same sequence. (The old version
   * re-divided the caller's h, which made results depend on how a frame was
   * sliced.)
   *
   * Events are reported per substep: bar contacts first, then goals that were
   * not won by a bar on the same cell in the same substep. Physics still
   * resolves the actual contact order; this only makes the public event order
   * stable for the red/green handshake.
   */
  w._acc = 0;
  w.step = (h) => {
    const events = [];
    if (!(h > 0)) return events;
    w._acc += h;
    let guard = 0;
    while (w._acc >= H - 1e-9 && guard < 240) {
      w._acc -= H;
      guard += 1;
      const local = [];
      substep(H, local);
      if (local.length) {
        const barCells = new Set(local.filter((e) => e.type === 'bar').map((e) => e.cell));
        for (const e of local) if (e.type === 'bar') events.push(e);
        for (const e of local) {
          if (e.type === 'goal' && barCells.has(e.cell)) continue;
          if (e.type === 'bar') continue;
          events.push(e);
        }
      }
      if (!w.awake) {
        w._acc = 0;
        break;
      }
    }
    if (guard >= 240) w._acc = 0;
    return events;
  };
  return w;
}

/** How deep a centre is inside the radius-inflated box (0 when outside). */
function boxDepth(p, box, radius = R) {
  const d = [
    Math.min(p.x - (box.minX - radius), (box.maxX + radius) - p.x),
    Math.min(p.y - (box.minY - radius), (box.maxY + radius) - p.y),
    Math.min(p.z - (box.minZ - radius), (box.maxZ + radius) - p.z),
  ];
  return Math.min(...d);
}

/** Outward face normal of the shallowest containment face. */
function shallowFace(p, box, radius = R) {
  const lo = [p.x - (box.minX - radius), p.y - (box.minY - radius), p.z - (box.minZ - radius)];
  const hi = [(box.maxX + radius) - p.x, (box.maxY + radius) - p.y, (box.maxZ + radius) - p.z];
  let axis = 0;
  for (let a = 1; a < 3; a += 1) if (Math.min(lo[a], hi[a]) < Math.min(lo[axis], hi[axis])) axis = a;
  const sign = lo[axis] < hi[axis] ? -1 : 1;
  return { nx: axis === 0 ? sign : 0, ny: axis === 1 ? sign : 0, nz: axis === 2 ? sign : 0 };
}

function fixBox(p, box, nx, ny, nz, radius = R) {
  if (nx < 0) p.x = box.minX - radius - 1e-6;
  else if (nx > 0) p.x = box.maxX + radius + 1e-6;
  if (ny < 0) p.y = box.minY - radius - 1e-6;
  else if (ny > 0) p.y = box.maxY + radius + 1e-6;
  if (nz < 0) p.z = box.minZ - radius - 1e-6;
  else if (nz > 0) p.z = box.maxZ + radius + 1e-6;
}

function guardBounds(room, radius, p) {
  const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);
  p.x = clamp(p.x, room.minX + radius + SKIN, room.maxX - radius - SKIN);
  p.y = clamp(p.y, (room.floorY ?? 0) + radius, room.maxY - radius - SKIN);
  p.z = clamp(p.z, room.minZ + radius + SKIN, room.maxZ - radius - SKIN);
}
