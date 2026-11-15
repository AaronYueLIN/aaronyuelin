/**
 * The physical camera and its framing, in pure maths (no DOM, no three.js).
 *
 * One level pinhole camera, on-axis, with a per-form-factor real standoff:
 *
 *   • the eye sits at the goal's vertical centre (y = GOAL_HEIGHT / 2) and
 *     looks straight down the room (−Z) with no pitch and no off-axis crop,
 *     so floor and ceiling take equal area and the 2×5 is a true rectangle;
 *   • portrait stands on the near face at z = ROOM.maxZ (5.00 m);
 *   • desktop stands farther back at CAMERA.desktopEyeZ, far enough that the
 *     resting ball stays fully in frame;
 *   • `goalFill` < 1 leaves a side margin, so left, right, floor and ceiling
 *     all show a band of perspective around the lattice.
 *
 * The projection is a symmetric pinhole (tanTop = −tanBottom, tanCentre = 0).
 * Square pixels: tanH / tanV equals the viewport aspect.
 */

import {
  BALL_RADIUS,
  CAMERA,
  FRAME,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  ROOM,
} from './config.js';

const DEG = Math.PI / 180;

/** Camera position, metres. */
export const EYE = Object.freeze({ ...CAMERA.eye });
/** The distance from the lens to the goal plane. */
export const DEPTH = EYE.z;
/** tan of the horizontal half-angle that makes the goal span the frame. */
export const GOAL_HALF_TAN = ((GOAL_WIDTH / 2) * CAMERA.goalFill) / DEPTH;
/** tan of the ray from the lens to the goal's vertical centre. */
export const GOAL_CENTRE_TAN = (GOAL_HEIGHT / 2 - EYE.y) / DEPTH;
/** tan of the ray to the room's top edge (plus a small optical margin). */
export const TOP_TAN = (GOAL_HEIGHT + CAMERA.topMargin - EYE.y) / DEPTH;
/** tan of the shallowest allowed bottom edge, from FRAME.nearZ. */
export const MIN_BOTTOM_TAN = -EYE.y / (EYE.z - CAMERA.framingNearZ);
/** Same bound in degrees (used by the docs / diagnostics). */
export const MIN_BOTTOM_DEG = Math.atan(MIN_BOTTOM_TAN) / DEG;
/** The goal's centre as a fraction of frame height from the top. */
export const GOAL_SCREEN_Y = CAMERA.goalScreenY;
/** Portrait crops raise the goal slightly (middle / middle-upper). */
export const PORTRAIT_GOAL_SCREEN_Y = CAMERA.portraitGoalScreenY;
/** Never let the goal fill more than this share of the frame height. */
export const MAX_GOAL_FRACTION = 0.74;
/** The goal's vertical span in tangent space (invariant of the room). */
export const GOAL_SPAN_TAN = GOAL_HEIGHT / DEPTH;

/**
 * Solve the viewport crop for a CSS-pixel frame.
 *
 * The eye z (and therefore the goal-plane depth) is per form factor: portrait
 * uses the near-face phone lens, landscape the farther desktop standoff. The
 * rest of the solve is identical, so both crops keep a full-width goal whose
 * optical centre is at the same fraction of the frame and whose openings stay
 * square (no pitch, square pixels).
 *
 * @param {number} width  CSS px
 * @param {number} height CSS px
 * @returns {{
 *   width:number, height:number, aspect:number,
 *   tanH:number, tanV:number, tanTop:number, tanBottom:number, tanCentre:number,
 *   eye:{x:number,y:number,z:number}, projection:string, pitch:number,
 *   depth:number, goalScreenY:number, goalWidthFraction:number,
 *   goalHeightFraction:number, nearZ:number
 * }}
 */
export function framingFor(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const aspect = w / h;
  const portrait = aspect < 1;
  const goalScreenY = portrait ? PORTRAIT_GOAL_SCREEN_Y : GOAL_SCREEN_Y;
  const eyeY = portrait ? CAMERA.portraitEyeY : EYE.y;
  const eyeZ = portrait ? (CAMERA.portraitEyeZ ?? EYE.z) : (CAMERA.desktopEyeZ ?? EYE.z);
  const pitch = 0;
  const eye = { x: EYE.x, y: eyeY, z: eyeZ };
  const depth = eyeZ; // the goal plane is z = 0
  // Phone: fill < 1 leaves a side margin. Desktop: fill = 1, full width.
  const fill = portrait
    ? (CAMERA.portraitGoalFill ?? 0.88)
    : (CAMERA.goalFill ?? 1);
  const tanH = (GOAL_WIDTH / 2) / (fill * depth);
  const tanV = tanH / aspect; // square pixels: tanH / tanV = aspect
  // Phone eye is on the goal centre, so the frustum is symmetric
  // (equal floor/ceiling). Desktop uses a low eye and an off-axis crop
  // so the 2×5 stays vertically centred.
  const goalCentreTan = (GOAL_HEIGHT / 2 - eyeY) / depth;
  const tanCentre = portrait ? 0 : goalCentreTan - (1 - 2 * goalScreenY) * tanV;
  const tanTop = tanCentre + tanV;
  const tanBottom = tanCentre - tanV;
  const goalHalfTan = (GOAL_WIDTH / 2) / depth;

  const goalWidthFraction = goalHalfTan / tanH;
  const goalHeightFraction = (GOAL_HEIGHT / depth) / (2 * tanV);
  // The visible floor's nearest point on the vertical centre line.
  const nearZ = tanBottom < 0 ? eyeZ - eyeY / -tanBottom : eyeZ;

  return {
    width: w,
    height: h,
    aspect,
    tanH,
    tanV,
    tanTop,
    tanBottom,
    tanCentre,
    eye,
    projection: 'perspective',
    pitch,
    depth,
    goalScreenY,
    goalWidthFraction,
    goalHeightFraction,
    nearZ,
  };
}

/**
 * World point → CSS px in the frame. Returns null for points at/behind the
 * lens (the room never contains one, but callers stay safe).
 *
 * Derivation: camera at the origin looking down −Z, symmetric frustum
 * (left/right = ±tanH, top/bottom = ±tanV, tanCentre = 0). A point at
 * depth d maps to NDC x = x/(d·tanH), NDC y = (y/d − tanCentre)/tanV.
 */
export function projectPoint(framing, p) {
  const depth = framing.eye.z - p.z;
  if (!(depth > 0)) return null;
  const ndcX = (p.x - framing.eye.x) / (depth * framing.tanH);
  const ndcY = ((p.y - framing.eye.y) / depth - framing.tanCentre) / framing.tanV;
  return {
    x: (ndcX * 0.5 + 0.5) * framing.width,
    y: (0.5 - ndcY * 0.5) * framing.height,
    ndcX,
    ndcY,
    depth,
  };
}

/**
 * Screen-space half-extents of a sphere's true silhouette.
 *
 * The outline of a sphere is the circle where the view rays are tangent to
 * it, on the sphere's near side. Projecting that circle is exact for an
 * off-axis ball; projecting the world AABB (the old approach) overstates the
 * vertical radius by 30–80 % at the portrait eye, which floated the ball far
 * above the bottom edge or clipped it when the target was a percentage.
 *
 * Returns distances from the projected centre, in CSS px, or null when the
 * sphere is behind/on the lens.
 */
export function projectSphereExtent(framing, p, radius = BALL_RADIUS) {
  const at = projectPoint(framing, p);
  if (!at) return null;
  const dx = p.x - framing.eye.x;
  const dy = p.y - framing.eye.y;
  const dz = p.z - framing.eye.z; // negative: the room is in front of the lens
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > radius * 1.001)) return null;

  // Unit vector from the lens to the sphere centre.
  const nx = dx / distance;
  const ny = dy / distance;
  const nz = dz / distance;
  // Any orthonormal pair (u, v) perpendicular to n spans the tangent circle.
  let ux;
  let uy;
  let uz;
  if (Math.abs(ny) < 0.9) {
    ux = nz; uy = 0; uz = -nx;
  } else {
    ux = 0; uy = -nz; uz = ny;
  }
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  // Tangent-circle centre and radius on the sphere's near side.
  const foot = (radius * radius) / distance;
  const ring = radius * Math.sqrt(Math.max(0, 1 - (radius * radius) / (distance * distance)));
  const cx = p.x - nx * foot;
  const cy = p.y - ny * foot;
  const cz = p.z - nz * foot;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const steps = 48;
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const q = projectPoint(framing, {
      x: cx + ring * (ux * ca + vx * sa),
      y: cy + ring * (uy * ca + vy * sa),
      z: cz + ring * (uz * ca + vz * sa),
    });
    if (!q) continue;
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    at,
    left: at.x - minX,
    right: maxX - at.x,
    top: at.y - minY,
    bottom: maxY - at.y,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * CSS px → the point where that ray meets the horizontal plane z = planeZ.
 * Returns null when the plane is behind the lens or off the visible cone.
 */
export function unprojectToPlane(framing, x, y, planeZ = 0) {
  const depth = framing.eye.z - planeZ;
  if (!(depth > 0)) return null;
  const ndcX = (x / framing.width) * 2 - 1;
  const ndcY = 1 - (y / framing.height) * 2;
  const dx = ndcX * framing.tanH;
  const dy = framing.tanCentre + ndcY * framing.tanV;
  return {
    x: framing.eye.x + dx * depth,
    y: framing.eye.y + dy * depth,
    z: planeZ,
  };
}

/**
 * CSS px → the point where the ray meets the horizontal floor plane
 * `y = planeY`. Used by the drag gesture; returns null for rays that do not
 * descend onto the floor.
 */
export function unprojectToFloor(framing, x, y, planeY = 0) {
  const ndcX = (x / framing.width) * 2 - 1;
  const ndcY = 1 - (y / framing.height) * 2;
  const dx = ndcX * framing.tanH;
  const dy = framing.tanCentre + ndcY * framing.tanV;
  const dz = -1;
  if (dy >= -1e-6) return null;
  const t = (planeY - framing.eye.y) / dy;
  if (!(t > 0)) return null;
  return { x: framing.eye.x + dx * t, y: planeY, z: framing.eye.z + dz * t };
}

/** The lateral / top half-width of the *visible* cone at depth z. */
export function frameHalfWidthAt(framing, z) {
  return framing.tanH * (framing.eye.z - z);
}
export function frameTopAt(framing, z) {
  return framing.eye.y + framing.tanTop * (framing.eye.z - z);
}

/**
 * The first hard boundary, in world space: the truncated pyramid of the
 * viewport projected back into the room.
 *
 * Each plane is `{ nx, ny, nz, d, edge }` with the inside half-space
 * `n·p ≤ d`; `d` already includes the ball radius, measured perpendicular to
 * the plane. The planes are the left/right viewport edges, the top edge, and
 * a near cap where the bottom edge meets the floor. They are identical on
 * every device: the desktop and phone crops share them, so a ball that is
 * visible on one is visible on the other.
 *
 * @param {number} [radius]
 * @param {{x:number,y:number,z:number}} [eye]
 */
export function framePlanes(radius = BALL_RADIUS, eye = EYE) {
  const tanH = GOAL_HALF_TAN;
  const tanTop = TOP_TAN;
  const ln = Math.hypot(1, tanH);
  const lnTop = Math.hypot(1, tanTop);
  // Plane through the lens and the goal's left/right edge x = ±tanH·(eye.z−z).
  const sideD = (tanH * eye.z) / ln - radius;
  // Plane through the lens and the room top at the goal plane.
  const topD = (eye.y + tanTop * eye.z) / lnTop - radius;
  // Near cap: the ball centre may not pass the line where the bottom edge
  // meets the floor; keep the whole ball behind it.
  const capZ = FRAME.nearZ - radius;
  return [
    { edge: 'right', nx: 1 / ln, ny: 0, nz: tanH / ln, d: sideD },
    { edge: 'left', nx: -1 / ln, ny: 0, nz: tanH / ln, d: sideD },
    { edge: 'top', nx: 0, ny: 1 / lnTop, nz: tanTop / lnTop, d: topD },
    { edge: 'near', nx: 0, ny: 0, nz: 1, d: capZ },
  ];
}

/** The room's central line at the near cap, for diagnostics. */
export const FRAME_NEAR_Z = FRAME.nearZ;
