import { describe, expect, test } from 'vitest';
import { buildQuestions, counterOptions, partZone } from '../../src/brain/questions';
import { makeFighterContext } from '../../src/brain/situation';
import { FOOTWORK_TACTICS, skillAction } from '../../src/brain/tactics';
import { DESIGNS } from '../../src/robots/designs';
import { RED_SETUP, telemetry } from './fixtures';

function questionsFor(me: string, opp: string) {
  const fc = makeFighterContext(0, DESIGNS[me], DESIGNS[opp], RED_SETUP);
  return buildQuestions(fc, telemetry(DESIGNS[opp], 1));
}

describe('question sets per design', () => {
  test('every design gets all six questions with the right types', () => {
    for (const id of Object.keys(DESIGNS)) {
      const { questions } = questionsFor(id, 'bruiser');
      expect(Object.keys(questions).sort()).toEqual(['aggression', 'counter_if_lunge', 'opp_commit', 'tactic', 'target', 'winning']);
      expect(questions.tactic.type).toBe('choice');
      expect(questions.target.type).toBe('choice');
      expect(questions.opp_commit.type).toBe('noul');
      expect(questions.counter_if_lunge.type).toBe('choice');
      expect(questions.aggression.type).toBe('score');
      expect(questions.winning.type).toBe('score');
      if (questions.aggression.type === 'score') expect(questions.aggression.criteria).toHaveLength(5);
    }
  });

  test('tactic options are the design\'s abilities plus footwork, each described', () => {
    const bruiser = questionsFor('bruiser', 'striker');
    expect(bruiser.tactics).toEqual(expect.arrayContaining(['jab', 'cross', 'hook', 'uppercut', 'overhand', 'front_kick', 'clinch']));
    expect(bruiser.tactics).not.toContain('low_kick');
    expect(bruiser.tactics).not.toContain('rocket_punch');

    const striker = questionsFor('striker', 'bruiser');
    expect(striker.tactics).toEqual(expect.arrayContaining(['low_kick', 'head_kick', 'front_kick']));
    expect(striker.tactics).not.toContain('hook');
    expect(striker.tactics).not.toContain('sprint'); // locomotion ability, not a tactic

    const goliath = questionsFor('goliath', 'bruiser');
    expect(goliath.tactics).toContain('rocket_punch');

    for (const qs of [bruiser, striker, goliath]) {
      expect(qs.tactics).toEqual(expect.arrayContaining([...FOOTWORK_TACTICS]));
      const q = qs.questions.tactic;
      if (q.type !== 'choice') throw new Error('tactic must be a choice');
      for (const t of qs.tactics) expect(typeof q.criteria[t]).toBe('string');
    }
  });

  test('counter options include only counters the design can throw', () => {
    expect(counterOptions(DESIGNS.bruiser)).toEqual(expect.arrayContaining(['sidestep_counter', 'guard', 'uppercut', 'clinch']));
    expect(counterOptions(DESIGNS.striker)).toContain('low_kick');
    expect(counterOptions(DESIGNS.striker)).not.toContain('uppercut');
  });

  test('targets follow what is still attached to the opponent', () => {
    const fc = makeFighterContext(0, DESIGNS.bruiser, DESIGNS.striker, RED_SETUP);
    const opp = telemetry(DESIGNS.striker, 1);
    expect(buildQuestions(fc, opp).targets).toEqual(['head', 'torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg']);
    const headless = { ...opp, parts: opp.parts.map((p) => (p.id === 'head' ? { ...p, attached: false } : p)) };
    expect(buildQuestions(fc, headless).targets).not.toContain('head');
    const cracked = { ...opp, parts: opp.parts.map((p) => (p.id === 'shin_l' ? { ...p, hp: 0.4 } : p)) };
    const q = buildQuestions(fc, cracked).questions.target;
    if (q.type !== 'choice') throw new Error('target must be a choice');
    expect(q.criteria.left_leg).toBe('his left leg, armor cracked');
  });

  test('part zones come from tags', () => {
    expect(partZone({ tags: ['forearm', 'left'] })).toBe('left_arm');
    expect(partZone({ tags: ['leg', 'front', 'right'] })).toBe('right_leg');
    expect(partZone({ tags: ['spinner'] })).toBe('weapon');
    expect(partZone({ tags: ['chassis'] })).toBe('torso');
  });

  test('skill strings map to actions', () => {
    expect(skillAction('strike.low_kick')).toBe('low_kick');
    expect(skillAction('head-kick windup')).toBe('head_kick');
    expect(skillAction('walk')).toBeNull();
  });

  test('skill names match whole words only, so "frame" is not a ram', () => {
    expect(skillAction('gait.frame')).toBeNull();
    expect(skillAction('ramp_up')).toBeNull();
    expect(skillAction('guarded_walk')).toBeNull();
    expect(skillAction('lowKick')).toBe('low_kick');
    expect(skillAction('jab-windup')).toBe('jab');
  });
});
