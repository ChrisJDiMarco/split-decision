// Walking: how a fighter covers ground (closing the distance). Stance footwork (stepping.ts) moves
// the feet between slots with the COM brought to rest over each stance sole first: precise, and
// slow (~0.2 m/s). Walking keeps the COM travelling. Every step is planned on the capture point ξ
// of the linear inverted pendulum, which through a step over a centre of pressure p moves as
//     ξ(t) = p + (ξ₀ − p)·e^{ωt}
//   lift-off   the pressure sits on the stance sole just ahead of its centre, so ξ runs on ahead
//              of it; only a step that would land beyond the leg's reach moves it toward the toe,
//              which slows ξ: p = (ξ_T − ξ₀·e^{ωT}) / (1 − e^{ωT})
//   swing      the landing is re-aimed every update at where ξ will be at touchdown, less the
//              offsets that hold a steady walk: b = s / (e^{ωT} − 1) short of it for a stride s,
//              d = 2w / (e^{ωT} + 1) out to the side for a step width 2w. Landing short of ξ is
//              what keeps the walk going; landing on it would stop it.
//   start      from standing the front foot steps first (ξ already lies ahead of the rear sole),
//              after a short sideways weight shift that puts ξ just inside the rear foot
//   stop       the last step lands the feet either side of ξ: the walk ends at rest in double
//              support and the stance footwork squares the feet up.
import { other, type Gait, type StanceFrame } from './gait';
import { sideSign, type HumanoidGeometry, type Side } from './geometry';
import { clamp, rot2 } from './math';
import type { Sense } from './sense';
import { clampToPolygon, footCorners, type FootPlace, type P2 } from './support';

const WALK_START_M = 0.6; // COM this far from the goal: walk rather than shuffle in stance
const WALK_STOP_M = 0.3; // a step that would carry the COM within this of the goal ends the walk
const WALK_MAX_ANGLE_RAD = 0.9; // walking is forward only: goal within this of the facing
const DS_S = 0.1; // double support between walking steps: the landed sole takes the weight, and
// the pressure moves across to put ξ where the next step needs it
const SHIFT_MAX_S = 0.8; // a starting weight shift that never frees the first step gives up
const SHIFT_GAIN = 1.5; // capture-point convergence during that shift, × ω
const SHIFT_TOL_M = 0.025; // ...until ξ is this close to where the first step needs it
const MAX_STRIDE = 0.46; // × leg length: stance sole to landing sole, along the walk
const MAX_BACK = 0.1; // × leg length: a landing may fall this far behind the stance sole
const MIN_WIDTH = 0.16; // × leg length: sole centres apart across the walk
const MAX_WIDTH = 0.42;
const COP_FWD = 0.2; // walking pressure point, × sole half-length ahead of its centre
const COP_MARGIN_M = 0.025; // a displaced pressure point stays this far inside the sole
const RETARGET_UNTIL = 0.85; // swing progress after which the landing stays put
const SWING_BASE_S = 0.32; // swing time: base...
const SWING_PER_M = 0.3; // ...plus this per metre the foot travels (heavy legs)
const SWING_MIN_S = 0.34;
const SWING_MAX_S = 0.6;
const TOE_OUT_RAD = 0.08;
const LEG_COM_SHARE = 0.6; // a leg's own COM moves this fraction of its foot's travel
const COP_UNTIL = 0.8; // swing progress after which the stance pressure point stays put
const LIFT_M = 0.06;

export interface WalkParams {
  speed: number; // m/s
  halfWidth: number; // m, sole centre from the walk line
  /** How far the gyro core can move the pressure point beyond the sole right now, m (its torque
   *  over m·g, less what its stored momentum has used up). */
  assistM: number;
}

interface WalkFrame {
  ox: number; // origin (the COM)
  oy: number;
  h: number; // walk heading
  ux: number; // along the walk
  uy: number;
  nx: number; // to the walker's left
  ny: number;
}

export class Walker {
  debug: unknown = null;
  /** Pressure-point shift beyond the sole the gyro core is asked for (world, m): the controller
   *  turns it into a torque m·g·(Δy, −Δx) on the torso. */
  readonly assist: P2 = [0, 0];
  private end: P2 = [0, 0];
  private shiftT = -1;
  private stopping = false;
  private next: Side | null = null;

  /**
   * `legShare`: one leg's share of the body mass. A heavy swing leg carries the COM forward with it
   * (≈ LEG_COM_SHARE of its travel × its mass share), which the point-mass pendulum does not see.
   */
  constructor(private readonly gait: Gait, private readonly geo: HumanoidGeometry, private readonly legShare = 0.15) {}

  get active(): boolean {
    return this.gait.walking || this.shiftT >= 0;
  }

  /** Walk for this body at `speed`: width from the hips. */
  params(speed: number, assistM = 0): WalkParams {
    return { speed, halfWidth: 0.95 * Math.abs(this.geo.legs.l.hip[1]), assistM };
  }

  /** Should a goal this far off be walked to? (Only forward: backing off stays in stance.) */
  wants(s: Sense, goal: StanceFrame | null, facing: number): boolean {
    if (!goal) return false;
    const dx = goal.x - s.com[0], dy = goal.y - s.com[1];
    if (Math.hypot(dx, dy) < WALK_START_M) return false;
    const a = Math.atan2(dy, dx) - facing;
    return Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < WALK_MAX_ANGLE_RAD;
  }

  /** Stop walking at once (a skill, a fall, the gantry). The COM settles where the feet are. */
  cancel(): void {
    this.assist[0] = this.assist[1] = 0;
    this.shiftT = -1;
    this.stopping = false;
    this.next = null;
    this.gait.stopWalk();
  }

  /**
   * One control update of the walk toward `goal`. Returns true while the walk owns the feet
   * (the caller then leaves the stance footwork alone).
   */
  update(s: Sense, goal: StanceFrame | null, p: WalkParams, dt: number): boolean {
    const gait = this.gait;
    if (!gait.walking) this.assist[0] = this.assist[1] = 0;
    if (gait.airborne()) return false;
    if (gait.phase === 'single' && gait.walking) {
      if (!goal) this.stopping = true; // the goal is gone (in range, a skill is due): this step stops
      this.aimSwing(s, goal, p);
      return true;
    }
    if (gait.phase !== 'double' || !gait.bothPlanted()) {
      if (!gait.walking) this.shiftT = -1;
      return gait.walking;
    }
    // Double support: after a walking touchdown (or during the starting shift) decide the next step.
    if (gait.walking && this.stopping) {
      this.cancel(); // the stopping step is down: the COM comes to rest between the feet
      return false;
    }
    if (!goal && !gait.walking) {
      if (this.shiftT >= 0) this.cancel();
      return false;
    }
    if (gait.walking && gait.doubleTime < DS_S) {
      this.steerDouble(s, goal, p);
      return true;
    }
    // Moving with no goal left: one more step, landing either side of where the COM comes to rest.
    const aim = goal ?? { x: s.capture[0], y: s.capture[1], heading: this.facing() };
    const f = walkFrame(s, aim);
    const side = this.next ?? this.frontFoot(f);
    const stance = other(side);
    if (!gait.walking && !this.ready(s, f, side, p, dt)) return this.shiftT >= 0;
    const plan = this.plan(s, f, aim, side, p);
    if (!gait.walkStep(side, plan.landing, plan.swing, LIFT_M, plan.cop)) return false;
    this.shiftT = -1;
    this.stopping = plan.stop;
    this.end = plan.end;
    this.next = stance;
    return true;
  }

  private facing(): number {
    const l = this.gait.feet.l.place.yaw, r = this.gait.feet.r.place.yaw;
    return Math.atan2(Math.sin(l) + Math.sin(r), Math.cos(l) + Math.cos(r));
  }

  /** From standing, the foot ahead along the walk steps first: ξ already lies ahead of the other. */
  private frontFoot(f: WalkFrame): Side {
    const along = (side: Side) => {
      const q = this.gait.feet[side].place;
      return (q.x - f.ox) * f.ux + (q.y - f.oy) * f.uy;
    };
    return along('l') >= along('r') ? 'l' : 'r';
  }

  /**
   * The first step needs ξ just inside the stance foot across the walk (so the swing out to the
   * side and the landing catch it); a weight shift in double support puts it there. True once it is.
   */
  private ready(s: Sense, f: WalkFrame, side: Side, p: WalkParams, dt: number): boolean {
    const stance = other(side);
    const st = this.gait.feet[stance].place;
    const E = Math.exp(s.omega0 * this.steadySwing(p));
    const { d } = offsets(s.omega0, p, E);
    const sg = sideSign(side);
    // Across the walk: stance sole + (2w − d)/E toward the swing side.
    const want = ((st.x - f.ox) * f.nx + (st.y - f.oy) * f.ny) + sg * (2 * p.halfWidth - d) / E;
    const now = (s.capture[0] - f.ox) * f.nx + (s.capture[1] - f.oy) * f.ny;
    if (Math.abs(now - want) < SHIFT_TOL_M) return true;
    if (this.shiftT < 0) this.shiftT = 0;
    this.shiftT += dt;
    if (this.shiftT > SHIFT_MAX_S) {
      this.cancel();
      return false;
    }
    const along = (s.capture[0] - f.ox) * f.ux + (s.capture[1] - f.oy) * f.uy;
    this.gait.launch([f.ox + f.ux * along + f.nx * want, f.oy + f.uy * along + f.ny * want], SHIFT_GAIN);
    return false;
  }

  /**
   * Double support between walking steps: the pressure can go anywhere under both soles, so it
   * moves to leave ξ where the next step needs it: just inside the sole just landed on (across the
   * walk the pendulum is very sensitive: an error at lift-off grows e^{ωT}-fold) and b ahead of its
   * ball (a landing that overshot, or a walk slowing down, is pushed on from the rear foot).
   */
  private steerDouble(s: Sense, goal: StanceFrame | null, p: WalkParams): void {
    const gait = this.gait;
    const side = this.next;
    if (!side) return;
    const stance = other(side);
    const st = gait.feet[stance].place;
    const f = walkFrame(s, goal ?? { x: s.capture[0] + Math.cos(st.yaw), y: s.capture[1] + Math.sin(st.yaw), heading: st.yaw });
    const N = (q: P2) => (q[0] - f.ox) * f.nx + (q[1] - f.oy) * f.ny;
    const A = (q: P2) => (q[0] - f.ox) * f.ux + (q[1] - f.oy) * f.uy;
    const E = Math.exp(s.omega0 * this.steadySwing(p));
    const { b, d } = offsets(s.omega0, p, E);
    const ball = gait.soleCop(stance, COP_FWD);
    const wantN = N([st.x, st.y]) + sideSign(side) * (2 * p.halfWidth - d) / E;
    const wantA = A(ball) + b;
    const Eds = Math.exp(s.omega0 * Math.max(0.02, DS_S - gait.doubleTime));
    const xi: P2 = [s.capture[0], s.capture[1]];
    const copN = (wantN - N(xi) * Eds) / (1 - Eds);
    const copA = (wantA - A(xi) * Eds) / (1 - Eds);
    this.steerTo([f.ox + f.ux * copA + f.nx * copN, f.oy + f.uy * copA + f.ny * copN], gait.supportPolygon(COP_MARGIN_M), p);
  }

  /**
   * Put the pressure point at `want`: on the soles as far as they reach, the rest (up to what it
   * has left) from the gyro core as a torque on the torso.
   */
  private steerTo(want: P2, support: P2[], p: WalkParams): void {
    const cop = clampToPolygon(support, want);
    const extra = clampLen([want[0] - cop[0], want[1] - cop[1]], p.assistM);
    this.assist[0] = extra[0];
    this.assist[1] = extra[1];
    this.gait.steer(cop);
  }

  /** Swing time for a foot travelling `m` metres. */
  private swingTime(m: number): number {
    return clamp(SWING_BASE_S + SWING_PER_M * m, SWING_MIN_S, SWING_MAX_S);
  }

  /** Where `side` lands, its swing time, and the stance pressure point for the step. */
  /** Swing time of a steady stride at this speed: the foot travels two strides (it passes the stance foot). */
  private steadySwing(p: WalkParams): number {
    return this.swingTime(p.speed);
  }

  /**
   * The step's plan: a nominal landing (one stride on from the stance sole, a regular width out;
   * a short last one near the goal), the capture point it should end on (b short of it and d
   * inside it; for the last step, midway between the feet), and the stance pressure point that
   * gets it there: p = (ξ_T − ξ₀·e^{ωT}) / (1 − e^{ωT}), kept on the sole. Through the swing the
   * pressure point keeps chasing that end point (aimSwing); only what the sole cannot deliver
   * moves the landing.
   */
  private plan(s: Sense, f: WalkFrame, goal: StanceFrame, side: Side, p: WalkParams): { landing: FootPlace; cop: P2; end: P2; swing: number; stop: boolean } {
    const gait = this.gait;
    const stance = other(side);
    const st = gait.feet[stance].place;
    const L = this.geo.legLength;
    const sg = sideSign(side);
    const swing = this.steadySwing(p);
    const E = Math.exp(s.omega0 * swing);
    const { b, d, stride } = offsets(s.omega0, p, E);
    const toGo = (goal.x - s.com[0]) * f.ux + (goal.y - s.com[1]) * f.uy;
    const stop = toGo < stride + WALK_STOP_M;
    const A = (q: P2) => (q[0] - f.ox) * f.ux + (q[1] - f.oy) * f.uy;
    const N = (q: P2) => (q[0] - f.ox) * f.nx + (q[1] - f.oy) * f.ny;
    const stA = A([st.x, st.y]), stN = N([st.x, st.y]);
    const reachA = stop ? clamp(toGo - 0.5 * WALK_STOP_M, 0.1 * L, stride) : stride;
    const la = stA + reachA, ln = stN + sg * 2 * p.halfWidth;
    const endA = stop ? stA + reachA / 2 : la + b;
    const endN = stop ? stN + sg * p.halfWidth : ln - sg * d;
    const end: P2 = [f.ox + f.ux * endA + f.nx * endN, f.oy + f.uy * endA + f.ny * endN];
    // The swing leg itself carries ξ along with it: take that out before planning the pendulum.
    const sw = gait.feet[side].place;
    const legA = this.legShare * LEG_COM_SHARE * (la - A([sw.x, sw.y]));
    const xi0: P2 = [s.capture[0] + f.ux * legA, s.capture[1] + f.uy * legA];
    const want = copLaw(end, xi0, E);
    const cop = clampToPolygon(footCorners(this.geo, stance, st, COP_MARGIN_M), want);
    const extra = clampLen([want[0] - cop[0], want[1] - cop[1]], p.assistM);
    const xi = predict([cop[0] + extra[0], cop[1] + extra[1]], xi0, E);
    const landing = this.landing(xi, st, f, side, stop, b, d);
    return { landing: this.constrain(side, stance, landing, f), cop, end, swing, stop };
  }

  /** Mid-swing: land where ξ will be at touchdown, less the walking offsets. */
  private aimSwing(s: Sense, goal: StanceFrame | null, p: WalkParams): void {
    const gait = this.gait;
    const side = gait.swingSide!;
    const sf = gait.feet[side];
    if (sf.t / sf.dur > RETARGET_UNTIL) return;
    const stance = other(side);
    const st = gait.feet[stance].place;
    const f = walkFrame(s, goal ?? { x: s.capture[0] + Math.cos(st.yaw), y: s.capture[1] + Math.sin(st.yaw), heading: st.yaw });
    const E = Math.exp(s.omega0 * Math.max(0.02, sf.dur - sf.t));
    const { b, d } = offsets(s.omega0, p, Math.exp(s.omega0 * this.steadySwing(p)));
    // The rest of the swing leg's travel still carries ξ along with it.
    const foot = s.feet[side].sole;
    const rest = this.legShare * LEG_COM_SHARE * ((sf.target.x - foot[0]) * f.ux + (sf.target.y - foot[1]) * f.uy);
    const xiNow: P2 = [s.capture[0] + f.ux * rest, s.capture[1] + f.uy * rest];
    // The stance pressure point keeps chasing the step's end point (until late in the swing,
    // when that would only slam it from edge to edge).
    if (sf.t / sf.dur < COP_UNTIL) this.steerTo(copLaw(this.end, xiNow, E), footCorners(this.geo, stance, st, COP_MARGIN_M), p);
    const xi = predict([gait.walkCop[0] + this.assist[0], gait.walkCop[1] + this.assist[1]], xiNow, E);
    const raw = this.landing(xi, st, f, side, this.stopping, b, d);
    const out = this.constrain(side, stance, raw, f);
    this.debug = { xi, raw, out, rest };
    gait.retargetSwing(out);
  }

  /** Landing for a capture point `xi` at touchdown: b short of it and d outside it, or (stopping)
   *  the feet either side of it. */
  private landing(xi: P2, st: FootPlace, f: WalkFrame, side: Side, stop: boolean, b: number, d: number): FootPlace {
    const sg = sideSign(side);
    const yaw = f.h - sg * TOE_OUT_RAD;
    if (stop) return { x: 2 * xi[0] - st.x, y: 2 * xi[1] - st.y, yaw };
    return { x: xi[0] - f.ux * b + f.nx * sg * d, y: xi[1] - f.uy * b + f.ny * sg * d, yaw };
  }

  /** Keep a landing within what the legs reach from the stance sole, and the feet apart. */
  private constrain(side: Side, stance: Side, t: FootPlace, f: WalkFrame): FootPlace {
    const st = this.gait.feet[stance].place;
    const L = this.geo.legLength;
    const sg = sideSign(side);
    const a = clamp((t.x - st.x) * f.ux + (t.y - st.y) * f.uy, -MAX_BACK * L, MAX_STRIDE * L);
    const l = clamp(((t.x - st.x) * f.nx + (t.y - st.y) * f.ny) * sg, MIN_WIDTH * L, MAX_WIDTH * L);
    const x = st.x + f.ux * a + f.nx * l * sg, y = st.y + f.uy * a + f.ny * l * sg;
    return this.gait.constrainTarget(side, { x, y, yaw: t.yaw }, (MAX_STRIDE + 0.1) * L);
  }
}

function walkFrame(s: Sense, goal: StanceFrame): WalkFrame {
  const dx = goal.x - s.com[0], dy = goal.y - s.com[1];
  const h = Math.hypot(dx, dy) > 0.05 ? Math.atan2(dy, dx) : goal.heading;
  const [ux, uy] = rot2(1, 0, h);
  return { ox: s.com[0], oy: s.com[1], h, ux, uy, nx: -uy, ny: ux };
}

/** The pressure point that brings ξ from `xi` to `end` over a growth factor E = e^{ωT}. */
function copLaw(end: P2, xi: P2, E: number): P2 {
  return [(end[0] - xi[0] * E) / (1 - E), (end[1] - xi[1] * E) / (1 - E)];
}

function clampLen(v: P2, max: number): P2 {
  const n = Math.hypot(v[0], v[1]);
  return n > max && n > 0 ? [(v[0] * max) / n, (v[1] * max) / n] : v;
}

/** ξ after a step with growth factor E = e^{ωT} over the pressure point `cop`. */
function predict(cop: P2, xi: P2, E: number): P2 {
  return [cop[0] + (xi[0] - cop[0]) * E, cop[1] + (xi[1] - cop[1]) * E];
}

/** Steady-walk capture point offsets at touchdown: b behind ξ, d outside it (E = e^{ωT}). */
function offsets(omega: number, p: WalkParams, E: number): { b: number; d: number; stride: number } {
  const T = Math.log(E) / omega;
  const stride = p.speed * (T + DS_S);
  return { b: stride / (E - 1), d: (2 * p.halfWidth) / (E + 1), stride };
}
