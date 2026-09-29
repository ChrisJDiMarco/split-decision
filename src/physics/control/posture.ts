// Whole-body pose command → joint targets. The gait writes the legs, skills write the arms,
// waist and kicking leg, balance writes the pelvis; this file turns that pose into servo targets.
import type { Vec3 } from '../../core/types';
import type { RobotRuntime } from '../sim-context';
import { SIDES, type HumanoidGeometry, type Side } from './geometry';
import { armIK, clampAngle, legIK, legIKPoint, newArmAngles, newLegAngles, type ArmAngles, type LegAngles } from './ik';
import { IDENTITY, mulMtM, mulMtV, sub, type Mat3 } from './math';

export type LegMode = 'foot' | 'point' | 'joints';
export type ArmMode = 'fist' | 'joints';

export interface LegCommand {
  mode: LegMode;
  /** Solve against the measured pelvis (swinging / kicking legs track the world target). */
  measured: boolean;
  /** 1 = ankle follows the posture IK (stiff, balance feedback); 0 = sole held flat in the
   *  world from the measured shin (compliant). Planted feet blend the two. */
  ankleStiffness: number;
  ankle: Vec3; // world: ankle joint centre ('foot' and 'point')
  footRot: Mat3; // world ('foot')
  kneePole: Vec3; // world direction the knee should point ('point')
  anklePitch: number; // 'point' mode ankle angles
  ankleRoll: number;
  angles: LegAngles; // 'joints'
}

export interface ArmCommand {
  mode: ArmMode;
  fist: Vec3; // fist centre, torso frame ('fist')
  pole: Vec3; // elbow direction, torso frame
  angles: ArmAngles; // 'joints'
}

export interface BodyCommand {
  pelvisPos: Vec3;
  pelvisRot: Mat3;
  waistYaw: number;
  waistPitch: number;
  neckYaw: number;
  legs: Record<Side, LegCommand>;
  arms: Record<Side, ArmCommand>;
}

export function newBodyCommand(): BodyCommand {
  const leg = (): LegCommand => ({
    mode: 'foot', measured: false, ankleStiffness: 1, ankle: [0, 0, 0], footRot: [...IDENTITY] as Mat3, kneePole: [1, 0, 0],
    anklePitch: 0, ankleRoll: 0, angles: newLegAngles(),
  });
  const arm = (): ArmCommand => ({ mode: 'fist', fist: [0.3, 0, 0.3], pole: [0, 0, -1], angles: newArmAngles() });
  return {
    pelvisPos: [0, 0, 1], pelvisRot: [...IDENTITY] as Mat3, waistYaw: 0, waistPitch: 0, neckYaw: 0,
    legs: { l: leg(), r: leg() },
    arms: { l: arm(), r: arm() },
  };
}

/** Joint indices by design joint name, resolved once. */
export interface JointMap {
  waistYaw: number;
  waistPitch: number;
  neckYaw: number;
  leg: Record<Side, { hipYaw: number; hipRoll: number; hipPitch: number; knee: number; anklePitch: number; ankleRoll: number }>;
  arm: Record<Side, { pitch: number; roll: number; yaw: number; elbow: number }>;
}

export function jointMap(r: RobotRuntime): JointMap {
  const i = (name: string) => {
    const idx = r.jointIndex.get(name);
    if (idx === undefined) throw new Error(`robot ${r.corner}: missing joint '${name}'`);
    return idx;
  };
  const leg = (s: Side) => ({
    hipYaw: i(`hip_yaw_${s}`), hipRoll: i(`hip_roll_${s}`), hipPitch: i(`hip_pitch_${s}`),
    knee: i(`knee_${s}`), anklePitch: i(`ankle_pitch_${s}`), ankleRoll: i(`ankle_roll_${s}`),
  });
  const arm = (s: Side) => ({ pitch: i(`shoulder_pitch_${s}`), roll: i(`shoulder_roll_${s}`), yaw: i(`shoulder_yaw_${s}`), elbow: i(`elbow_${s}`) });
  return { waistYaw: i('waist_yaw'), waistPitch: i('waist_pitch'), neckYaw: i('neck_yaw'), leg: { l: leg('l'), r: leg('r') }, arm: { l: arm('l'), r: arm('r') } };
}

const scratchLeg = newLegAngles();
const scratchArm = newArmAngles();

function writeLeg(q: Float64Array, jm: JointMap, geo: HumanoidGeometry, s: Side, a: LegAngles): void {
  const m = jm.leg[s];
  q[m.hipYaw] = clampAngle(a.hipYaw, geo.limits.get(`hip_yaw_${s}`));
  q[m.hipRoll] = clampAngle(a.hipRoll, geo.limits.get(`hip_roll_${s}`));
  q[m.hipPitch] = clampAngle(a.hipPitch, geo.limits.get(`hip_pitch_${s}`));
  q[m.knee] = clampAngle(a.knee, geo.limits.get(`knee_${s}`));
  q[m.anklePitch] = clampAngle(a.anklePitch, geo.limits.get(`ankle_pitch_${s}`));
  q[m.ankleRoll] = clampAngle(a.ankleRoll, geo.limits.get(`ankle_roll_${s}`));
}

function writeArm(q: Float64Array, jm: JointMap, geo: HumanoidGeometry, s: Side, a: ArmAngles): void {
  const m = jm.arm[s];
  q[m.pitch] = clampAngle(a.pitch, geo.limits.get(`shoulder_pitch_${s}`));
  q[m.roll] = clampAngle(a.roll, geo.limits.get(`shoulder_roll_${s}`));
  q[m.yaw] = clampAngle(a.yaw, geo.limits.get(`shoulder_yaw_${s}`));
  q[m.elbow] = clampAngle(a.elbow, geo.limits.get(`elbow_${s}`));
}

export interface MeasuredPose {
  pos: Vec3; // pelvis
  rot: Mat3;
  shin: Record<Side, Mat3>; // shin attitudes (world)
}

/**
 * Ankle angles that put the sole at `footRot` (world) given the measured shin attitude:
 * Ry(pitch)·Rx(roll) = Rshinᵀ·Rfoot. Real bipeds keep a planted sole flat this way, so an
 * attitude error higher up never rolls the foot onto an edge (where it has no grip).
 */
function flatAnkle(shin: Mat3, footRot: Mat3): [number, number] {
  const M = mulMtM(shin, footRot);
  return [Math.atan2(-M[6], M[0]), Math.atan2(-M[5], M[4])];
}

/**
 * Solves every limb of `cmd` into joint targets `q` (radians, by r.joints index). Legs flagged
 * `measured` are solved from the measured pelvis pose so a foot in the air lands where it aims.
 */
export function solveBody(cmd: BodyCommand, geo: HumanoidGeometry, jm: JointMap, q: Float64Array, measured: MeasuredPose): void {
  for (const s of SIDES) {
    const leg = cmd.legs[s];
    if (leg.mode === 'joints') {
      writeLeg(q, jm, geo, s, leg.angles);
      continue;
    }
    const Rp = leg.measured ? measured.rot : cmd.pelvisRot;
    const ankleP = mulMtV(Rp, sub(leg.ankle, leg.measured ? measured.pos : cmd.pelvisPos));
    if (leg.mode === 'foot') {
      legIK(geo.legs[s], ankleP, mulMtM(Rp, leg.footRot), scratchLeg);
      const [fp, fr] = flatAnkle(measured.shin[s], leg.footRot);
      const k = leg.ankleStiffness;
      scratchLeg.anklePitch = fp + k * (scratchLeg.anklePitch - fp);
      scratchLeg.ankleRoll = fr + k * (scratchLeg.ankleRoll - fr);
    } else {
      legIKPoint(geo.legs[s], ankleP, mulMtV(Rp, leg.kneePole), scratchLeg);
      scratchLeg.anklePitch = leg.anklePitch;
      scratchLeg.ankleRoll = leg.ankleRoll;
    }
    writeLeg(q, jm, geo, s, scratchLeg);
  }
  q[jm.waistYaw] = clampAngle(cmd.waistYaw, geo.limits.get('waist_yaw'));
  q[jm.waistPitch] = clampAngle(cmd.waistPitch, geo.limits.get('waist_pitch'));
  q[jm.neckYaw] = clampAngle(cmd.neckYaw, geo.limits.get('neck_yaw'));
  for (const s of SIDES) {
    const arm = cmd.arms[s];
    if (arm.mode === 'joints') {
      writeArm(q, jm, geo, s, arm.angles);
    } else {
      armIK(geo.arms[s], arm.fist, arm.pole, scratchArm);
      writeArm(q, jm, geo, s, scratchArm);
    }
  }
}
