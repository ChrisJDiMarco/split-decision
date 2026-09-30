// Test harness for the control module: a minimal MuJoCo world (canvas + two robots at chosen
// placements, same solver options as src/physics/world.ts), the real systems, and probes.
import loadMujoco from '@mujoco/mujoco';
import type { Intent, Tactic, TargetZone } from '../../src/core/protocol';
import type { MatchSetup, Vec3 } from '../../src/core/types';
import { controllerOf, controlSystem } from '../../src/physics/control';
import { buildContext } from '../../src/physics/runtime';
import type { RobotRuntime, SimContext, SimSystem } from '../../src/physics/sim-context';
import { intentSystem } from '../../src/physics/systems/intents';
import { motorSystem } from '../../src/physics/systems/motors';
import type { CompiledWorld } from '../../src/physics/world';
import { COLLIDE, compileRobot } from '../../src/robots/compile-mjcf';
import { design } from '../../src/robots/designs';

type Mj = Awaited<ReturnType<typeof loadMujoco>>;
let mjPromise: Promise<Mj> | null = null;
export const mujoco = (): Promise<Mj> => (mjPromise ??= loadMujoco());

export const SYSTEMS: readonly SimSystem[] = [intentSystem, controlSystem, motorSystem];

export interface Placement {
  design: string;
  x: number;
  y: number;
  yaw: number;
}

const f = (n: number) => Number(n.toFixed(5)).toString();

export function minimalWorld(a: Placement, b: Placement, timestep = 0.001): { world: CompiledWorld; setup: MatchSetup } {
  const d0 = design(a.design);
  const d1 = design(b.design);
  const r0 = compileRobot(d0, 0, { pos: [a.x, a.y, d0.rootHeight + 0.02], yaw: a.yaw });
  const r1 = compileRobot(d1, 1, { pos: [b.x, b.y, d1.rootHeight + 0.02], yaw: b.yaw });
  const worldAff = COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;
  const xml = `<mujoco model="control-test">
  <compiler angle="degree" autolimits="true"/>
  <option timestep="${f(timestep)}" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="30" ls_iterations="10">
    <flag energy="disable"/>
  </option>
  <size memory="64M"/>
  <worldbody>
    <geom name="canvas" type="plane" size="30 30 0.1" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" friction="0.9 0.005 0.0001" solref="0.004 1"/>
${r0.bodyXml}
${r1.bodyXml}
${r0.debrisXml}
${r1.debrisXml}
  </worldbody>
  <equality>
    ${r0.equalityXml}
    ${r1.equalityXml}
  </equality>
  <actuator>
    ${r0.actuatorXml}
    ${r1.actuatorXml}
  </actuator>
</mujoco>`;
  const setup: MatchSetup = {
    fighters: [
      { design: a.design, skin: 'factory', plan: '', temperament: 1 },
      { design: b.design, skin: 'factory', plan: '', temperament: 1 },
    ],
    seed: 1,
    timestep,
    reactionDelayS: 0,
  };
  return { world: { xml, robots: [r0, r1] }, setup };
}

export interface Sim {
  ctx: SimContext;
  step(n?: number): void;
  seconds(s: number, each?: (ctx: SimContext) => void): void;
  release(corner: 0 | 1): void;
  dispose(): void;
}

export async function makeSim(a: Placement, b: Placement, opts: { seed?: number; systems?: readonly SimSystem[] } = {}): Promise<Sim> {
  const mj = await mujoco();
  const { world, setup } = minimalWorld(a, b);
  setup.seed = opts.seed ?? 1;
  const ctx = buildContext(mj, world, setup);
  const systems = opts.systems ?? SYSTEMS;
  for (const s of systems) s.init?.(ctx);
  const stepOnce = () => {
    for (const s of systems) s.pre?.(ctx);
    mj.mj_step(ctx.model, ctx.data);
    ctx.tick++;
    ctx.time += ctx.dt;
    for (const s of systems) s.post?.(ctx);
  };
  return {
    ctx,
    step(n = 1) {
      for (let i = 0; i < n; i++) stepOnce();
    },
    seconds(s, each) {
      const n = Math.round(s / ctx.dt);
      for (let i = 0; i < n; i++) {
        stepOnce();
        each?.(ctx);
      }
    },
    release(corner) {
      ctx.setEqActive(ctx.eqIndex(ctx.robots[corner].compiled.gantryWeld), false);
      ctx.released = true;
    },
    dispose() {
      ctx.data.delete();
      ctx.model.delete();
    },
  };
}

export function intent(tactic: Tactic, target: TargetZone = 'head', aggression = 0.7, counterIfLunge?: Tactic): Intent {
  return { tactic, target, aggression, confidence: 0.8, source: 'fallback', counterIfLunge };
}

// ---------------------------------------------------------------- probes

export function pelvisPos(ctx: SimContext, r: RobotRuntime): Vec3 {
  const b = r.rootBody * 3;
  const x = ctx.data.xpos;
  return [x[b], x[b + 1], x[b + 2]];
}

export function comPos(ctx: SimContext, r: RobotRuntime): Vec3 {
  const b = r.rootBody * 3;
  const c = ctx.data.subtree_com;
  return [c[b], c[b + 1], c[b + 2]];
}

/** Torso up-axis z component: 1 upright, 0 horizontal. */
export function torsoUp(ctx: SimContext, r: RobotRuntime): number {
  const body = r.parts.get('torso')!.body;
  return ctx.data.xmat[body * 9 + 8];
}

export function isFinite(ctx: SimContext): boolean {
  const q = ctx.data.qpos;
  const v = ctx.data.qvel;
  for (let i = 0; i < ctx.model.nq; i++) if (!Number.isFinite(q[i])) return false;
  for (let i = 0; i < ctx.model.nv; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

export function maxQvel(ctx: SimContext): number {
  let m = 0;
  const v = ctx.data.qvel;
  for (let i = 0; i < ctx.model.nv; i++) m = Math.max(m, Math.abs(v[i]));
  return m;
}

/** Push a robot's torso with a constant world force for `duration` seconds (an impulse = F·t). */
export function push(sim: Sim, r: RobotRuntime, force: Vec3, duration: number): void {
  const body = r.parts.get('torso')!.body;
  const xf = sim.ctx.data.xfrc_applied;
  const n = Math.round(duration / sim.ctx.dt);
  for (let i = 0; i < n; i++) {
    xf[body * 6] += force[0];
    xf[body * 6 + 1] += force[1];
    xf[body * 6 + 2] += force[2];
    sim.step();
    xf[body * 6] -= force[0];
    xf[body * 6 + 1] -= force[1];
    xf[body * 6 + 2] -= force[2];
  }
}

export function robotMass(ctx: SimContext, r: RobotRuntime): number {
  return ctx.model.body_subtreemass[r.rootBody];
}

/** Every humanoid on the roster: the iron-age three and the modern four. */
export const HUMANOIDS = ['bruiser', 'striker', 'goliath', 'firecracker', 'savate', 'haymaker', 'pylon'] as const;

/**
 * A lone robot: robot 0 released on the canvas, robot 1 parked far away on its gantry with its
 * controller off (holding its design stance), so the bearing robot 0 squares up to stays put.
 */
export async function loneRobot(design: string, seed = 1): Promise<Sim> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design: 'striker', x: 8, y: 0, yaw: Math.PI }, { seed });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  sim.seconds(0.5);
  sim.release(0);
  return sim;
}

/** Knocked down: torso more than ~60° from upright or the COM below 55% of standing height. */
export function isDown(ctx: SimContext, r: RobotRuntime, standingComZ: number): boolean {
  return torsoUp(ctx, r) < 0.5 || comPos(ctx, r)[2] < 0.55 * standingComZ;
}

/** Largest |qvel| over this robot's own degrees of freedom (debris bodies excluded). */
export function robotMaxQvel(ctx: SimContext, r: RobotRuntime): number {
  let m = 0;
  const v = ctx.data.qvel;
  for (let i = 0; i < 6; i++) m = Math.max(m, Math.abs(v[r.rootDadr + i]));
  for (const j of r.joints) m = Math.max(m, Math.abs(v[j.dadr]));
  return m;
}
