// Per-frame features of a human track in the actor's facing frame (x toward where the actor is
// looking, y left, z up): what the segmenter reads to find and classify moves.
//
// Facing is the head's heading: a fighter watches the opponent, so the head points at the target
// even when the hips are bladed or turned over into a kick. It is circularly smoothed so a glance
// doesn't swing it.
import type { Vec3 } from '../../core/types';
import { CONTACT, humanContacts } from './contacts';
import { fr, pt, SIDES, type HumanTrack, type PointId, type Side } from './human';
import { col, smooth, wrapAngle } from './math';

export interface LimbKin {
  /** n × 3: position in the facing frame relative to the anchor (fists: chest, ankles: hip centre). */
  rel: Float64Array;
  /** n × 3: velocity of `rel` (fists) or of the world point (ankles), facing-frame axes, m/s. */
  vel: Float64Array;
  /** n: |vel|, lightly smoothed. */
  speed: Float64Array;
}

export interface Kin {
  tr: HumanTrack;
  n: number;
  fps: number;
  yaw: Float64Array; // facing heading, radians (smoothed, unwrapped per frame to (-π, π])
  pelvisYaw: Float64Array;
  contacts: Uint8Array;
  fist: Record<Side, LimbKin>;
  shoulder: Record<Side, Float64Array>; // n × 3, facing frame relative to the chest
  elbow: Record<Side, Float64Array>; // n × 3, facing frame relative to the chest
  ankle: Record<Side, LimbKin>;
  /** Lead-foot signal: (ankle L − ankle R) along the facing, m (> 0: left foot forward, orthodox). */
  stance: Float64Array;
  /** Hip-centre horizontal velocity in the facing frame (n × 2) and speed, smoothed. */
  hipVel: Float64Array;
  hipSpeed: Float64Array;
  /** Hip-centre height / standing hip height. */
  hipRatio: Float64Array;
  /** Chest up axis · world up (1 upright, 0 lying). */
  chestUp: Float64Array;
  /** Chest forward axis · world up (−1 face down, +1 face up). */
  chestFwdUp: Float64Array;
  /** Mean speed of the major body points (stillness), m/s. */
  bodySpeed: Float64Array;
}

const YAW_SMOOTH = 25; // frames
const SPEED_SMOOTH = 3;
const HIP_SMOOTH = 13;

/** Heading of the head (falls back to the chest when the head looks straight up or down). */
function rawHeading(tr: HumanTrack, i: number): number {
  const H = col(fr(tr, 'head', i), 0);
  if (Math.hypot(H[0], H[1]) > 0.35) return Math.atan2(H[1], H[0]);
  const C = col(fr(tr, 'chest', i), 0);
  return Math.atan2(C[1], C[0]);
}

/** Circular moving average of an angle series. */
export function smoothAngles(a: ArrayLike<number>, window: number): Float64Array {
  const s = new Float64Array(a.length), c = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    s[i] = Math.sin(a[i]);
    c[i] = Math.cos(a[i]);
  }
  const ss = smooth(s, window), cs = smooth(c, window);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.atan2(ss[i], cs[i]);
  return out;
}

/** World vector → facing frame of heading `yaw`. */
export function toFacing(v: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

function diff3(src: Float64Array, n: number, fps: number): Float64Array {
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    if (a === b) continue;
    const k = fps / (b - a);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = (src[b * 3 + c] - src[a * 3 + c]) * k;
  }
  return out;
}

function norms(v: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
  return out;
}

export function kinematics(tr: HumanTrack): Kin {
  const n = tr.n, fps = tr.fps;
  const rawYaw = new Float64Array(n);
  for (let i = 0; i < n; i++) rawYaw[i] = rawHeading(tr, i);
  const yaw = smoothAngles(rawYaw, YAW_SMOOTH);
  const pelvisYaw = new Float64Array(n);
  const chestUp = new Float64Array(n), chestFwdUp = new Float64Array(n), hipRatio = new Float64Array(n);
  const stance = new Float64Array(n);
  const S: Record<Side, 'L' | 'R'> = { l: 'L', r: 'R' };
  const series3 = () => new Float64Array(n * 3);
  const fistRel = { l: series3(), r: series3() }, shoulder = { l: series3(), r: series3() }, elbow = { l: series3(), r: series3() };
  const ankleRel = { l: series3(), r: series3() }, ankleWorld = { l: series3(), r: series3() };
  const fistChestWorld = { l: series3(), r: series3() };
  const hipWorld = series3();
  const bodyPts: PointId[] = ['hipC', 'chest', 'head', 'fistL', 'fistR', 'ankleL', 'ankleR', 'kneeL', 'kneeR'];
  const bodyWorld = bodyPts.map(() => series3());
  for (let i = 0; i < n; i++) {
    const y = yaw[i];
    const P = fr(tr, 'pelvis', i), C = fr(tr, 'chest', i);
    pelvisYaw[i] = Math.atan2(P[3], P[0]);
    chestUp[i] = C[8];
    chestFwdUp[i] = C[6];
    const hc = pt(tr, 'hipC', i), ch = pt(tr, 'chest', i);
    hipRatio[i] = hc[2] / tr.dims.standHipHeight;
    hipWorld.set(hc, i * 3);
    const rel = (p: Vec3, o: Vec3) => toFacing([p[0] - o[0], p[1] - o[1], p[2] - o[2]], y);
    for (const s of SIDES) {
      const fw = pt(tr, `fist${S[s]}`, i);
      fistRel[s].set(rel(fw, ch), i * 3);
      fistChestWorld[s].set([fw[0] - ch[0], fw[1] - ch[1], fw[2] - ch[2]], i * 3);
      shoulder[s].set(rel(pt(tr, `shoulder${S[s]}`, i), ch), i * 3);
      elbow[s].set(rel(pt(tr, `elbow${S[s]}`, i), ch), i * 3);
      ankleRel[s].set(rel(pt(tr, `ankle${S[s]}`, i), hc), i * 3);
      ankleWorld[s].set(pt(tr, `ankle${S[s]}`, i), i * 3);
    }
    const al = pt(tr, 'ankleL', i), ar = pt(tr, 'ankleR', i);
    stance[i] = toFacing([al[0] - ar[0], al[1] - ar[1], 0], y)[0];
    bodyPts.forEach((id, k) => bodyWorld[k].set(pt(tr, id, i), i * 3));
  }
  // Velocities are differenced in world axes, then turned onto the facing axes of their frame
  // (differencing facing-frame positions would add the heading's turn rate × distance).
  const limb = (relSeries: Float64Array, worldSource: Float64Array): LimbKin => {
    const w = diff3(worldSource, n, fps);
    const vel = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) vel.set(toFacing([w[i * 3], w[i * 3 + 1], w[i * 3 + 2]], yaw[i]), i * 3);
    return { rel: relSeries, vel, speed: smooth(norms(vel, n), SPEED_SMOOTH) };
  };
  const hipV = diff3(hipWorld, n, fps);
  const hipVel = new Float64Array(n * 2), hipSpeedRaw = new Float64Array(n);
  const hx = smooth(Array.from({ length: n }, (_, i) => hipV[i * 3]), HIP_SMOOTH);
  const hy = smooth(Array.from({ length: n }, (_, i) => hipV[i * 3 + 1]), HIP_SMOOTH);
  for (let i = 0; i < n; i++) {
    const v = toFacing([hx[i], hy[i], 0], yaw[i]);
    hipVel[i * 2] = v[0];
    hipVel[i * 2 + 1] = v[1];
    hipSpeedRaw[i] = Math.hypot(v[0], v[1]);
  }
  const bodyRaw = new Float64Array(n);
  for (const w of bodyWorld) {
    const sp = norms(diff3(w, n, fps), n);
    for (let i = 0; i < n; i++) bodyRaw[i] += sp[i] / bodyWorld.length;
  }
  return {
    tr, n, fps, yaw, pelvisYaw, contacts: humanContacts(tr),
    fist: { l: limb(fistRel.l, fistChestWorld.l), r: limb(fistRel.r, fistChestWorld.r) },
    shoulder, elbow,
    ankle: { l: limb(ankleRel.l, ankleWorld.l), r: limb(ankleRel.r, ankleWorld.r) },
    stance, hipVel, hipSpeed: hipSpeedRaw, hipRatio, chestUp, chestFwdUp, bodySpeed: smooth(bodyRaw, 9),
  };
}

export const v3 = (a: Float64Array, i: number): Vec3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];

/** Is the foot of `side` planted at frame i? */
export const footDown = (k: Kin, side: Side, i: number): boolean =>
  (k.contacts[i] & (side === 'l' ? CONTACT.FOOT_L : CONTACT.FOOT_R)) !== 0;

/** Circular mean heading over [a, b). */
export function meanYaw(yaw: ArrayLike<number>, a: number, b: number): number {
  let s = 0, c = 0;
  for (let i = Math.max(0, a); i < Math.min(yaw.length, b); i++) {
    s += Math.sin(yaw[i]);
    c += Math.cos(yaw[i]);
  }
  return Math.atan2(s, c);
}

export const yawDiff = (a: number, b: number): number => wrapAngle(a - b);
