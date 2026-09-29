// Third-person chase camera: over the right shoulder of the player's robot, locked on to the
// opponent (the lens stays behind the player on the line to him), mouse orbit within limits,
// smooth follow, and collision-aware: the lens is pulled in (and lifted) so the cage posts,
// top rails, truss and fixtures never sit between it and the robot, and it never leaves the
// fence. Occlusion uses the camera director's analytic sightline model (read-only import).
//
// Physics frame throughout (z-up, metres); the class converts to the three.js world once.
import * as THREE from 'three/webgpu';
import type { SimEvent } from '../core/protocol';
import type { Corner, Vec3 } from '../core/types';
import { CameraShake } from '../render/camera/shake';
import { firstBlocker, insideCage } from '../render/camera/sightlines';
import type { Stage } from '../render/stage';
import { hitStrength } from '../render/vfx/scaling';
import { CHASE } from './config';

export interface ChaseSubjects {
  me: Vec3; // player's COM
  meHeadZ: number;
  opp: Vec3; // opponent's COM
  oppHeadZ: number;
  down: boolean; // player knocked down
}

export interface ChaseView {
  yawOffset: number; // mouse orbit around the lock-on line, rad (+ turns the view to the left)
  pitch: number; // look-down angle, rad
}

export interface ChasePose {
  pos: Vec3;
  target: Vec3;
  fov: number;
  pivot: Vec3;
  /** Fraction of the full boom the lens could keep (1 = unobstructed; 0 = the overhead fallback). */
  boomShare: number;
  /** How far (rad) the lens had to swing around the robot to find a clear view. */
  swing: number;
  /** How much (rad) the pitch had to lift above the view's to find a clear view. */
  lift: number;
}

const CHEST_BELOW_HEAD_M = 0.35;
const PITCH_LIFTS = [0, 0.3, 0.6];
const SWINGS = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6];
const SHARE_STEP = 0.06;
const OVERHEAD_IN_M = 0.9;
const OVERHEAD_UP_M = 1.8;
const GOOD_SHARE = 0.7;
const MIN_Z = 0.3;
const MAX_PITCH_LIFTED = 1.2;
const PIVOT_MIN_Z = 1.0;

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Bearing from me to him (rad, CCW from +x). */
export function lockYaw(me: Vec3, opp: Vec3): number {
  return Math.atan2(opp[1] - me[1], opp[0] - me[0]);
}

/** Can the lens sit at `p`, seeing `pivot` and `target` past the arena hardware? */
export function clearLens(p: Vec3, pivot: Vec3, target: Vec3): boolean {
  return p[2] > MIN_Z && insideCage(p, CHASE.CAGE_INSET_M) && !firstBlocker(pivot, p, CHASE.HARDWARE_MARGIN_M) && !firstBlocker(p, target, 0);
}

/**
 * The chase pose for a lock-on bearing `yaw0` (the smoothed me → opponent bearing): the lens
 * behind the pivot along yaw0 + yawOffset, pulled in along the boom until it is clear. If the
 * boom must shrink a lot (backed onto the fence, under a truss beam) the lens also tries lifting
 * and swinging around the robot, preferring the side it swung to last frame (`preferSwing`) so
 * it doesn't flip between sides. While the plain view is blocked, last frame's swing and lift
 * (`prev`) are kept as long as they still frame well, so the lens doesn't hop between near-equal
 * candidates frame to frame (a robot pinned on the fence).
 */
export function solveChase(
  s: ChaseSubjects, view: ChaseView, yaw0: number, preferSwing: 1 | -1 = 1, prev: Pick<ChasePose, 'swing' | 'lift'> | null = null,
): ChasePose {
  const meChest: Vec3 = [s.me[0], s.me[1], Math.max(0.5, s.meHeadZ - CHEST_BELOW_HEAD_M)];
  const oppChest: Vec3 = [s.opp[0], s.opp[1], Math.max(0.5, s.oppHeadZ - CHEST_BELOW_HEAD_M)];
  const target = lerp3(meChest, oppChest, CHASE.LOOK_SHARE);
  const basePitch = view.pitch + (s.down ? CHASE.DOWN_PITCH_RAD : 0);
  const plain = lensAt(s, target, yaw0 + view.yawOffset, basePitch, 0, 0);
  if (plain && plain.boomShare >= GOOD_SHARE) return plain;
  if (prev && (prev.swing !== 0 || prev.lift !== 0)) {
    const kept = lensAt(s, target, yaw0 + view.yawOffset, basePitch, prev.swing, prev.lift);
    if (kept && kept.boomShare >= GOOD_SHARE) return kept;
  }
  let best = plain;
  for (const swing of SWINGS) {
    for (const lift of PITCH_LIFTS) {
      if (swing === 0 && lift === 0) continue;
      const p = lensAt(s, target, yaw0 + view.yawOffset, basePitch, swing * preferSwing, lift);
      if (p && (!best || p.boomShare > best.boomShare + 1e-9)) best = p;
      if (best && best.boomShare >= GOOD_SHARE) return best;
    }
  }
  return best ?? overhead(s, target);
}

/** One candidate: the lens swung `swing` around the robot and lifted `lift`, on the longest clear boom (or null). */
function lensAt(s: ChaseSubjects, target: Vec3, yawBase: number, basePitch: number, swing: number, lift: number): ChasePose | null {
  const yaw = yawBase + swing;
  const fwd: [number, number] = [Math.cos(yaw), Math.sin(yaw)];
  const right: [number, number] = [fwd[1], -fwd[0]]; // fwd × z
  const pivot: Vec3 = [
    s.me[0] + right[0] * CHASE.SHOULDER_M,
    s.me[1] + right[1] * CHASE.SHOULDER_M,
    Math.max(PIVOT_MIN_Z, s.meHeadZ + CHASE.PIVOT_ABOVE_HEAD_M),
  ];
  const pitch = Math.min(MAX_PITCH_LIFTED, basePitch + lift);
  const full: Vec3 = [
    pivot[0] - fwd[0] * Math.cos(pitch) * CHASE.BOOM_M,
    pivot[1] - fwd[1] * Math.cos(pitch) * CHASE.BOOM_M,
    pivot[2] + Math.sin(pitch) * CHASE.BOOM_M,
  ];
  for (let share = 1; share >= CHASE.MIN_BOOM_SHARE - 1e-9; share -= SHARE_STEP) {
    const p = lerp3(pivot, full, share);
    if (clearLens(p, pivot, target)) return { pos: p, target, fov: CHASE.FOV_DEG, pivot, boomShare: share, swing, lift };
  }
  return null;
}

/** Nothing clear at all: hang the lens above the player, nudged toward the middle of the cage. */
function overhead(s: ChaseSubjects, target: Vec3): ChasePose {
  const r = Math.hypot(s.me[0], s.me[1]);
  const k = r > 1e-6 ? Math.max(0, r - OVERHEAD_IN_M) / r : 0;
  const pos: Vec3 = [s.me[0] * k, s.me[1] * k, Math.max(PIVOT_MIN_Z, s.meHeadZ) + OVERHEAD_UP_M];
  return { pos, target, fov: CHASE.FOV_DEG, pivot: pos, boomShare: 0, swing: 0, lift: 0 };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(1e-4, tau));

type CamStage = Pick<Stage, 'camera' | 'controls' | 'physicsRoot'>;

interface SavedControls {
  enabled: boolean;
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
}

/** Drives the stage camera while player mode owns it. */
export class ChaseCamera {
  active = false;
  view: ChaseView = { yawOffset: 0, pitch: CHASE.PITCH_RAD };
  last: ChasePose | null = null;
  private yaw: number | null = null;
  private swingSide: 1 | -1 = 1;
  private pos: Vec3 | null = null;
  private target: Vec3 | null = null;
  private saved: SavedControls | null = null;
  private readonly shake = new CameraShake();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly rootQuat = new THREE.Quaternion();

  constructor(private readonly stage: CamStage, private readonly corner: Corner) {}

  activate(): void {
    if (this.active) return;
    this.active = true;
    const c = this.stage.controls;
    this.saved = { enabled: c.enabled, minDistance: c.minDistance, maxDistance: c.maxDistance, minPolarAngle: c.minPolarAngle, maxPolarAngle: c.maxPolarAngle };
    // Stage.render()/post.render() call controls.update(), which re-aims at controls.target and
    // clamps the orbit: lift the limits so it leaves the chase pose alone (as CameraRig does).
    Object.assign(c, { enabled: false, minDistance: 0, maxDistance: Infinity, minPolarAngle: 0, maxPolarAngle: Math.PI });
    this.snap();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this.saved) Object.assign(this.stage.controls, this.saved);
    this.saved = null;
  }

  /** Jump to the solved pose on the next update (after a cut or a reset). */
  snap(): void {
    this.pos = null;
    this.target = null;
    this.yaw = null;
  }

  /** Mouse look in pixels; after RECENTER_AFTER_S without it, the orbit eases back behind the robot. */
  look(dx: number, dy: number, idleS: number, dt: number): void {
    const v = this.view;
    const yawOffset = v.yawOffset - dx * CHASE.MOUSE_RAD_PER_PX;
    const pitch = v.pitch + dy * CHASE.MOUSE_RAD_PER_PX;
    const recenter = idleS > CHASE.RECENTER_AFTER_S ? ease(dt, CHASE.RECENTER_TAU_S) : 0;
    this.view = {
      yawOffset: Math.max(-CHASE.YAW_LIMIT_RAD, Math.min(CHASE.YAW_LIMIT_RAD, yawOffset)) * (1 - recenter),
      pitch: Math.max(CHASE.PITCH_MIN, Math.min(CHASE.PITCH_MAX, pitch)),
    };
  }

  /** Impacts shake the lens; hits on the player's own robot shake it harder. */
  onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.kind === 'impact') {
        const strike = e.striker !== null && e.victim !== null && e.striker !== e.victim;
        const s = strike ? hitStrength(e.energyJ, e.impulseNs, e.speed) : 0;
        const mine = e.victim === this.corner ? 1.25 : 0.8;
        this.shake.add(Math.max(CameraShake.forEnergy(e.energyJ), CameraShake.forStrength(s)) * mine);
        if (strike) this.shake.kick(e.normal, s * mine);
      } else if (e.kind === 'detach') this.shake.add(0.5);
      else if (e.kind === 'fall') this.shake.add(e.corner === this.corner ? 0.45 : 0.3);
    }
  }

  update(dt: number, s: ChaseSubjects): void {
    const offset = this.shake.update(dt);
    if (!this.active) return;
    const bearing = lockYaw(s.me, s.opp);
    this.yaw = this.yaw === null ? bearing : this.yaw + wrap(bearing - this.yaw) * ease(dt, CHASE.LOCK_TAU_S);
    const pose = solveChase(s, this.view, this.yaw, this.swingSide, this.last);
    if (pose.swing !== 0) this.swingSide = pose.swing > 0 ? 1 : -1;
    this.last = pose;
    if (!this.pos || !this.target) {
      this.pos = pose.pos;
      this.target = pose.target;
    } else {
      // Pulling in for an obstacle is fast; easing back out is gentle.
      const dNow = Math.hypot(this.pos[0] - pose.pivot[0], this.pos[1] - pose.pivot[1], this.pos[2] - pose.pivot[2]);
      const dNew = Math.hypot(pose.pos[0] - pose.pivot[0], pose.pos[1] - pose.pivot[1], pose.pos[2] - pose.pivot[2]);
      this.pos = lerp3(this.pos, pose.pos, ease(dt, dNew < dNow - 0.05 ? CHASE.POS_IN_TAU_S : CHASE.POS_TAU_S));
      this.target = lerp3(this.target, pose.target, ease(dt, CHASE.TARGET_TAU_S));
    }
    this.applyToStage(this.pos, this.target, pose.fov, offset);
  }

  private applyToStage(pos: Vec3, target: Vec3, fov: number, shake: Vec3): void {
    const { camera, controls, physicsRoot } = this.stage;
    physicsRoot.updateMatrixWorld();
    physicsRoot.getWorldQuaternion(this.rootQuat);
    const off = this.tmp2.set(shake[0], shake[1], shake[2]).applyQuaternion(this.rootQuat);
    physicsRoot.localToWorld(this.tmp.set(pos[0], pos[1], pos[2]));
    camera.position.copy(this.tmp).add(off);
    physicsRoot.localToWorld(this.tmp.set(target[0], target[1], target[2]));
    controls.target.copy(this.tmp).add(off);
    camera.lookAt(controls.target);
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
