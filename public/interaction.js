/**
 * Input → one launch velocity. This module never decides whether a shot scores.
 *
 * The shipped control scheme (supersedes tap-to-shoot, upward flick, Enter to
 * shoot and drag-for-placement):
 *
 *   press and hold the ball        → charge (0..1 over SHOT.chargeMs)
 *   move toward a goal opening     → aim at that point on the goal plane
 *   release                        → one real shot in that direction
 *
 * A short tap, a swipe made before the long-press threshold, or a release
 * without an aim cancels with no shot. Physics owns everything after launch;
 * green/red and the child-page transition are handled in app.js from real
 * physics events.
 *
 * Pointer Events with capture are used, so a finger can leave the ball while
 * aiming. Escape cancels a charge. Keyboard is a first-class alternative:
 * focus the ball, hold Space or Enter to charge, aim with the arrow keys
 * (Shift = fine), release to shoot, R resets.
 */

import {
  BALL_RADIUS,
  BAR,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  SHOT,
  RESTING,
} from './config.js?v=2026.11.23-r10';
import {
  chargeForElapsed,
  defaultAimPoint,
  launchFromAim,
  moveAim,
  aimFromGoalRect,
  releaseRatioFromSamples,
} from './shot.js?v=2026.11.23-r10';

const MIN_AIM_PX = SHOT.aimDeadzonePx;
const DRAG_START_PX = 4;
const DRAG_MAX_SPEED = 6.0; // m/s, a firm hand push
const HAPTIC = typeof navigator !== 'undefined'
  && typeof navigator.vibrate === 'function'
  && window.matchMedia?.('(pointer: coarse)').matches;

export function createInteraction({
  play,
  world,
  view,
  project,
  projectBall,
  unproject,
  unprojectFloor,
  reduceMotion,
  onHold,
  onLaunch,
  onReset,
  onCancel,
  status,
  rest = RESTING,
}) {
  const dom = {
    handle: play.querySelector('[data-ball]'),
    reset: document.querySelector('[data-reset]'),
    // The projected ball, goal and aim all live in the scene host's pixel
    // space; pointer coordinates must be converted against this same box.
    host: play.querySelector('[data-scene]') ?? play,
  };
  let phase = 'idle'; // idle | pressing | charging | flying | settled
  let gesture = null; // active pointer gesture
  let charge = 0;
  let chargeFrame = 0;
  let longPressTimer = 0;
  let aimPoint = null;
  let lastPointer = null;
  let lastRelease = 0;
  let lastDrag = null;
  let hapticStep = -1;
  const keyboard = { active: false, aim: defaultAimPoint(), timer: 0 };

  function setPhase(next) {
    phase = next;
    play.dataset.state = next;
    if (next !== 'charging') {
      setCharge(0);
      hideAim();
      stopHaptics();
    }
  }

  function ballPos() {
    return world.state().pos;
  }

  // ------------------------------------------------------------ feedback
  function setCharge(next) {
    charge = Math.max(0, Math.min(1, next));
    // No visible charge indicator by contract. Touch devices feel the charge
    // as short haptic pulses whose strength follows the charge level.
    if (phase === 'charging' && HAPTIC) {
      const step = Math.min(9, Math.floor(charge * 10));
      if (step !== hapticStep) {
        hapticStep = step;
        navigator.vibrate(8 + step * 5);
      }
    }
  }

  function stopHaptics() {
    hapticStep = -1;
    if (HAPTIC) navigator.vibrate(0);
  }

  function updateChargeFromClock(startedAt) {
    setCharge(chargeForElapsed(performance.now() - startedAt));
  }

  function pumpCharge() {
    if (phase !== 'charging') return;
    const startedAt = gesture?.chargeStartedAt ?? keyboard.startedAt;
    updateChargeFromClock(startedAt);
    chargeFrame = requestAnimationFrame(pumpCharge);
  }

  function stopChargeClock() {
    if (chargeFrame) cancelAnimationFrame(chargeFrame);
    chargeFrame = 0;
  }

  function showAim(point) {
    aimPoint = point;
    if (!dom.aim || !point) return;
    const at = project(point);
    dom.aim.style.setProperty('--aim-x', `${at.x.toFixed(2)}px`);
    dom.aim.style.setProperty('--aim-y', `${at.y.toFixed(2)}px`);
    dom.aim.dataset.on = 'true';
  }

  function hideAim() {
    aimPoint = null;
    if (dom.aim) delete dom.aim.dataset.on;
  }

  // ------------------------------------------------------------- layout
  /** The real lattice projected into CSS px, in the .room coordinate space. */
  function goalLayout() {
    const tl = project({ x: -GOAL_WIDTH / 2, y: GOAL_HEIGHT, z: 0 });
    const br = project({ x: GOAL_WIDTH / 2, y: 0, z: 0 });
    const width = br.x - tl.x;
    const height = br.y - tl.y;
    return {
      left: tl.x,
      top: tl.y,
      width,
      height,
      barPx: width * (BAR / GOAL_WIDTH),
      pxPerMetre: width / GOAL_WIDTH,
      worldWidth: GOAL_WIDTH,
      worldHeight: GOAL_HEIGHT,
    };
  }

  /**
   * The handle sits on the real (interpolated) ball so a grab starts on it.
   * Its diameter is derived from the projected sphere, so it stays usable at
   * every camera distance without a second source of truth.
   */
  function syncHandle() {
    if (!dom.handle) return;
    const pos = ballPos();
    const projectView = projectBall ?? project;
    const at = projectView(pos);
    const edge = projectView({ x: pos.x + BALL_RADIUS, y: pos.y, z: pos.z });
    const pxRadius = Math.max(10, Math.abs(edge.x - at.x));
    // The visible ball is physically small and now sits deeper in the room
    // (about 20 px across on a phone), but the touch target must stay usable.
    const size = Math.max(44, pxRadius * 2.9);
    dom.handle.style.setProperty('--ball-x', `${at.x.toFixed(2)}px`);
    dom.handle.style.setProperty('--ball-y', `${at.y.toFixed(2)}px`);
    dom.handle.style.setProperty('--ball-size', `${size.toFixed(2)}px`);
    dom.charge?.style.setProperty('--ball-x', `${at.x.toFixed(2)}px`);
    dom.charge?.style.setProperty('--ball-y', `${at.y.toFixed(2)}px`);
    dom.charge?.style.setProperty('--ball-size', `${size.toFixed(2)}px`);
  }

  function pointerToAim(event) {
    const rect = dom.host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    lastPointer = { clientX: event.clientX, clientY: event.clientY, hostX: x, hostY: y, hostLeft: rect.left, hostTop: rect.top };
    if (typeof unproject === 'function') {
      const point = unproject(x, y);
      if (point) return point;
    }
    const g = goalLayout();
    return aimFromGoalRect(x, y, { ...g, worldWidth: GOAL_WIDTH, worldHeight: GOAL_HEIGHT });
  }

  function eventDistance(event) {
    if (!gesture) return 0;
    return Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
  }

  // -------------------------------------------------------------- pointer
  function beginCharge() {
    if (phase !== 'pressing' || !gesture) return;
    longPressTimer = 0;
    setPhase('charging');
    gesture.chargeStartedAt = performance.now();
    if (gesture.pendingAim) showAim(gesture.pendingAim);
    setCharge(0);
    pumpCharge();
    status?.('Charging. Move toward a goal opening, then release to shoot.');
  }

  function armLongPress() {
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(beginCharge, SHOT.longPressMs);
  }

  function onPointerDown(event) {
    // A live gesture keeps the current pointer. After a bounce or a landing,
    // flying/settled must not lock the ball: the same rigid body can be
    // grabbed, dragged, or charged again.
    if (phase === 'charging' || phase === 'pressing' || phase === 'dragging') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    try {
      dom.handle.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best effort */
    }
    const now = performance.now();
    const pos = world.state().pos;
    gesture = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: now,
      chargeStartedAt: 0,
      pendingAim: null,
      moved: false,
      samples: [{ x: event.clientX, y: event.clientY, t: now }],
      drag: false,
      dragStartBall: pos,
    };
    // Spring-hold the same Rapier body under the finger so a flying or
    // just-landed ball can be grabbed, dragged, or charged again.
    if (typeof world.drag === 'function') world.drag({ x: pos.x, z: pos.z });
    onHold?.();
    setPhase('pressing');
    setCharge(0);
    armLongPress();
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    gesture.samples.push({ x: event.clientX, y: event.clientY, t: performance.now() });
    if (gesture.samples.length > 24) gesture.samples.shift();
    const moved = eventDistance(event);
    if (moved < DRAG_START_PX) return;

    // Immediate movement before the long-press threshold is a real drag on
    // the floor: the ball follows the finger, then rolls with the measured
    // release velocity and the fixed rolling resistance. Holding still
    // becomes the charge/aim shot instead.
    if (phase === 'pressing' || phase === 'dragging') {
      if (!gesture.drag) {
        gesture.drag = true;
        window.clearTimeout(longPressTimer);
        longPressTimer = 0;
        setPhase('dragging');
      }
      const rect = dom.host.getBoundingClientRect();
      const floorPoint = typeof unprojectFloor === 'function'
        ? unprojectFloor(event.clientX - rect.left, event.clientY - rect.top)
        : null;
      let target;
      if (floorPoint) {
        target = { x: floorPoint.x, z: floorPoint.z };
      } else {
        const ppm = Math.max(1, view().pxPerMetre || goalLayout().pxPerMetre || 120);
        target = {
          x: gesture.dragStartBall.x + (event.clientX - gesture.startX) / ppm,
          z: gesture.dragStartBall.z - (event.clientY - gesture.startY) / ppm,
        };
      }
      // Apply a real planar velocity; Rapier integrates it. No teleporting
      // the body to the pointer, no manual final pose.
      world.drag(target);
      onHold?.();
      gesture.pendingAim = null;
      event.preventDefault();
      return;
    }

    if (moved < MIN_AIM_PX) return;
    gesture.moved = true;
    const point = pointerToAim(event);
    if (!point) return;
    gesture.pendingAim = point;
    if (phase === 'charging') showAim(point);
    event.preventDefault();
  }

  function clearGesture() {
    window.clearTimeout(longPressTimer);
    longPressTimer = 0;
    stopChargeClock();
    if (!gesture) return;
    try {
      if (dom.handle.hasPointerCapture?.(gesture.id)) dom.handle.releasePointerCapture(gesture.id);
    } catch {
      /* already released */
    }
    gesture = null;
  }

  function cancelGesture(message) {
    world.releaseHand?.();
    clearGesture();
    setPhase('idle');
    setCharge(0);
    onCancel?.();
    if (message) status?.(message);
  }

  function releaseDrag() {
    if (!gesture) return;
    // The body already has Rapier velocity and spin from drag(); do not
    // overwrite them with a screen-pixel estimate, and do not zero ω.
    world.releaseHand?.();
    const v = world.state().vel;
    if (Math.hypot(v.x, v.y, v.z) < 0.18) {
      setPhase('idle');
      onCancel?.();
      status?.('Drag the ball to roll it, or hold still to charge a shot.');
      return;
    }
    if (typeof world.letRoll === 'function') world.letRoll();
    else world.launch({ vx: v.x, vy: v.y, vz: v.z });
    onLaunch?.();
    setPhase('flying');
    status?.('Rolling.');
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (phase === 'dragging') {
      releaseDrag();
      clearGesture();
      event.preventDefault();
      return;
    }
    const wasCharging = phase === 'charging';
    const aim = gesture.pendingAim;
    const moved = gesture.moved;
    const endedAt = performance.now();
    gesture.samples.push({ x: event.clientX, y: event.clientY, t: endedAt });
    const referencePx = Math.max(1, Math.min(
      dom.host.clientWidth || window.innerWidth,
      dom.host.clientHeight || window.innerHeight,
    ));
    const release = releaseRatioFromSamples(gesture.samples, referencePx);
    const chargedFor = gesture.chargeStartedAt ? endedAt - gesture.chargeStartedAt : 0;
    const finalCharge = gesture.chargeStartedAt
      ? chargeForElapsed(chargedFor)
      : 0;
    clearGesture();

    if (!wasCharging) {
      world.releaseHand?.();
      setPhase('idle');
      onCancel?.();
      status?.('Hold the ball to charge, then move toward an opening and release.');
      return;
    }
    if (!moved && !aim) {
      world.releaseHand?.();
      setPhase('idle');
      onCancel?.();
      status?.('Charge cancelled. Hold, then move toward a goal opening.');
      return;
    }
    if (!aim) {
      world.releaseHand?.();
      setPhase('idle');
      onCancel?.();
      status?.('Aim at a goal opening before releasing.');
      return;
    }
    if (finalCharge < SHOT.minCharge) {
      world.releaseHand?.();
      setPhase('idle');
      onCancel?.();
      status?.('Hold longer to charge the shot.');
      return;
    }
    lastRelease = release;
    shoot(aim, finalCharge, release);
  }

  function onPointerCancel(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    cancelGesture('Gesture cancelled.');
  }

  // --------------------------------------------------------------- keyboard
  function keyboardAim() {
    return keyboard.aim;
  }

  function startKeyboardCharge() {
    if (phase === 'charging' || phase === 'pressing' || phase === 'dragging') return;
    const pos = world.state().pos;
    if (typeof world.drag === 'function') world.drag({ x: pos.x, z: pos.z });
    onHold?.();
    keyboard.active = true;
    setPhase('charging');
    keyboard.startedAt = performance.now();
    showAim(keyboardAim());
    setCharge(0);
    pumpCharge();
    status?.('Charging. Aim with the arrow keys, then release to shoot.');
  }

  function stopKeyboardCharge(commit) {
    if (phase !== 'charging' || !keyboard.active) return;
    const finalCharge = chargeForElapsed(performance.now() - keyboard.startedAt);
    stopChargeClock();
    keyboard.active = false;
    if (!commit || finalCharge < SHOT.minCharge) {
      world.releaseHand?.();
      setPhase('idle');
      onCancel?.();
      status?.('Shot cancelled.');
      return;
    }
    shoot(keyboardAim(), finalCharge);
  }

  function nudgeAim(dx, dy, fine) {
    keyboard.aim = moveAim(keyboard.aim, dx, dy, fine);
    if (!keyboard.active) {
      keyboard.aim = { ...keyboard.aim };
    }
    if (keyboard.active) showAim(keyboard.aim);
    status?.(`Aim ${keyboard.aim.x.toFixed(2)} metres across, ${keyboard.aim.y.toFixed(2)} metres up.`);
  }

  function shoot(aim, chargeValue, release = 0) {
    const ball = ballPos();
    const velocity = launchFromAim(ball, aim, chargeValue, release);
    if (!velocity) {
      world.releaseHand?.();
      setPhase('idle');
      onCancel?.();
      return false;
    }
    setPhase('flying');
    world.launch(velocity);
    onLaunch?.(velocity);
    syncHandle();
    status?.('Shot away.');
    return true;
  }

  function reset() {
    window.clearTimeout(longPressTimer);
    longPressTimer = 0;
    stopChargeClock();
    keyboard.active = false;
    if (gesture) {
      try {
        if (dom.handle.hasPointerCapture?.(gesture.id)) dom.handle.releasePointerCapture(gesture.id);
      } catch {
        /* already released */
      }
      gesture = null;
    }
    world.reset({ x: rest.x, y: rest.y, z: rest.z });
    setPhase('idle');
    setCharge(0);
    syncHandle();
    onReset?.({ type: 'reset' });
    status?.('Ball reset.');
  }

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const onHandle = event.target === dom.handle;
    const chargeKey = event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter';
    if (event.key === 'Escape') {
      if (phase === 'charging') {
        event.preventDefault();
        clearGesture();
        stopKeyboardCharge(false);
        status?.('Charge cancelled.');
      } else if (phase === 'pressing') {
        event.preventDefault();
        cancelGesture('Gesture cancelled.');
      } else if (phase === 'idle' || phase === 'settled') {
        reset();
      }
      return;
    }
    if (onHandle && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      || event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (event.repeat) return;
      const dx = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const dy = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      nudgeAim(dx, dy, event.shiftKey);
      return;
    }
    if (onHandle && chargeKey) {
      event.preventDefault();
      if (event.repeat) return;
      if (phase === 'idle' || phase === 'settled' || phase === 'flying') startKeyboardCharge();
      return;
    }
    if (!event.repeat && (event.key === 'r' || event.key === 'R')) {
      const t = event.target;
      if (t instanceof HTMLElement && t.closest('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      reset();
    }
  }

  function onKeyUp(event) {
    const chargeKey = event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter';
    if (!chargeKey) return;
    if (phase === 'charging' && keyboard.active) {
      event.preventDefault();
      stopKeyboardCharge(true);
    }
  }

  // ---------------------------------------------------------------- mount
  const onMoveCapture = (event) => {
    if (gesture && event.pointerId === gesture.id && event.target !== dom.handle) onPointerMove(event);
  };
  const onUpCapture = (event) => {
    if (gesture && event.pointerId === gesture.id && event.target !== dom.handle) onPointerUp(event);
  };
  const onCancelCapture = (event) => {
    if (gesture && event.pointerId === gesture.id && event.target !== dom.handle) onPointerCancel(event);
  };

  function mount() {
    dom.handle.addEventListener('pointerdown', onPointerDown);
    dom.handle.addEventListener('pointermove', onPointerMove);
    dom.handle.addEventListener('pointerup', onPointerUp);
    dom.handle.addEventListener('pointercancel', onPointerCancel);
    dom.handle.addEventListener('lostpointercapture', (event) => {
      if (gesture && gesture.id === event.pointerId) onPointerCancel(event);
    });
    window.addEventListener('pointermove', onMoveCapture, true);
    window.addEventListener('pointerup', onUpCapture, true);
    window.addEventListener('pointercancel', onCancelCapture, true);
    dom.handle.addEventListener('contextmenu', (event) => event.preventDefault());
    dom.handle.addEventListener('dragstart', (event) => event.preventDefault());
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    dom.reset?.addEventListener('click', () => reset());
    dom.handle.hidden = false;
    if (dom.reset) dom.reset.hidden = false;
    keyboard.aim = defaultAimPoint();
    world.hold({ x: rest.x, y: rest.y, z: rest.z });
    onHold?.();
    syncHandle();
    setPhase('idle');
  }

  return {
    mount,
    goalLayout,
    syncHandle,
    reset,
    onPhysicsEvent(ev) {
      if (ev.type === 'settled') {
        if (phase === 'flying') setPhase('settled');
        syncHandle();
      }
      if (ev.type === 'reset') {
        setPhase('idle');
        syncHandle();
      }
    },
    get phase() {
      return phase;
    },
    get placedX() {
      return ballPos().x;
    },
    get charge() {
      return charge;
    },
    get aim() {
      return aimPoint ? { ...aimPoint } : null;
    },
    get pointer() {
      return lastPointer ? { ...lastPointer } : null;
    },
    /** The measured 0..1 flick boost of the last release (observability). */
    get releaseSpeed() {
      return lastRelease;
    },
    get drag() {
      return lastDrag ? { x: lastDrag.pos.x, z: lastDrag.pos.z } : null;
    },
  };
}
