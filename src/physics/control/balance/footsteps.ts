// Footstep planning (docs/design/balance-engine.md §4). Every mode writes into one footstep list,
// and the list alone sets the CMP plan and so the DCM reference (dcm.ts):
//   walk   while the opponent is beyond 2.4 m and the goal lies ahead: the feet pass, the CMP rolls
//          heel to toe on each stance sole, the hips square to the way it goes. The approach counts
//          its footsteps back from the goal: the last walking step puts the lead foot in its slot,
//          the rear foot drags into its own, and the final ξ is the stance centroid, so the plan
//          itself shapes the slowdown over the last steps (no stop, reset and rock)
//   drag   near the opponent (and backward, sideways, turning): step-drag. The foot on the side of travel
//          goes first while the other sole's ball pushes, then the other foot drags up to its slot;
//          the feet never pass, the stance travels with the body
//   hold   the goal is reached: no steps, the CMP rests on the stance centroid (plus a strike's
//          weight shift, set every tick by the engine)
// Gaits hold at least 0.3 s. A walk starts only with the opponent beyond 2.4 m and ends outside his
// reach (1.1 m from him); the step-drag covers the rest. Timing is in units of 1/ω₀ (Euphoria's
// time scaling), so every design keeps the same rhythm for its size.
// Footsteps are pooled: planning at every footstep event allocates nothing new.
import { other, type Gait, type StanceFrame } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import { clamp, rot2, wrapAngle } from '../math';
import type { StanceParams } from '../stance';
import type { FootPlace, P2 } from '../support';
import type { DcmPlan } from './dcm';
import type { Footstep, StepSource } from './types';

export type GaitKind = 'hold' | 'walk' | 'drag';

/** Footwork tuning (exported so tools can sweep it; the worker never changes it). */
export const FOOTWORK_TUNING = {
  walkBeyondM: 2.4, // opponent this far: walk
  walkEndM: 0, // a walk toward him stops at least this far from him (0: tactics' goal already stops outside his guard)
  minGaitS: 0.3, // hold any gait at least this long
  walkMinM: 0.7, // walk only to a goal at least this far ahead...
  walkMaxAngle: 0.8, // ...within this of the way the body faces (rad)
  walkSs: 1.7, // single support per walking step, × 1/ω₀ (1.15-1.5 swing a heavy leg too hard: its hip
  //            saturates and the torso pitches with every swing; longer, slower steps walk smoother)
  walkDs: 0.25, // double support between walking steps, × 1/ω₀
  walkSpeedLo: 0.26, // v̂ = v / √(g·z_c) at aggression 0...
  walkSpeedHi: 0.34, // ...and 1 (0.3 at 0.5)
  walkLift: 0.03, // swing apex, × leg length (in the crouch a higher apex folds the knee and swings the hip far)
  // Sole centres either side of the walk line: the soles' inner edges this far apart (a human's
  // ~10 cm step width). The ground force's yaw moment about the COM grows with the lever arm:
  // at 1.05 × the hip offset the planted foot spun 0.25 rad a step on SAVATE and the torso yawed
  // at 1.2 rad/s RMS; at this width 0.09 rad and 0.8 rad/s.
  walkGapM: 0.02,
  walkToeOut: 0.06, // rad
  walkMaxStep: 0.5, // × leg length between consecutive footholds along the walk
  walkFirst: 1, // from rest the first step is this share of a full one (the second halfway)
  stopMarginM: 0.03, // a walk's final stance centre lies at least this far past the body's DCM
  walkLast: 0.5, // the last walking step before the stance is this share of a full one (the one before halfway)
  arrivalKeepM: 0.25, // a goal within this of the frame a walk is arriving at leaves the arrival as it is
  slotTolM: 0.04, // a foot this close to its slot is in it
  arriveSnapM: 0.2, // a lead foot landed this close to its slot is the stance (the rear foot joins it)
  dragSwing: 0.75, // × 1/ω₀
  dragDs: 0.35, // × 1/ω₀ between the two steps of a pair and between pairs
  dragDsAttack: 0.2, // ...at full aggression
  dragStride: 0.3, // stance frame advance per pair, × leg length (0.3-0.45 with aggression)
  dragStrideAttack: 0.38,
  dragLift: 0.035, // × leg length
  maxTurnPerPair: 0.35, // rad
  launch: 0.6, // double support before the first step from standing, × 1/ω₀
  finalDs: 0.7, // the CMP slides onto the stance centroid over this, × 1/ω₀
  cmpHeel: -0.25, // walking CMP roll on the stance sole, × half-length from its centre...
  cmpToe: 0.3, // ...to here
  cmpPush: 0.25, // step-drag: the pushing sole's CMP toward the travel, × half-length
  holdTol: { pos: 0.1, yaw: 0.3 }, // a held stance moves only past these...
  anchorHold: 1, // re-forming a held stance steps one foot back into its slot around the weight-bearing one (0: a pair around their midpoint)
  moveTol: { pos: 0.05, yaw: 0.15 }, // ...and a moving one stops inside these
  horizon: 8, // footsteps planned ahead
  swingTorqueShare: 0.55, // a swing may ask the hip for this share of its stall torque at peak (the leg-as-rod model underestimates: FIRECRACKER, whose hips bind first, fell at 0.8)
  swingSpeedShare: 0.6, // ...and this share of its no-load speed
  maxSepL: 0.62, // swing sole within this × L of the stance sole
  minGapL: 0.08, // feet never cross: lateral gap, × L
  hipYawMargin: 0.12,
};

export interface PlanInput {
  time: number;
  omega: number;
  /** Goal stance frame (null: hold where the feet are, facing `bearing`). */
  goal: StanceFrame | null;
  bearing: number;
  oppDist: number;
  aggression: number;
  /** Requested ground speed (Intent.move), m/s; null: the gait's own. */
  speed: number | null;
  /** The CMP reference right now: the plan's first knot (continuity). */
  cmpNow: P2;
  /** World COM offset in stance (a strike's weight transfer). */
  shift: P2;
  /** In-progress swing (it keeps its landing), or null in double support. */
  swing: { side: Side; target: FootPlace; land: number } | null;
  /** Double support has lasted this long (the next lift may come sooner). */
  doubleS: number;
  /** The opponent's COM (world, horizontal), or null with none. */
  opp: P2 | null;
  /** The stance feet were holding still before this plan (a start needs a launch). */
  fromRest: boolean;
  /** The foot that landed last (a walk alternates: the other one swings next). */
  lastSide: Side | null;
  /** The body's DCM now (a walk under way cannot stop short of it). */
  xi: P2;
  /** Ring IQ: a walk toward the opponent ends at least this far from him (m; FOOTWORK_TUNING.walkEndM otherwise). */
  walkEnd?: number;
}

/** What the swing leg's drive can do (from the motor model and the leg's mass). */
export interface LegDrive {
  stallNm: number; // hip pitch stall torque, N·m
  noLoadRadS: number; // hip pitch no-load speed
  inertia: number; // one leg about its hip, kg·m² (thigh, shin, foot, straight)
}

/**
 * The shortest swing (s) the hip can fly a sole `travel` metres in, using `share` of its stall
 * torque and no-load speed: a minimum-jerk path over 80% of the swing peaks at 5.77·D/τ² and
 * 1.875·D/τ (the leg as a rod about the hip, its sole ~0.9 L out).
 */
export function minSwingTime(drive: LegDrive, travel: number, legLength: number, share: number): number {
  const r = 0.9 * legLength;
  const byTorque = Math.sqrt((5.77 * drive.inertia * travel) / Math.max(1e-6, share * drive.stallNm * r));
  const bySpeed = (1.875 * travel) / Math.max(1e-6, share * drive.noLoadRadS * r);
  return Math.max(byTorque, bySpeed) / 0.8;
}

function newStep(): Footstep {
  return { side: 'l', place: { x: 0, y: 0, yaw: 0 }, lift: 0, land: 0, cmp: [[0, 0], [0, 0]], clearance: 0, source: 'walk' };
}

export class FootstepPlanner {
  gait: GaitKind = 'hold';
  gaitSince = -Infinity;
  readonly steps: Footstep[] = Array.from({ length: 24 }, newStep);
  count = 0;
  /** Index of the next footstep that has not lifted yet. */
  next = 0;
  /** Where the plan leaves the CMP, and when. */
  readonly final: P2 = [0, 0];
  finalTime = 0;
  /** The goal the last plan was made for (replanning is skipped while it barely moves). */
  readonly planned: StanceFrame = { x: 0, y: 0, heading: 0 };
  /** The stance frame the planned steps leave the feet in. */
  endFrame: StanceFrame = { x: 0, y: 0, heading: 0 };
  /** The walk's travel direction (the hips square to it). */
  travel = 0;
  /** The stance frame a walk's arrival pair is taking the feet to, latched once it is planned (the
   *  goal moves a little every tick with the opponent: the last two steps must not chase it). */
  private arrival: StanceFrame | null = null;

  private readonly lead: Side;
  private readonly rear: Side;
  /** The lead and rear feet's slots in the stance frame. */
  private readonly stanceSlots: { x: number; y: number; rx: number; ry: number; ryaw: number };

  /** The swing leg's drive (set by the engine; the default never limits). */
  drive: LegDrive = { stallNm: Infinity, noLoadRadS: Infinity, inertia: 1 };

  constructor(private readonly geo: HumanoidGeometry, stance: StanceParams, private readonly feet: Gait) {
    this.lead = stance.lead;
    this.rear = other(stance.lead);
    const rs = stance.slots[this.rear];
    this.stanceSlots = { x: stance.slots[stance.lead].x, y: stance.slots[stance.lead].y, rx: rs.x, ry: rs.y, ryaw: rs.yaw };
  }

  /** The next footstep to lift, or null. */
  upcoming(): Footstep | null {
    return this.next < this.count ? this.steps[this.next] : null;
  }

  /** Walking the last two steps into the stance (the hips turn back to the blade). */
  arriving(): boolean {
    return this.gait === 'walk' && this.count - this.next <= 2;
  }

  reset(time: number): void {
    this.gait = 'hold';
    this.gaitSince = time;
    this.count = 0;
    this.next = 0;
  }

  /**
   * Plans the footsteps from the current feet (and the in-progress swing's landing) toward the
   * goal, and fills `dcm` with the CMP knots. Returns the gait chosen.
   */
  plan(pin: PlanInput, dcm: DcmPlan): GaitKind {
    const T = FOOTWORK_TUNING;
    const w = pin.omega;
    // The configuration the next step starts from.
    const sw = pin.swing;
    const stanceSide: Side | null = sw ? other(sw.side) : null;
    const place: Record<Side, FootPlace> = {
      l: sw?.side === 'l' ? sw.target : this.feet.feet.l.place,
      r: sw?.side === 'r' ? sw.target : this.feet.feet.r.place,
    };
    const baseT = sw ? sw.land : pin.time;
    const cur = frameOf(this.feet, place);
    const goal = pin.goal ?? this.holdFrame(pin, cur, place);
    this.planned.x = goal.x;
    this.planned.y = goal.y;
    this.planned.heading = goal.heading;
    const walkTo = this.walkTarget(pin, cur, goal);
    const gait = this.chooseGait(pin, cur, goal, walkTo, place);
    if (gait !== 'walk' || pin.fromRest) this.arrival = null;
    if (gait !== this.gait) {
      this.gait = gait;
      this.gaitSince = pin.time;
    }
    this.count = 0;
    this.next = 0;
    dcm.clear();
    dcm.add(pin.time, pin.cmpNow[0], pin.cmpNow[1]);
    // The in-progress swing: its stance sole holds the CMP until it lands.
    if (sw && stanceSide) {
      const st = this.feet.feet[stanceSide].place;
      const [cx, cy] = soleCmp(this.geo, stanceSide, st, 0.1);
      dcm.add(Math.max(pin.time + 0.02, sw.land), cx, cy);
    }
    // First lift: after a launch from rest, else after the double support still owed.
    const ds = gait === 'walk' ? T.walkDs / w : this.dragDs(pin) / w;
    const firstDs = sw ? ds : pin.fromRest ? T.launch / w : Math.max(0.03, ds - pin.doubleS);
    let ok = false;
    if (gait === 'walk') ok = this.planWalk(pin, place, sw ? sw.side : null, baseT + firstDs, walkTo);
    if (!ok && gait !== 'hold') {
      if (gait === 'walk') {
        this.gait = 'drag';
        this.gaitSince = pin.time;
      }
      ok = this.planDrag(pin, place, sw ? sw.side : null, baseT + firstDs, cur, goal);
    }
    // Knots for the planned steps, then the final settle onto the stance centroid.
    let lastPlace: Record<Side, FootPlace> = place;
    for (let i = 0; i < this.count; i++) {
      const s = this.steps[i];
      dcm.add(s.lift, s.cmp[0][0], s.cmp[0][1]);
      dcm.add(s.land, s.cmp[1][0], s.cmp[1][1]);
      lastPlace = { ...lastPlace, [s.side]: s.place };
    }
    this.endFrame = frameOf(this.feet, lastPlace);
    const lp = lastPlace.l, rp = lastPlace.r;
    this.final[0] = (lp.x + rp.x) / 2 + pin.shift[0];
    this.final[1] = (lp.y + rp.y) / 2 + pin.shift[1];
    const endT = this.count ? this.steps[this.count - 1].land : baseT;
    this.finalTime = endT + T.finalDs / w;
    dcm.add(this.finalTime, this.final[0], this.final[1]);
    dcm.solve(w);
    if (!this.count && !sw) {
      this.gait = 'hold';
    }
    return this.gait;
  }

  /**
   * Holding position (no goal), facing `bearing`: the stance frame the feet already describe. Once they
   * are out of their slots (a capture step, a shove, a hit), the frame is anchored on the foot nearer the
   * DCM (the one carrying the weight, usually the one that just caught the body), keeping its own yaw
   * within FOOTWORK_TUNING.holdTol.yaw of the bearing: only the other foot steps back into its slot, one
   * step, instead of a step-drag pair (or two) re-forming the stance around the feet's midpoint.
   */
  private holdFrame(pin: PlanInput, cur: StanceFrame, place: Record<Side, FootPlace>): StanceFrame {
    const want: StanceFrame = { x: cur.x, y: cur.y, heading: pin.bearing };
    if (!FOOTWORK_TUNING.anchorHold) return want;
    let err = 0;
    for (const side of ['l', 'r'] as const) {
      const sl = this.feet.slot(side, want);
      err = Math.max(err, Math.hypot(sl.x - place[side].x, sl.y - place[side].y));
    }
    if (err <= FOOTWORK_TUNING.holdTol.pos) return want;
    const dl = Math.hypot(place.l.x - pin.xi[0], place.l.y - pin.xi[1]);
    const dr = Math.hypot(place.r.x - pin.xi[0], place.r.y - pin.xi[1]);
    const anchor: Side = dl <= dr ? 'l' : 'r';
    const p = place[anchor];
    const zero = this.feet.slot(anchor, { x: 0, y: 0, heading: pin.bearing });
    const tol = FOOTWORK_TUNING.holdTol.yaw;
    const heading = pin.bearing + clamp(wrapAngle(p.yaw - zero.yaw), -tol, tol);
    const o = this.feet.slot(anchor, { x: 0, y: 0, heading });
    return { x: p.x - o.x, y: p.y - o.y, heading };
  }

  private dragDs(pin: PlanInput): number {
    const T = FOOTWORK_TUNING;
    return T.dragDs + (T.dragDsAttack - T.dragDs) * clamp((pin.aggression - 0.5) / 0.5, 0, 1);
  }

  /**
   * Where a walk toward `goal` ends: the goal itself, or, when the goal is inside walkEndM of the
   * opponent, the point that far out along the way in. Fighters walk to just outside reach and
   * step-drag the rest: two walks meeting at full speed clash guards and knock each other over.
   */
  private walkTarget(pin: PlanInput, cur: StanceFrame, goal: StanceFrame): StanceFrame {
    const o = pin.opp;
    if (!o) return goal;
    const gap = Math.hypot(goal.x - o[0], goal.y - o[1]);
    const back = Math.max(FOOTWORK_TUNING.walkEndM, pin.walkEnd ?? 0) - gap;
    const dx = goal.x - cur.x, dy = goal.y - cur.y;
    const d = Math.hypot(dx, dy);
    if (back <= 0 || d < 1e-6) return goal;
    const k = Math.min(back, d) / d;
    return { x: goal.x - dx * k, y: goal.y - dy * k, heading: goal.heading };
  }

  private chooseGait(pin: PlanInput, cur: StanceFrame, goal: StanceFrame, walkTo: StanceFrame, place: Record<Side, FootPlace>): GaitKind {
    const T = FOOTWORK_TUNING;
    // Steps of the last plan still to come (a walk under way, a drag pair half done). Once they are
    // all down the body has arrived, and it holds unless the goal is beyond the hold tolerance.
    const underway = this.count > this.next || !!pin.swing;
    const moving = this.gait !== 'hold' && underway;
    const tol = moving ? T.moveTol : T.holdTol;
    const dPos = Math.hypot(goal.x - cur.x, goal.y - cur.y);
    const dYaw = Math.abs(wrapAngle(goal.heading - cur.heading));
    // Arrived: each foot in its own slot (a frame averaged from crossed feet can look arrived).
    let slotErr = 0;
    for (const side of ['l', 'r'] as const) {
      const sl = this.feet.slot(side, goal);
      slotErr = Math.max(slotErr, Math.hypot(sl.x - place[side].x, sl.y - place[side].y) - 0.5 * tol.pos);
    }
    if (dPos <= tol.pos && dYaw <= tol.yaw && slotErr <= tol.pos && !pin.swing) return 'hold';
    const young = pin.time - this.gaitSince < T.minGaitS;
    // Walk only toward a goal well ahead of the way the body faces, starting far from the
    // opponent. A walk under way runs on to its arrival (its last two steps put the feet in their
    // stance slots and its final DCM on the stance centroid: the plan itself brakes the body);
    // switching to step-drag halfway in would leave the walking momentum with nowhere to go.
    const wPos = Math.hypot(walkTo.x - cur.x, walkTo.y - cur.y);
    const dir = Math.atan2(walkTo.y - cur.y, walkTo.x - cur.x);
    const inLine = Math.abs(wrapAngle(dir - cur.heading)) <= T.walkMaxAngle;
    // A walk under way finishes with its arrival pair (the lead foot, then the rear, into the slots),
    // also when the goal has come back on it (an opponent walking in): planWalk puts that stance no
    // shorter than the body's momentum carries it.
    const walking = this.gait === 'walk' && underway && (wPos > T.moveTol.pos || !!pin.swing);
    const start = inLine && wPos >= T.walkMinM && pin.oppDist > T.walkBeyondM;
    const want: GaitKind = walking || start ? 'walk' : 'drag';
    if (young && moving && want !== this.gait) return this.gait;
    return want;
  }

  // ---------------------------------------------------------------- walking

  /**
   * Walking footholds from the current feet to the goal's slots: evenly spaced along the line
   * from the feet's midpoint to the goal, alternating either side of it, the count chosen so the
   * lead foot takes the last walking step into its slot and the rear foot then drags into its own.
   */
  private planWalk(pin: PlanInput, place: Record<Side, FootPlace>, swinging: Side | null, firstLift: number, walkGoal: StanceFrame): boolean {
    let goal = walkGoal;
    const T = FOOTWORK_TUNING;
    const g = this.geo, L = g.legLength, w = pin.omega;
    const ox = (place.l.x + place.r.x) / 2, oy = (place.l.y + place.r.y) / 2;
    const kept = this.arrival;
    goal = kept && Math.hypot(goal.x - kept.x, goal.y - kept.y) < T.arrivalKeepM ? kept : this.stopNoShorter(pin, goal, ox, oy);
    const slotLead = this.feet.slot(this.lead, goal), slotRear = this.feet.slot(this.rear, goal);
    // The lead foot has landed at (or near) its slot and the rear foot swings next: the walk finishes
    // with the rear foot's drag into the stance beside the lead foot, wherever the lead landed (a
    // lead landing a little long or short is the stance: re-aiming it would cost two more steps).
    const nextSwing = pin.lastSide && !pin.fromRest ? other(pin.lastSide) : null;
    // (Also with the lead foot's swing into its slot still in the air: the rear foot follows it.)
    const leadArriving = swinging ? swinging === this.lead : nextSwing === this.rear;
    if (leadArriving && Math.hypot(place[this.lead].x - slotLead.x, place[this.lead].y - slotLead.y) < T.arriveSnapM) {
      const lp = place[this.lead];
      const [sx, sy] = rot2(this.stanceSlots.rx - this.stanceSlots.x, this.stanceSlots.ry - this.stanceSlots.y, goal.heading);
      const rearSlot: FootPlace = { x: lp.x + sx, y: lp.y + sy, yaw: goal.heading + this.stanceSlots.ryaw };
      const [ox2, oy2] = rot2(this.stanceSlots.x, this.stanceSlots.y, goal.heading);
      this.arrival = { x: lp.x - ox2, y: lp.y - oy2, heading: goal.heading };
      if (Math.hypot(place[this.rear].x - rearSlot.x, place[this.rear].y - rearSlot.y) < T.slotTolM) return false;
      const s = this.push();
      s.side = this.rear;
      s.place = constrainFrom(this.geo, place[this.lead], this.rear, rearSlot, T.maxSepL * L);
      s.lift = firstLift;
      s.land = firstLift + T.dragSwing / w;
      s.clearance = T.dragLift * L;
      s.source = 'arrive';
      const [hx, hy] = soleCmp(this.geo, this.lead, lp, -0.15);
      s.cmp[0][0] = s.cmp[1][0] = hx;
      s.cmp[0][1] = s.cmp[1][1] = hy;
      return true;
    }
    const dx = slotLead.x - ox, dy = slotLead.y - oy;
    const h = Math.hypot(dx, dy) > 0.05 ? Math.atan2(dy, dx) : goal.heading;
    this.travel = h;
    const ux = Math.cos(h), uy = Math.sin(h), nx = -uy, ny = ux;
    const along = (p: FootPlace) => (p.x - ox) * ux + (p.y - oy) * uy;
    // The foot that swings next, and the one it swings past.
    let first: Side;
    if (swinging) first = other(swinging);
    else if (pin.lastSide && !pin.fromRest) first = other(pin.lastSide);
    else first = along(place.l) <= along(place.r) ? 'l' : 'r';
    const stanceFirst = other(first);
    const aS = along(place[stanceFirst]);
    // Past (or at) the lead slot already: the arrival pair alone, no walking steps before it.
    const D = Math.max(0, along(slotLead) - aS);
    const vhat = T.walkSpeedLo + (T.walkSpeedHi - T.walkSpeedLo) * clamp(pin.aggression, 0, 1);
    const zc = 9.81 / (w * w);
    const v = pin.speed ?? vhat * Math.sqrt(9.81 * zc) * (g.legLength < 0.65 ? 0.93 : 1);
    const Tss = T.walkSs / w, Tds = T.walkDs / w;
    // The hip can only swing the leg so far in the time it has: a walking swing travels about two
    // step lengths along a minimum-jerk path over 80% of single support (peak foot acceleration
    // 5.77·D/τ², peak speed 1.875·D/τ). Shorten the steps rather than rush them.
    const tau = 0.8 * Tss;
    const reach = 0.9 * L;
    const dTorque = (T.swingTorqueShare * this.drive.stallNm * tau * tau * reach) / (5.77 * this.drive.inertia);
    const dSpeed = (T.swingSpeedShare * this.drive.noLoadRadS * reach * tau) / 1.875;
    const ell = clamp(Math.min(v * (Tss + Tds), 0.5 * Math.min(dTorque, dSpeed)), 0.08 * L, T.walkMaxStep * L);
    // From rest the first steps are shorter (the body gets up to speed), and the last two walking
    // steps before the stance shorten too (the body slows over them: an even pace into the arrival
    // pair asks the last two steps to stop the whole walk, and the body runs on past its slots).
    const start = (k: number): number => (!pin.fromRest ? 1 : k === 1 ? T.walkFirst : k === 2 ? 0.5 * (1 + T.walkFirst) : 1);
    const end = (j: number): number => (j === 1 ? T.walkLast : j === 2 ? 0.5 * (1 + T.walkLast) : 1);
    let nRamp = 2;
    const ramp = (k: number): number => start(k) * (nRamp >= 3 ? end(nRamp - k) : 1);
    const totalOf = (n: number): number => {
      nRamp = n;
      let a = 0;
      for (let k = 1; k <= n - 1; k++) a += ramp(k);
      return a;
    };
    // N steps: s_1 = first, alternating; s_{N−1} = lead, s_N = rear. N is the count whose full
    // step comes nearest ℓ (by ratio) without passing the longest allowed step: a goal a little
    // past one step is reached with one longer step, not three stutters that cannot catch the DCM.
    const sideOf = (k: number): Side => (k % 2 === 1 ? first : other(first));
    const lengthOf = (n: number): number => (n === 2 ? D : D / totalOf(n));
    const cost = (len: number): number => (len >= ell ? len / ell : ell / Math.max(1e-3, len));
    const maxStep = T.walkMaxStep * L;
    let N = 2;
    while (sideOf(N - 1) !== this.lead || sideOf(N) !== this.rear || lengthOf(N) > maxStep) N++;
    while (N < 400 && cost(lengthOf(N + 2)) < cost(lengthOf(N))) N += 2;
    const total = totalOf(N); // (also leaves nRamp = N for cum)
    this.arrival = N <= 2 ? goal : null;
    const cum = (k: number): number => {
      let a = 0;
      for (let j = 1; j <= k; j++) a += ramp(j);
      return a / total;
    };
    const width = g.legs.l.footHalfWidth + T.walkGapM / 2;
    const count = Math.min(N, T.horizon);
    let t = firstLift;
    const prev: Record<Side, FootPlace> = { l: place.l, r: place.r };
    for (let k = 1; k <= count; k++) {
      const side = sideOf(k);
      const st = other(side);
      let target: FootPlace;
      let source: StepSource = 'walk';
      let swingT = Tss;
      let lift = T.walkLift * L;
      if (k === N - 1) {
        target = slotLead;
        source = 'arrive';
      } else if (k === N) {
        target = slotRear;
        source = 'arrive';
        swingT = T.dragSwing / w;
        lift = T.dragLift * L;
      } else {
        const a = aS + D * cum(k);
        const sg = side === 'l' ? 1 : -1;
        const yaw = h + sg * T.walkToeOut;
        target = { x: ox + ux * a + nx * sg * width, y: oy + uy * a + ny * sg * width, yaw };
      }
      target = constrainFrom(this.geo, prev[st], side, target, T.maxSepL * L);
      const s = this.push();
      s.side = side;
      s.place = target;
      s.lift = t;
      s.land = t + swingT;
      s.clearance = lift;
      s.source = source;
      // The stance sole rolls heel to toe; the rear foot's drag into its slot rests on the lead heel.
      const sp = prev[st];
      if (k === N) {
        const [hx, hy] = soleCmp(this.geo, st, sp, -0.15);
        s.cmp[0][0] = s.cmp[1][0] = hx;
        s.cmp[0][1] = s.cmp[1][1] = hy;
      } else {
        const [hx, hy] = soleCmp(this.geo, st, sp, T.cmpHeel);
        const [tx, ty] = soleCmp(this.geo, st, sp, T.cmpToe);
        s.cmp[0][0] = hx;
        s.cmp[0][1] = hy;
        s.cmp[1][0] = tx;
        s.cmp[1][1] = ty;
      }
      prev[side] = target;
      t = s.land + (k === N - 1 ? this.dragDs(pin) / w : Tds);
    }
    return true;
  }

  /**
   * A walk under way stops with its arrival pair, and the final DCM rests on the final stance's
   * centre: that centre cannot lie short of where the body's DCM already is (plus a margin), or the
   * arrival plan would ask the body to fall backward. A goal that has come back on the walk (an
   * opponent walking in) is moved out along the travel to there; the stance is squared up from that
   * frame once the body has stopped.
   */
  private stopNoShorter(pin: PlanInput, goal: StanceFrame, ox: number, oy: number): StanceFrame {
    if (pin.fromRest || this.gait !== 'walk') return goal;
    const ux = Math.cos(this.travel), uy = Math.sin(this.travel);
    const aGoal = (goal.x - ox) * ux + (goal.y - oy) * uy;
    const aStop = (pin.xi[0] - ox) * ux + (pin.xi[1] - oy) * uy + FOOTWORK_TUNING.stopMarginM;
    if (aGoal >= aStop) return goal;
    return { x: goal.x + (aStop - aGoal) * ux, y: goal.y + (aStop - aGoal) * uy, heading: goal.heading };
  }

  // ---------------------------------------------------------------- step-drag

  /**
   * Step-drag toward the goal frame: stance frames a stride apart, each reached by two steps (the
   * foot on the side of travel first while the other sole pushes, then the other foot drags up).
   */
  private planDrag(pin: PlanInput, place: Record<Side, FootPlace>, swinging: Side | null, firstLift: number, cur: StanceFrame, goal: StanceFrame): boolean {
    const T = FOOTWORK_TUNING;
    const g = this.geo, L = g.legLength, w = pin.omega;
    const aggr = clamp((pin.aggression - 0.5) / 0.5, 0, 1);
    let stride = (T.dragStride + (T.dragStrideAttack - T.dragStride) * aggr) * L;
    if (pin.speed !== null) stride = clamp(pin.speed * (2 * T.dragSwing + 2 * this.dragDs(pin)) / w, 0.05 * L, stride);
    const dx = goal.x - cur.x, dy = goal.y - cur.y;
    const dist = Math.hypot(dx, dy);
    const dyaw = wrapAngle(goal.heading - cur.heading);
    // (Re-forming a held stance (no goal) is one pair at most: holdFrame anchored it on a foot already in its slot.)
    const pairs = !pin.goal && T.anchorHold ? 1 : Math.max(1, Math.ceil(dist / stride - 1e-6), Math.ceil(Math.abs(dyaw) / T.maxTurnPerPair - 1e-6));
    const ux = dist > 1e-6 ? dx / dist : Math.cos(cur.heading), uy = dist > 1e-6 ? dy / dist : Math.sin(cur.heading);
    this.travel = Math.atan2(uy, ux);
    const Tsw = T.dragSwing / w, Tds = this.dragDs(pin) / w;
    const prev: Record<Side, FootPlace> = { l: place.l, r: place.r };
    let t = firstLift;
    let lastSide: Side | null = swinging;
    for (let k = 1; k <= pairs && this.count < T.horizon; k++) {
      const f: StanceFrame = { x: cur.x + (dx * k) / pairs, y: cur.y + (dy * k) / pairs, heading: cur.heading + (dyaw * k) / pairs };
      const slot = { l: this.feet.slot('l', f), r: this.feet.slot('r', f) };
      const ahead = (s: Side) => prev[s].x * ux + prev[s].y * uy;
      const move = (s: Side) => Math.hypot(slot[s].x - prev[s].x, slot[s].y - prev[s].y) + 0.15 * Math.abs(wrapAngle(slot[s].yaw - prev[s].yaw));
      // The foot on the side of travel first (the lead foot to advance, the rear foot to retreat,
      // the near foot to side-step); for a turn in place, the one with further to go.
      // (By the progress each foot makes along the travel first: after a capture step has left the
      // feet swapped, the foot that must come through goes first, not the one that would back up.)
      const progress = (s: Side) => (slot[s].x - prev[s].x) * ux + (slot[s].y - prev[s].y) * uy + 0.1 * ahead(s);
      let firstSide: Side = dist > 0.02 ? (progress('l') >= progress('r') ? 'l' : 'r') : move('l') >= move('r') ? 'l' : 'r';
      if (firstSide === lastSide && this.count === 0 && move(other(firstSide)) > 0.01) firstSide = other(firstSide);
      for (const side of [firstSide, other(firstSide)] as const) {
        if (move(side) < 0.012 && this.count > 0) continue;
        const st = other(side);
        const target = constrainFrom(this.geo, prev[st], side, slot[side], T.maxSepL * L);
        const s = this.push();
        s.side = side;
        s.place = target;
        s.lift = t;
        s.land = t + Tsw;
        s.clearance = T.dragLift * L;
        s.source = Math.abs(dyaw) > 0.1 && dist < 0.05 ? 'pivot' : 'shuffle';
        // The pushing sole's CMP sits toward the travel (the rear ball pushes an advance, the lead
        // heel a retreat); the sole just landed takes the weight nearer its centre.
        const push = side === firstSide ? T.cmpPush : 0.4 * T.cmpPush;
        const [cx, cy] = pushCmp(this.geo, st, prev[st], ux, uy, push);
        s.cmp[0][0] = s.cmp[1][0] = cx;
        s.cmp[0][1] = s.cmp[1][1] = cy;
        prev[side] = target;
        lastSide = side;
        t = s.land + Tds;
      }
    }
    return this.count > 0;
  }

  private push(): Footstep {
    if (this.count >= this.steps.length) this.steps.push(newStep());
    const s = this.steps[this.count++];
    s.clipIdx = undefined;
    return s;
  }

  /** The walk's arrival latch, for a caller that tries plans it may throw away (mocap picks). */
  saveArrival(): StanceFrame | null {
    return this.arrival;
  }

  restoreArrival(a: StanceFrame | null): void {
    this.arrival = a;
  }

  /**
   * Like plan(), with the footsteps `clip[from..to)` of a mocap pick (already placed and timed,
   * balance/mocap-steps.ts) taken first, after any swing in the air; the plan then carries on from
   * where they leave the feet toward the goal with the gait plan() chose (walk or step-drag), so
   * the DCM reference runs to the goal and never brakes at the end of a clip.
   */
  planClip(pin: PlanInput, dcm: DcmPlan, clip: readonly Footstep[], from: number, to: number): void {
    const T = FOOTWORK_TUNING;
    const w = pin.omega;
    const sw = pin.swing;
    const stanceSide: Side | null = sw ? other(sw.side) : null;
    const place: Record<Side, FootPlace> = {
      l: sw?.side === 'l' ? sw.target : this.feet.feet.l.place,
      r: sw?.side === 'r' ? sw.target : this.feet.feet.r.place,
    };
    const cur = frameOf(this.feet, place);
    const goal = pin.goal ?? { x: cur.x, y: cur.y, heading: pin.bearing };
    this.planned.x = goal.x;
    this.planned.y = goal.y;
    this.planned.heading = goal.heading;
    const gait: GaitKind = this.gait === 'hold' ? 'drag' : this.gait;
    this.count = 0;
    this.next = 0;
    dcm.clear();
    dcm.add(pin.time, pin.cmpNow[0], pin.cmpNow[1]);
    if (sw && stanceSide) {
      const st = this.feet.feet[stanceSide].place;
      const [cx, cy] = soleCmp(this.geo, stanceSide, st, 0.1);
      dcm.add(Math.max(pin.time + 0.02, sw.land), cx, cy);
    }
    let lastSide: Side | null = sw ? sw.side : pin.lastSide;
    let tEnd = sw ? sw.land : pin.time;
    for (let i = from; i < to; i++) {
      const c = clip[i];
      const s = this.push();
      s.side = c.side;
      s.place = c.place;
      s.lift = c.lift;
      s.land = c.land;
      s.cmp[0][0] = c.cmp[0][0];
      s.cmp[0][1] = c.cmp[0][1];
      s.cmp[1][0] = c.cmp[1][0];
      s.cmp[1][1] = c.cmp[1][1];
      s.clearance = c.clearance;
      s.source = 'clip';
      s.clipIdx = i;
      place[c.side] = c.place;
      lastSide = c.side;
      tEnd = c.land;
    }
    // Carry on toward the goal from where the clip leaves the feet.
    const end = frameOf(this.feet, place);
    const pin2: PlanInput = { ...pin, time: tEnd, swing: null, fromRest: false, lastSide, doubleS: 0 };
    const firstLift = tEnd + (gait === 'walk' ? T.walkDs / w : this.dragDs(pin) / w);
    const dPos = Math.hypot(goal.x - end.x, goal.y - end.y), dYaw = Math.abs(wrapAngle(goal.heading - end.heading));
    if (dPos > T.moveTol.pos || dYaw > T.moveTol.yaw) {
      let ok = false;
      if (gait === 'walk') ok = this.planWalk(pin2, place, null, firstLift, this.walkTarget(pin2, end, goal));
      if (!ok) this.planDrag(pin2, place, null, firstLift, end, goal);
    }
    let lastPlace: Record<Side, FootPlace> = { l: sw?.side === 'l' ? sw.target : this.feet.feet.l.place, r: sw?.side === 'r' ? sw.target : this.feet.feet.r.place };
    for (let i = 0; i < this.count; i++) {
      const s = this.steps[i];
      dcm.add(s.lift, s.cmp[0][0], s.cmp[0][1]);
      dcm.add(s.land, s.cmp[1][0], s.cmp[1][1]);
      lastPlace = { ...lastPlace, [s.side]: s.place };
    }
    this.endFrame = frameOf(this.feet, lastPlace);
    const lp = lastPlace.l, rp = lastPlace.r;
    this.final[0] = (lp.x + rp.x) / 2 + pin.shift[0];
    this.final[1] = (lp.y + rp.y) / 2 + pin.shift[1];
    const endT = this.count ? this.steps[this.count - 1].land : sw ? sw.land : pin.time;
    this.finalTime = endT + T.finalDs / w;
    dcm.add(this.finalTime, this.final[0], this.final[1]);
    dcm.solve(w);
    if (this.gait === 'hold' && this.count) {
      this.gait = 'drag';
      this.gaitSince = pin.time;
    }
  }
}

/** The stance frame two foot places describe (Gait.currentFrame for arbitrary places). */
export function frameOf(gait: Gait, place: Record<Side, FootPlace>): StanceFrame {
  const saveL = gait.feet.l.place, saveR = gait.feet.r.place;
  gait.feet.l.place = place.l;
  gait.feet.r.place = place.r;
  const f = gait.currentFrame();
  gait.feet.l.place = saveL;
  gait.feet.r.place = saveR;
  return f;
}

/** A point on a sole `fwd` × its half-length ahead of the centre (along the foot). */
export function soleCmp(geo: HumanoidGeometry, side: Side, p: FootPlace, fwd: number): P2 {
  const a = fwd * geo.legs[side].footHalfLength;
  return [p.x + Math.cos(p.yaw) * a, p.y + Math.sin(p.yaw) * a];
}

/** The pushing point of a sole for travel along (ux, uy): toward the travel, inside the sole. */
export function pushCmp(geo: HumanoidGeometry, side: Side, p: FootPlace, ux: number, uy: number, share: number): P2 {
  const leg = geo.legs[side];
  const [fx, fy] = rot2(ux, uy, -p.yaw); // travel in the foot frame
  const ax = share * leg.footHalfLength * fx, ay = share * leg.footHalfWidth * fy;
  const [wx, wy] = rot2(ax, ay, p.yaw);
  return [p.x + wx, p.y + wy];
}

/**
 * Keeps a landing within `maxSep` of the stance sole and clear of it (the feet never cross), and
 * the two feet's yaw inside what the hips can twist between them (Gait.constrainTarget for a
 * stance place that is not planted yet). `frameYaw`: the frame the feet must not cross in, the stance
 * foot's own by default (planned footholds point the way the stance does). Catch steps and landing
 * adjustments pass the pelvis's once the stance sole has spun far off it (step-adjust.ts crossFrame): the
 * legs cross at the hips, and in sparring a rear sole spun 75° turned "behind the body" into "across the
 * stance foot", so the catch step for a body falling backward was planned in front of it.
 */
export function constrainFrom(geo: HumanoidGeometry, st: FootPlace, side: Side, target: FootPlace, maxSep: number, frameYaw = st.yaw): FootPlace {
  const T = FOOTWORK_TUNING;
  const L = geo.legLength;
  const sign = side === 'l' ? 1 : -1;
  let [rx, ry] = rot2(target.x - st.x, target.y - st.y, -frameYaw);
  ry *= sign;
  ry = Math.max(ry, T.minGapL * L);
  const d = Math.hypot(rx, ry);
  const dMin = 0.2 * L;
  if (d < dMin) {
    rx *= dMin / d;
    ry *= dMin / d;
  } else if (d > maxSep) {
    rx *= maxSep / d;
    ry *= maxSep / d;
  }
  const [wx, wy] = rot2(rx, ry * sign, frameYaw);
  const maxRel = 2 * (0.7 - T.hipYawMargin);
  const rel = clamp(wrapAngle(target.yaw - st.yaw), -maxRel, maxRel);
  return { x: st.x + wx, y: st.y + wy, yaw: st.yaw + rel };
}
