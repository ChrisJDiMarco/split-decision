// Headless fight: the real physics systems with the sparring stand-in brain, no rendering.
// Prints a timeline of knockdowns, detaches and KOs plus impact statistics, so strike
// impulses and break thresholds can be tuned against real fights.
// usage: npx tsx tools/fight-sim.ts [red] [blue] [seconds] [seed]
import loadMujoco from '@mujoco/mujoco';
import type { SimEvent } from '../src/core/protocol';
import type { MatchSetup } from '../src/core/types';
import { sparringIntent } from '../src/physics/control';
import { buildContext } from '../src/physics/runtime';
import { SYSTEMS } from '../src/physics/systems';
import { compileWorld } from '../src/physics/world';

const [red = 'bruiser', blue = 'striker', secondsArg = '120', seedArg = '7'] = process.argv.slice(2);
const SECONDS = Number(secondsArg);
const INTENT_EVERY_S = 0.5;

const setup: MatchSetup = {
  fighters: [
    { design: red, skin: 'factory', plan: '', temperament: 1 },
    { design: blue, skin: 'neon', plan: '', temperament: 1 },
  ],
  seed: Number(seedArg),
  timestep: 0.001,
  reactionDelayS: 0.3,
};

const mj = await loadMujoco();
const ctx = buildContext(mj, compileWorld(setup), setup);
for (const s of SYSTEMS) s.init?.(ctx);
for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
ctx.released = true;

const headHits: number[] = [];
const robotHits: number[] = [];
const timeline: string[] = [];
let blowups = 0;
const t0 = performance.now();
const steps = Math.round(SECONDS / ctx.dt);
const intentEvery = Math.round(INTENT_EVERY_S / ctx.dt);

const log = (e: SimEvent) => {
  const t = ctx.time.toFixed(1).padStart(6);
  switch (e.kind) {
    case 'impact':
      if (e.striker !== null && e.victim !== null && e.striker !== e.victim) {
        robotHits.push(e.impulseNs);
        if (e.part === 'head') headHits.push(e.impulseNs);
      }
      break;
    case 'fall': timeline.push(`${t}s  ${ctx.robots[e.corner].design.name} DOWN`); break;
    case 'getup': timeline.push(`${t}s  ${ctx.robots[e.corner].design.name} back up`); break;
    case 'detach': timeline.push(`${t}s  ${ctx.robots[e.corner].design.name} lost ${e.part}`); break;
    case 'joint': timeline.push(`${t}s  ${ctx.robots[e.corner].design.name} ${e.joint} → ${e.state}`); break;
    case 'ko': timeline.push(`${t}s  KO! ${ctx.robots[e.corner].design.name} (${e.reason})`); break;
    default: break;
  }
};

for (let i = 0; i < steps; i++) {
  if (i % intentEvery === 0) {
    for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
  }
  for (const s of SYSTEMS) s.pre?.(ctx);
  mj.mj_step(ctx.model, ctx.data);
  ctx.tick++;
  ctx.time += ctx.dt;
  let bad = false;
  for (let k = 0; k < ctx.model.nv; k++) if (!(Math.abs(ctx.data.qvel[k]) < 400)) { bad = true; break; }
  if (bad) { blowups++; break; }
  for (const s of SYSTEMS) s.post?.(ctx);
  for (const e of ctx.events) log(e);
  ctx.events.length = 0;
  if (ctx.robots.some((r) => r.koReason)) break;
}

const wall = (performance.now() - t0) / 1000;
const pct = (arr: number[], p: number) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : 0);
console.log(`${red} vs ${blue}, seed ${seedArg}: simulated ${ctx.time.toFixed(1)} s in ${wall.toFixed(1)} s (${((wall / ctx.time) * 1000).toFixed(0)} ms per sim second)${blowups ? ', BLOW-UP' : ''}`);
console.log(timeline.join('\n') || '(no knockdowns, detaches or KOs)');
console.log(`robot-on-robot hits: ${robotHits.length}, impulse p50 ${pct(robotHits, 0.5).toFixed(0)} p90 ${pct(robotHits, 0.9).toFixed(0)} max ${pct(robotHits, 1).toFixed(0)} N·s`);
console.log(`head hits: ${headHits.length}, impulse p50 ${pct(headHits, 0.5).toFixed(0)} p90 ${pct(headHits, 0.9).toFixed(0)} max ${pct(headHits, 1).toFixed(0)} N·s`);
for (const r of ctx.robots) {
  const hurt = r.joints.filter((j) => j.state !== 'ok').map((j) => `${j.name}:${j.state}`);
  const head = r.parts.get('head');
  console.log(`${r.design.name}: head hp ${(head?.hp ?? 0).toFixed(2)} dmg ${(head?.damage ?? 0).toFixed(0)}, gyro ${(r.gyro?.health ?? 0).toFixed(2)}, battery ${r.battery.toFixed(2)}, hydraulics ${[...r.hydraulics].map(([k, h]) => `${k}=${h.pressure.toFixed(2)}`).join(' ') || '-'}, joints ${hurt.join(' ') || 'all ok'}`);
}
