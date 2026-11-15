/**
 * The one full-stage canvas: renderer, camera, the Blender room + full-wall
 * 2x5 goal, its real 3D diffuser bars, the ball's cast shadow and the ball.
 *
 * One authoritative position. physics.js owns the ball; this module only
 * READS the interpolated physics state (prev → current by the frame alpha)
 * every frame. The mesh, the cast shadow and the DOM goal all derive from
 * that single state, so they can never disagree.
 *
 * Camera: the team lead owns the framing contract. This module applies it
 * without per-axis distortion; world → CSS px is the normal projection. The
 * lens is level on every aspect; portrait keeps the near-face phone standoff,
 * desktop uses its own farther real standoff (see config.js CAMERA).
 *
 * `assets/glb/room-goal.4k.3988b0da4c17eaf0.glb` is the visible room: complete closed shell, goal
 * partition sealed to all four room boundaries, and 27 diffuser lenses on the
 * grid bars. Walls/ceiling are in the asset but hidden by product rule; the
 * floor and goal are not. Light state is assigned to real lens meshes, never
 * painted as a 2D fill. The DOM goal is a measuring/accessibility layer only.
 */

import * as THREE from './three.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { loadFootball } from './ball-view.js';
import {
  BALL_RADIUS,
  BAR,
  CAMERA,
  CELLS_X,
  CELLS_Y,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  GOAL,
  KEY_LIGHT,
  LAYER2,
  OPENING,
  RESTING,
  ROOM,
} from './config.js';
import { framingFor, projectPoint, projectSphereExtent, unprojectToFloor, unprojectToPlane } from './camera.js';
import { DPR_CAP, applyTextureSampling, loadGlb, resolveAsset } from './texture-infra.js';

export function supportsWebGL2() {
  try {
    if (!window.WebGL2RenderingContext) return false;
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2'));
  } catch {
    return false;
  }
}

export const GLB_URL = new URL('assets/glb/football.4k.b022e4b93a8701be.glb', import.meta.url);
export const ROOM_URL = new URL('assets/glb/room-goal.4k.3988b0da4c17eaf0.glb', import.meta.url);

/** Deep anodized goal: micro-brushed metal + a cool Fresnel edge, no grey. */
function installGoalShader(material) {
  if (!material || material.userData.goalShader) return;
  material.userData.goalShader = true;
  material.color.setHex(0x040404);
  material.metalness = 0.22;
  material.roughness = 0.42;
  material.envMapIntensity = 0.22;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGoalWorld;')
      .replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvGoalWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGoalWorld;
        float goalHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float brushed = goalHash(vec2(vGoalWorld.x * 2200.0, vGoalWorld.y * 18.0));
        diffuseColor.rgb *= 0.86 + 0.07 * brushed;`)
      .replace('#include <opaque_fragment>', `
        float goalRim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 4.5);
        outgoingLight += vec3(0.10, 0.11, 0.13) * goalRim * 0.28;
        gl_FragColor = vec4(outgoingLight, diffuseColor.a);`);
  };
  material.customProgramCacheKey = () => 'anodized-goal-2';
  material.needsUpdate = true;
}

/**
 * @param {{ canvas: HTMLCanvasElement, host: HTMLElement }} options
 */
export function createScene({ canvas, host }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true, // the white page is the room; the canvas only adds ball, shadow, goal
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  // The product is a pure-white field: no floor shadow, no ambient shadow,
  // no ball shadow. Lighting still shapes the leather and the goal.
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  /**
   * One level physical pinhole camera, looking straight down the room (−Z).
   * `camera.js` solves the crop and the per-aspect standoff for the current
   * viewport; this module only applies that solve to three.js. The projection
   * is off-axis (shifted principal point), never an orthographic or stretched
   * matrix: that is what lets the same level camera fill a desktop full-width
   * view and a phone's taller crop while keeping the goal a true rectangle.
   */
  const camera = new THREE.PerspectiveCamera(60, 1, CAMERA.near, CAMERA.far);
  camera.position.set(CAMERA.eye.x, CAMERA.eye.y, CAMERA.eye.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(CAMERA.eye.x, CAMERA.eye.y, CAMERA.eye.z - 1);
  // Layer 2 uses the same physical camera pose and z-projection, with a pure
  // vertical lens shift for the ball only. The goal/room stay on `camera`.
  const ballCamera = camera.clone();

  /** Layer-2 vertical shift of the ball image, CSS px (diagnostics/inverse). */
  let ballShiftPx = 0;
  /** The current crop solve from camera.js. */
  let framing = framingFor(1, 1);
  const halfW = GOAL_WIDTH / 2;
  const view = {
    width: 1,
    height: 1,
    projection: 'perspective',
    /** The level lens for the current aspect (phone near face / desktop standoff). */
    eye: { ...CAMERA.eye },
    /** Goal-plane scale, CSS px per metre. */
    pxPerMetre: 1,
    /** Visible world width/height at the goal plane. */
    span: { x: 1, y: 1 },
    /** The goal's share of the frame, from the crop solve (diagnostics). */
    goalWidthFraction: 1,
    goalHeightFraction: 1,
    rect: () => ({ left: 0, top: 0, width: view.width, height: view.height }),
  };
  /** Current real-goal light state: null = all strips off. */
  let light = null;

  /**
   * Apply the pure crop solve to the render camera. The camera position and
   * orientation never change: only the off-axis frustum (the sensor crop).
   */
  function applyFraming() {
    const n = CAMERA.near;
    camera.near = n;
    camera.far = CAMERA.far;
    // Keep the conventional fields truthful for diagnostics; the off-axis
    // matrix below is authoritative and is never recomputed from fov/aspect.
    camera.aspect = framing.aspect;
    camera.fov = (2 * Math.atan(framing.tanV) * 180) / Math.PI;
    camera.updateProjectionMatrix();
    camera.projectionMatrix.makePerspective(
      -n * framing.tanH,
      n * framing.tanH,
      n * framing.tanTop,
      n * framing.tanBottom,
      n,
      CAMERA.far,
    );
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camera.updateMatrixWorld();
    ballCamera.position.copy(camera.position);
    ballCamera.quaternion.copy(camera.quaternion);
    ballCamera.up.copy(camera.up);
    ballCamera.updateMatrixWorld();
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (t) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };

  /** True screen-space silhouette of the 3D sphere (no sprite scale). */
  function ballExtent(p) {
    return projectSphereExtent(framing, p, BALL_RADIUS);
  }

  /** Base shift that puts the resting ball's lower rim at the bottom margin. */
  function baseBallShift() {
    if (!host.isConnected || !view.height) return 0;
    const rest = project({ x: RESTING.x, y: RESTING.y, z: RESTING.z });
    const extent = ballExtent({ x: RESTING.x, y: RESTING.y, z: RESTING.z });
    if (!extent) return 0;
    // Placement-only target: the projected centre so the sphere's actual
    // lower silhouette sits `bottomMarginPx` above the viewport bottom.
    const target = view.height - extent.bottom - LAYER2.bottomMarginPx;
    return target - rest.y;
  }

  /**
   * Layer-2 screen map for a ball pose: fade to zero at the goal so a scored
   * ball still enters the visible cell, then clamp the whole silhouette inside
   * the viewport. No scale is applied; only a vertical screen translation.
   */
  function shiftForBall(p) {
    // One camera for the ball, goal and floor: no screen-space ball shift,
    // so the ball, the goal base and the floor share one ground plane and the
    // flight is the true projected parabola.
    if (p) return 0;
    const base = baseBallShift();
    const t = smooth((p.z - LAYER2.fadeStartZ) / Math.max(1e-6, LAYER2.fadeEndZ - LAYER2.fadeStartZ));
    let shift = base * t;
    const y1 = project(p).y;
    const extent = ballExtent(p);
    if (extent) {
      // Hard screen boundary: the whole visible sphere stays inside.
      shift = clamp(shift, extent.top + 2 - y1, view.height - extent.bottom - 2 - y1);
    }
    return shift;
  }

  /** Apply the layer-2 shift to the ball-only camera. */
  function applyBallFraming(shiftPx) {
    const n = CAMERA.near;
    const centre = (2 * shiftPx / Math.max(1, view.height)) * framing.tanV;
    ballCamera.projectionMatrix.makePerspective(
      -n * framing.tanH,
      n * framing.tanH,
      n * (framing.tanTop + centre),
      n * (framing.tanBottom + centre),
      n,
      CAMERA.far,
    );
    ballCamera.projectionMatrixInverse.copy(ballCamera.projectionMatrix).invert();
    ballCamera.updateMatrixWorld();
  }

  /**
   * @param {boolean} [silent] true for a per-frame re-apply: the host size has
   * not changed, so the renderer is not resized.
   */
  function layout(silent = false) {
    if (!host.isConnected) return; // never resize a detached host (it can collapse to 1px)
    // The page is a full-viewport canvas. Use the real viewport so the
    // projection aspect can never disagree with the CSS aspect (the source
    // of the stretched phone ball).
    const width = Math.max(1, Math.round(window.innerWidth || host.clientWidth || 1));
    const height = Math.max(1, Math.round(window.innerHeight || host.clientHeight || 1));
    view.width = width;
    view.height = height;
    framing = framingFor(width, height);
    view.eye = { ...framing.eye };
    view.pitch = framing.pitch;
    camera.position.set(framing.eye.x, framing.eye.y, framing.eye.z);
    camera.lookAt(framing.eye.x, framing.eye.y, framing.eye.z - 1);
    applyFraming();
    ballCamera.position.copy(camera.position);
    ballCamera.quaternion.copy(camera.quaternion);
    ballCamera.up.copy(camera.up);
    ballCamera.updateMatrixWorld();
    ballShiftPx = shiftForBall(pose.pos);
    applyBallFraming(ballShiftPx);
    view.ballShiftPx = ballShiftPx;
    view.span.x = 2 * framing.tanH * framing.eye.z;
    view.span.y = 2 * framing.tanV * framing.eye.z;
    view.goalWidthFraction = framing.goalWidthFraction;
    view.goalHeightFraction = framing.goalHeightFraction;
    const a = project({ x: -halfW, y: 0, z: 0 });
    const b = project({ x: halfW, y: 0, z: 0 });
    view.pxPerMetre = (b.x - a.x) / GOAL_WIDTH;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    if (silent) return;
    renderer.setSize(width, height, false);
  }

  // A window dragged between displays changes devicePixelRatio without a CSS
  // resize. Re-arm the media query each time so the drawing buffer keeps a
  // crisp 1:1 CSS-pixel ratio (capped at 2).
  let dprQuery = null;
  function onPixelRatio() {
    layout();
    invalidate();
    watchPixelRatio();
  }
  function watchPixelRatio() {
    dprQuery?.removeEventListener('change', onPixelRatio);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener?.('change', onPixelRatio);
  }

  /** Layer-1 world→screen projection (room/goal). */
  function project(p) {
    const q = projectPoint(framing, p);
    // A point at/behind the lens is not visible; keep callers numeric.
    return q ? { x: q.x, y: q.y, depth: q.depth } : { x: -1e6, y: -1e6, depth: 0 };
  }

  /**
   * CSS px → the point where that ray meets the horizontal plane z = planeZ.
   * Used only to turn a swipe into a direction; physics never consumes screen
   * coordinates.
   */
  function unproject(x, y, planeZ = 0) {
    return unprojectToPlane(framing, x, y, planeZ);
  }

  /** CSS px → point on the physical floor, for direct drag rolling. */
  function unprojectFloor(x, y) {
    // Inverse layer-2 map: the pointer was placed against the shifted ball
    // image, so remove that exact screen shift before the Rapier/world ray.
    return unprojectToFloor(framing, x, y - ballShiftPx, 0);
  }

  /** Layer-2 ball screen position (same 3D size, shifted placement). */
  function projectBall(p) {
    const q = project(p);
    const shift = shiftForBall(p);
    return { ...q, y: q.y + shift, shift };
  }

  // -------------------------------------------------------------- room GLB
  // The visible room, the full-wall 2x5 goal and every light bar come from
  // Blender (`assets/glb/room-goal.4k.3988b0da4c17eaf0.glb`). Nothing here invents a goal or a floor.
  // Walls/ceiling are present geometry but invisible by product rule; the
  // floor and goal remain. Each diffuser bar knows the cell edges it borders,
  // so green/red is assigned to real 3D lenses on the bars.
  const cellStrips = Array.from({ length: CELLS_X * CELLS_Y }, () => ({
    top: null, bottom: null, left: null, right: null,
  }));
  const stripMeshes = [];
  let stripMaterials = null;
  let roomRoot = null;
  let goalGroup = null;
  let roomMode = 'loading';

  function applyLights() {
    if (!stripMaterials) return;
    for (const mesh of stripMeshes) mesh.material = stripMaterials.off;
    if (!light) return;
    const cell = cellStrips[light.cell];
    if (!cell) return;
    const material = light.state === 'green' ? stripMaterials.green : stripMaterials.red;
    const edges = light.state === 'green'
      ? ['top', 'bottom', 'left', 'right']
      : (light.edge ? [light.edge] : ['top', 'bottom', 'left', 'right']);
    for (const edge of edges) {
      if (cell[edge]) cell[edge].material = material;
    }
  }

  /**
   * Drive the real Blender light bars:
   *   setLights(cell, 'green')             -> all four bars of that opening
   *   setLights(cell, 'red', 'left')       -> the one struck bar/post
   *   setLights(-1, null)                  -> all off
   */
  function setLights(cell, state, edge = null) {
    const valid = cell >= 0 && state !== null && (state === 'green' || state === 'red') && cellStrips[cell];
    light = valid ? { cell, state, edge: edge ?? null } : null;
    applyLights();
    invalidate();
  }

  /**
   * Load the room/goal asset once. It carries the complete closed shell, the
   * goal partition and 27 diffuser bars; the site hides the shell.
   */
  async function loadRoom() {
    const asset = resolveAsset('room-goal', ROOM_URL.href, renderer);
    const { gltf, bytes, ms } = await loadGlb(new GLTFLoader(), asset.url, {
      label: 'room-goal',
      timeoutMs: 45_000,
      retries: 1,
      priority: 'high',
    });
    const root = gltf.scene;
    applyTextureSampling(root, renderer);
    console.info(`[room] ${asset.tier} ${Math.round(bytes / 1024)} KiB in ${ms} ms (${asset.reason})`);
    root.name = 'room-model';
    let baseMaterial = null;
    root.traverse((object) => {
      if (!object.isMesh) return;
      // glTF stores node extras on the node wrapper; the mesh itself can be a
      // child, so walk up until a role is found. Without this the floor and
      // walls keep their GLB materials and a grey slab leaks into the frame.
      let source = object;
      let role = '';
      while (source && !role) {
        role = source.userData?.role ?? '';
        source = source.parent;
      }
      object.castShadow = false;
      object.receiveShadow = role === 'floor';
      object.frustumCulled = false;
      if (role === 'wall' || role === 'ceiling' || role === 'seam'
        || role === 'wall-joint' || role === 'front-wall') {
        object.visible = false;
        return;
      }
      if (role === 'goal-frame') {
        goalGroup = object;
        // Deep satin black, keeping the authored bead-blast texture/normal.
        // A low metalness and restrained environment reflection stop the
        // full-wall frame from reading as grey under the white room light.
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) installGoalShader(material);
        return;
      }
      if (role === 'floor') {
        // Walls, ceiling and floor are the physical room, not pixels. The
        // product is a pure-white field: the floor mesh is hidden and the page
        // white shows through. The soft contact shadow below follows the ball.
        object.visible = false;
        return;
      }
      if (role !== 'light-strip') return;
      stripMeshes.push(object);
      if (!baseMaterial) baseMaterial = object.material;
      const data = object.userData;
      const bar = Number(data.bar);
      const index = Number(data.index);
      if (data.orientation === 'vertical') {
        if (bar > 0) cellStrips[index * CELLS_X + (bar - 1)].right = object;
        if (bar < CELLS_X) cellStrips[index * CELLS_X + bar].left = object;
      } else {
        if (bar > 0) cellStrips[(bar - 1) * CELLS_X + index].top = object;
        if (bar < CELLS_Y) cellStrips[bar * CELLS_X + index].bottom = object;
      }
    });
    const expected = (CELLS_X + 1) * CELLS_Y + (CELLS_Y + 1) * CELLS_X;
    if (!baseMaterial || stripMeshes.length !== expected) {
      throw new Error(`room GLB is missing goal light bars (${stripMeshes.length}/${expected})`);
    }
    const off = baseMaterial;
    off.name = 'goal-light-off';
    if (off.emissive) off.emissive.setHex(0x000000);
    if ('emissiveIntensity' in off) off.emissiveIntensity = 0;
    const green = off.clone();
    green.name = 'goal-light-green';
    green.color.setHex(0x041408);
    if (green.emissive) green.emissive.setHex(0x22ff66);
    if ('emissiveIntensity' in green) green.emissiveIntensity = 2.4;
    green.toneMapped = false;
    const red = off.clone();
    red.name = 'goal-light-red';
    red.color.setHex(0x140402);
    if (red.emissive) red.emissive.setHex(0xff2a1e);
    if ('emissiveIntensity' in red) red.emissiveIntensity = 2.4;
    red.toneMapped = false;
    stripMaterials = { off, green, red };
    for (const mesh of stripMeshes) mesh.material = off;
    roomRoot = root;
    scene.add(root);
    roomMode = 'glb';
    applyLights();
    invalidate();
    return root;
  }

  // The Blender floor is the visible, pure-white receiver. The key light is
  // the only shadow caster; room meshes are not casters, so the full-wall goal
  // cannot slice bands into the ball's contact shadow.
  const BALL_LAYER = 1;
  camera.layers.enable(BALL_LAYER);

  // -------------------------------------------------------------- lighting
  const hemi = new THREE.HemisphereLight(0xffffff, 0xe8e4df, 1.35);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff6ee, 2.4);
  key.name = 'key';
  key.position.set(KEY_LIGHT.x, KEY_LIGHT.y, KEY_LIGHT.z);
  key.castShadow = false;
  scene.add(key, key.target);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  // Leather responds to a soft studio: generated environment, no files.
  const env = buildStudio(renderer);
  scene.environment = env;
  scene.environmentIntensity = 0.9;

  // ----------------------------------------------------------- ball model
  // No placeholder sphere and no PNG: ball-view.js proves the Blender PBR
  // asset (UVs + colour/normal/roughness maps + decoded images) before it
  // adds anything visible. A failed load leaves the group hidden and records
  // the failure; it never draws an untextured substitute.
  const ballGroup = new THREE.Group();
  ballGroup.name = 'football';
  ballGroup.visible = false;
  scene.add(ballGroup);

  let model = null;
  let mode = 'loading';

  /**
   * Load the real football from assets/glb/football.4k.b022e4b93a8701be.glb. Rejects if the mesh or
   * any required PBR map is missing. The GLB textures are embedded.
   */
  async function loadModel() {
    const result = await loadFootball({
      ballGroup,
      renderer,
      camera,
      scene,
      layer: BALL_LAYER,
    });
    model = result.root;
    mode = 'glb';
    paint();
    return result.root;
  }

  // ---------------------------------------------------------------- frame
  /** The interpolated ball transform the renderer must show. */
  const pose = { pos: new THREE.Vector3(RESTING.x, RESTING.y, RESTING.z), quat: new THREE.Quaternion() };
  function setPose(p, q) {
    pose.pos.set(p.x, p.y, p.z);
    pose.quat.copy(q);
  }
  /**
   * The camera is the room's window: it is fixed on the near face and never
   * pans, dollies or pitches. A goal therefore does not move the camera; the
   * real ball is seen through the real opening with the same projection.
   * `setFollow` remains as an observability hook for app.js and the tests.
   */
  let followSig = '';
  function setFollow(sig = '') {
    followSig = sig;
  }

  function paint() {
    ballGroup.position.copy(pose.pos);
    ballGroup.quaternion.copy(pose.quat);
    ballShiftPx = shiftForBall(pose.pos);
    applyBallFraming(ballShiftPx);
    view.ballShiftPx = ballShiftPx;

    // Layer 1: room + goal + full depth buffer.
    ballGroup.visible = false;
    renderer.autoClear = true;
    renderer.render(scene, camera);
    // Layer 2: the same 3D ball, same z depth, shifted only in screen space.
    // Room geometry is hidden but its depth buffer still occludes a ball that
    // is behind a bar. No second pose and no scale change.
    ballGroup.visible = true;
    const roomVisible = roomRoot?.visible ?? false;
    if (roomRoot) roomRoot.visible = false;
    renderer.autoClear = false;
    renderer.render(scene, ballCamera);
    renderer.autoClear = true;
    if (roomRoot) roomRoot.visible = roomVisible;
  }

  /** Paint one authoritative frame: fixed camera, current crop, real state. */
  function draw() {
    layout(true); // re-solve the crop only if the host size changed
    paint();
  }

  // ---------------------------------------------------------------- loop
  let frameHandle = 0;
  let loopHandle = 0;
  let loopStep = null;
  let last = 0;
  let disposed = false;
  const listeners = new Set();

  function invalidate() {
    if (disposed || frameHandle || loopHandle || document.hidden) return;
    frameHandle = requestAnimationFrame(() => {
      frameHandle = 0;
      if (!disposed) draw();
    });
  }

  const tick = (now) => {
    loopHandle = 0;
    if (disposed) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
    last = now;
    const more = loopStep ? loopStep(dt) : false;
    draw();
    if (more && loopStep && !disposed && !document.hidden) loopHandle = requestAnimationFrame(tick);
    else {
      loopStep = null;
    }
  };
  function startLoop(step) {
    loopStep = step;
    last = 0;
    if (!loopHandle && !document.hidden && !disposed) loopHandle = requestAnimationFrame(tick);
  }
  /** Whether the render loop is currently running (observability). */
  function isLooping() {
    return Boolean(loopHandle);
  }
  function stopLoop() {
    loopStep = null;
    if (loopHandle) cancelAnimationFrame(loopHandle);
    loopHandle = 0;
  }

  function onVisibility() {
    if (document.hidden) {
      if (frameHandle) cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      if (loopHandle) cancelAnimationFrame(loopHandle);
      loopHandle = 0;
    } else if (loopStep) {
      last = 0;
      loopHandle = requestAnimationFrame(tick);
    } else invalidate();
  }
  document.addEventListener('visibilitychange', onVisibility);

  function onViewportChange() {
    const w = Math.round(window.innerWidth || host.clientWidth || 1);
    const h = Math.round(window.innerHeight || host.clientHeight || 1);
    if (w === view.width && h === view.height) return;
    layout();
    listeners.forEach((fn) => fn());
    invalidate();
  }

  const observer = new ResizeObserver(() => {
    const w = Math.round(host.clientWidth);
    const h = Math.round(host.clientHeight);
    if (w === view.width && h === view.height) return;
    layout();
    listeners.forEach((fn) => fn());
    invalidate();
  });

  // ResizeObserver alone misses orientation changes and some headless /
  // emulated viewport resizes while the page is not visible. A viewport
  // resize must re-solve the projection immediately so a 390x844 window can
  // never keep the 1.58 landscape aspect (the stretched phone ball bug).
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.addEventListener('orientationchange', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });

  layout();
  watchPixelRatio();
  observer.observe(host);
  invalidate();

  return {
    renderer,
    scene,
    camera,
    ballCamera,
    view,
    project,
    projectBall,
    unproject,
    unprojectFloor,
    goal: GOAL,
    ballGroup,
    get goalGroup() {
      return goalGroup;
    },
    get roomRoot() {
      return roomRoot;
    },
    faces: stripMeshes,
    setLights,
    loadRoom,
    get roomMode() {
      return roomMode;
    },
    setFollow,
    draw,
    invalidate,
    paint,
    startLoop,
    stopLoop,
    isLooping,
    setPose,
    loadModel,
    get mode() {
      return mode;
    },
    onLayout(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * The DOM goal's box in stage CSS px, from the projection of the real
     * lattice: the outer corners of the frame in the plane z = 0.
     */
    goalGeometry() {
        const tl = project({ x: -halfW, y: GOAL_HEIGHT, z: 0 });
      const br = project({ x: halfW, y: 0, z: 0 });
      return {
        left: tl.x,
        top: tl.y,
        width: br.x - tl.x,
        height: br.y - tl.y,
        openingPx: ((br.x - tl.x) / GOAL_WIDTH) * OPENING,
        barPx: ((br.x - tl.x) / GOAL_WIDTH) * BAR,
      };
    },
    dispose() {
      disposed = true;
      if (frameHandle) cancelAnimationFrame(frameHandle);
      if (loopHandle) cancelAnimationFrame(loopHandle);
      observer.disconnect();
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      window.visualViewport?.removeEventListener('resize', onViewportChange);
      document.removeEventListener('visibilitychange', onVisibility);
      scene.traverse((object) => {
        if (!object.isMesh) return;
        object.geometry?.dispose?.();
        const maps = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of maps) {
          if (!material) continue;
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
      });
      env.dispose();
      renderer.dispose();
    },
  };
}

/** Soft neutral studio for the leather, rendered once into a PMREM. */
function buildStudio(renderer) {
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x9d9d9d);
  const panel = (color, intensity, w, h, position) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    mesh.position.set(...position);
    mesh.lookAt(0, 0, 0);
    room.add(mesh);
  };
  panel(0xfff8f0, 3.2, 6, 5, [-5, 6, 5]);
  panel(0xe9eff9, 1.1, 6, 6, [7, 1, 4]);
  panel(0xffffff, 0.6, 8, 2, [0, -6, 3]);
  panel(0xfff1e2, 1.2, 4, 3, [1, 2, -7]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(room, 0.04);
  pmrem.dispose();
  room.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    object.material.dispose();
  });
  return target.texture;
}
