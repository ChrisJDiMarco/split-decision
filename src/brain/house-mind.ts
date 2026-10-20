// House Mind: the local behavior tree that fights whenever Jev is unreachable, and the
// "obvious tick" rules that settle a decision without a call even when Jev is online.
// Deterministic for a given (seed, corner, tick) and the fight so far, so fallback fights replay exactly.
// Temperament (Chris: "they need to be going at each other ... more aggressive and clever"): it
// presses by default (base aggression at the body's pressure line), throws what has been landing
// this fight (FightMemory's weapon record over a prior from the measured landing rates), steps in
// from the edge WITH a punch (a kick needs a set stance, so it is the rare choice from a step out),
// counters his windup with a straight that lands from there, and still respects him: it slips or
// covers a blow already in the air, circles off the cage, and backs off when it is losing badly.
import type { ComboPlan, GetupStyle, Opening, Tactic, TargetZone } from '../core/protocol';
import { creativeRoll, gambleAppetite, openingMenu, reflexArming, reflexMenu, type MenuItem } from './gambles';
import { readyCombos } from './limbs';
import { sampleKip } from './policy';
import { fitsHere, weaponFit, type StrikeFit } from './ranges';
import { zoneHealth } from './questions';
import { mixSeed, rng } from './rng';
import type { FighterContext, Situation } from './situation';
import { planOf, setupCombos } from './setups';
import { designCombos, styleOf } from './style';
import { abilityTactics, FINISHER_ORDER, isFlashy, isStrike, TACTIC_INFO, tacticWords } from './tactics';

const RULE_STREAM = 7;
const GAMBLE_STREAM = 8;
const COMBO_RULE_STREAM = 9;
const REFLEX_RULE_STREAM = 12;
const SETUP_RULE_STREAM = 13;
const COUNTER_RULE_STREAM = 14;
/** When it throws a combination, a setup → payoff one (if any fits) this often. */
const HOUSE_SETUP_RATE = 0.5;
/** House Mind takes an opening move this often (before its risk gate). */
const HOUSE_TAKE_OPENING = 0.6;
/** ...if its fall risk is under this times the fighter's appetite (a creative gamble: half that). */
const HOUSE_RISK_PER_APPETITE = 0.45;
/** Throws a combination instead of a single strike this often, times the appetite. */
const HOUSE_COMBO_RATE = 0.45;
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
/**
 * How much a strike's range fit weighs in the pick: throw what lands; step in behind a punch (the
 * body throws it off the step); a kick from a step out only rarely (the body walks in and sets its
 * stance first: slow, and it mostly whiffed).
 */
const FIT_WEIGHT: Record<StrikeFit, number> = { lands: 1, step: 0.5, close: 0, far: 0, out: 0 };
const KICK_STEP_WEIGHT = 0.1;
const KICKS: ReadonlySet<Tactic> = new Set<Tactic>(['low_kick', 'front_kick', 'head_kick', 'tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee']);
/**
 * Prior weight per strike before the fight shows what lands (the reviews' measured landing: the jab
 * about 90%, hook, cross and uppercut most of the time, front and head kicks rarely). The fight's
 * own record (FightMemory.landingFactor) multiplies it.
 */
const STRIKE_PRIOR: Partial<Record<Tactic, number>> = { jab: 2, cross: 1.3, hook: 1.3, uppercut: 1.2, overhand: 1, low_kick: 0.6, front_kick: 0.5, head_kick: 0.35 };
const DEFAULT_PRIOR = 0.7;
/** The fight's landing record moves a weapon's weight within these bounds. */
const LANDING_MIN = 0.15;
const LANDING_MAX = 2;
/** Straights that answer his windup by landing first, best first. */
const COUNTER_STRIKES: readonly Tactic[] = ['cross', 'jab', 'hook'];
/** His windup (not yet in the air): beat him to it with a straight that lands this often (the rest: slip or cover). */
const BEAT_HIM_TO_IT = 0.45;
/** His blow in the air: slip it and counter this often, else cover. */
const SLIP_IN_AIR = 0.65;
/** The lunge answer armed with every decision: a counter straight that lands from here this often, else the slip. */
const COUNTER_ARMED = 0.5;
/** Pinned on the cage with a weapon that lands: fight off it this often instead of circling out. */
const FIGHT_OFF_CAGE = 0.5;
/** Short weapons for the clinch, in order of preference (when they land from there). */
const INSIDE_STRIKES: readonly Tactic[] = ['uppercut', 'hook', 'jaw_crush', 'shield_bash'];
/** Never from the clinch, whatever the range table says: the leg has no room to rise. */
const HEAD_KICKS: ReadonlySet<Tactic> = new Set<Tactic>(['head_kick', 'tornado_kick']);
const NOTHING_BANNED: ReadonlySet<Tactic> = new Set<Tactic>();
/**
 * At the edge (one step out): a setup that opens with a feint this often, a lone feint now and then;
 * otherwise it steps in WITH a strike, at least this aggressive.
 */
const EDGE_SETUP = 0.12;
const EDGE_FEINT = 0.17;
const EDGE_ENTRY_AGGRESSION = 0.75;
/** Closing from out of range at least this aggressive (the walk-in pace scales with it). */
const CLOSE_AGGRESSION = 0.75;
/** Base aggression: at the body's pressure line (control PACE.pressureAggression 0.7) when even, moved by the damage lead. */
const BASE_AGGRESSION = 0.7;
const LEAD_AGGRESSION = 0.5;
const CAGE_TRAP_M = 0.6;

/** What the House Mind remembers of the fight: how each of its weapons has been landing (FightMemory). */
export interface HouseMemory { landingFactor(t: Tactic): number }

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
  // (No creative gamble into his blow already in the air: that is a free shot for him.)
  const creative = !openings.length && s.oppPhase !== 'striking' && (s.band === 'striking range' || s.band === 'just outside reach') && creativeRoll(appetite, seed, fc.corner, s.tick);
  if (!openings.length && !creative) return null;
  if (rng(mixSeed(seed, fc.corner, s.tick, GAMBLE_STREAM))() >= HOUSE_TAKE_OPENING) return null;
  const limit = HOUSE_RISK_PER_APPETITE * appetite * (creative ? 0.5 : 1);
  const menu = openingMenu(fc.design, s.me, openings, (t) => TACTIC_INFO[t].description, creative, readyCombos(s.me, designCombos(fc.design)).length > 0);
  const ok = menu.items
    .filter((i) => i.move !== 'sidestep_counter' || s.oppPhase !== 'neutral')
    .filter((i) => (i.risk ?? 0) < limit)
    .filter((i) => (i.move === 'combo' ? readyCombos(s.me, designCombos(fc.design)).some((c) => opensHere(fc, s, c)) : !isStrike(i.move) || fitsHere(strikeFit(fc, s, i.move))))
    .filter((i) => s.band !== 'clinch' || !HEAD_KICKS.has(i.move));
  return ok.sort((a, b) => b.weight - a.weight)[0] ?? null;
}

/** A strike's fit from this gap (ranges.weaponFit): 'out' once damage took it away, null without skill ranges. */
function strikeFit(fc: FighterContext, s: Situation, t: Tactic): StrikeFit | null {
  return weaponFit(fc.design, s.range, t);
}

/** The first strike of a combination or setup (a setup may open with a feint). */
function opener(steps: readonly Tactic[]): Tactic | undefined {
  return steps.find((t) => t !== 'combo' && isStrike(t));
}

/** A combination (or setup) opens with a strike that lands from here or one step in. */
function opensHere(fc: FighterContext, s: Situation, steps: readonly Tactic[]): boolean {
  const first = opener(steps);
  return !first || fitsHere(strikeFit(fc, s, first));
}

/** A strike's weight from what it is (the prior) and how it has been landing this fight. */
function reliability(t: Tactic, mem?: HouseMemory): number {
  const f = mem ? Math.max(LANDING_MIN, Math.min(LANDING_MAX, mem.landingFactor(t))) : 1;
  return (STRIKE_PRIOR[t] ?? DEFAULT_PRIOR) * f;
}

/** A weighted pick (u in [0, 1)); null when every weight is 0. */
function weighted<T>(items: readonly T[], w: readonly number[], u: number): T | null {
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += w[i];
    if (u * total < acc) return items[i];
  }
  return items[items.length - 1];
}

/** A combination that opens with a strike that fits the gap, weighted by how its strikes have been landing (null: none, or not this time). */
function houseCombo(fc: FighterContext, s: Situation, seed: number, aggression: number, mem?: HouseMemory): Tactic[] | null {
  // Not the one the body is still finishing: it would take the same combination for the one it runs
  // and, once done, throw its first step again.
  const running = s.me.comboStep !== undefined && s.me.intent?.tactic === 'combo' ? s.me.intent.combo?.join('>') : undefined;
  const combos = readyCombos(s.me, designCombos(fc.design)).filter((c) => opensHere(fc, s, c) && c.join('>') !== running).slice(0, 4);
  if (!combos.length) return null;
  const appetite = gambleAppetite(styleOf(fc.design), fc.setup.temperament, aggression);
  const u = rng(mixSeed(seed, fc.corner, s.tick, COMBO_RULE_STREAM));
  if (u() >= HOUSE_COMBO_RATE * appetite) return null;
  return weighted(combos, combos.map((c) => chainReliability(c, mem)), u());
}

function has(fc: FighterContext, t: Tactic): boolean {
  return abilityTactics(fc.design).includes(t);
}

function baseAggression(s: Situation): number {
  const lead = s.opp.damageTotal - s.me.damageTotal;
  return Math.max(0.45, Math.min(0.95, BASE_AGGRESSION + LEAD_AGGRESSION * lead));
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

/**
 * The biggest shot that fits the gap (lands or one step in) and has not been whiffing this fight; without
 * skill ranges, the biggest one it has.
 */
function finisher(fc: FighterContext, s: Situation, mem?: HouseMemory): Tactic {
  const own = abilityTactics(fc.design);
  const fits = FINISHER_ORDER.filter((t) => own.includes(t) && fitsHere(strikeFit(fc, s, t)));
  return fits.find((t) => !mem || mem.landingFactor(t) >= 0.6) ?? fits[0]
    ?? FINISHER_ORDER.find((t) => own.includes(t)) ?? 'close_distance';
}

/** The fighter's strike abilities (bar the lunge and `banned`) whose fit from here is one of `fits` (all of them without skill ranges). */
function strikesFitting(fc: FighterContext, s: Situation, fits: readonly StrikeFit[], banned = NOTHING_BANNED): Tactic[] {
  return abilityTactics(fc.design).filter((t) => isStrike(t) && t !== 'lunge' && !banned.has(t)).filter((t) => {
    const f = strikeFit(fc, s, t);
    return f === null || fits.includes(f);
  });
}

/**
 * A weighted strike pick: the jab and the strikes that hit what is already hurt weigh more, and each
 * is scaled by its range fit (FIT_WEIGHT: what lands, now and then a step in behind a longer one).
 * Null when nothing fits.
 */
function pickStrike(fc: FighterContext, s: Situation, u: number, fits: readonly StrikeFit[] = ['lands', 'step'], banned = NOTHING_BANNED, mem?: HouseMemory): Tactic | null {
  const zones = zoneHealth(fc.oppDesign, s.opp);
  const legHurt = Math.min(zones.get('left_leg') ?? 1, zones.get('right_leg') ?? 1) < DAMAGED_ZONE_HP;
  const headHurt = (zones.get('head') ?? 1) < DAMAGED_ZONE_HP;
  const strikes = strikesFitting(fc, s, fits, banned);
  const w = strikes.map((t) => {
    const f = strikeFit(fc, s, t);
    const fit = f === 'step' && KICKS.has(t) ? KICK_STEP_WEIGHT : f ? FIT_WEIGHT[f] : 1;
    return reliability(t, mem) * (legHurt && LEG_STRIKES.has(t) ? 2 : 1) * (headHurt && HEAD_STRIKES.has(t) ? 1.5 : 1) * fit;
  });
  return weighted(strikes, w, u);
}

/** The straight that answers his windup by landing first: of COUNTER_STRIKES that land from here, the one landing best this fight. */
function counterStrike(fc: FighterContext, s: Situation, mem?: HouseMemory): Tactic | null {
  if (!s.range) return null;
  const ok = COUNTER_STRIKES.filter((t) => has(fc, t) && strikeFit(fc, s, t) === 'lands');
  return ok.reduce<Tactic | null>((best, t) => (best === null || reliability(t, mem) > reliability(best, mem) ? t : best), null);
}

/** How well a run of strikes has been landing: the geometric mean of their weights (one that keeps whiffing drags it down). */
function chainReliability(steps: readonly Tactic[], mem?: HouseMemory): number {
  const strikes = steps.filter((t) => t !== 'combo' && isStrike(t));
  if (!strikes.length) return 1;
  return Math.exp(strikes.reduce((a, t) => a + Math.log(reliability(t, mem)), 0) / strikes.length);
}

/** The answer armed for his lunge (the body fires it on his windup): a straight that lands from here half the time, else the slip and counter. */
function lungeAnswer(fc: FighterContext, s: Situation, seed: number, mem?: HouseMemory): Tactic {
  const c = counterStrike(fc, s, mem);
  return c && rng(mixSeed(seed, fc.corner, s.tick, COUNTER_RULE_STREAM))() < COUNTER_ARMED ? c : 'sidestep_counter';
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

/**
 * The full fallback behavior tree (first matching branch wins), with a pre-armed reflex on top.
 * `mem`: the fight so far (which of its weapons land); without it, the priors alone.
 */
export function houseMind(fc: FighterContext, s: Situation, seed: number, mem?: HouseMemory): RuleDecision {
  const obvious = obviousDecision(fc, s, seed);
  if (obvious) return obvious;
  const d = houseTree(fc, s, seed, mem);
  if (s.oppPhase === 'down') return d;
  const onOpening = houseReflex(fc, s, seed, d.aggression);
  return onOpening ? { ...d, onOpening } : d;
}

function houseTree(fc: FighterContext, s: Situation, seed: number, mem?: HouseMemory): RuleDecision {
  const u = rng(mixSeed(seed, fc.corner, s.tick, RULE_STREAM))();
  const agg = baseAggression(s);
  const close = s.band === 'clinch' || s.band === 'striking range';
  const counterIfLunge: Tactic = s.oppPhase === 'down' ? 'sidestep_counter' : lungeAnswer(fc, s, seed, mem);
  const pack = (tactic: Tactic, aggression: number, reason: string, target?: TargetZone): RuleDecision =>
    ({ tactic, target: target ?? strikeTarget(tactic, fc, s), aggression, counterIfLunge, reason });

  // Never jump on a downed man: the referee sends the standing fighter away until he is up (a break
  // settles this tick in obviousDecision; this covers telemetry without the referee's view).
  if (s.oppPhase === 'down') return pack('hold_range', BREAK_AGGRESSION, 'opponent down: give him room', 'torso');
  const gamble = houseGamble(fc, s, seed, agg);
  if (gamble) {
    const why = gamble.opening ? `opening (${gamble.opening.replace(/_/g, ' ')})` : 'creative gamble';
    const combo = gamble.move === 'combo'
      ? houseCombo(fc, s, seed, 1) ?? readyCombos(s.me, designCombos(fc.design)).find((c) => opensHere(fc, s, c))
      : undefined;
    return {
      ...pack(gamble.move, Math.max(agg, 0.7), `${why}: ${gamble.move.replace(/_/g, ' ')}`, gamble.target ?? undefined),
      ...(combo ? { combo } : {}),
      flourish: isFlashy(gamble.move) || gamble.opening !== null,
      gamble: { move: gamble.move, opening: gamble.opening, risk: gamble.risk },
    };
  }
  if ((s.oppPhase === 'windup' || s.oppPhase === 'striking') && (close || s.band === 'just outside reach')) {
    if (s.band === 'clinch' && has(fc, 'clinch')) return pack('clinch', agg, 'incoming strike in close: tie him up', 'torso');
    // He is winding up: beat him to it with a straight that lands from here (now and then); his blow
    // already in the air: slip it and counter, or cover up. Never stand there and eat it.
    const beat = s.oppPhase === 'windup' ? counterStrike(fc, s, mem) : null;
    if (beat && u < BEAT_HIM_TO_IT) return pack(beat, Math.max(agg, 0.85), 'he winds up: beat him to it');
    const slip = s.oppPhase === 'windup' ? (u - BEAT_HIM_TO_IT) / (1 - BEAT_HIM_TO_IT) < SLIP_IN_AIR : u < SLIP_IN_AIR;
    return slip ? pack('sidestep_counter', agg * 0.8, 'incoming strike: slip and counter', 'torso') : pack('guard', agg * 0.7, 'incoming strike: cover up', 'torso');
  }
  if (close && s.geometry.cageGap < CAGE_TRAP_M) {
    // Pinned: fight off the fence with what lands (half the time), else circle out.
    if (s.range && strikesFitting(fc, s, ['lands']).length && u < FIGHT_OFF_CAGE) {
      const off = throwFromHere(fc, s, seed, u / FIGHT_OFF_CAGE, agg, pack, mem);
      return { ...off, reason: `on the cage: fight off it (${off.reason})` };
    }
    return pack(circleAway(s), agg * 0.6, 'trapped on the cage: circle out', 'torso');
  }
  if (s.band === 'clinch') {
    if (has(fc, 'clinch') && u < 0.4) return pack('clinch', agg, 'in close: clinch', 'torso');
    // Never a head kick in the clinch: only what lands from this close.
    const inside = INSIDE_STRIKES.find((t) => has(fc, t) && fitsHere(strikeFit(fc, s, t)))
      ?? (s.range ? pickStrike(fc, s, u, ['lands'], HEAD_KICKS, mem) : null);
    return inside ? pack(inside, agg, 'in close: short strike') : pack('retreat', agg * 0.5, 'in close without tools: back out', 'torso');
  }
  if (s.range) return rangedTree(fc, s, seed, u, agg, pack, mem);
  if (s.band === 'striking range') {
    if (s.oppPhase === 'staggered') return pack(finisher(fc, s, mem), Math.max(agg, 0.85), 'opponent staggered: big shot');
    return throwFromHere(fc, s, seed, u, agg, pack, mem);
  }
  if (s.band === 'just outside reach') {
    if (u < 0.2) return pack('feint', agg * 0.8, 'at the edge: feint to draw him', 'torso');
    if (u < 0.4 && has(fc, 'front_kick')) return pack('front_kick', agg, 'at the edge: long kick', 'torso');
    return pack('close_distance', Math.max(agg, CLOSE_AGGRESSION), 'at the edge: step in', 'head');
  }
  return pack('close_distance', Math.max(agg, CLOSE_AGGRESSION), 'out of range: close in', 'head');
}

/**
 * In range: a combination or setup that opens with a strike that fits the gap, or a single strike
 * (mostly one that lands, now and then a step in behind a longer one).
 */
function throwFromHere(fc: FighterContext, s: Situation, seed: number, u: number, agg: number, pack: Pack, mem?: HouseMemory): RuleDecision {
  const combo = houseCombo(fc, s, seed, agg, mem);
  if (combo) {
    const setup = rng(mixSeed(seed, fc.corner, s.tick, SETUP_RULE_STREAM))() < HOUSE_SETUP_RATE ? houseSetup(fc, s, mem) : null;
    if (setup) return setup(pack, agg);
    const entry = opener(combo);
    const why = entry && strikeFit(fc, s, entry) === 'step' ? 'step in behind a combination' : 'in range: combination';
    return { ...pack('combo', agg, why, strikeTarget(combo[0], fc, s)), combo };
  }
  const strike = pickStrike(fc, s, u, ['lands', 'step'], NOTHING_BANNED, mem);
  if (!strike) return pack('close_distance', agg, 'in range: step in', 'head');
  return pack(strike, agg, strikeFit(fc, s, strike) === 'step' ? `step in behind the ${tacticWords(strike)}` : 'in range: strike');
}

type Pack = (tactic: Tactic, aggression: number, reason: string, target?: TargetZone) => RuleDecision;

/**
 * The setup → payoff combination to run (opening with a strike that fits, or a feint), the one whose
 * prior weight times its payoff's landing record is best; null when none fits. `feintOnly`: only
 * setups that open with a feint (from the edge: sell the fake, then step in behind the payoff).
 */
function houseSetup(fc: FighterContext, s: Situation, mem?: HouseMemory, feintOnly = false): ((pack: Pack, agg: number) => RuleDecision) | null {
  const running = s.me.comboStep !== undefined && s.me.intent?.tactic === 'combo' ? s.me.intent.combo?.join('>') : undefined;
  const setups = setupCombos(fc.design, s.me, s.opp)
    .filter((c) => opensHere(fc, s, c.steps) && (!feintOnly || c.steps[0] === 'feint') && c.steps.join('>') !== running)
    .map((c) => ({ c, w: c.weight * chainReliability(c.steps, mem) }))
    .sort((a, b) => b.w - a.w);
  const pick = setups[0]?.c;
  if (!pick) return null;
  return (pack, agg) => {
    const comboPlan = planOf(pick);
    return { ...pack('combo', agg, `set him up: ${pick.why}`, comboPlan.zones[0]), combo: [...pick.steps], comboPlan };
  };
}

/**
 * Past the clinch, for a body with skill ranges: the weapons decide, not the reach band.
 *   something lands     throw it (a combination or setup that opens with one, or a single strike;
 *                       now and then a step in behind a longer one); staggered: the biggest that fits
 *   one step out        enter WITH a strike: step in behind one that lands after the step (a feint sometimes)
 *   all too close       tie him up, or make room
 *   nothing reaches     close the distance
 */
function rangedTree(fc: FighterContext, s: Situation, seed: number, u: number, agg: number, pack: Pack, mem?: HouseMemory): RuleDecision {
  const lands = strikesFitting(fc, s, ['lands']);
  const step = strikesFitting(fc, s, ['step']);
  if (s.oppPhase === 'staggered' && (lands.length || step.length)) return pack(finisher(fc, s, mem), Math.max(agg, 0.85), 'opponent staggered: big shot');
  if (lands.length) return throwFromHere(fc, s, seed, u, agg, pack, mem);
  if (step.length) {
    // From the edge: now and then sell a fake first (a setup that opens with a feint), else step in
    // WITH a strike (a punch off the step by preference), never a walk into his guard.
    const entry = Math.max(agg, EDGE_ENTRY_AGGRESSION);
    const fake = u < EDGE_SETUP ? houseSetup(fc, s, mem, true) : null;
    if (fake) return fake(pack, entry);
    if (u >= EDGE_SETUP && u < EDGE_FEINT) return pack('feint', agg * 0.8, 'at the edge: feint to draw him', 'torso');
    return throwFromHere(fc, s, seed, u < EDGE_FEINT ? u / EDGE_FEINT : (u - EDGE_FEINT) / (1 - EDGE_FEINT), entry, pack, mem);
  }
  if (s.range?.mine.length && s.range.mine.every((w) => w.fit === 'close')) {
    return has(fc, 'clinch') ? pack('clinch', agg, 'too close for my weapons: clinch', 'torso') : pack('hold_range', agg * 0.7, 'too close for my weapons: make room', 'torso');
  }
  return pack('close_distance', Math.max(agg, CLOSE_AGGRESSION), 'out of range: close in', 'head');
}
