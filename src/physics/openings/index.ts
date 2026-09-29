// Openings system (post-step, after damage): watches for hard strikes landing (the 'stunned'
// memory) and, at telemetry time, publishes for each fighter
//   openings      what it sees on its opponent right now (detect.ts)
//   moveRisk      its own fall/failure risk for each flashy move (risk.ts); the gait-phase inputs
//                 (balance margin, gyro load) are read only with both feet planted and smoothed over
//                 ~0.4 s, and each value moves only past a 0.05 deadband, so the bands do not swing
//                 with every step; a real stumble, joints, battery and a knockdown count at once
//   stance        orthodox / southpaw from the lead foot, read feet planted and held >= 0.4 s
//   facingOffDeg  how far its shoulders are off square to the opponent
// Snapshots are read once per telemetry frame (~60 Hz), never per physics step.
import type { Opening, SimEvent } from '../../core/protocol';
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';
import { detectOpenings, facingOffDeg, heldStance, isStunningHit, newStanceMemory, offBalance, type StanceMemory } from './detect';
import { moveRisks } from './risk';
import { snapshot, type BodySnapshot } from './snapshot';

export { detectOpenings, facingOffDeg, fenceGap, heldStance, isStunningHit, newStanceMemory, stanceOf, STUN_PARTS, STANCE_HOLD_S, type StanceMemory } from './detect';
export { moveRisks, riskOf, MOVE_PROFILES } from './risk';
export { snapshot, type BodySnapshot } from './snapshot';

interface OpeningsState {
  stunnedAt: [number, number]; // per corner: sim time of the last hard strike it took
  events: SimEvent[] | null; // the events array last scanned (the worker swaps it every frame)
  seen: number;
  last: SimEvent | null; // the last event scanned (headless tools clear the array in place)
  snap: { tick: number; bodies: [BodySnapshot, BodySnapshot] } | null;
  stance: [StanceMemory, StanceMemory];
  held: [HeldInputs, HeldInputs]; // per corner: gait-phase risk inputs, from planted reads only
  risk: [Record<string, number> | null, Record<string, number> | null]; // per corner: last published moveRisk
  sees: { tick: number; openings: [Opening[], Opening[]] } | null; // per corner, what it sees this tick
}

/** Time constants of the planted-read smoothing: getting shakier shows fast, settling back slowly. */
export const RISK_HOLD_TAU_S = 0.4;
export const RISK_WORSEN_TAU_S = 0.2;
/** Off the planted read, a margin this low is a stumble (a normal step dips to ~0.2; a catch step after a shove, to ~0), read live. */
export const STUMBLE_MARGIN = 0.08;

interface HeldInputs { balance: number; saturation: number; at: number | null }

function newHeld(): HeldInputs {
  return { balance: 1, saturation: 0, at: null };
}

/**
 * The snapshot moveRisk reads: balance margin and gyro saturation from planted reads only (an
 * exponential average: RISK_WORSEN_TAU_S getting worse, RISK_HOLD_TAU_S recovering), everything else
 * live. A stumble off the planted read (offBalance, or a margin under STUMBLE_MARGIN: shoved, a catch
 * step) raises the held risk at once; planted reads then settle it back. Mutates `held`.
 */
export function riskInputs(held: HeldInputs, me: BodySnapshot): BodySnapshot {
  const sat = me.gyro?.saturation ?? 0;
  if (me.planted) {
    const dt = held.at === null ? Infinity : Math.max(0, me.time - held.at);
    const k = (worse: boolean) => 1 - Math.exp(-dt / (worse ? RISK_WORSEN_TAU_S : RISK_HOLD_TAU_S));
    held.balance += k(me.balance < held.balance) * (me.balance - held.balance);
    held.saturation += k(sat > held.saturation) * (sat - held.saturation);
    held.at = me.time;
  } else if (!me.down && (offBalance(me) || me.balance < STUMBLE_MARGIN)) {
    // A stumble counts at once, and is only forgotten over the next planted reads.
    held.balance = Math.min(held.balance, me.balance);
    held.saturation = Math.max(held.saturation, sat);
  }
  return { ...me, balance: held.balance, gyro: me.gyro ? { ...me.gyro, saturation: held.saturation } : null };
}

/** A published risk only moves once the new value is this far off it (or it becomes / stops being 1). */
export const RISK_DEADBAND = 0.05;

/** Deadband on each move's published risk, so a value hovering at a band edge does not flicker. */
export function settleRisk(prev: Record<string, number> | null, next: Record<string, number>): Record<string, number> {
  if (!prev) return next;
  const out: Record<string, number> = {};
  for (const [m, r] of Object.entries(next)) {
    const p = prev[m];
    out[m] = p === undefined || Math.abs(r - p) >= RISK_DEADBAND || (r >= 1) !== (p >= 1) ? r : p;
  }
  return out;
}

function freshState(): OpeningsState {
  return {
    stunnedAt: [-Infinity, -Infinity], events: null, seen: 0, last: null, snap: null,
    stance: [newStanceMemory(), newStanceMemory()], held: [newHeld(), newHeld()], risk: [null, null], sees: null,
  };
}

const states = new WeakMap<SimContext, OpeningsState>();

function stateOf(ctx: SimContext): OpeningsState {
  let st = states.get(ctx);
  if (!st) {
    st = freshState();
    states.set(ctx, st);
  }
  return st;
}

/** Sim time `corner` last took a strike above the stun energy (-Infinity if never). */
export function lastStunnedAt(ctx: SimContext, corner: 0 | 1): number {
  return stateOf(ctx).stunnedAt[corner];
}

function scanEvents(ctx: SimContext, st: OpeningsState): void {
  // A new array (the worker's swap) or the same one cleared in place (headless tools): all of it is new.
  if (st.events !== ctx.events || (st.seen > 0 && ctx.events[st.seen - 1] !== st.last)) {
    st.events = ctx.events;
    st.seen = 0;
  }
  const ev = ctx.events;
  for (let i = st.seen; i < ev.length; i++) {
    const e = ev[i];
    if (e.kind !== 'impact' || e.victim === null || e.striker === null || e.striker === e.victim) continue;
    const mass = ctx.model.body_subtreemass[ctx.robots[e.victim].rootBody] as number;
    if (isStunningHit(e, mass)) st.stunnedAt[e.victim] = ctx.time;
  }
  st.seen = ev.length;
  st.last = ev.length ? ev[ev.length - 1] : null;
}

/** Both bodies, read once per tick and shared by the two telemetry calls (and openingsNow). */
function bodies(ctx: SimContext, st: OpeningsState): [BodySnapshot, BodySnapshot] {
  if (st.snap?.tick !== ctx.tick) st.snap = { tick: ctx.tick, bodies: [snapshot(ctx, ctx.robots[0]), snapshot(ctx, ctx.robots[1])] };
  return st.snap.bodies;
}

/**
 * What `corner` sees on its opponent this tick, computed once per tick and cached. The control
 * layer polls this to fire Intent.onOpening reflexes between telemetry frames.
 */
export function openingsNow(ctx: SimContext, corner: 0 | 1): readonly Opening[] {
  const st = stateOf(ctx);
  if (st.sees?.tick !== ctx.tick) {
    scanEvents(ctx, st);
    const [a, b] = bodies(ctx, st);
    st.sees = { tick: ctx.tick, openings: [detectOpenings(a, b, st.stunnedAt[1]), detectOpenings(b, a, st.stunnedAt[0])] };
  }
  return st.sees.openings[corner];
}

export const openingsSystem: SimSystem = {
  name: 'openings',
  init(ctx) {
    states.set(ctx, freshState());
  },
  post(ctx) {
    scanEvents(ctx, stateOf(ctx));
  },
  telemetry(ctx, robot: RobotRuntime, out) {
    const st = stateOf(ctx);
    const c = robot.corner;
    const pair = bodies(ctx, st);
    const me = pair[c];
    const opp = pair[c === 0 ? 1 : 0];
    out.openings = [...openingsNow(ctx, c)];
    st.risk[c] = settleRisk(st.risk[c], moveRisks(riskInputs(st.held[c], me)));
    out.moveRisk = { ...st.risk[c] };
    out.stance = heldStance(st.stance[c], me, opp);
    out.facingOffDeg = Math.round(facingOffDeg(me, opp) * 10) / 10;
  },
};
