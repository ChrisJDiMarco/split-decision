// Recorded fall endings (not a test; run with npx tsx): sparring fights as tools/fight-metrics.ts runs them (the
// real arena and systems, the sparring stand-in's intents every 0.5 s, the 0.3 s reaction delay). Each time a
// fallen fighter's get-up starts to move (the settle on the canvas is over), how it lies is written as one JSON
// line: the root pose with x and y zeroed, every joint angle, the lying orientation, the joints already damaged.
// tools/balance-drills.ts --drills poses and tests/control/roll-search.ts (SD_POSES) start get-ups from these, so
// a get-up is judged on the poses fights really leave, not only on clean drops.
//   SD_BALANCE=legacy npx tsx tests/balance/capture-falls.ts savate:haymaker,firecracker:pylon 1,2,3 90 > falls.jsonl
// tests/balance/fixtures/fall-endings.jsonl holds 247 of them (each line tagged with its balance `path`): the four
// sparring pairs × seeds 1-8 × 90 s on both paths at f2ae969, before the get-up repair (156 legacy, 91 dcm).
import loadMujoco from '@mujoco/mujoco';
import type { MatchSetup } from '../../src/core/types';
import { controllerOf, sparringIntent } from '../../src/physics/control';
import { lyingLabel } from '../../src/physics/control/mocap/getup';
import { buildContext } from '../../src/physics/runtime';
import type { SimContext } from '../../src/physics/sim-context';
import { SYSTEMS } from '../../src/physics/systems';
import { compileWorld } from '../../src/physics/world';

const INTENT_EVERY_S = 0.5;
const [pairsS = 'savate:haymaker', seedsS = '1', secondsS = '90'] = process.argv.slice(2);
const seconds = Number(secondsS);
const mj = await loadMujoco();
for (const pair of pairsS.split(',')) {
  const [red, blue] = pair.split(':');
  for (const seed of seedsS.split(',').map(Number)) {
    const setup: MatchSetup = {
      fighters: [
        { design: red, skin: 'factory', plan: '', temperament: 1 },
        { design: blue, skin: 'neon', plan: '', temperament: 1 },
      ],
      seed, timestep: 0.001, reactionDelayS: 0.3,
    };
    const ctx: SimContext = buildContext(mj, compileWorld(setup), setup);
    for (const s of SYSTEMS) s.init?.(ctx);
    for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
    ctx.released = true;
    const ctl = ctx.robots.map((r) => controllerOf(r)!);
    const last = ['up', 'up'];
    const every = Math.round(INTENT_EVERY_S / ctx.dt);
    let n = 0;
    for (let i = 0; i < Math.round(seconds / ctx.dt); i++) {
      if (i % every === 0) for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
      for (const s of SYSTEMS) s.pre?.(ctx);
      mj.mj_step(ctx.model, ctx.data);
      ctx.tick++;
      ctx.time += ctx.dt;
      for (const s of SYSTEMS) s.post?.(ctx);
      ctx.events.length = 0;
      for (const c of [0, 1]) {
        const g = ctl[c].getUp;
        const phase = g.active ? g.phase : 'up';
        const s = ctl[c].lastSense;
        if (last[c] === 'settle' && phase !== 'settle' && s) {
          const r = ctx.robots[c];
          const q = ctx.data.qpos as Float64Array;
          const a = r.rootQadr;
          const joints: Record<string, number> = {};
          for (const j of r.joints) joints[j.name] = Number(q[j.qadr].toFixed(4));
          const root = [0, 0, q[a + 2], q[a + 3], q[a + 4], q[a + 5], q[a + 6]].map((v) => Number(v.toFixed(5)));
          console.log(JSON.stringify({
            design: r.design.id, opp: ctx.robots[1 - c].design.id, seed, t: Number(ctx.time.toFixed(2)), orient: lyingLabel(s).orient,
            damaged: r.joints.filter((j) => j.state !== 'ok').map((j) => j.name), root, joints,
          }));
          n++;
        }
        last[c] = phase;
      }
      if (ctx.robots.some((r) => r.koReason)) break;
    }
    console.error(`${red} v ${blue} s${seed}: ${n} fall endings`);
    ctx.data.delete();
    ctx.model.delete();
  }
}
