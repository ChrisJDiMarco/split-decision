// The pace stage's rules, without physics: combinations run whole in the body (combo.ts), feints sold
// and telegraphed past the reflex threshold (feint.ts), the balance engine's shorter pause between
// blows (tactics.ts PACE).
import { describe, expect, it } from 'vitest';
import type { FeintRead, Intent } from '../../src/core/protocol';
import { adaptPayoff, ComboRun, comboKey, stepZone, wholeCombo } from '../../src/physics/control/combo';
import { FEINT, feintDue, feintOf, fixFeintWindup } from '../../src/physics/control/feint';
import { SKILLS } from '../../src/physics/control/skills';
import type { SkillRun } from '../../src/physics/control/skills/types';
import { PACE } from '../../src/physics/control/tactics';

const REFLEX_WINDUP = 0.55; // tactics.ts: the opponent's pre-armed counter fires past this telegraph

const base = (extra: Partial<Intent>): Intent => ({ tactic: 'combo', target: 'head', aggression: 0.6, confidence: 1, source: 'fallback', ...extra });

const read = (reactions: FeintRead['reactions']): FeintRead => ({ seq: 3, time: 1, level: 'high', limb: 'arm', skill: 'cross', deliberate: true, bit: reactions.length > 0, reactions });

function run(def = SKILLS.cross!): SkillRun {
  return { def, phase: 'windup', t: 0, durations: { windup: 0.1, strike: 0.2, recover: 0.3 }, zone: 'head', aim: null, landed: false, landedSpeed: 0, scratch: {} };
}

describe('combinations in the body', () => {
  it('a combo intent without a brain-sequenced step is run whole; a step intent is not', () => {
    expect(wholeCombo(base({ combo: ['jab', 'cross'] }))).toBe(true);
    expect(wholeCombo(base({ combo: ['jab', 'cross'], comboPlan: { setup: 0, zones: ['head', 'head'], payoffZone: 'head', step: 1 } }))).toBe(false);
    expect(wholeCombo(base({ tactic: 'jab', combo: ['jab', 'cross'] }))).toBe(false);
    expect(wholeCombo(base({}))).toBe(false);
    expect(comboKey(base({ combo: ['jab', 'cross', 'low_kick'] }))).toBe('jab>cross>low_kick');
    expect(comboKey(null)).toBe('');
  });

  it('takes its zones, setup, tempo and payoff zone from the plan', () => {
    const r = new ComboRun(base({ combo: ['feint', 'low_kick', 'head_kick'], comboPlan: { setup: 1, zones: ['torso', 'left_leg', 'head'], payoffZone: 'left_leg', tempo: [0, 0.2, 0] } }), 2, 7);
    expect(r.steps).toEqual(['feint', 'low_kick', 'head_kick']);
    expect(r.zones).toEqual(['torso', 'left_leg', 'head']);
    expect(r.setup).toBe(1);
    expect(r.tempo).toEqual([0, 0.2, 0]);
    expect(r.payoffZone).toBe('left_leg');
    expect(r.readSeq0).toBe(7);
    expect(r.payoff(0)).toBe(false);
    expect(r.payoff(1)).toBe(true);
  });

  it('a plain combination aims every step where asked, kicks where they are built to land', () => {
    const r = new ComboRun(base({ combo: ['jab', 'cross', 'low_kick', 'front_kick'] }), 0, 0);
    expect(r.zones).toEqual(['head', 'head', 'left_leg', 'torso']);
    expect(r.setup).toBe(0);
    expect(stepZone('low_kick', 'right_leg')).toBe('right_leg');
    expect(stepZone('hook', 'weapon')).toBe('head');
  });

  it('the payoff answers the read: a long shot if he retreated, the planned move otherwise', () => {
    const long = ['front_kick', 'cross', 'jab'] as const;
    expect(adaptPayoff('hook', 'head', read(['retreated']), long)).toEqual({ tactic: 'front_kick', zone: 'torso' });
    expect(adaptPayoff('hook', 'head', read(['retreated']), ['cross'])).toEqual({ tactic: 'cross', zone: 'head' });
    for (const r of [read(['covered']), read(['countered']), read(['flinched']), read([]), null]) {
      expect(adaptPayoff('low_kick', 'left_leg', r, long)).toEqual({ tactic: 'low_kick', zone: 'left_leg' });
    }
  });
});

describe('feints', () => {
  it('fake the real strike (same id, kind, side) with a telegraph past the reflex threshold at the pull', () => {
    for (const id of ['jab', 'cross', 'hook', 'low_kick', 'front_kick'] as const) {
      const real = SKILLS[id]!;
      const f = feintOf(real);
      expect(f.id).toBe(real.id);
      expect(f.kind).toBe(real.kind);
      expect(f.side).toBe(real.side);
      expect(f.clip).toBeUndefined();
      expect(f.telegraph * FEINT.pullAt).toBeGreaterThanOrEqual(REFLEX_WINDUP);
      expect(feintOf(real)).toBe(f); // cached
    }
  });

  it('show a sold windup (at least 0.18 s, 60-70% of it) before the pull, whatever the aggression', () => {
    const r = run(feintOf(SKILLS.cross!));
    fixFeintWindup(r);
    expect(r.durations.windup).toBe(FEINT.windupS);
    expect(FEINT.windupS * FEINT.pullAt).toBeGreaterThanOrEqual(0.18);
    expect(FEINT.pullAt).toBeGreaterThanOrEqual(0.6);
    r.t = 0.2;
    expect(feintDue(r, false)).toBe(false);
    r.t = FEINT.windupS * FEINT.pullAt;
    expect(feintDue(r, false)).toBe(true);
    r.phase = 'strike';
    expect(feintDue(r, false)).toBe(false); // committed: no longer a feint
  });

  it('a low feint is pulled just after the leg is lent (the foot barely leaves the canvas)', () => {
    const r = run(feintOf(SKILLS.low_kick!));
    fixFeintWindup(r);
    r.t = 0.1;
    expect(feintDue(r, true)).toBe(false);
    r.t = 0.1 + FEINT.legLentS;
    expect(feintDue(r, true)).toBe(true);
  });
});

describe('pace', () => {
  it('the balance engine pauses less between blows than the legacy path, at every aggression', () => {
    for (const a of [0, 0.3, 0.5, 0.7, 1]) {
      const legacy = PACE.cooldownLegacy[0] - PACE.cooldownLegacy[1] * a;
      const engine = PACE.cooldownEngine[0] - PACE.cooldownEngine[1] * a;
      expect(engine).toBeLessThan(legacy);
      expect(engine).toBeGreaterThan(0.05);
    }
  });
});
