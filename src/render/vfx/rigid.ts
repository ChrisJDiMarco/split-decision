// Minimal impulse-based rigid body for render-only debris. Each body is a mass with an
// isotropic inertia and a set of hull support points; contacts are the canvas plane and
// the cage (approximated by its inscribed circle). Enough to tumble, skid, roll and
// settle on a stable face like real hardware.
import * as THREE from 'three/webgpu';
import { FLOOR_Y, GRAVITY } from './coords';

export interface RigidBody {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  angVel: THREE.Vector3; // world frame, rad/s
  invMass: number;
  invInertia: number; // isotropic approximation, 1/(kg·m²)
  support: readonly THREE.Vector3[]; // body-frame hull points
  radius: number;
  restitution: number;
  friction: number;
  sleepTimer: number;
  asleep: boolean;
  touching: boolean;
}

export interface RigidEnv {
  /** Inscribed radius of the cage; bodies bounce off it. Infinity disables. */
  fenceRadius: number;
}

const AIR_DRAG_PER_S = 0.05;
const ROLL_DAMP_PER_S = 5;
/** Extra linear damping while resting on the canvas (rolling/skid losses). */
const CONTACT_DAMP_PER_S = 1.5;
const SLEEP_SPEED = 0.12;
const SLEEP_SPIN = 2.5;
const SLEEP_AFTER_S = 0.3;
const RESTING_SPEED = 0.35; // below this normal speed a contact does not bounce
const CONTACT_ITERATIONS = 4;
const FENCE_RESTITUTION = 0.25;

export function makeBody(
  support: readonly THREE.Vector3[], radius: number, massKg: number,
  opts: { restitution?: number; friction?: number } = {},
): RigidBody {
  // Solid sphere inertia of the bounding radius, shrunk: hardware is not a ball.
  const inertia = 0.4 * massKg * radius * radius * 0.6;
  return {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    invMass: 1 / massKg,
    invInertia: 1 / Math.max(inertia, 1e-9),
    support,
    radius,
    restitution: opts.restitution ?? 0.3,
    friction: opts.friction ?? 0.55,
    sleepTimer: 0,
    asleep: false,
    touching: false,
  };
}

export function wake(b: RigidBody): void {
  b.asleep = false;
  b.sleepTimer = 0;
}

const r = new THREE.Vector3();
const vp = new THREE.Vector3();
const rxn = new THREE.Vector3();
const t = new THREE.Vector3();
const rxt = new THREE.Vector3();
const dq = new THREE.Quaternion();
const N = new THREE.Vector3(0, 1, 0);

export function stepBody(b: RigidBody, dt: number, env: RigidEnv): void {
  if (b.asleep) return;
  b.vel.y -= GRAVITY * dt;
  const drag = Math.exp(-AIR_DRAG_PER_S * dt);
  b.vel.multiplyScalar(drag);
  b.pos.addScaledVector(b.vel, dt);
  integrateRotation(b, dt);
  b.touching = false;
  if (b.pos.y - b.radius < FLOOR_Y) {
    for (let k = 0; k < CONTACT_ITERATIONS; k++) solveFloor(b);
  }
  if (Number.isFinite(env.fenceRadius)) solveFence(b, env.fenceRadius);
  if (b.touching) {
    b.angVel.multiplyScalar(Math.exp(-ROLL_DAMP_PER_S * dt));
    b.vel.multiplyScalar(Math.exp(-CONTACT_DAMP_PER_S * dt));
  }
  updateSleep(b, dt);
}

function integrateRotation(b: RigidBody, dt: number): void {
  const w = b.angVel;
  const angle = w.length() * dt;
  if (angle < 1e-7) return;
  r.copy(w).normalize();
  dq.setFromAxisAngle(r, angle);
  b.quat.premultiply(dq).normalize();
}

/** Velocity impulses for every support point below the canvas, then push out. */
function solveFloor(b: RigidBody): void {
  let deepest = 0;
  for (const p of b.support) {
    r.copy(p).applyQuaternion(b.quat);
    const y = b.pos.y + r.y;
    if (y >= FLOOR_Y) continue;
    b.touching = true;
    deepest = Math.min(deepest, y - FLOOR_Y);
    // Velocity of the contact point.
    vp.copy(b.angVel).cross(r).add(b.vel);
    const vn = vp.y;
    if (vn >= 0) continue;
    rxn.copy(r).cross(N);
    const k = b.invMass + b.invInertia * rxn.lengthSq();
    const e = -vn > RESTING_SPEED ? b.restitution : 0;
    const jn = (-(1 + e) * vn) / k;
    b.vel.y += jn * b.invMass;
    b.angVel.addScaledVector(rxn, jn * b.invInertia);
    applyFriction(b, jn);
  }
  if (deepest < 0) b.pos.y -= deepest;
}

function applyFriction(b: RigidBody, jn: number): void {
  vp.copy(b.angVel).cross(r).add(b.vel);
  t.set(vp.x, 0, vp.z);
  const vt = t.length();
  if (vt < 1e-6) return;
  t.divideScalar(vt);
  rxt.copy(r).cross(t);
  const kt = b.invMass + b.invInertia * rxt.lengthSq();
  const jt = Math.min(vt / kt, b.friction * jn);
  b.vel.addScaledVector(t, -jt * b.invMass);
  b.angVel.addScaledVector(rxt, -jt * b.invInertia);
}

function solveFence(b: RigidBody, fenceRadius: number): void {
  const d = Math.hypot(b.pos.x, b.pos.z);
  const limit = fenceRadius - b.radius;
  if (d <= limit || d < 1e-6) return;
  const nx = b.pos.x / d;
  const nz = b.pos.z / d;
  b.pos.x = nx * limit;
  b.pos.z = nz * limit;
  const vn = b.vel.x * nx + b.vel.z * nz;
  if (vn > 0) {
    b.vel.x -= (1 + FENCE_RESTITUTION) * vn * nx;
    b.vel.z -= (1 + FENCE_RESTITUTION) * vn * nz;
  }
}

function updateSleep(b: RigidBody, dt: number): void {
  const still = b.touching && b.vel.lengthSq() < SLEEP_SPEED * SLEEP_SPEED && b.angVel.lengthSq() < SLEEP_SPIN * SLEEP_SPIN;
  b.sleepTimer = still ? b.sleepTimer + dt : 0;
  if (b.sleepTimer > SLEEP_AFTER_S) {
    b.asleep = true;
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
  }
}
