// The tactic vocabulary: what each Tactic means (shown to Jev as choice criteria),
// which design abilities unlock it, and how to read an opponent's skill string.
import type { Tactic } from '../core/protocol';
import type { AbilityId, RobotDesign } from '../core/types';

export type TacticKind = 'footwork' | 'strike' | 'grapple' | 'defense';

export const TACTIC_INFO: Record<Tactic, { kind: TacticKind; description: string }> = {
  hold_range: { kind: 'footwork', description: 'stay just outside his reach and make him come to you' },
  close_distance: { kind: 'footwork', description: 'walk him down into your striking range' },
  circle_left: { kind: 'footwork', description: 'circle to your left, off his power line' },
  circle_right: { kind: 'footwork', description: 'circle to your right, off his power line' },
  retreat: { kind: 'footwork', description: 'back out into open space and reset' },
  jab: { kind: 'strike', description: 'fast lead-hand punch, low commitment' },
  cross: { kind: 'strike', description: 'straight rear-hand punch, more power' },
  hook: { kind: 'strike', description: 'looping punch around the guard to the side of the head' },
  uppercut: { kind: 'strike', description: 'rising punch, best in close' },
  overhand: { kind: 'strike', description: 'big looping overhead punch, slow and heavy' },
  front_kick: { kind: 'strike', description: 'straight push kick to the body, keeps him off' },
  low_kick: { kind: 'strike', description: 'kick to the lead leg, wears down his knee' },
  head_kick: { kind: 'strike', description: 'high kick to the head: knockout power, slow, risks your balance' },
  hammer_smash: { kind: 'strike', description: 'overhead hammer drop, crushing but slow' },
  shield_bash: { kind: 'strike', description: 'drive the shield into him to knock him off balance' },
  rocket_punch: { kind: 'strike', description: 'piston-fired punch: huge impact, long reset' },
  jaw_crush: { kind: 'grapple', description: 'clamp the jaw on a limb and crush it' },
  lunge: { kind: 'strike', description: 'explosive forward lunge that covers distance' },
  ram: { kind: 'strike', description: 'drive your chassis into him at speed' },
  clinch: { kind: 'grapple', description: 'tie him up at close range and smother his strikes' },
  guard: { kind: 'defense', description: 'cover up and absorb in a tight stance' },
  feint: { kind: 'defense', description: 'show a windup without committing to draw a reaction' },
  sidestep_counter: { kind: 'defense', description: 'wait for his lunge, step off the line, strike back' },
  cage_pin: { kind: 'grapple', description: 'drive him back into the cage and trap him there' },
};

export const FOOTWORK_TACTICS: readonly Tactic[] = [
  'hold_range', 'close_distance', 'circle_left', 'circle_right', 'retreat', 'guard', 'feint', 'sidestep_counter', 'cage_pin',
];

export function isTactic(s: string): s is Tactic {
  return Object.prototype.hasOwnProperty.call(TACTIC_INFO, s);
}

export function isStrike(t: Tactic): boolean {
  const k = TACTIC_INFO[t].kind;
  return k === 'strike' || t === 'jaw_crush';
}

/** Abilities that are tactics in their own right ('spinner' and 'sprint' are passive or locomotion). */
export function abilityTactics(design: RobotDesign): Tactic[] {
  return design.abilities.filter((a: AbilityId) => isTactic(a)) as Tactic[];
}

/** Every tactic this design can run, abilities first. */
export function designTactics(design: RobotDesign): Tactic[] {
  const out = abilityTactics(design);
  for (const t of FOOTWORK_TACTICS) if (!out.includes(t)) out.push(t);
  return out;
}

/** Strikes ranked from most to least committing, used by rules to pick a finisher. */
export const FINISHER_ORDER: readonly Tactic[] = [
  'rocket_punch', 'hammer_smash', 'head_kick', 'overhand', 'jaw_crush', 'ram', 'hook', 'cross', 'uppercut', 'lunge', 'front_kick', 'low_kick', 'shield_bash', 'jab',
];

const ACTION_NAMES = Object.keys(TACTIC_INFO)
  .filter((t) => TACTIC_INFO[t as Tactic].kind !== 'footwork')
  .sort((a, b) => b.length - a.length);

/**
 * Reads a physics skill string ('strike.low_kick', 'jab-windup', 'lowKick') as the action it
 * performs. Whole words only, so 'gait.frame' is not a ram and 'guarded_walk' is not a guard.
 */
export function skillAction(skill: string): Tactic | null {
  const s = `_${skill.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_')}_`;
  for (const name of ACTION_NAMES) if (s.includes(`_${name}_`)) return name as Tactic;
  return null;
}

export function tacticWords(t: Tactic): string {
  return t.replace(/_/g, ' ');
}
