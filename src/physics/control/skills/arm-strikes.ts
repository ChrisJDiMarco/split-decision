// Punches. Each one cocks the fist (windup), drives it to an aim point on the opponent with the
// hips and waist turning into it (strike), then returns to guard (recover). The strike aims
// past the surface so the servos keep pushing through the target: real momentum, not a tap.
import type { Vec3 } from '../../../core/types';
import type { HumanoidGeometry, Side } from '../geometry';
import { clamp, lerp, minJerk, mix, normalize, sub } from '../math';
import type { SkillDef, SkillEnv, SkillRun } from './types';

const ARM_JOINTS = (s: Side | null) => (s ? [`shoulder_pitch_${s}`, `shoulder_roll_${s}`, `elbow_${s}`] : []);
const FOLLOW_THROUGH = 0.1; // m past the target surface
const ROCKET_FOLLOW_THROUGH = 0.25;
const STANCE_TORSO_YAW = -0.16; // pelvis blade + waist turn-back in the stance
const STRAIGHT_ARM = 0.92; // usable fraction of arm length
const FIST_SPEED_FRACTION = 0.6; // fist speed ≈ this × joint speed × arm length

function guardFist(env: SkillEnv, side: Side): Vec3 {
  return [...env.stance.guard[side].fist] as Vec3;
}

function guardPole(env: SkillEnv, side: Side): Vec3 {
  return [...env.stance.guard[side].pole] as Vec3;
}

/** Aim point in the torso frame: the zone surface facing us, plus follow-through. */
function aimTorso(env: SkillEnv, run: SkillRun, side: Side, follow: number): Vec3 {
  const shoulder = env.geo.arms[side].shoulder;
  const target = run.aim ?? env.opp.chest;
  const t = env.toTorso(target);
  const dir = normalize(sub(t, shoulder), [1, 0, 0]);
  // Pull back to the surface facing us (target is a body centre), then push through it.
  const k = follow - env.opp.frontDepth * 0.6;
  return [t[0] + dir[0] * k, t[1] + dir[1] * k, t[2] + dir[2] * k];
}

function setArm(env: SkillEnv, side: Side, fist: Vec3, pole: Vec3): void {
  const arm = env.cmd.arms[side];
  arm.mode = 'fist';
  arm.fist = fist;
  arm.pole = pole;
}

function setTorso(env: SkillEnv, waistYaw: number, pelvisYaw: number, fwd: number, waistPitch = env.stance.waistPitch): void {
  env.pose.waistYaw = env.stance.waistYaw + waistYaw;
  env.pose.pelvisYaw = pelvisYaw;
  env.pose.waistPitch = waistPitch;
  env.pose.weightShift = [fwd, 0];
}

interface PunchShape {
  cock: (env: SkillEnv, side: Side) => Vec3; // cocked fist, torso frame
  cockPole: Vec3;
  strikePole: Vec3;
  windupTurn: number; // waist yaw during windup (relative)
  strikeTurn: number; // waist yaw at the end of the strike
  pelvisTurn: number;
  lean: number; // extra waist pitch at the strike
  weight: number; // forward COM shift at the strike, m
  dip?: number; // pelvis drop during the windup
  arc?: Vec3; // mid-strike bulge (torso frame) for looping punches
  follow: number;
}

function punchPose(shape: PunchShape) {
  return (env: SkillEnv, run: SkillRun, u: number): void => {
    const side = run.def.side!;
    const guard = guardFist(env, side);
    const cock = shape.cock(env, side);
    const k = minJerk(u);
    if (run.phase === 'windup') {
      setArm(env, side, mix(guard, cock, k), mix(guardPole(env, side), shape.cockPole, k) as Vec3);
      setTorso(env, shape.windupTurn * k, shape.pelvisTurn * -0.3 * k, 0);
      env.pose.pelvisDrop = (shape.dip ?? 0) * k;
      return;
    }
    const aim = aimTorso(env, run, side, shape.follow);
    if (run.phase === 'strike') {
      // Punches accelerate hard: the target leads the fist so the servos saturate.
      const p = Math.min(1, u * 1.15);
      const kk = minJerk(p);
      let fist = mix(cock, aim, kk);
      if (shape.arc) {
        const bulge = Math.sin(Math.PI * p);
        fist = [fist[0] + shape.arc[0] * bulge, fist[1] + shape.arc[1] * bulge, fist[2] + shape.arc[2] * bulge];
      }
      setArm(env, side, fist, shape.strikePole);
      setTorso(env, lerp(shape.windupTurn, shape.strikeTurn, kk), lerp(-0.3 * shape.pelvisTurn, shape.pelvisTurn, kk), shape.weight * kk, env.stance.waistPitch + shape.lean * kk);
      env.pose.pelvisDrop = (shape.dip ?? 0) * (1 - kk);
      return;
    }
    // recover: back to guard
    setArm(env, side, mix(aim, guard, k), mix(shape.strikePole, guardPole(env, side), k) as Vec3);
    setTorso(env, shape.strikeTurn * (1 - k), shape.pelvisTurn * (1 - k), shape.weight * (1 - k), env.stance.waistPitch + shape.lean * (1 - k));
    env.pose.pelvisDrop = 0;
  };
}

/**
 * COM-to-opponent-COM range at which a punch lands: where the striking shoulder sits once the
 * torso has turned into the punch, plus the arm's straight reach across to the centre line and
 * the depth of the opponent's body in front of its COM (taken as our own torso depth).
 */
function punchRange(side: Side, turn: number, lo = 0.5) {
  return (geo: HumanoidGeometry): [number, number] => {
    const stanceYaw = STANCE_TORSO_YAW + turn;
    const sh = geo.arms[side].shoulder;
    const x = -Math.sin(stanceYaw) * sh[1] + geo.pelvisToTorso[0];
    const y = Math.cos(stanceYaw) * sh[1];
    const R = STRAIGHT_ARM * (geo.arms[side].upper + geo.arms[side].fore);
    const along = Math.sqrt(Math.max(0, R * R - y * y));
    const hi = x + along + geo.arms[side].fistHalf + geo.torsoHalf[0] * 0.8;
    return [lo * hi, hi];
  };
}

/** Minimum-jerk strike time for the fist's travel at the arm's top speed (motor no-load speed). */
function armStrikeTime(env: SkillEnv, run: SkillRun): number {
  const side = run.def.side!;
  const w = Math.min(...['shoulder_pitch', 'elbow'].map((j) => env.joint(`${j}_${side}`)?.motor.noLoadSpeedRadS ?? 10));
  const vMax = FIST_SPEED_FRACTION * w * (env.geo.arms[side].upper + env.geo.arms[side].fore);
  const from = env.cmd.arms[side].fist;
  const to = aimTorso(env, run, side, FOLLOW_THROUGH);
  const d = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  return (1.875 * d) / Math.max(0.5, vMax);
}

const sideY = (side: Side) => (side === 'l' ? 1 : -1);

export const JAB: SkillDef = {
  id: 'jab', kind: 'arm', side: 'l', telegraph: 0.25, defaultZone: 'head',
  durations: { windup: 0.1, strike: 0.15, recover: 0.2 },
  requires: ARM_JOINTS, strikers: ['fist_l', 'forearm_l'],
  range: punchRange('l', -0.3), strikeTime: armStrikeTime,
  pose: punchPose({
    cock: (env, s) => { const g = guardFist(env, s); return [g[0] - 0.05, g[1], g[2] - 0.02]; },
    cockPole: [-0.2, 0.3, -1], strikePole: [0, 0.35, -1],
    windupTurn: 0.05, strikeTurn: -0.3, pelvisTurn: -0.1, lean: 0.05, weight: 0.03, follow: FOLLOW_THROUGH,
  }),
};

export const CROSS: SkillDef = {
  id: 'cross', kind: 'arm', side: 'r', telegraph: 0.45, defaultZone: 'head',
  durations: { windup: 0.16, strike: 0.18, recover: 0.28 },
  requires: ARM_JOINTS, strikers: ['fist_r', 'forearm_r'],
  range: punchRange('r', 0.55), strikeTime: armStrikeTime,
  pose: punchPose({
    cock: (env, s) => { const g = guardFist(env, s); return [g[0] - 0.06, g[1] - 0.02, g[2] - 0.03]; },
    cockPole: [-0.2, -0.3, -1], strikePole: [0, -0.3, -1],
    windupTurn: -0.05, strikeTurn: 0.55, pelvisTurn: 0.22, lean: 0.08, weight: 0.06, follow: FOLLOW_THROUGH,
  }),
};

export const HOOK: SkillDef = {
  id: 'hook', kind: 'arm', side: 'l', telegraph: 0.5, defaultZone: 'head',
  durations: { windup: 0.18, strike: 0.2, recover: 0.26 },
  requires: ARM_JOINTS, strikers: ['fist_l', 'forearm_l'],
  range: punchRange('l', -0.55, 0.4), strikeTime: armStrikeTime,
  pose: punchPose({
    cock: (env, s) => { const g = guardFist(env, s); const sh = env.geo.arms[s].shoulder; return [g[0] - 0.05, sh[1] + sideY(s) * 0.12, g[2]]; },
    cockPole: [-0.3, 1, 0.2], strikePole: [-0.2, 1, 0.35],
    windupTurn: 0.22, strikeTurn: -0.55, pelvisTurn: -0.2, lean: 0.05, weight: 0.03,
    arc: [0.02, 0.18, 0.02], follow: FOLLOW_THROUGH * 0.8,
  }),
};

export const UPPERCUT: SkillDef = {
  id: 'uppercut', kind: 'arm', side: 'r', telegraph: 0.45, defaultZone: 'head',
  durations: { windup: 0.2, strike: 0.18, recover: 0.28 },
  requires: ARM_JOINTS, strikers: ['fist_r', 'forearm_r'],
  range: punchRange('r', 0.45, 0.35), strikeTime: armStrikeTime,
  pose: punchPose({
    cock: (env, s) => { const sh = env.geo.arms[s].shoulder; return [0.28 * env.geo.armReach, sh[1] * 0.5, sh[2] - 0.32 * env.geo.armReach]; },
    cockPole: [-0.3, -0.2, -1], strikePole: [-1, -0.25, -0.4],
    windupTurn: 0.1, strikeTurn: 0.45, pelvisTurn: 0.15, lean: -0.05, weight: 0.04, dip: 0.07,
    arc: [-0.05, 0, -0.06], follow: FOLLOW_THROUGH,
  }),
};

export const OVERHAND: SkillDef = {
  id: 'overhand', kind: 'arm', side: 'r', telegraph: 0.85, defaultZone: 'head',
  durations: { windup: 0.3, strike: 0.22, recover: 0.36 },
  requires: ARM_JOINTS, strikers: ['fist_r', 'forearm_r'],
  range: punchRange('r', 0.6), strikeTime: armStrikeTime,
  pose: punchPose({
    cock: (env, s) => { const sh = env.geo.arms[s].shoulder; return [-0.02, sh[1] * 1.1, sh[2] + 0.22 * env.geo.armReach]; },
    cockPole: [-0.4, -0.6, 0.4], strikePole: [-0.3, -0.8, 0.5],
    windupTurn: -0.18, strikeTurn: 0.6, pelvisTurn: 0.25, lean: 0.22, weight: 0.08,
    arc: [0.05, 0, 0.18], follow: FOLLOW_THROUGH * 1.2,
  }),
};

/** Goliath's piston fist: a long, readable load (fist pulled to the shoulder, knees dipped),
 *  then the elbow and shoulder fire flat out along the shoulder→target line (step targets, so
 *  every joint runs at its torque limit) with the hips driving through. */
export const ROCKET_PUNCH: SkillDef = {
  id: 'rocket_punch', kind: 'arm', side: 'r', telegraph: 1.0, defaultZone: 'head',
  durations: { windup: 0.55, strike: 0.2, recover: 0.5 },
  requires: (s) => [...ARM_JOINTS(s), 'waist_yaw'], strikers: ['fist_r', 'forearm_r'],
  range: punchRange('r', 0.35, 0.55), strikeTime: armStrikeTime,
  pose: (env, run, u) => {
    const side = run.def.side!;
    const guard = guardFist(env, side);
    const sh = env.geo.arms[side].shoulder;
    const cock: Vec3 = [sh[0] + 0.1 * env.geo.armReach, sh[1] * 0.75, sh[2] - 0.12 * env.geo.armReach];
    if (run.phase === 'windup') {
      const k = minJerk(u);
      setArm(env, side, mix(guard, cock, k), [-0.5, -0.3, -1]);
      setTorso(env, -0.15 * k, -0.08 * k, -0.03 * k);
      env.pose.pelvisDrop = 0.06 * k;
      return;
    }
    const aim = aimTorso(env, run, side, ROCKET_FOLLOW_THROUGH);
    if (run.phase === 'strike') {
      const k = clamp(u * 2.5, 0, 1);
      setArm(env, side, mix(cock, aim, k), [0, -0.3, -1]);
      setTorso(env, lerp(-0.15, 0.4, k), lerp(-0.08, 0.15, k), lerp(-0.03, 0.1, k), env.stance.waistPitch + 0.1 * k);
      env.pose.pelvisDrop = 0.06 * (1 - k);
      return;
    }
    const k = minJerk(u);
    setArm(env, side, mix(aim, guard, k), [-0.2, -0.35, -1]);
    setTorso(env, 0.4 * (1 - k), 0.15 * (1 - k), 0.1 * (1 - k), env.stance.waistPitch + 0.1 * (1 - k));
    env.pose.pelvisDrop = 0;
  },
};

export const ARM_STRIKES: readonly SkillDef[] = [JAB, CROSS, HOOK, UPPERCUT, OVERHAND, ROCKET_PUNCH];
