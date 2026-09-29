import { describe, expect, test } from 'vitest';
import {
  AnswerError, applyHysteresis, commitMode, decide, parseAnswers, sampleTemperature, seededSample,
} from '../../src/brain/policy';
import { buildQuestions } from '../../src/brain/questions';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { answerFor, frame, RED_SETUP, scene } from './fixtures';

const PROBS = { jab: 0.5, cross: 0.3, guard: 0.2 };

function count(T: number, n = 20000) {
  const c: Record<string, number> = { jab: 0, cross: 0, guard: 0 };
  for (let i = 0; i < n; i++) c[seededSample(PROBS, T, 42, 0, i)]++;
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / n]));
}

describe('temperature sampling', () => {
  test('same (seed, corner, tick) always picks the same option', () => {
    for (let tick = 0; tick < 50; tick++) {
      expect(seededSample(PROBS, 1.3, 7, 1, tick)).toBe(seededSample(PROBS, 1.3, 7, 1, tick));
    }
    const a = Array.from({ length: 40 }, (_, t) => seededSample(PROBS, 1, 7, 0, t));
    const b = Array.from({ length: 40 }, (_, t) => seededSample(PROBS, 1, 8, 0, t));
    expect(a).not.toEqual(b);
  });

  test('T = 1 follows Jev\'s distribution', () => {
    const f = count(1);
    expect(f.jab).toBeCloseTo(0.5, 1);
    expect(f.cross).toBeCloseTo(0.3, 1);
    expect(f.guard).toBeCloseTo(0.2, 1);
  });

  test('low T sharpens toward the favourite, high T flattens', () => {
    expect(count(0.3).jab).toBeGreaterThan(0.8);
    const wild = count(1.8);
    expect(wild.jab).toBeLessThan(0.5);
    expect(wild.guard).toBeGreaterThan(0.2);
  });

  test('u maps monotonically across the cumulative weights', () => {
    expect(sampleTemperature(PROBS, 1, 0)).toBe('jab');
    expect(sampleTemperature(PROBS, 1, 0.6)).toBe('cross');
    expect(sampleTemperature(PROBS, 1, 0.99)).toBe('guard');
  });
});

describe('gating and hysteresis', () => {
  test('confidence bands: commit >= 0.6, probe 0.35..0.6, guard below', () => {
    expect(commitMode(0.75)).toBe('commit');
    expect(commitMode(0.6)).toBe('commit');
    expect(commitMode(0.5)).toBe('probe');
    expect(commitMode(0.35)).toBe('probe');
    expect(commitMode(0.2)).toBe('guard');
  });

  test('switches only when the new favourite leads the current tactic by 0.15', () => {
    expect(applyHysteresis('cross', 'jab', { jab: 0.4, cross: 0.3 })).toBe('cross');
    expect(applyHysteresis('cross', 'jab', { jab: 0.46, cross: 0.3 })).toBe('jab');
    expect(applyHysteresis(null, 'jab', { jab: 0.4 })).toBe('jab');
    expect(applyHysteresis('ram', 'jab', { jab: 0.4 })).toBe('jab'); // current no longer offered
    // A current tactic Jev has abandoned does not anchor a low-probability sample.
    expect(applyHysteresis('guard', 'jab', { front_kick: 0.2, jab: 0.07, guard: 0.02 })).toBe('jab');
    // Near-tie with the favourite: keep the current tactic even if the sample differs.
    expect(applyHysteresis('cross', 'guard', { jab: 0.4, cross: 0.3, guard: 0.3 })).toBe('cross');
  });

  function situation(distance: number) {
    const sc = scene();
    const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
    const f = frame(sc, 3, distance);
    return { fc, s: readSituation(fc, f), qs: buildQuestions(fc, f.telemetry[1]) };
  }

  test('decide: commit keeps full aggression, probe scales it, guard covers up in range', () => {
    const { s, qs } = situation(1.0);
    const base = { situation: s, current: null, temperature: 0.3, seed: 1, corner: 0, tick: 100 };
    const commit = decide({ ...base, parsed: parseAnswers(answerFor(qs.questions, 'hook', 0.8), qs) });
    expect(commit.mode).toBe('commit');
    expect(commit.tactic).toBe('hook');
    expect(commit.aggression).toBeCloseTo(0.5);
    const probe = decide({ ...base, parsed: parseAnswers(answerFor(qs.questions, 'hook', 0.45), qs) });
    expect(probe.mode).toBe('probe');
    expect(probe.aggression).toBeCloseTo(0.35);
    const guard = decide({ ...base, parsed: parseAnswers(answerFor(qs.questions, 'hook', 0.2), qs) });
    expect(guard.mode).toBe('guard');
    expect(guard.tactic).toBe('guard');
  });

  test('decide: low confidence out of range circles instead of covering', () => {
    const { s, qs } = situation(2.6);
    const out = decide({ situation: s, current: null, temperature: 1, seed: 1, corner: 0, tick: 5, parsed: parseAnswers(answerFor(qs.questions, 'jab', 0.1), qs) });
    expect(['circle_left', 'circle_right']).toContain(out.tactic);
  });

  test('parseAnswers drops options that were not offered and rejects a missing tactic', () => {
    const { qs } = situation(1.0);
    const res = answerFor(qs.questions, 'jab');
    const tactic = res.answers.tactic;
    if (tactic.type !== 'choice') throw new Error('expected choice');
    tactic.probabilities = { ...tactic.probabilities, rocket_punch: 5 };
    const parsed = parseAnswers(res, qs);
    expect(parsed.tacticProbs.rocket_punch).toBeUndefined();
    expect(Object.values(parsed.tacticProbs).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(() => parseAnswers({ ...res, answers: {} }, qs)).toThrow(AnswerError);
  });
});
