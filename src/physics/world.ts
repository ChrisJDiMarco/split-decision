// Composes the full MJCF: canvas, cage colliders and both compiled robots.
import { ARENA, panels, postPositions } from '../core/arena-spec';
import type { MatchSetup } from '../core/types';
import { COLLIDE, compileRobot, type CompiledRobot } from '../robots/compile-mjcf';
import { design } from '../robots/designs';
import { applyLoadout } from '../robots/loadout';

export interface CompiledWorld {
  xml: string;
  robots: [CompiledRobot, CompiledRobot];
}

const f = (n: number) => Number(n.toFixed(5)).toString();

function cageXml(): string {
  const worldAff = COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;
  const h = ARENA.FENCE_HEIGHT_M;
  const t = ARENA.FENCE_THICKNESS_M;
  const out: string[] = [];
  panels().forEach((p, i) => {
    // The panel is a slightly soft collider: chain link gives, then pushes back.
    const q = [Math.cos(p.normalAngle / 2), 0, 0, Math.sin(p.normalAngle / 2)];
    const cx = p.center[0] + Math.cos(p.normalAngle) * t;
    const cy = p.center[1] + Math.sin(p.normalAngle) * t;
    out.push(`<geom name="fence_${i}" type="box" size="${f(t)} ${f(p.length / 2)} ${f(h / 2)}" pos="${f(cx)} ${f(cy)} ${f(h / 2)}" quat="${q.map(f).join(' ')}" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" friction="0.7 0.005 0.0001" solref="0.03 0.5" solimp="0.8 0.95 0.02" rgba="0.2 0.2 0.2 0.3"/>`);
  });
  postPositions().forEach(([x, y], i) => {
    out.push(`<geom name="post_${i}" type="cylinder" size="${f(ARENA.POST_PAD_RADIUS_M)} ${f(h / 2 + 0.05)}" pos="${f(x)} ${f(y)} ${f(h / 2 + 0.05)}" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" friction="0.8 0.005 0.0001" solref="0.01 0.8" rgba="0.1 0.1 0.1 1"/>`);
  });
  return out.join('\n    ');
}

export function compileWorld(setup: MatchSetup): CompiledWorld {
  // Loadouts are applied before compile; a stock (or absent) loadout is the design as built.
  const d0 = applyLoadout(design(setup.fighters[0].design), setup.fighters[0].loadout);
  const d1 = applyLoadout(design(setup.fighters[1].design), setup.fighters[1].loadout);
  const r0 = compileRobot(d0, 0, { pos: [-ARENA.SPAWN_OFFSET_M, 0, d0.rootHeight + 0.02], yaw: 0 });
  const r1 = compileRobot(d1, 1, { pos: [ARENA.SPAWN_OFFSET_M, 0, d1.rootHeight + 0.02], yaw: Math.PI });
  const worldAff = COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;
  // Only worlds with tendon-driven hands get a <tendon> block, so stock worlds keep their exact MJCF.
  const tendons = [r0.tendonXml, r1.tendonXml].filter(Boolean);
  const tendonBlock = tendons.length ? `
  <tendon>
    ${tendons.join('\n    ')}
  </tendon>` : '';
  const xml = `<mujoco model="split-decision">
  <compiler angle="degree" autolimits="true"/>
  <option timestep="${f(setup.timestep)}" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="30" ls_iterations="10">
    <flag energy="disable"/>
  </option>
  <size memory="64M"/>
  <worldbody>
    <geom name="canvas" type="plane" size="30 30 0.1" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" friction="${f(ARENA.CANVAS_FRICTION)} 0.005 0.0001" solref="0.004 1"/>
    ${cageXml()}
${r0.bodyXml}
${r1.bodyXml}
${r0.debrisXml}
${r1.debrisXml}
  </worldbody>
  <equality>
    ${r0.equalityXml}
    ${r1.equalityXml}
  </equality>${tendonBlock}
  <actuator>
    ${r0.actuatorXml}
    ${r1.actuatorXml}
  </actuator>
  <sensor>
    ${r0.sensorXml}
    ${r1.sensorXml}
  </sensor>
</mujoco>`;
  return { xml, robots: [r0, r1] };
}
