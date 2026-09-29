// The JEV MIND panel's opening, gamble and combo lines.
import { expect, test } from 'vitest';
import { comboLine, gambleLine, seesLine, type MindView } from '../../src/ui/minds';

const base: MindView = { source: 'jev', tactic: 'jab', target: 'head', aggression: 0.6, tacticProbs: { jab: 1 }, oppCommit: null, latencyMs: 240 };

test('opening → gamble with Jev\'s probability, creative gambles, combos as a chain', () => {
  expect(gambleLine({ ...base, gamble: { move: 'spinning_back_kick', opening: 'turned_away', p: 0.41, risk: 0.3 } })).toBe('OPENING: TURNED AWAY → SPINNING BACK KICK 41%');
  expect(gambleLine({ ...base, gamble: { move: 'tornado_kick', opening: null, p: 0.22, risk: 0.6 } })).toBe('GAMBLE → TORNADO KICK 22%');
  expect(gambleLine({ ...base, gamble: { move: 'low_kick', opening: 'weak_left_leg', p: null, risk: null } })).toBe('OPENING: WEAK LEFT LEG → LOW KICK');
  expect(gambleLine(base)).toBeNull();
  expect(comboLine({ ...base, combo: ['jab', 'cross', 'low_kick'] })).toBe('JAB › CROSS › LOW KICK');
  expect(comboLine(base)).toBeNull();
  expect(seesLine({ ...base, openings: ['low_guard', 'on_cage'] })).toBe('SEES: LOW GUARD · ON CAGE');
  expect(seesLine({ ...base, openings: ['low_guard'], gamble: { move: 'hook', opening: 'low_guard', p: 0.5, risk: null } })).toBeNull();
});
