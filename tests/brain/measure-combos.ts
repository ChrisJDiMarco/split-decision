// Combos thrown whole in the body, never a step twice: headless House-Mind fights on the real physics
// (no Jev calls), counting what the body throws for each combination the brain sends.
//   instance      a combo intent the body applies (tactic 'combo'), until an intent for another
//                 combination (or none) applies; brain-sequenced step intents of the same combination
//                 (comboPlan.step) belong to it
//   thrown        strike and feint windups the body starts while the instance stands
//   extra         thrown beyond the combination's step count: a step thrown a second time (a late
//                 brain step intent re-throwing what the body already ran, or a standing combo intent
//                 re-throwing its first step after the body finished it)
//   step intents  brain-sequenced step intents sent (zero with body sequencing on a body that runs combos)
// Not a test: run it by hand. SD_BALANCE=dcm for the balance engine (the body that runs combos whole).
// usage: SD_BALANCE=dcm npx tsx tests/brain/measure-combos.ts [--pairs savate:haymaker] [--seconds 60] [--seeds 1,2] [--json out.json]
import loadMujoco from '@mujoco/mujoco';
import { writeFileSync } from 'node:fs';
import { Brain } from '../../src/brain/brain';
import { JevLink } from '../../src/brain/link';
import type { Intent, SimEvent } from '../../src/core/protocol';
import type { Corner, MatchSetup } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import { buildContext } from '../../src/physics/runtime';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { compileWorld } from '../../src/physics/world';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PAIRS = opt('pairs', 'savate:haymaker,firecracker:pylon,savate:pylon,haymaker:firecracker').split(',').map((p) => p.split(':') as [string, string]);
const SECONDS = Number(opt('seconds', '60'));
const SEEDS = opt('seeds', '1,2').split(',').map(Number);
const JSON_OUT = opt('json', '');
const FRAME_S = 1 / 60;
const REACTION_S = 0.3; // the game's reaction delay (as tools/fight-metrics)

const keyOf = (i: Intent | null): string => (i?.combo?.length ? i.combo.join('>') : '');

interface Tally { instances: number; steps: number; thrown: number; extra: number; withExtra: number; stepIntents: number; combosSent: number }
const newTally = (): Tally => ({ instances: 0, steps: 0, thrown: 0, extra: 0, withExtra: 0, stepIntents: 0, combosSent: 0 });

async function fight(mj: Awaited<ReturnType<typeof loadMujoco>>, red: string, blue: string, seed: number) {
  const setup: MatchSetup = {
    fighters: [
      { design: red, skin: 'factory', plan: '', temperament: 1.2 },
      { design: blue, skin: 'neon', plan: '', temperament: 1.2 },
    ],
    seed, timestep: 0.001, reactionDelayS: REACTION_S,
  };
  const ctx = buildContext(mj, compileWorld(setup), setup);
  for (const s of SYSTEMS) s.init?.(ctx);
  const link = new JevLink({ ask: () => Promise.reject(new Error('offline: House Mind')), retryMs: 1e9 });
  const meta = { nbody: 0, timestep: 0.001, robots: [0, 1].map((c) => ({ corner: c as Corner, design: setup.fighters[c].design, prefix: '', parts: [] })), props: [] };
  const tally = [newTally(), newTally()];
  const brains = ([0, 1] as Corner[]).map((corner) => new Brain({
    corner, meta, seed, link, source: 'house', fighter: setup.fighters[corner],
    onIntent: (c: Corner, intent: Intent) => {
      ctx.robots[c].pendingIntents.push({ applyAtTick: ctx.tick + Math.round(REACTION_S / ctx.dt), intent });
      if (intent.comboPlan?.step !== undefined) tally[c].stepIntents++;
      else if (intent.tactic === 'combo') tally[c].combosSent++;
    },
  }));
  for (let i = 0; i < 300; i++) { for (const s of SYSTEMS) s.pre?.(ctx); mj.mj_step(ctx.model, ctx.data); ctx.tick++; ctx.time += ctx.dt; for (const s of SYSTEMS) s.post?.(ctx); }
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  for (const b of brains) b.start();
  const open: Array<{ key: string; steps: number; thrown: number } | null> = [null, null];
  const lastRun: unknown[] = [null, null];
  const lastIntent: Array<Intent | null> = [null, null];
  const close = (c: number) => {
    const o = open[c];
    if (!o) return;
    const t = tally[c];
    t.instances++;
    t.steps += o.steps;
    t.thrown += o.thrown;
    const extra = Math.max(0, o.thrown - o.steps);
    t.extra += extra;
    if (extra) t.withExtra++;
    open[c] = null;
  };
  const perFrame = Math.round(FRAME_S / ctx.dt);
  const start = ctx.time;
  let ended = false;
  for (let f = 0; f < SECONDS / FRAME_S && !ended; f++) {
    const frameEvents: SimEvent[] = [];
    for (let i = 0; i < perFrame; i++) {
      for (const s of SYSTEMS) s.pre?.(ctx);
      mj.mj_step(ctx.model, ctx.data);
      ctx.tick++;
      ctx.time += ctx.dt;
      for (const s of SYSTEMS) s.post?.(ctx);
      for (const e of ctx.events) { frameEvents.push(e); if (e.kind === 'ko') ended = true; }
      ctx.events.length = 0;
      for (const c of [0, 1]) {
        const r = ctx.robots[c];
        const intent = r.intent;
        if (intent !== lastIntent[c]) {
          lastIntent[c] = intent;
          const key = keyOf(intent);
          const comboish = !!key && (intent!.tactic === 'combo' || intent!.comboPlan?.step !== undefined);
          if (open[c] && (!comboish || open[c]!.key !== key)) close(c);
          if (comboish && !open[c] && intent!.tactic === 'combo') open[c] = { key, steps: intent!.combo!.length, thrown: 0 };
        }
        const run = controllerOf(r)?.skills.run ?? null;
        if (run !== lastRun[c]) {
          lastRun[c] = run;
          if (run && (run.def.kind === 'arm' || run.def.kind === 'leg') && open[c]) open[c]!.thrown++;
        }
        if (r.down && open[c]) close(c);
      }
    }
    const telemetry = [buildTelemetry(ctx, ctx.robots[0], SYSTEMS), buildTelemetry(ctx, ctx.robots[1], SYSTEMS)] as [ReturnType<typeof buildTelemetry>, ReturnType<typeof buildTelemetry>];
    for (const b of brains) b.onFrame({ tick: ctx.tick, time: ctx.time, events: frameEvents, telemetry });
    await Promise.resolve();
  }
  for (const c of [0, 1]) close(c);
  return { red, blue, seed, length: ctx.time - start, tally };
}

const mj = await loadMujoco();
const results = [];
const all = newTally();
for (const [red, blue] of PAIRS) for (const seed of SEEDS) {
  const r = await fight(mj, red, blue, seed);
  results.push(r);
  for (const t of r.tally) for (const k of Object.keys(all) as Array<keyof Tally>) all[k] += t[k];
  const s = (k: keyof Tally) => r.tally[0][k] + r.tally[1][k];
  console.log(`${red} v ${blue} s${seed}: ${r.length.toFixed(0)} s | combos ${s('instances')} (sent ${s('combosSent')}), steps ${s('steps')}, thrown ${s('thrown')}, extra ${s('extra')} in ${s('withExtra')} | step intents ${s('stepIntents')}`);
}
console.log(`TOTAL ${results.length} fights | combos ${all.instances} (sent ${all.combosSent}) | steps ${all.steps}, thrown ${all.thrown} | extra throws ${all.extra} in ${all.withExtra} combos (${((100 * all.withExtra) / Math.max(1, all.instances)).toFixed(0)}%) | brain step intents ${all.stepIntents} | balance ${process.env.SD_BALANCE ?? 'default'}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ all, results }, null, 2));
