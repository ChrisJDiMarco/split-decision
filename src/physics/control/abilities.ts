// What a robot can still do. A skill is usable while every joint it needs still drives (not limp,
// not seized, enough hydraulic pressure) and the parts it strikes with are still attached.
import type { Tactic } from '../../core/protocol';
import type { RobotRuntime } from '../sim-context';
import { isHumanoid } from './geometry';
import { SKILLS, type SkillDef, type SkillId } from './skills';

const MIN_PRESSURE = 0.35; // below this a hydraulic joint cannot swing a strike

/**
 * The humanoid skill a tactic runs. Strikes map to themselves; tactics built for other body
 * types map to the nearest humanoid move.
 */
export const TACTIC_SKILL: Partial<Record<Tactic, SkillId>> = {
  jab: 'jab', cross: 'cross', hook: 'hook', uppercut: 'uppercut', overhand: 'overhand',
  front_kick: 'front_kick', low_kick: 'low_kick', head_kick: 'head_kick', rocket_punch: 'rocket_punch',
  guard: 'guard', clinch: 'clinch',
  hammer_smash: 'overhand', shield_bash: 'front_kick', lunge: 'cross', ram: 'front_kick',
  jaw_crush: 'clinch', cage_pin: 'clinch',
};

function jointsWork(r: RobotRuntime, def: SkillDef): boolean {
  for (const name of def.requires(def.side)) {
    const i = r.jointIndex.get(name);
    if (i === undefined) return false;
    const j = r.joints[i];
    if (j.state === 'limp' || j.state === 'seized') return false;
    if (j.hydraulicCircuit && (r.hydraulics.get(j.hydraulicCircuit)?.pressure ?? 1) < MIN_PRESSURE) return false;
  }
  return true;
}

function partsAttached(r: RobotRuntime, def: SkillDef): boolean {
  return def.strikers.every((id) => r.parts.get(id)?.attached ?? false);
}

/** Can `r` run this skill right now? */
export function canUse(r: RobotRuntime, def: SkillDef): boolean {
  return jointsWork(r, def) && partsAttached(r, def);
}

/**
 * The skills this robot can run right now: its design's abilities that the control module
 * implements, plus a guard, minus anything its damage has taken away.
 */
export function availableSkills(r: RobotRuntime): SkillId[] {
  if (!isHumanoid(r.design)) return [];
  const ids = new Set<SkillId>();
  for (const a of r.design.abilities) if (SKILLS[a as SkillId]) ids.add(a as SkillId);
  ids.add('guard');
  return [...ids].filter((id) => canUse(r, SKILLS[id]!));
}
