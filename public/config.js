/**
 * Shared constants, metres. The single source of truth for the
 * physical world (physics.js) and the view (scene.js). Nothing here may
 * draw: physics.js imports it and stays free of DOM and three.js.
 *
 * Axes: +X right, +Y up, +Z toward the camera. The floor is FLOOR_Y.
 * The goal plane is z = 0; the black frame occupies z ∈ [-BAR_DEPTH, 0].
 *
 * The world is one finite, visually invisible room:
 *   • in front of the goal (z ∈ (0, 5]) the ball is placed and shot;
 *   • behind the goal (z ∈ [REAR_Z, 0)) is the SAME room: same floor, same
 *     ceiling, same rear wall. There is NO per-opening net. The thin black
 *     bars (z ∈ [-BAR_DEPTH, 0]) stop a ball at the goal plane; once the whole
 *     sphere has passed an opening it continues into the room, bouncing and
 *     rolling, and may tumble sideways through neighbouring openings.
 * Two solid (never drawn) walls stand behind the goal's outer posts; they
 * close the rear room and give a ball on their far side a contact shadow.
 */

export const BALL_RADIUS = 0.11;

/**
 * The goal mouth: five equal square openings across, two rows.
 * Human court scale, shared with the room track's
 * `prototype/room-goal-ball/room.py` (opening 1.10 m, bar 0.07 m):
 * a person can stand in the room and the ball stays small against the goal.
 * Every derived size below follows from these four numbers, so changing the
 * room proportions, ball radius or frame is a config-only edit.
 */
export const CELLS_X = 5;
export const CELLS_Y = 2;
/** Opening side (both axes), m. */
export const OPENING = 1.1;
/** Every bar, m. */
export const BAR = 0.07;
/** Goal bars run from the plane z = 0 back to z = -BAR_DEPTH. */
export const BAR_DEPTH = 0.16;
/**
 * Height of the room's floor surface, m, where a resting ball's centre sits
 * FLOOR_Y + BALL_RADIUS. The goal's bottom bar stands on this floor; the floor
 * must be deeper than the bar is thick so a whole sphere fits through the
 * bottom openings (the bottom aperture is BAR above the floor, so a rolling
 * ball must be lifted a little before it can pass — decided by physics, never
 * by input).
 */
export const FLOOR_Y = 0;

/** Goal box, origin at the middle of the bottom bar (on the floor, z = 0). */
export const GOAL_WIDTH = (CELLS_X + 1) * BAR + CELLS_X * OPENING;
export const GOAL_HEIGHT = (CELLS_Y + 1) * BAR + CELLS_Y * OPENING;

/**
 * The finite room. No boundary is drawn: its depth and bounds are inferred
 * only from ball bounces, rolls and the cast shadow.
 */
export const REAR_DEPTH = 2.6; // m, the room behind the goal: z ∈ [-2.6, 0]
export const REAR_Z = -REAR_DEPTH;

export const ROOM = {
  floorY: FLOOR_Y,
  minX: -GOAL_WIDTH / 2,
  maxX: GOAL_WIDTH / 2,
  minZ: REAR_Z,
  maxZ: 5,
  maxY: GOAL_HEIGHT,
};

/** Ground: a strip of back-wall + side-wall back shading is not drawn at all. */
export const GROUND = { restitution: 0.52, friction: 0.42 };

/** Ball placement rail: the ball may slide across the front of the room. */
export const PLACE_LIMIT = ROOM.maxX - BALL_RADIUS;

/**
 * The physical camera. Real perspective pinhole, level gaze straight down
 * the room (−Z), no pitch and no off-axis crop. The optical axis goes through
 * the goal's vertical centre, so the floor and the ceiling take the same
 * amount of the frame and the 2×5 stays a true rectangle.
 *
 * Eye height is the goal's vertical centre (`GOAL_HEIGHT / 2` = 1.205 m) on
 * every form factor. Phone stands on the near face at z = 5.00 m; desktop
 * stands farther back so the resting ball at z = 4.05 m stays fully inside
 * the frame (a 6.25 m standoff would clip it once the lens is this high).
 *
 * `goalFill` is less than 1 so the goal is not flush with the left and right
 * edges: the four walls of the room (floor, ceiling, left, right) all show
 * a band of perspective around the lattice.
 */
export const CAMERA = {
  projection: 'perspective',
  /** Desktop/shared lens, metres; z is the near face used as the phone default. */
  eye: { x: 0, y: 0.22, z: ROOM.maxZ },
  near: 0.05,
  far: 50,
  /** Desktop: the goal spans this share of the frame width at z = 0. */
  goalFill: 1,
  /** Phone: 0.88 leaves 6 % of the frame on each side of the lattice. */
  portraitGoalFill: 0.88,
  /** Optical margin above the ceiling at the goal plane, metres. */
  topMargin: 0.04,
  /** Bottom-crop reference (independent of physics nearZ). */
  framingNearZ: 3.45,
  /** Goal centre as a fraction of frame height from the top. */
  goalScreenY: 0.50,
  /** Portrait: goal centre stays mid-frame. */
  portraitGoalScreenY: 0.50,
  /** Portrait lens height: the goal's vertical centre, so floor and ceiling
   *  take equal area. */
  portraitEyeY: GOAL_HEIGHT / 2,
  /** Portrait standoff, m. Far enough that the floor ball is only ~18° off
   *  the optical axis, so the silhouette stays round, not a rugby ball. */
  portraitEyeZ: 7.2,
  /** Desktop standoff, m. Low 0.22 m eye, full-width goal, resting ball
   *  stays in the lower band and visually round. */
  desktopEyeZ: 6.25,
  /** Level gaze only: no pitch, so the goal plane stays parallel to the image. */
  desktopPitch: 0,
};

/** Light for the real, cast ground shadow. High behind-left, like the reference. */
export const KEY_LIGHT = { x: -3.2, y: 7.5, z: 3.4 };

/** The ball's home, same world pose as RESTING (z = 4.05 m). */
export const HOME = { x: 0, y: BALL_RADIUS, z: 4.05 };

/**
 * Pointer/keyboard shot model (supersedes the old tap/flick/Enter auto-shot).
 *
 * One gesture: press and hold the ball to charge, then move toward the goal
 * to aim, then release. `charge` is 0..1 and maps to launch speed; the aim
 * point is where the pointer ray meets the goal plane z = 0, so the swipe
 * direction is the shot direction. A shot is only taken on release after the
 * long-press threshold, and physics — never input — decides the outcome.
 *
 * The same numbers are used by the Node tests, so input and trajectory cannot
 * drift apart. Do not add a tap-to-shoot path: a tap is a cancel.
 */
export const SHOT = {
  /** Hold this long before charging starts, ms. */
  longPressMs: 190,
  /** Charge time from 0 to full power after the long-press threshold, ms. */
  chargeMs: 1150,
  /** Launch speed at zero charge, m/s (barely a nudge). */
  minSpeed: 4.2,
  /** Launch speed at full charge, m/s. */
  maxSpeed: 14,
  /** A release below this charge is treated as a cancel, not a shot. */
  minCharge: 0.12,
  /** Pointer travel below this is not an aim, px. */
  aimDeadzonePx: 6,
  /** Keyboard aim step on the goal plane, m (Shift = fine). */
  aimStep: 0.24,
  aimFineStep: 0.07,
  /** Keyboard aim starts at this cell's centre (bottom row, centre column). */
  defaultAimCell: 2,
  /** Maximum upward elevation of a shot, radians (about 63°). The ball now
   *  rests deep near the goal, so a top-row shot has to be chipped; 45° would
   *  hit the divider from this range. */
  maxElevation: 1.1,
  /**
   * Measured release velocity: the pointer's own displacement/time over this
   * trailing window (ms), not the hold duration, sets the final flick boost.
   * Normalised by the shorter viewport side to "screen heights per second",
   * so a phone flick and a desktop flick of the same visual speed match.
   */
  releaseWindowMs: 90,
  releaseFullScreenPerSec: 3.0,
  /** Extra launch speed at a full-speed flick (fraction of charge speed). */
  releaseBoost: 0.22,
};

/**
 * Stable child-page routes for cells 1..10. `cell + 1` is the public id; the
 * path is relative to the site root so it works both from `/index.html` and
 * from a nested preview such as `/prototype/site/index.html` when the preview
 * has a sibling `target/` directory. perf-infra owns the pages: do not rename.
 */
export const CHILD_ROUTE = {
  base: 'target/',
  path(cell) {
    return `${CHILD_ROUTE.base}${cell + 1}/`;
  },
};

/** Cell index of an opening: column 0..4 left→right, row 0 = bottom. */
export function cellIndexOf(column, row) {
  return row * CELLS_X + column;
}
export function cellColumnRow(index) {
  return { column: index % CELLS_X, row: Math.floor(index / CELLS_X) };
}

/** The goal lattice in metres, shared by physics and the DOM layout. */
export const GOAL = {
  width: GOAL_WIDTH,
  height: GOAL_HEIGHT,
  bar: BAR,
  opening: OPENING,
  cellsX: CELLS_X,
  cellsY: CELLS_Y,
};

/** The resting ball centre (on the floor), 0.55 m in front of the phone lens. */
export const RESTING = { y: FLOOR_Y + BALL_RADIUS + 2e-4, x: 0, z: 4.05 };

/**
 * The framing contract (ROOM + CAMERA + FRAME), solved from the complete room.
 * See camera.js for the maths and the exact per-aspect crop.
 *
 *   • The lens looks straight down −Z from the goal's vertical centre
 *     (y = 1.205 m): phone at z = 5.00 m, desktop at z = 13.5 m. Real
 *     perspective, never orthographic, and no off-axis crop.
 *   • The goal at z = 0 fills 88 % of the frame width, leaving a 6 % margin
 *     on each side so floor, ceiling, left and right all show perspective.
 *   • The goal's optical centre is 50 % of the frame height from the top on
 *     both desktop and portrait (equal floor and ceiling bands).
 *   • Square pixels: tan(horizontal half-FOV) / tan(vertical half-FOV) equals
 *     the viewport aspect. The frustum is a symmetric pinhole (tanCentre = 0),
 *     so verticals stay vertical and the goal openings stay rectangular.
 *
 * `FRAME.nearZ` is the second half of the two-layer boundary: the ball may
 * never come nearer than the screen's bottom edge where it meets the floor.
 * `camera.js#framePlanes()` projects the viewport edges into the room to form
 * the first layer (left/right/top frame + near cap). Both layers are real
 * ball-plane constraints in physics; nothing is clamped after rendering.
 */
/**
 * Layer 2: screen placement on top of the real 3D render. The ball image is
 * shifted vertically (never scaled) so it can sit at the bottom edge while
 * the room/goal keep the true pinhole crop. The shift targets the sphere's
 * actual projected silhouette (not its bounding box), so the lower rim keeps
 * exactly `bottomMarginPx` and no part is clipped. The shift fades to zero as
 * the ball approaches the goal plane, so the ball still visually enters the
 * cell it physically crossed. `projectBall`/`unprojectFloor` invert this shift.
 */
export const LAYER2 = {
  /** Gap between the resting ball's lower rim and the viewport bottom, CSS px. */
  bottomMarginPx: 8,
  /** Fade the screen shift out between these goal-relative depths (m). */
  fadeStartZ: 0.20,
  fadeEndZ: 1.00,
};

export const FRAME = {
  /**
   * Near cap, m: the ball's centre never passes this plane. It is where the
   * screen's bottom edge (MIN_BOTTOM) meets the floor; solving the crop keeps
   * that edge below the default ball on every aspect.
   */
  nearZ: 4.75,
  /** Bounce off the visible frame: a firm, quiet rebound back into view. */
  restitution: 0.9,
  friction: 0.05,
};

/** Opening rectangle in the goal plane. */
export function openingRect(index) {
  const { column, row } = cellColumnRow(index);
  const left = -GOAL_WIDTH / 2 + BAR + column * (OPENING + BAR);
  const bottom = BAR + row * (OPENING + BAR);
  return {
    left,
    right: left + OPENING,
    bottom,
    top: bottom + OPENING,
    column,
    row,
    cx: left + OPENING / 2,
    cy: bottom + OPENING / 2,
  };
}

/** Which opening a point in the goal plane belongs to, or -1 (bar/outside). */
export function cellAt(x, y) {
  for (let i = 0; i < CELLS_X * CELLS_Y; i += 1) {
    const c = openingRect(i);
    if (x > c.left && x < c.right && y > c.bottom && y < c.top) return i;
  }
  return -1;
}
