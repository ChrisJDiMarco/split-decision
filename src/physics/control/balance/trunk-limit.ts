// Feasible trunk style (the fight-clean pass, 2026-10-20). Skills and the mocap layers ask the trunk for
// a pelvis dip, a pelvis pitch and roll and a waist bend copied from the actors' clips; a punch plays its
// clip at up to STRIKE_P3.punchRate × the actor's speed, and every acceleration in it scales with the
// square of that. Played as asked, a hook's 3-8 cm dip demanded 3-6 g of vertical acceleration: the legs
// can only drop the body at g, so the feet came off the canvas instead (in sparring the fighters spent 5-6%
// of their time on their feet with neither sole pushing on the canvas, 90% of it in strikes) and landed at
// 3-4 × body weight; and the trunk's tilt, whipped at that rate, asked the stance legs for reaction
// torques worth 20-30 cm of centre-of-pressure shift (I·α / m·g) against soles 7-14 cm long, which the
// gyro core then paid for out of its reserve.
//
// So each style channel tracks what was asked with its acceleration capped at what the body can do with its
// feet loaded and its pressure inside the soles, braking in time (no overshoot: a trunk that tips past its
// target is a wobble), and following a feasible motion without lag:
//   dip          |z̈| ≤ vertAccelG·g: the soles carry m(g + z̈), between (1 − vertAccelG) and
//                (1 + vertAccelG) of the weight, never zero
//   pelvis tilt  |α| ≤ m·g·tiltCopM / I_hips: the upper body turning about the hips moves the pressure
//                point by I·α / (m·g); at most tiltCopM of it
//   waist bend   |α| ≤ m·g·tiltCopM / I_waist (the torso alone about the waist)
// Style is kept, only rate-limited: a slow clip plays as it was, a 2.5× clip's dip comes out shallower.
// Nothing is added to the physics; the targets the servos get are ones the body can follow on the canvas.
// A brace (the knees fold on purpose, the fall is lost), the get-up's rise and a kick (its counter-lean is
// the reaction to its own leg, timed with it) pass through unfiltered.
// Measured (sparring, 32 fights): time on the feet with neither sole on the canvas 5-6% → 1.5-2.8%.
import type { RobotRuntime, SimContext } from '../../sim-context';

/** Tunable (tools sweep it; the worker never changes it). */
export const TRUNK_LIMIT = {
  enabled: 1,
  vertAccelG: 0.35, // the pelvis height target accelerates at most this × g
  tiltCopM: 0.03, // the pelvis tilt and waist bend accelerate at most what moves the COP this far (punches too:
  //               a looser cap through the blow left the trunk moving faster than the footwork cap could stop
  //               once the blow ended, and it tipped past its target: fight drill self-falls 12 → 44)
  omega: 25, // 1/s: near the target the gap closes at this rate (the target's own rate is fed forward, so a
  //            motion the body can follow is followed without lag; only the acceleration cap shapes the rest)
  rateTauS: 0.01, // the target's rate is low-passed this much...
  maxRate: 3, // ...and fed forward up to this (a target that jumps is a gap to close, not a speed to match)
  speedTauS: 0.008, // the channel's speed tracks its wanted speed this fast (within the acceleration cap)
};

const G = 9.81;

class Channel {
  x = 0;
  v = 0;
  primed = false;
  /** The target's own rate (finite differences, lightly filtered): a feasible target is followed without lag. */
  private last = 0;
  private rate = 0;

  /**
   * One tick toward `target` with the acceleration capped at `aMax`; returns the filtered value. The
   * channel's speed follows the target's own speed plus a closing speed: proportional to the gap near the
   * target (time constant 1/omega), never more than it can still brake from at aMax (√(2·aMax·|gap|)), so a
   * step comes in time-optimally without overshoot and a feasible motion is followed without lag.
   */
  step(target: number, aMax: number, dt: number): number {
    if (!this.primed) return this.pass(target);
    const k = Math.min(1, dt / TRUNK_LIMIT.rateTauS);
    this.rate += ((target - this.last) / dt - this.rate) * k;
    this.last = target;
    const gap = target - this.x;
    const lin = TRUNK_LIMIT.omega * gap;
    const brake = Math.sqrt(2 * aMax * Math.abs(gap)) * Math.sign(gap);
    const close = Math.abs(lin) < Math.abs(brake) ? lin : brake;
    const rate = Math.max(-TRUNK_LIMIT.maxRate, Math.min(TRUNK_LIMIT.maxRate, this.rate));
    const a = Math.max(-aMax, Math.min(aMax, (rate + close - this.v) / TRUNK_LIMIT.speedTauS));
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }

  /** Follow `target` exactly from now (a brace, the rise): the filter resumes from here, at rest. */
  pass(target: number): number {
    this.x = this.last = target;
    this.v = this.rate = 0;
    this.primed = true;
    return target;
  }
}

export interface TrunkStyle {
  pelvisDrop: number;
  pelvisPitch: number;
  pelvisRoll: number;
  /** The waist bend beyond the stance's own waist pitch. */
  waistBend: number;
}

export class TrunkLimiter {
  private readonly drop = new Channel();
  private readonly pitch = new Channel();
  private readonly roll = new Channel();
  private readonly bend = new Channel();

  /**
   * `mass`: the whole robot (kg). `hipInertia`, `waistInertia`: what turns about the hips (everything
   * above them) and about the waist (the torso, arms and head), kg·m².
   */
  constructor(private readonly mass: number, private readonly hipInertia: number, private readonly waistInertia: number) {}

  /** Filter the style in place (`bypass`: brace, rise or kick, passed through). */
  apply(style: TrunkStyle, dt: number, bypass: boolean): void {
    if (!TRUNK_LIMIT.enabled || bypass) {
      style.pelvisDrop = this.drop.pass(style.pelvisDrop);
      style.pelvisPitch = this.pitch.pass(style.pelvisPitch);
      style.pelvisRoll = this.roll.pass(style.pelvisRoll);
      style.waistBend = this.bend.pass(style.waistBend);
      return;
    }
    const vert = TRUNK_LIMIT.vertAccelG * G;
    const copTorque = this.mass * G * TRUNK_LIMIT.tiltCopM;
    const hip = copTorque / Math.max(0.05, this.hipInertia);
    const waist = copTorque / Math.max(0.05, this.waistInertia);
    style.pelvisDrop = this.drop.step(style.pelvisDrop, vert, dt);
    style.pelvisPitch = this.pitch.step(style.pelvisPitch, hip, dt);
    style.pelvisRoll = this.roll.step(style.pelvisRoll, hip, dt);
    style.waistBend = this.bend.step(style.waistBend, waist, dt);
  }

  /** Start over (a fall, the gantry): the next target is taken as it is. */
  reset(): void {
    this.drop.primed = this.pitch.primed = this.roll.primed = this.bend.primed = false;
  }
}

/**
 * The limiter for robot `r`, its inertias from the model as it stands (MuJoCo's body masses, inertias and
 * centres): about the hips, every part above them (pelvis, torso, arms, head) turning about the line
 * through both hip joints; about the waist, the torso and what it carries turning about the waist joint.
 */
export function trunkLimiterFor(ctx: SimContext, r: RobotRuntime, mass: number): TrunkLimiter {
  const xipos = ctx.data.xipos as Float64Array;
  const xpos = ctx.data.xpos as Float64Array;
  const bm = ctx.model.body_mass as Float64Array;
  const inertia = ctx.model.body_inertia as Float64Array;
  const body = (id: string) => r.parts.get(id)?.body ?? -1;
  const tl = body('thigh_l'), tr = body('thigh_r'), torso = body('torso');
  if (tl < 0 || tr < 0 || torso < 0) return new TrunkLimiter(mass, 1, 1);
  // The hip pitch axis: through both hip joints (the thighs' origins), left to right.
  const hip = [(xpos[tl * 3] + xpos[tr * 3]) / 2, (xpos[tl * 3 + 1] + xpos[tr * 3 + 1]) / 2, (xpos[tl * 3 + 2] + xpos[tr * 3 + 2]) / 2];
  let ax = xpos[tl * 3] - xpos[tr * 3], ay = xpos[tl * 3 + 1] - xpos[tr * 3 + 1];
  const n = Math.hypot(ax, ay) || 1;
  ax /= n;
  ay /= n;
  const about = (b: number, p: number[]): number => {
    const dx = xipos[b * 3] - p[0], dy = xipos[b * 3 + 1] - p[1], dz = xipos[b * 3 + 2] - p[2];
    const along = dx * ax + dy * ay;
    const own = (inertia[b * 3] + inertia[b * 3 + 1] + inertia[b * 3 + 2]) / 3;
    return bm[b] * (dx * dx + dy * dy + dz * dz - along * along) + own;
  };
  const waistPivot = [xpos[torso * 3], xpos[torso * 3 + 1], xpos[torso * 3 + 2]];
  let iHip = 0, iWaist = 0;
  for (const [id, part] of r.parts) {
    if (/^(thigh|shin|foot)_/.test(id)) continue;
    iHip += about(part.body, hip);
    if (id !== 'pelvis') iWaist += about(part.body, waistPivot);
  }
  return new TrunkLimiter(mass, iHip, iWaist);
}
