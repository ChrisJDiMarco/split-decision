// The typed questions each fighter asks Jev per decision. Options depend on the
// fighter's design (its abilities) and on what is still attached to the opponent.
import type { RobotTelemetry, Tactic, TargetZone } from '../core/protocol';
import type { PartDef, RobotDesign } from '../core/types';
import { hpWords } from './bands';
import type { JevQuestion } from './jev-client';
import type { FighterContext } from './situation';
import { designTactics, TACTIC_INFO } from './tactics';

export const AGGRESSION_LEVELS = ['fully defensive', 'cautious', 'balanced', 'pressing', 'all-out'];
export const WINNING_LEVELS = ['opponent clearly', 'opponent slightly', 'even', 'you slightly', 'you clearly'];

const COUNTER_BASE: readonly Tactic[] = ['sidestep_counter', 'guard', 'retreat', 'circle_left', 'circle_right'];
const COUNTER_STRIKES: readonly Tactic[] = [
  'jab', 'cross', 'hook', 'uppercut', 'front_kick', 'low_kick', 'shield_bash', 'clinch', 'hammer_smash', 'jaw_crush',
];

const ZONE_WORDS: Record<TargetZone, string> = {
  head: 'his head and sensors',
  torso: 'his torso and core',
  left_arm: 'his left arm',
  right_arm: 'his right arm',
  left_leg: 'his left leg',
  right_leg: 'his right leg',
  weapon: 'his weapon',
};

export interface QuestionSet {
  questions: Record<string, JevQuestion>;
  tactics: Tactic[];
  targets: TargetZone[];
  counters: Tactic[];
}

/** Which target zone a part belongs to, from its tags. */
export function partZone(part: Pick<PartDef, 'tags'>): TargetZone | null {
  const t = new Set<string>(part.tags);
  if (t.has('head') || t.has('neck')) return 'head';
  if (t.has('hammer') || t.has('spinner') || t.has('jaw') || t.has('shield')) return 'weapon';
  const side = t.has('left') ? 'left' : t.has('right') ? 'right' : null;
  const arm = t.has('upperarm') || t.has('forearm') || t.has('fist');
  const leg = t.has('thigh') || t.has('shin') || t.has('foot') || t.has('leg') || t.has('wheel');
  if (side && arm) return `${side}_arm`;
  if (side && leg) return `${side}_leg`;
  if (t.has('torso') || t.has('pelvis') || t.has('chassis') || t.has('armor') || t.has('gyro')) return 'torso';
  return null;
}

/** Worst hp (0..1) of the still-attached parts in each opponent zone. */
export function zoneHealth(oppDesign: RobotDesign, opp: RobotTelemetry): Map<TargetZone, number> {
  const tel = new Map(opp.parts.map((p) => [p.id, p]));
  const worst = new Map<TargetZone, number>();
  for (const part of oppDesign.parts) {
    const zone = partZone(part);
    const pt = tel.get(part.id);
    if (!zone || (pt && !pt.attached)) continue;
    worst.set(zone, Math.min(worst.get(zone) ?? 1, pt?.hp ?? 1));
  }
  return worst;
}

/** Zones still worth aiming at, with a short condition note for each. */
export function targetOptions(oppDesign: RobotDesign, opp: RobotTelemetry): Map<TargetZone, string> {
  const worst = zoneHealth(oppDesign, opp);
  const out = new Map<TargetZone, string>();
  for (const zone of Object.keys(ZONE_WORDS) as TargetZone[]) {
    if (!worst.has(zone)) continue;
    const cond = hpWords(worst.get(zone) ?? 1);
    out.set(zone, cond ? `${ZONE_WORDS[zone]}, armor ${cond}` : ZONE_WORDS[zone]);
  }
  if (!out.size) out.set('torso', ZONE_WORDS.torso);
  return out;
}

export function counterOptions(design: RobotDesign): Tactic[] {
  const own = new Set<string>(design.abilities);
  return [...COUNTER_BASE, ...COUNTER_STRIKES.filter((t) => own.has(t))];
}

function describe(tactics: readonly Tactic[]): Record<string, string> {
  return Object.fromEntries(tactics.map((t) => [t, TACTIC_INFO[t].description]));
}

export function buildQuestions(fc: FighterContext, opp: RobotTelemetry): QuestionSet {
  const tactics = designTactics(fc.design);
  const zones = targetOptions(fc.oppDesign, opp);
  const counters = counterOptions(fc.design);
  return {
    tactics,
    targets: [...zones.keys()],
    counters,
    questions: {
      tactic: { type: 'choice', instructions: 'Which tactic should `you` run for the next second, following `plan` and `personality`?', criteria: describe(tactics) },
      target: { type: 'choice', instructions: 'Where on the `opponent` should `you` aim right now?', criteria: Object.fromEntries(zones) },
      opp_commit: { type: 'noul', instructions: 'Will the `opponent` commit to a strike or lunge within the next half second?' },
      counter_if_lunge: { type: 'choice', instructions: 'If the `opponent` lunges at `you` right now, what should `you` do?', criteria: describe(counters) },
      aggression: { type: 'score', instructions: 'How aggressive should `you` be for the next two seconds?', criteria: AGGRESSION_LEVELS },
      winning: { type: 'score', instructions: 'Who is winning this round so far?', criteria: WINNING_LEVELS },
    },
  };
}
