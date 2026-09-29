// Headless fight with two brains on the real physics (House Mind: no Jev calls), measuring fighter
// IQ in play: feint reads and bites, habits formed, setup → payoff plans started and how they went,
// the weak spots at the end. Not a test: run it by hand.
// usage: npx tsx tests/brain/measure-iq.ts [red] [blue] [seconds] [seed]
import loadMujoco from '@mujoco/mujoco';
import { Brain } from '../../src/brain/brain';
import { JevLink } from '../../src/brain/link';
import type { Intent } from '../../src/core/protocol';
import type { Corner, MatchSetup } from '../../src/core/types';
import { buildContext } from '../../src/physics/runtime';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { compileWorld } from '../../src/physics/world';

const [red = 'savate', blue = 'pylon', secondsArg = '60', seedArg = '3'] = process.argv.slice(2);
const SECONDS = Number(secondsArg);
const FRAME_S = 1 / 60;
const REACTION_S = 0.12;
const setup: MatchSetup = {
  fighters: [
    { design: red, skin: 'factory', plan: 'Set him up, then hit what opens.', temperament: 1.2 },
    { design: blue, skin: 'neon', plan: 'Set him up, then hit what opens.', temperament: 1.2 },
  ],
  seed: Number(seedArg), timestep: 0.001, reactionDelayS: REACTION_S,
};
const mj = await loadMujoco();
const world = compileWorld(setup);
const ctx = buildContext(mj, world, setup);
for (const s of SYSTEMS) s.init?.(ctx);
const link = new JevLink({ ask: () => Promise.reject(new Error('offline: House Mind')), retryMs: 1e9 });
const meta = { nbody: 0, timestep: 0.001, robots: [0, 1].map((c) => ({ corner: c as Corner, design: setup.fighters[c].design, prefix: '', parts: [] })), props: [] };
const plans = { started: 0, setups: 0, payoffs: 0, kinds: new Map<string, number>() };
const brains = ([0, 1] as Corner[]).map((corner) => new Brain({
  corner, meta, seed: setup.seed, link, fighter: setup.fighters[corner],
  onIntent: (c: Corner, intent: Intent) => {
    ctx.robots[c].pendingIntents.push({ applyAtTick: ctx.tick + Math.round(REACTION_S / ctx.dt), intent });
    if (intent.tactic === 'combo') plans.started++;
    if (intent.tactic === 'combo' && intent.comboPlan) { plans.setups++; const k = intent.combo!.join('>'); plans.kinds.set(k, (plans.kinds.get(k) ?? 0) + 1); }
    if (intent.comboPlan?.step !== undefined && intent.comboPlan.step === intent.comboPlan.setup) plans.payoffs++;
  },
}));
const step = () => { for (const s of SYSTEMS) s.pre?.(ctx); mj.mj_step(ctx.model, ctx.data); ctx.tick++; ctx.time += ctx.dt; for (const s of SYSTEMS) s.post?.(ctx); };
for (let i = 0; i < 300; i++) step();
for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
ctx.released = true;
for (const b of brains) b.start();
const perFrame = Math.round(FRAME_S / ctx.dt);
const t0 = performance.now();
let reads = 0;
const lastSeq = [0, 0];
for (let f = 0; f < SECONDS / FRAME_S; f++) {
  for (let i = 0; i < perFrame; i++) step();
  const events = ctx.events.splice(0);
  const telemetry = [buildTelemetry(ctx, ctx.robots[0], SYSTEMS), buildTelemetry(ctx, ctx.robots[1], SYSTEMS)] as [ReturnType<typeof buildTelemetry>, ReturnType<typeof buildTelemetry>];
  for (const c of [0, 1]) for (const r of telemetry[c].reads ?? []) if (r.seq > lastSeq[c]) { lastSeq[c] = r.seq; reads++; console.log(`t=${ctx.time.toFixed(1)} ${c ? 'blue' : 'red'} feint ${r.level}/${r.skill}${r.deliberate ? '' : ' (pulled)'}: ${r.bit ? `BIT ${r.reactions.join('+')}` : 'no bite'}`); }
  for (const b of brains) b.onFrame({ tick: ctx.tick, time: ctx.time, events, telemetry });
  await Promise.resolve();
}
const wall = (performance.now() - t0) / 1000;
for (const c of [0, 1] as const) {
  const t = buildTelemetry(ctx, ctx.robots[c], SYSTEMS);
  console.log(`${c ? 'blue' : 'red'} (${setup.fighters[c].design}) weak spots on him:`, JSON.stringify(t.weakSpots?.map((w) => [w.zone, w.score.toFixed(2), w.reasons.map((r) => r.kind + (r.part ? `:${r.part}` : '') + (r.value !== undefined ? `=${r.value.toFixed(2)}` : '')).join(',')])));
  console.log(`   habits:`, JSON.stringify(t.habits));
  console.log(`   last decision:`, brains[c].latest?.reason, '| plan', JSON.stringify(brains[c].latest?.plan), '| read', brains[c].latest?.read);
}
console.log(`${SECONDS}s sim in ${wall.toFixed(1)}s wall | feint reads ${reads} | combos started ${plans.started}, setups ${plans.setups} (${[...plans.kinds].map(([k, n]) => `${k}×${n}`).join(', ')}), payoffs reached ${plans.payoffs}`);
