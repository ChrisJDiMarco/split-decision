// House Mind: the local behavior tree that fights whenever Jev is unreachable, and the
// "obvious tick" rules that settle a decision without a call even when Jev is online.
// Deterministic for a given (seed, corner, tick) so fallback fights replay exactly.
import type { GetupStyle, Opening, Tactic, TargetZone } from '../core/protocol';
import { creativeRoll, gambleAppetite, IMPOSSIBLE_RISK, openingMenu, type MenuItem } from './gambles';
import { zoneHealth } from './questions';
import { mixSeed, rng } from './rng';
import type { FighterContext, Situation } from './situation';
import { designCombos, styleOf } from './style';
import { abilityTactics, FINISHER_ORDER, isFlashy, isStrike, TACTIC_INFO } from './tactics';

const RULE_STREAM = 7;
const GAMBLE_STREAM = 8;
const COMBO_RULE_STREAM = 9;
/** House Mind takes an opening move this often (before its risk gate). */
const HOUSE_TAKE_OPENING = 0.6;
/** ...if its fall risk is under this times the fighter's appetite (a creative gamble: half that). */
const HOUSE_RISK_PER_APPETITE = 0.45;
/** Throws a combination instead of a single strike this often, times the appetite. */
const HOUSE_COMBO_RATE = 0.3;
/** Tries a kip-up when its risk is under this times the appetite. */
const HOUSE_KIP_PER_APPETITE = 0.35;
const HEAD_STRIKES = new Set<Tactic>(['head_kick', 'hook', 'overhand', 'uppercut', 'rocket_punch', 'hammer_smash']);
const LEG_STRIKES = new Set<Tactic>(['low_kick']);
const DAMAGED_ZONE_HP = 0.7;
const CAGE_TRAP_M = 0.6;

export interface RuleDecision {
  tactic: Tactic;
  target: TargetZone;
  aggression: number;
  counterIfLunge: Tactic;
  reason: string;
  combo?: Tactic[];
  getupStyle?: GetupStyle;
  flourish?: boolean;
  gamble?: { move: Tactic; opening: Opening | null; risk: number | null };
}

/** The House Mind's get-up call: a kip-up when this body's risk is low enough for its appetite. */
export function houseGetupStyle(fc: FighterContext, s: Situation): GetupStyle {
  const risk = s.me.moveRisk?.kip_up;
  if (risk === undefined || !Number.isFinite(risk) || risk >= IMPOSSIBLE_RISK) return 'safe';
  const appetite = gambleAppetite(styleOf(fc.design), fc.setup.temperament, 0.5);
  return risk < HOUSE_KIP_PER_APPETITE * appetite ? 'kip_up' : 'safe';
}

/** The first menu move (by style weight) whose risk the fighter's appetite accepts. */
function houseGamble(fc: FighterContext, s: Situation, seed: number, aggression: number): MenuItem | null {
  const openings = s.me.openings ?? [];
  const appetite = gambleAppetite(styleOf(fc.design), fc.setup.temperament, aggression);
  const creative = !openings.length && (s.band === 'striking range' || s.band === 'just outside reach') && creativeRoll(appetite, seed, fc.corner, s.tick);
  if (!openings.length && !creative) return null;
  if (rng(mixSeed(seed, fc.corner, s.tick, GAMBLE_STREAM))() >= HOUSE_TAKE_OPENING) return null;
  const limit = HOUSE_RISK_PER_APPETITE * appetite * (creative ? 0.5 : 1);
  const menu = openingMenu(fc.design, s.me, openings, (t) => TACTIC_INFO[t].description, creative);
  const ok = menu.items.filter((i) => i.move !== 'sidestep_counter' || s.oppPhase !== 'neutral').filter((i) => (i.risk ?? 0) < limit);
  return ok.sort((a, b) => b.weight - a.weight)[0] ?? null;
}

function houseCombo(fc: FighterContext, s: Situation, seed: number, aggression: number): Tactic[] | null {
  const combos = designCombos(fc.design);
  if (!combos.length) return null;
  const appetite = gambleAppetite(styleOf(fc.design), fc.setup.temperament, aggression);
  const u = rng(mixSeed(seed, fc.corner, s.tick, COMBO_RULE_STREAM));
  if (u() >= HOUSE_COMBO_RATE * appetite) return null;
  return combos[Math.floor(u() * Math.min(combos.length, 4))];
}

function has(fc: FighterContext, t: Tactic): boolean {
  return abilityTactics(fc.design).includes(t);
}

function baseAggression(s: Situation): number {
  const lead = s.opp.damageTotal - s.me.damageTotal;
  return Math.max(0.2, Math.min(0.9, 0.5 + lead));
}

function weakestZone(fc: FighterContext, s: Situation, fallback: TargetZone): TargetZone {
  let best: TargetZone = fallback;
  let bestHp = DAMAGED_ZONE_HP;
  for (const [zone, hp] of zoneHealth(fc.oppDesign, s.opp)) if (hp < bestHp) { best = zone; bestHp = hp; }
  return best;
}

function circleAway(s: Situation): Tactic {
  return s.geometry.cageBearingRad < 0 ? 'circle_left' : 'circle_right';
}

function finisher(fc: FighterContext): Tactic {
  const own = abilityTactics(fc.design);
  return FINISHER_ORDER.find((t) => own.includes(t)) ?? 'close_distance';
}

function pickStrike(fc: FighterContext, s: Situation, u: number): Tactic {
  const zones = zoneHealth(fc.oppDesign, s.opp);
  const legHurt = Math.min(zones.get('left_leg') ?? 1, zones.get('right_leg') ?? 1) < DAMAGED_ZONE_HP;
  const headHurt = (zones.get('head') ?? 1) < DAMAGED_ZONE_HP;
  const strikes = abilityTactics(fc.design).filter((t) => isStrike(t) && t !== 'lunge');
  if (!strikes.length) return 'close_distance';
  const w = strikes.map((t) => (t === 'jab' ? 1.5 : 1) * (legHurt && LEG_STRIKES.has(t) ? 2 : 1) * (headHurt && HEAD_STRIKES.has(t) ? 1.5 : 1));
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < strikes.length; i++) {
    acc += w[i];
    if (u * total < acc) return strikes[i];
  }
  return strikes[strikes.length - 1];
}

function strikeTarget(t: Tactic, fc: FighterContext, s: Situation): TargetZone {
  if (LEG_STRIKES.has(t)) return 'left_leg';
  return weakestZone(fc, s, HEAD_STRIKES.has(t) || t === 'jab' || t === 'cross' ? 'head' : 'torso');
}

/**
 * Settles an obvious tick locally, or returns null when the call deserves Jev.
 * Obvious: I'm down (the body is getting up), or the opponent is far and not a threat.
 */
export function obviousDecision(fc: FighterContext, s: Situation): RuleDecision | null {
  const counterIfLunge: Tactic = 'sidestep_counter';
  if (s.me.down) {
    const getupStyle = houseGetupStyle(fc, s);
    return { tactic: 'guard', target: 'torso', aggression: 0.2, counterIfLunge, reason: getupStyle === 'kip_up' ? 'down: try a kip-up' : 'down: cover up while the body gets up', getupStyle };
  }
  if (s.band === 'far' && s.geometry.oppApproachSpeed < 1.5) {
    return { tactic: 'close_distance', target: weakestZone(fc, s, 'head'), aggression: baseAggression(s), counterIfLunge, reason: 'far apart, no threat: close the distance' };
  }
  return null;
}

/** The full fallback behavior tree (first matching branch wins). */
export function houseMind(fc: FighterContext, s: Situation, seed: number): RuleDecision {
  const obvious = obviousDecision(fc, s);
  if (obvious) return obvious;
  const u = rng(mixSeed(seed, fc.corner, s.tick, RULE_STREAM))();
  const agg = baseAggression(s);
  const close = s.band === 'clinch' || s.band === 'striking range';
  const counterIfLunge: Tactic = 'sidestep_counter';
  const pack = (tactic: Tactic, aggression: number, reason: string, target?: TargetZone): RuleDecision =>
    ({ tactic, target: target ?? strikeTarget(tactic, fc, s), aggression, counterIfLunge, reason });

  if (s.oppPhase === 'down') {
    return close ? pack(finisher(fc), 1, 'opponent down: finish') : pack('close_distance', 0.9, 'opponent down: get there');
  }
  const gamble = houseGamble(fc, s, seed, agg);
  if (gamble) {
    const why = gamble.opening ? `opening (${gamble.opening.replace(/_/g, ' ')})` : 'creative gamble';
    const combo = gamble.move === 'combo' ? houseCombo(fc, s, seed, 1) ?? designCombos(fc.design)[0] : undefined;
    return {
      ...pack(gamble.move, Math.max(agg, 0.7), `${why}: ${gamble.move.replace(/_/g, ' ')}`, gamble.target ?? undefined),
      ...(combo ? { combo } : {}),
      flourish: isFlashy(gamble.move) || gamble.opening !== null,
      gamble: { move: gamble.move, opening: gamble.opening, risk: gamble.risk },
    };
  }
  if ((s.oppPhase === 'windup' || s.oppPhase === 'striking') && (close || s.band === 'just outside reach')) {
    if (s.band === 'clinch' && has(fc, 'clinch')) return pack('clinch', agg, 'incoming strike in close: tie him up', 'torso');
    return pack(u < 0.5 ? 'sidestep_counter' : 'guard', agg * 0.7, 'incoming strike: slip or cover', 'torso');
  }
  if (close && s.geometry.cageGap < CAGE_TRAP_M) return pack(circleAway(s), agg * 0.6, 'trapped on the cage: circle out', 'torso');
  if (s.band === 'clinch') {
    if (has(fc, 'clinch') && u < 0.4) return pack('clinch', agg, 'in close: clinch', 'torso');
    const inside = (['uppercut', 'hook', 'jaw_crush', 'shield_bash'] as Tactic[]).find((t) => has(fc, t));
    return inside ? pack(inside, agg, 'in close: short strike') : pack('retreat', agg * 0.5, 'in close without tools: back out', 'torso');
  }
  if (s.band === 'striking range') {
    if (s.oppPhase === 'staggered') return pack(finisher(fc), Math.max(agg, 0.85), 'opponent staggered: big shot');
    const combo = houseCombo(fc, s, seed, agg);
    if (combo) return { ...pack('combo', agg, 'in range: combination', strikeTarget(combo[0], fc, s)), combo };
    const strike = pickStrike(fc, s, u);
    return pack(strike, agg, 'in range: strike');
  }
  if (s.band === 'just outside reach') {
    if (u < 0.2) return pack('feint', agg * 0.8, 'at the edge: feint to draw him', 'torso');
    if (u < 0.4 && has(fc, 'front_kick')) return pack('front_kick', agg, 'at the edge: long kick', 'torso');
    return pack('close_distance', agg, 'at the edge: step in', 'head');
  }
  return pack('close_distance', agg, 'out of range: close in', 'head');
}
