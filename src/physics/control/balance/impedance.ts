// Joint impedance on the balance engine (docs/design/balance-engine.md §3.6): per-joint gain and
// damping scales, written every control tick into r.mem.gainScale / r.mem.dampScale and multiplied
// into the MuJoCo position servos by the motor system (src/physics/systems/motors.ts), the way an
// MIT-mode drive takes Kp and Kd in every CAN frame. No torque is added: the torque-speed line, heat,
// health and battery limits are the motor model's, as before.
//
//   stance legs   soft: the inverse-dynamics feed-forward (feedforward.ts) carries the load and the
//                 spring only corrects, so a tracking error no longer throws the centre of pressure to
//                 a sole edge, and a bent, soft knee takes up a touchdown or a hit instead of passing
//                 it to the trunk. Ankles 0.3, knee and hip pitch and roll 0.5, hip yaw 0.35
//   swing legs    stiff (1.0): the foot lands where the step adjuster aims it
//   kicking leg   the skill's (1.0)
//   the rest      as built here; the strike drive (strike-drive.ts) sets the striking chain's
//                 damping and a punch's stance hip yaw after this writes
//
// kv scales with √(kp scale), keeping each joint's damping ratio. A planted foot's scales follow
// the weight the plan puts on it (the planned COP's load share): a foot unloading to lift is stiff
// again by the time it leaves the canvas, and a landing foot softens as the weight comes onto it.
// Every scale moves at most IMPEDANCE.ratePerS per second (a step in kp with a position error in
// place is a step in torque).
import type { RobotRuntime } from '../../sim-context';
import type { Gait } from '../gait';
import { SIDES, type Side } from '../geometry';
import type { JointMap } from '../posture';

/** Tunable (tools sweep it; the worker never changes it). */
export const IMPEDANCE = {
  leg: 0.5, // stance knee, hip pitch and hip roll kp scale (§3.6)
  // ...of the leg a kick stands on (the gait's shift and skill phases). Braced at 1 the strike drill's kicks
  // landed 36 of 72 with 6 falls against 37 and 5 at 0.5: kept as soft as any stance leg.
  kickStance: 0.5,
  loadFull: 0.3, // a planted foot carrying this share of the weight or more is fully soft
  ratePerS: 15, // a scale changes at most this much per second
};

/** The stance values the engine passes in (BALANCE_TUNING's, so the tools' old tunables still work). */
export interface StanceScales {
  ankle: number;
  hipYaw: number;
}

export class Impedance {
  /** The scales in force (kp; kv is its square root), by r.joints index. */
  private readonly cur: Float64Array;

  constructor(private readonly r: RobotRuntime, private readonly jm: JointMap) {
    this.cur = new Float64Array(r.joints.length).fill(1);
  }

  /** The arrays the motor system reads (created on first use, all 1). */
  private arrays(): { kp: Float64Array; kv: Float64Array } {
    const r = this.r;
    let kp = r.mem.gainScale as Float64Array | undefined;
    let kv = r.mem.dampScale as Float64Array | undefined;
    if (!kp || !kv) {
      kp = new Float64Array(r.joints.length).fill(1);
      kv = new Float64Array(r.joints.length).fill(1);
      r.mem.gainScale = kp;
      r.mem.dampScale = kv;
    }
    return { kp, kv };
  }

  /**
   * One control tick. `share(side)`: the share of the weight the plan puts on that foot (0..1; 0 when
   * it is not planted). Legs lent to a skill (a kick) are stiff.
   */
  write(gait: Gait, share: (side: Side) => number, stance: StanceScales, dt: number): void {
    const { kp, kv } = this.arrays();
    const step = IMPEDANCE.ratePerS * dt;
    const leg = gait.phase === 'shift' || gait.phase === 'skill' ? IMPEDANCE.kickStance : IMPEDANCE.leg;
    for (const side of SIDES) {
      const f = gait.feet[side];
      const m = this.jm.leg[side];
      // 0 = stiff (swing, kick, unloaded), 1 = carrying its full share.
      const soft = f.phase === 'planted' ? Math.min(1, share(side) / IMPEDANCE.loadFull) : 0;
      this.set(m.anklePitch, 1 + (stance.ankle - 1) * soft, step, kp, kv);
      this.set(m.ankleRoll, 1 + (stance.ankle - 1) * soft, step, kp, kv);
      this.set(m.knee, 1 + (leg - 1) * soft, step, kp, kv);
      this.set(m.hipPitch, 1 + (leg - 1) * soft, step, kp, kv);
      this.set(m.hipRoll, 1 + (leg - 1) * soft, step, kp, kv);
      // A planted sole's torsional grip is a fraction of the hip yaw's torque: the stance hip yaw turns
      // the body with a softer spring, so a heading error does not spin the sole (any load at all).
      this.set(m.hipYaw, f.phase === 'planted' ? stance.hipYaw : 1, step, kp, kv);
    }
  }

  private set(i: number, want: number, step: number, kp: Float64Array, kv: Float64Array): void {
    const c = this.cur[i];
    const v = want > c + step ? c + step : want < c - step ? c - step : want;
    this.cur[i] = v;
    kp[i] = v;
    kv[i] = Math.sqrt(v);
  }

  /** Back to the servos as built (legacy path, a knockout, the get-up); the next write ramps from there. */
  clear(): void {
    const kp = this.r.mem.gainScale as Float64Array | undefined;
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    kp?.fill(1);
    kv?.fill(1);
    this.cur.fill(1);
  }
}
