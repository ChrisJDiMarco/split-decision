// Test rig: builds a real MuJoCo world (compiled robots + cage), optionally with free "rams"
// (heavy boxes we can fire at a robot), and steps it exactly like the worker does.
import loadMujoco from '@mujoco/mujoco';
import type { SimEvent } from '../../src/core/protocol';
import type { MatchSetup, Vec3 } from '../../src/core/types';
import { damageSystem } from '../../src/physics/damage';
import { buildContext } from '../../src/physics/runtime';
import type { SimContext, SimSystem } from '../../src/physics/sim-context';
import { intentSystem } from '../../src/physics/systems/intents';
import { motorSystem } from '../../src/physics/systems/motors';
import { stanceSystem } from '../../src/physics/systems/stance';
import { COLLIDE } from '../../src/robots/compile-mjcf';
import { compileWorld } from '../../src/physics/world';

export const mj = await loadMujoco();

const PRE: SimSystem[] = [intentSystem, stanceSystem, motorSystem];

export interface Ram {
  name: string;
  massKg: number;
  halfSize: number;
}

export interface RigOptions {
  designs?: [string, string];
  rams?: Ram[];
  /** Spawn the robots this far from the center instead of the arena default (a clinch). */
  spawnOffset?: number;
}

function ramXml(r: Ram, i: number): string {
  const aff = COLLIDE.WORLD | COLLIDE.R0 | COLLIDE.R1;
  // Parked out of the way on the canvas; tests teleport and fire it.
  return `<body name="${r.name}" pos="0 ${3 - i * 0.6} ${r.halfSize + 0.01}"><freejoint name="${r.name}_free"/>` +
    `<geom name="${r.name}_g" type="box" size="${r.halfSize} ${r.halfSize} ${r.halfSize}" mass="${r.massKg}" contype="${COLLIDE.DEBRIS}" conaffinity="${aff}" friction="0.6 0.005 0.0001"/></body>`;
}

export function makeRig(opts: RigOptions = {}): SimContext {
  const designs = opts.designs ?? ['bruiser', 'striker'];
  const setup: MatchSetup = {
    fighters: [
      { design: designs[0], skin: 'factory', plan: '', temperament: 1 },
      { design: designs[1], skin: 'neon', plan: '', temperament: 1 },
    ],
    seed: 7,
    timestep: 0.001,
    reactionDelayS: 0.3,
  };
  const world = compileWorld(setup);
  let xml = world.xml;
  if (opts.rams?.length) xml = xml.replace('</worldbody>', `${opts.rams.map(ramXml).join('\n')}\n  </worldbody>`);
  if (opts.spawnOffset !== undefined) {
    const off = opts.spawnOffset;
    xml = xml.replace(/(<body name="r0_pelvis" pos=")[-\d.]+/, `$1${-off}`).replace(/(<body name="r1_pelvis" pos=")[-\d.]+/, `$1${off}`);
  }
  const ctx = buildContext(mj, { ...world, xml }, setup);
  damageSystem.init!(ctx);
  return ctx;
}

/** One physics step, same order as the worker: pre systems (damage's drive state after the motors), mj_step, damage. */
export function step(ctx: SimContext, n = 1, onStep?: () => void): void {
  for (let k = 0; k < n; k++) {
    for (const s of PRE) s.pre?.(ctx);
    damageSystem.pre!(ctx);
    ctx.mj.mj_step(ctx.model, ctx.data);
    ctx.tick++;
    ctx.time += ctx.dt;
    damageSystem.post!(ctx);
    onStep?.();
  }
}

export function drain(ctx: SimContext): SimEvent[] {
  const ev = ctx.events;
  ctx.events = [];
  return ev;
}

export function bodyPos(ctx: SimContext, body: number): Vec3 {
  const x = ctx.data.xpos;
  return [x[body * 3], x[body * 3 + 1], x[body * 3 + 2]];
}

/** Center of a geom in world space. */
export function geomPos(ctx: SimContext, geom: number): Vec3 {
  const x = ctx.data.geom_xpos;
  return [x[geom * 3], x[geom * 3 + 1], x[geom * 3 + 2]];
}

/** Teleports a ram to `pos` and fires it with velocity `vel`. */
export function fireRam(ctx: SimContext, name: string, pos: Vec3, vel: Vec3): void {
  const jid = ctx.model.jnt(`${name}_free`).id;
  const qa = ctx.model.jnt_qposadr[jid];
  const da = ctx.model.jnt_dofadr[jid];
  const qpos = ctx.data.qpos;
  const qvel = ctx.data.qvel;
  qpos[qa] = pos[0]; qpos[qa + 1] = pos[1]; qpos[qa + 2] = pos[2];
  qpos[qa + 3] = 1; qpos[qa + 4] = 0; qpos[qa + 5] = 0; qpos[qa + 6] = 0;
  for (let k = 0; k < 6; k++) qvel[da + k] = 0;
  qvel[da] = vel[0]; qvel[da + 1] = vel[1]; qvel[da + 2] = vel[2];
  ctx.mj.mj_forward(ctx.model, ctx.data);
}

export function ofKind<K extends SimEvent['kind']>(events: SimEvent[], kind: K): Array<Extract<SimEvent, { kind: K }>> {
  return events.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === kind);
}

function ramTouching(ctx: SimContext, name: string): boolean {
  const g = ctx.model.geom(`${name}_g`).id;
  const contacts = ctx.data.contact;
  let touching = false;
  for (let i = 0; i < ctx.data.ncon && !touching; i++) {
    const c = contacts.get(i);
    touching = c.geom1 === g || c.geom2 === g;
    c.delete(); // each element is a heap copy
  }
  contacts.delete();
  return touching;
}

/**
 * Fires a ram along unit `dir` so it strikes `target`, spawning it at the nearest clear spot behind
 * the target (a ram spawned inside a limb is a solver push-out, not a hit). Returns false if none is clear.
 */
export function fireRamAt(ctx: SimContext, name: string, target: Vec3, dir: Vec3, speed: number): boolean {
  for (let d = 0.3; d < 1.5; d += 0.05) {
    fireRam(ctx, name, [target[0] - dir[0] * d, target[1] - dir[1] * d, target[2] - dir[2] * d], [dir[0] * speed, dir[1] * speed, dir[2] * speed]);
    if (!ramTouching(ctx, name)) return true;
  }
  return false;
}
