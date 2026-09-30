// House Mind: the local behavior tree that fights whenever Jev is unreachable, and the
// "obvious tick" rules that settle a decision without a call even when Jev is online.
// Deterministic for a given (seed, corner, tick) so fallback fights replay exactly.
import type { ComboPlan, GetupStyle, Opening, Tactic, TargetZone } from '../core/protocol';
import { creativeRoll, gambleAppetite, openingMenu, reflexArming, reflexMenu, type MenuItem } from './gambles';
import { readyCombos } from './limbs';
import { sampleKip } from './policy';
import { zoneHealth } from './questions';
import { mixSeed, rng } from './rng';
import type { FighterContext, Situation } from './situation';
import { planOf, setupCombos } from './setups';
import { designCombos, styleOf } from './style';
import { abilityTactics, FINISHER_ORDER, isFlashy, isStrike, TACTIC_INFO } from './tactics';

const RULE_STREAM = 7;
const GAMBLE_STREAM = 8;
const COMBO_RULE_STREAM = 9;
const REFLEX_RULE_STREAM = 12;
const SETUP_RULE_STREAM = 13;
/** When it throws a combination, a setup → payoff one (if any fits) this often. */
const HOUSE_SETUP_RATE = 0.55;
/** House Mind takes an opening move this often (before its risk gate). */
const HOUSE_TAKE_OPENING = 0.6;
/** ...if its fall risk is under this times the fighter's appetite (a creative gamble: half that). */
const HOUSE_RISK_PER_APPETITE = 0.45;
/** Throws a combination instead of a single strike this often, times the appetite. */
const HOUSE_COMBO_RATE = 0.3;
/** The House Mind's own P(yes) for a kip-up: Jev's typical answer, then the same appetite scaling. */
export const HOUSE_KIP_YES = 0.33;
/** Aggression the get-up appetite is read at: a knockdown call should not swing with the last tactic. */
const KIP_AGGRESSION = 0.5;
/** Arms an opening reflex this often (before its risk gate). */
const HOUSE_ARM_REFLEX = 0.7;
const REFLEX_BANDS = new Set(['clinch', 'striking range', 'just outside reach']);
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
  onOpening?: Partial<Record<Opening, Tactic>>;
  comboPlan?: ComboPlan;
}

/** How readily this fighter gambles on a kip-up: its style and temperament at a neutral aggression. */
export function kipAppetite(fc: FighterContext): number {
  return gambleAppetite(styleOf(fc.design), fc.setup.temperament, KIP_AGGRESSION);
}

/**
 * The House Mind's get-up call: the same seeded draw as a Jev answer (policy.kipChance), from
 * HOUSE_KIP_YES scaled by appetite and the body's kip-up risk. No risk published: safe.
 */
export function houseGetupStyle(fc: FighterContext, s: Situation, seed = 0): GetupStyle {
  const risk = s.me.moveRisk?.kip_up;
  if (risk === undefined || !Number.isFinite(risk)) return 'safe';
  return sampleKip(HOUSE_KIP_YES, kipAppetite(fc), risk, seed, fc.corner, s.tick);
}

/** The House Mind's pre-armed reflex: its style's favourite answer to a whiff that its appetite accepts. */
function houseReflex(fc: FighterContext, s: Situation, seed: number, aggression: number): Partial<Record<Opening, Tactic>> | null {
  if (s.me.down || !REFLEX_BANDS.has(s.band)) return null;
  if (rng(mixSeed(seed, fc.corner, s.tick, REFLEX_RULE_STREAM))() >= HOUSE_ARM_REFLEX) return null;
  const limit = HOUSE_RISK_PER_APPETITE * gambleAppetite(styleOf(fc.design), fc.setup.temperament, aggression);
  const pick = reflexMenu(fc.design, s.me).filter((i) => (i.risk ?? 0) < limit).sort((a, b) => b.weight - a.weight)[0];
  return pick ? reflexArming(pick.move) : null;
}

/** The first menu move (by style weight) whose risk the fighter's appetite accepts. */
function houseGamble(fc: FighterContext, s: Situation, seed: number, aggression: number): MenuItem | null {
  const openings = s.me.openings ?? [];
  const appetite = gambleAppetite(styleOf(fc.design), fc.setup.temperament, aggression);
  const creative = !openings.length && (s.band === 'striking range' || s.band === 'just outside reach') && creativeRoll(appetite, seed, fc.corner, s.tick);
  if (!openings.length && !creative) return null;
  if (rng(mixSeed(seed, fc.corner, s.tick, GAMBLE_STREAM))() >= HOUSE_TAKE_OPENING) return null;
  const limit = HOUSE_RISK_PER_APPETITE * appetite * (creative ? 0.5 : 1);
  const menu = openingMenu(fc.design, s.me, openings, (t) => TACTIC_INFO[t].description, creative, readyCombos(s.me, designCombos(fc.design)).length > 0);
  const ok = menu.items.filter((i) => i.move !== 'sidestep_counter' || s.oppPhase !== 'neutral').filter((i) => (i.risk ?? 0) < limit);
  return ok.sort((a, b) => b.weight - a.weight)[0] ?? null;
}

function houseCombo(fc: FighterContext, s: Situation, seed: number, aggression: number): Tactic[] | null {
  const combos = readyCombos(s.me, designCombos(fc.design));
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

/** Aggression while the referee holds the fight: guard up, nothing thrown. */
export const BREAK_AGGRESSION = 0.2;

/**
 * This fighter's role in a referee break (RobotTelemetry.referee, src/physics/systems/referee.ts),
 * or null while they fight: 'down' on the canvas or rising, 'neutral' sent to a neutral spot, 'hold'
 * back up and waiting for FIGHT.
 * A knockdown counts as a break from its first frame: the controller flags the fall a control tick or
 * two before the referee's next update, so a telemetry frame can carry `down` (and the 'fall' event)
 * without `referee.break` yet. Treating that frame as a break keeps it from sending a model question
 * that the break would then throw away (the downed man's kip-up question with it).
 */
export function breakRole(s: Pick<Situation, 'me' | 'opp'>): 'down' | 'neutral' | 'hold' | null {
  const refereed = s.me.referee !== undefined || s.opp.referee !== undefined;
  const knockdown = refereed && (s.me.down || s.opp.down);
  if (!s.me.referee?.break && !s.opp.referee?.break && !knockdown) return null;
  return s.me.referee?.role ?? (s.me.down ? 'down' : s.opp.down ? 'neutral' : 'hold');
}

/**
 * Settles an obvious tick locally, or returns null when the call deserves Jev.
 * Obvious: I'm down (the body is getting up), the referee holds the fight (a break: the body obeys
 * him over any intent, so nothing is worth a question), or the opponent is far and not a threat.
 */
export function obviousDecision(fc: FighterContext, s: Situation, seed = 0): RuleDecision | null {
  const counterIfLunge: Tactic = 'sidestep_counter';
  if (s.me.down) {
    const getupStyle = houseGetupStyle(fc, s, seed);
    return { tactic: 'guard', target: 'torso', aggression: 0.2, counterIfLunge, reason: getupStyle === 'kip_up' ? 'down: try a kip-up' : 'down: cover up while the body gets up', getupStyle };
  }
  const role = breakRole(s);
  if (role) {
    // No reflex armed, no counter thrown: 'guard' as the lunge answer only covers up.
    const hold = (tactic: Tactic, reason: string): RuleDecision => ({ tactic, target: 'torso', aggression: BREAK_AGGRESSION, counterIfLunge: 'guard', reason });
    if (role === 'down') return hold('guard', 'down: getting up');
    if (role === 'neutral') return hold('hold_range', 'referee break: neutral corner');
    return hold('guard', 'referee break: waiting for FIGHT');
  }
  if (s.band === 'far' && s.geometry.oppApproachSpeed < 1.5) {
    return { tactic: 'close_distance', target: weakestZone(fc, s, 'head'), aggression: baseAggression(s), counterIfLunge, reason: 'far apart, no threat: close the distance' };
  }
  return null;
}

/** The full fallback behavior tree (first matching branch wins), with a pre-armed reflex on top. */
export function houseMind(fc: FighterContext, s: Situation, seed: number): RuleDecision {
  const obvious = obviousDecision(fc, s, seed);
  if (obvious) return obvious;
  const d = houseTree(fc, s, seed);
  if (s.oppPhase === 'down') return d;
  const onOpening = houseReflex(fc, s, seed, d.aggression);
  return onOpening ? { ...d, onOpening } : d;
}

function houseTree(fc: FighterContext, s: Situation, seed: number): RuleDecision {
  const u = rng(mixSeed(seed, fc.corner, s.tick, RULE_STREAM))();
  const agg = baseAggression(s);
  const close = s.band === 'clinch' || s.band === 'striking range';
  const counterIfLunge: Tactic = 'sidestep_counter';
  const pack = (tactic: Tactic, aggression: number, reason: string, target?: TargetZone): RuleDecision =>
    ({ tactic, target: target ?? strikeTarget(tactic, fc, s), aggression, counterIfLunge, reason });

  // Never jump on a downed man: the referee sends the standing fighter away until he is up (a break
  // settles this tick in obviousDecision; this covers telemetry without the referee's view).
  if (s.oppPhase === 'down') return pack('hold_range', BREAK_AGGRESSION, 'opponent down: give him room', 'torso');
  const gamble = houseGamble(fc, s, seed, agg);
  if (gamble) {
    const why = gamble.opening ? `opening (${gamble.opening.replace(/_/g, ' ')})` : 'creative gamble';
    const combo = gamble.move === 'combo' ? houseCombo(fc, s, seed, 1) ?? readyCombos(s.me, designCombos(fc.design))[0] : undefined;
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
    if (combo) {
      const setups = setupCombos(fc.design, s.me, s.opp);
      if (setups.length && rng(mixSeed(seed, fc.corner, s.tick, SETUP_RULE_STREAM))() < HOUSE_SETUP_RATE) {
        const pick = setups[0];
        const comboPlan = planOf(pick);
        return { ...pack('combo', agg, `set him up: ${pick.why}`, comboPlan.zones[0]), combo: [...pick.steps], comboPlan };
      }
      return { ...pack('combo', agg, 'in range: combination', strikeTarget(combo[0], fc, s)), combo };
    }
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
