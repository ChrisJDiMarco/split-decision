// Analytic inverse kinematics for the humanoid limbs.
//
// MuJoCo composes several joints in one body in the order they are declared, so
//   thigh    R = Rz(hip_yaw) · Rx(hip_roll) · Ry(hip_pitch),  then knee Ry(k),  then ankle Ry(pitch) · Rx(roll)
//   upperarm R = Ry(sh_pitch) · Rx(sh_roll) · Rz(sh_yaw),    then elbow Ry(e)
// Limbs hang along −z in the zero pose. A positive knee angle folds the shin back; a negative
// elbow angle folds the forearm forward.
import type { Vec3 } from '../../core/types';
import type { ArmGeometry, JointLimit, LegGeometry } from './geometry';
import { clamp, cross, dot, fromColumns, mulMM, mulMtM, mulMV, normalize, rotX, rotY, rotZ, scale, sub, type Mat3 } from './math';

export interface LegAngles {
  hipYaw: number;
  hipRoll: number;
  hipPitch: number;
  knee: number;
  anklePitch: number;
  ankleRoll: number;
}

export interface ArmAngles {
  pitch: number;
  roll: number;
  yaw: number;
  elbow: number;
}

export const newLegAngles = (): LegAngles => ({ hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0, anklePitch: 0, ankleRoll: 0 });
export const newArmAngles = (): ArmAngles => ({ pitch: 0, roll: 0, yaw: 0, elbow: 0 });

const REACH_MARGIN = 0.998; // never ask for a fully straight limb (knee/elbow singularity)
const MAX_FOLD_RAD = 2.6; // knees and elbows fold to 150°

/** Bend angle (0 = straight) between links a and b that spans distance d: d² = a² + b² + 2ab·cos(bend). */
function bendFor(a: number, b: number, d: number): number {
  return Math.acos(clamp((d * d - a * a - b * b) / (2 * a * b), -1, 1));
}

function clampSpan(a: number, b: number, d: number): number {
  const dMax = (a + b) * REACH_MARGIN;
  const dMin = Math.sqrt(Math.max(1e-6, a * a + b * b + 2 * a * b * Math.cos(MAX_FOLD_RAD)));
  return clamp(d, dMin, dMax);
}

/** Decompose R = Rz(y)·Rx(r)·Ry(p). */
function eulerZXY(R: Mat3): [number, number, number] {
  const roll = Math.asin(clamp(R[7], -1, 1));
  return [Math.atan2(-R[1], R[4]), roll, Math.atan2(-R[6], R[8])];
}

/** Decompose R = Ry(p)·Rx(r)·Rz(y). */
function eulerYXZ(R: Mat3): [number, number, number] {
  const roll = Math.asin(clamp(-R[5], -1, 1));
  return [Math.atan2(R[2], R[8]), roll, Math.atan2(R[3], R[4])];
}

/**
 * Full 6-DOF leg IK for a planted or placed foot.
 * @param ankle ankle joint centre in the pelvis frame
 * @param footRot foot orientation in the pelvis frame
 */
export function legIK(leg: LegGeometry, ankle: Vec3, footRot: Mat3, out: LegAngles): LegAngles {
  const T = leg.thigh, S = leg.shin;
  const hipToAnkle = sub(ankle, leg.hip);
  const d0 = Math.hypot(hipToAnkle[0], hipToAnkle[1], hipToAnkle[2]);
  const d = clampSpan(T, S, d0);
  const knee = bendFor(T, S, d);
  // Hip seen from the ankle, in the foot frame, rescaled to the reachable span.
  const r = scale(mulMtV3(footRot, scale(hipToAnkle, -1)), d / Math.max(d0, 1e-9));
  // Principal ankle roll (|roll| < 90°): atan(r_y / r_z), whichever side of the foot the hip is on.
  const zSign = r[2] < 0 ? -1 : 1;
  const ankleRoll = Math.atan2(r[1] * zSign, Math.abs(r[2]) + 1e-12);
  const wz = zSign * Math.hypot(r[1], r[2]);
  const phiU = Math.atan2(-T * Math.sin(knee), T * Math.cos(knee) + S);
  const phiW = Math.atan2(r[0], wz);
  const anklePitch = phiU - phiW;
  const thigh = mulMM(mulMM(footRot, rotX(-ankleRoll)), rotY(-(knee + anklePitch)));
  const [hipYaw, hipRoll, hipPitch] = eulerZXY(thigh);
  out.hipYaw = hipYaw;
  out.hipRoll = hipRoll;
  out.hipPitch = hipPitch;
  out.knee = knee;
  out.anklePitch = anklePitch;
  out.ankleRoll = ankleRoll;
  return out;
}

function mulMtV3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** Unit vector perpendicular to `dir`, leaning toward `pole`. */
function swivel(dir: Vec3, pole: Vec3): Vec3 {
  const w = sub(pole, scale(dir, dot(pole, dir)));
  const n = Math.hypot(w[0], w[1], w[2]);
  if (n > 1e-6) return scale(w, 1 / n);
  // Pole parallel to the limb: pick any perpendicular.
  return normalize(cross(dir, Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
}

/**
 * Position-only leg IK (kicks and swing): hip angles and knee from the ankle target, with the
 * knee pushed toward `kneePole` (pelvis frame). Ankle angles are left for the caller.
 */
export function legIKPoint(leg: LegGeometry, ankle: Vec3, kneePole: Vec3, out: LegAngles): LegAngles {
  const T = leg.thigh, S = leg.shin;
  const t = sub(ankle, leg.hip);
  const d = clampSpan(T, S, Math.hypot(t[0], t[1], t[2]));
  const tHat = normalize(t, [0, 0, -1]);
  const knee = bendFor(T, S, d);
  const cosA = clamp((T * T + d * d - S * S) / (2 * T * d), -1, 1);
  const w = swivel(tHat, kneePole);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const along: Vec3 = [cosA * tHat[0] + sinA * w[0], cosA * tHat[1] + sinA * w[1], cosA * tHat[2] + sinA * w[2]];
  const axis = normalize(cross(w, tHat), [0, 1, 0]); // knee hinge axis (+y of the thigh)
  const zAxis = scale(along, -1);
  const xAxis = cross(axis, zAxis);
  const [hipYaw, hipRoll, hipPitch] = eulerZXY(fromColumns(xAxis, axis, zAxis));
  out.hipYaw = hipYaw;
  out.hipRoll = hipRoll;
  out.hipPitch = hipPitch;
  out.knee = knee;
  return out;
}

/**
 * Arm IK: fist centre target in the torso frame, elbow pushed toward `elbowPole` (torso frame).
 * Returns the reach error (m) left after clamping to the arm's span.
 */
export function armIK(arm: ArmGeometry, fist: Vec3, elbowPole: Vec3, out: ArmAngles): number {
  const U = arm.upper, F = arm.fore;
  const t = sub(fist, arm.shoulder);
  const d0 = Math.hypot(t[0], t[1], t[2]);
  const d = clampSpan(U, F, d0);
  const tHat = normalize(t, [1, 0, 0]);
  out.elbow = -bendFor(U, F, d);
  const cosA = clamp((U * U + d * d - F * F) / (2 * U * d), -1, 1);
  const w = swivel(tHat, elbowPole);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const along: Vec3 = [cosA * tHat[0] + sinA * w[0], cosA * tHat[1] + sinA * w[1], cosA * tHat[2] + sinA * w[2]];
  const axis = normalize(cross(tHat, w), [0, 1, 0]); // elbow hinge axis (+y of the upper arm)
  const zAxis = scale(along, -1);
  const xAxis = cross(axis, zAxis);
  const [pitch, roll, yaw] = eulerYXZ(fromColumns(xAxis, axis, zAxis));
  out.pitch = pitch;
  out.roll = roll;
  out.yaw = yaw;
  return Math.abs(d0 - d);
}

// ---------------------------------------------------------------- forward kinematics (checks, planning)

export function legFK(leg: LegGeometry, a: LegAngles): { ankle: Vec3; footRot: Mat3; knee: Vec3 } {
  const thigh = mulMM(mulMM(rotZ(a.hipYaw), rotX(a.hipRoll)), rotY(a.hipPitch));
  const knee = add3(leg.hip, mulMV(thigh, [0, 0, -leg.thigh]));
  const shin = mulMM(thigh, rotY(a.knee));
  const ankle = add3(knee, mulMV(shin, [0, 0, -leg.shin]));
  const footRot = mulMM(mulMM(shin, rotY(a.anklePitch)), rotX(a.ankleRoll));
  return { ankle, footRot, knee };
}

export function armFK(arm: ArmGeometry, a: ArmAngles): { fist: Vec3; elbow: Vec3; foreRot: Mat3 } {
  const upper = mulMM(mulMM(rotY(a.pitch), rotX(a.roll)), rotZ(a.yaw));
  const elbow = add3(arm.shoulder, mulMV(upper, [0, 0, -arm.upper]));
  const foreRot = mulMM(upper, rotY(a.elbow));
  const fist = add3(elbow, mulMV(foreRot, [0, 0, -arm.fore]));
  return { fist, elbow, foreRot };
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function clampAngle(x: number, lim: JointLimit | undefined): number {
  return lim ? clamp(x, lim.lo, lim.hi) : x;
}

/** Relative rotation helper exposed for callers that need a frame in another frame. */
export const relativeRotation = (parent: Mat3, child: Mat3): Mat3 => mulMtM(parent, child);
