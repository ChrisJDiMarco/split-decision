// Defensive and grappling skills.
//   guard    both fists up by the forehead, elbows tucked, chin down, a little lower in the
//            knees: punches land on forearms instead of the head. Held while it runs.
//   clinch   step in, reach both arms around the back of the opponent's neck and haul it in:
//            the forearms load the opponent's shoulders and smother its strikes.
import type { Vec3 } from '../../../core/types';
import type { HumanoidGeometry, Side } from '../geometry';
import { minJerk, mix } from '../math';
import type { SkillDef, SkillEnv, SkillRun } from './types';

const BOTH_ARMS = () => ['shoulder_pitch_l', 'elbow_l', 'shoulder_pitch_r', 'elbow_r'];
const COVER_HEIGHT = 0.12; // fists above the neck, fraction of arm reach
const COVER_REACH = 0.34; // fists in front of the chest, fraction of arm reach
const COVER_WIDTH = 0.32; // fists either side of the centre line, fraction of shoulder width
const CLINCH_BEHIND = 0.12; // m past the back of the opponent's neck
const CLINCH_WIDE = 0.1; // m either side of it

function setArm(env: SkillEnv, side: Side, fist: Vec3, pole: Vec3): void {
  const arm = env.cmd.arms[side];
  arm.mode = 'fist';
  arm.fist = fist;
  arm.pole = pole;
}

const reach = (env: SkillEnv, side: Side) => env.geo.arms[side].upper + env.geo.arms[side].fore;
const sgn = (side: Side) => (side === 'l' ? 1 : -1);

function coverFist(env: SkillEnv, side: Side): Vec3 {
  const R = reach(env, side);
  const shoulderY = Math.abs(env.geo.arms[side].shoulder[1]);
  return [COVER_REACH * R, sgn(side) * COVER_WIDTH * shoulderY, env.geo.neck[2] + COVER_HEIGHT * R];
}

function guardPose(env: SkillEnv, run: SkillRun, u: number): void {
  const k = run.phase === 'windup' ? minJerk(u) : run.phase === 'recover' ? 1 - minJerk(u) : 1;
  for (const side of ['l', 'r'] as const) {
    const g = env.stance.guard[side];
    setArm(env, side, mix(g.fist, coverFist(env, side), k), mix(g.pole, [-0.1, sgn(side) * 0.15, -1], k) as Vec3);
  }
  env.pose.waistPitch = env.stance.waistPitch + 0.08 * k;
  env.pose.waistYaw = env.stance.waistYaw * (1 - 0.5 * k);
  env.pose.pelvisDrop = 0.025 * k;
}

/** Where a clinching fist goes: behind the opponent's neck, a little to its side. */
function clinchPoint(env: SkillEnv, side: Side): Vec3 {
  const o = env.opp;
  const neck = o.head ?? o.chest;
  // Opponent's facing direction: from its COM toward us is its front; behind is the far side.
  const bx = Math.cos(o.heading), by = Math.sin(o.heading);
  const lx = -by, ly = bx; // opponent's left
  const w = -sgn(side) * CLINCH_WIDE; // our left hand wraps the opponent's right side
  return env.toTorso([neck[0] - bx * CLINCH_BEHIND + lx * w, neck[1] - by * CLINCH_BEHIND + ly * w, neck[2] - 0.08]);
}

function clinchPose(env: SkillEnv, run: SkillRun, u: number): void {
  const k = run.phase === 'windup' ? minJerk(u) : run.phase === 'recover' ? 1 - minJerk(u) : 1;
  for (const side of ['l', 'r'] as const) {
    const g = env.stance.guard[side];
    setArm(env, side, mix(g.fist, clinchPoint(env, side), k), mix(g.pole, [0, sgn(side) * 1, -0.4], k) as Vec3);
  }
  env.pose.waistPitch = env.stance.waistPitch + 0.14 * k;
  env.pose.waistYaw = env.stance.waistYaw * (1 - k);
  env.pose.pelvisYaw = -env.stance.pelvisYaw * 0.5 * k; // square up
  env.pose.weightShift = [0.04 * k, 0];
}

/** Guard works at any range. */
const anyRange = (): [number, number] => [0, Number.POSITIVE_INFINITY];

/** Clinch range: close enough to wrap the arms around the neck. */
function clinchRange(geo: HumanoidGeometry): [number, number] {
  const R = geo.arms.l.upper + geo.arms.l.fore;
  return [0.2, 0.55 * R + geo.torsoHalf[0] * 1.6];
}

export const GUARD: SkillDef = {
  id: 'guard', kind: 'defense', side: null, telegraph: 0, defaultZone: 'head',
  durations: { windup: 0.12, strike: 0.6, recover: 0.2 },
  requires: BOTH_ARMS, strikers: [], range: anyRange,
  pose: guardPose,
};

export const CLINCH: SkillDef = {
  id: 'clinch', kind: 'grapple', side: null, telegraph: 0.2, defaultZone: 'head',
  durations: { windup: 0.3, strike: 1.4, recover: 0.35 },
  requires: BOTH_ARMS, strikers: ['forearm_l', 'forearm_r', 'fist_l', 'fist_r'], range: clinchRange,
  pose: clinchPose,
};

export const DEFENSE: readonly SkillDef[] = [GUARD, CLINCH];
