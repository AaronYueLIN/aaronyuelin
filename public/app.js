/**
 * Entry point: the one place where physics, view and input meet.
 *
 *   physics.js      fixed-step swept-sphere world — the only owner of position
 *   scene.js        one canvas: camera, real goal lattice, real floor shadow
 *   ball.js         mesh pose from the interpolated physics state
 *   interaction.js  pointer / keyboard → placement or launch velocity only
 *   (this file)     the loop, physics-event → DOM state, observability hooks
 *
 * Physics runs on fixed 1/120 s steps from performance.now() deltas. The
 * loop is a setTimeout pump, not the renderer's rAF: hidden frames drop
 * simulation time (bounded by MAX_FRAME), and stopping rendering can never
 * freeze the ball. Rendering interpolates between the two latest physics
 * states (never extrapolates). Red/green are assigned to the Blender 3D light
 * bars; DOM cells keep only an accessibility/state record. A goal is shown
 * once per trajectory.
 */

import { createScene, supportsWebGL2 } from './scene.js';
import { createBall } from './ball.js';
import { createInteraction } from './interaction.js';
import { createWorld, initRapier, H, BALL_RADIUS, GOAL, ROOM, openingRect } from './physics-rapier.js';
import { CHILD_ROUTE, RESTING, SHOT } from './config.js';
import { defaultAimPoint, launchFromAim } from './shot.js';
import { afterFirstPaint } from './texture-infra.js';

const play = document.querySelector('[data-play]');
const host = play?.querySelector('[data-scene]');
const canvas = play?.querySelector('[data-canvas]');
const goalEl = play?.querySelector('[data-goal]');
// DOM order is visual (top row first); the stable index is row 0 = bottom.
const cells = play
  ? [...play.querySelectorAll('[data-cell]')].sort((a, b) => Number(a.dataset.cell) - Number(b.dataset.cell))
  : [];
const statusEl = play?.querySelector('[data-status]');

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduceMotion = () => motionQuery.matches;

/**
 * After a real goal the cell lights green, the camera follows the real ball,
 * and the page transitions to that cell's stable child route. The short hold
 * lets the green and the follow be seen; it never decides the outcome.
 */
const GOAL_HOLD_MS = reduceMotion() ? 480 : 1000;

async function boot() {
  if (!play || !host || !canvas || !goalEl) return;

  // The site always adds the visible-frame boundary (first layer) on top of
  // the pure room physics (second layer). The tests can create a room-only
  // world to verify the room contract independently.
  await initRapier();
  const world = createWorld({ viewport: true });
  const events = [];
  const errors = [];
  let stepCount = 0;
  let frameCount = 0;
  let prev = world.state();
  let cur = prev;
  let alpha = 1;
  let shotOpening = -1; // the first real goal crossed by the current shot
  let redCells = [];
  let barCell = -1; // last bar hit of the current shot (its red)
  let settlePhase = 'idle';
  let rendering = false;
  let followOpening = -1; // once the ball is really through, the camera follows it
  let navigationEnabled = true;
  let navTimer = 0;
  let navTarget = null;

  // ------------------------------------------------------------ scene
  let scene = null;
  let ball = null;
  let rendererMode = 'png';
  const webgl = supportsWebGL2();
  if (webgl) {
    try {
      scene = createScene({ canvas, host });
      rendererMode = 'webgl';
    } catch (error) {
      errors.push(String(error?.message ?? error));
      scene = null;
    }
  }

  // ------------------------------------------------------------ goal DOM
  /**
   * Keep the DOM overlay on the same projection as the 3D lattice. Called
   * after every rendered frame because the follow camera pans the goal; a
   * resize-only update would leave the overlay behind the real frame.
   */
  function syncGoalLayout() {
    const g = interaction?.goalLayout ? interaction.goalLayout() : scene.goalGeometry();
    goalEl.style.setProperty('--goal-x', `${g.left.toFixed(2)}px`);
    goalEl.style.setProperty('--goal-y', `${g.top.toFixed(2)}px`);
    goalEl.style.setProperty('--goal-w', `${g.width.toFixed(2)}px`);
    goalEl.style.setProperty('--goal-h', `${g.height.toFixed(2)}px`);
    goalEl.style.setProperty('--bar-w', `${g.barPx.toFixed(2)}px`);
    viewMetres = g.pxPerMetre;
    return g;
  }

  function layoutGoal() {
    syncGoalLayout();
    placeFallback();
  }
  let viewMetres = 120; // CSS px per metre at the ball plane

  /** A rough projection for the no-WebGL path, mirroring the camera layout. */
  function cssProject(p) {
    if (scene) return scene.project(p);
    const box = goalEl.getBoundingClientRect();
    const parent = play.getBoundingClientRect();
    const px = box.width / GOAL.width;
    const py = box.height / GOAL.height;
    return {
      x: box.left - parent.left + (p.x + GOAL.width / 2) * px,
      y: box.top - parent.top + (GOAL.height - p.y) * py + (RESTING.z - p.z) * px * 0.14,
    };
  }
  function placeFallback() {
    // Intentionally empty. The textured Blender GLB is the only ball; if it
    // cannot load there is no visible substitute (see ball-view.js).
  }

  // ------------------------------------------------------------ lights
  function cancelNavigation() {
    window.clearTimeout(navTimer);
    navTimer = 0;
    navTarget = null;
  }

  function clearLights() {
    cancelNavigation();
    shotOpening = -1;
    followOpening = -1;
    delete play.dataset.follow;
    if (scene) scene.setFollow('', 0);
    redCells = [];
    barCell = -1;
    for (const c of cells) {
      delete c.dataset.lit;
      delete c.dataset.bar;
    }
    scene?.setLights(-1, null);
    delete play.dataset.shot;
  }

  /**
   * The only page transition: a real whole-ball aperture crossing. The cell
   * is already green from the physics event; the route is stable per id
   * (`target/<cell+1>/`) and owned by perf-infra. Tests can disable the
   * actual navigation while still checking the target, so the trajectory and
   * lighting can be observed after a goal.
   */
  function scheduleChildPage(cell) {
    cancelNavigation();
    navTarget = CHILD_ROUTE.path(cell);
    play.dataset.shot = 'goal';
    navTimer = window.setTimeout(() => {
      navTimer = 0;
      if (!navigationEnabled) return;
      window.location.assign(navTarget);
    }, GOAL_HOLD_MS);
  }

  /**
   * Which bar of an opening was struck, from the physics event's real bar
   * rectangle. Used to light exactly one 3D lens on that bar/post.
   */
  function barEdgeFor(ev) {
    if (!ev?.barRect) return null;
    const cell = openingRect(ev.cell);
    const r = ev.barRect;
    const horizontal = (r.maxY - r.minY) <= GOAL.bar * 1.5;
    if (horizontal) return r.maxY <= cell.bottom + 1e-6 ? 'bottom' : 'top';
    return r.maxX <= cell.left + 1e-6 ? 'left' : 'right';
  }

  /** Paint one opening state on the real Blender light bars. */
  function lightCell(cell, state, edge = null) {
    if (cells[cell]) {
      cells[cell].dataset.lit = state;
      if (state === 'red' && edge) cells[cell].dataset.bar = edge;
      else delete cells[cell].dataset.bar;
    }
    // Only a real pass lights a whole cell. A bar hit lights one bar/post;
    // filling the opening red would read as a goal.
    scene?.setLights(cell, state, state === 'red' ? edge : null);
  }

  // The game view has NO visible text: status messages go to the live region
  // (screen readers only) and to the event log. They are never shown, never
  // used for instructions, and never read back by input.
  const STATUS_HOLD_MS = 1500;
  let sayTimer = 0;
  let saySeq = 0;
  function say(text) {
    if (!statusEl) return;
    saySeq += 1;
    const seq = saySeq;
    const message = String(text ?? '');
    window.clearTimeout(sayTimer);
    statusEl.textContent = ''; // let assistive tech see a fresh message
    sayTimer = window.setTimeout(() => {
      if (seq !== saySeq) return;
      statusEl.textContent = message;
      sayTimer = window.setTimeout(() => {
        if (seq === saySeq) statusEl.textContent = '';
      }, STATUS_HOLD_MS);
    }, reduceMotion() ? 0 : 30);
  }

  function setPhase(phase) {
    play.dataset.state = phase;
  }

  /** Physics → visible state. Only real events light anything. */
  function onPhysics(ev) {
    events.push({ t: Math.round(world.time * 1000) / 1000, ...ev });
    if (events.length > 200) events.shift();
    if (ev.type === 'goal') {
      if (shotOpening < 0) {
        shotOpening = ev.cell;
        // A successful pass supersedes the transient red bar feedback: show
        // the green aperture cleanly, then transition to its child page.
        for (const c of redCells) delete cells[c].dataset.lit;
        redCells = [];
        barCell = -1;
            lightCell(ev.cell, 'green');
        // The camera follows the actual trajectory from here on (below). The
        // DOM overlay is a crisp front view; fade it during the follow so the
        // real 3D goal and the ball behind it are visible.
        followOpening = ev.cell;
        play.dataset.follow = 'true';
        setPhase('hit');
        scheduleChildPage(ev.cell);
        say(`Goal in opening ${ev.cell + 1}. Opening it.`);
      }
    } else if (ev.type === 'bar') {
      if (shotOpening < 0 && !redCells.includes(ev.cell)) {
        redCells.push(ev.cell);
        barCell = ev.cell;
        lightCell(ev.cell, 'red', barEdgeFor(ev));
        setPhase('bar');
        say(`Bar at opening ${ev.cell + 1}. The ball rebounded.`);
      }
    } else if (ev.type === 'settled') {
      if (!world.awake) {
        rendering = false;
        scene?.stopLoop();
        present();
      }
      if (shotOpening < 0) {
        settlePhase = 'settled';
        setPhase('settled');
        say('The ball came to rest. Press and hold it to shoot again.');
      }
    } else if (ev.type === 'reset') {
      clearLights();
      setPhase('idle');
      say('Ball reset.');
    }
    interaction?.onPhysicsEvent(ev);
  }

  // ------------------------------------------------------------ physics
  let acc = 0;
  let last = 0;
  /** Longest wall-clock slice admitted to the simulator, seconds (15 Hz). The
   *  fixed 1/120 s substeps below make 60 Hz and 120 Hz identical; the cap only
   *  prevents a suspended tab from replaying a huge backlog. */
  const MAX_FRAME = 1 / 15;

  function advance(dt) {
    if (!world.awake) return;
    prev = cur;
    const list = world.step(dt);
    stepCount += 1;
    cur = world.state();
    for (const ev of list) onPhysics(ev);
    // The camera stays fixed on the near face. The follow flag only fades the
    // DOM goal during the green hold; it never moves the real camera.
    if (followOpening >= 0) {
      scene?.setFollow(`shot-${cur.shotId}-cell-${followOpening}`, Math.max(0, cur.time - (cur.lastGoal?.t ?? cur.time)));
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    } else if (world.awake) {
      last = 0;
      schedule();
    }
  });

  // Simulation and rendering are separate:
  //   • the fixed-step pump runs on a short timer (independent of rAF, so a
  //     hidden or stopped renderer cannot freeze the physics);
  //   • the renderer's rAF loop interpolates between the last two physics
  //     states and paints; it never advances physics.
  let timer = 0;
  function schedule() {
    if (timer || document.hidden || !world.awake) return;
    timer = window.setTimeout(() => {
      timer = 0;
      pump();
    }, 4);
  }

  function pump() {
    const now = performance.now();
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    acc += dt;
    let n = 0;
    while (acc >= H && n < 30) {
      advance(H);
      acc -= H;
      n += 1;
    }
    if (n === 30) acc = 0;
    alpha = Math.max(0, Math.min(1, acc / H));
    kickRender();
    if (world.awake) schedule();
  }

  // placement while idle: keep the visual ball where physics holds it
  function onWorldHeld() {
    prev = world.state();
    cur = prev;
    alpha = 1;
    interaction?.syncHandle();
    present();
    // Let Rapier integrate the drag velocity while the finger is moving.
    schedule();
  }

  let interaction = null;
  const view = () => (scene ? scene.view : { pxPerMetre: viewMetres, width: host.clientWidth, height: host.clientHeight });

  interaction = createInteraction({
    play,
    world,
    scene: scene ?? null,
    view,
    project: cssProject,
    projectBall: scene ? (p) => scene.projectBall(p) : cssProject,
    unproject: scene ? (x, y) => scene.unproject(x, y, 0) : null,
    unprojectFloor: scene ? (x, y) => scene.unprojectFloor(x, y) : null,
    reduceMotion,
    onHold: () => {
      onWorldHeld();
      scene?.invalidate();
    },
    onLaunch: () => {
      clearLights();
      prev = cur = world.state();
      alpha = 1;
      last = 0;
      acc = 0;
      setPhase('flying');
      schedule();
    },
    onReset: onPhysics,
    onCancel: () => {
      setPhase(shotOpening >= 0 ? 'hit' : 'idle');
    },
    status: say,
    rest: RESTING,
  });

  // ---------------------------------------------------------- rendering
  if (scene) {
    ball = createBall({ scene, reduceMotion });
  }
  // The render loop: interpolate the two latest physics states, then paint.
  // Rendering is a rAF loop that only reads the two latest physics states.
  // The simulation timer calls kickRender() after each pump: a stopped or
  // hidden renderer never blocks physics, and the ball always has a live frame.
  function drawFrame() {
    frameCount += 1;
    if (!scene) return false;
    const dt = Math.min(0.05, Math.max(0, (cur.time ?? 0) - (prev.time ?? 0))) || H;
    ball?.sync(cur, cur, 1, dt);
    scene.draw();
    syncGoalLayout();
    interaction?.syncHandle();
    return world.awake; // loop only while the simulation is live
  }
  function kickRender() {
    if (!scene || rendering) return;
    // A fresh loop per flight: stop whatever frame was pending on demand
    // rendering, then drive frames while the simulation is live.
    if (scene.isLooping?.()) return;
    rendering = true;
    scene.startLoop(() => {
      const more = drawFrame();
      if (!more) rendering = false;
      return more;
    });
  }

  /** One-shot paint (rest, a resize, a placement): no loop, just a frame. */
  function present() {
    if (scene) {
      const dt = Math.min(0.05, Math.max(0, (cur.time ?? 0) - (prev.time ?? 0))) || H;
      ball?.sync(cur, cur, 1, dt);
      scene.invalidate();
    }
    interaction?.syncHandle();
  }

  interaction.mount();
  layoutGoal();
  scene?.onLayout(() => {
    layoutGoal();
    present();
  });
  window.addEventListener('resize', layoutGoal);
  cur = world.state();
  prev = cur;
  present();

  // ------------------------------------------------------------ hooks
  const api = {
    events,
    get state() {
      return {
        phase: play.dataset.state,
        renderer: rendererMode,
        mode: scene ? scene.mode : 'png',
        glbLoaded: scene ? scene.mode === 'glb' : false,
        ball: { ...cur.pos, yFloorVisible: BALL_RADIUS },
        cells: cells.map((c, i) => ({
          index: i,
          lit: c.dataset.lit ?? 'none',
          bar: c.dataset.bar ?? null,
        })),
        roomMode: scene ? scene.roomMode : 'none',
        roomLoaded: scene ? scene.roomMode === 'glb' : false,
        textureTier: globalThis.__textureInfra?.tier ?? null,
        textureTierReason: globalThis.__textureInfra?.reason ?? null,
        goals: [...cur.goals],
        reds: [...cur.reds],
        shotId: cur.shotId,
        stepCount,
        frameCount,

        interpolationAlpha: alpha,
        settled: !world.awake,
        lit: shotOpening >= 0 ? shotOpening : (barCell >= 0 ? barCell : null),
        following: followOpening >= 0,
        target: navTarget ?? (shotOpening >= 0 ? CHILD_ROUTE.path(shotOpening) : null),
        navigation: {
          enabled: navigationEnabled,
          pending: navTimer > 0,
          delayMs: GOAL_HOLD_MS,
        },
        geometry: {
          goalWidth: GOAL.width,
          goalHeight: GOAL.height,
          bar: GOAL.bar,
          opening: GOAL.opening,
          room: { ...ROOM },
        },
        charge: interaction?.charge ?? 0,
        releaseSpeed: interaction?.releaseSpeed ?? 0,
        aim: interaction?.aim ?? null,
        pointer: interaction?.pointer ?? null,
        reducedMotion: reduceMotion(),
        errors: [...errors],
      };
    },
    debug: {
      step(seconds) {
        const n = Math.round(seconds / H);
        for (let i = 0; i < n; i += 1) advance(H);
        alpha = 1;
        if (scene) ball?.sync(prev, cur, 1, H);
        return api.state;
      },
      launch(v) {
        world.launch(v);
        clearLights();
        prev = cur = world.state();
        setPhase('flying');
        schedule();
      },
      /**
       * Deterministic real launch at a cell centre using the same pure shot
       * model as the player gesture. Tests use it to cover every opening
       * without synthesising pointer timing; physics still decides the event.
       */
      shootAtCell(cell = SHOT.defaultAimCell, charge = 1) {
        const aim = defaultAimPoint(cell);
        const velocity = launchFromAim(world.state().pos, aim, charge);
        if (!velocity) return null;
        interaction?.reset?.();
        world.launch(velocity);
        clearLights();
        prev = cur = world.state();
        setPhase('flying');
        schedule();
        return velocity;
      },
      setNavigation(enabled) {
        navigationEnabled = Boolean(enabled);
        if (!navigationEnabled) cancelNavigation();
        return navigationEnabled;
      },
      state: () => api.state,
      project: (p) => cssProject(p),
      unproject: (x, y, z = 0) => (scene ? scene.unproject(x, y, z) : null),
      worldState: () => world.state(),
      draw: () => { if (!scene) return false; ball?.sync(prev, cur, 1, H); scene.draw(); syncGoalLayout(); interaction?.syncHandle(); return true; },
      lights: () => (scene ? {
        follow: play.dataset.follow ?? null,
        faces: scene.faces.map((f) => ({ visible: f.visible, color: f.material.color.getHexString() })),
      } : null),
      /** Diagnostic hook for the light-bar proof; real events still drive play. */
      setLights: (cell, state, edge = null) => {
        scene?.setLights(cell, state, edge);
        return scene ? { cell, state, edge } : null;
      },
      cell: (k = 0) => openingRect(k),
      shot: () => ({ charge: interaction?.charge ?? 0, aim: interaction?.aim ?? null }),
    },
    reset: () => interaction.reset(),
  };
  window.__prototype = api;
  play.dataset.renderer = rendererMode;
  play.dataset.mode = scene ? 'loading' : 'error';
  play.dataset.ball = 'loading';
  setPhase('idle');
  layoutGoal();

  if (!scene) return;

  try {
    await scene.loadRoom();
    play.dataset.room = 'glb';
    play.dataset.textureTier = globalThis.__textureInfra?.tier ?? '';
    // Compose the real room before starting the (possibly 4K) ball download.
    // The homepage paints immediately; the ball never blocks the room.
    scene.draw();
    await afterFirstPaint();
  } catch (error) {
    errors.push(`room: ${error?.message ?? error}`);
    play.dataset.room = 'failed';
  }

  try {
    await scene.loadModel();
    play.dataset.mode = 'glb';
    play.dataset.ball = 'ready';
    play.dataset.textureTier = globalThis.__textureInfra?.tier ?? play.dataset.textureTier ?? '';
    // Textures are decoded/uploaded and the shader is compiled inside
    // loadModel(); draw the complete textured frame immediately instead of
    // waiting for a rAF that may never run while the physics is at rest.
    scene.draw();
    scene.invalidate();
  } catch (error) {
    errors.push(`ball: ${error?.message ?? error}`);
    play.dataset.mode = 'error';
    play.dataset.ball = 'error';
    console.error('[ball] not shown: textured Blender GLB failed', error);
  }
  window.dispatchEvent(new Event('football-ready'));
}

boot().catch((error) => {
  console.warn('[football] startup failed', error);
  if (!play) return;
  play.dataset.state = 'idle';
  play.dataset.mode = 'error';
  play.dataset.ball = 'error';
});
