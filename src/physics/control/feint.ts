// Feints (docs/design/fighter-iq-control-contract.md §1): the real strike's windup, sold and
// telegraphed past the opponent's reflex threshold, pulled by choice before it commits.
//   which strike   head: the rear hand (cross, else overhand), else the jab; torso: the cross or the
//                  hook at the body; a leg: the low kick's windup (the front kick's if that is all);
//                  feint_left / feint_right: that hand
//   sold           the procedural strike's own windup (the same id, aim and kind), held to a fixed
//                  FEINT.windupS whatever the aggression and shown to FEINT.pullAt of it (0.21 s of
//                  motion): the hips start to turn into it, the weight goes onto the front foot, the
//                  shoulder dips; the gaze aims at the zone on its own (gaze.ts 'aim': a windup)
//   telegraph      FEINT.telegraph, so the windup the opponent reads (telegraph × progress) passes
//                  the reflex threshold (REFLEX_WINDUP 0.55, tactics.ts) by the pull
//   pulled         skills.cancel by choice (lastEnd 'cancelled'): the openings system reads it as a
//                  feint (its intent asks for one) and watches his answer
//   low            a kick's windup is the weight going onto the stance foot and the hips turning over;
//                  it is pulled at the same point, or just after the leg is lent (the knee only starts
//                  up), so the foot never leaves the canvas for long
import type { TargetZone } from '../../core/protocol';
import { canUse } from './abilities';
import type { HumanoidController } from './controller';
import { minJerk } from './math';
import { SKILLS, type SkillDef, type SkillId } from './skills';
import type { SkillRun } from './skills/types';

/** Feint tuning (exported so tools can sweep it; the worker never changes it). */
export const FEINT = {
  windupS: 0.3, // the feint's windup, s (fixed: aggression does not shorten a sell)
  pullAt: 0.7, // pulled at this share of it (0.21 s shown; the physics needs 30%)
  telegraph: 0.85, // × the pull share = 0.6 read at the pull, past REFLEX_WINDUP
  shiftM: 0.035, // weight onto the front foot, m
  dipM: 0.025, // shoulder dip (pelvis drop), m
  hipTurn: 0.12, // rad: the hips start to turn into the faked blow
  restS: 0.5, // a lone feint tactic shows its next feint no sooner than this after a pull
  legLentS: 0.04, // a low feint whose leg has been lent is pulled this soon after
};

const LEG_ZONES = new Set<TargetZone>(['left_leg', 'right_leg']);

/** The strike a feint fakes for this robot: by the zone it shows, or the hand asked for. */
export function feintSkill(c: HumanoidController, zone: TargetZone, hand?: 'l' | 'r'): SkillDef | null {
  const ok = (id: SkillId): SkillDef | null => {
    const d = SKILLS[id];
    return d && c.r.design.abilities.includes(id as never) && canUse(c.r, d) ? d : null;
  };
  if (hand === 'l') return ok('jab') ?? ok('hook');
  if (hand === 'r') return ok('cross') ?? ok('overhand') ?? ok('uppercut') ?? ok('jab');
  if (LEG_ZONES.has(zone)) return ok('low_kick') ?? ok('front_kick') ?? ok('jab');
  if (zone === 'torso') return ok('cross') ?? ok('hook') ?? ok('jab');
  return ok('cross') ?? ok('overhand') ?? ok('jab');
}

const cache = new WeakMap<SkillDef, SkillDef>();

/** The feint of a strike: the same id, kind, aim and windup motion, sold and telegraphed (cached per strike). */
export function feintOf(base: SkillDef): SkillDef {
  let f = cache.get(base);
  if (f) return f;
  // The hips turn the way the blow would turn them (a right-side blow counter-clockwise, seen from above).
  const turn = (base.side === 'l' ? -1 : 1) * FEINT.hipTurn;
  f = {
    ...base,
    telegraph: Math.max(base.telegraph, FEINT.telegraph),
    clip: undefined,
    pose(env, run, u) {
      base.pose(env, run, u);
      if (run.phase !== 'windup') return;
      const k = minJerk(Math.min(1, u / FEINT.pullAt));
      env.pose.pelvisYaw += turn * k;
      env.pose.pelvisDrop += FEINT.dipM * k;
      if (base.kind === 'arm') env.pose.weightShift = [env.pose.weightShift[0] + FEINT.shiftM * k, env.pose.weightShift[1]];
    },
  };
  cache.set(base, f);
  return f;
}

/** A feint run started now gets its fixed windup (the runner scaled it by aggression). */
export function fixFeintWindup(run: SkillRun): void {
  run.durations.windup = FEINT.windupS;
}

/** Time to pull this feint: the sold share of its windup is shown (or a low feint's leg was lent). */
export function feintDue(run: SkillRun, legLent: boolean): boolean {
  if (run.phase !== 'windup') return false;
  if (run.t >= FEINT.pullAt * run.durations.windup) return true;
  if (!legLent) return false;
  run.scratch.feintLentAt ??= run.t;
  return run.t - (run.scratch.feintLentAt as number) >= FEINT.legLentS;
}
