// Skill registry.
import { ARM_STRIKES } from './arm-strikes';
import { DEFENSE } from './defense';
import { KICKS } from './kicks';
import type { SkillDef, SkillId } from './types';

export const SKILLS: Partial<Record<SkillId, SkillDef>> = Object.fromEntries([...ARM_STRIKES, ...KICKS, ...DEFENSE].map((d) => [d.id, d]));

export function skillDef(id: SkillId): SkillDef | null {
  return SKILLS[id] ?? null;
}

/** Strikes are the skills that can land a blow (and count as thrown / landed). */
export const isStrikeSkill = (def: SkillDef): boolean => def.kind === 'arm' || def.kind === 'leg';

export type { SkillDef, SkillId } from './types';
