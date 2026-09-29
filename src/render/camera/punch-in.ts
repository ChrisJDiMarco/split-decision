// Camera punch-in: on a big hit the lens pushes toward the contact and squeezes its field of
// view for a beat, then settles back; a KO or a head knockoff gets a slow, dramatic push-in
// that holds on the moment until the replay takes over. The punch is layered on top of the
// director's shot by the rig (after its easing, so the attack stays sharp).
//
// Sight lines stay the director's: constrainPunch() re-checks the punched pose with
// checkPose() and backs the punch off (half, then none) if it would put arena hardware or a
// fighter in front of the subjects, or push a cage-side lens through the fence. Cropping the
// frame is the point, so only the framing rule is waived. Pure logic in the physics frame, unit tested.
import type { Vec3 } from '../../core/types';
import { HIT } from '../vfx/scaling';
import { checkPose } from './shot-plan';
import { insideCage } from './sightlines';
import type { CameraPose, Shot, Subjects } from './shots';

export const PUNCH = {
  ATTACK_S: 0.045,
  DECAY_S: 0.3,
  PUSH: 0.12, // share of the lens-to-contact distance a full-strength hit pushes in
  MAX_PUSH_M: 0.9,
  AIM: 0.3, // share of the way the aim point slides toward the contact
  FOV_SQUEEZE: 0.08, // FOV shrinks by this share at full strength
  DRAMA_S: 1.2, // KO push-in duration
  DRAMA_PUSH: 0.26,
  DRAMA_MAX_PUSH_M: 3.2,
  DRAMA_AIM: 0.75,
  DRAMA_FOV_SQUEEZE: 0.2,
  REPLAY_SCALE: 0.5, // punches during a replay
} as const;

/** What the rig layers on top of the shot this frame. `point` is in the physics frame. */
export interface PunchFx {
  point: Vec3;
  push: number; // 0..1 share of the lens-to-point distance
  maxPushM: number;
  aim: number; // 0..1 share of the aim-to-point distance
  fovScale: number; // multiplies the shot's FOV (< 1 squeezes)
}

/** Where the drama push-in aims: a fixed point, or a live one (the flying head, the falling loser). */
export type DramaTarget = Vec3 | ((s: Subjects) => Vec3 | null);

export class PunchIn {
  private hitT = Infinity;
  private hitAmount = 0;
  private hitPoint: Vec3 = [0, 0, 1];
  private dramaT = -1;
  private dramaTarget: DramaTarget | null = null;
  private dramaPoint: Vec3 | null = null;

  /** A landed hit of strength 0..1 at `point` (below HIT.RING nothing happens). */
  hit(point: Vec3, strength: number, scale = 1): void {
    if (strength < HIT.RING || this.dramaT >= 0) return;
    const amount = Math.min(1, (strength - HIT.RING) / (1 - HIT.RING) * 0.75 + 0.25) * scale;
    // A fresh hit only takes over if it's bigger than what's left of the current one.
    if (amount < this.currentHit()) return;
    this.hitAmount = amount;
    this.hitT = 0;
    this.hitPoint = [point[0], point[1], point[2]];
  }

  /** Start (or retarget) the KO / knockoff push-in. It holds until reset(). */
  drama(target: DramaTarget): void {
    if (this.dramaT < 0) this.dramaT = 0;
    this.dramaTarget = target;
  }

  get dramatic(): boolean {
    return this.dramaT >= 0;
  }

  reset(): void {
    this.hitT = Infinity;
    this.hitAmount = 0;
    this.dramaT = -1;
    this.dramaTarget = null;
    this.dramaPoint = null;
  }

  private currentHit(): number {
    const t = this.hitT;
    if (!Number.isFinite(t)) return 0;
    if (t < PUNCH.ATTACK_S) return this.hitAmount * smooth(t / PUNCH.ATTACK_S);
    return this.hitAmount * Math.exp(-(t - PUNCH.ATTACK_S) / PUNCH.DECAY_S);
  }

  /** Advance (wall time) and return this frame's punch, or null when there is none. */
  update(dt: number, s: Subjects): PunchFx | null {
    if (this.dramaT >= 0) {
      this.dramaT += dt;
      const tgt = this.dramaTarget;
      const p = typeof tgt === 'function' ? tgt(s) : tgt;
      if (p) this.dramaPoint = [p[0], p[1], p[2]];
      if (!this.dramaPoint) return null;
      const k = smooth(Math.min(1, this.dramaT / PUNCH.DRAMA_S));
      return { point: this.dramaPoint, push: PUNCH.DRAMA_PUSH * k, maxPushM: PUNCH.DRAMA_MAX_PUSH_M, aim: PUNCH.DRAMA_AIM * k, fovScale: 1 - PUNCH.DRAMA_FOV_SQUEEZE * k };
    }
    if (!Number.isFinite(this.hitT)) return null;
    this.hitT += dt;
    const a = this.currentHit();
    if (this.hitT > PUNCH.ATTACK_S && a < 0.012) {
      this.hitT = Infinity;
      return null;
    }
    return { point: this.hitPoint, push: PUNCH.PUSH * a, maxPushM: PUNCH.MAX_PUSH_M, aim: PUNCH.AIM * a, fovScale: 1 - PUNCH.FOV_SQUEEZE * a };
  }
}

/** The pose the rig will show with this punch applied (same math as CameraRig, in the physics frame). */
export function punchedPose(pose: CameraPose, fx: PunchFx): CameraPose {
  const d = [fx.point[0] - pose.pos[0], fx.point[1] - pose.pos[1], fx.point[2] - pose.pos[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const pushM = Math.min(fx.maxPushM, len * fx.push);
  const k = len > 1e-6 ? pushM / len : 0;
  return {
    pos: [pose.pos[0] + d[0] * k, pose.pos[1] + d[1] * k, pose.pos[2] + d[2] * k],
    target: [
      pose.target[0] + (fx.point[0] - pose.target[0]) * fx.aim,
      pose.target[1] + (fx.point[1] - pose.target[1]) * fx.aim,
      pose.target[2] + (fx.point[2] - pose.target[2]) * fx.aim,
    ],
    fov: pose.fov * fx.fovScale,
  };
}

const FRAMING_REASON = 'fighters out of frame';
/** A lens outside the fence stays at least this far outside it when punched (never pops through the mesh). */
const FENCE_CLEARANCE_M = 0.15;

/** The punch would carry a lens that is outside the cage up to (or through) the fence. */
function crossesFence(base: CameraPose, fx: PunchFx): boolean {
  return fx.push > 0 && !insideCage(base.pos) && insideCage(punchedPose(base, fx).pos, -FENCE_CLEARANCE_M);
}

/** Occlusion reasons (everything but framing) the punched pose adds over the shot's own pose. */
function addedBlockers(shot: Shot, base: CameraPose, fx: PunchFx, s: Subjects, aspect: number): number {
  const before = new Set(checkPose(shot, base, s, aspect).reasons);
  return checkPose(shot, punchedPose(base, fx), s, aspect).reasons.filter((r) => r !== FRAMING_REASON && !before.has(r)).length;
}

/**
 * Keep the director's sight-line rules: back the punch off (half, then a lens squeeze without
 * moving, then none) when it would add a blocker in front of the subjects or cross the fence.
 */
export function constrainPunch(fx: PunchFx | null, shot: Shot, pose: CameraPose, s: Subjects, aspect: number): PunchFx | null {
  if (!fx) return null;
  const half: PunchFx = { ...fx, push: fx.push / 2, aim: fx.aim / 2, fovScale: 1 - (1 - fx.fovScale) / 2 };
  const squeezeOnly: PunchFx = { ...fx, push: 0, aim: 0 };
  for (const cand of [fx, half, squeezeOnly]) if (!crossesFence(pose, cand) && addedBlockers(shot, pose, cand, s, aspect) === 0) return cand;
  return null;
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
