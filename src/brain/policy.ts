// Turning Jev's distributions into one intent: seeded temperature sampling,
// confidence gating and hysteresis. Pure functions, so replays are deterministic.
import type { GetupStyle, Opening, Tactic, TargetZone } from '../core/protocol';
import { gambleWeights, IMPOSSIBLE_RISK, NONE, NOTHING, reflexArming } from './gambles';
import type { JevAnswer, JevResult } from './jev-client';
import { AGGRESSION_LEVELS, WINNING_LEVELS, type QuestionSet } from './questions';
import type { SetupCombo } from './setups';
import { comboId } from './style';
import type { Situation } from './situation';
import { mixSeed, rng } from './rng';
import type { CommitMode } from './types';

export const COMMIT_CONFIDENCE = 0.6;
export const PROBE_CONFIDENCE = 0.35;
export const HYSTERESIS_MARGIN = 0.15;
export const PROBE_AGGRESSION_SCALE = 0.7;
export const GUARD_AGGRESSION_CAP = 0.3;
const OPP_COMMIT_GUARD = 0.5;
const MIN_TEMPERATURE = 0.05;

export class AnswerError extends Error {}

export interface ParsedAnswers {
  tacticProbs: Record<string, number>;
  tacticConfidence: number;
  targetProbs: Record<string, number>;
  oppCommit: number | null;
  counter: Tactic | undefined;
  aggression: number; // 0..1
  winning: number | null; // 0..1
}

/** Keeps only offered options and renormalizes. Returns null if nothing usable is left. */
export function restrict(probs: Record<string, number> | undefined, options: readonly string[]): Record<string, number> | null {
  if (!probs) return null;
  let sum = 0;
  const out: Record<string, number> = {};
  for (const o of options) {
    const p = Number(probs[o]);
    const v = Number.isFinite(p) && p > 0 ? p : 0;
    out[o] = v;
    sum += v;
  }
  if (sum <= 0) return null;
  for (const o of options) out[o] /= sum;
  return out;
}

export function argmax(probs: Record<string, number>): string {
  let best = '';
  let bp = -1;
  for (const [k, p] of Object.entries(probs)) if (p > bp) { best = k; bp = p; }
  return best;
}

function choiceProbs(a: JevAnswer | undefined, options: readonly string[]): Record<string, number> | null {
  return a?.type === 'choice' ? restrict(a.probabilities, options) : null;
}

function scoreFrac(a: JevAnswer | undefined, levels: readonly string[]): number | null {
  if (a?.type !== 'score' || !Number.isFinite(a.score)) return null;
  return Math.max(0, Math.min(1, a.score / (levels.length - 1)));
}

/** Validates Jev's answers against the question set. Throws AnswerError if the tactic is unusable. */
export function parseAnswers(result: JevResult, qs: QuestionSet): ParsedAnswers {
  const a = result.answers;
  const tacticProbs = choiceProbs(a.tactic, qs.tactics);
  if (!tacticProbs) throw new AnswerError('Jev answer has no usable tactic distribution');
  const tactic = a.tactic as Extract<JevAnswer, { type: 'choice' }>;
  const targetProbs = choiceProbs(a.target, qs.targets) ?? { [qs.targets[0]]: 1 };
  const counterProbs = choiceProbs(a.counter_if_lunge, qs.counters);
  const commit = a.opp_commit?.type === 'noul' && Number.isFinite(a.opp_commit.noul) ? a.opp_commit.noul : null;
  return {
    tacticProbs,
    tacticConfidence: Number.isFinite(tactic.confidence) ? tactic.confidence : Math.max(...Object.values(tacticProbs)),
    targetProbs,
    oppCommit: commit,
    counter: counterProbs ? (argmax(counterProbs) as Tactic) : undefined,
    aggression: scoreFrac(a.aggression, AGGRESSION_LEVELS) ?? 0.5,
    winning: scoreFrac(a.winning, WINNING_LEVELS),
  };
}

/** Samples an option from p^(1/T), renormalized, using a uniform draw u in [0, 1). */
export function sampleTemperature(probs: Record<string, number>, temperature: number, u: number): string {
  const inv = 1 / Math.max(MIN_TEMPERATURE, temperature);
  const keys = Object.keys(probs);
  const w = keys.map((k) => (probs[k] > 0 ? Math.pow(probs[k], inv) : 0));
  const total = w.reduce((s, x) => s + x, 0);
  if (total <= 0 || !Number.isFinite(total)) return argmax(probs);
  let acc = 0;
  const target = u * total;
  for (let i = 0; i < keys.length; i++) {
    acc += w[i];
    if (target < acc) return keys[i];
  }
  return keys[keys.length - 1];
}

/** Seeded draw keyed on (fight seed, corner, tick, stream) so a replay picks the same thing. */
export function seededSample(probs: Record<string, number>, temperature: number, seed: number, corner: number, tick: number, stream = 0): string {
  return sampleTemperature(probs, temperature, rng(mixSeed(seed, corner, tick, stream))());
}

/**
 * Keep the current tactic unless Jev's new favourite leads it by the margin; this stops
 * 4 Hz dithering between near-equal options. Once the lead is clear, the sampled pick
 * (which carries the fighter's temperament) goes through.
 */
export function applyHysteresis(current: string | null, sampled: string, probs: Record<string, number>, margin = HYSTERESIS_MARGIN): string {
  if (!current || current === sampled || !(current in probs)) return sampled;
  const favourite = argmax(probs);
  return probs[favourite] - probs[current] >= margin ? sampled : current;
}

export function commitMode(confidence: number): CommitMode {
  if (confidence >= COMMIT_CONFIDENCE) return 'commit';
  if (confidence >= PROBE_CONFIDENCE) return 'probe';
  return 'guard';
}

/** Low-confidence default: cover up when there is a threat, otherwise circle away from the cage. */
export function guardTactic(s: Situation, oppCommit: number | null): Tactic {
  const threat = s.band === 'clinch' || s.band === 'striking range' || s.oppPhase === 'windup' || s.oppPhase === 'striking' || (oppCommit ?? 0) > OPP_COMMIT_GUARD;
  if (threat) return 'guard';
  return s.geometry.cageBearingRad < 0 ? 'circle_left' : 'circle_right';
}

export interface PolicyInput {
  parsed: ParsedAnswers;
  situation: Situation;
  current: Tactic | null;
  temperature: number;
  seed: number;
  corner: number;
  tick: number;
}

export interface PolicyOutput {
  tactic: Tactic;
  target: TargetZone;
  aggression: number;
  mode: CommitMode;
  reason: string;
}

export function decide(input: PolicyInput): PolicyOutput {
  const { parsed, situation, current, temperature, seed, corner, tick } = input;
  const mode = commitMode(parsed.tacticConfidence);
  const target = argmax(parsed.targetProbs) as TargetZone;
  if (mode === 'guard') {
    return { tactic: guardTactic(situation, parsed.oppCommit), target, aggression: Math.min(parsed.aggression, GUARD_AGGRESSION_CAP), mode, reason: 'low confidence: guard and circle' };
  }
  const sampled = seededSample(parsed.tacticProbs, temperature, seed, corner, tick) as Tactic;
  const tactic = applyHysteresis(current, sampled, parsed.tacticProbs) as Tactic;
  const reason = tactic === sampled ? `sampled at T=${temperature.toFixed(2)}` : `hysteresis kept ${tactic}`;
  const aggression = mode === 'probe' ? parsed.aggression * PROBE_AGGRESSION_SCALE : parsed.aggression;
  return { tactic, target, aggression, mode, reason };
}

// ---------------------------------------------------------------- openings, combos, get-ups

export const OPENING_STREAM = 3;
export const COMBO_STREAM = 4;
export const REFLEX_STREAM = 5;
export const KIP_STREAM = 6;
/** Crowd factor on the kip-up odds: Chris wants fighters to attempt it, not wait for certainty. */
export const KIP_SHOWMAN = 1.5;
/** The kip-up risk a neutral fighter is calibrated at (a mid-weight body): lighter goes more, heavier less. */
const KIP_REF_SAFETY = 0.6;
const KIP_P_MIN = 0.01;
const KIP_P_MAX = 0.99;

/**
 * P(attempt a kip-up) from Jev's P(yes), scaled by the fighter's gamble appetite (style and
 * temperament) and by its body's odds: odds(p) · appetite² · (1 − risk)/0.6 · KIP_SHOWMAN. A light,
 * wild fighter (appetite ~1.4, risk ~0.3) turns Jev's usual 0.33 into ~0.64; a heavy, disciplined
 * one (appetite ~0.6, risk ~0.75) into ~0.1. Impossible (a limp joint): 0.
 */
export function kipChance(kipYes: number, appetite: number, kipRisk: number | null): number {
  const risk = kipRisk ?? 1 - KIP_REF_SAFETY;
  if (risk >= IMPOSSIBLE_RISK) return 0;
  const p = Math.max(KIP_P_MIN, Math.min(KIP_P_MAX, kipYes));
  const odds = (p / (1 - p)) * appetite * appetite * ((1 - risk) / KIP_REF_SAFETY) * KIP_SHOWMAN;
  return odds / (1 + odds);
}

/** The seeded kip-up draw: same (seed, corner, tick) → same call, so replays match. */
export function sampleKip(kipYes: number, appetite: number, kipRisk: number | null, seed: number, corner: number, tick: number): GetupStyle {
  return rng(mixSeed(seed, corner, tick, KIP_STREAM))() < kipChance(kipYes, appetite, kipRisk) ? 'kip_up' : 'safe';
}

export interface ExtraParsed {
  openingProbs: Record<string, number> | null; // Jev's distribution over the menu plus 'none'
  comboProbs: Record<string, number> | null;
  kipYes: number | null; // P(try a kip-up)
  reflexProbs: Record<string, number> | null; // on_opening: the reflex menu plus 'nothing'
}

/** Reads the optional answers; any that are missing or malformed are simply null. */
export function parseExtras(result: JevResult, qs: QuestionSet): ExtraParsed {
  const a = result.answers;
  const kip = a.getup_style;
  return {
    openingProbs: qs.menu.length ? choiceProbs(a.opening_move, [...qs.menu.map((i) => i.move), NONE]) : null,
    comboProbs: qs.combos.length || qs.setups.length ? choiceProbs(a.combo, [...qs.combos.map(comboId), ...qs.setups.map((c) => c.id)]) : null,
    kipYes: qs.getup && kip?.type === 'noul' && Number.isFinite(kip.noul) ? Math.max(0, Math.min(1, kip.noul)) : null,
    reflexProbs: qs.reflex.length ? choiceProbs(a.on_opening, [...qs.reflex.map((i) => i.move), NOTHING]) : null,
  };
}

export interface GambleInput {
  extras: ExtraParsed;
  qs: QuestionSet;
  appetite: number; // gambleAppetite(style, temperament, aggression); for a get-up, kipAppetite
  temperature: number;
  kipRisk: number | null;
  seed: number;
  corner: number;
  tick: number;
}

export interface GambleOutput {
  move: Tactic | null; // the opening move taken (null: none)
  moveP: number | null; // Jev's own probability for it
  opening: Opening | null; // the opening it exploits (null: a creative gamble)
  risk: number | null;
  target: TargetZone | null;
  combo: Tactic[] | null; // the combination to run if the tactic is 'combo'
  comboP: number | null;
  setup: SetupCombo | null; // the combination is a setup → payoff one (its steps are `combo`)
  getupStyle: GetupStyle | undefined;
  kipP: number | null; // the kip-up chance the draw used
  onOpening: Partial<Record<Opening, Tactic>> | null; // the armed reflex (null: 'nothing' or not asked)
  reflexP: number | null; // Jev's own probability for the armed move
}

export function decideGambles(input: GambleInput): GambleOutput {
  const { extras, qs, appetite, temperature, seed, corner, tick } = input;
  const out: GambleOutput = { move: null, moveP: null, opening: null, risk: null, target: null, combo: null, comboP: null, setup: null, getupStyle: undefined, kipP: null, onOpening: null, reflexP: null };
  if (extras.openingProbs) {
    const weighted = gambleWeights(extras.openingProbs, qs.menu, appetite);
    const pick = seededSample(weighted, temperature, seed, corner, tick, OPENING_STREAM);
    const item = qs.menu.find((i) => i.move === pick);
    if (item) Object.assign(out, { move: item.move, moveP: extras.openingProbs[pick], opening: item.opening, risk: item.risk, target: item.target });
  }
  if (qs.combos.length || qs.setups.length) {
    const ids = [...qs.combos.map(comboId), ...qs.setups.map((c) => c.id)];
    const probs = extras.comboProbs ?? Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0]));
    const pick = extras.comboProbs ? seededSample(probs, temperature, seed, corner, tick, COMBO_STREAM) : argmax(probs);
    const setup = qs.setups.find((c) => c.id === pick) ?? null;
    out.setup = setup;
    out.combo = setup ? [...setup.steps] : qs.combos.find((c) => comboId(c) === pick) ?? null;
    out.comboP = extras.comboProbs ? probs[pick] : null;
  }
  if (extras.reflexProbs) {
    // Same appetite weighting as the opening move: a bold fighter arms the flashy answer.
    const weighted = gambleWeights(extras.reflexProbs, qs.reflex, appetite);
    const pick = seededSample(weighted, temperature, seed, corner, tick, REFLEX_STREAM);
    const item = qs.reflex.find((i) => i.move === pick);
    if (item) Object.assign(out, { onOpening: reflexArming(item.move), reflexP: extras.reflexProbs[pick] });
  }
  if (qs.getup && extras.kipYes !== null) {
    out.kipP = kipChance(extras.kipYes, appetite, input.kipRisk);
    out.getupStyle = sampleKip(extras.kipYes, appetite, input.kipRisk, seed, corner, tick);
  }
  return out;
}
