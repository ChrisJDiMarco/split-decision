// Damage-system cost benchmark. Run with `npx tsx tests/damage/bench.ts`; prints one JSON line.
// perf.test.ts runs it in a child process because vitest's worker slows WASM calls ~4x.
import { damageState, damageSystem } from '../../src/physics/damage';
import type { SimContext } from '../../src/physics/sim-context';
import { intentSystem } from '../../src/physics/systems/intents';
import { motorSystem } from '../../src/physics/systems/motors';
import { stanceSystem } from '../../src/physics/systems/stance';
import { drain, fireRamAt, geomPos, makeRig, ofKind } from './helpers';

const STEPS = 6000;
const RAM_EVERY = 60; // a fresh hit every 60 ms keeps impact episodes open much of the time

export interface Profile { damageUs: number; stepUs: number; meanContacts: number; maxContacts: number; impacts: number }

function profile(ctx: SimContext, hit: (k: number) => void): Profile {
  let damageMs = 0;
  let totalMs = 0;
  let contacts = 0;
  let maxContacts = 0;
  let impacts = 0;
  for (let k = 0; k < STEPS; k++) {
    hit(k);
    const t0 = performance.now();
    intentSystem.pre!(ctx); stanceSystem.pre!(ctx); motorSystem.pre!(ctx);
    ctx.mj.mj_step(ctx.model, ctx.data);
    ctx.tick++;
    ctx.time += ctx.dt;
    const t1 = performance.now();
    damageSystem.post!(ctx);
    const t2 = performance.now();
    damageMs += t2 - t1;
    totalMs += t2 - t0;
    contacts += ctx.data.ncon;
    maxContacts = Math.max(maxContacts, ctx.data.ncon);
    if (k % 200 === 0) impacts += ofKind(drain(ctx), 'impact').length;
  }
  impacts += ofKind(drain(ctx), 'impact').length;
  return { damageUs: (damageMs * 1000) / STEPS, stepUs: (totalMs * 1000) / STEPS, meanContacts: contacts / STEPS, maxContacts, impacts };
}

/** Both robots dropped off the gantry face to face: they collapse into a heap on the canvas under ram fire. */
function heapUnderFire(): Profile {
  const ctx = makeRig({ spawnOffset: 0.35, rams: [{ name: 'ram', massKg: 20, halfSize: 0.1 }] });
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  const targets = ['head', 'torso', 'forearm_l', 'fist_r', 'upperarm_r', 'thigh_l'];
  const st = damageState(ctx);
  return profile(ctx, (k) => {
    if (k % RAM_EVERY !== 0) return;
    const n = k / RAM_EVERY;
    const corner = n % 2;
    const part = st.robots[corner].parts.get(targets[n % targets.length])!;
    if (part.part.attached) fireRamAt(ctx, 'ram', geomPos(ctx, part.part.geoms[0]), [0, corner ? -1 : 1, 0], 7);
  });
}

const standing = makeRig();
profile(standing, () => {}); // JIT warm-up on the same paths
const quiet = profile(standing, () => {});
heapUnderFire(); // warm-up
const busy = heapUnderFire();
console.log(JSON.stringify({ standing: quiet, heap: busy }));
