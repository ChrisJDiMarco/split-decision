// The reviewer's fixes to the creative brain: pre-armed opening reflexes (on_opening → Intent.onOpening),
// the kip-up appetite (a seeded draw scaled by style, temperament and body), side-on vs turned-away
// words, and injury-aware combos.
import { describe, expect, test } from 'vitest';
import { Brain } from '../../src/brain/brain';
import { NOTHING, openingsWords, reflexArming, reflexMenu } from '../../src/brain/gambles';
import { houseMind, kipAppetite } from '../../src/brain/house-mind';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink } from '../../src/brain/link';
import { readyCombos } from '../../src/brain/limbs';
import { decideGambles, kipChance, parseExtras, sampleKip } from '../../src/brain/policy';
import { buildQuestions, comboQuestion } from '../../src/brain/questions';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { comboId, designCombos } from '../../src/brain/style';
import type { BrainDecision } from '../../src/brain/types';
import type { Intent, Opening, RobotTelemetry } from '../../src/core/protocol';
import { armedLine } from '../../src/ui/minds';
import { flush, frame, scene, telemetry, type Scene } from './fixtures';

const RISK = { tornado_kick: 0.55, spinning_back_kick: 0.3, jump_kick: 0.42, jumping_knee: 0.3, superman_punch: 0.22, spinning_backfist: 0.1, kip_up: 0.35 };

function me(openings: Opening[] = [], extra: Partial<RobotTelemetry> = {}): Partial<RobotTelemetry> {
  return { openings, moveRisk: { ...RISK }, stance: 'orthodox', facingOffDeg: -12, ...extra };
}

function setup(red: string, blue: string, temperament = 1) {
  const sc = scene(red, blue);
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: red, skin: 'factory', plan: 'Take the openings.', temperament });
  return { sc, fc };
}

/** A limb joint (by exact name) set limp on a design's fresh telemetry. */
function limp(sc: Scene, names: string[]): Partial<RobotTelemetry> {
  const joints = sc.red.parts.flatMap((p) => (p.joints ?? []).map((j) => ({ name: j.name, health: names.includes(j.name) ? 0.02 : 1, state: names.includes(j.name) ? 'limp' as const : 'ok' as const, tempC: 30, torqueFrac: 0 })));
  return { joints };
}

function answer(questions: Record<string, JevQuestion>, prefer: Record<string, string | number>): JevResult {
  const answers: JevResult['answers'] = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const top = typeof prefer[id] === 'string' && keys.includes(prefer[id] as string) ? (prefer[id] as string) : keys[0];
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === top ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]));
      answers[id] = { type: 'choice', choice: top, confidence: 0.85, probabilities };
    } else if (q.type === 'noul') answers[id] = { type: 'noul', noul: typeof prefer[id] === 'number' ? (prefer[id] as number) : 0.3 };
    else answers[id] = { type: 'score', score: 3, confidence: 0.6, probabilities: Object.fromEntries(q.criteria.map((c) => [c, 1 / q.criteria.length])) };
  }
  return { answers, latencyMs: 230, inputTokens: 1400, outputTokens: 30 };
}

function brainWith(sc: Scene, prefer: Record<string, string | number>, temperament = 1.3, seed = 9) {
  const clock = { t: 0 };
  const calls: Array<Record<string, JevQuestion>> = [];
  const link = new JevLink({ now: () => clock.t, ask: (_s, q) => { calls.push(q); return Promise.resolve(answer(q, prefer)); } });
  const intents: Intent[] = [];
  const decisions: BrainDecision[] = [];
  const brain = new Brain({
    corner: 0, meta: sc.meta, seed, link,
    fighter: { design: sc.meta.robots[0].design, skin: 'factory', plan: 'Take every opening.', temperament },
    onIntent: (_c, i) => intents.push(i), onDecision: (d) => decisions.push(d),
  });
  brain.start();
  return { brain, calls, intents, decisions, clock };
}

async function run(b: ReturnType<typeof brainWith>, sc: Scene, from: number, to: number, red: Partial<RobotTelemetry>, distance = 1.0) {
  for (let t = from; t < to; t += 1 / 60) {
    b.clock.t = t * 1000;
    b.brain.onFrame(frame(sc, t, distance, { red }));
    await flush();
  }
}

// ---------------------------------------------------------------- 1. opening reflexes

describe('pre-armed opening reflexes', () => {
  test('the menu: whiff and overcommit exploits, then the style\'s flashy moves; only what the body can throw', () => {
    const { sc, fc } = setup('pylon', 'haymaker');
    const s = readSituation(fc, frame(sc, 10, 1, { red: me() }));
    const moves = reflexMenu(fc.design, s.me).map((i) => i.move);
    expect(moves.length).toBeGreaterThanOrEqual(4);
    expect(moves.length).toBeLessThanOrEqual(6);
    expect(moves[0]).toBe('spinning_backfist'); // the best answer to a whiff leads
    expect(moves).toContain('sidestep_counter');
    expect(moves).toContain('spinning_back_kick'); // the style's signature spin is armable
    const { sc: sk, fc: sf } = setup('savate', 'haymaker');
    expect(reflexMenu(sf.design, readSituation(sf, frame(sk, 10, 1, { red: me() })).me).map((i) => i.move)).toContain('tornado_kick');
    expect(moves).not.toContain('combo');
    // A limp knee rules out the leg flashies; a dead left arm rules out the hook.
    const hurt = readSituation(fc, frame(sc, 10, 1, { red: me([], { moveRisk: { ...RISK, tornado_kick: 1, spinning_back_kick: 1, jump_kick: 1, jumping_knee: 1 } }) }));
    const hurtMoves = reflexMenu(fc.design, hurt.me).map((i) => i.move);
    for (const m of ['tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee']) expect(hurtMoves).not.toContain(m);
    const { sc: sc2, fc: fc2 } = setup('haymaker', 'savate');
    const armDead = readSituation(fc2, frame(sc2, 10, 1, { red: { ...me(), ...limp(sc2, ['elbow_l']) } }));
    expect(reflexMenu(fc2.design, armDead.me).map((i) => i.move)).not.toContain('hook');
  });

  test('a sidestep only answers an overcommit; any strike answers both', () => {
    expect(reflexArming('sidestep_counter')).toEqual({ overcommitted: 'sidestep_counter' });
    expect(reflexArming('spinning_backfist')).toEqual({ missed_recovering: 'spinning_backfist', overcommitted: 'spinning_backfist' });
  });

  test('on_opening rides in the same call, in range only; its answer becomes Intent.onOpening', async () => {
    const sc = scene('pylon', 'haymaker');
    const b = brainWith(sc, { tactic: 'jab', on_opening: 'spinning_backfist' });
    await run(b, sc, 0, 1.5, me());
    expect(b.calls.length).toBeGreaterThanOrEqual(5);
    expect(b.calls.length).toBeLessThanOrEqual(7); // no extra calls: same ~4 Hz
    const q = b.calls[0].on_opening;
    if (q?.type !== 'choice') throw new Error('on_opening must be a choice');
    expect(q.instructions).toMatch(/whiffs a strike or overcommits in the next second/);
    expect(Object.keys(q.criteria)).toContain(NOTHING);
    expect(q.criteria.spinning_backfist).toMatch(/low fall risk; payoff: /);
    expect(q.criteria.cross ?? null).toBeNull(); // described once, in the tactic question
    const armed = b.intents.filter((i) => i.onOpening);
    expect(armed.length).toBeGreaterThan(b.intents.length / 2);
    for (const i of armed) expect(Object.keys(i.onOpening!).sort()).toEqual(['missed_recovering', 'overcommitted']);
    expect(armed.filter((i) => i.onOpening!.missed_recovering === 'spinning_backfist').length).toBeGreaterThan(armed.length / 2);
    const d = b.decisions.find((x) => x.onOpening)!;
    expect(armedLine(d)).toMatch(/^ARMED: WHIFF → /);
    // Out at mid range nothing is armed and the question is not asked.
    const far = brainWith(sc, { tactic: 'close_distance', on_opening: 'spinning_backfist' });
    await run(far, sc, 0, 1.5, me(), 2.6);
    expect(far.calls.every((c) => !c.on_opening)).toBe(true);
    expect(far.intents.every((i) => !i.onOpening)).toBe(true);
    // Nor with him down on the canvas in range (he cannot whiff or overcommit; the House Mind skips it too).
    const floored = brainWith(sc, { tactic: 'hold_range', on_opening: 'spinning_backfist' });
    for (let t = 0; t < 1.5; t += 1 / 60) {
      floored.clock.t = t * 1000;
      floored.brain.onFrame(frame(sc, t, 1.0, { red: me(['rising']), blue: { down: true, upright: 0.1 } }));
      await flush();
    }
    expect(floored.calls.length).toBeGreaterThan(0);
    expect(floored.calls.every((c) => !c.on_opening)).toBe(true);
    expect(floored.intents.every((i) => !i.onOpening)).toBe(true);
  });

  test('"nothing" arms nothing; a disciplined fighter arms the risky spin less often than a wild one', () => {
    const { sc, fc } = setup('savate', 'haymaker');
    const s = readSituation(fc, frame(sc, 10, 1, { red: me() }));
    const reflex = reflexMenu(fc.design, s.me);
    const qs = buildQuestions(fc, s.opp, { reflex });
    const nothing = answer(qs.questions, { on_opening: NOTHING });
    const probs = (move: string) => answer(qs.questions, { on_opening: move });
    const g = (res: JevResult, appetite: number, tick: number) => decideGambles({ extras: parseExtras(res, qs), qs, appetite, temperature: 1, kipRisk: null, seed: 4, corner: 0, tick });
    let none = 0;
    for (let t = 0; t < 200; t++) if (!g(nothing, 1, t).onOpening) none++;
    expect(none).toBeGreaterThan(150);
    const tornado = (appetite: number) => {
      let n = 0;
      for (let t = 0; t < 400; t++) if (g(probs('tornado_kick'), appetite, t).onOpening?.missed_recovering === 'tornado_kick') n++;
      return n;
    };
    expect(tornado(2.2)).toBeGreaterThan(tornado(0.4));
  });

  test('the House Mind arms reflexes too, in range, from its style\'s favourites', () => {
    const { sc, fc } = setup('savate', 'haymaker', 1.4);
    let armed = 0;
    for (let i = 0; i < 200; i++) {
      const d = houseMind(fc, readSituation(fc, frame(sc, 10 + i * 0.25, 1, { red: me() })), 5);
      if (d.onOpening) {
        armed++;
        expect(Object.values(d.onOpening).every((m) => typeof m === 'string')).toBe(true);
      }
      expect(houseMind(fc, readSituation(fc, frame(sc, 10 + i * 0.25, 2.6, { red: me() })), 5).onOpening).toBeUndefined();
    }
    expect(armed).toBeGreaterThan(100);
    expect(armed).toBeLessThan(180);
  });

  test('ARMED line wording', () => {
    const base = { source: 'jev' as const, tactic: 'jab', target: 'head', aggression: 0.6, tacticProbs: { jab: 1 }, oppCommit: null, latencyMs: 200 };
    expect(armedLine({ ...base, onOpening: { missed_recovering: 'spinning_backfist', overcommitted: 'spinning_backfist' } })).toBe('ARMED: WHIFF → SPINNING BACKFIST');
    expect(armedLine({ ...base, onOpening: { overcommitted: 'sidestep_counter' } })).toBe('ARMED: OVERCOMMIT → SIDESTEP COUNTER');
    expect(armedLine({ ...base, onOpening: { missed_recovering: 'cross', overcommitted: 'sidestep_counter' } })).toBe('ARMED: WHIFF → CROSS · OVERCOMMIT → SIDESTEP COUNTER');
    expect(armedLine(base)).toBeNull();
    expect(armedLine({ ...base, onOpening: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------- 2. kip-up appetite

describe('kip-up appetite', () => {
  test('kipChance: Jev\'s usual 0.33 becomes an attempt for a light wild body, rarely for a heavy disciplined one', () => {
    const light = kipAppetite(setup('firecracker', 'savate', 1.6).fc);
    const heavy = kipAppetite(setup('haymaker', 'savate', 0.5).fc);
    expect(kipChance(0.33, light, 0.29)).toBeGreaterThan(0.55);
    expect(kipChance(0.33, heavy, 0.75)).toBeLessThan(0.15);
    expect(kipChance(0.33, heavy, 0.75)).toBeGreaterThan(0.02);
    expect(kipChance(0.33, 1, 0.4)).toBeGreaterThan(0.33); // the showman factor: more attempts than Jev's own p
    expect(kipChance(0.9, 2.5, 1)).toBe(0); // a limp joint: impossible
    expect(kipChance(0.6, 1, 0.4)).toBeGreaterThan(kipChance(0.3, 1, 0.4)); // monotone in Jev's p
  });

  test('the draw is seeded (a replay kips up at the same knockdowns) and hits its chance', () => {
    const appetite = 1.3;
    const draws = Array.from({ length: 1000 }, (_, t) => sampleKip(0.33, appetite, 0.35, 11, 0, t));
    expect(Array.from({ length: 1000 }, (_, t) => sampleKip(0.33, appetite, 0.35, 11, 0, t))).toEqual(draws);
    const rate = draws.filter((d) => d === 'kip_up').length / 1000;
    expect(Math.abs(rate - kipChance(0.33, appetite, 0.35))).toBeLessThan(0.05);
  });

  test('Jev-driven: a light wild fighter answering 0.33 kips up in most knockdowns', async () => {
    const sc = scene('firecracker', 'haymaker');
    let kips = 0;
    const N = 12;
    for (let seed = 1; seed <= N; seed++) {
      const b = brainWith(sc, { getup_style: 0.33 }, 1.6, seed);
      await run(b, sc, 0, 0.6, { ...me([], { moveRisk: { ...RISK, kip_up: 0.29 } }), down: true, upright: 0.1 });
      const d = b.decisions.find((x) => x.reason.startsWith('down: ') && x.source === 'jev')!;
      expect(d.reason).toMatch(/\(Jev 33%, appetite \d+%\)$/);
      if (b.intents.at(-1)!.getupStyle === 'kip_up') kips++;
    }
    expect(kips).toBeGreaterThanOrEqual(N / 2);
  });
});

// ---------------------------------------------------------------- 4. side-on vs turned away

test('side-on and turned-away read honestly', () => {
  const { sc } = setup('savate', 'haymaker');
  const opp = telemetry(sc.blue, 1);
  expect(openingsWords(['side_on'], opp)).toBe("he's side-on to you");
  expect(openingsWords(['turned_away'], opp)).toBe('his back is to you');
  const { fc } = setup('savate', 'haymaker');
  const s = readSituation(fc, frame(sc, 10, 1, { red: me() }));
  expect(buildQuestions(fc, s.opp).tactics.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- 5. injury-aware combos

describe('injury-aware combos', () => {
  test('combos with a dead limb or an impossible flashy move are dropped', () => {
    const { sc, fc } = setup('firecracker', 'haymaker');
    const all = designCombos(fc.design);
    const fresh = readSituation(fc, frame(sc, 10, 1, { red: me() })).me;
    expect(readyCombos(fresh, all)).toEqual(all);
    const noLeftArm = readSituation(fc, frame(sc, 10, 1, { red: { ...me(), ...limp(sc, ['shoulder_pitch_l']) } })).me;
    const left = readyCombos(noLeftArm, all);
    expect(left.length).toBeLessThan(all.length);
    for (const c of left) expect(c).not.toContain('jab'), expect(c).not.toContain('hook');
    const noKnees = readSituation(fc, frame(sc, 10, 1, { red: me([], { moveRisk: { ...RISK, jumping_knee: 1, superman_punch: 1 } }) })).me;
    for (const c of readyCombos(noKnees, all)) expect(c).not.toContain('jumping_knee'), expect(c).not.toContain('superman_punch');
    const legDead = readSituation(fc, frame(sc, 10, 1, { red: { ...me(), ...limp(sc, ['knee_r']) } })).me;
    for (const c of readyCombos(legDead, all)) expect(c).not.toContain('low_kick');
  });

  test('the Brain asks only about combos the body can throw (and none when no combo is left)', async () => {
    const sc = scene('firecracker', 'haymaker');
    const b = brainWith(sc, { tactic: 'combo' });
    await run(b, sc, 0, 1, { ...me(), ...limp(sc, ['elbow_l']) });
    const q = b.calls[0].combo;
    if (q?.type !== 'choice') throw new Error('combo must be a choice');
    for (const id of Object.keys(q.criteria)) expect(id.split('-')).not.toContain('jab');
    for (const i of b.intents.filter((x) => x.tactic === 'combo')) {
      // A setup → payoff pick is keyed by its setup id ('fake_low_go_high'); a plain one by its strikes.
      if (i.comboPlan) expect(Object.values(q.criteria).some((t) => t?.startsWith('setup:'))).toBe(true);
      else expect(Object.keys(q.criteria)).toContain(comboId(i.combo!));
      for (const t of i.combo!) expect(['jab', 'hook']).not.toContain(t);
    }
    const both = brainWith(sc, { tactic: 'combo' });
    await run(both, sc, 0, 1, { ...me(), ...limp(sc, ['elbow_l', 'elbow_r']), moveRisk: { ...RISK, jumping_knee: 1 } });
    expect(both.calls.every((c) => !c.combo)).toBe(true);
  });

  test('the combo question is lean: plain strike lists, the signature note once', () => {
    const { fc } = setup('savate', 'haymaker');
    const q = comboQuestion(fc, designCombos(fc.design));
    if (q.type !== 'choice') throw new Error('combo must be a choice');
    expect(q.instructions).toMatch(/The first 8 are signature combinations for a kickboxer\.$/);
    // Was ~900 characters with "(a signature combination for a kickboxer)" on every option.
    expect(JSON.stringify(q).length).toBeLessThan(600);
  });
});
