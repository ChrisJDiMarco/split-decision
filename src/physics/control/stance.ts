// The fighting stance, derived from each design's proportions: an orthodox stagger (left foot
// leads), rear foot turned out, pelvis bladed a little toward the right, hands up by the chin.
import type { Vec3 } from '../../core/types';
import type { HumanoidGeometry, Side } from './geometry';

export interface FootSlot {
  x: number; // sole centre in the stance frame (x toward the opponent)
  y: number;
  yaw: number; // foot yaw relative to the stance heading
}

export interface StanceParams {
  lead: Side;
  slots: Record<Side, FootSlot>;
  pelvisYaw: number; // pelvis yaw relative to the stance heading
  waistYaw: number;
  waistPitch: number;
  pelvisHeight: number; // pelvis origin above the canvas
  guard: Record<Side, { fist: Vec3; pole: Vec3 }>; // torso frame
  legExtension: number; // hip→ankle span / (thigh + shin) in the stance
}

const LEG_EXTENSION = 0.95; // straighter knees carry the weight with less torque
const HALF_LENGTH_PER_LEG = 0.14; // stagger, fraction of leg length: inside single-support reach
const WIDTH_FRACTION = 0.8; // lateral half-width as a fraction of hip offset: narrow enough to step
const LEAD_FOOT_YAW = -0.05;
const REAR_FOOT_YAW = -0.5;
const PELVIS_BLADE = -0.28;
const WAIST_TURN_BACK = 0.12;
const GUARD_LEAD = 0.5; // lead fist reach, fraction of arm reach
const GUARD_REAR = 0.36;
const WAIST_PITCH = 0.06;

/** Stance proportions a caller may override (the balance engine widens the stance). */
export interface StanceOptions {
  widthFraction?: number; // lateral half-width, × hip offset
  halfLengthPerLeg?: number; // stagger, × leg length
}

export function stanceFor(geo: HumanoidGeometry, opts: StanceOptions = {}): StanceParams {
  const L = geo.legLength;
  const leg = geo.legs.l;
  const hipY = Math.abs(leg.hip[1]);
  const halfLength = (opts.halfLengthPerLeg ?? HALF_LENGTH_PER_LEG) * L;
  const halfWidth = hipY * (opts.widthFraction ?? WIDTH_FRACTION);
  const span = LEG_EXTENSION * L;
  const vertical = Math.sqrt(Math.max(0.1, span * span - halfLength * halfLength));
  const pelvisHeight = leg.soleDepth + vertical - leg.hip[2];
  const neckZ = geo.neck[2];
  const reach = geo.arms.l.upper + geo.arms.l.fore;
  const shoulderY = Math.abs(geo.arms.l.shoulder[1]);
  return {
    lead: 'l',
    slots: {
      l: { x: halfLength, y: halfWidth, yaw: LEAD_FOOT_YAW },
      r: { x: -halfLength, y: -halfWidth, yaw: REAR_FOOT_YAW },
    },
    pelvisYaw: PELVIS_BLADE,
    waistYaw: WAIST_TURN_BACK,
    waistPitch: WAIST_PITCH,
    pelvisHeight,
    guard: {
      // Lead hand out in front of the chin, rear hand tight by the cheek. Elbows down.
      l: { fist: [GUARD_LEAD * reach, 0.42 * shoulderY, neckZ + 0.02], pole: [-0.2, 0.35, -1] },
      r: { fist: [GUARD_REAR * reach, -0.5 * shoulderY, neckZ + 0.05], pole: [-0.2, -0.35, -1] },
    },
    legExtension: LEG_EXTENSION,
  };
}
