// Turning Jev's distributions into one intent: seeded temperature sampling,
// confidence gating and hysteresis. Pure functions, so replays are deterministic.
import type { Tactic, TargetZone } from '../core/protocol';
import type { JevAnswer, JevResult } from './jev-client';
import { AGGRESSION_LEVELS, WINNING_LEVELS, type QuestionSet } from './questions';
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
