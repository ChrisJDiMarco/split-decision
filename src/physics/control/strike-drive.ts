// How the striking chain's servos are driven while a blow is on its way (docs/design/strike-power.md
// §2.1, balance engine only; the legacy path keeps its servos exactly as built):
//   burst       through the windup, the strike and the first moments of contact the chain's servos
//               track the planned velocity instead of braking it: their damping drops to BURST.damp
//               of as built (an MIT-mode drive sets Kd every frame). kp, the torque-speed line, heat,
//               health and battery are unchanged, so no torque is added; the recovery restores the
//               damping and the limb brakes on the full braking quadrant
//   inertia     the acceleration the chain's targets ask for is fed forward as a target shift
//               (M·q̈)/kp: the diagonal of MuJoCo's own joint-space inertia (the subtree each joint
//               swings) times the targets' acceleration, clamped to the torque the motor has left
//               (BURST.headroom of it) and to ±0.35 rad. With the gravity / ground-force feed-forward
//               already in the targets, the servo no longer has to fall behind to find the torque.
import type { RobotRuntime, SimContext } from '../sim-context';
import { effectiveKp, type VelocityFeedforward } from './feedforward';
import type { Side } from './geometry';
import { isStrikeSkill } from './skills';
import type { SkillRun } from './skills/types';

/** Tunables (exported so tools can sweep them; the worker never changes them). */
export const BURST = {
  damp: 0.15, // servo damping on the striking chain while the blow is on its way, × as built
  // Kicks keep their damping: in the strike drill a kicking leg swung with it cut whipped past its
  // aim and threw the thrower (falls per 10 kicks 2.1-2.5 → 3.8-4.4); a punching arm does not.
  kicks: 0,
  followS: 0.06, // ...kept this long into the recovery (the follow-through through contact)
  inertia: 1, // share of M·q̈ fed forward (0: off)
  headroom: 0.9, // the feed-forward never asks for more than this share of the torque available
  maxShiftRad: 0.35,
  accelTauS: 0.008, // the targets' acceleration is low-passed this much (it is a difference of rates)
};

const ARM = (s: Side) => [`shoulder_pitch_${s}`, `shoulder_roll_${s}`, `shoulder_yaw_${s}`, `elbow_${s}`, 'waist_yaw', 'waist_pitch'];
const LEG = (s: Side) => [`hip_yaw_${s}`, `hip_roll_${s}`, `hip_pitch_${s}`, `knee_${s}`, 'waist_yaw', 'waist_pitch'];

/** The striking side of a run: the part that lands (a mirrored clip strikes with the other side). */
export function strikeSide(run: SkillRun): Side | null {
  const first = run.strikers?.[0] ?? run.def.strikers[0];
  const m = first ? /_([lr])$/.exec(first) : null;
  return m ? (m[1] as Side) : run.def.side;
}

/** Is the blow still on its way (windup, strike, or just into the recovery)? */
export function burstLive(run: SkillRun | null): boolean {
  if (!run || !isStrikeSkill(run.def) || (run.def.kind === 'leg' && !BURST.kicks)) return false;
  return run.phase === 'windup' || run.phase === 'strike' || (run.phase === 'recover' && run.t < BURST.followS);
}

export class StrikeDrive {
  private readonly chains = new Map<string, Int16Array>();
  private readonly upper: Int16Array;
  private readonly diag: Int32Array;
  private readonly prevRate: Float64Array;
  private readonly accel: Float64Array;
  private chain: Int16Array | null = null;
  private primed = false;
  /** Diagnostics: control ticks with the burst on. */
  ticks = 0;

  constructor(ctx: SimContext, private readonly r: RobotRuntime, upperJoints: readonly number[]) {
    this.upper = Int16Array.from(upperJoints);
    const m = ctx.model;
    // Row i of MuJoCo's CSR mass matrix ends on its diagonal (lower triangle, columns ascending).
    this.diag = Int32Array.from(r.joints, (j) => (m.M_rowadr[j.dadr] as number) + (m.M_rownnz[j.dadr] as number) - 1);
    this.prevRate = new Float64Array(r.joints.length);
    this.accel = new Float64Array(r.joints.length);
  }

  private chainOf(kind: 'arm' | 'leg', side: Side): Int16Array {
    const key = `${kind}${side}`;
    let c = this.chains.get(key);
    if (!c) {
      const names = kind === 'arm' ? ARM(side) : LEG(side);
      c = Int16Array.from(names.map((n) => this.r.jointIndex.get(n) ?? -1).filter((i) => i >= 0));
      this.chains.set(key, c);
    }
    return c;
  }

  /**
   * Every control tick on the balance engine, after the engine has written its gain scales: the
   * burst's damping on the chain of the blow under way (the arms and waist go back to as built
   * otherwise; the legs' scales are the engine's, rewritten every tick).
   */
  impedance(run: SkillRun | null): void {
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    this.chain = null;
    if (!kv) return;
    for (const i of this.upper) kv[i] = 1;
    if (!burstLive(run)) return;
    const side = strikeSide(run!);
    if (!side) return;
    const chain = this.chainOf(run!.def.kind === 'leg' ? 'leg' : 'arm', side);
    for (const i of chain) kv[i] = Math.min(kv[i], BURST.damp);
    this.chain = chain;
    this.ticks++;
  }

  /**
   * The inertial feed-forward on the burst chain: the acceleration of the targets (from the
   * velocity feed-forward's filtered target rates) through the diagonal of the joint-space inertia.
   */
  inertia(ctx: SimContext, targets: Float64Array, velFF: VelocityFeedforward, dt: number): void {
    const rate = velFF.rates;
    const n = targets.length;
    const a = dt / (BURST.accelTauS + dt);
    if (!this.primed) {
      for (let i = 0; i < n; i++) this.prevRate[i] = rate[i];
      this.primed = true;
    }
    for (let i = 0; i < n; i++) {
      const acc = (rate[i] - this.prevRate[i]) / dt;
      this.prevRate[i] = rate[i];
      this.accel[i] += (acc - this.accel[i]) * a;
    }
    const chain = this.chain;
    if (!chain || BURST.inertia <= 0) return;
    const M = ctx.data.M as Float64Array;
    for (const i of chain) {
      const kp = effectiveKp(this.r, i);
      if (kp <= 0) continue;
      const avail = this.r.joints[i].availableTorque * BURST.headroom;
      const tau = Math.max(-avail, Math.min(avail, BURST.inertia * M[this.diag[i]] * this.accel[i]));
      targets[i] += Math.max(-BURST.maxShiftRad, Math.min(BURST.maxShiftRad, tau / kp));
    }
  }

  reset(): void {
    this.primed = false;
    this.accel.fill(0);
    this.chain = null;
  }
}
