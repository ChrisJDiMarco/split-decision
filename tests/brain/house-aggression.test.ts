// The House Mind picks the fight (Chris: "they need to be going at each other ... more aggressive and
// clever"): it presses when even, throws what lands (its own fight record over measured priors), steps in
// WITH a punch from the edge, beats his windup with a straight, and still slips or covers a blow in the
// air and eases off when losing. Plus the weapon record it learns from (FightMemory).
import { describe, expect, test } from 'vitest';
import { houseMind, type HouseMemory } from '../../src/brain/house-mind';
import { FightMemory } from '../../src/brain/memory';
import { rangeTable } from '../../src/brain/ranges';
import { makeFighterContext, readSituation, type FighterContext } from '../../src/brain/situation';
import { isStrike } from '../../src/brain/tactics';
import type { RobotTelemetry, SimEvent, Tactic } from '../../src/core/protocol';
import { frame, scene, telemetry, type Scene } from './fixtures';

const IQ: Partial<RobotTelemetry> = { openings: [], stance: 'orthodox', weakSpots: [], habits: [] };

function ctx(red: string, blue: string): { sc: Scene; fc: FighterContext } {
  const sc = scene(red, blue);
  return { sc, fc: makeFighterContext(0, sc.red, sc.blue, { design: red, skin: 'factory', plan: '', temperament: 1.2 }) };
}

/** Gaps for red: the pocket (his longest weapon lands) and the edge (nothing lands, the longest one step out). */
function gaps(fc: FighterContext): { pocket: number; edge: number } {
  const t = rangeTable(fc.design)!;
  const longest = Math.max(...[...t.byTactic.values()].filter((w) => fc.design.abilities.includes(w.tactic as never)).map((w) => w.edge));
  return { pocket: longest - 0.04, edge: longest + t.step / 3 };
}

function decisions(fc: FighterContext, sc: Scene, gap: number, over: { red?: Partial<RobotTelemetry>; blue?: Partial<RobotTelemetry> } = {}, mem?: HouseMemory, n = 400) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = readSituation(fc, { ...frame(sc, 20, gap, { red: { ...IQ, ...over.red }, blue: { ...over.blue } }), tick: 1000 + 37 * k });
    out.push({ s, d: houseMind(fc, s, 5, mem) });
  }
  return out;
}

const attacks = (t: Tactic) => t === 'combo' || isStrike(t);
const share = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length / Math.max(1, xs.length);
const memOf = (factors: Partial<Record<Tactic, number>>): HouseMemory => ({ landingFactor: (t) => factors[t] ?? 1 });

describe('House Mind: goes at him', () => {
  test('in the pocket it attacks nearly every decision, pressing (aggression at the body\'s pressure line)', () => {
    for (const [red, blue] of [['savate', 'pylon'], ['haymaker', 'firecracker'], ['firecracker', 'pylon']]) {
      const { sc, fc } = ctx(red, blue);
      const ds = decisions(fc, sc, gaps(fc).pocket);
      expect(share(ds, ({ d }) => attacks(d.tactic))).toBeGreaterThan(0.85);
      expect(share(ds, ({ d }) => d.aggression >= 0.7)).toBeGreaterThan(0.95);
    }
  });

  test('from the edge it steps in WITH a strike, by preference a punch, never one that is too far', () => {
    for (const [red, blue] of [['savate', 'haymaker'], ['pylon', 'savate'], ['haymaker', 'firecracker']]) {
      const { sc, fc } = ctx(red, blue);
      const ds = decisions(fc, sc, gaps(fc).edge);
      expect(ds[0].s.range!.mine.some((w) => w.fit === 'step')).toBe(true);
      expect(share(ds, ({ d }) => attacks(d.tactic) || d.tactic === 'feint')).toBeGreaterThan(0.95);
      const singles = ds.filter(({ d }) => isStrike(d.tactic) && d.tactic !== 'combo' && !d.gamble); // (a creative gamble is its own call)
      expect(share(singles, ({ d }) => !['low_kick', 'front_kick', 'head_kick'].includes(d.tactic))).toBeGreaterThan(0.85);
      for (const { s, d } of singles) expect(s.range!.mine.find((w) => w.tactic === d.tactic)?.fit).toBe('step');
      expect(share(ds.filter(({ d }) => attacks(d.tactic) && !d.gamble), ({ d }) => d.aggression >= 0.75)).toBeGreaterThan(0.95);
    }
  });

  test('it throws what lands: a weapon that keeps whiffing this fight fades, one that lands takes over', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    const pocket = gaps(fc).pocket;
    const kicks = (mem?: HouseMemory) => share(decisions(fc, sc, pocket, {}, mem), ({ d }) => d.tactic === 'head_kick' || (d.combo ?? []).includes('head_kick'));
    const jabs = (mem?: HouseMemory) => share(decisions(fc, sc, pocket, {}, mem), ({ d }) => d.tactic === 'jab');
    const whiffing = memOf({ head_kick: 0.2, low_kick: 0.2, front_kick: 0.2, jab: 1.8 });
    expect(kicks(whiffing)).toBeLessThan(kicks() * 0.6);
    expect(jabs(whiffing)).toBeGreaterThan(jabs());
  });

  test('his windup in range: beat him to it with a straight that lands (or slip / cover); his blow in the air: never swing into it', () => {
    const { sc, fc } = ctx('haymaker', 'savate');
    const pocket = gaps(fc).pocket;
    const windup = decisions(fc, sc, pocket, { blue: { windup: 0.3, skill: 'cross' } });
    const beat = windup.filter(({ d }) => d.reason === 'he winds up: beat him to it');
    expect(beat.length / windup.length).toBeGreaterThan(0.3);
    for (const { s, d } of beat) {
      expect(['cross', 'jab', 'hook']).toContain(d.tactic);
      expect(s.range!.mine.find((w) => w.tactic === d.tactic)?.fit).toBe('lands');
      expect(d.aggression).toBeGreaterThanOrEqual(0.85);
    }
    expect(windup.every(({ d }) => d.tactic !== 'head_kick' && d.tactic !== 'low_kick')).toBe(true);
    const inAir = decisions(fc, sc, pocket, { blue: { windup: 0, skill: 'cross', skillPhase: 0.5 } });
    expect(inAir.every(({ d }) => d.tactic === 'sidestep_counter' || d.tactic === 'guard')).toBe(true);
    expect(share(inAir, ({ d }) => d.tactic === 'sidestep_counter')).toBeGreaterThan(0.5);
  });

  test('the lunge answer is a counter straight that lands from here half the time, else the slip', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    const ds = decisions(fc, sc, gaps(fc).pocket);
    const counters = ds.map(({ d }) => d.counterIfLunge);
    expect(share(counters, (c) => c === 'sidestep_counter')).toBeGreaterThan(0.3);
    expect(share(counters, (c) => ['cross', 'jab', 'hook'].includes(c))).toBeGreaterThan(0.3);
    const far = decisions(fc, sc, 2.6);
    expect(far.every(({ d }) => d.counterIfLunge === 'sidestep_counter')).toBe(true);
  });

  test('losing badly it eases off the pressure; well ahead it presses harder', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    const pocket = gaps(fc).pocket;
    const losing = decisions(fc, sc, pocket, { red: { damageTotal: 0.6 }, blue: { damageTotal: 0.1 } }, undefined, 50);
    const winning = decisions(fc, sc, pocket, { red: { damageTotal: 0.1 }, blue: { damageTotal: 0.5 } }, undefined, 50);
    const plain = (xs: typeof losing) => xs.filter(({ d }) => !d.gamble && !/winds up|staggered|incoming/.test(d.reason));
    expect(Math.max(...plain(losing).map(({ d }) => d.aggression))).toBeLessThan(0.7);
    expect(Math.min(...plain(winning).map(({ d }) => d.aggression))).toBeGreaterThan(0.85);
  });

  test('never sends again the combination the body is still finishing (it would re-throw its first step)', () => {
    const { sc, fc } = ctx('haymaker', 'firecracker');
    const pocket = gaps(fc).pocket;
    const free = decisions(fc, sc, pocket).map(({ d }) => d.combo?.join('>')).filter((k): k is string => !!k);
    const favourite = [...new Set(free)].sort((a, b) => free.filter((k) => k === b).length - free.filter((k) => k === a).length)[0];
    const steps = favourite.split('>') as Tactic[];
    const busy = decisions(fc, sc, pocket, { red: { intent: { tactic: 'combo', combo: steps, target: 'head', aggression: 0.8, confidence: 1, source: 'fallback' }, comboStep: steps.length } });
    expect(busy.some(({ d }) => d.tactic === 'combo')).toBe(true);
    expect(busy.every(({ d }) => d.combo?.join('>') !== favourite)).toBe(true);
  });

  test('deterministic: the same fight state and record give the same call', () => {
    const { sc, fc } = ctx('pylon', 'savate');
    const mem = memOf({ jab: 1.5, head_kick: 0.3 });
    const s = readSituation(fc, { ...frame(sc, 20, gaps(fc).edge, { red: IQ }), tick: 4242 });
    expect(houseMind(fc, s, 9, mem)).toEqual(houseMind(fc, s, 9, mem));
  });
});

describe('the weapon record (FightMemory)', () => {
  const sc = scene('savate', 'pylon');
  const impact = (impulseNs: number): SimEvent => ({ kind: 'impact', pos: [0, 0, 1], normal: [1, 0, 0], impulseNs, speed: 3, energyJ: 5, striker: 0, victim: 1, part: 'head', metal: true });
  function feed(m: FightMemory, t: number, skill: string, committed: boolean, events: SimEvent[] = []) {
    m.onFrame({ tick: Math.round(t * 1000), time: t, events, telemetry: [telemetry(sc.red, 0, { skill, committed }), telemetry(sc.blue, 1)] });
  }

  test('counts committed throws by weapon and whether they touched him; a pulled feint is no throw', () => {
    const m = new FightMemory(0);
    let t = 0;
    const swing = (skill: string, landed: boolean, committed = true) => {
      for (let k = 0; k < 20; k++, t += 1 / 60) feed(m, t, skill, committed && k >= 8, landed && k === 12 ? [impact(9)] : []);
      for (let k = 0; k < 12; k++, t += 1 / 60) feed(m, t, 'stance', false);
    };
    swing('jab', true);
    swing('jab', true);
    swing('jab', false);
    swing('head_kick', false);
    swing('head_kick', false);
    swing('head_kick', false);
    swing('cross', false, false); // a feint: its windup pulled, never committed
    expect(m.weapon('jab')).toEqual({ thrown: 3, landed: 2 });
    expect(m.weapon('head_kick')).toEqual({ thrown: 3, landed: 0 });
    expect(m.weapon('cross')).toEqual({ thrown: 0, landed: 0 });
    expect(m.landingFactor('jab')).toBeCloseTo(((2 + 1) / 5) / 0.5);
    expect(m.landingFactor('head_kick')).toBeCloseTo(((0 + 1) / 5) / 0.5);
    expect(m.landingFactor('hook')).toBe(1);
    expect(m.weaponsWords()).toBe('your jabs: 2 of 3 landed; your head kicks: 0 of 3 landed');
    expect(m.words()?.yours).toContain('your head kicks: 0 of 3 landed');
  });
});
