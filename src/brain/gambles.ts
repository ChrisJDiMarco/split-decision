// Openings and gambles: the words for what a fighter sees on its opponent, the risk bands for its
// flashy moves, and the opening_move menu (flashy and opportunistic moves that fit right now).
// Code finds the openings and prices the risk; Jev only chooses.
import type { FlashyMove, Opening, RobotTelemetry, Tactic, TargetZone } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import { jointGroupName } from './bands';
import { mixSeed, rng } from './rng';
import { canThrow, styleOf, styleWeight, type StyleProfile } from './style';
import { isFlashy, skillAction, tacticWords } from './tactics';

// ---------------------------------------------------------------- words

const OPENING_WORDS: Record<Opening, string> = {
  off_balance: "he's off balance",
  turned_away: "he's turned away from you",
  missed_recovering: 'he just missed and is recovering',
  stunned: "he's rocked from a hard shot",
  rising: "he's getting up off the canvas",
  on_cage: 'his back is on the cage',
  gyro_saturated: "his gyro is saturated, he can't catch a stumble",
  weak_left_leg: 'his left leg is failing',
  weak_right_leg: 'his right leg is failing',
  low_guard: 'his hands are down',
  overcommitted: "he's overcommitted",
};

/** The worst leg joint on one side, as words ('left knee'), from telemetry. */
function weakJointWords(opp: RobotTelemetry, side: 'l' | 'r'): string | null {
  let worst: { name: string; health: number } | null = null;
  for (const j of opp.joints) {
    if (!/^(knee|hip_pitch|hip_roll|hip_yaw)_[lr]$/.test(j.name) || !j.name.endsWith(`_${side}`)) continue;
    if (!worst || j.health < worst.health) worst = { name: j.name, health: j.health };
  }
  return worst ? jointGroupName(worst.name) : null;
}

/** One opening in words, using the opponent's telemetry for specifics ("his left knee is failing"). */
export function openingWords(o: Opening, opp: RobotTelemetry): string {
  const action = skillAction(opp.skill);
  if (o === 'missed_recovering' && action) return `he just missed a ${tacticWords(action)} and is recovering`;
  if (o === 'overcommitted' && action) return `he's overcommitted to a ${tacticWords(action)}`;
  if (o === 'weak_left_leg' || o === 'weak_right_leg') {
    const joint = weakJointWords(opp, o === 'weak_left_leg' ? 'l' : 'r');
    if (joint) return `his ${joint} is failing`;
  }
  return OPENING_WORDS[o];
}

export function openingsWords(openings: readonly Opening[], opp: RobotTelemetry): string {
  return openings.length ? openings.map((o) => openingWords(o, opp)).join('; ') : 'no clear opening';
}

export function riskBand(risk: number): string {
  if (risk >= 0.97) return 'impossible right now';
  if (risk >= 0.65) return 'very high fall risk';
  if (risk >= 0.4) return 'high fall risk';
  if (risk >= 0.2) return 'moderate fall risk';
  return 'low fall risk';
}

// ---------------------------------------------------------------- menu

const PAYOFF: Record<string, string> = {
  tornado_kick: 'a knockout if it lands, and the crowd loses it',
  spinning_back_kick: 'drives the air out of him, can fold him in half',
  jump_kick: 'covers the gap in one leap and knocks him back',
  jumping_knee: 'a fight-ending shot to the chin or body',
  superman_punch: 'a long straight punch that catches him flat-footed',
  spinning_backfist: 'a whip-crack shot to the head from nowhere',
};

/** Which moves exploit each opening, best first. */
const EXPLOITS: Record<Opening, Tactic[]> = {
  turned_away: ['jump_kick', 'superman_punch', 'head_kick', 'cross', 'low_kick'],
  off_balance: ['front_kick', 'low_kick', 'superman_punch', 'cage_pin', 'jump_kick'],
  missed_recovering: ['spinning_backfist', 'cross', 'hook', 'head_kick', 'tornado_kick'],
  stunned: ['jumping_knee', 'tornado_kick', 'head_kick', 'overhand', 'combo', 'hook'],
  rising: ['head_kick', 'front_kick', 'jumping_knee', 'low_kick'],
  on_cage: ['cage_pin', 'jumping_knee', 'combo', 'uppercut', 'clinch'],
  gyro_saturated: ['low_kick', 'front_kick', 'spinning_back_kick', 'jump_kick'],
  weak_left_leg: ['low_kick', 'front_kick'],
  weak_right_leg: ['low_kick', 'front_kick'],
  low_guard: ['head_kick', 'spinning_backfist', 'superman_punch', 'hook', 'tornado_kick', 'overhand'],
  overcommitted: ['sidestep_counter', 'spinning_backfist', 'cross', 'jumping_knee', 'spinning_back_kick'],
};

const OPPORTUNE_WHY: Record<Opening, string> = {
  turned_away: 'his back is to you',
  off_balance: 'one shove and he goes over',
  missed_recovering: 'he is out of position after the miss',
  stunned: 'he cannot defend right now',
  rising: 'he cannot defend while he rises',
  on_cage: 'he has nowhere to go',
  gyro_saturated: 'he cannot catch a stumble',
  weak_left_leg: 'his left leg will buckle',
  weak_right_leg: 'his right leg will buckle',
  low_guard: 'his head is open',
  overcommitted: 'his weight is committed forward',
};

const TARGET_FOR: Partial<Record<Opening, TargetZone>> = {
  weak_left_leg: 'left_leg', weak_right_leg: 'right_leg', low_guard: 'head', stunned: 'head',
};

const FOOTWORK_OK = new Set<Tactic>(['sidestep_counter', 'cage_pin', 'combo']);
const MAX_MOVES = 8;
export const NONE = 'none';
/** A move whose risk is at least this is not offered: it cannot be attempted at all. */
export const IMPOSSIBLE_RISK = 0.97;
/** With no opening, how often (times the gamble appetite) a creative gamble is still offered. */
export const CREATIVE_RATE = 0.12;
const CREATIVE_STREAM = 11;

export interface MenuItem {
  move: Tactic;
  risk: number | null; // flashy moves only
  target: TargetZone | null;
  opening: Opening | null; // the opening it exploits (null: a creative gamble)
  weight: number; // style prior
  description: string;
}

export interface OpeningMenu {
  items: MenuItem[];
  creative: boolean; // offered without an opening, as a gamble
}

function riskOf(me: RobotTelemetry, t: Tactic): number | null {
  if (!isFlashy(t)) return null;
  const r = me.moveRisk?.[t];
  return Number.isFinite(r) ? (r as number) : null;
}

function describeItem(item: Omit<MenuItem, 'description'>, info: string): string {
  const parts = [info];
  if (item.opening) parts.push(OPPORTUNE_WHY[item.opening]);
  if (item.risk !== null) parts.push(riskBand(item.risk));
  const payoff = PAYOFF[item.move];
  if (payoff) parts.push(`payoff: ${payoff}`);
  return parts.join('; ');
}

function usable(design: RobotDesign, me: RobotTelemetry, t: Tactic): boolean {
  if (!FOOTWORK_OK.has(t) && !canThrow(design, t)) return false;
  if (t === 'cage_pin' && !canThrow(design, 'clinch')) return false;
  const risk = riskOf(me, t);
  return risk === null || risk < IMPOSSIBLE_RISK;
}

/**
 * The opening_move menu: moves that exploit the current openings (in the order the openings
 * matter), then, when there is no opening, the style's own flashy gambles. `describe` gives the
 * base description of a tactic.
 */
export function openingMenu(design: RobotDesign, me: RobotTelemetry, openings: readonly Opening[], describe: (t: Tactic) => string, creative: boolean): OpeningMenu {
  const style = styleOf(design);
  const byMove = new Map<Tactic, MenuItem>();
  const add = (move: Tactic, opening: Opening | null) => {
    if (byMove.has(move) || byMove.size >= MAX_MOVES || !usable(design, me, move)) return;
    const risk = riskOf(me, move);
    const base = { move, risk, target: opening ? TARGET_FOR[opening] ?? null : null, opening, weight: styleWeight(style, move) };
    byMove.set(move, { ...base, description: describeItem(base, describe(move)) });
  };
  // Round-robin over the openings so each gets its best exploit before any gets a second one.
  const lists = openings.map((o) => EXPLOITS[o].map((t) => [t, o] as const));
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) add(l[i][0], l[i][1]);
  if (creative) for (const t of flashyByStyle(style)) add(t, null);
  return { items: [...byMove.values()], creative: creative && openings.length === 0 };
}

/** The style's flashy moves, most characteristic first. */
function flashyByStyle(style: StyleProfile): Tactic[] {
  const flashy: Tactic[] = ['tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist'];
  return flashy.sort((a, b) => styleWeight(style, b) - styleWeight(style, a));
}

// ---------------------------------------------------------------- appetite

/**
 * How readily this fighter gambles: its style, its temperament (0.3 disciplined .. 1.8 wild) and
 * the aggression it is fighting at. 1 is neutral; about 0.3 to 2.5.
 */
export function gambleAppetite(style: StyleProfile, temperament: number, aggression: number): number {
  const g = style.gamble * (0.5 + 0.5 * temperament) * (0.6 + 0.8 * aggression);
  return Math.max(0.3, Math.min(2.5, g));
}

/** With no opening, is a creative gamble offered on this tick? Seeded, so replays match. */
export function creativeRoll(appetite: number, seed: number, corner: number, tick: number): boolean {
  return rng(mixSeed(seed, corner, tick, CREATIVE_STREAM))() < CREATIVE_RATE * appetite;
}

/**
 * Re-weights Jev's opening_move distribution by the style prior, the appetite and each move's risk:
 * move weight = p · style · appetite · (1 − risk)^(1/appetite); 'none' keeps its p. A bold fighter
 * discounts risk less; a disciplined one shies away from a high-risk gamble even when Jev likes it.
 */
export function gambleWeights(probs: Record<string, number>, items: readonly MenuItem[], appetite: number): Record<string, number> {
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [k, p] of Object.entries(probs)) {
    const item = items.find((i) => i.move === k);
    const w = k === NONE || !item ? p : p * item.weight * appetite * Math.pow(1 - (item.risk ?? 0), 1 / appetite);
    out[k] = w;
    sum += w;
  }
  if (sum > 0) for (const k of Object.keys(out)) out[k] /= sum;
  return out;
}

/** Flashy moves this design can attempt at all (for the risk list in the state). */
export function designFlashy(design: RobotDesign): FlashyMove[] {
  const moves: FlashyMove[] = ['tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist'];
  return [...moves.filter((m) => canThrow(design, m as Tactic)), 'kip_up'];
}
