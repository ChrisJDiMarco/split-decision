// Referee break: give a downed fighter room to get up, like the referee's count in boxing and the
// robot leagues. Deterministic, no forces: the referee only writes orders that the tactics hook
// (src/physics/control/tactics.ts, top of TacticRunner.update) obeys over the intent.
//
//   start   the tick a fighter goes down (r.down, or its get-up / rise is running) after release
//   during  the standing fighter starts no blows, grapples, feints or reflexes; a blow still in its
//           windup is pulled (one already committed finishes: it cannot be un-thrown); he walks to a
//           neutral spot NEUTRAL_M from the downed fighter, facing him, guard up, never back in.
//           The spot is re-aimed every update from where the downed fighter is now, so a get-up
//           that rolls or crawls toward him sends him further back. Backing straight away would pin
//           him on the fence: the spot rotates around the downed fighter toward open floor (inside
//           ARENA_LIMIT_M) and he walks there around the arc. A fighter back up waits ('hold').
//   double  both down (or the standing one falls on his own): both just get up
//   end     FIGHT once every fighter is back up and steady (not down, not rising, torso upright and
//           balanced enough to strike, all for GRACE_S) AND the fighter at the neutral spot has got
//           there: as in boxing, the fight does not restart until the other man is in his neutral
//           corner. The stepping is slow (~0.1-0.2 m/s backing up), so this is what guarantees the
//           room. The referee stops waiting if he makes no progress for STALL_S, or after
//           MAX_WAIT_S; a KO ends the break silently.
// Runs before control at the control rate, so an order is in place by the next control update after the fall.
import type { RefereeEvent, RefereeTelemetry } from '../../core/protocol';
import { APOTHEM } from '../../core/arena-spec';
import type { Corner } from '../../core/types';
import type { HumanoidController } from '../control/controller';
import type { RefereeOrder, RefereeState, RobotRuntime, SimContext, SimSystem } from '../sim-context';

/**
 * Neutral distance, COM to COM: well outside every strike (the longest reach is ~1.0 m) and the
 * reflex range (1.35 m), and short enough that the slow backward walk gets there in a few seconds
 * ("a bit of space", not the far side of the cage).
 */
export const NEUTRAL_M = 2.2;
/** Back up and steady this long before FIGHT. */
export const GRACE_S = 1.0;
/** FIGHT once the fighter sent to the neutral spot is within this of its distance. */
export const ROOM_TOL_M = 0.15;
/** Everyone is up, but he has made no STALL_GAIN_M of room in this long: stop waiting for him. */
export const STALL_S = 3.0;
/** Everyone is up: never wait longer than this for room and steadiness. */
export const MAX_WAIT_S = 10.0;
const STALL_GAIN_M = 0.05;
const SETTLE_M = 0.05; // he stops walking this close to NEUTRAL_M (he walks again once short of the room, NEUTRAL_M - ROOM_TOL_M)
const ARENA_LIMIT_M = APOTHEM - 0.9; // the same fence margin as the tactics' stance goals
const UPRIGHT_MIN = 0.7; // torso up-axis z: standing, not stooped over the canvas
const ARC_STEP_RAD = 0.5; // walking around him, each waypoint leads by at most this angle
const ARRIVE_M = 0.25; // this close to the spot, the spot itself is the goal
const CARROT_M = 0.8; // until then the goal leads him by at least this much (full strides, not fine settling steps)
const SEARCH_STEP_RAD = Math.PI / 18;
const STRIDE = 2; // physics steps per referee update: the control rate (control/index.ts CONTROL_DECIMATION)

type P2 = [number, number];

/** A fresh referee state (no break). */
export function newRefereeState(): RefereeState {
  return {
    active: false, since: 0, down: [false, false], roles: [null, null], spots: [null, null], settled: [false, false], upSince: [0, 0], readySince: [0, 0],
    waitSince: -1, best: [0, 0], progressAt: [0, 0], orders: [null, null], log: [], sent: [0, 0],
  };
}

/** The referee state of a context (created on first use). */
export function refereeState(ctx: SimContext): RefereeState {
  return (ctx.referee ??= newRefereeState());
}

const controller = (r: RobotRuntime) => r.mem.control as HumanoidController | undefined;

/** On the canvas, in the scripted get-up, or still rising out of the crouch. */
export function isDown(r: RobotRuntime): boolean {
  const c = controller(r);
  return r.down || !!c?.getUp.active || !!c?.rising;
}

export function upright(ctx: SimContext, r: RobotRuntime): number {
  const torso = r.parts.get('torso') ?? r.parts.get('chassis');
  return ctx.data.xmat[(torso ? torso.body : r.rootBody) * 9 + 8];
}

/** Steady on his feet: balanced enough to throw (the controller's own readiness), so FIGHT never finds him mid-stumble. */
function steady(r: RobotRuntime): boolean {
  const c = controller(r);
  return !c || c.readyToStrike();
}

/**
 * Up and steady right now, the referee's test for FIGHT: off the canvas, done rising, torso upright
 * and balanced enough to strike. The KO count (damage/ko.ts) resets only after this has held.
 */
export function upAndSteady(ctx: SimContext, r: RobotRuntime): boolean {
  return !isDown(r) && upright(ctx, r) >= UPRIGHT_MIN && steady(r);
}

function comXY(ctx: SimContext, r: RobotRuntime): P2 {
  const c = ctx.data.subtree_com as Float64Array;
  return [c[r.rootBody * 3], c[r.rootBody * 3 + 1]];
}

const inside = (p: P2) => Math.hypot(p[0], p[1]) <= ARENA_LIMIT_M;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const at = (o: P2, r: number, a: number): P2 => [o[0] + r * Math.cos(a), o[1] + r * Math.sin(a)];
const gap = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * The neutral spot for a fighter at `me` while `o` is down: NEUTRAL_M from him (or where he already
 * is, if farther), on his current bearing if that is open floor, else rotated around the downed
 * fighter by the smallest angle that is (toward the centre when both ways work).
 */
export function neutralSpot(me: P2, o: P2): P2 {
  const d = gap(me, o);
  const a0 = d > 1e-3 ? Math.atan2(me[1] - o[1], me[0] - o[0]) : Math.atan2(-o[1], -o[0]);
  for (const r of d > NEUTRAL_M ? [d, NEUTRAL_M] : [NEUTRAL_M]) {
    for (let k = 0; k * SEARCH_STEP_RAD <= Math.PI; k++) {
      const open = [at(o, r, a0 + k * SEARCH_STEP_RAD), at(o, r, a0 - k * SEARCH_STEP_RAD)].filter(inside);
      if (open.length) return open.reduce((a, b) => (Math.hypot(b[0], b[1]) < Math.hypot(a[0], a[1]) ? b : a));
    }
  }
  // Unreachable in this cage (it is wide enough for a spot on any side); the centre side of him.
  const toCentre = Math.atan2(-o[1], -o[0]);
  const p = at(o, NEUTRAL_M, toCentre);
  const rr = Math.hypot(p[0], p[1]);
  return rr > ARENA_LIMIT_M ? [(p[0] * ARENA_LIMIT_M) / rr, (p[1] * ARENA_LIMIT_M) / rr] : p;
}

/** Next stance goal from `me` toward `spot`, keeping the spot's distance from `o` (around the arc, never through him). */
export function neutralGoal(me: P2, o: P2, spot: P2): { x: number; y: number; heading: number } {
  let p = spot;
  if (gap(me, spot) > ARRIVE_M) {
    const r = gap(spot, o);
    const aMe = Math.atan2(me[1] - o[1], me[0] - o[0]);
    const da = wrap(Math.atan2(spot[1] - o[1], spot[0] - o[0]) - aMe);
    p = at(o, r, aMe + Math.max(-ARC_STEP_RAD, Math.min(ARC_STEP_RAD, da)));
    // A goal this close would get fine settling steps; lead it out so the stepping takes full strides.
    const lead = gap(p, me);
    if (lead > 1e-6 && lead < CARROT_M) p = [me[0] + ((p[0] - me[0]) * CARROT_M) / lead, me[1] + ((p[1] - me[1]) * CARROT_M) / lead];
    const rr = Math.hypot(p[0], p[1]);
    if (rr > ARENA_LIMIT_M) p = [(p[0] * ARENA_LIMIT_M) / rr, (p[1] * ARENA_LIMIT_M) / rr];
  }
  return { x: p[0], y: p[1], heading: Math.atan2(o[1] - p[1], o[0] - p[0]) };
}

function end(st: RefereeState): void {
  st.active = false;
  st.down = [false, false];
  st.roles = [null, null];
  st.spots = [null, null];
  st.settled = [false, false];
  st.orders = [null, null];
  st.waitSince = -1;
}

/**
 * The order for corner `c`: to the neutral spot (re-aimed from where the other fighter is now), else
 * hold. At his neutral distance he stops and stands (settled): no fine steps chasing a spot that
 * sways with the other body; he walks again once he is short of the room (a get-up that crawls at him).
 */
function order(ctx: SimContext, st: RefereeState, c: number): RefereeOrder {
  if (st.roles[c] !== 'neutral') {
    st.spots[c] = null;
    st.settled[c] = false;
    return { goal: null };
  }
  const me = comXY(ctx, ctx.robots[c]);
  const him = comXY(ctx, ctx.robots[1 - c]);
  const d = gap(me, him);
  if (d >= NEUTRAL_M - SETTLE_M) st.settled[c] = true;
  else if (d < NEUTRAL_M - ROOM_TOL_M) st.settled[c] = false;
  if (st.settled[c]) {
    st.spots[c] = me;
    return { goal: null };
  }
  const spot = (st.spots[c] = neutralSpot(me, him));
  return { goal: neutralGoal(me, him, spot) };
}

/** Corner `c` (role 'neutral') is at his neutral distance. */
function hasRoom(ctx: SimContext, c: number): boolean {
  return gap(comXY(ctx, ctx.robots[c]), comXY(ctx, ctx.robots[1 - c])) >= NEUTRAL_M - ROOM_TOL_M;
}

/** Why the break can end now, if it can: everyone up and steady with room; or the referee gives up waiting. */
function fightReason(ctx: SimContext, st: RefereeState): 'room' | 'stalled' | 'timeout' | null {
  const robots = ctx.robots;
  if (!robots.every((_, c) => ctx.time - st.upSince[c] >= GRACE_S)) {
    st.waitSince = -1;
    return null;
  }
  const neutral = robots.flatMap((_, c) => (st.roles[c] === 'neutral' ? [c] : []));
  if (st.waitSince < 0) {
    st.waitSince = ctx.time;
    for (const c of neutral) {
      st.best[c] = gap(comXY(ctx, robots[c]), comXY(ctx, robots[1 - c]));
      st.progressAt[c] = ctx.time;
    }
  }
  for (const c of neutral) {
    const d = gap(comXY(ctx, robots[c]), comXY(ctx, robots[1 - c]));
    if (d >= st.best[c] + STALL_GAIN_M) {
      st.best[c] = d;
      st.progressAt[c] = ctx.time;
    }
  }
  const ready = robots.every((_, c) => ctx.time - st.readySince[c] >= GRACE_S);
  if (ready && neutral.every((c) => hasRoom(ctx, c))) return 'room';
  if (ready && neutral.some((c) => ctx.time - st.progressAt[c] >= STALL_S)) return 'stalled';
  return ctx.time - st.waitSince >= MAX_WAIT_S ? 'timeout' : null;
}

export const refereeSystem: SimSystem = {
  name: 'referee',
  init(ctx) {
    ctx.referee = newRefereeState();
  },
  pre(ctx) {
    const st = refereeState(ctx);
    if (!ctx.released || ctx.tick % STRIDE !== 0) return;
    const robots = ctx.robots;
    if (robots.some((r) => r.koReason)) {
      if (st.active) end(st);
      return;
    }
    const downNow = robots.map(isDown);
    const up = robots.map((r, c) => !downNow[c] && upright(ctx, r) >= UPRIGHT_MIN);
    for (let c = 0; c < robots.length; c++) if (!up[c]) st.upSince[c] = ctx.time;
    if (!st.active) {
      if (!downNow.some(Boolean)) return;
      st.readySince = robots.map(() => ctx.time); // steadiness is judged from the start of the break
      st.active = true;
      st.since = ctx.time;
      st.down = [...downNow];
      st.waitSince = -1;
      emit(ctx, st, { kind: 'break', down: corners(downNow) });
    } else {
      const fresh = downNow.some((d, c) => d && !st.down[c]);
      if (fresh) {
        st.down = st.down.map((d, c) => d || downNow[c]);
        emit(ctx, st, { kind: 'break', down: corners(st.down) });
      }
    }
    for (let c = 0; c < robots.length; c++) if (!up[c] || !steady(robots[c])) st.readySince[c] = ctx.time;
    // Roles: down; neutral while the other is down (and he keeps it until FIGHT); hold once back up.
    for (let c = 0; c < robots.length; c++) {
      if (downNow[c]) st.roles[c] = 'down';
      else if (downNow[1 - c] || st.roles[c] === 'neutral') st.roles[c] = 'neutral';
      else st.roles[c] = 'hold';
    }
    for (let c = 0; c < robots.length; c++) st.orders[c] = order(ctx, st, c);
    const reason = fightReason(ctx, st);
    if (reason) {
      emit(ctx, st, { kind: 'fight', breakS: ctx.time - st.since, reason });
      end(st);
    }
  },
  telemetry(ctx, robot, out) {
    const st = ctx.referee;
    if (!st) return;
    const c = robot.corner;
    const ref: RefereeTelemetry = { break: st.active };
    if (st.active) {
      ref.breakS = ctx.time - st.since;
      const role = st.roles[c];
      if (role) ref.role = role;
      const spot = st.spots[c];
      if (role === 'neutral' && spot) ref.neutral = [spot[0], spot[1], 0];
    }
    // The events since this corner's last telemetry (each corner keeps its own cursor into the log).
    if (st.sent[c] < st.log.length) {
      ref.events = st.log.slice(st.sent[c]);
      st.sent[c] = st.log.length;
    }
    out.referee = ref;
  },
};

/**
 * Logs a break / fight event. It goes out once in this frame's SimEvent list (ctx.events) and in the
 * next telemetry of each corner (RefereeTelemetry.events); a consumer reads one or the other.
 */
function emit(ctx: SimContext, st: RefereeState, e: RefereeEvent): void {
  st.log.push({ ...e, seq: st.log.length, time: ctx.time });
  ctx.events.push({ ...e });
}

function corners(flags: boolean[]): Corner[] {
  return flags.flatMap((f, c) => (f ? [c as Corner] : []));
}
