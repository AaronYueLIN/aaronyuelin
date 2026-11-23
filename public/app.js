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

import { createScene, supportsWebGL2 } from './scene.js?v=2026.11.23-r10';
import { createBall } from './ball.js?v=2026.11.23-r10';
import { createInteraction } from './interaction.js?v=2026.11.23-r10';
import { createWorld, initRapier, H, BALL_RADIUS, GOAL, ROOM, openingRect } from './physics-rapier.js?v=2026.11.23-r10';
import { CHILD_ROUTE, RESTING, SHOT } from './config.js?v=2026.11.23-r10';
import { defaultAimPoint, launchFromAim } from './shot.js?v=2026.11.23-r10';
import { afterFirstPaint } from './texture-infra.js?v=2026.11.23-r10';
import { createSimXgClient, renderScoreboardGlyphs } from './sim-xg-client.js?v=2026.11.23-r10';
import { isPhoneViewport } from './sim-xg.js?v=2026.11.23-r10';

const play = document.querySelector('[data-play]');
const host = play?.querySelector('[data-scene]');
const canvas = play?.querySelector('[data-canvas]');
const goalEl = play?.querySelector('[data-goal]');
// DOM order is visual (top row first); the stable index is row 0 = bottom.
const cells = play
  ? [...play.querySelectorAll('[data-cell]')].sort((a, b) => Number(a.dataset.cell) - Number(b.dataset.cell))
  : [];
const statusEl = play?.querySelector('[data-status]');
const replayButton = document.querySelector('[data-guide-replay]');
const scoreboardEl = play?.querySelector('[data-sim-xg]');
const replayControl = window.__homepageReplay ??= { serial: 0, pending: false, navigating: false, run: null };

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
  let lightGuide = null;
  let manualReplayToken = 0;
  let manualReplayPending = false;
  // Sticky: real input/feedback cancels an in-flight optional guide import.
  let lightGuideCancelled = false;
  // Pre-load holds/launches must not consume the intro or write the seen flag.
  // Stand-down is armed only when the visible scene is ready and start is attempted.
  let lightGuideCancellable = false;
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
    // Place the only xG display in the white gap above the pitch, not the top
    // icon row. Set geometry on the readout itself, never on a sibling.
    const board = scoreboardEl;
    if (board) {
      const width = window.innerWidth || host.clientWidth;
      const height = window.innerHeight || host.clientHeight;
      const boardWidth = 0.92 * Math.min(260, Math.max(176, g.width * 0.55), Math.max(128, width - 144));
      const boardHeight = boardWidth * 224 / 640;
      const centerX = Math.max(boardWidth / 2 + 72, Math.min(width - boardWidth / 2 - 72, g.left + g.width / 2));
      const centerY = Math.max(boardHeight / 2 + 8, Math.min(height * 0.305, g.top - boardHeight / 2 - 12 - height * 0.017));
      board.style.setProperty('--scoreboard-width', `${boardWidth.toFixed(2)}px`);
      board.style.setProperty('--scoreboard-left', `${centerX.toFixed(2)}px`);
      board.style.setProperty('--scoreboard-top', `${centerY.toFixed(2)}px`);
    }
    viewMetres = g.pxPerMetre;
    updateFormFactor();
    return g;
  }

  /** Same portrait test as camera.js (aspect < 1). Desktop composition is unchanged. */
  function updateFormFactor() {
    const box = host.getBoundingClientRect();
    const w = box.width || host.clientWidth || window.innerWidth || 1;
    const h = box.height || host.clientHeight || window.innerHeight || 1;
    play.dataset.form = isPhoneViewport(w, h) ? 'phone' : 'desktop';
  }

  function layoutGoal() {
    syncGoalLayout();
    placeFallback();
    simXg?.tick();
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

  function standDownLightGuide() {
    if (!lightGuideCancellable) return;
    lightGuideCancelled = true;
    manualReplayToken += 1;
    manualReplayPending = false;
    replayControl.pending = false;
    lightGuide?.interrupt();
    syncReplayButton();
  }

  function clearLights() {
    standDownLightGuide();
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
      replayControl.navigating = true;
      syncReplayButton();
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
    syncReplayButton();
  }

  /** Physics → visible state. Only real events light anything. */
  function onPhysics(ev) {
    // Stand down BEFORE real light feedback and any downstream estimator tick.
    if (ev.type === 'goal' || ev.type === 'bar') standDownLightGuide();
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
      // The existing explicit R/reset already reset physics. Refresh the view
      // immediately instead of retaining a pre-reset/offscreen snapshot.
      prev = cur = world.state();
      alpha = 1;
      acc = 0;
      last = 0;
      setPhase('idle');
      present();
      schedule();
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
  let simXg = null;
  // interaction.mount() emits one synthetic onHold to position the ball. That
  // is NOT user input and must not permanently cancel the first-visit guide.
  let interactionMounted = false;
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
      if (interactionMounted) standDownLightGuide();
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
      simXg?.tick();
    },
    onReset: onPhysics,
    onCancel: () => {
      setPhase(shotOpening >= 0 ? 'hit' : 'idle');
    },
    status: say,
    rest: RESTING,
  });

  // Phone-only simulated goal probability. Created after interaction so it
  // can read phase/aim/charge, but it does no work until the ball is ready
  // and the player is aiming. It never steps the playable Rapier world.
  simXg = createSimXgClient({ play, host, world, interaction });

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
    simXg?.tick();
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
    simXg?.tick();
  }

  /**
   * Arm the optional first-visit light guide only after the playable scene
   * (room and ball) has been drawn. The module is loaded with a dynamic
   * import so it adds no request to first paint, and it does no work for a
   * visitor who already watched it. The scene must expose setGuide();
   * without it the guide is skipped entirely. Skipped or pre-load-cancelled
   * starts do not write the watched flag.
   */
  async function startLightGuide() {
    if (!scene?.setGuide) return;
    // Scene is on screen: later real input may interrupt. Input that happened
    // only while assets were still loading did not set lightGuideCancelled.
    lightGuideCancellable = true;
    const phase = interaction?.phase;
    if (lightGuideCancelled || (phase && phase !== 'idle')) return;
    try {
      const mod = await import('./goal-light-guide.js?v=2026.11.23-r10');
      // A real hold/goal/bar/reset can land during the import. At this point
      // there is still no controller, so the sticky flag is the priority
      // guard: do not create or start anything over live feedback.
      const phaseAfter = interaction?.phase;
      if (lightGuideCancelled || (phaseAfter && phaseAfter !== 'idle')) return;
      lightGuide = await mod.startGoalLightGuideWhenReady({
        load: async () => mod,
        isCancelled: () => lightGuideCancelled,
        ...guidePresentation(),
      });
    } catch (error) {
      errors.push(`guide: ${error?.message ?? error}`);
    }
  }

  function guidePresentation() {
    return {
      setLights: (state, level) => scene?.setGuide?.(state, level),
      reduceMotion,
      onStart: () => simXg?.beginGuideMessage?.('Pull ball to kick', reduceMotion()),
      onFrame: (elapsed) => simXg?.updateGuideMessage?.(elapsed),
      onFinish: () => simXg?.endGuideMessage?.(),
    };
  }

  function replaySceneReady() {
    return Boolean(scene?.setGuide && play.dataset.room === 'glb'
      && play.dataset.ball === 'ready' && scene.mode === 'glb');
  }

  function syncReplayButton() {
    if (!replayButton) return;
    replayButton.disabled = replayControl.navigating;
    replayButton.title = replayControl.navigating ? 'Leaving the homepage'
      : (play.dataset.room === 'failed' || play.dataset.ball === 'error') ? 'Replay queued: the textured scene is unavailable'
        : replayControl.pending && !replaySceneReady() ? 'Replay queued until the textured scene is ready'
          : 'Replay the goal-frame light show';
  }

  async function replayLightGuide() {
    if (replayControl.navigating || !replayControl.pending) return;
    if (!replaySceneReady()) { syncReplayButton(); return; }
    lightGuideCancellable = true;
    lightGuideCancelled = true;
    const token = ++manualReplayToken;
    const serial = replayControl.serial;
    lightGuide?.interrupt();
    manualReplayPending = true;
    syncReplayButton();
    try {
      const mod = await import('./goal-light-guide.js?v=2026.11.23-r10');
      if (token !== manualReplayToken || serial !== replayControl.serial || replayControl.navigating) return;
      if (!replaySceneReady()) return;
      replayControl.pending = false;
      lightGuide = mod.createGoalLightGuide({ manual: true, ...guidePresentation() });
      lightGuide.start();
    } catch (error) {
      errors.push(`guide replay: ${error?.message ?? error}`);
      say('The light show is unavailable.');
    } finally {
      if (token === manualReplayToken) manualReplayPending = false;
      syncReplayButton();
    }
  }

  replayControl.run = () => { void replayLightGuide(); };
  if (replayControl.pending) void replayLightGuide();

  interaction.mount();
  interactionMounted = true;
  layoutGoal();
  scene?.onLayout(() => {
    layoutGoal();
    syncReplayButton();
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
  window.__simXg = () => simXg?.inspect?.() ?? null;
  function attachSimXg() {
    if (simXg?.isDisposed?.()) simXg = null;
    if (!simXg) simXg = createSimXgClient({ play, host, world, interaction });
    return simXg;
  }
  window.addEventListener('pagehide', (event) => {
    replayControl.navigating = true;
    lightGuide?.interrupt();
    syncReplayButton();
    if (event.persisted) {
      simXg?.suspend?.();
      return;
    }
    simXg?.dispose?.();
  });
  window.addEventListener('pageshow', (event) => {
    replayControl.navigating = false;
    syncReplayButton();
    if (event.persisted || simXg?.isDisposed?.()) {
      attachSimXg();
      simXg?.resume?.();
      simXg?.tick();
    }
  });

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
    syncReplayButton();
  } catch (error) {
    errors.push(`room: ${error?.message ?? error}`);
    play.dataset.room = 'failed';
  }

  try {
    await scene.loadModel();
    play.dataset.mode = 'glb';
    play.dataset.ball = 'ready';
    syncReplayButton();
    simXg?.tick();
    play.dataset.textureTier = globalThis.__textureInfra?.tier ?? play.dataset.textureTier ?? '';
    // Re-bind only the view to the current real state after async publication.
    // A cosmetic replay never changes or resets the Rapier body.
    prev = cur = world.state();
    alpha = 1;
    ball?.sync(cur, cur, 1, H);
    // Textures are decoded/uploaded and the shader is compiled inside
    // loadModel(); draw the complete textured frame immediately instead of
    // waiting for a rAF that may never run while the physics is at rest.
    scene.draw();
    scene.invalidate();
    // Early clicks remain pending through decoding/compilation; latest click wins.
    if (replayControl.pending) void replayLightGuide();
  } catch (error) {
    errors.push(`ball: ${error?.message ?? error}`);
    play.dataset.mode = 'error';
    play.dataset.ball = 'error';
    syncReplayButton();
    simXg?.tick();
    console.error('[ball] not shown: textured Blender GLB failed', error);
  }

  // Intro starts only once the visible scene has painted. It is unawaited
  // so football-ready is not blocked. Pre-load input did not consume it.
  if (play.dataset.room === 'glb') {
    await afterFirstPaint();
    void startLightGuide();
  }
  window.dispatchEvent(new Event('football-ready'));
}

boot().catch((error) => {
  const xgValue = play?.querySelector('[data-sim-xg-value]');
  const xgSr = play?.querySelector('[data-sim-xg-sr]');
  if (xgValue) { delete xgValue.dataset.value; renderScoreboardGlyphs(xgValue, '--'); }
  if (xgSr) xgSr.textContent = 'Simulated goal probability is unavailable because game initialization failed.';
  console.warn('[football] startup failed', error);
  if (!play) return;
  play.dataset.state = 'idle';
  play.dataset.mode = 'error';
  play.dataset.ball = 'error';
});
