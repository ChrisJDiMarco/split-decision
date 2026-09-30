// Balance metrics for one fighter (docs/design/balance-engine.md §8), sampled after every physics
// step by tools/balance-drills.ts and tools/fight-metrics.ts. Works on both balance paths: it
// reads the controller's probe (planned COP, DCM and its reference, touchdowns) and MuJoCo.
//
//   approach      closing speed (own COM velocity toward the opponent) while more than 1.3 m
//                 apart; time to 1.3 m
//   footwork      single-support share inside 2 m; touchdowns after arriving at the goal
//   smoothness    torso pitch/roll rate RMS below and above 3 Hz (2nd-order Butterworth split);
//                 torso tilt peak beyond the standing lean; pelvis height std; largest planned-COP
//                 jump in one control tick; DCM error RMS
//   effort        share of control ticks with a planted-leg servo at its torque limit (no skill
//                 running); gyro saturation while stepping or standing; free momentum at touchdown
import type { SimEvent } from '../../src/core/protocol';
import { controllerOf, type HumanoidController } from '../../src/physics/control';
import type { RobotRuntime, SimContext } from '../../src/physics/sim-context';

export const APPROACH_MIN_DIST_M = 1.3;
const INSIDE_M = 2.0;
const SPLIT_HZ = 3;
const LIMIT_FRAC = 0.98; // |servo torque| ≥ this × available: at the limit
const ARRIVE_M = 0.12; // stance frame this close to the goal: arrived
const RUBBISH_TICK_S = 0.004; // the first ticks after the recorder starts carry no jump

/** Second-order Butterworth low-pass (bilinear), one channel. */
class LowPass {
  private readonly b0: number;
  private readonly b1: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private primed = false;

  constructor(fc: number, fs: number) {
    const K = Math.tan((Math.PI * fc) / fs);
    const n = 1 / (1 + Math.SQRT2 * K + K * K);
    this.b0 = K * K * n;
    this.b1 = 2 * this.b0;
    this.a1 = 2 * (K * K - 1) * n;
    this.a2 = (1 - Math.SQRT2 * K + K * K) * n;
  }

  step(x: number): number {
    if (!this.primed) {
      this.x1 = this.x2 = this.y1 = this.y2 = x;
      this.primed = true;
    }
    const y = this.b0 * x + this.b1 * this.x1 + this.b0 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export interface FallNote {
  t: number; // s after the recorder started
  activity: string; // what the body was doing at the fall: stepping, standing, striking, kicking, rising, ...
  doing: string[]; // skills seen in the 1.5 s before
}

export interface BalanceMetrics {
  seconds: number;
  falls: FallNote[];
  closingSpeed: number; // m/s, while more than 1.3 m apart (NaN if never)
  closingSeconds: number;
  timeTo13: number; // s from the start to 1.3 m apart (Infinity if never)
  singleInside2: number; // share of the time inside 2 m spent on one foot
  insideSeconds: number;
  arrivedAt: number; // s (Infinity if never)
  stepsAfterArrive: number;
  touchdowns: number;
  torsoRateLow: number; // rad/s RMS, pitch/roll below 3 Hz
  torsoRateHigh: number; // ... above 3 Hz
  standingLeanDeg: number;
  tiltPeakDeg: number; // beyond the standing lean
  pelvisStdCm: number;
  copJumpCm: number; // largest planned-COP jump in one control tick
  copJumpP99Cm: number;
  dcmErrCm: number; // RMS
  servoLimitShare: number; // control ticks with a planted-leg servo at its limit (no skill running)
  gyroSatFootwork: number; // mean while stepping or standing
  gyroSatPeak: number;
  reserveAtTouchdown: number; // mean free momentum at touchdown (1 = empty rotor)
  reserveAtTouchdownMin: number;
}

const legJoint = /^(hip|knee|ankle)_/;

export class BalanceRecorder {
  readonly c: HumanoidController;
  private readonly r: RobotRuntime;
  private readonly opp: RobotRuntime;
  private readonly torso: number;
  private readonly legIdx: Array<{ i: number; side: 'l' | 'r' }> = [];
  private t0 = -1;
  private tick = 0;
  private readonly lpX: LowPass;
  private readonly lpY: LowPass;
  private rateLow2 = 0;
  private rateHigh2 = 0;
  private rateN = 0;
  private leanSum = 0;
  private leanN = 0;
  private lean = NaN;
  private tiltPeak = 0;
  private pz = 0;
  private pz2 = 0;
  private pzN = 0;
  private lastCop: [number, number] | null = null;
  private lastCopT = 0;
  private readonly jumps: number[] = [];
  private dcm2 = 0;
  private dcmN = 0;
  private limitTicks = 0;
  private limitN = 0;
  private satSum = 0;
  private satN = 0;
  private satPeak = 0;
  private reserves: number[] = [];
  private lastTouch = -1;
  private touch0 = -1;
  private closeM = 0;
  private closeS = 0;
  private timeTo13 = Infinity;
  private single = 0;
  private inside = 0;
  private arrivedAt = Infinity;
  private touchAtArrive = 0;
  private readonly falls: FallNote[] = [];
  private readonly recent: Array<{ t: number; skill: string }> = [];
  /** Goal the arrival is measured against (defaults to the controller's own goal). */
  goal: (() => { x: number; y: number } | null) | null = null;

  /**
   * `leanS`: seconds at the start spent measuring the standing lean before anything else is
   * sampled (0: take the lean from the first sample).
   */
  constructor(ctx: SimContext, corner: 0 | 1, private readonly leanS = 0.3) {
    this.r = ctx.robots[corner];
    this.opp = ctx.robots[corner === 0 ? 1 : 0];
    this.c = controllerOf(this.r)!;
    this.torso = this.r.parts.get('torso')!.body;
    this.r.joints.forEach((j, i) => { if (legJoint.test(j.name)) this.legIdx.push({ i, side: j.name.endsWith('_l') ? 'l' : 'r' }); });
    const fs = 1 / (ctx.dt * 2);
    this.lpX = new LowPass(SPLIT_HZ, fs);
    this.lpY = new LowPass(SPLIT_HZ, fs);
  }

  /** Call after every physics step (events are read here too, before the caller clears them). */
  sample(ctx: SimContext): void {
    if (this.t0 < 0) this.t0 = ctx.time;
    const t = ctx.time - this.t0;
    for (const e of ctx.events as SimEvent[]) if (e.kind === 'fall' && e.corner === this.r.corner) this.noteFall(t);
    if (ctx.tick % 2 !== 0) return; // one sample per control tick
    this.tick++;
    const c = this.c;
    const d = ctx.data;
    const xmat = d.xmat as Float64Array;
    const up = xmat[this.torso * 9 + 8];
    const tilt = (Math.acos(Math.max(-1, Math.min(1, up))) * 180) / Math.PI;
    if (t < this.leanS) {
      this.leanSum += tilt;
      this.leanN++;
      return;
    }
    if (Number.isNaN(this.lean)) this.lean = this.leanN ? this.leanSum / this.leanN : tilt;
    this.recent.push({ t, skill: this.r.skill });
    if (this.recent.length > 800) this.recent.splice(0, 200);
    if (this.r.down || c.getUp.active || c.rising) {
      // On the canvas or unfolding out of the get-up crouch: not footwork.
      this.lastCop = null;
      return;
    }
    // Torso pitch/roll rate, split at 3 Hz.
    const cv = d.cvel as Float64Array;
    const wx = cv[this.torso * 6], wy = cv[this.torso * 6 + 1];
    const lx = this.lpX.step(wx), ly = this.lpY.step(wy);
    this.rateLow2 += lx * lx + ly * ly;
    this.rateHigh2 += (wx - lx) ** 2 + (wy - ly) ** 2;
    this.rateN++;
    this.tiltPeak = Math.max(this.tiltPeak, tilt - this.lean);
    const skill = c.skills.active();
    if (!skill && !c.rising) {
      const z = (d.xpos as Float64Array)[this.r.rootBody * 3 + 2];
      this.pz += z;
      this.pz2 += z * z;
      this.pzN++;
    }
    // Planned COP continuity and DCM tracking.
    const p = c.probe;
    if (this.lastCop && t - this.lastCopT < RUBBISH_TICK_S + 0.002) this.jumps.push(Math.hypot(p.cop[0] - this.lastCop[0], p.cop[1] - this.lastCop[1]));
    this.lastCop = [p.cop[0], p.cop[1]];
    this.lastCopT = t;
    const e2 = (p.xi[0] - p.xiRef[0]) ** 2 + (p.xi[1] - p.xiRef[1]) ** 2;
    this.dcm2 += e2;
    this.dcmN++;
    // Planted-leg servos at their torque limit, outside strikes.
    if (!skill) {
      const force = d.actuator_force as Float64Array;
      let limit = false;
      for (const { i, side } of this.legIdx) {
        if (!c.gait.planted(side)) continue;
        const j = this.r.joints[i];
        if (Math.abs(force[j.act]) >= LIMIT_FRAC * j.availableTorque) { limit = true; break; }
      }
      if (limit) this.limitTicks++;
      this.limitN++;
      const sat = c.gyro?.saturation ?? 0;
      this.satSum += sat;
      this.satN++;
    }
    this.satPeak = Math.max(this.satPeak, c.gyro?.saturation ?? 0);
    if (this.touch0 < 0) this.touch0 = p.touchdowns;
    if (this.lastTouch < 0) this.lastTouch = p.touchdowns;
    else if (p.touchdowns !== this.lastTouch) {
      this.reserves.push(p.reserveAtTouchdown);
      this.lastTouch = p.touchdowns;
    }
    // Approach and footwork.
    const com = d.subtree_com as Float64Array, vel = d.subtree_linvel as Float64Array;
    const a = this.r.rootBody * 3, b = this.opp.rootBody * 3;
    const dx = com[b] - com[a], dy = com[b + 1] - com[a + 1];
    const dist = Math.hypot(dx, dy);
    const dt = ctx.dt * 2;
    if (dist > APPROACH_MIN_DIST_M) {
      this.closeM += ((vel[a] * dx + vel[a + 1] * dy) / dist) * dt;
      this.closeS += dt;
    } else if (!Number.isFinite(this.timeTo13)) this.timeTo13 = t - this.leanS;
    if (dist < INSIDE_M) {
      this.inside += dt;
      if (!c.gait.bothPlanted()) this.single += dt;
    }
    if (!Number.isFinite(this.arrivedAt) && c.gait.bothPlanted()) {
      const g = this.goal ? this.goal() : c.goal;
      if (g) {
        const f = c.gait.currentFrame();
        if (Math.hypot(f.x - g.x, f.y - g.y) < ARRIVE_M) {
          this.arrivedAt = t - this.leanS;
          this.touchAtArrive = p.touchdowns;
        }
      }
    }
  }

  private noteFall(t: number): void {
    const since = t - 1.5;
    const doing = [...new Set(this.recent.filter((h) => h.t >= since).map((h) => h.skill))];
    this.falls.push({ t, activity: activityOf(this.recent, t), doing });
  }

  result(): BalanceMetrics {
    const jumps = [...this.jumps].sort((x, y) => x - y);
    const n = Math.max(1, this.pzN);
    const mean = this.pz / n;
    const rates = this.reserves;
    return {
      seconds: this.tick * 0.002,
      falls: this.falls,
      closingSpeed: this.closeS > 0 ? this.closeM / this.closeS : NaN,
      closingSeconds: this.closeS,
      timeTo13: this.timeTo13,
      singleInside2: this.inside > 0 ? this.single / this.inside : 0,
      insideSeconds: this.inside,
      arrivedAt: this.arrivedAt,
      stepsAfterArrive: Number.isFinite(this.arrivedAt) ? this.c.probe.touchdowns - this.touchAtArrive : 0,
      touchdowns: this.c.probe.touchdowns - Math.max(0, this.touch0),
      torsoRateLow: Math.sqrt(this.rateLow2 / Math.max(1, this.rateN)),
      torsoRateHigh: Math.sqrt(this.rateHigh2 / Math.max(1, this.rateN)),
      standingLeanDeg: this.lean,
      tiltPeakDeg: this.tiltPeak,
      pelvisStdCm: 100 * Math.sqrt(Math.max(0, this.pz2 / n - mean * mean)),
      copJumpCm: 100 * (jumps.length ? jumps[jumps.length - 1] : 0),
      copJumpP99Cm: 100 * (jumps.length ? jumps[Math.floor(0.99 * (jumps.length - 1))] : 0),
      dcmErrCm: 100 * Math.sqrt(this.dcm2 / Math.max(1, this.dcmN)),
      servoLimitShare: this.limitN ? this.limitTicks / this.limitN : 0,
      gyroSatFootwork: this.satN ? this.satSum / this.satN : 0,
      gyroSatPeak: this.satPeak,
      reserveAtTouchdown: rates.length ? rates.reduce((s, x) => s + x, 0) / rates.length : 1,
      reserveAtTouchdownMin: rates.length ? Math.min(...rates) : 1,
    };
  }
}

const ARM = new Set(['jab', 'cross', 'hook', 'uppercut', 'overhand', 'rocket_punch']);
const LEG = new Set(['front_kick', 'low_kick', 'head_kick']);

/**
 * What a fighter was doing when it fell: striking or kicking if a strike ran in the last second,
 * rising if it was standing up out of a get-up, stepping if a foot was in the air in the last
 * half second, else standing (guard and clinch count as standing).
 */
export function activityOf(recent: ReadonlyArray<{ t: number; skill: string }>, t: number): string {
  const last = (s: number) => recent.filter((h) => h.t >= t - s).map((h) => h.skill);
  const second = last(1);
  if (second.some((k) => LEG.has(k))) return 'kicking';
  if (second.some((k) => ARM.has(k))) return 'striking';
  if (second.some((k) => k === 'getup_rise' || k.startsWith('getup'))) return 'rising';
  if (second.some((k) => k === 'victory')) return 'victory';
  if (last(0.5).some((k) => k === 'step')) return 'stepping';
  return 'standing';
}
