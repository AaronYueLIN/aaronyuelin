/**
 * Rapier 3D physics for the football room.
 *
 * Public shape intentionally mirrors the old hand-rolled `physics.js`:
 *   createWorld(), world.step(dt) -> events, world.state(), launch, hold,
 *   reset, awake, time, shotId.
 *
 * The visual mesh reads the rigid body's translation AND rotation every
 * frame. There is no second pose, no visual-only spin.
 *
 * Static geometry comes from the same config as the renderer:
 *   floor / ceiling / four invisible walls / rear room / 2x5 goal bars.
 * Ten goal sensors sit just behind the apertures. A whole-ball crossing
 * inside one opening emits `goal`; a bar contact emits `bar` (red, rebound).
 */

import RAPIER from './vendor/rapier/rapier.mjs';
import {
  BALL_RADIUS,
  BAR,
  BAR_DEPTH,
  CELLS_X,
  CELLS_Y,
  FLOOR_Y,
  GOAL,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  OPENING,
  REAR_DEPTH,
  REAR_Z,
  RESTING,
  ROOM,
  openingRect,
} from './config.js?v=2026.11.23-r10';

export { BALL_RADIUS, GOAL, GOAL_WIDTH, GOAL_HEIGHT, OPENING, BAR, CELLS_X, CELLS_Y, ROOM, RESTING, openingRect };
export const G = 9.81;
export const H = 1 / 120;
// FIFA size-5 football: 0.43 kg, r = 0.11 m (config), drag Cd ≈ 0.25,
// sea-level air 1.204 kg/m³. Bounce: FIFA rebound test 1.35–1.65 m from 2 m
// gives e ≈ 0.82–0.91 on a hard floor; we use 0.80. Posts are softer (0.60).
export const MASS = 0.43;
export const FRICTION = 0.55;
export const RESTITUTION = 0.80;
const BAR_RESTITUTION = 0.60;
const AIR_DENSITY = 1.204;
const DRAG_CD = 0.25;
/** Quadratic drag constant c in F = −c·|v|·v (N·s²/m²). */
const DRAG_C = 0.5 * AIR_DENSITY * DRAG_CD * Math.PI * BALL_RADIUS * BALL_RADIUS;
/** Rolling resistance coefficient of a football on a hard indoor floor. */
const ROLL_MU = 0.035;
const ANGULAR_DAMPING = 0.02;
const LINEAR_DAMPING = 0;
/** Drag hand: critically damped spring toward the finger (rad/s). */
const HAND_OMEGA = 22;
const SKIN = 2e-4;
const MAX_SPEED = 22;

let ready = false;

/** Load the compat build once (wasm is inlined in the vendored module). */
export async function initRapier() {
  if (ready) return RAPIER;
  await RAPIER.init();
  ready = true;
  return RAPIER;
}

function vec(x, y, z) { return { x, y, z }; }
function quat(q) { return { x: q.x, y: q.y, z: q.z, w: q.w }; }
function speedOf(v) { return Math.hypot(v.x, v.y, v.z); }

function openingAt(x, y) {
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) {
    const r = openingRect(i);
    if (x > r.left && x < r.right && y > r.bottom && y < r.top) return i;
  }
  return -1;
}

function nearestCell(x, y) {
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) {
    const r = openingRect(i);
    const d = Math.hypot(x - r.cx, y - r.cy);
    if (d < dist) { dist = d; best = i; }
  }
  return best;
}

/** Add a static cuboid and remember what it is. */
function staticBox(world, colliders, kind, size, center, meta = {}) {
  const desc = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
    .setTranslation(center.x, center.y, center.z)
    .setFriction(FRICTION)
    .setRestitution(kind === 'bar' ? BAR_RESTITUTION : RESTITUTION)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  const collider = world.createCollider(desc);
  colliders.set(collider.handle, { kind, ...meta });
  return collider;
}

export function createWorld(opts = {}) {
  if (!ready) throw new Error('initRapier() must be awaited before createWorld()');

  const world = new RAPIER.World(vec(0, -G, 0));
  world.timestep = H;
  // More solver iterations than the default for a clean, firm floor contact.
  world.integrationParameters.numSolverIterations = 8;
  const events = new RAPIER.EventQueue(true);
  const colliders = new Map();
  const barColliders = new Map();
  const sensorCells = new Map();
  const goalRects = Array.from({ length: CELLS_X * CELLS_Y }, (_, i) => openingRect(i));
  const width = ROOM.maxX - ROOM.minX;
  const depth = ROOM.maxZ - ROOM.minZ;
  const midZ = (ROOM.minZ + ROOM.maxZ) / 2;
  const wallT = 0.3;

  // ---------------------------------------------------------------- room
  staticBox(world, colliders, 'floor', { x: width, y: 0.2, z: depth },
    { x: 0, y: FLOOR_Y - 0.1, z: midZ });
  staticBox(world, colliders, 'ceil', { x: width, y: wallT, z: depth },
    { x: 0, y: ROOM.maxY + wallT / 2, z: midZ });
  staticBox(world, colliders, 'left', { x: wallT, y: ROOM.maxY, z: depth },
    { x: ROOM.minX - wallT / 2, y: ROOM.maxY / 2, z: midZ });
  staticBox(world, colliders, 'right', { x: wallT, y: ROOM.maxY, z: depth },
    { x: ROOM.maxX + wallT / 2, y: ROOM.maxY / 2, z: midZ });
  staticBox(world, colliders, 'front', { x: width, y: ROOM.maxY, z: wallT },
    { x: 0, y: ROOM.maxY / 2, z: ROOM.maxZ + wallT / 2 });
  staticBox(world, colliders, 'back', { x: width, y: ROOM.maxY, z: wallT },
    { x: 0, y: ROOM.maxY / 2, z: ROOM.minZ - wallT / 2 });
  // Rear chamber side walls are the same room walls; no extra colliders.

  // ---------------------------------------------------------------- goal
  // Nine bars: six vertical, three horizontal. Each is a static box.
  for (let i = 0; i <= CELLS_X; i += 1) {
    const x = -GOAL_WIDTH / 2 + i * (OPENING + BAR) + BAR / 2;
    const bar = i === 0 ? 'left' : (i === CELLS_X ? 'right' : 'divider-v');
    const c = staticBox(world, colliders, 'bar',
      { x: BAR, y: GOAL_HEIGHT, z: BAR_DEPTH },
      { x, y: GOAL_HEIGHT / 2, z: -BAR_DEPTH / 2 },
      { bar, index: i, orientation: 'vertical' });
    barColliders.set(c.handle, { bar, index: i, orientation: 'vertical' });
  }
  for (let j = 0; j <= CELLS_Y; j += 1) {
    const y = j * (OPENING + BAR) + BAR / 2;
    const bar = j === 0 ? 'bottom' : (j === CELLS_Y ? 'top' : 'divider-h');
    const c = staticBox(world, colliders, 'bar',
      { x: GOAL_WIDTH, y: BAR, z: BAR_DEPTH },
      { x: 0, y, z: -BAR_DEPTH / 2 },
      { bar, index: j, orientation: 'horizontal' });
    barColliders.set(c.handle, { bar, index: j, orientation: 'horizontal' });
  }

  // Ten goal sensors just behind the mouths.
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) {
    const r = goalRects[i];
    const desc = RAPIER.ColliderDesc.cuboid(
      Math.max(0.01, (r.right - r.left) / 2 - 0.02),
      Math.max(0.01, (r.top - r.bottom) / 2 - 0.02),
      0.22,
    )
      .setTranslation(r.cx, r.cy, -0.22)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.INTERSECTION_EVENTS);
    const sensor = world.createCollider(desc);
    sensorCells.set(sensor.handle, i);
    colliders.set(sensor.handle, { kind: 'goal-sensor', cell: i });
  }

  // ---------------------------------------------------------------- ball
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(RESTING.x, RESTING.y, RESTING.z)
    .setLinearDamping(LINEAR_DAMPING)
    .setAngularDamping(ANGULAR_DAMPING)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);
  const ballDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
    .setMass(MASS)
    .setFriction(FRICTION)
    .setRestitution(RESTITUTION)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.INTERSECTION_EVENTS);
  const ballCollider = world.createCollider(ballDesc, body);
  colliders.set(ballCollider.handle, { kind: 'ball' });

  // Boundaries are the Rapier room only: floor, ceiling, walls, goal bars.
  // Viewport crop is a camera rule, not a second collider or custom bounce.

  const w = {
    body,
    time: 0,
    shotId: 0,
    goals: [],
    reds: [],
    lastGoal: null,
    lastBar: null,
    awake: true,
    settle: 0,
    sensorCells: new Set(),
    goalLock: new Set(),
    active: true,
    hand: null, // drag target {x,z} while a finger holds the ball
  };

  function bodyState() {
    const t = body.translation();
    const v = body.linvel();
    const a = body.angvel();
    const q = body.rotation();
    return {
      pos: vec(t.x, t.y, t.z),
      vel: vec(v.x, v.y, v.z),
      spin: vec(a.x, a.y, a.z),
      quat: quat(q),
      supported: t.y <= RESTING.y + 0.004 && Math.abs(v.y) < 0.08,
      time: w.time,
      goals: [...w.goals],
      reds: [...w.reds],
      lastGoal: w.lastGoal ? { ...w.lastGoal } : null,
      lastBar: w.lastBar ? { ...w.lastBar } : null,
      shotId: w.shotId,
      awake: w.awake,
    };
  }

  function state() { return bodyState(); }

  function clearShot() {
    w.goals = [];
    w.reds = [];
    w.lastGoal = null;
    w.lastBar = null;
    w.goalLock.clear();
    w.sensorCells.clear();
    w.settle = 0;
  }

  function hold(init = {}) {
    const t = body.translation();
    const x = Number.isFinite(init.x) ? init.x : t.x;
    const z = Number.isFinite(init.z) ? init.z : t.z;
    const dx = x - t.x;
    const dz = z - t.z;
    body.setTranslation(vec(x, RESTING.y, z), true);
    body.setLinvel(vec(0, 0, 0), true);
    body.setAngvel(vec(0, 0, 0), true);
    // Drag rotates the rigid body by the arc actually travelled.
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-8) {
      const q = body.rotation();
      const angle = dist / BALL_RADIUS;
      const axis = { x: dz / dist, y: 0, z: -dx / dist };
      const s = Math.sin(angle / 2);
      const dq = { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
      const out = {
        x: q.w * dq.x + q.x * dq.w + q.y * dq.z - q.z * dq.y,
        y: q.w * dq.y - q.x * dq.z + q.y * dq.w + q.z * dq.x,
        z: q.w * dq.z + q.x * dq.y - q.y * dq.x + q.z * dq.w,
        w: q.w * dq.w - q.x * dq.x - q.y * dq.y - q.z * dq.z,
      };
      body.setRotation(out, true);
    }
    body.wakeUp();
    w.awake = true;
    w.settle = 0;
    return bodyState();
  }

  /** Pointer drag: the finger is a critically damped spring force on the
   * rigid body. Rapier integrates it every substep; nothing is teleported. */
  function drag(init = {}) {
    const t = body.translation();
    const x = Number.isFinite(init.x) ? Math.max(ROOM.minX + BALL_RADIUS, Math.min(ROOM.maxX - BALL_RADIUS, init.x)) : t.x;
    const z = Number.isFinite(init.z) ? Math.max(ROOM.minZ + BALL_RADIUS, Math.min(ROOM.maxZ - BALL_RADIUS, init.z)) : t.z;
    w.hand = { x, z };
    body.wakeUp();
    w.awake = true;
    w.settle = 0;
    return bodyState();
  }

  function releaseHand() { w.hand = null; }

  function reset(init = {}) {
    w.hand = null;
    const x = Number.isFinite(init.x) ? init.x : RESTING.x;
    const z = Number.isFinite(init.z) ? init.z : RESTING.z;
    body.setTranslation(vec(x, RESTING.y, z), true);
    body.setLinvel(vec(0, 0, 0), true);
    body.setAngvel(vec(0, 0, 0), true);
    body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    body.wakeUp();
    w.time = 0;
    w.shotId = 0;
    w.awake = true;
    w.settle = 0;
    clearShot();
    return bodyState();
  }

  /** Keep the rigid body's current Rapier velocity and spin after a drag. */
  function letRoll() {
    w.hand = null;
    const v = body.linvel();
    const speed = speedOf(v);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      body.setLinvel(vec(v.x * k, v.y * k, v.z * k), true);
    }
    body.wakeUp();
    w.shotId += 1;
    w.awake = true;
    w.settle = 0;
    clearShot();
    return bodyState();
  }

  function launch(l = {}) {
    w.hand = null;
    let vx = Number(l.vx) || 0;
    let vy = Number(l.vy) || 0;
    let vz = Number(l.vz) || 0;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      vx *= k; vy *= k; vz *= k;
    }
    body.setLinvel(vec(vx, vy, vz), true);
    // Rolling-consistent spin from the launch velocity; do not zero ω.
    const planar = Math.hypot(vx, vz);
    if (planar > 1e-8) body.setAngvel(vec(vz / BALL_RADIUS, 0, -vx / BALL_RADIUS), true);
    else body.setAngvel(vec(0, 0, 0), true);
    w.shotId += 1;
    body.wakeUp();
    w.awake = true;
    w.settle = 0;
    clearShot();
    return bodyState();
  }

  function emitGoal(cell) {
    if (w.goalLock.has(cell)) return;
    w.goalLock.add(cell);
    w.goals.push(cell);
    w.lastGoal = { cell, t: w.time };
    w.reds = w.reds.filter((c) => c !== cell);
    eventsList.push({ type: 'goal', cell, t: w.time, point: { ...bodyState().pos } });
  }

  function wholeBallInside(cell, p) {
    const r = goalRects[cell];
    return p.x > r.left + BALL_RADIUS && p.x < r.right - BALL_RADIUS
      && p.y > r.bottom + BALL_RADIUS && p.y < r.top - BALL_RADIUS;
  }

  function barInfoFor(handle) {
    return barColliders.get(handle) ?? null;
  }

  function barCellFor(info, p) {
    if (!info) return nearestCell(p.x, p.y);
    if (info.orientation === 'vertical') {
      const near = nearestCell(p.x, p.y);
      return p.x < info.index * (OPENING + BAR) - GOAL_WIDTH / 2 + BAR
        ? near : nearestCell(p.x, p.y);
    }
    return nearestCell(p.x, p.y);
  }

  let eventsList = [];

  function drainEvents() {
    events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = colliders.get(h1);
      const b = colliders.get(h2);
      if (!a || !b) return;
      const ball = a.kind === 'ball' ? b : (b.kind === 'ball' ? a : null);
      if (!ball) return;
      if (ball.kind === 'goal-sensor' && Number.isInteger(ball.cell)) {
        w.sensorCells.add(ball.cell);
        return;
      }
      const p = bodyState().pos;
      const speed = speedOf(bodyState().vel);
      if (ball.kind === 'bar' && speed > 0.8 && w.goals.length === 0) {
        const info = barInfoFor(a.kind === 'bar' ? h1 : h2);
        if (!info) return;
        const cell = nearestCell(p.x, p.y);
        if (w.reds.includes(cell)) return;
        w.reds.push(cell);
        const r = goalRects[cell];
        const rect = info.orientation === 'vertical'
          ? { minX: p.x - BAR / 2, maxX: p.x + BAR / 2, minY: r.bottom, maxY: r.top }
          : { minX: r.left, maxX: r.right, minY: p.y - BAR / 2, maxY: p.y + BAR / 2 };
        w.lastBar = { cell, bar: info.bar, t: w.time, speed };
        eventsList.push({
          type: 'bar', cell, bar: info.bar, barRect: rect,
          point: { ...p }, speed, normal: { x: 0, y: 0, z: 0 },
        });
      } else if (ball.kind === 'floor' && speed > 0.5) {
        eventsList.push({ type: 'floor', speed, point: { ...p }, normal: { x: 0, y: 1, z: 0 } });
      } else if (ball.kind !== 'ball' && ball.kind !== 'goal-sensor' && speed > 0.5) {
        eventsList.push({ type: 'wall', kind: ball.kind, speed, point: { ...p }, normal: { x: 0, y: 0, z: 0 } });
      }
    });
  }

  /** Real forces on the one rigid body: air drag, rolling resistance, hand. */
  function applyForces() {
    body.resetForces(true);
    const v = body.linvel();
    const p = body.translation();
    const speed = speedOf(v);
    let fx = 0; let fy = 0; let fz = 0;
    if (speed > 1e-6) {
      fx -= DRAG_C * speed * v.x;
      fy -= DRAG_C * speed * v.y;
      fz -= DRAG_C * speed * v.z;
    }
    const onFloor = p.y <= RESTING.y + 0.003 && Math.abs(v.y) < 0.15;
    const planar = Math.hypot(v.x, v.z);
    if (onFloor && planar > 1e-4) {
      const f = ROLL_MU * MASS * G;
      fx -= f * v.x / planar;
      fz -= f * v.z / planar;
    }
    if (w.hand) {
      const k = MASS * HAND_OMEGA * HAND_OMEGA;
      const c = 2 * MASS * HAND_OMEGA;
      fx += k * (w.hand.x - p.x) - c * v.x;
      fz += k * (w.hand.z - p.z) - c * v.z;
    }
    if (fx || fy || fz) body.addForce(vec(fx, fy, fz), true);
  }

  function step(dt = H) {
    eventsList = [];
    let remaining = Math.max(0, Math.min(0.25, dt));
    let iterations = 0;
    while (remaining > 1e-9 && iterations < 8) {
      const h = Math.min(H, remaining);
      const before = body.translation();
      const beforeZ = before.z;
      applyForces();
      world.timestep = h;
      world.step(events);
      w.time += h;
      remaining -= h;
      iterations += 1;
      const p = body.translation();
      const v = body.linvel();
      // Goal: whole sphere inside one opening and the centre crossed z=0.
      if (p.z <= 0) {
        const cell = openingAt(p.x, p.y);
        // The Rapier sensor behind the aperture confirms the whole sphere
        // entered that cell; the centre check rejects a partial edge pass.
        if (cell >= 0 && w.sensorCells.has(cell) && wholeBallInside(cell, p)) emitGoal(cell);
      }
      // A slow ball on the floor settles; Rapier can keep micro-jittering.
      const speed = speedOf(v);
      const onFloor = p.y <= RESTING.y + 0.005 && Math.abs(v.y) < 0.1;
      if (!w.hand && onFloor && speed < 0.06) w.settle += h;
      else w.settle = 0;
      if (w.settle > 0.35 && w.awake) {
        body.setLinvel(vec(0, 0, 0), true);
        body.setAngvel(vec(0, 0, 0), true);
        body.sleep();
        w.awake = false;
        eventsList.push({ type: 'settled', pos: { ...p } });
      }
    }
    // Events are emitted after integration so collision callbacks see final
    // positions. Drain after the loop; callbacks push into eventsList.
    drainEvents();
    if (!w.awake) return eventsList;
    w.awake = !body.isSleeping();
    return eventsList;
  }

  return {
    world,
    body,
    radius: BALL_RADIUS,
    mass: MASS,
    friction: FRICTION,
    get time() { return w.time; },
    get shotId() { return w.shotId; },
    get awake() { return w.awake; },
    state,
    step,
    hold,
    drag,
    letRoll,
    releaseHand,
    reset,
    launch,
    /** Test/debug: place at a point without changing shot bookkeeping. */
    place(init) { return hold(init); },
    /** Test/debug: current event list (last step). */
    get events() { return eventsList; },
  };
}
