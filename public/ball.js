/**
 * The ball's VIEW. The physics world (physics.js) owns position, velocity and
 * spin; this module only derives the mesh pose from that one state:
 *
 *   • position = interpolation of the previous and current physics centres
 *     by the frame alpha (never extrapolated) — the cast shadow moves with
 *     the same ballGroup, so floor shadow and ball share one state;
 *   • orientation = rolling without slipping while supported (ω = (−vz, 0, vx)/R
 *     accumulated as dq = exp(ω·dt/2) in world space) and the physics spin axis
 *     while airborne. Reduced motion keeps the rest pose and does not spin.
 *
 * Loading: scene.loadModel() exposes the validated PBR Blender GLB. There is
 * no visible fallback; ball-view.js withholds the ball until every map is
 * decoded, so this module never animates an untextured stand-in.
 */

import * as THREE from './three.js?v=2026.11.23-r10';
import { BALL_RADIUS } from './config.js?v=2026.11.23-r10';

/** A three-quarter rest pose so the leather reads from the camera. */
const REST = new THREE.Euler(0.18, -0.5, 0.06, 'XYZ');

export function createBall({ scene, reduceMotion }) {
  const quat = new THREE.Quaternion().setFromEuler(REST);
  const spinQ = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  let lastPos = null;
  let impact = 0;
  let impactAxis = 'y';
  const scale = new THREE.Vector3(1, 1, 1);

  /**
   * @param {{pos:{x,y,z}, vel:{x,y,z}, spin:{x,y,z}}} prev
   * @param {{pos:{x,y,z}, vel:{x,y,z}, spin:{x,y,z}}} cur
   * @param {number} alpha interpolation in [0, 1]
   * @param {number} dt frame duration, seconds (for spin integration)
   */
  function sync(prev, cur, alpha, dt) {
    const a = Math.max(0, Math.min(1, alpha));
    pos.set(
      prev.pos.x + (cur.pos.x - prev.pos.x) * a,
      prev.pos.y + (cur.pos.y - prev.pos.y) * a,
      prev.pos.z + (cur.pos.z - prev.pos.z) * a,
    );
    // Rolling is bound to the ARC actually travelled, not to a guessed
    // speed: distance / radius is the exact contact rotation for a sphere.
    const travel = Math.hypot(cur.pos.x - prev.pos.x, cur.pos.z - prev.pos.z);
    if (cur.quat) {
      // Rapier is authoritative: the rigid body's rotation IS the mesh pose.
      quat.set(cur.quat.x, cur.quat.y, cur.quat.z, cur.quat.w).normalize();
    } else if (!reduceMotion()) {
      if (cur.supported && travel > 1e-7) {
        axis.set(cur.pos.z - prev.pos.z, 0, -(cur.pos.x - prev.pos.x)).normalize();
        spinQ.setFromAxisAngle(axis, travel / BALL_RADIUS);
        quat.premultiply(spinQ).normalize();
      } else if (Math.abs(cur.vel.y) > 0.05) {
        const m = Math.hypot(cur.spin.x, cur.spin.z);
        if (m > 1e-3) {
          axis.set(cur.spin.z, 0, -cur.spin.x).normalize();
          spinQ.setFromAxisAngle(axis, Math.min(m, 40) * dt * 0.25);
          quat.premultiply(spinQ).normalize();
        }
      }
    }

    // Short contact compression along the collision normal, then a natural
    // spring back. The deformation is derived from the same physics state as
    // position and spin; it never invents a second pose.
    const bounceY = prev.vel.y < -0.55 && cur.vel.y > 0.08;
    const bounceX = Math.sign(prev.vel.x) !== Math.sign(cur.vel.x) && Math.abs(prev.vel.x) > 0.7;
    const bounceZ = Math.sign(prev.vel.z) !== Math.sign(cur.vel.z) && Math.abs(prev.vel.z) > 0.7;
    if (bounceY || bounceX || bounceZ) {
      impactAxis = bounceY ? 'y' : (bounceX ? 'x' : 'z');
      const speed = bounceY ? Math.abs(prev.vel.y) : Math.abs(bounceX ? prev.vel.x : prev.vel.z);
      impact = Math.max(impact, Math.min(1, 0.35 + speed / 12));
    }
    impact *= Math.exp(-dt * 11);
    if (impact < 0.002) impact = 0;
    const k = impact * 0.16;
    if (impactAxis === 'y') scale.set(1 + k * 0.55, 1 - k, 1 + k * 0.55);
    else if (impactAxis === 'x') scale.set(1 - k, 1 + k * 0.35, 1 + k * 0.55);
    else scale.set(1 + k * 0.55, 1 + k * 0.35, 1 - k);
    if (scene.ballGroup) scene.ballGroup.scale.copy(scale);

    lastPos = pos.clone();
    scene.setPose(pos, quat);
    return pos;
  }

  /** Place immediately (a drag), without spin. */
  function place(p) {
    pos.set(p.x, p.y, p.z);
    impact = 0;
    if (scene.ballGroup) scene.ballGroup.scale.set(1, 1, 1);
    scene.setPose(pos, quat);
  }

  function resetPose() {
    quat.setFromEuler(REST);
    impact = 0;
    if (scene.ballGroup) scene.ballGroup.scale.set(1, 1, 1);
    scene.setPose(lastPos ?? pos, quat);
  }

  return { sync, place, resetPose, get position() { return lastPos ?? pos; } };
}
