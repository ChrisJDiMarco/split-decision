// Ring IQ, mind side: range facts from the body's own skill ranges, the words Jev reads, the tactic
// option notes, the state size, and the House Mind choosing weapons that fit the gap.
import { describe, expect, test } from 'vitest';
import { houseMind } from '../../src/brain/house-mind';
import { buildQuestions, TACTIC_OPTION_MAX_WORDS } from '../../src/brain/questions';
import { readFileSync } from 'node:fs';
import {
  fitAt, fitNote, fromHereWords, hisWeaponsWords, meetWords, RANGE_FACTS, RANGE_WORDING, rangeTable, reachEdgeWords, STEP_LEG_FRACTION, tacticFit, THROW_ZONE, weaponFit, type StrikeFit,
} from '../../src/brain/ranges';
import { distanceWords, serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { isStrike, TACTIC_INFO } from '../../src/brain/tactics';
import type { Tactic } from '../../src/core/protocol';
import type { RobotDesign } from '../../src/core/types';
import { humanoidGeometry } from '../../src/physics/control/geometry';
import { SKILLS, type SkillId } from '../../src/physics/control/skills';
import { DESIGNS } from '../../src/robots/designs';
import { frame, scene } from './fixtures';

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'];
const CLOCK = { round: 1, rounds: 3, remainingS: 100 };

function ctx(red: string, blue: string) {
  const sc = scene(red, blue);
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: red, skin: 'factory', temperament: 1.2, plan: 'Take what he gives you.' });
  return { sc, fc };
}

function strikeAbilities(d: RobotDesign): Tactic[] {
  return d.abilities.filter((a) => a in TACTIC_INFO && isStrike(a as Tactic)) as Tactic[];
}

describe('range table: one source of truth with the body', () => {
  test.each(MODERN)('%s: every strike ability carries its skill\'s own def.range(geo)', (id) => {
    const d = DESIGNS[id];
    const table = rangeTable(d)!;
    const geo = humanoidGeometry(d);
    expect(table.step).toBeCloseTo(STEP_LEG_FRACTION * geo.legLength, 6);
    for (const t of strikeAbilities(d)) {
      const w = table.byTactic.get(t)!;
      const [lo, hi] = SKILLS[w.skill as SkillId]!.range(geo);
      expect([w.lo, w.hi]).toEqual([lo, hi]);
    }
  });

  test.each(MODERN)('%s: fit by distance (too close, lands, one step in, too far)', (id) => {
    const d = DESIGNS[id];
    const table = rangeTable(d)!;
    for (const t of strikeAbilities(d)) {
      const w = table.byTactic.get(t)!;
      expect(tacticFit(d, t, w.lo - 0.02)).toBe('close');
      expect(tacticFit(d, t, (w.lo + w.hi) / 2)).toBe('lands');
      expect(tacticFit(d, t, w.edge + 0.01)).toBe('step');
      expect(tacticFit(d, t, w.edge + table.step / 2)).toBe('step');
      expect(tacticFit(d, t, w.edge + table.step + 0.05)).toBe('far');
    }
  });

  // The body's own decision (control/tactics.ts strike()): it throws from lo..lo + throwAt·(hi − lo) and
  // walks in past that, with the skill control/tactics.ts usable() picks for the tactic (the tactic's
  // own if the design has it, else the design's first strike of the same kind). Swept at 1 cm, every
  // strike tactic (own abilities and menu moves alike), every modern design.
  test.each(MODERN)('%s: the fit matches the body\'s own throw-or-step decision at every gap', (id) => {
    const d = DESIGNS[id];
    const geo = humanoidGeometry(d);
    const step = rangeTable(d)!.step;
    const pool = d.abilities.map((a) => SKILLS[a as SkillId]).filter((x) => !!x && x.kind !== 'defense' && x.kind !== 'grapple');
    for (const t of Object.keys(TACTIC_INFO) as Tactic[]) {
      if (t === 'combo' || !isStrike(t)) continue;
      const fit = tacticFit(d, t, 0.8);
      if (fit === null) continue;
      const own = SKILLS[rangeTable(d)!.byTactic.get(t)!.skill as SkillId]!;
      expect(d.abilities.includes(own.id as never) || pool[0] === own || pool.some((x) => x!.kind === own.kind)).toBe(true);
      const [lo, hi] = own.range(geo);
      const edge = lo + (own.approach?.throwAt ?? THROW_ZONE) * (hi - lo);
      for (let cm = 20; cm <= 220; cm++) {
        const g = cm / 100;
        const body = g < lo ? 'close' : g <= edge ? 'lands' : g <= edge + step ? 'step' : 'far';
        expect(tacticFit(d, t, g), `${t} at ${cm} cm`).toBe(body);
      }
    }
  });

  test('a menu move on a body without its fallback skill reads the strike the body throws instead', () => {
    // HAYMAKER has no head kick: the body throws its first leg strike (low kick) for a tornado kick.
    expect(rangeTable(DESIGNS.haymaker)!.byTactic.get('tornado_kick')!.skill).toBe('low_kick');
    expect(rangeTable(DESIGNS.firecracker)!.byTactic.get('head_kick')!.skill).toBe('front_kick');
    expect(rangeTable(DESIGNS.pylon)!.byTactic.get('hook')!.skill).toBe('jab');
  });

  test('the throw point mirrors the body\'s (control/tactics.ts THROW_ZONE)', () => {
    const src = readFileSync(new URL('../../src/physics/control/tactics.ts', import.meta.url), 'utf8');
    const m = /const THROW_ZONE = ([\d.]+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(THROW_ZONE);
    expect(src).toMatch(/def\.approach \?\? \{ sweet: SWEET_SPOT, throwAt: THROW_ZONE \}/);
  });

  test('flashy moves use the skill the body falls back to; footwork and non-humanoids have no fit', () => {
    const savate = DESIGNS.savate;
    for (const dist of [0.4, 0.7, 0.95, 1.4]) expect(tacticFit(savate, 'tornado_kick', dist)).toBe(tacticFit(savate, 'head_kick', dist));
    expect(tacticFit(savate, 'close_distance', 0.7)).toBeNull();
    expect(tacticFit(savate, 'guard', 0.7)).toBeNull();
    const rover = { ...savate, bodyType: 'wheeled' } as RobotDesign;
    expect(rangeTable(rover)).toBeNull();
    expect(tacticFit(rover, 'jab', 0.7)).toBeNull();
  });

  test('one step in mirrors the walk\'s longest stride (walk.ts MAX_STRIDE)', () => {
    const src = readFileSync(new URL('../../src/physics/control/walk.ts', import.meta.url), 'utf8');
    const m = /const MAX_STRIDE = ([\d.]+)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(STEP_LEG_FRACTION);
  });

  test('weaponFit: a working weapon by its fit, a broken one "out", flashy moves through their fallback skill, footwork none', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    const f = frame(sc, 40, 0.7);
    f.telemetry[0].parts = f.telemetry[0].parts.map((p) => (p.id === 'fist_l' ? { ...p, attached: false } : p));
    const s = readSituation(fc, f);
    expect(weaponFit(fc.design, s.range, 'cross')).toBe('lands');
    expect(weaponFit(fc.design, s.range, 'jab')).toBe('out');
    expect(weaponFit(fc.design, s.range, 'tornado_kick')).toBe(tacticFit(fc.design, 'head_kick', 0.7));
    expect(weaponFit(fc.design, s.range, 'close_distance')).toBeNull();
    expect(weaponFit(fc.design, s.range, 'combo')).toBeNull();
    expect(weaponFit(fc.design, null, 'cross')).toBeNull();
  });

  test('the A/B switch: off, there are no range facts and the mind reads the old reach band', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    RANGE_FACTS.enabled = false;
    try {
      const s = readSituation(fc, frame(sc, 40, 0.7));
      expect(s.range).toBeNull();
      const g = serializeState(fc, s, [], CLOCK, null).geometry;
      expect(g.reach).toMatch(/his reach$/);
      expect(g.from_here).toBeUndefined();
    } finally {
      RANGE_FACTS.enabled = true;
    }
  });

  test('longer bodies out-reach shorter ones (PYLON vs FIRECRACKER)', () => {
    const hi = (id: string) => Math.max(...[...rangeTable(DESIGNS[id])!.byTactic.values()].filter((w) => DESIGNS[id].abilities.includes(w.tactic as never)).map((w) => w.hi));
    expect(hi('pylon')).toBeGreaterThan(hi('firecracker') + 0.2);
  });
});

describe('range words', () => {
  test('from here: grouped by fit, the biggest group folded into "the rest"', () => {
    expect(fromHereWords([{ tactic: 'jab', fit: 'lands' }, { tactic: 'cross', fit: 'lands' }])).toBe('everything lands');
    expect(fromHereWords([{ tactic: 'jab', fit: 'lands' }, { tactic: 'cross', fit: 'lands' }, { tactic: 'head_kick', fit: 'step' }])).toBe('head kick lands with a step in; the rest land');
    // The edge wording the live A/B picked (tests/brain/live-edge.ts); the first version still reads as before.
    expect(RANGE_WORDING.step).toBe('lands');
    expect(fromHereWords([{ tactic: 'jab', fit: 'step' }, { tactic: 'cross', fit: 'step' }])).toBe('everything lands with a step in');
    RANGE_WORDING.step = 'needs';
    try {
      expect(fromHereWords([{ tactic: 'jab', fit: 'lands' }, { tactic: 'cross', fit: 'lands' }, { tactic: 'head_kick', fit: 'step' }])).toBe('head kick needs a step in; the rest land');
      expect(fitNote('step')).toBe('needs a step in');
    } finally {
      RANGE_WORDING.step = 'lands';
    }
    expect(fitNote('step')).toBe('lands with a step in');
    expect(fromHereWords([{ tactic: 'uppercut', fit: 'close' }, { tactic: 'jab', fit: 'lands' }, { tactic: 'head_kick', fit: 'far' }])).toBe('jab lands; uppercut too close; the rest too far');
    expect(fromHereWords([])).toBeNull();
  });

  test('his weapons, reach edge and meeting time', () => {
    expect(hisWeaponsWords([{ tactic: 'jab', fit: 'lands' }, { tactic: 'low_kick', fit: 'step' }])).toBe('his jab reaches you');
    expect(hisWeaponsWords([{ tactic: 'jab', fit: 'step' }, { tactic: 'low_kick', fit: 'step' }])).toBe('all his weapons one step off');
    expect(hisWeaponsWords([{ tactic: 'jab', fit: 'far' }])).toBe('out of his range');
    expect(reachEdgeWords(0.94, 0.8)).toBe('you out-reach him by ~15 cm');
    expect(reachEdgeWords(0.67, 0.94)).toBe('he out-reaches you by ~25 cm');
    expect(reachEdgeWords(0.86, 0.88)).toBe('even reach');
    expect(meetWords(0.3)).toBe('in range in under half a second');
    expect(meetWords(1)).toBe('in range in about a second');
    expect(meetWords(null)).toBeNull();
    expect(meetWords(4)).toBeNull();
  });

  test('fitAt boundaries are inclusive at the throw edge', () => {
    expect(fitAt({ lo: 0.4, edge: 0.8 }, 0.8, 0.3)).toBe('lands');
    expect(fitAt({ lo: 0.4, edge: 0.8 }, 0.81, 0.3)).toBe('step');
    expect(fitAt({ lo: 0.4, edge: 0.8 }, 1.1, 0.3)).toBe('step');
  });
});

describe('serialized range facts', () => {
  test('the state says what lands, what of his reaches, the reach edge and when they meet, in words', () => {
    const { sc, fc } = ctx('firecracker', 'pylon');
    const s = readSituation(fc, frame(sc, 40, 1.2, { blue: { velocity: [-1.5, 0, 0] } }));
    const g = serializeState(fc, s, [], CLOCK, null).geometry;
    expect(g.from_here).toBe('everything too far');
    expect(g.his_weapons).toMatch(/one step off/);
    expect(g.reach).toMatch(/^he out-reaches you by ~\d+ cm$/);
    expect(g.closing).toMatch(/^closing (slowly|fast), in range in /);
    expect(JSON.stringify(g)).not.toMatch(/\d\.\d/);
  });

  test('the distance word follows the weapons, never contradicting from_here', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    for (const d of [0.7, 0.95, 1.4]) {
      const s = readSituation(fc, frame(sc, 40, d));
      const g = serializeState(fc, s, [], CLOCK, null).geometry;
      const lands = s.range!.mine.some((w) => w.fit === 'lands');
      expect(g.distance === 'striking range').toBe(lands);
      if (!lands && s.range!.mine.some((w) => w.fit === 'step')) expect(distanceWords(s)).toBe('just outside reach');
    }
  });

  test('a weapon damage took away drops out of the line, and its option says so', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    const f = frame(sc, 40, 0.7);
    f.telemetry[0].parts = f.telemetry[0].parts.map((p) => (p.id === 'fist_l' ? { ...p, attached: false } : p));
    const s = readSituation(fc, f);
    expect(s.range!.mine.map((w) => w.tactic)).not.toContain('jab');
    const qs = buildQuestions(fc, s.opp, { range: s.range });
    expect((qs.questions.tactic as { criteria: Record<string, string> }).criteria.jab).toMatch(/out of action$/);
  });

  test('state size: the range facts add under 40 tokens (chars / 4)', () => {
    const { sc, fc } = ctx('savate', 'haymaker');
    const recent = [{ action: 'jab' as const, time: 38 }];
    let worst = 0;
    for (const d of [0.45, 0.8, 0.95, 1.3, 2.5]) {
      const s = readSituation(fc, frame(sc, 40, d, { blue: { velocity: [-1.2, 0, 0] } }));
      const withRange = JSON.stringify(serializeState(fc, s, recent, CLOCK, 'jab')).length / 4;
      const without = JSON.stringify(serializeState(fc, { ...s, range: null }, recent, CLOCK, 'jab')).length / 4;
      worst = Math.max(worst, withRange - without);
    }
    console.log(`range facts add at most ~${Math.round(worst)} tokens to the state`);
    expect(worst).toBeLessThan(40);
  });
});

describe('tactic options annotated by range', () => {
  test.each(MODERN)('%s: strikes say how they fit, footwork stays plain, every option within its word budget', (id) => {
    const { sc, fc } = ctx(id, id === 'pylon' ? 'firecracker' : 'pylon');
    for (const d of [0.35, 0.6, 0.8, 1.0, 1.6]) {
      const s = readSituation(fc, frame(sc, 40, d));
      const qs = buildQuestions(fc, s.opp, { range: s.range });
      const criteria = (qs.questions.tactic as { criteria: Record<string, string> }).criteria;
      for (const t of qs.tactics) {
        const text = criteria[t];
        expect(text.split(/\s+/).length).toBeLessThanOrEqual(TACTIC_OPTION_MAX_WORDS);
        const fit = tacticFit(fc.design, t, d);
        if (fit && t !== 'combo') expect(text).toMatch(/(lands from here|lands with a step in|too close for it|too far from here)$/);
        else expect(text).toBe(TACTIC_INFO[t].description);
      }
    }
  });

  test('without range facts the options are unchanged', () => {
    const { sc, fc } = ctx('savate', 'pylon');
    const s = readSituation(fc, frame(sc, 40, 0.8));
    const criteria = (buildQuestions(fc, s.opp).questions.tactic as { criteria: Record<string, string> }).criteria;
    expect(criteria.jab).toBe(TACTIC_INFO.jab.description);
  });
});

describe('House Mind by range', () => {
  const PAIRS: Array<[string, string]> = [['savate', 'haymaker'], ['firecracker', 'pylon'], ['pylon', 'firecracker'], ['haymaker', 'savate']];

  /** The strike an intent would throw first (a combo by its opener) and its fit where it was chosen. */
  function decisions(red: string, blue: string, dist: number, n = 150) {
    const { sc, fc } = ctx(red, blue);
    const out: Array<{ tactic: Tactic; strike: Tactic | null; fit: StrikeFit | null; reason: string }> = [];
    for (let i = 0; i < n; i++) {
      const s = readSituation(fc, { ...frame(sc, 20 + i * 0.25, dist), tick: 1000 + i * 13 });
      const d = houseMind(fc, s, 11);
      const strike = d.tactic === 'combo' ? d.combo?.find((t) => isStrike(t)) ?? null : isStrike(d.tactic) ? d.tactic : null;
      out.push({ tactic: d.tactic, strike, fit: strike ? tacticFit(fc.design, strike, dist) : null, reason: d.reason });
    }
    return out;
  }

  test.each(PAIRS)('%s v %s: in range it throws weapons that land (or step in behind one), never one that cannot', (red, blue) => {
    const table = rangeTable(DESIGNS[red])!;
    const his = rangeTable(DESIGNS[blue])!;
    // A gap where most of my weapons land and his may too: the middle of my jab's range.
    const jab = table.byTactic.get('jab')!;
    const dist = (jab.lo + jab.hi) / 2 + 0.05;
    const ds = decisions(red, blue, dist);
    const strikes = ds.filter((d) => d.strike);
    expect(strikes.length).toBeGreaterThan(40);
    for (const d of strikes) expect(['lands', 'step']).toContain(d.fit);
    expect(strikes.filter((d) => d.fit === 'lands').length).toBeGreaterThan(strikes.length * 0.7);
    expect(his.step).toBeGreaterThan(0);
  });

  test.each(PAIRS)('%s v %s: one step out it enters WITH a strike, not by walking in', (red, blue) => {
    const d = DESIGNS[red];
    const table = rangeTable(d)!;
    const longest = Math.max(...strikeAbilities(d).map((t) => table.byTactic.get(t)!.edge));
    const ds = decisions(red, blue, longest + table.step * 0.5);
    const strikes = ds.filter((x) => x.strike);
    expect(strikes.length).toBeGreaterThan(ds.length * 0.5);
    for (const x of strikes) expect(['lands', 'step']).toContain(x.fit);
    expect(ds.filter((x) => x.tactic === 'close_distance').length).toBe(0);
  });

  test('out of range it closes the distance; no strike is thrown from too far', () => {
    for (const [red, blue] of PAIRS) {
      const ds = decisions(red, blue, 1.6, 60);
      for (const x of ds) if (x.strike) expect(x.fit === 'far').toBe(false);
      expect(ds.filter((x) => x.tactic === 'close_distance').length).toBeGreaterThan(30);
    }
  });

  test('in the clinch: never a head kick or anything too close for it', () => {
    // 0.55 m: still the clinch band, but inside PYLON's and SAVATE's head-kick range by the table.
    for (const red of ['savate', 'pylon', 'haymaker', 'firecracker']) {
      for (const dist of [0.5, 0.55]) {
        const ds = decisions(red, 'savate', dist, 120);
        for (const x of ds) {
          expect(x.strike).not.toBe('head_kick');
          if (x.strike) expect(x.fit).not.toBe('close');
        }
      }
    }
  });

  test('a weapon damage took away is never chosen', () => {
    const { sc, fc } = ctx('savate', 'haymaker');
    for (let i = 0; i < 150; i++) {
      const f = { ...frame(sc, 20 + i * 0.25, 0.65), tick: 1000 + i * 13 };
      f.telemetry[0].parts = f.telemetry[0].parts.map((p) => (p.id === 'fist_l' ? { ...p, attached: false } : p));
      const d = houseMind(fc, readSituation(fc, f), 11);
      expect(d.tactic).not.toBe('jab');
      if (d.combo) expect(d.combo.find((t) => isStrike(t))).not.toBe('jab');
    }
  });

  test('never an uppercut from outside its range', () => {
    for (const red of ['firecracker', 'haymaker']) {
      const up = rangeTable(DESIGNS[red])!.byTactic.get('uppercut')!;
      for (const dist of [up.hi + 0.02, up.hi + 0.3, 1.5]) {
        for (const x of decisions(red, 'pylon', dist, 100)) if (x.strike === 'uppercut') expect(x.fit).not.toBe('far');
      }
    }
  });
});
