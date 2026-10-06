// Mocap footwork on the plan (docs/design/balance-engine.md §9 Phase 5, "Motion matching, the
// physics way"). Human footwork on top, physically correct foot placement underneath:
//   pick      at every footstep event on two feet (a touchdown, a start from rest, a goal that
//             moved), a brute-force motion-matching search over the design's footwork clips
//             (mocap/footwork-db.ts): the query is the body now (soles relative to the pelvis, the
//             pelvis velocity, in the opponent-locked root frame) and the future the procedural
//             footstep plan asks for (the COM 0.2/0.4/0.6 clip-seconds ahead and the turn). The
//             playing clip's own continuation is favoured, the foot that has just landed is not
//             lifted again at once, and inside step-drag range no clip step passes the other foot
//   steps     the pick's next swings become the plan's footsteps: which foot, when it lifts and
//             lands (the clip's rhythm at the playback rate), how far it travels (warped to the
//             travel the plan asks for, shortened to what the hip can fly in the clip's time) and
//             how high it swings come from the clip; how wide the robot stands, the turn to face
//             the opponent, the reach set, the fence and the goal (steering, the arrival slots)
//             are the robot's. The procedural planner carries the plan on from the clip's last
//             step to the goal, so the DCM reference never brakes at the end of a clip
//   validate  a pick is kept only if its steps take the stance toward the goal and a rollout of
//             the pendulum under the engine's feedback, the CMP clipped into the soles
//             (rollout.ts), tracks its DCM reference about as well as the procedural plan's.
//             Otherwise the next best; none (or a move too small for a clip): the planner's own steps
//   follow    whenever the feet take the planner's steps (walking: these legs are too heavy for a
//             human stride at a human cadence; small corrections; a pick that did not fit), a clip
//             of the same kind (a walk, a shuffle) is matched and its clock follows those steps
//             foot by foot, so the style below still moves with the real contacts
//   clock     the clip's time follows the real contacts: it runs to the clip time of the next
//             event (a lift, a touchdown) by the time the plan has it, waits there for a foot that
//             is late, and jumps to the touchdown when a foot lands early (the rest of that
//             fragment is dropped; the style layer's jump is inertialized)
//   style     mocap-style.ts: arms, waist and pelvis offsets from the clip on this clock (off by
//             default: measured, it cost strikes and stepping falls)
// SD_MOCAP_FOOTWORK = 0 (none of it) | steps (the default) | style | 1 (both).
// Allocation free per tick; a pick (at footstep events, 2-5 Hz) allocates a few small objects.
import { APOTHEM } from '../../../core/arena-spec';
import { other, type Gait, type StanceFrame } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import { clamp, rot2, wrapAngle } from '../math';
import { footworkDb, FUTURE_S, nearest, newQuery, pelvisAt, QUERY, stepOf, type DbClip, type DbStep, type FootworkDb } from '../mocap/footwork-db';
import type { MocapSet } from '../mocap/library';
import type { Sense } from '../sense';
import type { StanceParams } from '../stance';
import type { FootPlace, P2 } from '../support';
import { constrainFrom, FOOTWORK_TUNING, minSwingTime, soleCmp, type LegDrive } from './footsteps';
import type { Footstep } from './types';

const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SD_MOCAP_FOOTWORK;

/** Tuning (exported so tools can sweep it; the worker never changes it). */
export const MOCAP_STEPS = {
  /** 1: footsteps from the clips; 0: the procedural planner's (SD_MOCAP_FOOTWORK=0 or =style). */
  enabled: ENV === '0' || ENV === 'style' ? 0 : 1,
  /** Walking (the far approach) on clip steps too. 0: the procedural walk with the clip's clock and
   *  style following it (these heavy legs cannot fly a human stride at a human cadence: measured, a
   *  clip walk stalls between long steps and leans on the gyro). */
  walkClips: 0,
  rateLo: 1.0, // wanted clip time scale at aggression 0...
  rateHi: 1.35, // ...and 1 (the motors' rate tables and the hip cap it)
  topK: 8, // candidates validated, best first
  continuity: 0.55, // cost multiplier for the playing clip's own continuation
  sameFootCost: 4, // ...and for lifting the foot that has just landed (within freshS of the touchdown)
  freshS: 0.15,
  maxMismatchM: 0.04, // a pick's DCM reference starts at most this far from the procedural plan's
  maxClampM: 0.06, // the reach set may move a clip landing at most this far
  maxTravelL: 0.55, // a clip swing moves its foot at most this far (× leg length)...
  maxStrideL: 1.0, // ...a walking (passing) one this far
  maxStretch: 1.8, // the hip may slow a clip swing at most this much
  steerM: 0.1, // a landing slides at most this far toward the goal's slot
  minMoveM: 0.2, // a goal closer than this (and a turn under minTurnRad) is the planner's to square up: no pick
  minTurnRad: 0.35,
  progressShare: 0.5, // a pick must cut the distance to the goal by this share of the ground it covers
  snapM: 0.14, // the segment's last landing this close to its goal slot lands in it
  horizon: 3, // clip steps planned per pick (the procedural plan carries on from the last)
  minDsW: 0.2, // double support at least this × 1/ω₀ between swings...
  maxDsWalkW: 0.35, // ...and between walking (passing) steps at most this (a heavy body stalls between
  //                   spread feet: these legs cannot push off the trailing toe, the weight settles forward)
  dsReachHL: 1.0, // the validation rollout keeps the CMP on two feet within this × a sole's half-length of the COM...
  settleS: 0, // ...and on the sole just landed for this long after a touchdown (rollout.ts; 0.12 made every plan,
  //             the procedural ones too, diverge in step-drag range: no use as a yardstick)
  warpMin: 0.25, // the clip's steps scale to the plan's travel (motion warping): at least this...
  warpMax: 1.15, // ...at most this
  launchW: 0.6, // from standing, the first lift waits at least this × 1/ω₀ (FOOTWORK_TUNING.launch)
  apexMinL: 0.025, // swing apex, × leg length, from the clip's own (the boxers' hops are capped)
  apexMaxL: 0.05,
  latMaxL: 0.55, // soles at most this far apart across the opponent line (× leg length)
  walkToeOut: 0.06,
};

/** A clip footstep: a Footstep (source 'clip') with the clip times it stands for. */
export interface ClipFootstep extends Footstep {
  clipLift: number;
  clipLand: number;
}

function newClipStep(): ClipFootstep {
  return { side: 'l', place: { x: 0, y: 0, yaw: 0 }, lift: 0, land: 0, cmp: [[0, 0], [0, 0]], clearance: 0, source: 'clip', clipLift: 0, clipLand: 0 };
}

/** What a pick needs from the engine. */
export interface PickInput {
  s: Sense;
  time: number;
  omega: number;
  bearing: number;
  aggression: number;
  gait: Gait;
  goal: StanceFrame | null;
  opp: P2 | null;
  /** World COM displacement the procedural plan predicts at FUTURE_S[i] / rate (wall s), x,y × 3. */
  future: Float32Array;
  /** Stance heading change the plan asks for by then (rad), × 3. */
  facing: Float32Array;
  drive: LegDrive;
  fromRest: boolean;
  doubleS: number;
  /** Walking (the feet may pass); in step-drag range they never do (§4.2). */
  allowPass: boolean;
  /** The foot that landed last (it carries the weight just after a touchdown), or null. */
  lastLanded: Side | null;
  /** Plans the steps (count of them) and says whether the body can follow that plan now. */
  accept(steps: readonly ClipFootstep[], count: number): boolean;
}

export class MocapSteps {
  readonly db: FootworkDb | null;
  /** The clip whose steps the feet are taking (or just took), and its playback. */
  clip: DbClip | null = null;
  rate = 1;
  /** Clip time of `clip`, synced to the contacts. */
  tau = 0;
  /** The pick's steps (wall times, world places) and progress through them. */
  readonly steps: ClipFootstep[] = Array.from({ length: 8 }, newClipStep);
  count = 0;
  /** Next step not lifted yet; the step in the air (−1: none). */
  next = 0;
  inAir = -1;
  /**
   * 'steps': the pick's clip steps drive the feet. 'follow': the feet take the planner's own steps
   * (walking, or a pick that did not fit) and the clip's clock follows them, step for step by side,
   * so the style layer moves with the real contacts. 'off': the guard idle.
   */
  mode: 'off' | 'steps' | 'follow' = 'off';
  /** Follow mode: the clip step to pair with the next lift, and the pair in the air. */
  private followK = 0;
  private readonly air: DbStep = { side: 'l', lift: 0, land: 0, apex: 0, from: [0, 0], to: [0, 0], yawFrom: 0, yawTo: 0, stance: [0, 0], passes: false };
  private airLand = 0;
  private airOn = false;
  /** The clip (or its clock) jumped: the controller inertializes the style's arms and waist. */
  switched = false;
  /** Telemetry: picks made, picks that fell back to the procedural steps. */
  picks = 0;
  fallbacks = 0;
  /** Tools: a log of picks and rejections (left undefined in the game). */
  trace?: string[];
  private readonly query = newQuery();
  private readonly scratch = newQuery();
  private readonly best = new Int32Array(MOCAP_STEPS.topK);
  private readonly cost = new Float64Array(MOCAP_STEPS.topK);
  private readonly pending: ClipFootstep[] = Array.from({ length: 8 }, newClipStep);
  private readonly st: DbStep = { side: 'l', lift: 0, land: 0, apex: 0, from: [0, 0], to: [0, 0], yawFrom: 0, yawTo: 0, stance: [0, 0], passes: false };
  private readonly stanceSep: P2;
  private readonly p0: [number, number, number] = [0, 0, 0];
  private readonly p1: [number, number, number] = [0, 0, 0];
  private readonly walkSep: number;

  constructor(
    private readonly set: MocapSet,
    private readonly geo: HumanoidGeometry,
    private readonly stance: StanceParams,
  ) {
    this.db = footworkDb(set, geo);
    const l = stance.slots.l, r = stance.slots.r;
    this.stanceSep = [l.x - r.x, l.y - r.y];
    this.walkSep = 2 * geo.legs.l.footHalfWidth + FOOTWORK_TUNING.walkGapM;
  }

  /** Clip steps are driving the feet (planned, or one in the air). */
  get active(): boolean {
    return this.mode === 'steps' && this.clip !== null && (this.next < this.count || this.inAir >= 0);
  }

  /** The clip's clock follows the planner's steps (the style moves with them). */
  get following(): boolean {
    return this.mode === 'follow' && this.clip !== null;
  }

  /** Drop the segment (a capture step, a kick, a hold, a fall): the feet are the planner's again. */
  cancel(): void {
    if (this.clip) this.switched = true;
    this.clip = null;
    this.mode = 'off';
    this.count = this.next = 0;
    this.inAir = -1;
    this.airOn = false;
  }

  /**
   * The feet take the planner's steps; the clip's clock follows them (pick the clip by the
   * matcher's best candidate for this query; a playing clip keeps playing).
   */
  follow(inp: PickInput): void {
    const db = this.db;
    if (!db) return;
    // A followed clip of the right kind (a walk while walking, a shuffle in range) plays on.
    if (this.mode === 'follow' && this.clip && this.clip.move.label.startsWith('walk') === inp.allowPass) return;
    const M = MOCAP_STEPS;
    const rate = M.rateLo + (M.rateHi - M.rateLo) * clamp(inp.aggression, 0, 1);
    this.fillQuery(inp, rate);
    const playing = this.clip;
    const tau = this.tau;
    // Walking, the style is a walk's (the feet pass); in step-drag range, a shuffle's.
    const walk = inp.allowPass;
    const found = nearest(db, this.query, this.scratch, this.best, this.cost, (i) => {
      const c = db.clips[db.cClip[i]];
      if (c.move.label.startsWith('walk') !== walk) return Infinity;
      return playing && db.cClip[i] === playing.index && Math.abs(db.cTime[i] - tau) < 2.5 / 60 ? M.continuity : 1;
    });
    if (!found) return;
    const i = this.best[0];
    const c = db.clips[db.cClip[i]];
    if (c !== playing || Math.abs(db.cTime[i] - tau) > 2.5 / 60) this.switched = true;
    this.clip = c;
    this.mode = 'follow';
    this.rate = Math.min(rate, this.legRate(c, db.cTime[i]));
    this.tau = db.cTime[i];
    this.followK = db.cStep[i];
    this.count = this.next = 0;
    this.inAir = -1;
    this.airOn = false;
    this.trace?.push(`${inp.time.toFixed(2)} follow ${c.move.id}@${this.tau.toFixed(2)}`);
  }

  /** Follow mode: the planner lifted `side`, landing at wall time `land`: pair it with the clip's next step of that side. */
  followLift(side: Side, land: number): void {
    const c = this.clip;
    if (this.mode !== 'follow' || !c) return;
    const n = c.steps.length;
    const lim = c.move.loop ? this.followK + n + 1 : n;
    let k = this.followK;
    while (k < lim && stepOf(c, k, this.air).side !== side) k++;
    if (k >= lim) {
      // The clip has no such step left (a one-shot played out): back to the guard idle.
      this.cancel();
      return;
    }
    if (this.tau < this.air.lift - 1 / 60 || this.tau > this.air.lift + 0.15) this.switched = true;
    this.tau = this.air.lift;
    this.airLand = land;
    this.airOn = true;
    this.followK = k + 1;
  }

  /** The clip step lifting now is pick index `i` (the engine lifted it). */
  onLift(i: number): void {
    if (!this.clip || i < 0 || i >= this.count) return;
    const st = this.steps[i];
    // A lift that came before the clip's clock got there (the body was ready early): jump to it.
    if (this.tau < st.clipLift - 1 / 60) this.switched = true;
    this.tau = Math.max(this.tau, st.clipLift);
    this.inAir = i;
    this.next = i + 1;
  }

  /** The swing in the air landed (early: the rest of the fragment is dropped). */
  onTouchdown(): void {
    if (this.mode === 'follow' && this.airOn) {
      if (this.tau < this.air.land - 1 / 60) this.switched = true;
      this.tau = Math.max(this.tau, this.air.land);
      this.airOn = false;
      return;
    }
    if (this.inAir < 0 || !this.clip) {
      this.inAir = -1;
      return;
    }
    const st = this.steps[this.inAir];
    if (this.tau < st.clipLand - 1 / 60) this.switched = true;
    this.tau = Math.max(this.tau, st.clipLand);
    this.inAir = -1;
  }

  /**
   * The engine re-timed the plan from a real lift-off: the steps still to come keep their clip
   * rhythm after the one in the air (wall times shift by the delay).
   */
  retime(landing: number): void {
    if (this.inAir < 0) return;
    const shift = landing - this.steps[this.inAir].land;
    if (Math.abs(shift) < 1e-6) return;
    this.steps[this.inAir].land = landing;
    for (let i = this.inAir + 1; i < this.count; i++) {
      this.steps[i].lift += shift;
      this.steps[i].land += shift;
    }
  }

  /**
   * Advance the clip clock (contact sync); once per control tick. The clock runs toward the clip time
   * of the next contact event (a lift, a touchdown) so as to reach it when the plan says that event
   * comes, and waits there for the real one. `nextLift`: the planner's next lift (wall time, NaN if
   * none), for follow mode.
   */
  tick(t: number, dt: number, nextLift: number): void {
    const c = this.clip;
    if (c) {
      let target = NaN, deadline = NaN;
      if (this.mode === 'steps') {
        if (this.inAir >= 0) {
          target = this.steps[this.inAir].clipLand;
          deadline = this.steps[this.inAir].land;
        } else if (this.next < this.count) {
          target = this.steps[this.next].clipLift;
          deadline = this.steps[this.next].lift;
        }
      } else if (this.mode === 'follow') {
        if (this.airOn) {
          target = this.air.land;
          deadline = this.airLand;
        } else if (Number.isFinite(nextLift)) {
          const n = c.steps.length;
          if (this.followK < (c.move.loop ? Infinity : n)) {
            target = stepOf(c, this.followK, this.st).lift;
            deadline = nextLift;
          }
        }
      }
      if (Number.isFinite(target)) {
        const k = Number.isFinite(deadline) ? clamp((target - this.tau) / Math.max(dt, deadline - t), 0, 3) : this.rate;
        this.tau = Math.min(target, this.tau + dt * k);
      } else {
        this.tau += dt * this.rate;
        // A one-shot clip played out: the style goes back to the guard idle.
        if (!c.move.loop && this.tau >= c.move.duration) this.cancel();
      }
    }
  }

  /**
   * Motion-matching pick at a footstep event on two feet. Returns true when a clip segment now
   * drives the feet (its steps are in `steps`, already accepted by `inp.accept`).
   */
  pick(inp: PickInput): boolean {
    const db = this.db;
    const goal = inp.goal;
    if (!db || !MOCAP_STEPS.enabled || !goal) return false;
    const M = MOCAP_STEPS;
    // No goal, no footwork to match: squaring up and recovering (a push, a capture step) are the
    // planner's and the step adjuster's (§2: clips are footwork, not recovery; measured, picks after
    // a stance push walked PYLON off its feet). Small corrections (a few cm of range) are the
    // planner's precise job too.
    const f = inp.gait.currentFrame();
    if (Math.hypot(goal.x - f.x, goal.y - f.y) < M.minMoveM && Math.abs(wrapAngle(goal.heading - f.heading)) < M.minTurnRad) return false;
    const rate = M.rateLo + (M.rateHi - M.rateLo) * clamp(inp.aggression, 0, 1);
    this.fillQuery(inp, rate);
    const playing = this.clip;
    const tau = this.tau;
    // Inside step-drag range no walking step; just after a touchdown, not the foot that just landed
    // (its leg has the weight: it would have to be shifted straight back off it).
    const fresh = inp.lastLanded && inp.doubleS < M.freshS ? (inp.lastLanded === 'l' ? 0 : 1) : -1;
    const found = nearest(db, this.query, this.scratch, this.best, this.cost, (i) => {
      if (!inp.allowPass && db.cPass[i]) return Infinity;
      let b = playing && db.cClip[i] === playing.index && Math.abs(db.cTime[i] - tau) < 2.5 / 60 ? M.continuity : 1;
      if (db.cSide[i] === fresh) b *= M.sameFootCost;
      return b;
    });
    for (let k = 0; k < found; k++) {
      const i = this.best[k];
      const c = db.clips[db.cClip[i]];
      // The clip's own rate table caps the playback (its leg joints at their motors' speeds).
      const r = Math.min(rate, this.legRate(c, db.cTime[i]));
      const n = this.place(inp, c, db.cTime[i], db.cStep[i], r);
      if (n <= 0 || !inp.accept(this.pending, n)) {
        this.trace?.push(`${inp.time.toFixed(2)} reject ${c.move.id}@${db.cTime[i].toFixed(2)} cost ${this.cost[k].toFixed(1)} ${n <= 0 ? `place ${this.why}` : 'dcm'}`);
        continue;
      }
      this.trace?.push(`${inp.time.toFixed(2)} pick ${c.move.id}@${db.cTime[i].toFixed(2)} cost ${this.cost[k].toFixed(1)} rate ${r.toFixed(2)} steps ${this.pending.slice(0, n).map((p) => `${p.side}${p.clipIdx ?? ''}[${p.lift.toFixed(2)}-${p.land.toFixed(2)}] (${p.place.x.toFixed(2)},${p.place.y.toFixed(2)})`).join(' ')}`);
      const same = playing === c && Math.abs(db.cTime[i] - tau) < 2.5 / 60;
      if (!same) this.switched = true;
      this.clip = c;
      this.mode = 'steps';
      this.airOn = false;
      this.rate = r;
      this.tau = db.cTime[i];
      for (let j = 0; j < n; j++) copyStep(this.pending[j], this.steps[j]);
      this.count = n;
      this.next = 0;
      this.inAir = -1;
      this.picks++;
      return true;
    }
    this.fallbacks++;
    this.trace?.push(`${inp.time.toFixed(2)} fallback (${found} tried)`);
    if (this.mode === 'steps') this.cancel();
    return false;
  }

  /** Why the last place() refused (tools). */
  private why = '';

  /** The slowest the clip's leg joints allow around clip time t (its rate table, legs mask). */
  private legRate(c: DbClip, t: number): number {
    const table = this.set.rates(c.move, 'legs');
    const f0 = Math.max(0, Math.round(t * c.move.fps));
    let lim = Infinity;
    for (let f = f0; f < Math.min(table.length, f0 + Math.round(1.2 * c.move.fps)); f++) lim = Math.min(lim, table[f]);
    return Number.isFinite(lim) ? lim : 1;
  }

  /** The query: the body now and the future the plan asks for, in the opponent-locked frame. */
  private fillQuery(inp: PickInput, rate: number): void {
    const q = this.query;
    const s = inp.s;
    const b = -inp.bearing;
    const g = inp.gait;
    for (const [k, side] of [[0, 'l'], [1, 'r']] as const) {
      const p = g.feet[side].place;
      const [x, y] = rot2(p.x - s.pelvisPos[0], p.y - s.pelvisPos[1], b);
      q[QUERY.FEET + 2 * k] = x;
      q[QUERY.FEET + 2 * k + 1] = y;
      q[QUERY.FOOTVEL + 2 * k] = 0;
      q[QUERY.FOOTVEL + 2 * k + 1] = 0;
    }
    const [vx, vy] = rot2(s.comVel[0], s.comVel[1], b);
    q[QUERY.HIPVEL] = vx / rate;
    q[QUERY.HIPVEL + 1] = vy / rate;
    for (let i = 0; i < 3; i++) {
      const [fx, fy] = rot2(inp.future[2 * i], inp.future[2 * i + 1], b);
      q[QUERY.FUTURE + 2 * i] = fx;
      q[QUERY.FUTURE + 2 * i + 1] = fy;
      q[QUERY.FACING + i] = inp.facing[i];
    }
  }

  /**
   * The robot's footsteps for clip `c` from clip time `t0` (next clip step `k0`) at rate `r`, into
   * `pending`. Returns how many, or 0 when the clip's steps do not fit this robot here.
   */
  private place(inp: PickInput, c: DbClip, t0: number, k0: number, r: number): number {
    const M = MOCAP_STEPS;
    const g = inp.gait;
    const geo = this.geo;
    const L = geo.legLength;
    const w = inp.omega;
    const cosB = Math.cos(inp.bearing), sinB = Math.sin(inp.bearing);
    const place: Record<Side, FootPlace> = { l: { ...g.feet.l.place }, r: { ...g.feet.r.place } };
    const minDs = M.minDsW / w;
    let tClip = t0;
    let tWall = inp.time;
    let n = 0;
    const heading = inp.goal ? inp.goal.heading : inp.bearing;
    const nSteps = c.steps.length;
    // Motion warping: the clip's steps scale to the travel the plan asks for over the feature horizon
    // (a body still getting up to speed takes shorter steps than the actor; time stays the clip's).
    const p0 = pelvisAt(c, t0, this.p0), p1 = pelvisAt(c, t0 + FUTURE_S[2], this.p1);
    const dClip = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const dPlan = Math.hypot(inp.future[4], inp.future[5]);
    const warp = dClip > 0.05 ? clamp(dPlan / dClip, M.warpMin, M.warpMax) : 1;
    const last = c.move.loop ? k0 + M.horizon : Math.min(nSteps, k0 + M.horizon);
    for (let k = k0; k < last; k++) {
      const st = stepOf(c, k, this.st);
      // Inside step-drag range the feet never pass: the segment ends before such a step.
      if (st.passes && !inp.allowPass) {
        this.why = 'passes';
        break;
      }
      const side = st.side, o = other(side);
      const sg = side === 'l' ? 1 : -1;
      // When: the clip's double support at the playback rate (and enough to shift the weight).
      let ds = (st.lift - tClip) / r;
      if (st.passes) ds = Math.min(ds, M.maxDsWalkW / w);
      let lift = tWall + Math.max(ds, n === 0 ? Math.max(0.02, minDs - inp.doubleS) : minDs);
      if (n === 0 && inp.fromRest) lift = Math.max(lift, inp.time + M.launchW / w);
      // Where: the foot moves as the clip moves it (turned into the opponent frame, capped)...
      let mx = (st.to[0] - st.from[0]) * warp, my = (st.to[1] - st.from[1]) * warp;
      const mv = Math.hypot(mx, my), cap = (st.passes ? M.maxStrideL : M.maxTravelL) * L;
      if (mv > cap) {
        mx *= cap / mv;
        my *= cap / mv;
      }
      const P = place[side], S = place[o];
      let tx = P.x + cosB * mx - sinB * my, ty = P.y + sinB * mx + cosB * my;
      // ...but stands as wide as this robot stands (the actors' guard is wider, their walk
      // narrower): the clip's width off its own nominal, around ours.
      let [ax, ay] = rot2(tx - S.x, ty - S.y, -inp.bearing);
      const clipSep = sg * (st.to[1] - st.stance[1]);
      const actorSep = st.passes ? 0.5 * (this.db!.actorStance[1]) : this.db!.actorStance[1];
      const ownSep = st.passes ? this.walkSep : this.stanceSep[1];
      const sep = clamp(ownSep + (clipSep - actorSep), this.walkSep, M.latMaxL * L);
      ay = sg * sep;
      [tx, ty] = rot2(ax, ay, inp.bearing);
      tx += S.x;
      ty += S.y;
      // Feet point the stance's way (a walking step along its travel).
      let yaw: number;
      if (st.passes) yaw = Math.atan2(my * cosB + mx * sinB, mx * cosB - my * sinB) + sg * M.walkToeOut;
      else yaw = heading + this.stance.slots[side].yaw;
      let target: FootPlace = { x: tx, y: ty, yaw };
      // Steering toward the goal: a step whose goal slot lies within the clip's own step (plus
      // snapM) lands in it (the arrival: the clip's rhythm, the stance's place); farther off, the
      // landing slides at most steerM across the clip's travel toward the slot.
      if (inp.goal) {
        const gs = g.slot(side, inp.goal);
        const toSlot = Math.hypot(gs.x - P.x, gs.y - P.y);
        if (toSlot <= Math.min(mv, cap) + M.snapM) target = gs;
        else {
          const ex = gs.x - target.x, ey = gs.y - target.y;
          const len = Math.min(mv, cap);
          const ux = len > 1e-3 ? (cosB * mx - sinB * my) / len : 0, uy = len > 1e-3 ? (sinB * mx + cosB * my) / len : 0;
          const along = ex * ux + ey * uy;
          const sx = ex - along * ux, sy = ey - along * uy;
          const sn = Math.hypot(sx, sy);
          const k2 = sn > M.steerM ? M.steerM / sn : 1;
          target = { x: target.x + sx * k2, y: target.y + sy * k2, yaw: target.yaw };
        }
      }
      // Never carry the stance past the goal toward the opponent (ring IQ: no walking into guards).
      if (inp.opp && inp.goal) {
        const o2 = inp.opp;
        const dGoal = Math.hypot(inp.goal.x - o2[0], inp.goal.y - o2[1]);
        const mxM = (target.x + S.x) / 2, myM = (target.y + S.y) / 2;
        const dMid = Math.hypot(mxM - o2[0], myM - o2[1]);
        const short = dGoal - 0.03 - dMid;
        if (short > 0 && dMid > 1e-6) {
          // Move the landing back along the line from the opponent (twice: the midpoint moves half).
          const ux = (mxM - o2[0]) / dMid, uy = (myM - o2[1]) / dMid;
          target = { x: target.x + 2 * short * ux, y: target.y + 2 * short * uy, yaw: target.yaw };
        }
      }
      // The reach set (feet never cross, within the leg's span of the stance sole) and the fence. A
      // clip step longer than these legs reach is shortened; one the set moves sideways (the feet
      // would cross) is not this clip's step any more.
      const sep2 = FOOTWORK_TUNING.maxSepL * L;
      const reachable = insideFence(constrainFrom(geo, S, side, target, sep2));
      {
        const dx = target.x - P.x, dy = target.y - P.y;
        const len = Math.hypot(dx, dy);
        const cx = reachable.x - target.x, cy = reachable.y - target.y;
        const side2 = len > 1e-3 ? Math.abs((cx * dy - cy * dx) / len) : Math.hypot(cx, cy);
        if (side2 > M.maxClampM) {
          this.why = `reach ${side2.toFixed(2)}`;
          break;
        }
      }
      // How long: the clip's swing at the playback rate. A step the hip cannot fly in that time is
      // shortened to what it can (the rhythm is the clip's; these legs are heavier than the actor's).
      const clipT = Math.max(0.12, (st.land - st.lift) / r);
      let land2 = reachable;
      const travel0 = Math.hypot(reachable.x - P.x, reachable.y - P.y);
      const fly = maxSwingTravel(inp.drive, clipT, L, FOOTWORK_TUNING.swingTorqueShare);
      if (travel0 > fly && travel0 > 1e-6) {
        const k3 = fly / travel0;
        land2 = constrainFrom(geo, S, side, { x: P.x + (reachable.x - P.x) * k3, y: P.y + (reachable.y - P.y) * k3, yaw: reachable.yaw }, sep2);
      }
      const travel = Math.hypot(land2.x - P.x, land2.y - P.y);
      const need = minSwingTime(inp.drive, travel, L, FOOTWORK_TUNING.swingTorqueShare);
      if (need > M.maxStretch * clipT) {
        this.why = `hip ${need.toFixed(2)}>${clipT.toFixed(2)}`;
        break;
      }
      const T = Math.max(clipT, need);
      this.trace?.push(`      place ${c.move.id} k${k} ${side}${st.passes ? '*' : ''} warp ${warp.toFixed(2)} mv ${mx.toFixed(2)},${my.toFixed(2)} P (${P.x.toFixed(2)},${P.y.toFixed(2)}) S (${S.x.toFixed(2)},${S.y.toFixed(2)}) target (${target.x.toFixed(2)},${target.y.toFixed(2)}) reach (${reachable.x.toFixed(2)},${reachable.y.toFixed(2)}) fly ${fly.toFixed(2)} land (${land2.x.toFixed(2)},${land2.y.toFixed(2)}) T ${T.toFixed(2)}`);
      const out = this.pending[n++];
      out.side = side;
      out.place = land2;
      out.lift = lift;
      out.land = lift + T;
      out.clearance = clamp(st.apex, M.apexMinL * L, M.apexMaxL * L);
      out.source = 'clip';
      out.clipLift = st.lift;
      out.clipLand = st.land;
      // The stance sole's CMP: rolling heel to toe under a walking step, else pushing toward the travel.
      if (st.passes) {
        const [hx, hy] = soleCmp(geo, o, S, FOOTWORK_TUNING.cmpHeel);
        const [ex2, ey2] = soleCmp(geo, o, S, FOOTWORK_TUNING.cmpToe);
        out.cmp[0][0] = hx;
        out.cmp[0][1] = hy;
        out.cmp[1][0] = ex2;
        out.cmp[1][1] = ey2;
      } else {
        const ux = travel > 1e-3 ? (land2.x - P.x) / travel : Math.cos(inp.bearing), uy = travel > 1e-3 ? (land2.y - P.y) / travel : Math.sin(inp.bearing);
        const [cx, cy] = pushPoint(geo, o, S, ux, uy, FOOTWORK_TUNING.cmpPush);
        out.cmp[0][0] = out.cmp[1][0] = cx;
        out.cmp[0][1] = out.cmp[1][1] = cy;
      }
      place[side] = land2;
      tClip = st.land;
      tWall = out.land;
    }
    // The segment must take the stance toward the goal (a clip whose steps wander off it is not
    // the move asked for): the distance left falls by at least progressShare of the ground covered.
    if (n > 0 && inp.goal) {
      const g0 = g.currentFrame();
      const before = Math.hypot(inp.goal.x - g0.x, inp.goal.y - g0.y);
      const mx = (place.l.x + place.r.x) / 2 - (g.feet.l.place.x + g.feet.r.place.x) / 2;
      const my = (place.l.y + place.r.y) / 2 - (g.feet.l.place.y + g.feet.r.place.y) / 2;
      const ex = g0.x + mx, ey = g0.y + my;
      const after = Math.hypot(inp.goal.x - ex, inp.goal.y - ey);
      if (before - after < M.progressShare * Math.hypot(mx, my)) {
        this.why = `wanders ${before.toFixed(2)}→${after.toFixed(2)}`;
        return 0;
      }
    }
    return n;
  }
}

/**
 * The furthest the hip can fly a sole in `swing` seconds with `share` of its stall torque and no-load
 * speed (the inverse of footsteps.ts minSwingTime: a minimum-jerk path over 80% of the swing).
 */
function maxSwingTravel(drive: LegDrive, swing: number, legLength: number, share: number): number {
  const r = 0.9 * legLength;
  const tau = 0.8 * swing;
  const byTorque = (share * drive.stallNm * r * tau * tau) / (5.77 * Math.max(1e-6, drive.inertia));
  const bySpeed = (share * drive.noLoadRadS * r * tau) / 1.875;
  return Math.min(byTorque, bySpeed);
}

function copyStep(a: ClipFootstep, b: ClipFootstep): void {
  b.side = a.side;
  b.place = { ...a.place };
  b.lift = a.lift;
  b.land = a.land;
  b.cmp[0][0] = a.cmp[0][0];
  b.cmp[0][1] = a.cmp[0][1];
  b.cmp[1][0] = a.cmp[1][0];
  b.cmp[1][1] = a.cmp[1][1];
  b.clearance = a.clearance;
  b.source = a.source;
  b.clipLift = a.clipLift;
  b.clipLand = a.clipLand;
}

/** Keeps a landing inside the cage (the step adjuster's fence). */
function insideFence(p: FootPlace): FootPlace {
  const lim = APOTHEM - 0.9;
  const r = Math.hypot(p.x, p.y);
  if (r <= lim) return p;
  return { x: (p.x * lim) / r, y: (p.y * lim) / r, yaw: p.yaw };
}

/** The pushing point of a sole for travel along (ux, uy): toward the travel, inside the sole. */
function pushPoint(geo: HumanoidGeometry, side: Side, p: FootPlace, ux: number, uy: number, share: number): P2 {
  const leg = geo.legs[side];
  const [fx, fy] = rot2(ux, uy, -p.yaw);
  const [wx, wy] = rot2(share * leg.footHalfLength * fx, share * leg.footHalfWidth * fy, p.yaw);
  return [p.x + wx, p.y + wy];
}

export { FUTURE_S };
