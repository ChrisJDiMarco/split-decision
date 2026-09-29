// Setup → payoff combinations: fool him first, then hit what the setup exposes.
//   fake_high_go_low   feint high to lift his guard, then a low kick or a body shot
//   fake_low_go_high   feint low to drop his hands, then a head shot
//   jab_draw           a real jab to make him cover, then the body or the legs
//   low_kick_high      a real low kick, then straight upstairs while he checks it
//   rhythm_break       jab, jab, a pause, then the burst: he times the rhythm and walks onto it
//   draw_counter       feint to draw his counter, then hit over it (only if he throws back at feints)
//   switch_kick        switch stance, then kick from the new side
// Built from the design's abilities and style, the weak-spot map (where the payoff lands) and the
// habit model (which feints he bites on). Code builds the menu; Jev picks in the same call.
import type { BiteReaction, ComboPlan, FeintLevel, Habit, RobotTelemetry, Tactic, TargetZone, WeakSpot } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import { moveReady } from './limbs';
import { strikeFor, zoneName, zoneNote } from './scouting';
import { canThrow, styleOf, styleWeight, type StyleId } from './style';
import { tacticWords } from './tactics';

export type SetupKind = 'fake_high_go_low' | 'fake_low_go_high' | 'jab_draw' | 'low_kick_high' | 'rhythm_break' | 'draw_counter' | 'switch_kick';

export interface SetupCombo {
  id: string; // the choice key Jev sees ('fake_high_go_low'), unique in the menu
  kind: SetupKind;
  steps: Tactic[];
  zones: TargetZone[];
  setup: number; // leading steps that are the setup
  payoffZone: TargetZone;
  fishing: BiteReaction;
  tempo?: number[];
  weight: number; // prior (style, habits, the weak spot the payoff lands on)
  why: string; // one line for Jev and the HUD
}

export const MAX_SETUPS = 3;
/** The pause before the burst of a rhythm break, seconds. */
export const RHYTHM_PAUSE_S = 0.45;

/** Which setups each style reaches for (1 = neutral). */
const STYLE_KIND: Record<StyleId, Partial<Record<SetupKind, number>>> = {
  swarmer: { jab_draw: 1.4, rhythm_break: 1.4, fake_low_go_high: 1.1, fake_high_go_low: 1.1, draw_counter: 1.1 },
  kickboxer: { fake_high_go_low: 1.4, low_kick_high: 1.5, switch_kick: 1.3, jab_draw: 1.1 },
  pressure: { jab_draw: 1.3, fake_low_go_high: 1.3, rhythm_break: 1.2, draw_counter: 1.2 },
  distance: { fake_high_go_low: 1.3, switch_kick: 1.4, low_kick_high: 1.2, rhythm_break: 1.1 },
  brawler: { jab_draw: 1.2, fake_high_go_low: 1.1 },
};

const FOOTWORK_STEPS = new Set<Tactic>(['feint', 'switch_stance']);
const LEGS: readonly TargetZone[] = ['left_leg', 'right_leg'];

/**
 * How much a feint at `level` is worth against him, from the habit model: his bite rate,
 * Laplace-smoothed (n + 1) / (of + 2) so no data reads as a coin flip, as a multiplier (2p)^1.3:
 * 1 with no data, ~0.25 when he never bites (0 of 4), ~1.9 when he always does (4 of 4).
 */
export function biteFactor(habits: readonly Habit[] | undefined, level: FeintLevel): number {
  const h = habits?.find((x) => x.kind === 'bites' && x.level === level);
  const p = h ? (h.n + 1) / (h.of + 2) : 0.5;
  return Math.pow(2 * p, 1.3);
}

function counters(habits: readonly Habit[] | undefined): boolean {
  const h = habits?.find((x) => x.kind === 'counters');
  return !!h && h.n / h.of >= 0.4;
}

/** The best weak spot among `zones` (null: none of them is weak). */
function bestSpot(spots: readonly WeakSpot[], zones: readonly TargetZone[]): WeakSpot | null {
  return spots.filter((s) => zones.includes(s.zone)).sort((a, b) => b.score - a.score)[0] ?? null;
}

/** His lead leg (the one a low kick reaches first), from his published stance. */
function leadLeg(opp: RobotTelemetry): TargetZone {
  return opp.stance === 'southpaw' ? 'right_leg' : 'left_leg';
}

/** The limb a feint shows with at each level: an arm strike high or to the body, a kick low. */
const FEINT_LIMBS: Record<'arm' | 'leg', readonly Tactic[]> = { arm: ['jab', 'cross'], leg: ['low_kick', 'front_kick'] };

function throwable(design: RobotDesign, me: RobotTelemetry, t: Tactic, zone?: TargetZone): boolean {
  if (t === 'feint') {
    const limbs = FEINT_LIMBS[zone && LEGS.includes(zone) ? 'leg' : 'arm'];
    return limbs.some((l) => canThrow(design, l) && moveReady(me, l));
  }
  return FOOTWORK_STEPS.has(t) || (canThrow(design, t) && moveReady(me, t));
}

function first(design: RobotDesign, me: RobotTelemetry, prefs: readonly Tactic[]): Tactic | null {
  return prefs.find((t) => throwable(design, me, t)) ?? null;
}

function payoffWords(move: Tactic, zone: TargetZone, spots: readonly WeakSpot[]): string {
  const note = zoneNote(spots, zone);
  return `${tacticWords(move)}${zone === 'head' ? '' : ` his ${zoneName(zone)}`}${note ? ` (${note})` : ''}`;
}

/**
 * 0 to MAX_SETUPS setup → payoff combinations for this moment, best first. `me` carries the
 * weak-spot map and habits (RobotTelemetry.weakSpots, .habits); `opp` its stance.
 */
export function setupCombos(design: RobotDesign, me: RobotTelemetry, opp: RobotTelemetry): SetupCombo[] {
  const style = styleOf(design);
  const spots = me.weakSpots ?? [];
  const habits = me.habits;
  const out: SetupCombo[] = [];
  const push = (c: Omit<SetupCombo, 'weight'>, weight: number) => {
    if (!c.steps.every((t, i) => throwable(design, me, t, c.zones[i]))) return;
    const spot = spots.find((s) => s.zone === c.payoffZone);
    const w = weight * (STYLE_KIND[style.id][c.kind] ?? 1) * styleWeight(style, c.steps[c.steps.length - 1]) * (0.6 + (spot?.score ?? 0));
    out.push({ ...c, weight: w });
  };
  const lowSpot = bestSpot(spots, [...LEGS, 'torso']);
  const lowZone = lowSpot?.zone ?? leadLeg(opp);
  const lowMove = strikeFor(design, me, lowSpot ?? { zone: lowZone, score: 0, reasons: [] });
  const headSpot = bestSpot(spots, ['head']) ?? { zone: 'head' as TargetZone, score: 0, reasons: [] };
  const headMove = strikeFor(design, me, headSpot) ?? first(design, me, ['cross', 'hook', 'jab']);
  // A kicker's level change: the low fake drops his hands, the head kick goes over them.
  const kicker = style.id === 'kickboxer' || style.id === 'distance';
  const overTheTop = (kicker ? first(design, me, ['head_kick']) : null) ?? headMove;

  if (lowMove) {
    push({
      id: 'fake_high_go_low', kind: 'fake_high_go_low', steps: ['feint', lowMove], zones: ['head', lowZone], setup: 1, payoffZone: lowZone, fishing: 'covered',
      why: `feint high to lift his guard, then ${payoffWords(lowMove, lowZone, spots)}`,
    }, biteFactor(habits, 'high'));
  }
  if (overTheTop) {
    push({
      id: 'fake_low_go_high', kind: 'fake_low_go_high', steps: ['feint', overTheTop], zones: [leadLeg(opp), 'head'], setup: 1, payoffZone: 'head', fishing: 'covered',
      why: `feint low to drop his hands, then ${payoffWords(overTheTop, 'head', spots)}`,
    }, biteFactor(habits, 'low'));
  }
  if (lowMove && canThrow(design, 'jab')) {
    push({
      id: 'jab_draw', kind: 'jab_draw', steps: ['jab', lowMove], zones: ['head', lowZone], setup: 1, payoffZone: lowZone, fishing: 'covered',
      why: `jab to make him cover, then ${payoffWords(lowMove, lowZone, spots)}`,
    }, 1);
  }
  const highKick = first(design, me, ['head_kick', 'overhand', 'cross']);
  if (highKick && canThrow(design, 'low_kick')) {
    const leg = bestSpot(spots, LEGS)?.zone ?? leadLeg(opp);
    push({
      id: 'low_kick_high', kind: 'low_kick_high', steps: ['low_kick', highKick], zones: [leg, 'head'], setup: 1, payoffZone: 'head', fishing: 'covered',
      why: `low kick his ${zoneName(leg)}, then straight upstairs with a ${payoffWords(highKick, 'head', spots)}`,
    }, 1);
  }
  const burst = first(design, me, ['cross', 'hook', 'overhand']);
  const burst2 = first(design, me, ['hook', 'uppercut', 'low_kick', 'cross']);
  if (burst && canThrow(design, 'jab')) {
    const steps: Tactic[] = burst2 && burst2 !== burst ? ['jab', 'jab', burst, burst2] : ['jab', 'jab', burst];
    const pz: TargetZone = burst2 === 'low_kick' ? lowZone : 'head';
    push({
      id: 'rhythm_break', kind: 'rhythm_break', steps, zones: steps.map((t) => (t === 'low_kick' ? lowZone : 'head')), setup: 2, payoffZone: pz, fishing: 'retreated',
      tempo: steps.map((_, i) => (i === 2 ? RHYTHM_PAUSE_S : 0)),
      why: `jab, jab, a pause, then the burst: ${steps.slice(2).map(tacticWords).join(', ')}`,
    }, 0.9);
  }
  if (counters(habits) && headMove) {
    push({
      id: 'draw_counter', kind: 'draw_counter', steps: ['feint', headMove], zones: ['head', 'head'], setup: 1, payoffZone: 'head', fishing: 'countered',
      why: `he throws back at feints: draw it, then ${payoffWords(headMove, 'head', spots)} over it`,
    }, 1.4);
  }
  const switchKick = first(design, me, ['head_kick', 'low_kick']);
  if (switchKick && (style.id === 'kickboxer' || style.id === 'distance')) {
    const zone: TargetZone = switchKick === 'low_kick' ? (leadLeg(opp) === 'left_leg' ? 'right_leg' : 'left_leg') : 'head';
    push({
      id: 'switch_kick', kind: 'switch_kick', steps: ['switch_stance', switchKick], zones: ['torso', zone], setup: 1, payoffZone: zone, fishing: 'flinched',
      why: `switch stance to change the angle, then ${payoffWords(switchKick, zone, spots)}`,
    }, 0.8);
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, MAX_SETUPS);
}

const FEINT_TACTICS = new Set<Tactic>(['feint', 'feint_left', 'feint_right']);

/**
 * Jev picked a plain tactic that is this setup's first move (a feint for a fake, the jab for a jab
 * draw, the low kick for low-kick-high) while its combo answer was this setup: it wants the setup.
 */
export function opensSetup(tactic: Tactic, c: SetupCombo): boolean {
  const first = c.steps[0];
  return tactic === first || (FEINT_TACTICS.has(tactic) && FEINT_TACTICS.has(first));
}

/** The Intent's comboPlan for a setup combination. */
export function planOf(c: SetupCombo): ComboPlan {
  return { setup: c.setup, zones: [...c.zones], payoffZone: c.payoffZone, fishing: c.fishing, ...(c.tempo ? { tempo: [...c.tempo] } : {}) };
}

/** 'feint' at a zone reads as its level on the HUD: FEINT HIGH / FEINT BODY / FEINT LOW. */
export function stepLabel(t: Tactic, zone: TargetZone | undefined): string {
  if (t === 'feint' || t === 'feint_left' || t === 'feint_right') {
    const level = zone === undefined || zone === 'head' ? 'high' : zone === 'torso' ? 'body' : 'low';
    return `feint ${level}`;
  }
  return tacticWords(t);
}
