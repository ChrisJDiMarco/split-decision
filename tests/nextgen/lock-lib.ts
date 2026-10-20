// Regression lock for the seven existing fighters, shared by lock.test.ts (checks) and
// regenerate.ts (writes the fixtures). Two locks (docs/design/next-gen-chassis.md §4.3, "Guarding
// the existing seven"):
//  1. MJCF bytes: each modern design compiled for both corners at the iron-age fixture's placement,
//     hashed (sha256), plus a hash of the runtime fields outside the MJCF (stance, root height, gyro).
//  2. Behaviour golden: a fixed-seed scripted trace per design on the real systems (intents, control,
//     motors): gantry drop, release, stand, a side shove, a jab at a standing target, recovery.
//     Robot 0's qpos is hashed every 50 steps (50 ms), so a mismatch names the first step that moved.
// Not a test file itself (no .test suffix).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controllerOf } from '../../src/physics/control';
import { compileRobot } from '../../src/robots/compile-mjcf';
import { design } from '../../src/robots/designs';
import { comPos, intent, isDown, makeSim, push } from '../control/helpers';

export const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'] as const;
export const IRON = ['bruiser', 'striker', 'goliath'] as const;
export const SEVEN = [...MODERN, ...IRON] as const;

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const MJCF_FIXTURE = join(FIXTURES, 'modern-mjcf.json');
export const BEHAVIOUR_FIXTURE = join(FIXTURES, 'behaviour-golden.json');

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- 1. MJCF bytes

export interface MjcfLock { sha256: string; length: number; totalMassKg: number; runtimeSha256: string }

/** Same placement as tests/roster/fixtures/iron-age-baseline.json, so the two fixtures read alike. */
export function mjcfLock(id: string, corner: 0 | 1): MjcfLock {
  const d = design(id);
  const c = compileRobot(d, corner, { pos: [corner ? 1.5 : -1.5, 0.25, 1.1], yaw: corner ? Math.PI : 0 });
  const xml = [c.bodyXml, c.debrisXml, c.actuatorXml, c.tendonXml, c.equalityXml, c.sensorXml].join('\n');
  // Fields the runtime reads that never reach the MJCF: the stance the servos start on, where the
  // gantry holds the root, the gyro core.
  const runtime = JSON.stringify({ stance: d.stance, rootHeight: d.rootHeight, gyro: d.gyro ?? null, abilities: d.abilities });
  return { sha256: sha(xml), length: xml.length, totalMassKg: c.totalMassKg, runtimeSha256: sha(runtime) };
}

// ---------------------------------------------------------------- 2. behaviour golden

export const TRACE_EVERY = 50; // steps between qpos hashes (50 ms at the 1 ms step)
export const TRACE_SEED = 7;

export interface BehaviourTrace {
  steps: number;
  hashes: string[]; // first 16 hex of sha256 over robot 0's qpos bytes, every TRACE_EVERY steps
  final: { pelvis: number[]; fell: boolean; thrown: number; landed: number };
}

/** Robot 0's own qpos (root + joints), as raw float64 bytes. */
function qposBytes(ctx: Awaited<ReturnType<typeof makeSim>>['ctx']): Uint8Array {
  const r = ctx.robots[0];
  const out = new Float64Array(7 + r.joints.length);
  for (let i = 0; i < 7; i++) out[i] = ctx.data.qpos[r.rootQadr + i];
  r.joints.forEach((j, i) => { out[7 + i] = ctx.data.qpos[j.qadr]; });
  return new Uint8Array(out.buffer);
}

/**
 * The scripted trace: 0.5 s on the gantry, release, 1 s stand, a 0.1 s side shove worth
 * 0.4 m/s of body velocity, 1.5 s recovery, then a jab intent at a standing BRUISER 1.4 m away
 * for 6 s (the controller walks in and throws after ~3.5-5 s), and 1 s with no intent. Same seed, same world, same steps every run.
 */
export async function behaviourTrace(id: string): Promise<BehaviourTrace> {
  const sim = await makeSim({ design: id, x: 0, y: 0, yaw: 0 }, { design: 'bruiser', x: 1.4, y: 0, yaw: Math.PI }, { seed: TRACE_SEED });
  const { ctx } = sim;
  const me = ctx.robots[0];
  const hashes: string[] = [];
  let steps = 0;
  const tick = () => {
    steps++;
    if (steps % TRACE_EVERY === 0) hashes.push(sha(qposBytes(ctx)).slice(0, 16));
  };
  const run = (s: number) => sim.seconds(s, tick);
  run(0.5);
  sim.release(0);
  sim.release(1);
  run(1.0);
  const c = controllerOf(me)!;
  const z0 = comPos(ctx, me)[2];
  const mass = ctx.model.body_subtreemass[me.rootBody];
  // push() steps the sim itself; count its steps into the trace too.
  const before = ctx.tick;
  push(sim, me, [0, (0.4 * mass) / 0.1, 0], 0.1);
  for (let i = before; i < ctx.tick; i++) tick();
  let fell = false;
  sim.seconds(1.5, () => { tick(); if (isDown(ctx, me, z0)) fell = true; });
  me.intent = intent('jab', 'head', 0.7);
  sim.seconds(6.0, () => { tick(); if (isDown(ctx, me, z0)) fell = true; });
  me.intent = null;
  sim.seconds(1.0, () => { tick(); if (isDown(ctx, me, z0)) fell = true; });
  const p = me.rootQadr;
  const out: BehaviourTrace = {
    steps,
    hashes,
    final: {
      pelvis: [ctx.data.qpos[p], ctx.data.qpos[p + 1], ctx.data.qpos[p + 2]].map((x) => Number(x.toFixed(6))),
      fell,
      thrown: c.skills.stats.thrown,
      landed: c.skills.stats.landed,
    },
  };
  sim.dispose();
  return out;
}

// ---------------------------------------------------------------- source fingerprint

/**
 * sha256 over every source file the locks depend on (src/robots, src/physics, src/core and the
 * motion-library data). Stored with the fixtures for diagnosis only: when a lock fails, a changed
 * fingerprint says some source moved since the fixture was written; an equal one means the
 * nondeterminism is elsewhere (MuJoCo build, Node version).
 */
export function sourceFingerprint(): { sha256: string; files: number } {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|json)$/.test(name)) files.push(p);
    }
  };
  for (const d of ['src/robots', 'src/physics', 'src/core']) walk(join(root, d));
  const h = createHash('sha256');
  for (const f of files) h.update(relative(root, f)).update('\0').update(readFileSync(f)).update('\0');
  return { sha256: h.digest('hex'), files: files.length };
}
