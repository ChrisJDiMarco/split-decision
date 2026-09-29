// Player-mode measurements in headless physics (npx tsx tests/player/measure-latency.ts):
//   1. which footwork tactic moves the fighter to its own left / right (the WASD mapping)
//   2. press → strike start in physics, with the player delay and with Jev's 0.3 s
//   3. press → footwork motion (COM velocity along the request > 0.15 m/s)
// The worker applies an intent at issuedAtTick + delay, and the main thread stamps issuedAtTick
// with the last frame it saw, on average half a 60 Hz frame old: emulated as STALE_TICKS.
import type { Intent, Tactic } from '../../src/core/protocol';
import type { RobotRuntime, SimContext } from '../../src/physics/sim-context';
import { PLAYER_REACTION_DELAY_S } from '../../src/player/config';
import { controllerOf } from '../../src/physics/control';
import { comPos, makeSim, type Sim } from '../control/helpers';

const ME = process.argv[2] ?? 'savate';
const OPP = process.argv[3] ?? 'haymaker';
const STALE_TICKS = 8;
const STRIKES: Tactic[] = ['jab', 'cross', 'hook', 'uppercut', 'overhand', 'front_kick', 'low_kick', 'head_kick'];
const IDLE_SKILLS = new Set(['stance', 'step', 'guard', 'clinch', '']);

const intent = (tactic: Tactic, aggression = 1): Intent => ({ tactic, target: tactic === 'low_kick' ? 'left_leg' : 'head', aggression, confidence: 1, source: 'player' });

function press(ctx: SimContext, r: RobotRuntime, i: Intent, delayS: number): void {
  const issued = Math.max(0, ctx.tick - STALE_TICKS);
  r.pendingIntents.push({ applyAtTick: Math.max(ctx.tick, issued + Math.round(delayS / ctx.dt)), intent: i });
}

/** Both released and standing still (no intent: the controller holds its stance), `gap` m apart. */
async function fresh(gap = 1.3): Promise<Sim> {
  const sim = await makeSim({ design: ME, x: 0, y: 0, yaw: 0 }, { design: OPP, x: gap, y: 0, yaw: Math.PI });
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  sim.seconds(0.6);
  return sim;
}

/** Each strike's reach [lo, hi] for ME (COM distance), read from its controller. */
async function reaches(): Promise<Map<Tactic, [number, number]>> {
  const sim = await fresh();
  const c = controllerOf(sim.ctx.robots[0]) as unknown as { skillFor(id: string): { range(g: unknown): [number, number] } | null; geo: unknown };
  const out = new Map<Tactic, [number, number]>();
  for (const t of STRIKES) {
    const r = c.skillFor(t)?.range(c.geo);
    if (r) out.set(t, r);
  }
  sim.dispose();
  return out;
}

const flat = (ctx: SimContext, r: RobotRuntime): [number, number] => {
  const c = comPos(ctx, r);
  return [c[0], c[1]];
};

async function circleCheck(tactic: Tactic): Promise<number> {
  const sim = await fresh();
  const { ctx } = sim;
  const [me, opp] = ctx.robots;
  const m0 = flat(ctx, me);
  const o0 = flat(ctx, opp);
  const fx = o0[0] - m0[0], fy = o0[1] - m0[1];
  const n = Math.hypot(fx, fy) || 1;
  const right: [number, number] = [fy / n, -fx / n]; // facing × z
  me.intent = intent(tactic, 0.85);
  sim.seconds(2.5);
  const m1 = flat(ctx, me);
  const lateral = (m1[0] - m0[0]) * right[0] + (m1[1] - m0[1]) * right[1];
  sim.dispose();
  return lateral;
}

interface Latency { tactic: Tactic; delayS: number; gap: number; startMs: number | null; skill: string }

async function strikeLatency(tactic: Tactic, delayS: number, gap: number): Promise<Latency> {
  const sim = await fresh(gap);
  const { ctx } = sim;
  const me = ctx.robots[0];
  const t0 = ctx.time;
  press(ctx, me, intent(tactic), delayS);
  let startMs: number | null = null;
  const steps = Math.round(2 / ctx.dt);
  for (let i = 0; i < steps && startMs === null; i++) {
    sim.step();
    if (!IDLE_SKILLS.has(me.skill)) startMs = (ctx.time - t0) * 1000;
  }
  const out = { tactic, delayS, gap, startMs, skill: me.skill };
  sim.dispose();
  return out;
}

async function moveLatency(tactic: Tactic, sign: 1 | -1, delayS: number): Promise<number | null> {
  const sim = await fresh();
  const { ctx } = sim;
  const [me, opp] = ctx.robots;
  const m0 = flat(ctx, me);
  const o0 = flat(ctx, opp);
  const n = Math.hypot(o0[0] - m0[0], o0[1] - m0[1]) || 1;
  const dir: [number, number] = [((o0[0] - m0[0]) / n) * sign, ((o0[1] - m0[1]) / n) * sign];
  const t0 = ctx.time;
  press(ctx, me, intent(tactic, 0.85), delayS);
  let prev = m0;
  let out: number | null = null;
  const every = 10; // velocity over 10 ms windows
  for (let i = 0; i < 2000 && out === null; i++) {
    sim.step();
    if (i % every !== 0) continue;
    const p = flat(ctx, me);
    const v = ((p[0] - prev[0]) * dir[0] + (p[1] - prev[1]) * dir[1]) / (every * ctx.dt);
    prev = p;
    if (v > 0.15) out = (ctx.time - t0) * 1000;
  }
  sim.dispose();
  return out;
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

async function main() {
  console.log(`# player latency: ${ME} vs ${OPP} (stale issuedAtTick ${STALE_TICKS} ticks)`);
  for (const t of ['circle_left', 'circle_right'] as Tactic[]) {
    const lat = await circleCheck(t);
    console.log(`${t}: lateral ${lat.toFixed(2)} m toward the fighter's own ${lat > 0 ? 'RIGHT' : 'LEFT'}`);
  }
  const reach = await reaches();
  for (const delay of [PLAYER_REACTION_DELAY_S, 0.3]) {
    for (const where of ['in range', 'from 1.3 m'] as const) {
      const rows: Latency[] = [];
      for (const t of STRIKES) {
        const r = reach.get(t);
        if (!r) continue; // this design has no such strike
        rows.push(await strikeLatency(t, delay, where === 'in range' ? r[0] + 0.55 * (r[1] - r[0]) : 1.3));
      }
      for (const r of rows) console.log(`delay ${r.delayS}s ${where.padEnd(10)} ${r.tactic.padEnd(10)} gap ${r.gap.toFixed(2)} start ${r.startMs === null ? 'never (2 s)' : `${r.startMs.toFixed(0)} ms`} (${r.skill})`);
      const ok = rows.map((r) => r.startMs).filter((x): x is number => x !== null);
      console.log(`== delay ${delay}s ${where}: strike start p50 ${pct(ok, 0.5).toFixed(0)} ms  p90 ${pct(ok, 0.9).toFixed(0)} ms  (${ok.length}/${rows.length} started in 2 s)`);
    }
    const fwd = await moveLatency('close_distance', 1, delay);
    const back = await moveLatency('retreat', -1, delay);
    console.log(`delay ${delay}s  move start: close_distance ${fwd?.toFixed(0) ?? 'never'} ms, retreat ${back?.toFixed(0) ?? 'never'} ms`);
  }
}

await main();
