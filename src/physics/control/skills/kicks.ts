// Kicks borrow a leg from the gait: the windup shifts the weight onto the other foot and waits
// until the capture point is over it (single support is then balanced), chambers the knee,
// the strike drives the leg at the target, and the recovery re-chambers and hands the leg back
// to the gait to swing down and plant. The torso leans away to keep the COM over the stance sole.
//
// The hip is a yaw-roll-pitch joint with ±40° yaw and under 45° of roll: it cannot fold the knee
// in a horizontal plane the way a human roundhouse does (that takes a pelvis rolled onto its
// side). So every kick travels in the leg's pitch plane, knee up, and the rear-leg kicks get
// their sweep from the hips turning over, not from a horizontal whip of the shin.
import type { Vec3 } from '../../../core/types';
import { other } from '../gait';
import { sideSign, type HumanoidGeometry, type Side } from '../geometry';
import { clamp, dot, minJerk, mix, mulMV, rot2, sub } from '../math';
import { nearLeg } from './targets';
import type { SkillDef, SkillEnv, SkillRun } from './types';

const LEG_JOINTS = (s: Side | null) => (s ? [`hip_pitch_${s}`, `hip_roll_${s}`, `knee_${s}`, `hip_pitch_${other(s)}`, `knee_${other(s)}`] : []);
const RETURN_SWING = { shift: 0, shiftFraction: 1, swing: 0.3, lift: 0.04 };
const SHIFT_WAIT_S = 1.3;
const CHAMBER_SHARE = 0.6; // share of the windup spent lifting the knee once the leg is free
const MAX_REACH = 0.97; // × hip-to-ankle span: a kick aimed past this extends fully and stops
const THROUGH_REACH = 0.985; // "through" kicks drive to a nearly straight leg along the aim line
const JOINT_SPEED_FRACTION = 0.6; // peak joint speed a kick asks of a motor, × its no-load speed
const MIN_JERK_PEAK = 1.875; // peak / mean speed of a minimum-jerk move
const RECHAMBER_SHARE = 0.625; // share of the recovery spent pulling the leg back to the chamber
const RETURN_AT = 0.65; // recovery progress at which the leg is handed back to swing down
/** Driving kicks want margin: a leg that only just reaches has nothing left to hit with. */
const CLOSE_KICK = { sweet: 0.45, throwAt: 0.7 };

// Vectors are in the heading frame as (forward, outward, up): outward is toward the kicking
// leg's own side, so the same numbers describe either leg.
interface KickShape {
  /** Chambered ankle, relative to the kicking hip, × leg length. */
  chamber: Vec3;
  kneePole: Vec3; // direction the knee points while chambered / striking
  anklePitch: number; // foot attitude at the strike (negative = toes up, sole forward)
  lean: number; // waist pitch (negative leans back) at full extension
  pelvisTurn: number; // pelvis yaw offset during the strike, toward the stance side (hip turn-over)
  pelvisTilt: number; // pelvis pitch at the strike (negative tilts back, raises the kick)
  follow: Vec3; // follow-through past the target, m
  /** Steepest the leg may rise above the hip, rad: a target above it is struck at this height. */
  maxElevation?: number;
  /** Drive a nearly straight leg along the aim line (a bent knee would lift the thigh too far). */
  through?: boolean;
  aim: (env: SkillEnv, run: SkillRun) => Vec3; // world target for the ankle
}

/** (forward, outward, up) for the kicking `side`, in a frame facing `yaw` → world. */
function frameVec(yaw: number, side: Side, v: Vec3): Vec3 {
  const [x, y] = rot2(v[0], v[1] * sideSign(side), yaw);
  return [x, y, v[2]];
}

/**
 * The way the body itself faces. The recovery works in this frame: a leg hauled back toward a
 * point fixed in the world reacts on a pelvis that is free to yaw on one sole, and the body
 * winds itself up into a spin.
 */
function bodyHeading(env: SkillEnv): number {
  return env.s.heading - env.stance.pelvisYaw;
}

function hipWorld(env: SkillEnv, side: Side): Vec3 {
  const s = env.s;
  const h = mulMV(s.pelvisRot, env.geo.legs[side].hip);
  return [s.pelvisPos[0] + h[0], s.pelvisPos[1] + h[1], s.pelvisPos[2] + h[2]];
}

const span = (env: SkillEnv, side: Side): number => env.geo.legs[side].thigh + env.geo.legs[side].shin;

function chamberPoint(env: SkillEnv, side: Side, shape: KickShape, yaw: number): Vec3 {
  const L = env.geo.legLength;
  const c = frameVec(yaw, side, [shape.chamber[0] * L, shape.chamber[1] * L, shape.chamber[2] * L]);
  const hip = hipWorld(env, side);
  return [hip[0] + c[0], hip[1] + c[1], hip[2] + c[2]];
}

function setKickLeg(env: SkillEnv, side: Side, ankle: Vec3, pole: Vec3, anklePitch: number): void {
  const leg = env.cmd.legs[side];
  leg.mode = 'point';
  leg.measured = true;
  leg.ankle = ankle;
  leg.kneePole = pole;
  leg.anklePitch = anklePitch;
  leg.ankleRoll = 0;
}

function kickPose(shape: KickShape) {
  return (env: SkillEnv, run: SkillRun, u: number): void => {
    const side = run.def.side!;
    env.pose.holdFeet = true;
    const leg = env.gait.skillLegActive();
    const turn = -shape.pelvisTurn * sideSign(side); // the hips turn over toward the stance side
    const yaw = run.phase === 'recover' ? bodyHeading(env) : env.heading;
    const pole = frameVec(yaw, side, shape.kneePole);
    const chamber = chamberPoint(env, side, shape, yaw);
    if (run.phase === 'windup') {
      if (leg !== side) return; // still shifting the weight across
      if (run.scratch.grantedAt === undefined) run.scratch.grantedAt = run.t;
      const k = minJerk(chamberProgress(run));
      setKickLeg(env, side, mix(startAnkle(env, side, run), chamber, k), pole, 0);
      env.pose.waistPitch = env.stance.waistPitch + shape.lean * 0.4 * k;
      env.pose.pelvisYaw = turn * 0.3 * k;
      return;
    }
    const target = strikePoint(env, run, shape);
    if (run.phase === 'strike') {
      const k = minJerk(Math.min(1, u * 1.2));
      // On contact the leg stops extending: it has delivered the blow, and driving on into a
      // braced target only launches the kicker backward off one foot.
      if (run.landed && !run.scratch.contact) run.scratch.contact = [...env.s.feet[side].ankle];
      const ankle = (run.scratch.contact as Vec3 | undefined) ?? mix(chamber, target, k);
      setKickLeg(env, side, ankle, pole, shape.anklePitch * k);
      env.pose.waistPitch = env.stance.waistPitch + shape.lean * (0.4 + 0.6 * k);
      env.pose.pelvisYaw = turn * (0.3 + 0.7 * k);
      env.pose.pelvisPitch = shape.pelvisTilt * k;
      return;
    }
    // recover: back to the chamber, then hand the leg back to the gait. The hips unwind over the
    // whole recovery: a quick turn-back with the leg still out spins the stance foot. Both moves
    // are paced to the leg's motors: a leg hauled down faster than they can brake falls freely,
    // swings through behind the body and takes the stance knee with it.
    if (!run.scratch.recoverFrom) {
      const from: Vec3 = [...env.s.feet[side].ankle];
      run.scratch.recoverFrom = from;
      run.durations.recover = Math.max(run.durations.recover, legMoveTime(env, side, from, chamber) / RECHAMBER_SHARE);
    }
    const k = minJerk(Math.min(1, u / RECHAMBER_SHARE));
    const unwind = minJerk(u);
    if (leg === side) setKickLeg(env, side, mix(run.scratch.recoverFrom as Vec3, chamber, k), pole, shape.anklePitch * (1 - k));
    env.pose.waistPitch = env.stance.waistPitch + shape.lean * (1 - k);
    env.pose.pelvisYaw = turn * (1 - unwind);
    env.pose.pelvisPitch = shape.pelvisTilt * (1 - k);
    if (u >= RETURN_AT && leg === side) returnLeg(env, side);
  };
}

/** Swing the kicking leg down beside the stance foot, no faster than its motors can carry it. */
function returnLeg(env: SkillEnv, side: Side): void {
  const slot = env.gait.partnerSlot(side);
  const g = env.geo.legs[side];
  const ankle: Vec3 = [slot.x - Math.cos(slot.yaw) * g.footCenterX, slot.y - Math.sin(slot.yaw) * g.footCenterX, g.soleDepth];
  const swing = Math.max(RETURN_SWING.swing, legMoveTime(env, side, env.s.feet[side].ankle, ankle));
  env.gait.returnSkillLeg(slot, { ...RETURN_SWING, swing }, env.s);
}

function chamberProgress(run: SkillRun): number {
  if (run.scratch.grantedAt === undefined) return 0;
  return clamp((run.t - (run.scratch.grantedAt as number)) / (run.durations.windup * CHAMBER_SHARE), 0, 1);
}

function startAnkle(env: SkillEnv, side: Side, run: SkillRun): Vec3 {
  if (!run.scratch.start) run.scratch.start = [...env.s.feet[side].ankle];
  return run.scratch.start as Vec3;
}

/** Locked at the start of the strike: the aim plus follow-through, within the leg's reach. */
function strikePoint(env: SkillEnv, run: SkillRun, shape: KickShape): Vec3 {
  if (!run.scratch.strikeAt) {
    const side = run.def.side!;
    const p = shape.aim(env, run);
    const f = frameVec(env.heading, side, shape.follow);
    const hip = hipWorld(env, side);
    const d: Vec3 = [p[0] + f[0] - hip[0], p[1] + f[1] - hip[1], p[2] + f[2] - hip[2]];
    if (shape.maxElevation !== undefined) d[2] = Math.min(d[2], Math.hypot(d[0], d[1]) * Math.tan(shape.maxElevation));
    const n = Math.max(1e-6, Math.hypot(d[0], d[1], d[2]));
    const reach = span(env, side) * (shape.through ? THROUGH_REACH : MAX_REACH);
    const k = shape.through ? reach / n : Math.min(1, reach / n);
    run.scratch.strikeAt = [hip[0] + d[0] * k, hip[1] + d[1] * k, hip[2] + d[2] * k];
  }
  return run.scratch.strikeAt as Vec3;
}

/** Knee bend (0 = straight) that puts the ankle `d` from the hip. */
function kneeBend(env: SkillEnv, side: Side, d: number): number {
  const { thigh: a, shin: b } = env.geo.legs[side];
  return Math.acos(clamp((d * d - a * a - b * b) / (2 * a * b), -1, 1));
}

/**
 * The strike can be no quicker than the leg's motors can swing it: the hip must sweep from the
 * chamber direction to the strike direction and the knee must open, each at a fraction of its
 * no-load speed (a motor near its no-load speed has no torque left to fight gravity).
 */
function kickStrikeTime(shape: KickShape) {
  return (env: SkillEnv, run: SkillRun): number => {
    const side = run.def.side!;
    return legMoveTime(env, side, chamberPoint(env, side, shape, env.heading), strikePoint(env, run, shape));
  };
}

/**
 * Seconds for a minimum-jerk move of the ankle from `from` to `to` (world): the hip sweeps the
 * angle between the two hip-to-ankle lines and the knee opens or closes to the new span, each
 * peaking at a fraction of its motor's no-load speed.
 */
function legMoveTime(env: SkillEnv, side: Side, from: Vec3, to: Vec3): number {
  const hip = hipWorld(env, side);
  const a = sub(from, hip);
  const b = sub(to, hip);
  const na = Math.hypot(a[0], a[1], a[2]), nb = Math.hypot(b[0], b[1], b[2]);
  const sweep = Math.acos(clamp(dot(a, b) / Math.max(1e-9, na * nb), -1, 1));
  const knee = Math.abs(kneeBend(env, side, na) - kneeBend(env, side, nb));
  const speed = (joint: string) => JOINT_SPEED_FRACTION * (env.joint(`${joint}_${side}`)?.motor.noLoadSpeedRadS ?? 8);
  return MIN_JERK_PEAK * Math.max(sweep / speed('hip_pitch'), knee / speed('knee'));
}

/** The opponent leg named by the target zone, else the nearer one. */
function legOf(env: SkillEnv, run: SkillRun): Side {
  if (run.zone === 'left_leg') return 'l';
  if (run.zone === 'right_leg') return 'r';
  return nearLeg(env.opp, env.s.com);
}

/** Windup: leg granted and chambered. Recovery: the foot is back on the canvas. */
function kickReady(env: SkillEnv, run: SkillRun): boolean {
  const side = run.def.side!;
  if (run.phase === 'recover') return env.gait.phase === 'double' || env.gait.phase === 'shift';
  // Balance engine: a weight shift its kick gate called off (the body was not ready for one foot in time,
  // or the DCM ran out of the soles) is the end of this kick, as for the mocap kicks: asked again at once,
  // the shift held the feet and the catch step the body needed never came.
  run.scratch.aborted0 ??= env.gait.abortedShifts;
  if (env.engine && env.gait.abortedShifts !== run.scratch.aborted0) {
    run.scratch.abort = true;
    return false;
  }
  if (!env.gait.requestSkillLeg(side, SHIFT_WAIT_S)) return false;
  return chamberProgress(run) >= 1;
}

function kickEnd(env: SkillEnv, run: SkillRun): void {
  const side = run.def.side!;
  if (env.gait.skillLegActive() === side) returnLeg(env, side);
  else env.gait.cancelSkillRequest();
}

/** COM-to-opponent-COM range for a kick whose ankle must reach `height` × leg length above the canvas. */
function kickRange(reach: number, targetHeight: number) {
  return (geo: HumanoidGeometry): [number, number] => {
    const L = geo.legLength;
    const hip = L * 0.95 + geo.legs.l.soleDepth;
    const dz = Math.abs(targetHeight * L - hip);
    const horiz = Math.sqrt(Math.max(0, (reach * L) ** 2 - dz * dz));
    const hi = horiz + geo.torsoHalf[0] * 0.8 + Math.abs(geo.legs.l.hip[0]);
    return [0.55 * hi, hi];
  };
}

type KickHead = Omit<SkillDef, 'kind' | 'requires' | 'ready' | 'end' | 'pose' | 'strikeTime'>;

function kick(head: KickHead, shape: KickShape): SkillDef {
  return { ...head, kind: 'leg', requires: LEG_JOINTS, ready: kickReady, end: kickEnd, pose: kickPose(shape), strikeTime: kickStrikeTime(shape) };
}

/** Lead-leg push kick to the body: knee up, then drive the sole straight through. */
export const FRONT_KICK: SkillDef = kick(
  {
    id: 'front_kick', side: 'l', telegraph: 0.55, defaultZone: 'torso',
    durations: { windup: 0.35, strike: 0.26, recover: 0.4 },
    strikers: ['foot_l', 'shin_l'], range: kickRange(0.9, 1.3), approach: CLOSE_KICK,
  },
  {
    chamber: [0.3, 0.05, -0.45], kneePole: [0.3, 0, 1], anklePitch: -0.5,
    lean: -0.16, pelvisTurn: 0.1, pelvisTilt: -0.08, follow: [0.12, 0, 0],
    aim: (env) => { const c = env.opp.chest; return [c[0], c[1], c[2] - 0.12]; },
  },
);

/** Rear-leg low kick: the hips turn over and the shin chops down into the opponent's thigh. */
export const LOW_KICK: SkillDef = kick(
  {
    id: 'low_kick', side: 'r', telegraph: 0.45, defaultZone: 'left_leg',
    durations: { windup: 0.32, strike: 0.26, recover: 0.4 },
    strikers: ['foot_r', 'shin_r'], range: kickRange(0.95, 0.55),
  },
  {
    chamber: [0.1, 0.3, -0.6], kneePole: [1, -0.2, 0.5], anklePitch: 0.4,
    lean: -0.1, pelvisTurn: 0.3, pelvisTilt: 0, follow: [0.05, -0.1, 0],
    aim: (env, run) => env.opp.thigh[legOf(env, run)],
  },
);

/**
 * Rear-leg high kick: knee up, hips turned over and tilted back, a nearly straight leg driven
 * up the line to the head. It rises as high as the hip allows; on a taller opponent it lands on
 * the shoulder or the guard instead.
 */
export const HEAD_KICK: SkillDef = kick(
  {
    id: 'head_kick', side: 'r', telegraph: 0.75, defaultZone: 'head',
    durations: { windup: 0.42, strike: 0.3, recover: 0.48 },
    strikers: ['foot_r', 'shin_r'], range: kickRange(1.05, 1.55), approach: CLOSE_KICK,
  },
  {
    chamber: [0.3, 0.1, -0.3], kneePole: [1, -0.2, 0.8], anklePitch: 0.5,
    lean: -0.22, pelvisTurn: 0.3, pelvisTilt: -0.18, follow: [0.05, -0.1, 0.05],
    maxElevation: 0.35, through: true,
    aim: (env) => env.opp.head ?? env.opp.chest,
  },
);

export const KICKS: readonly SkillDef[] = [FRONT_KICK, LOW_KICK, HEAD_KICK];
