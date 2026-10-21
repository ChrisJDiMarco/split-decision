// Reactions after hits and falls (docs/design/balance-engine.md §6): the Euphoria-style layer above the
// balance engine. It decides what the body is doing about a disturbance; the engine (feet, gyro) and the
// behaviours (behaviours.ts: arms, waist, posture, stiffness) carry it out. Nothing here adds a force:
// every reaction is a choice of targets, stiffness and timing for the motors and the gyro core.
//
//   detect     proprioceptive. Each control tick the DCM is predicted from the pressure point the soles
//              could have made (the support, plus what the gyro core and the body's own swinging limbs can
//              add): ξₖ = r + (ξₖ₋₁ − r)·e^{ωΔt}. The part of the DCM's change no such r explains is an
//              outside push; more than hitXiM of it within hitWindowS is a hit (20 N·s moves SAVATE's ξ by
//              7 cm). Its size and direction are measured, and the robot's skin (its contacts with the
//              other robot at that moment) says which part took it.
//   absorb     ≤ absorbS: the hit part's chain drops to absorbKp of its stiffness and regains at regainPerS
//              (a back-drivable drive gives under a blow); stance legs and the rest of the guard keep theirs
//   recover    the DCM out of the support (the engine's capture stepping), or a hit that moved it more than
//              recoverXiM: capture steps at the leg's pace (the engine), arms out with the torso's tumble
//              rate, the fall side first, the hips bend when the gyro reserve is low, the gyro damps the
//              trunk's wobble out of its reserve (gyro-policy.ts); steady again once stable for stableS
//   brace      the fall can no longer be caught: the trunk leaning past braceLean beyond what was commanded
//              with the DCM out of the soles (past braceLeanAlone whatever the DCM does), the legs giving
//              way (the COM low and dropping), the DCM beyond two steps' reach and the gyro's on two feet,
//              or braceSteps recovery steps that leave it past one more step's reach. Within a tick: no
//              more steps, hands to where the body will land, arms stiff and legs soft, knees fold, the
//              waist tucks (falling back) or turns onto the hip and shoulder, the gyro spends all it has
//              slowing the rotation. Held at least braceHoldS; left only if the body really comes back
//   pre-brace  the opponent's windup past preWindup within preRangeM: the pelvis preDropM lower, the guard
//              and waist stiffer (preStiff); a held stance's DCM reference is already centred over the feet
//   down, rise the get-up (getup.ts, mocap/getup.ts, rise.ts) owns the body
// Where the measured numbers led away from §6's starting values, the table below says so.
import type { Vec3 } from '../../../core/types';
import { other, type Gait } from '../gait';
import { SIDES, type HumanoidGeometry, type Side } from '../geometry';
import { clamp } from '../math';
import type { Sense } from '../sense';
import { convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from '../support';
import type { BalanceStateMode } from './types';

/** Tunables (exported so tools can sweep them; the worker never changes them). */
export const REACTIONS = {
  enabled: 1,
  // detection
  hitXiM: 0.025, // unexplained DCM change within hitWindowS that is a hit (§6 says 1.5 cm in a tick; summed over the window,
  //              1.5-2 cm also caught the body's own blows and steps: a jab's momentum change is about 1.5 cm of DCM;
  //              a 9 N·s blow moves SAVATE's by 3 cm)
  zddTauS: 0.01, // the COM's vertical acceleration is low-passed this much for the pendulum's ω
  blindXiM: 0.05, // with nothing of his touching the body, a jump this big still counts (a 15 N·s shove on SAVATE)
  hitWindowS: 0.016,
  allowanceM: 0.1, // CMP beyond the soles (and the gyro's reach) the body's own limbs can account for...
  strikeAllowanceM: 0.1, // ...and this much more while it throws a blow or a kick (their own momentum change)
  hitHoldS: 0.04, // a hit keeps adding to its measured size this long after it is detected
  hitCooldownS: 0.12,
  // absorb
  absorbS: 0.15,
  absorbKp: 0.6,
  regainPerS: 4, // §6 says 2/s; at 4 the trunk's wobble after a body shot dies sooner (time to stable over the recoveries, with the
  //               gentler arms out below: 0.79 → 0.71 s; blows survived 156 → 157 of 192)
  // recover
  recoverXiM: 0.03,
  stableS: 0.15,
  recoverDropM: 0, // §6 asks 3 cm; measured, lowering the pelvis mid-catch-step tipped FIRECRACKER over (40 N·s hits survived 19 → 23 of 48 without it)
  armsOutRate: 1.2, // rad/s of torso tumble before the arms go out...
  armsOutGain: 0.3, // ...then this many rad of shoulder abduction per rad/s over it (§6: 0.5; heavy arms flung out that hard
  //                  rock the trunk on the landing)...
  armsOutLean: 0.5, // ...plus this per rad of lean past armsOutLeanFrom
  armsOutLeanFrom: 0.3,
  armsOutMax: 1.1,
  armsOtherShare: 0.5, // the arm on the far side from the fall goes half as far
  armsInS: 0.3, // and they come back in this slowly
  bendReserve: 0, // gyro reserve below which the hips and waist bend into the recovery (§6: 0.3; measured, the bend
  //               tipped FIRECRACKER over in a walking push it survives without it, and changed nothing on the
  //               hit drill (155 → 156 of 192 survived without it): off, the strategy stays for a damaged gyro)
  // brace
  braceLean: 0.6, // rad of lean beyond the commanded one, with the DCM out of the soles...
  braceLeanAlone: 0.8, // ...or this much whatever the DCM does...
  braceLeanStriking: 0.95, // ...or this much while the body throws a blow or a kick
  braceLookS: 0, // ...or heading past it this soon at the lean rate (0: off; a head shot tips the trunk fast and the gyro and soles stop it)
  braceComZ: 0.7, // COM below this × its standing height above the lowest sole and dropping faster than braceSinkMS...
  braceSinkMS: 0.4,
  braceComZLow: 0.55, // ...or below this
  braceSteps: 3, // ...recovery steps without settling, with the DCM still past one more step's reach (+ braceStepsOutM)
  braceStepsOutM: 0,
  braceStepS: 0.75, // a capture step's swing, × 1/ω₀ (the two-step reach)
  braceStepL: 0.7, // its longest step, × leg length
  braceMarginM: 0.15, // on two feet, the DCM this much past two steps' reach (and the gyro's) is a fall
  braceTouchMarginM: 0, // with a step in the air, this much past one more step's reach (0: not judged in the air; measured too pessimistic)
  braceHoldS: 0.3,
  braceGyroRateRadS: 0.6, // bracing, the gyro's full torque goes against any tumble faster than this
  braceExitLean: 0.3, // a brace is let go only with the lean back under this...
  braceExitInM: 0.02, // ...and the DCM this far inside the soles
  // pre-brace
  preWindup: 0.55,
  preRangeM: 1.35,
  preHoldS: 0.2,
  preDropM: 0.02,
  preStiff: 1.3,
};

/** A hit as the body felt it. */
export interface HitRead {
  t: number; // sim time detected
  jump: P2; // DCM change it caused (world, m)
  impulse: number; // N·s, from the jump (m·ω·|Δξ|)
  part: string | null; // the part that took it (skin contact), null if none was touching him
}

/** Where a fall is going: the brace aims the hands and turns the trunk from this. */
export interface FallPlan {
  dir: P2; // unit, world: the way the body is falling
  contact: Vec3; // world: where the hands should meet the canvas
  back: number; // −1 … 1: how much of the fall is backward (1 = straight back)
  side: number; // −1 … 1: + toward the body's left
}

export interface ReactionInput {
  gait: Gait;
  /** The engine's capture stepping is on (a catch step in the air, or the DCM out of the soles on two feet). */
  recovering: boolean;
  /** How far past the soles the gyro can still carry the CMP (m). */
  gyroReach: number;
  /** The opponent's windup (0..1) if he is within striking reach with a strike, else 0. */
  threat: number;
  oppDist: number;
  /** Own skill running (a strike owns the arms: no pre-brace). */
  striking: boolean;
  /** A step in the air: where the DCM will be at its touchdown (the CMP held on the stance sole) and where it lands. */
  touch: { xi: P2; landing: FootPlace; side: Side } | null;
  /**
   * The torso's up axis as last commanded (world): a blow's lean, the hip strategy's bend and the style's
   * tilt are wanted; only the lean beyond them is the body falling.
   */
  torsoUpCmd: readonly number[] | null;
  /** Steps are allowed (not rising out of a get-up). */
  allowSteps: boolean;
  /** Standing up out of the get-up crouch: low and folded on purpose (no 'sinking'). */
  rising?: boolean;
  touchdowns: number;
}

export class Reactions {
  mode: BalanceStateMode = 'steady';
  since = 0;
  /** The last hit read, and the stiffness its part's chain has back (absorbKp → 1). */
  hit: HitRead | null = null;
  absorbScale = 1;
  absorbPart: string | null = null;
  readonly fall: FallPlan = { dir: [1, 0], contact: [0, 0, 0], back: 0, side: 0 };
  preBrace = false;
  /** Shoulder abduction for the arms-out behaviour, rad (left, right arm). */
  readonly armsOut: Record<Side, number> = { l: 0, r: 0 };
  /** Counters for the tools. */
  readonly counts = { hits: 0, absorbs: 0, recovers: 0, braces: 0, braceExits: 0, preBraces: 0 };
  /** Why the last brace started (diagnostics). */
  braceWhy = '';
  /** Who to ask which of this robot's parts touch the other robot now (the controller's skin). */
  touching: (() => string[]) | null = null;

  private readonly xiPrev: P2 = [0, 0];
  private primed = false;
  /** The COM's vertical speed last tick and its vertical acceleration, low-passed (the pendulum's ω moves with it). */
  private vzPrev = 0;
  private zdd = 0;
  private readonly ring: Float64Array;
  private ringI = 0;
  private hitUntil = -1;
  private cooldownUntil = -1;
  private stableSince = -1;
  private recoverTouch0 = 0;
  private preUntil = -1;
  private comZStand: number;
  /**
   * How far outside the stance sole the DCM may be for two steps to still catch it (m): each step of
   * braceStepS/ω₀ lets it grow by e^{braceStepS} and lands at most braceStepL × L (plus the sole) out.
   */
  private twoStep(): number {
    const R = REACTIONS;
    const k = Math.exp(-R.braceStepS);
    const l = R.braceStepL * this.geo.legLength;
    const s = this.geo.legs.l.footHalfLength;
    return l * k + (l + s) * k * k;
  }

  /** ...and for one step. */
  private oneStep(): number {
    const R = REACTIONS;
    return (R.braceStepL * this.geo.legLength + this.geo.legs.l.footHalfLength) * Math.exp(-R.braceStepS);
  }

  constructor(private readonly geo: HumanoidGeometry, comHeight: number, dt = 0.002) {
    this.comZStand = comHeight;
    this.ring = new Float64Array(2 * Math.max(1, Math.round(REACTIONS.hitWindowS / dt)));
  }

  /** The COM's height above the soles standing in the stance (m): what 'sinking' is measured against. */
  setStandingCom(z: number): void {
    this.comZStand = z;
  }

  reset(t: number, mode: BalanceStateMode = 'steady'): void {
    this.mode = mode;
    this.since = t;
    this.primed = false;
    this.ring.fill(0);
    this.hit = null;
    this.absorbScale = 1;
    this.absorbPart = null;
    this.hitUntil = this.cooldownUntil = -1;
    this.stableSince = -1;
    this.preBrace = false;
    this.preUntil = -1;
    this.armsOut.l = this.armsOut.r = 0;
  }

  /** Bracing for a fall it can no longer catch. */
  get bracing(): boolean {
    return this.mode === 'brace';
  }

  /** The get-up owns the body ('down', 'rise'): the reactions only keep the record. */
  setMode(mode: BalanceStateMode, t: number): void {
    if (this.mode === mode) return;
    if (mode === 'brace') this.counts.braces++;
    this.mode = mode;
    this.since = t;
  }

  /**
   * One control tick on the feet. `s`: the sense (whole-body COM). Updates the mode, the hit read, the
   * fall plan and the arms-out amounts.
   */
  update(s: Sense, dt: number, inp: ReactionInput): void {
    const R = REACTIONS;
    const t = s.time;
    if (!R.enabled) {
      this.mode = inp.recovering ? 'recover' : 'steady';
      return;
    }
    this.detect(s, dt, inp);
    // The absorbing chain regains its stiffness.
    if (this.absorbScale < 1) this.absorbScale = Math.min(1, this.absorbScale + R.regainPerS * dt);
    const lean = this.unwantedLean(s, inp.torsoUpCmd);
    const leanRate = this.leanRate(s);
    this.updatePreBrace(t, inp);
    const support = inp.gait.supportPolygon();
    const out = support.length >= 3 ? polygonDistance(support, [s.capture[0], s.capture[1]]).d : this.outsideStance(s, inp.gait);
    // Stable on two feet (Euphoria's 0.3 m/s and 0.3 rad/s), the DCM inside.
    const stable = inp.gait.phase === 'double' && inp.gait.bothPlanted() && Math.hypot(s.comVel[0], s.comVel[1]) < 0.3
      && Math.hypot(s.torsoOmega[0], s.torsoOmega[1]) < 0.3 && out < 0;
    if (!stable) this.stableSince = -1;
    else if (this.stableSince < 0) this.stableSince = t;
    if (this.mode === 'brace') {
      this.planFall(s);
      // Let go of a brace only once it has been held, the body really is back over its feet and upright.
      if (t - this.since >= R.braceHoldS && lean < R.braceExitLean && out < -R.braceExitInM && inp.gait.bothPlanted()) {
        this.counts.braceExits++;
        this.enter('recover', t, inp);
      }
      this.armsOut.l = this.armsOut.r = 0;
      return;
    }
    const why = this.braceTrigger(s, inp, lean, leanRate, out);
    if (why) {
      this.braceWhy = why;
      this.planFall(s);
      this.enter('brace', t, inp);
      this.armsOut.l = this.armsOut.r = 0;
      return;
    }
    const bigHit = !!this.hit && t - this.hit.t < R.absorbS && Math.hypot(this.hit.jump[0], this.hit.jump[1]) > R.recoverXiM;
    if (inp.recovering || bigHit) {
      if (this.mode !== 'recover') this.enter('recover', t, inp);
    } else if (this.mode === 'recover') {
      if (this.stableSince >= 0 && t - this.stableSince >= R.stableS) this.enter('steady', t, inp);
    } else if (this.mode === 'absorb') {
      if (t - this.since >= R.absorbS) this.enter('steady', t, inp);
    } else if (this.hit && this.hit.t === t) this.enter('absorb', t, inp);
    this.updateArmsOut(s, lean, dt);
  }

  private enter(mode: BalanceStateMode, t: number, inp: ReactionInput): void {
    if (mode === this.mode) return;
    if (mode === 'recover') {
      this.counts.recovers++;
      this.recoverTouch0 = inp.touchdowns;
    }
    if (mode === 'absorb') this.counts.absorbs++;
    if (mode === 'brace') this.counts.braces++;
    this.mode = mode;
    this.since = t;
  }

  /** Recovery steps taken since the recovery started. */
  stepsSince(touchdowns: number): number {
    return this.mode === 'recover' ? touchdowns - this.recoverTouch0 : 0;
  }

  // ------------------------------------------------------------------ detection

  private detect(s: Sense, dt: number, inp: ReactionInput): void {
    const R = REACTIONS;
    const xi: P2 = [s.capture[0], s.capture[1]];
    if (!this.primed) {
      this.xiPrev[0] = xi[0];
      this.xiPrev[1] = xi[1];
      this.vzPrev = s.comVel[2];
      this.zdd = 0;
      this.primed = true;
      return;
    }
    // The ground's horizontal push per metre of COM-to-CMP offset is m(g + z̈)/z, not mg/z: a touchdown or a
    // dip moves it by a third (measured: most false hits came with the COM rising or sinking at 0.5-1.5 m/s).
    const a = Math.min(1, dt / R.zddTauS);
    this.zdd += ((s.comVel[2] - this.vzPrev) / dt - this.zdd) * a;
    this.vzPrev = s.comVel[2];
    const w = Math.sqrt(Math.max(0.3, 9.81 + this.zdd) / Math.max(0.3, s.com[2]));
    const E = Math.exp(w * dt);
    // The pressure point that would explain this tick's change of the DCM.
    const rx = (xi[0] - E * this.xiPrev[0]) / (1 - E), ry = (xi[1] - E * this.xiPrev[1]) / (1 - E);
    this.xiPrev[0] = xi[0];
    this.xiPrev[1] = xi[1];
    // What the soles (any foot near the canvas), the gyro and the body's own limbs could have made.
    const soles = this.soles(s, inp.gait);
    let ux = 0, uy = 0;
    if (soles.length >= 3) {
      const { d, closest } = polygonDistance(soles, [rx, ry]);
      const allow = R.allowanceM + inp.gyroReach + (inp.striking ? R.strikeAllowanceM : 0);
      if (d > allow) {
        // The nearest point the body could have pushed from, and the DCM change it leaves unexplained.
        const k = (d - allow) / d;
        ux = (closest[0] - rx) * k * (E - 1);
        uy = (closest[1] - ry) * k * (E - 1);
      }
    }
    const n = this.ring.length / 2;
    this.ring[2 * this.ringI] = ux;
    this.ring[2 * this.ringI + 1] = uy;
    this.ringI = (this.ringI + 1) % n;
    const t = s.time;
    if (this.hit && t <= this.hitUntil) {
      // Still arriving: the hit's measured size grows.
      this.hit.jump[0] += ux;
      this.hit.jump[1] += uy;
      this.hit.impulse = s.mass * s.omega0 * Math.hypot(this.hit.jump[0], this.hit.jump[1]);
      return;
    }
    if (t < this.cooldownUntil) return;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      sx += this.ring[2 * i];
      sy += this.ring[2 * i + 1];
    }
    const jump = Math.hypot(sx, sy);
    if (jump < R.hitXiM) return;
    const touching = this.touching?.() ?? [];
    const part = pickPart(touching);
    // A blow comes through the skin: with nothing of his touching, only a big jump counts (a shove the body
    // felt but did not see coming; in a fight the small no-contact ones were the body's own blows and steps).
    if (!part && jump < R.blindXiM) return;
    this.hit = { t, jump: [sx, sy], impulse: s.mass * s.omega0 * Math.hypot(sx, sy), part };
    this.hitUntil = t + R.hitHoldS;
    this.cooldownUntil = t + R.hitCooldownS;
    this.ring.fill(0);
    this.counts.hits++;
    this.absorbScale = R.absorbKp;
    this.absorbPart = part ?? 'torso';
  }

  /** Every sole within 3 cm of the canvas (a landing foot pushes before the gait knows it is down). */
  private soles(s: Sense, gait: Gait): P2[] {
    const pts: P2[] = [];
    for (const side of SIDES) {
      const f = s.feet[side];
      if (f.height > 0.03 && !gait.planted(side)) continue;
      pts.push(...footCorners(this.geo, side, { x: f.sole[0], y: f.sole[1], yaw: f.yaw }, 0));
    }
    return pts.length >= 3 ? convexHull(pts) : pts;
  }

  /** In single support: how far the DCM is outside the stance sole. */
  private outsideStance(s: Sense, gait: Gait): number {
    const side = gait.stanceSide();
    if (!side) return 0;
    const sole = footCorners(this.geo, side, gait.feet[side].place, 0);
    return polygonDistance(sole, [s.capture[0], s.capture[1]]).d;
  }

  // ------------------------------------------------------------------ brace

  private braceTrigger(s: Sense, inp: ReactionInput, lean: number, leanRate: number, out: number): string {
    const R = REACTIONS;
    // The lean: past braceLean with the DCM out of the soles, or past braceLeanAlone whatever it does (a big head
    // shot tips the trunk past 0.6 rad and the gyro and soles still stand it back up: 5 of 158 hits measured).
    // Mid-step the DCM is outside the stance sole on purpose (the landing catches it): only on two feet does a
    // DCM outside the soles mean the step did not. A blow or a kick leans the trunk on purpose (a head kick's
    // counter-lean reaches 30-45°): then only braceLeanStriking counts.
    const twoFeet = inp.gait.phase === 'double' && inp.gait.bothPlanted();
    if (inp.striking ? lean > R.braceLeanStriking : lean > R.braceLeanAlone || (lean > R.braceLean && twoFeet && out > 0)) return 'lean';
    if (R.braceLookS > 0 && !inp.striking && lean > 0.5 * R.braceLean && lean + Math.max(0, leanRate) * R.braceLookS > R.braceLean) return 'tipping';
    // The legs giving way: the COM low and still dropping, or very low.
    const low = Math.min(s.feet.l.sole[2], s.feet.r.sole[2]);
    const h = s.com[2] - low;
    if (!inp.rising && (h < R.braceComZLow * this.comZStand || (h < R.braceComZ * this.comZStand && s.comVel[2] < -R.braceSinkMS))) return 'sinking';
    // The DCM beyond what the steps (and the gyro's remaining reach) can catch: on two feet, two steps
    // from now; with a step in the air, one more after it lands where it is going.
    if (inp.allowSteps) {
      const tc = inp.touch;
      if (tc && R.braceTouchMarginM > 0) {
        const stance = other(tc.side);
        const hull = convexHull([...footCorners(this.geo, stance, inp.gait.feet[stance].place, 0), ...footCorners(this.geo, tc.side, tc.landing, 0)]);
        const after = hull.length >= 3 ? polygonDistance(hull, tc.xi).d : 0;
        if (after > this.oneStep() + inp.gyroReach + R.braceTouchMarginM) return 'beyond reach';
      } else if (inp.gait.phase === 'double' && out > this.twoStep() + inp.gyroReach + R.braceMarginM) return 'beyond reach';
    } else if (out > inp.gyroReach + R.braceMarginM && lean > 0.5 * R.braceLean) return 'no steps';
    // Steps that are not settling it: still more than one more step can catch.
    if (this.mode === 'recover' && twoFeet && this.stepsSince(inp.touchdowns) >= R.braceSteps && out > this.oneStep() + R.braceStepsOutM) return 'steps';
    return '';
  }

  /** The torso's lean beyond the one commanded (rad): the angle between its up axis and the commanded one. */
  private unwantedLean(s: Sense, cmd: readonly number[] | null): number {
    const T = s.torsoRot;
    if (!cmd) return Math.acos(clamp(T[8], -1, 1));
    return Math.acos(clamp(T[2] * cmd[0] + T[5] * cmd[1] + T[8] * cmd[2], -1, 1));
  }

  /** The torso's tumble rate away from upright (rad/s; + falling further): lean = acos(u_z), u̇ = ω × u. */
  private leanRate(s: Sense): number {
    const T = s.torsoRot;
    const ux = T[2], uy = T[5];
    const h = Math.hypot(ux, uy);
    if (h < 1e-4) return Math.hypot(s.torsoOmega[0], s.torsoOmega[1]);
    const w = s.torsoOmega;
    return (w[1] * ux - w[0] * uy) / h;
  }

  /** The fall's direction and where the hands should land. */
  private planFall(s: Sense): void {
    const T = s.torsoRot;
    let dx = T[2], dy = T[5];
    let n = Math.hypot(dx, dy);
    if (n < 0.05) {
      // Barely tipped: the DCM's way out of the feet says where.
      dx = s.capture[0] - s.com[0];
      dy = s.capture[1] - s.com[1];
      n = Math.hypot(dx, dy);
    }
    if (n < 1e-6) {
      dx = Math.cos(s.heading);
      dy = Math.sin(s.heading);
      n = 1;
    }
    const f = this.fall;
    f.dir[0] = dx / n;
    f.dir[1] = dy / n;
    const reach = 0.8 * this.comZStand;
    f.contact[0] = s.com[0] + f.dir[0] * reach;
    f.contact[1] = s.com[1] + f.dir[1] * reach;
    f.contact[2] = 0;
    const c = Math.cos(s.heading), sn = Math.sin(s.heading);
    f.back = -(f.dir[0] * c + f.dir[1] * sn);
    f.side = -f.dir[0] * sn + f.dir[1] * c;
  }

  // ------------------------------------------------------------------ arms out, pre-brace

  private updateArmsOut(s: Sense, lean: number, dt: number): void {
    const R = REACTIONS;
    const rate = Math.hypot(s.torsoOmega[0], s.torsoOmega[1]);
    const want = this.mode === 'recover' ? clamp(R.armsOutGain * Math.max(0, rate - R.armsOutRate) + R.armsOutLean * Math.max(0, lean - R.armsOutLeanFrom), 0, R.armsOutMax) : 0;
    // The fall side: where the torso's up axis leans (body frame, left +).
    const T = s.torsoRot;
    const c = Math.cos(s.heading), sn = Math.sin(s.heading);
    const lat = -T[2] * sn + T[5] * c;
    const near: Side = lat >= 0 ? 'l' : 'r';
    for (const side of SIDES) {
      const target = want * (side === near ? 1 : R.armsOtherShare);
      // Out at once (the target is already rate-limited by the motors), back in over armsInS.
      this.armsOut[side] = target >= this.armsOut[side] ? target : this.armsOut[side] + (target - this.armsOut[side]) * Math.min(1, dt / R.armsInS);
    }
  }

  private updatePreBrace(t: number, inp: ReactionInput): void {
    const R = REACTIONS;
    if (inp.threat >= R.preWindup && inp.oppDist < R.preRangeM && !inp.striking && this.mode === 'steady') {
      if (!this.preBrace) this.counts.preBraces++;
      this.preBrace = true;
      this.preUntil = t + R.preHoldS;
    } else if (t > this.preUntil) this.preBrace = false;
  }
}

/** Of the parts touching the other robot, the one a blow most likely landed on. */
function pickPart(parts: string[]): string | null {
  if (!parts.length) return null;
  for (const p of ['head', 'torso', 'pelvis']) if (parts.includes(p)) return p;
  return parts.find((p) => !p.startsWith('foot')) ?? parts[0];
}
