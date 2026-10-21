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
import type { JointDynamics } from './strike-path';

/** Tunables (exported so tools can sweep them; the worker never changes them). */
export const BURST = {
  // Servo damping on the striking chain while the blow is on its way, × as built: the drive tracks the
  // planned velocity (an MIT-mode drive sets Kd every frame) and the motor runs on its torque-speed line,
  // not against its own servo's drag (Chris, 2026-10-20: run the limbs at the top of the real curve, never a
  // cautious fraction). The gantry (tools/motor-variants.ts --gantry) puts the fist's ceiling at 0.02: elbow
  // snap 6.92 / 8.39 / 7.35 / 8.62 m/s against 6.68 / 8.03 / 7.21 / 8.24 at 0.15 (FIRECRACKER / SAVATE /
  // HAYMAKER / PYLON). Ringing after the contact is what contactS is for.
  damp: 0.03,
  // Kicks keep their damping: in the strike drill a kicking leg swung with it cut whipped past its
  // aim and threw the thrower (falls per 10 kicks 2.1-2.5 → 3.8-4.4); a punching arm does not.
  kicks: 0,
  followS: 0.06, // ...kept this long into the recovery (the follow-through through contact)
  // ...and for a blow that has landed, this long after its contact at most (Infinity: as the phases say). The
  // burst is for getting the fist up to speed: once it has met him, the as-built damping catches the arm's
  // recoil off the contact instead of letting it ring at the burst's low damping (sparring, 32 fights without
  // the gyro-damage coupling: the burst at 0.03 to the end of the follow-through 25 self-falls, cut 10 ms after
  // the contact 17, as at 0.15).
  contactS: 0.01,
  inertia: 1, // share of M·q̈ fed forward (0: off)
  headroom: 1, // the feed-forward never asks for more than this share of the torque available (the motor model caps the rest)
  maxShiftRad: 0.35,
  accelTauS: 0.008, // the targets' acceleration is low-passed this much (it is a difference of rates)
  // Through a punch the stance hip yaws hold the pelvis at this gain scale (the balance engine's 0.35
  // otherwise, BALANCE_TUNING.stanceHipYawKp): the chest's turn reacts on the pelvis, and a soft hip lets
  // the pelvis spin back as the chest goes forward, wasting the waist's work. The feet's grip limits the
  // turn instead (mocap/strikes.ts STRIKE_P3.groundYawShare).
  hipYawKp: 1,
};

const ARM = (s: Side) => [`shoulder_pitch_${s}`, `shoulder_roll_${s}`, `shoulder_yaw_${s}`, `elbow_${s}`, 'waist_yaw', 'waist_pitch'];
const LEG = (s: Side) => [`hip_yaw_${s}`, `hip_roll_${s}`, `hip_pitch_${s}`, `knee_${s}`, 'waist_yaw', 'waist_pitch'];

/** The striking side of a run: the part that lands (a mirrored clip strikes with the other side). */
export function strikeSide(run: SkillRun): Side | null {
  const first = run.strikers?.[0] ?? run.def.strikers[0];
  const m = first ? /_([lr])$/.exec(first) : null;
  return m ? (m[1] as Side) : run.def.side;
}

/** Is the blow still on its way (windup, strike, or just into the recovery)? `sinceContact`: s since it landed (−1: not yet). */
export function burstLive(run: SkillRun | null, sinceContact = -1): boolean {
  if (!run || !isStrikeSkill(run.def) || (run.def.kind === 'leg' && !BURST.kicks)) return false;
  if (sinceContact >= BURST.contactS) return false;
  return run.phase === 'windup' || run.phase === 'strike' || (run.phase === 'recover' && run.t < BURST.followS);
}

/**
 * The robot's dynamics for planning a blow (strike-path.ts): MuJoCo's joint-space inertia diagonal and
 * bias torque at this step, and the share of each motor's torque that health and battery leave (the
 * motor model's factors, src/physics/systems/motors.ts; the thermal derating is left to the margin).
 */
class Dynamics implements JointDynamics {
  ctx: SimContext | null = null;
  constructor(private readonly r: RobotRuntime, private readonly diag: Int32Array) {}
  inertia(i: number): number {
    return (this.ctx!.data.M as Float64Array)[this.diag[i]];
  }
  bias(i: number): number {
    return (this.ctx!.data.qfrc_bias as Float64Array)[this.r.joints[i].dadr];
  }
  torqueScale(i: number): number {
    const j = this.r.joints[i];
    if (j.state === 'limp' || j.state === 'seized') return 0;
    return (0.25 + 0.75 * j.health) * (0.6 + 0.4 * this.r.battery);
  }
}

export class StrikeDrive {
  private readonly chains = new Map<string, Int16Array>();
  /** The dynamics for the skill environment (bound to the step each control tick). */
  readonly dyn: Dynamics;
  private readonly upper: Int16Array;
  private readonly diag: Int32Array;
  private readonly prevRate: Float64Array;
  private readonly accel: Float64Array;
  private chain: Int16Array | null = null;
  private primed = false;
  /** The blow whose contact is being timed, and how long ago it landed (s; −1 before). */
  private landedRun: SkillRun | null = null;
  private sinceContact = -1;
  /** Diagnostics: control ticks with the burst on. */
  ticks = 0;

  constructor(ctx: SimContext, private readonly r: RobotRuntime, upperJoints: readonly number[]) {
    this.upper = Int16Array.from(upperJoints);
    const m = ctx.model;
    // Row i of MuJoCo's CSR mass matrix ends on its diagonal (lower triangle, columns ascending).
    this.diag = Int32Array.from(r.joints, (j) => (m.M_rowadr[j.dadr] as number) + (m.M_rownnz[j.dadr] as number) - 1);
    this.prevRate = new Float64Array(r.joints.length);
    this.accel = new Float64Array(r.joints.length);
    this.dyn = new Dynamics(r, this.diag);
  }

  /** The striking chain whose burst is on this tick (r.joints indices), or null. */
  get burstChain(): Int16Array | null {
    return this.chain;
  }

  /** This control tick's step (the dynamics read MjData). */
  bind(ctx: SimContext): void {
    this.dyn.ctx = ctx;
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
   * otherwise; the legs' scales are the engine's, rewritten every tick), and through a punch the
   * stance hips' yaw gain (BURST.hipYawKp) for the `planted` legs.
   */
  impedance(run: SkillRun | null, planted?: (side: Side) => boolean, dt = 0): void {
    const kv = this.r.mem.dampScale as Float64Array | undefined;
    const kp = this.r.mem.gainScale as Float64Array | undefined;
    this.chain = null;
    if (run !== this.landedRun) {
      this.landedRun = run;
      this.sinceContact = -1;
    }
    if (run?.landed) this.sinceContact = this.sinceContact < 0 ? 0 : this.sinceContact + dt;
    if (!kv) return;
    for (const i of this.upper) kv[i] = 1;
    if (!burstLive(run, this.sinceContact)) return;
    const side = strikeSide(run!);
    if (!side) return;
    const chain = this.chainOf(run!.def.kind === 'leg' ? 'leg' : 'arm', side);
    for (const i of chain) kv[i] = Math.min(kv[i], BURST.damp);
    this.chain = chain;
    this.ticks++;
    if (kp && planted && run!.def.kind === 'arm') {
      for (const sd of ['l', 'r'] as const) {
        const i = this.r.jointIndex.get(`hip_yaw_${sd}`);
        if (i === undefined || !planted(sd)) continue;
        kp[i] = BURST.hipYawKp;
        kv[i] = Math.sqrt(BURST.hipYawKp);
      }
    }
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
    this.landedRun = null;
    this.sinceContact = -1;
  }
}
