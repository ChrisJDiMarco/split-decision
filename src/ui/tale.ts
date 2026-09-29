// Tale of the tape: the numbers a fight broadcast shows before the walkout, computed
// from the design itself (mass from the MJCF compiler, height from kinematics).
import type { AbilityId, MaterialId, RobotDesign } from '../core/types';
import { MATERIALS, motor } from '../robots/catalog';
import { compileRobot } from '../robots/compile-mjcf';
import { handsLabel } from '../robots/loadout';
import { verticalExtent } from './kinematics';
import { jointName } from './names';

export interface Tale {
  id: string;
  name: string;
  tagline: string;
  bodyType: string;
  massKg: number;
  heightM: number;
  peakTorqueNm: number;
  peakJoint: string; // readable joint name carrying the peak torque
  armor: string; // readable armor material
  frame: string;
  gyro: string; // '420 N·m' or 'NONE'
  hydraulics: string; // '210 BAR' or 'NONE'
  dof: number; // actuated joints (a dexterous hand's ten tendon joints share one drive)
  hands: string; // 'GLOVES', 'KNUCKLE PLATES', 'DEXTEROUS · 5 FINGERS'
  abilities: AbilityId[];
}

const cache = new Map<string, Tale>();

function dominantMaterial(design: RobotDesign, roles: string[]): MaterialId | null {
  const score = new Map<MaterialId, number>();
  for (const p of design.parts) {
    for (const g of p.geoms) {
      if (!roles.includes(g.role)) continue;
      score.set(g.material, (score.get(g.material) ?? 0) + 1);
    }
  }
  let best: MaterialId | null = null;
  let bestN = 0;
  for (const [m, n] of score) if (n > bestN) { best = m; bestN = n; }
  return best;
}

/** Pass the loaded design (applyLoadout) to get the tape of that loadout. */
export function taleOfTheTape(design: RobotDesign): Tale {
  const key = design.loadout ? `${design.id}:${design.loadout.hands}` : design.id;
  const hit = cache.get(key);
  if (hit) return hit;
  const compiled = compileRobot(design, 0, { pos: [0, 0, design.rootHeight], yaw: 0 });
  const [lo, hi] = verticalExtent(design);
  let peakTorqueNm = 0;
  let peakJoint = '';
  let dof = 0;
  for (const p of design.parts) {
    for (const j of p.joints ?? []) {
      if (j.passive) continue;
      dof++;
      const t = motor(j.motor).stallTorqueNm * (j.gear ?? 1);
      if (t > peakTorqueNm) { peakTorqueNm = t; peakJoint = jointName(j.name); }
    }
  }
  const armorId = dominantMaterial(design, ['armor', 'sensor']);
  const frameId = dominantMaterial(design, ['structure']);
  const hyd = design.hydraulics?.[0];
  const tale: Tale = {
    id: design.id,
    name: design.name,
    tagline: design.tagline,
    bodyType: design.bodyType,
    massKg: compiled.totalMassKg,
    heightM: hi - lo,
    peakTorqueNm,
    peakJoint,
    armor: armorId ? MATERIALS[armorId].name : '—',
    frame: frameId ? MATERIALS[frameId].name : '—',
    gyro: design.gyro ? `${Math.round(design.gyro.maxTorqueNm)} N·m` : 'NONE',
    hydraulics: hyd ? `${hyd.pressureBar} BAR` : 'NONE',
    dof: dof + (design.tendons?.length ?? 0),
    hands: handsLabel(design),
    abilities: design.abilities,
  };
  cache.set(key, tale);
  return tale;
}
