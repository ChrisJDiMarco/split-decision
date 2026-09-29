// A two-robot world with loadouts at chosen placements (same solver options as src/physics/world.ts)
// running the real systems, for the loadout, hands and gaze tests.
import loadMujoco from '@mujoco/mujoco';
import type { HandsOption, MatchSetup } from '../../src/core/types';
import { buildContext } from '../../src/physics/runtime';
import type { SimContext } from '../../src/physics/sim-context';
import { SYSTEMS } from '../../src/physics/systems';
import { COLLIDE, compileRobot } from '../../src/robots/compile-mjcf';
import { design } from '../../src/robots/designs';
import { applyLoadout } from '../../src/robots/loadout';

type Mj = Awaited<ReturnType<typeof loadMujoco>>;
let mjPromise: Promise<Mj> | null = null;
export const mujoco = (): Promise<Mj> => (mjPromise ??= loadMujoco());

export interface Corner { design: string; hands?: HandsOption; x: number; y: number; yaw: number }

const f = (n: number) => Number(n.toFixed(5)).toString();

export async function loadoutSim(a: Corner, b: Corner, seed = 1): Promise<{ ctx: SimContext; step(n?: number, each?: () => void): void; release(): void; dispose(): void }> {
  const mj = await mujoco();
  const setup: MatchSetup = {
    fighters: [a, b].map((c) => ({ design: c.design, skin: 'factory' as const, plan: '', temperament: 1, loadout: { design: c.design, hands: c.hands ?? 'stock' } })) as MatchSetup['fighters'],
    seed, timestep: 0.001, reactionDelayS: 0,
  };
  const robots = [a, b].map((c, i) => {
    const d = applyLoadout(design(c.design), setup.fighters[i].loadout);
    return compileRobot(d, i as 0 | 1, { pos: [c.x, c.y, d.rootHeight + 0.02], yaw: c.yaw });
  }) as [ReturnType<typeof compileRobot>, ReturnType<typeof compileRobot>];
  const tendons = robots.map((r) => r.tendonXml).filter(Boolean);
  const worldAff = COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;
  const xml = `<mujoco model="loadout-test">
  <compiler angle="degree" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="30" ls_iterations="10">
    <flag energy="disable"/>
  </option>
  <size memory="64M"/>
  <worldbody>
    <geom name="canvas" type="plane" size="30 30 0.1" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" friction="${f(0.9)} 0.005 0.0001" solref="0.004 1"/>
${robots.map((r) => r.bodyXml).join('\n')}
${robots.map((r) => r.debrisXml).join('\n')}
  </worldbody>
  <equality>
    ${robots.map((r) => r.equalityXml).join('\n    ')}
  </equality>
  ${tendons.length ? `<tendon>\n    ${tendons.join('\n    ')}\n  </tendon>` : ''}
  <actuator>
    ${robots.map((r) => r.actuatorXml).join('\n    ')}
  </actuator>
</mujoco>`;
  const ctx = buildContext(mj, { xml, robots }, setup);
  for (const s of SYSTEMS) s.init?.(ctx);
  const once = () => {
    for (const s of SYSTEMS) s.pre?.(ctx);
    mj.mj_step(ctx.model, ctx.data);
    ctx.tick++;
    ctx.time += ctx.dt;
    for (const s of SYSTEMS) s.post?.(ctx);
  };
  return {
    ctx,
    step(n = 1, each) {
      for (let i = 0; i < n; i++) {
        once();
        each?.();
        ctx.events.length = 0;
      }
    },
    release() {
      for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
      ctx.released = true;
    },
    dispose() {
      ctx.data.delete();
      ctx.model.delete();
    },
  };
}
