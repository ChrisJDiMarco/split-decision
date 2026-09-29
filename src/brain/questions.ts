// The typed questions each fighter asks Jev per decision. Options depend on the
// fighter's design (its abilities) and on what is still attached to the opponent.
import type { RobotTelemetry, Tactic, TargetZone } from '../core/protocol';
import type { PartDef, RobotDesign } from '../core/types';
import { hpWords } from './bands';
import { NONE, NOTHING, riskBand, type MenuItem, type OpeningMenu } from './gambles';
import type { JevQuestion } from './jev-client';
import type { SetupCombo } from './setups';
import type { FighterContext } from './situation';
import { COMBO_MAX, comboId, styleOf } from './style';
import { designTactics, TACTIC_INFO, tacticWords } from './tactics';

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
  /** opening_move options (empty when not asked); the choice keys are their moves plus 'none'. */
  menu: MenuItem[];
  creative: boolean; // the menu is a creative gamble with no opening
  combos: Tactic[][]; // combo options (empty when not asked)
  setups: SetupCombo[]; // setup → payoff options in the same combo question (empty when not asked)
  getup: boolean; // getup_style asked
  /** on_opening options (empty when not asked); the choice keys are their moves plus 'nothing'. */
  reflex: MenuItem[];
}

/** The optional questions for one decision (all ride in the same Jev call). */
export interface ExtraQuestions {
  menu?: OpeningMenu | null; // ask opening_move when it has items
  combos?: Tactic[][] | null; // ask combo (and offer 'combo' as a tactic) when non-empty
  setups?: SetupCombo[] | null; // setup → payoff combinations, offered in the combo question
  kipRisk?: number | null; // ask getup_style (only when down)
  reflex?: MenuItem[] | null; // ask on_opening (the pre-armed reflex) when non-empty
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

export function comboWords(c: readonly Tactic[]): string {
  return c.map(tacticWords).join(', ');
}

export function openingMoveQuestion(menu: OpeningMenu): JevQuestion {
  const criteria: Record<string, string> = Object.fromEntries(menu.items.map((i) => [i.move, i.description]));
  criteria[NONE] = menu.creative ? 'no gamble: keep to the plan' : 'let the opening go and stay patient';
  const instructions = menu.creative
    ? 'There is no clear opening. Should `you` try a creative gamble right now, given the fall risks in `you.flashy_risk`, your `personality` and your `record`?'
    : 'The `opponent` shows an opening (see `opponent.openings`). Which move should `you` go for right now, weighing each fall risk and payoff against your `personality` and your `record`?';
  return { type: 'choice', instructions, criteria };
}

/** A setup → payoff option as Jev reads it: "setup, then payoff: <why>". */
export function setupWords(c: SetupCombo): string {
  return `setup: ${c.why}`;
}

export function comboQuestion(fc: FighterContext, combos: readonly Tactic[][], setups: readonly SetupCombo[] = []): JevQuestion {
  const style = styleOf(fc.design);
  const signature = new Set(style.combos.map(comboId));
  const lead = combos.findIndex((c) => !signature.has(comboId(c)));
  const n = lead < 0 ? combos.length : lead; // signature combos come first (designCombos)
  const note = n ? ` The first ${n === 1 ? 'one is a signature combination' : `${n} are signature combinations`} for ${style.words.split(':')[0]}.` : '';
  const fool = setups.length ? ' Setups fool him first (his `habits`), then hit what that opens (his `weak_spots`).' : '';
  const criteria: Record<string, string> = Object.fromEntries(combos.map((c) => [comboId(c), comboWords(c)]));
  for (const c of setups) criteria[c.id] = setupWords(c);
  return { type: 'choice', instructions: `If \`you\` throw a combination next, which one fits this moment and \`plan\` best?${fool}${note}`, criteria };
}

/** "If he whiffs or overcommits in the next second, what do you throw?": the pre-armed reflex. */
export function onOpeningQuestion(items: readonly MenuItem[]): JevQuestion {
  const criteria: Record<string, string | null> = Object.fromEntries(items.map((i) => [i.move, i.description || null]));
  criteria[NOTHING] = 'nothing: stay on the plan';
  return {
    type: 'choice',
    instructions: 'If the `opponent` whiffs a strike or overcommits in the next second, what do `you` throw the instant it happens? It fires on reflex, before you can think again; weigh each fall risk against your `personality` and your `record`.',
    criteria,
  };
}

/** Plain odds for a kip-up from its risk ("it usually works for your body right now"). */
export function kipOddsWords(kipRisk: number): string {
  if (kipRisk < 0.2) return 'it almost always works for your body right now';
  if (kipRisk < 0.4) return 'it usually works for your body right now';
  if (kipRisk < 0.65) return 'it works about half the time for your body right now';
  return 'it usually fails for your body right now';
}

export function getupQuestion(kipRisk: number): JevQuestion {
  return {
    type: 'noul',
    instructions: `\`you\` are down on the canvas. Should \`you\` try a kip-up (spring straight up off your back: fast and spectacular, the crowd loves it; ${riskBand(kipRisk)}, ${kipOddsWords(kipRisk)}; a failed one costs a second on the canvas) instead of the safe get-up?`,
  };
}

export function buildQuestions(fc: FighterContext, opp: RobotTelemetry, extras: ExtraQuestions = {}): QuestionSet {
  const setups = extras.setups?.length ? extras.setups : [];
  const combos = extras.combos?.length ? extras.combos.slice(0, Math.max(0, COMBO_MAX - setups.length)) : [];
  const tactics = combos.length || setups.length ? [...designTactics(fc.design), 'combo' as Tactic] : designTactics(fc.design);
  const zones = targetOptions(fc.oppDesign, opp);
  const counters = counterOptions(fc.design);
  const menu = extras.menu?.items.length ? extras.menu : null;
  const kip = extras.kipRisk !== undefined && extras.kipRisk !== null && Number.isFinite(extras.kipRisk);
  const reflex = extras.reflex?.length ? extras.reflex : [];
  const extra: Record<string, JevQuestion> = {};
  if (menu) extra.opening_move = openingMoveQuestion(menu);
  if (reflex.length) extra.on_opening = onOpeningQuestion(reflex);
  if (combos.length || setups.length) extra.combo = comboQuestion(fc, combos, setups);
  if (kip) extra.getup_style = getupQuestion(extras.kipRisk as number);
  return {
    tactics,
    targets: [...zones.keys()],
    counters,
    menu: menu?.items ?? [],
    creative: menu?.creative ?? false,
    combos,
    setups,
    getup: kip,
    reflex,
    questions: {
      ...extra,
      tactic: { type: 'choice', instructions: 'Which tactic should `you` run for the next second, following `plan` and `personality`?', criteria: describe(tactics) },
      target: { type: 'choice', instructions: 'Where on the `opponent` should `you` aim right now?', criteria: Object.fromEntries(zones) },
      opp_commit: { type: 'noul', instructions: 'Will the `opponent` commit to a strike or lunge within the next half second?' },
      counter_if_lunge: { type: 'choice', instructions: 'If the `opponent` lunges at `you` right now, what should `you` do?', criteria: describe(counters) },
      aggression: { type: 'score', instructions: 'How aggressive should `you` be for the next two seconds?', criteria: AGGRESSION_LEVELS },
      winning: { type: 'score', instructions: 'Who is winning this round so far?', criteria: WINNING_LEVELS },
    },
  };
}
