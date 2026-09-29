// Fighter intelligence in the brain: openings and risk in words, the opening_move / combo /
// getup_style questions per design, the per-fight memory, House Mind rules, and intent mapping
// with a mocked Jev.
import { describe, expect, test } from 'vitest';
import { Brain } from '../../src/brain/brain';
import { gambleAppetite, gambleWeights, NONE, openingMenu, riskBand } from '../../src/brain/gambles';
import { houseMind, obviousDecision } from '../../src/brain/house-mind';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink } from '../../src/brain/link';
import { FightMemory, plural } from '../../src/brain/memory';
import { buildQuestions } from '../../src/brain/questions';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { canThrow, comboId, designCombos, styleOf, STYLES } from '../../src/brain/style';
import { TACTIC_INFO } from '../../src/brain/tactics';
import type { BrainDecision } from '../../src/brain/types';
import type { Intent, Opening, RobotTelemetry, SimEvent, Tactic } from '../../src/core/protocol';
import { fallbackTactic } from '../../src/physics/control/tactics';
import { TACTIC_SKILL } from '../../src/physics/control/abilities';
import { DESIGNS } from '../../src/robots/designs';
import { flush, frame, scene, type Scene } from './fixtures';

const CLOCK = { round: 1, rounds: 3, remainingS: 120 };
const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'] as const;
const RISK = { tornado_kick: 0.55, spinning_back_kick: 0.3, jump_kick: 0.42, jumping_knee: 0.3, superman_punch: 0.22, spinning_backfist: 0.1, kip_up: 0.35 };
const describeTactic = (t: Tactic) => TACTIC_INFO[t].description;

function me(openings: Opening[], extra: Partial<RobotTelemetry> = {}): Partial<RobotTelemetry> {
  return { openings, moveRisk: { ...RISK }, stance: 'orthodox', facingOffDeg: -12, ...extra };
}

function setup(red: string, blue: string, temperament = 1) {
  const sc = scene(red, blue);
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: red, skin: 'factory', plan: 'Fight smart, take the openings.', temperament });
  return { sc, fc };
}

describe('state words', () => {
  test('openings, stance, risk bands and the record read as words', () => {
    const { sc, fc } = setup('savate', 'haymaker');
    const f = frame(sc, 10, 1.0, {
      red: me(['turned_away', 'weak_left_leg', 'missed_recovering', 'low_guard']),
      blue: { skill: 'hook', joints: sc.blue.parts.flatMap((p) => (p.joints ?? []).map((j) => ({ name: j.name, health: j.name === 'knee_l' ? 0.3 : 1, state: j.name === 'knee_l' ? 'degraded' as const : 'ok' as const, tempC: 30, torqueFrac: 0 }))) },
    });
    const state = serializeState(fc, readSituation(fc, f), [], CLOCK, 'jab', { yours: 'your tornado kicks: 1 of 3 landed, fell once', his: 'his low kicks keep landing' });
    expect(state.opponent.openings).toBe('his back is to you; his left knee is failing; he just missed a hook and is recovering; his hands are down');
    expect(state.you.flashy_risk).toContain('tornado kick: high fall risk');
    expect(state.you.flashy_risk).toContain('spinning backfist: low fall risk');
    expect(state.you.flashy_risk).toContain('kip-up: moderate fall risk');
    expect(state.you.stance).toBe('orthodox, squared up');
    expect(state.you.style).toMatch(/^a kickboxer/);
    expect(state.record).toEqual({ yours: 'your tornado kicks: 1 of 3 landed, fell once', his: 'his low kicks keep landing' });
    // No numbers leak into the new fields.
    for (const text of [state.opponent.openings, state.you.flashy_risk, state.you.stance]) expect(text).not.toMatch(/\d/);
  });

  test('without openings telemetry (an old frame) the new keys are simply absent', () => {
    const { sc, fc } = setup('savate', 'haymaker');
    const state = serializeState(fc, readSituation(fc, frame(sc, 10, 1.0)), [], CLOCK, null);
    expect(state.opponent.openings).toBeUndefined();
    expect(state.you.flashy_risk).toBeUndefined();
    expect(state.record).toBeUndefined();
    expect(serializeState(fc, readSituation(fc, frame(sc, 10, 1.0, { red: me([]) })), [], CLOCK, null).opponent.openings).toBe('no clear opening');
  });

  test('risk bands', () => {
    expect(riskBand(0.1)).toBe('low fall risk');
    expect(riskBand(0.3)).toBe('moderate fall risk');
    expect(riskBand(0.5)).toBe('high fall risk');
    expect(riskBand(0.8)).toBe('very high fall risk');
    expect(riskBand(1)).toBe('impossible right now');
  });
});

describe('question sets per design', () => {
  test('opening_move offers only moves the design can throw, each with risk and payoff, plus none', () => {
    for (const id of MODERN) {
      const { sc, fc } = setup(id, 'savate');
      const s = readSituation(fc, frame(sc, 10, 1.0, { red: me(['low_guard', 'missed_recovering', 'turned_away']) }));
      const menu = openingMenu(fc.design, s.me, s.me.openings!, describeTactic, false);
      const qs = buildQuestions(fc, s.opp, { menu, combos: designCombos(fc.design) });
      const q = qs.questions.opening_move;
      if (q?.type !== 'choice') throw new Error('opening_move must be a choice');
      const keys = Object.keys(q.criteria);
      expect(keys).toContain(NONE);
      expect(keys.length).toBeGreaterThanOrEqual(3);
      expect(keys.length).toBeLessThanOrEqual(9);
      for (const k of keys.filter((k) => k !== NONE)) {
        expect(canThrow(fc.design, k as Tactic) || ['sidestep_counter', 'cage_pin', 'combo'].includes(k)).toBe(true);
        expect(q.criteria[k]).toBeTruthy();
      }
      const flashyKeys = keys.filter((k) => k in RISK);
      for (const k of flashyKeys) expect(q.criteria[k]).toMatch(/fall risk; payoff: /);
    }
  });

  test('designs get different flashy menus', () => {
    const menuFor = (id: string) => {
      const { sc, fc } = setup(id, 'savate');
      const s = readSituation(fc, frame(sc, 10, 1.0, { red: me([]) }));
      return openingMenu(fc.design, s.me, [], describeTactic, true).items.map((i) => i.move);
    };
    expect(menuFor('firecracker')).not.toContain('tornado_kick'); // no head kick to build it on
    expect(menuFor('savate')).toContain('tornado_kick');
    expect(menuFor('haymaker')).not.toContain('jump_kick'); // no front kick
    expect(menuFor('haymaker')).toContain('jumping_knee'); // off the clinch
    expect(menuFor('pylon')[0]).toBe('spinning_back_kick'); // its signature spin leads
    expect(menuFor('savate')[0]).toMatch(/tornado_kick|spinning_back_kick/);
  });

  test('an impossible move (limp knee) is never offered', () => {
    const { sc, fc } = setup('savate', 'haymaker');
    const s = readSituation(fc, frame(sc, 10, 1.0, { red: me(['stunned'], { moveRisk: { ...RISK, tornado_kick: 1, jumping_knee: 1 } }) }));
    const moves = openingMenu(fc.design, s.me, s.me.openings!, describeTactic, false).items.map((i) => i.move);
    expect(moves).not.toContain('tornado_kick');
    expect(moves).not.toContain('jumping_knee');
    expect(moves).toContain('head_kick');
  });

  test('4-8 combos per design, all throwable, signature ones first', () => {
    for (const id of Object.keys(DESIGNS)) {
      const combos = designCombos(DESIGNS[id]);
      expect(combos.length).toBeGreaterThanOrEqual(4);
      expect(combos.length).toBeLessThanOrEqual(8);
      for (const c of combos) {
        expect(c.length).toBeGreaterThanOrEqual(2);
        expect(c.length).toBeLessThanOrEqual(4);
        for (const t of c) expect(canThrow(DESIGNS[id], t)).toBe(true);
      }
    }
    expect(comboId(designCombos(DESIGNS.savate)[0])).toBe('jab-cross-low_kick');
    expect(designCombos(DESIGNS.firecracker).map(comboId)).toContain('jab-cross-hook-uppercut');
    expect(designCombos(DESIGNS.pylon).map(comboId)).toContain('jab-jab-spinning_backfist');
    expect(designCombos(DESIGNS.haymaker).map(comboId)).toContain('hook-uppercut-overhand');
  });

  test('extras add opening_move, combo (with a combo tactic) and getup_style; none by default', () => {
    const { sc, fc } = setup('savate', 'haymaker');
    const s = readSituation(fc, frame(sc, 10, 1.0, { red: me(['on_cage']) }));
    expect(Object.keys(buildQuestions(fc, s.opp).questions)).toHaveLength(6);
    const menu = openingMenu(fc.design, s.me, ['on_cage'], describeTactic, false);
    const qs = buildQuestions(fc, s.opp, { menu, combos: designCombos(fc.design), kipRisk: 0.3 });
    expect(Object.keys(qs.questions).sort()).toEqual(['aggression', 'combo', 'counter_if_lunge', 'getup_style', 'opening_move', 'opp_commit', 'tactic', 'target', 'winning']);
    expect(qs.tactics).toContain('combo');
    expect(qs.questions.getup_style.type).toBe('noul');
    const combo = qs.questions.combo;
    if (combo.type !== 'choice') throw new Error('combo must be a choice');
    // Each combination is just its strikes; the signature note is said once, in the instructions.
    expect(combo.criteria['jab-cross-low_kick']).toBe('jab, cross, low kick');
    expect(combo.instructions).toMatch(/The first \d are signature combinations for a kickboxer\.$/);
    for (const text of Object.values(combo.criteria)) expect(text).not.toMatch(/signature/);
  });
});

describe('style and appetite', () => {
  test('styles weight their signature moves', () => {
    expect(STYLES.kickboxer.weights.tornado_kick).toBeGreaterThan(STYLES.pressure.weights.tornado_kick!);
    expect(STYLES.swarmer.weights.combo).toBeGreaterThan(1);
    expect(styleOf(DESIGNS.pylon).id).toBe('distance');
    expect(styleOf(DESIGNS.bruiser).id).toBe('brawler');
  });

  test('temperament and aggression scale the gamble; risk discounts it', () => {
    const style = STYLES.kickboxer;
    expect(gambleAppetite(style, 1.8, 0.9)).toBeGreaterThan(gambleAppetite(style, 1, 0.5));
    expect(gambleAppetite(style, 0.3, 0.2)).toBeLessThan(gambleAppetite(style, 1, 0.5));
    const items = [
      { move: 'tornado_kick' as Tactic, risk: 0.7, target: null, opening: null, weight: 1, description: '' },
      { move: 'low_kick' as Tactic, risk: null, target: null, opening: null, weight: 1, description: '' },
    ];
    const probs = { tornado_kick: 0.4, low_kick: 0.3, none: 0.3 };
    const bold = gambleWeights(probs, items, 2.2);
    const timid = gambleWeights(probs, items, 0.4);
    expect(bold.tornado_kick).toBeGreaterThan(timid.tornado_kick);
    expect(timid.none).toBeGreaterThan(bold.none);
    expect(timid.tornado_kick).toBeLessThan(timid.low_kick); // a disciplined fighter shies from the risky one
  });
});

describe('fight memory', () => {
  const impact = (striker: 0 | 1, victim: 0 | 1, energyJ: number, impulseNs = 10): SimEvent => ({ kind: 'impact', pos: [0, 0, 1], normal: [1, 0, 0], impulseNs, speed: 5, energyJ, striker, victim, part: 'head', metal: false });

  test('"your tornado kicks: 1 of 3 landed, fell once" and "his low kicks keep landing"', () => {
    const sc = scene('savate', 'haymaker');
    const m = new FightMemory(0);
    const tk: Intent = { tactic: 'tornado_kick', target: 'head', aggression: 0.8, confidence: 0.7, source: 'jev', flourish: true };
    const feed = (t: number, events: SimEvent[] = [], blueSkill = 'stance') => m.onFrame({ ...frame(sc, t, 1, { blue: { skill: blueSkill } }), events });
    m.onIntent(tk, 1, true, false); feed(1.2, [impact(0, 1, 30)]); feed(3);
    m.onIntent(tk, 4, true, false); feed(4.3, [{ kind: 'fall', corner: 0 }]); feed(6);
    m.onIntent(tk, 7, true, false); m.onIntent(tk, 7.2, true, false); feed(9); // a repeated decision is one attempt
    for (let i = 0; i < 4; i++) feed(10 + i, [impact(1, 0, 15, 12)], 'low_kick');
    feed(15, [impact(1, 0, 15, 12)], 'hook');
    feed(16, [impact(1, 0, 15, 12)], 'guard'); // contact while he guards or clinches is not a strike of his
    feed(17, [impact(1, 0, 15, 12)], 'clinch');
    expect(m.moveRecord('tornado_kick')).toEqual({ attempts: 3, landed: 1, fell: 1 });
    expect(m.yoursWords()).toBe('your tornado kicks: 1 of 3 landed, fell once');
    expect(m.hisWords()).toBe('his low kicks keep landing; his hook landed once');
    expect(m.words()).toEqual({ yours: 'your tornado kicks: 1 of 3 landed, fell once', his: 'his low kicks keep landing; his hook landed once' });
  });

  test('kip-ups and combos are remembered; nothing happened yet means no record', () => {
    const sc = scene('firecracker', 'haymaker');
    const m = new FightMemory(0);
    expect(m.words()).toBeNull();
    m.onIntent({ tactic: 'guard', target: 'torso', aggression: 0.2, confidence: 1, source: 'jev', getupStyle: 'kip_up' }, 2, false, true);
    m.onFrame({ ...frame(sc, 3.5, 1), events: [{ kind: 'getup', corner: 0 }] });
    m.onIntent({ tactic: 'combo', combo: ['jab', 'cross', 'hook'], target: 'head', aggression: 0.8, confidence: 0.7, source: 'jev' }, 5, false, false);
    m.onFrame({ ...frame(sc, 5.3, 1), events: [impact(0, 1, 12)] });
    m.onFrame(frame(sc, 7, 1));
    expect(m.kipUps).toEqual({ attempts: 1, made: 1 });
    // A long knockdown is still one kip-up attempt, however many intents it carries.
    const kip: Intent = { tactic: 'guard', target: 'torso', aggression: 0.2, confidence: 1, source: 'jev', getupStyle: 'kip_up' };
    for (let t = 8; t < 20; t += 0.5) { m.onIntent(kip, t, false, true); m.onFrame(frame(sc, t, 1)); }
    expect(m.kipUps).toEqual({ attempts: 2, made: 1 });
    expect(plural('superman punch')).toBe('superman punches');
    expect(plural('tornado kick')).toBe('tornado kicks');
    expect(m.yoursWords()).toBe('your combo jab-cross-hook: 1 of 1 landed; your kip-ups: 1 of 2 made it up');
  });
});

describe('House Mind', () => {
  test('down: light, wild bodies try the kip-up often, heavy, disciplined ones rarely (seeded)', () => {
    const rate = (id: string, risk: number, temperament: number) => {
      const { sc, fc } = setup(id, 'savate', temperament);
      let kips = 0;
      for (let i = 0; i < 400; i++) {
        const s = readSituation(fc, frame(sc, 10 + i * 0.25, 1.5, { red: { ...me([], { moveRisk: { ...RISK, kip_up: risk } }), down: true } }));
        if (obviousDecision(fc, s, 3)?.getupStyle === 'kip_up') kips++;
      }
      return kips / 400;
    };
    expect(rate('firecracker', 0.29, 1.6)).toBeGreaterThan(0.5);
    expect(rate('haymaker', 0.75, 0.5)).toBeLessThan(0.15);
    expect(rate('haymaker', 0.75, 0.5)).toBeGreaterThan(0); // rarely, not never
    expect(rate('firecracker', 1, 1.8)).toBe(0); // a limp joint: never
  });

  test('with an opening it often goes for a move that exploits it, and throws combos in range', () => {
    const { sc, fc } = setup('savate', 'haymaker', 1.4);
    let gambles = 0, combos = 0;
    for (let i = 0; i < 200; i++) {
      const t = 10 + i * 0.25;
      const s = readSituation(fc, frame(sc, t, 1.0, { red: me(['low_guard']) }));
      const d = houseMind(fc, s, 5);
      if (d.gamble) {
        gambles++;
        expect(d.gamble.opening).toBe('low_guard');
        expect(d.flourish).toBe(true);
      }
      const plain = houseMind(fc, readSituation(fc, frame(sc, t, 1.0, { red: me([]) })), 5);
      if (plain.tactic === 'combo') {
        combos++;
        expect(plain.combo!.length).toBeGreaterThanOrEqual(2);
      }
    }
    expect(gambles).toBeGreaterThan(60);
    expect(gambles).toBeLessThan(180);
    expect(combos).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------- Brain with a mocked Jev

interface Call { questions: Record<string, JevQuestion>; state: Record<string, unknown> }

/** Answers every question; `prefer` maps a question id to the option it should favour. */
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

function brainWith(sc: Scene, prefer: Record<string, string | number>, temperament = 1.3) {
  const clock = { t: 0 };
  const calls: Call[] = [];
  const link = new JevLink({
    now: () => clock.t,
    ask: (state, questions) => {
      calls.push({ state: state as Record<string, unknown>, questions });
      return Promise.resolve(answer(questions, prefer));
    },
  });
  const intents: Intent[] = [];
  const decisions: BrainDecision[] = [];
  const brain = new Brain({
    corner: 0, meta: sc.meta, seed: 9, link,
    fighter: { design: sc.meta.robots[0].design, skin: 'factory', plan: 'Take every opening.', temperament },
    onIntent: (_c, i) => intents.push(i),
    onDecision: (d) => decisions.push(d),
  });
  brain.start();
  return { brain, calls, intents, decisions, clock };
}

async function runFrames(b: ReturnType<typeof brainWith>, sc: Scene, from: number, to: number, red: Partial<RobotTelemetry>, distance = 1.0) {
  for (let t = from; t < to; t += 1 / 60) {
    b.clock.t = t * 1000;
    b.brain.onFrame(frame(sc, t, distance, { red }));
    await flush();
  }
}

describe('intent mapping with a mocked Jev', () => {
  test('an opening: opening_move is asked and Jev\'s gamble becomes the tactic, with flourish', async () => {
    const sc = scene('savate', 'haymaker');
    const b = brainWith(sc, { tactic: 'jab', opening_move: 'jump_kick' });
    await runFrames(b, sc, 0, 1, me(['turned_away']));
    expect(b.calls.length).toBeGreaterThan(0);
    const q = b.calls[0].questions.opening_move;
    expect(q?.type).toBe('choice');
    const state = b.calls[0].state as { opponent: Record<string, string>; you: Record<string, string> };
    expect(state.opponent.openings).toBe('his back is to you');
    expect(state.you.flashy_risk).toContain('jump kick: high fall risk');
    const gambled = b.intents.filter((i) => i.tactic === 'jump_kick');
    expect(gambled.length).toBeGreaterThan(0);
    for (const i of gambled) expect(i.flourish).toBe(true);
    const d = b.decisions.find((x) => x.gamble)!;
    expect(d.gamble).toMatchObject({ move: 'jump_kick', opening: 'turned_away', risk: 0.42 });
    expect(d.gamble!.p).toBeCloseTo(0.9, 2);
    expect(d.openings).toEqual(['turned_away']);
    expect(d.reason).toBe('took the opening, high fall risk');
  });

  test('no opening: opening_move is usually not asked; "none" keeps Jev\'s tactic', async () => {
    const sc = scene('savate', 'haymaker');
    const b = brainWith(sc, { tactic: 'low_kick', opening_move: NONE }, 0.5);
    await runFrames(b, sc, 0, 3, me([]));
    const asked = b.calls.filter((c) => c.questions.opening_move).length;
    expect(asked).toBeLessThan(b.calls.length / 2); // only the occasional creative gamble
    expect(b.intents.every((i) => i.tactic === 'low_kick')).toBe(true);
    expect(b.intents.every((i) => !i.flourish)).toBe(true);
  });

  test('tactic "combo" carries the combination Jev picked, then runs it strike by strike', async () => {
    const sc = scene('firecracker', 'haymaker');
    const b = brainWith(sc, { tactic: 'combo', combo: 'jab-cross-hook-uppercut' });
    await runFrames(b, sc, 0, 40, me([]));
    const starts = b.intents.map((x, i) => [x, i] as const).filter(([x]) => x.tactic === 'combo');
    const combos = starts.map(([x]) => comboId(x.combo!));
    const menu = designCombos(DESIGNS.firecracker).map(comboId);
    expect(combos.length).toBeGreaterThanOrEqual(5);
    for (const [x, i] of starts) {
      if (x.comboPlan) continue; // a setup → payoff combination (its own test)
      expect(menu).toContain(comboId(x.combo!)); // sampled at the fighter's temperament, always from its menu
      // The brain sequences it (COMBO_SEQUENCING 'brain'): the next intents are the remaining strikes, in order.
      const rest = b.intents.slice(i + 1, i + x.combo!.length).map((y) => y.tactic);
      expect(rest).toEqual(x.combo!.slice(1, 1 + rest.length));
    }
    // Jev's favourite is the most thrown (sampled at temperament 1.3 against 7 others, setups included).
    const counts = new Map<string, number>();
    for (const c of combos) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.get('jab-cross-hook-uppercut')).toBe(Math.max(...counts.values()));
    expect(b.decisions.filter((d) => d.tactic === 'combo').every((d) => d.combo && d.combo.length >= 2)).toBe(true);
  });

  test('down: getup_style is asked once per knockdown and every intent while down carries it', async () => {
    const sc = scene('firecracker', 'haymaker');
    const b = brainWith(sc, { getup_style: 0.85 });
    await runFrames(b, sc, 0, 2, { ...me([]), down: true, upright: 0.1 });
    const getupCalls = b.calls.filter((c) => c.questions.getup_style);
    expect(getupCalls).toHaveLength(1);
    expect(Object.keys(getupCalls[0].questions)).toEqual(['getup_style']);
    const downIntents = b.intents;
    expect(downIntents.length).toBeGreaterThan(2);
    expect(downIntents.every((i) => i.getupStyle === 'kip_up')).toBe(true);
    // Up again, then down again: a new knockdown is a new question.
    await runFrames(b, sc, 2, 2.5, me([]));
    await runFrames(b, sc, 2.5, 3.5, { ...me([]), down: true, upright: 0.1 });
    expect(b.calls.filter((c) => c.questions.getup_style)).toHaveLength(2);
  });

  test('an impossible kip-up (a limp joint) costs no Jev call: safe get-up', async () => {
    const sc = scene('firecracker', 'haymaker');
    const b = brainWith(sc, { getup_style: 0.95 });
    await runFrames(b, sc, 0, 1.5, { ...me([], { moveRisk: { ...RISK, kip_up: 1 } }), down: true, upright: 0.1 });
    expect(b.calls.filter((c) => c.questions.getup_style)).toHaveLength(0);
    expect(b.intents.length).toBeGreaterThan(0);
    expect(b.intents.every((i) => i.getupStyle === 'safe')).toBe(true);
  });

  test('a timid heavy fighter answers "maybe" with a safe get-up', async () => {
    const sc = scene('haymaker', 'firecracker');
    const b = brainWith(sc, { getup_style: 0.55 }, 0.3);
    await runFrames(b, sc, 0, 1, { ...me([], { moveRisk: { ...RISK, kip_up: 0.8 } }), down: true, upright: 0.1 });
    expect(b.intents.at(-1)!.getupStyle).toBe('safe');
  });

  test('the request budget is unchanged: extras ride in the same call', async () => {
    const sc = scene('savate', 'haymaker');
    const a = brainWith(sc, { tactic: 'jab' });
    await runFrames(a, sc, 0, 2, me(['low_guard', 'on_cage']));
    expect(a.calls.length).toBeGreaterThanOrEqual(7);
    expect(a.calls.length).toBeLessThanOrEqual(9); // the same ~4 Hz as without openings
  });
});

describe('control fallback (TODO(control-build))', () => {
  test('every new tactic maps to something the current controller runs', () => {
    const runnable = (t: Tactic) => TACTIC_SKILL[t] !== undefined || ['hold_range', 'close_distance', 'circle_left', 'circle_right', 'retreat', 'feint', 'sidestep_counter'].includes(t);
    const added: Tactic[] = ['spinning_back_kick', 'tornado_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist', 'switch_stance', 'pivot_left', 'pivot_right', 'feint_left', 'feint_right'];
    for (const t of added) expect(runnable(fallbackTactic(t))).toBe(true);
    expect(fallbackTactic('combo', ['jab', 'cross'])).toBe('jab');
    expect(fallbackTactic('combo', ['spinning_backfist', 'cross'])).toBe('hook');
    expect(fallbackTactic('combo')).toBe('jab');
    expect(fallbackTactic('cross')).toBe('cross');
  });
});
