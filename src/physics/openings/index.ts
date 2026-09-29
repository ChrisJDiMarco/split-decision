// Openings system (post-step, after damage): watches for hard strikes landing (the 'stunned'
// memory) and, at telemetry time, publishes for each fighter
//   openings      what it sees on its opponent right now (detect.ts)
//   moveRisk      its own fall/failure risk for each flashy move (risk.ts)
//   stance        orthodox / southpaw from the lead foot
//   facingOffDeg  how far its shoulders are off square to the opponent
// Snapshots are read once per telemetry frame (~60 Hz), never per physics step.
import type { SimEvent } from '../../core/protocol';
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';
import { detectOpenings, facingOffDeg, isStunningHit, stanceOf } from './detect';
import { moveRisks } from './risk';
import { snapshot, type BodySnapshot } from './snapshot';

export { detectOpenings, facingOffDeg, fenceGap, isStunningHit, stanceOf, STUN_PARTS } from './detect';
export { moveRisks, riskOf, MOVE_PROFILES } from './risk';
export { snapshot, type BodySnapshot } from './snapshot';

interface OpeningsState {
  stunnedAt: [number, number]; // per corner: sim time of the last hard strike it took
  events: SimEvent[] | null; // the events array last scanned (the worker swaps it every frame)
  seen: number;
  last: SimEvent | null; // the last event scanned (headless tools clear the array in place)
  snap: { tick: number; bodies: [BodySnapshot, BodySnapshot] } | null;
}

const states = new WeakMap<SimContext, OpeningsState>();

function stateOf(ctx: SimContext): OpeningsState {
  let st = states.get(ctx);
  if (!st) {
    st = { stunnedAt: [-Infinity, -Infinity], events: null, seen: 0, last: null, snap: null };
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

/** Both bodies, read once per tick and shared by the two telemetry calls. */
function bodies(ctx: SimContext, st: OpeningsState): [BodySnapshot, BodySnapshot] {
  if (st.snap?.tick !== ctx.tick) st.snap = { tick: ctx.tick, bodies: [snapshot(ctx, ctx.robots[0]), snapshot(ctx, ctx.robots[1])] };
  return st.snap.bodies;
}

export const openingsSystem: SimSystem = {
  name: 'openings',
  init(ctx) {
    states.set(ctx, { stunnedAt: [-Infinity, -Infinity], events: null, seen: 0, last: null, snap: null });
  },
  post(ctx) {
    scanEvents(ctx, stateOf(ctx));
  },
  telemetry(ctx, robot: RobotRuntime, out) {
    const st = stateOf(ctx);
    scanEvents(ctx, st);
    const pair = bodies(ctx, st);
    const me = pair[robot.corner];
    const opp = pair[robot.corner === 0 ? 1 : 0];
    out.openings = detectOpenings(me, opp, st.stunnedAt[opp.corner]);
    out.moveRisk = moveRisks(me);
    out.stance = stanceOf(me, opp);
    out.facingOffDeg = Math.round(facingOffDeg(me, opp) * 10) / 10;
  },
};
