// Fighter IQ in the brain: the weak-spot map, habits and reads in words; setup → payoff combos per
// design, steered by the weak spots and the habit model; the state token budget; and the combo
// running step by step with a mocked Jev: setup, the read of his answer, the payoff it picks.
import { describe, expect, test } from 'vitest';
import { Brain } from '../../src/brain/brain';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { houseMind } from '../../src/brain/house-mind';
import { JevLink } from '../../src/brain/link';
import { buildQuestions } from '../../src/brain/questions';
import { habitsWords, readHud, readWords, strikeFor, weakSpotsWords, weakSpotWords } from '../../src/brain/scouting';
import { COMBO_SEQUENCING, STEP_TIMEOUT_S } from '../../src/brain/sequencer';
import { serializeState } from '../../src/brain/serializer';
import { biteFactor, setupCombos, stepLabel, type SetupCombo } from '../../src/brain/setups';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { canThrow, designCombos } from '../../src/brain/style';
import type { BrainDecision } from '../../src/brain/types';
import type { FeintRead, Habit, Intent, RobotTelemetry, WeakSpot } from '../../src/core/protocol';
import { DESIGNS } from '../../src/robots/designs';
import { planLine, readLine, type MindView } from '../../src/ui/minds';
import { flush, frame, scene, type Scene } from './fixtures';

const CLOCK = { round: 2, rounds: 3, remainingS: 100 };
const RISK = { tornado_kick: 0.55, spinning_back_kick: 0.3, jump_kick: 0.42, jumping_knee: 0.3, superman_punch: 0.22, spinning_backfist: 0.1, kip_up: 0.35 };
const KNEE: WeakSpot = { zone: 'left_leg', score: 0.62, reasons: [{ kind: 'joint_failing', part: 'knee_l', value: 0.4 }, { kind: 'narrow_base', value: 4.9 }, { kind: 'lead_leg' }] };
const HEAD: WeakSpot = { zone: 'head', score: 0.41, side: 'right', reasons: [{ kind: 'guard_open', side: 'right' }, { kind: 'glass_jaw', value: 0.95 }] };
const BODY: WeakSpot = { zone: 'torso', score: 0.3, reasons: [{ kind: 'narrow_base', value: 4.9 }, { kind: 'gyro_drained', value: 0.4 }] };
const HABITS: Habit[] = [{ kind: 'bites', level: 'high', n: 3, of: 4 }, { kind: 'circles', side: 'left', n: 3, of: 4 }, { kind: 'drops_hand', side: 'right', after: 'cross', n: 2, of: 3 }];
const read = (seq: number, time: number, over: Partial<FeintRead> = {}): FeintRead =>
  ({ seq, time, level: 'high', limb: 'arm', skill: 'jab', deliberate: true, bit: true, reactions: ['covered'], ...over });

function iq(extra: Partial<RobotTelemetry> = {}): Partial<RobotTelemetry> {
  return { openings: [], moveRisk: { ...RISK }, stance: 'orthodox', facingOffDeg: -10, weakSpots: [KNEE, HEAD, BODY], habits: HABITS, ...extra };
}

function setup(red: string, blue: string, temperament = 1) {
  const sc = scene(red, blue);
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: red, skin: 'factory', plan: 'Chop the lead leg until his stance goes, then go upstairs.', temperament });
  return { sc, fc };
}

describe('the scouting report in words', () => {
  test('weak spots are ranked, each with the strike that fits this design', () => {
    const { sc, fc } = setup('savate', 'pylon');
    const me = readSituation(fc, frame(sc, 40, 1, { red: iq() })).me;
    expect(weakSpotWords(KNEE, strikeFor(fc.design, me, KNEE))).toBe('his left knee at 40%, narrow base, lead leg: low kick');
    expect(weakSpotsWords(fc.design, me)).toBe(
      '1) his left knee at 40%, narrow base, lead leg: low kick; 2) head: guard open on his right, glass jaw, a clean shot pops his head: hook; 3) body: narrow base, gyro drained: front kick');
    const arm: WeakSpot = { zone: 'head', score: 0.3, side: 'left', reasons: [{ kind: 'joint_failing', part: 'elbow_l', value: 0.42 }] };
    expect(weakSpotWords(arm, 'cross')).toBe('his left elbow at 40%, that guard sags: cross');
    // His left side open: your right hand. FIRECRACKER has no head kick; HAYMAKER loads the overhand.
    const left: WeakSpot = { ...HEAD, side: 'left', reasons: [{ kind: 'guard_open', side: 'left' }] };
    expect(strikeFor(DESIGNS.haymaker, me, left)).toBe('overhand');
    expect(strikeFor(DESIGNS.firecracker, me, { ...HEAD, side: undefined, reasons: [] })).toBe('cross');
    // A limp right leg: no low kick, the front kick is what is left for a leg.
    const legDead = { ...me, joints: me.joints.map((j) => (j.name === 'knee_r' ? { ...j, state: 'limp' as const, health: 0.02 } : j)) };
    expect(strikeFor(fc.design, legDead, KNEE)).toBeNull();
  });

  test('habits and reads', () => {
    expect(habitsWords(HABITS)).toBe('bites on high feints 3 of 4; circles left when pressured 3 of 4; drops his right hand after the cross 2 of 3');
    expect(habitsWords([{ kind: 'bites', level: 'low', n: 0, of: 3 }])).toBe('never bites on low feints (0 of 3)');
    expect(readWords(read(1, 0))).toBe('he bit your high feint: covered up');
    expect(readWords(read(1, 0, { bit: false, reactions: [], level: 'low' }))).toBe('he ignored your low feint');
    expect(readHud(read(1, 0))).toBe('HE BIT: COVERED HIGH');
    expect(readHud(read(1, 0, { reactions: ['retreated', 'flinched'] }))).toBe('HE BIT: STEPPED BACK + FLINCHED');
    expect(readHud(read(1, 0, { bit: false, reactions: [], level: 'body' }))).toBe('NO BITE: BODY FEINT');
  });

  test('state token budget: the whole scouting report adds about 100 tokens', () => {
    const { sc, fc } = setup('savate', 'pylon');
    const recent = [{ action: 'front_kick' as const, time: 38 }];
    const record = { yours: 'your combo jab-cross-low kick: 1 of 2 landed', his: 'his front kicks keep landing' };
    const size = (red: Partial<RobotTelemetry>) => JSON.stringify(serializeState(fc, readSituation(fc, frame(sc, 40, 1, { red })), recent, CLOCK, 'jab', record)).length / 4;
    const base = size({ openings: ['low_guard'], moveRisk: { ...RISK }, stance: 'orthodox', facingOffDeg: -10 });
    const full = size(iq({ openings: ['low_guard'], reads: [read(4, 39.5)] }));
    console.log(`state ~${Math.round(base)} tokens → ~${Math.round(full)} with weak spots, habits and a read`);
    expect(full - base).toBeLessThan(110);
    expect(full).toBeLessThan(500);
    // A stale read (older than READ_FRESH_S) is left out; so is everything when physics sent none.
    const state = serializeState(fc, readSituation(fc, frame(sc, 45, 1, { red: iq({ reads: [read(4, 39.5)] }) })), recent, CLOCK, 'jab');
    expect(state.opponent.last_read).toBeUndefined();
    expect(state.opponent.weak_spots).toMatch(/^1\) his left knee at 40%/);
    const bare = serializeState(fc, readSituation(fc, frame(sc, 45, 1)), recent, CLOCK, 'jab');
    expect(bare.opponent.weak_spots).toBeUndefined();
    expect(bare.opponent.habits).toBeUndefined();
  });
});

describe('setup → payoff combos', () => {
  const valid = (design: string, c: SetupCombo) => {
    expect(c.steps.length).toBe(c.zones.length);
    expect(c.setup).toBeGreaterThanOrEqual(1);
    expect(c.setup).toBeLessThan(c.steps.length);
    for (const t of c.steps) expect(t === 'feint' || t === 'switch_stance' || canThrow(DESIGNS[design], t)).toBe(true);
  };

  test.each(['firecracker', 'savate', 'haymaker', 'pylon', 'bruiser', 'striker', 'goliath'])('%s: 1-3 setups, all throwable, paying off on the weak spots', (id) => {
    const { sc, fc } = setup(id, 'pylon');
    const s = readSituation(fc, frame(sc, 40, 1, { red: iq() }));
    const setups = setupCombos(fc.design, s.me, s.opp);
    expect(setups.length).toBeGreaterThanOrEqual(1);
    expect(setups.length).toBeLessThanOrEqual(3);
    for (const c of setups) valid(id, c);
    // A low payoff lands on his failing knee, never on the healthy leg.
    for (const c of setups.filter((x) => x.payoffZone.endsWith('_leg'))) expect(c.payoffZone).toBe('left_leg');
    const words = setups.map((c) => c.why).join(' | ');
    if (setups.some((c) => c.payoffZone === 'left_leg')) expect(words).toContain('left knee 40%');
  });

  test('styles: the kickboxer chops then goes upstairs, the swarmer draws with the jab', () => {
    const kinds = (id: string) => {
      const { sc, fc } = setup(id, 'pylon');
      const s = readSituation(fc, frame(sc, 40, 1, { red: iq({ habits: [] }) }));
      return setupCombos(fc.design, s.me, s.opp).map((c) => c.kind);
    };
    expect(kinds('savate')).toContain('low_kick_high');
    expect(kinds('firecracker')).toContain('jab_draw');
    expect(kinds('firecracker')).not.toContain('switch_kick');
  });

  test('habits steer the fake: he bites high → fake high; he never bites high but bites low → fake low', () => {
    const { sc, fc } = setup('haymaker', 'pylon');
    const rank = (habits: Habit[]) => {
      const s = readSituation(fc, frame(sc, 40, 1, { red: iq({ habits }) }));
      return setupCombos(fc.design, s.me, s.opp).map((c) => c.kind);
    };
    const bitesHigh = rank([{ kind: 'bites', level: 'high', n: 4, of: 4 }, { kind: 'bites', level: 'low', n: 0, of: 4 }]);
    const bitesLow = rank([{ kind: 'bites', level: 'high', n: 0, of: 4 }, { kind: 'bites', level: 'low', n: 4, of: 4 }]);
    const at = (list: string[], k: string) => (list.includes(k) ? list.indexOf(k) : 99);
    expect(at(bitesHigh, 'fake_high_go_low')).toBeLessThan(at(bitesHigh, 'fake_low_go_high'));
    expect(at(bitesLow, 'fake_low_go_high')).toBeLessThan(at(bitesLow, 'fake_high_go_low'));
    expect(biteFactor([{ kind: 'bites', level: 'high', n: 3, of: 4 }], 'high')).toBeGreaterThan(biteFactor(undefined, 'high'));
    expect(biteFactor([{ kind: 'bites', level: 'high', n: 0, of: 4 }], 'high')).toBeLessThan(biteFactor(undefined, 'high'));
    // Drawing his counter is only offered once he throws back at feints.
    expect(rank([]).includes('draw_counter')).toBe(false);
    expect(rank([{ kind: 'counters', n: 3, of: 4 }])).toContain('draw_counter');
  });

  test('a feint needs a working limb at its level; arms gone, no high feint', () => {
    const { sc, fc } = setup('firecracker', 'pylon');
    const dead = sc.red.parts.flatMap((p) => (p.joints ?? []).map((j) => ({ name: j.name, health: /^elbow/.test(j.name) ? 0.02 : 1, state: /^elbow/.test(j.name) ? 'limp' as const : 'ok' as const, tempC: 30, torqueFrac: 0 })));
    const s = readSituation(fc, frame(sc, 40, 1, { red: iq({ joints: dead }) }));
    for (const c of setupCombos(fc.design, s.me, s.opp)) {
      c.steps.forEach((t, i) => { if (t === 'feint') expect(c.zones[i]).toMatch(/_leg$/); });
      expect(c.steps).not.toContain('jab');
    }
  });

  test('the combo question offers them after the signature combos, in the same call', () => {
    const { sc, fc } = setup('savate', 'pylon');
    const s = readSituation(fc, frame(sc, 40, 1, { red: iq() }));
    const setups = setupCombos(fc.design, s.me, s.opp);
    const qs = buildQuestions(fc, s.opp, { combos: designCombos(fc.design), setups });
    const q = qs.questions.combo;
    if (q.type !== 'choice') throw new Error('combo must be a choice');
    expect(Object.keys(q.criteria)).toHaveLength(8);
    for (const c of setups) expect(q.criteria[c.id]).toBe(`setup: ${c.why}`);
    expect(q.instructions).toContain('Setups fool him first');
    expect(q.instructions).toMatch(/signature combinations for a kickboxer\.$/);
    expect(qs.tactics).toContain('combo');
    expect(JSON.stringify(q).length / 4).toBeLessThan(200);
  });

  test('HUD labels for steps', () => {
    expect(stepLabel('feint', 'head')).toBe('feint high');
    expect(stepLabel('feint', 'left_leg')).toBe('feint low');
    expect(stepLabel('feint', 'torso')).toBe('feint body');
    expect(stepLabel('low_kick', 'left_leg')).toBe('low kick');
  });
});

// ---------------------------------------------------------------- the plan unfolding (mocked Jev)

function answer(questions: Record<string, JevQuestion>, prefer: Record<string, string>): JevResult {
  const answers: JevResult['answers'] = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const top = prefer[id] && keys.includes(prefer[id]) ? prefer[id] : keys[0];
      answers[id] = { type: 'choice', choice: top, confidence: 0.9, probabilities: Object.fromEntries(keys.map((k) => [k, k === top ? 0.97 : 0.03 / Math.max(1, keys.length - 1)])) };
    } else if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.2 };
    else answers[id] = { type: 'score', score: 3, confidence: 0.6, probabilities: Object.fromEntries(q.criteria.map((c) => [c, 1 / q.criteria.length])) };
  }
  return { answers, latencyMs: 150, inputTokens: 1000, outputTokens: 25 };
}

function fighter(sc: Scene, prefer: Record<string, string>) {
  const clock = { t: 0 };
  const intents: Intent[] = [];
  const decisions: BrainDecision[] = [];
  const link = new JevLink({ now: () => clock.t, ask: (_s, q) => Promise.resolve(answer(q, { opening_move: 'none', on_opening: 'nothing', ...prefer })) });
  const brain = new Brain({
    corner: 0, meta: sc.meta, seed: 3, link, fighter: { design: sc.meta.robots[0].design, skin: 'factory', plan: 'Set him up.', temperament: 0.4 },
    onIntent: (_c, i) => intents.push(i), onDecision: (d) => decisions.push(d),
  });
  brain.start();
  return { brain, intents, decisions, clock };
}

type Fighter = ReturnType<typeof fighter>;

/**
 * Frames at 60 Hz. The body is a legacy one by default: its telemetry shows the last intent applied
 * (no reaction delay) and never a comboStep, so the brain steps combinations itself.
 */
async function play(f: Fighter, sc: Scene, from: number, to: number, red: (t: number) => Partial<RobotTelemetry>, blue: Partial<RobotTelemetry> = {}) {
  for (let t = from; t < to; t += 1 / 60) {
    f.clock.t = t * 1000;
    f.brain.onFrame(frame(sc, t, 1.0, { red: { intent: f.intents[f.intents.length - 1] ?? null, ...red(t) }, blue }));
    await flush();
  }
}

/** The body throwing the feint: its jab windup shows from t0 and is pulled 0.1 s later. */
const feintAt = (t0: number) => (t: number) => (t >= t0 && t < t0 + 0.1 ? 'jab' : 'stance');

describe('a setup → payoff combination, step by step (a body that cannot run it whole)', () => {
  test('feint high → he bites (covered) → low kick to his failing knee, shown on the MIND panel', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    await play(f, sc, 0, 0.3, () => iq());
    const first = f.intents.find((i) => i.tactic === 'combo')!;
    expect(first).toMatchObject({ combo: ['feint', 'low_kick'], target: 'head', comboPlan: { setup: 1, zones: ['head', 'left_leg'], payoffZone: 'left_leg', fishing: 'covered' } });
    const startAt = f.decisions.find((d) => d.tactic === 'combo')!.time;
    expect(f.brain.latest!.plan).toMatchObject({ setup: ['feint high'], payoff: ['low kick'], note: 'left knee 40%', phase: 'setup' });
    const mind = f.brain.latest as MindView;
    expect(planLine(mind)).toBe('SETUP: FEINT HIGH → PAYOFF: LOW KICK · LEFT KNEE 40%');
    const n = f.intents.length;
    // The body shows the feint and pulls it; physics reads him covering up 0.15 s later.
    const pulled = startAt + 0.5;
    await play(f, sc, 0.3, 1.2, (t) => iq({ skill: feintAt(startAt + 0.4)(t), reads: t >= pulled ? [read(1, pulled)] : [] }));
    const payoff = f.intents.slice(n).find((i) => i.tactic === 'low_kick')!;
    expect(payoff).toMatchObject({ target: 'left_leg', comboPlan: { step: 1 } });
    expect(payoff.aggression).toBeGreaterThanOrEqual(0.8);
    expect(f.intents.slice(n).filter((i) => i.tactic !== 'low_kick')).toEqual([]); // no re-decisions in between
    const d = f.decisions[f.decisions.length - 1];
    expect(d.reason).toBe('payoff: he covered → low kick to the left leg');
    expect(d.trigger).toBe('plan');
    const now = f.brain.latest as MindView;
    expect(now.plan?.phase).toBe('payoff');
    expect(readLine(now)).toBe('READ · HE BIT: COVERED HIGH');
    expect(COMBO_SEQUENCING).toBe('body'); // stepped by the brain only because this body never showed a comboStep
  });

  test('Jev answers "feint" as the tactic and a fake in the combo answer: it runs the fake as a setup', async () => {
    // Live Jev does exactly this with a scouting report in the state (tactic feint 0.9, combo fake_high_go_low 0.9).
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'feint', combo: 'fake_high_go_low' });
    await play(f, sc, 0, 0.3, () => iq());
    expect(f.intents[0]).toMatchObject({ tactic: 'combo', combo: ['feint', 'low_kick'], comboPlan: { payoffZone: 'left_leg' } });
    // A feint with a plain combination picked stays a plain feint.
    const g = fighter(sc, { tactic: 'feint', combo: 'jab-cross-low_kick' });
    await play(g, sc, 0, 0.3, () => iq());
    expect(g.intents[0].tactic).toBe('feint');
    expect(g.intents[0].comboPlan).toBeUndefined();
  });

  test('he stepped away instead: the payoff becomes a long shot', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    await play(f, sc, 0, 0.3, () => iq());
    const startAt = f.decisions.find((d) => d.tactic === 'combo')!.time;
    const pulled = startAt + 0.5;
    await play(f, sc, 0.3, 1.2, (t) => iq({ skill: feintAt(startAt + 0.4)(t), reads: t >= pulled ? [read(1, pulled, { reactions: ['retreated'] })] : [] }));
    const payoff = f.intents[f.intents.length - 1];
    expect(payoff).toMatchObject({ tactic: 'front_kick', target: 'torso' });
    expect(f.brain.latest!.plan?.payoff).toEqual(['front kick']);
  });

  test('he threw back: the payoff also arms as the opening reflex on his whiff', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    await play(f, sc, 0, 0.3, () => iq());
    const startAt = f.decisions.find((d) => d.tactic === 'combo')!.time;
    const pulled = startAt + 0.5;
    await play(f, sc, 0.3, 1.2, (t) => iq({ skill: feintAt(startAt + 0.4)(t), reads: t >= pulled ? [read(1, pulled, { reactions: ['countered'] })] : [] }));
    expect(f.intents[f.intents.length - 1]).toMatchObject({ tactic: 'low_kick', onOpening: { missed_recovering: 'low_kick', overcommitted: 'low_kick' } });
  });

  test('no read: the payoff still goes after a beat; a plan the body never throws times out step by step', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    await play(f, sc, 0, 0.3, () => iq());
    const n = f.intents.length;
    await play(f, sc, 0.3, 0.3 + STEP_TIMEOUT_S + 0.5, () => iq());
    expect(f.intents.slice(n).map((i) => i.tactic)).toEqual(['low_kick']);
    expect(f.decisions[f.decisions.length - 1].reason).toBe('payoff: no read → low kick to the left leg');
  });

  test('knocked down mid-plan: the plan is dropped and Jev is asked again', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    await play(f, sc, 0, 0.3, () => iq());
    expect(f.brain.latest!.plan).not.toBeNull();
    await play(f, sc, 0.3, 0.6, () => iq({ down: true, upright: 0.1 }));
    expect(f.brain.latest!.plan ?? null).toBeNull();
    expect(f.intents.slice(-1)[0].tactic).not.toBe('low_kick');
  });

  test('an answer asked before the plan started does not cut into it (Jev slower than the cadence)', async () => {
    const sc = scene('savate', 'pylon');
    const clock = { t: 0 };
    const intents: Intent[] = [];
    const asked: Array<{ q: Record<string, JevQuestion>; resolve: (r: JevResult) => void }> = [];
    const link = new JevLink({ now: () => clock.t, ask: (_s, q) => new Promise((resolve) => { asked.push({ q, resolve }); }) });
    const brain = new Brain({
      corner: 0, meta: sc.meta, seed: 3, link, fighter: { design: 'savate', skin: 'factory', plan: 'Set him up.', temperament: 0.4 },
      onIntent: (_c, i) => intents.push(i),
    });
    brain.start();
    const run = async (from: number, to: number) => {
      for (let t = from; t < to; t += 1 / 60) {
        clock.t = t * 1000;
        brain.onFrame(frame(sc, t, 1.0, { red: iq() }));
        await flush();
      }
    };
    await run(0, 0.3);
    expect(asked).toHaveLength(2); // the second question went out before the first answer came back
    const quiet = { opening_move: 'none', on_opening: 'nothing' };
    asked[0].resolve(answer(asked[0].q, { ...quiet, tactic: 'combo', combo: 'fake_high_go_low' }));
    await run(0.3, 0.35);
    expect(intents.map((i) => i.tactic)).toEqual(['combo']);
    asked[1].resolve(answer(asked[1].q, { ...quiet, tactic: 'jab' }));
    await run(0.35, 0.6);
    expect(intents.map((i) => i.tactic)).toEqual(['combo']); // the stale 'jab' is dropped: the plan runs on
    expect(brain.latest!.plan?.setup).toEqual(['feint high']);
  });

  test('picked at mid range or over a downed man, a combo goes out as before: no plan to drop, no re-ask churn', async () => {
    for (const where of ['mid range', 'he is down'] as const) {
      const sc = scene('savate', 'pylon');
      const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
      const dist = where === 'mid range' ? 2.8 : 1.0;
      const blue = where === 'he is down' ? { down: true, upright: 0.1 } : {};
      for (let t = 0; t < 1; t += 1 / 60) {
        f.clock.t = t * 1000;
        f.brain.onFrame(frame(sc, t, dist, { red: iq(), blue }));
        await flush();
      }
      expect(f.brain.latest?.plan ?? null).toBeNull();
      expect(f.decisions.filter((d) => d.trigger === 'plan_aborted')).toEqual([]);
      expect(f.intents.length).toBeLessThanOrEqual(5); // cadence (0.25-0.5 s), not a 0.1 s re-ask loop
    }
  });

  test('a combo that opens with the strike already in the air moves on when it lands, not on the timeout', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'jab-cross-low_kick' });
    // The body is mid-jab when the plan starts; the jab ends 0.3 s later.
    await play(f, sc, 0, 0.3, () => iq({ skill: 'jab' }));
    const first = f.intents.find((i) => i.tactic === 'combo')!;
    expect(first.combo).toEqual(['jab', 'cross', 'low_kick']);
    const startAt = f.decisions.find((d) => d.tactic === 'combo')!.time;
    const n = f.intents.length;
    await play(f, sc, 0.3, startAt + 0.6, (t) => iq({ skill: t < startAt + 0.3 ? 'jab' : 'stance' }));
    expect(f.intents.slice(n).map((i) => i.tactic)).toEqual(['cross']);
  });

  test('a rhythm break holds for a beat before the burst', async () => {
    const sc = scene('firecracker', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'rhythm_break' });
    await play(f, sc, 0, 0.3, () => iq({ habits: [], weakSpots: [] }));
    const first = f.intents.find((i) => i.tactic === 'combo');
    expect(first?.comboPlan?.tempo?.[2]).toBeGreaterThan(0.3);
    await play(f, sc, 0.3, 6, () => iq({ habits: [], weakSpots: [] }));
    const seq = f.intents.slice(f.intents.indexOf(first!)).map((i) => i.tactic);
    expect(seq.slice(0, 5)).toEqual(['combo', 'jab', 'hold_range', 'cross', 'hook']);
  });
});

describe('House Mind', () => {
  test('in range it sets him up some of the time, with the plan on the intent', () => {
    const { sc, fc } = setup('savate', 'pylon', 1.3);
    let setups = 0, combos = 0;
    for (let tick = 0; tick < 3000; tick += 7) {
      const s = readSituation(fc, { ...frame(sc, 20, 1.0, { red: iq() }), tick });
      const d = houseMind(fc, s, 5);
      if (d.tactic !== 'combo') continue;
      combos++;
      if (d.comboPlan) {
        setups++;
        expect(d.combo!.length).toBe(d.comboPlan.zones.length);
        expect(d.reason).toMatch(/^set him up: /);
      }
    }
    expect(combos).toBeGreaterThan(10);
    expect(setups).toBeGreaterThan(combos * 0.3);
    expect(setups).toBeLessThan(combos);
  });
});

describe('HUD lines', () => {
  const base: MindView = { source: 'jev', tactic: 'combo', target: 'head', aggression: 0.7, tacticProbs: { combo: 1 }, oppCommit: null, latencyMs: 200 };
  test('plan and read lines', () => {
    expect(planLine(base)).toBeNull();
    expect(readLine(base)).toBeNull();
    expect(planLine({ ...base, plan: { setup: [], payoff: ['jab', 'cross'], payoffZone: 'head', note: null, step: 0, phase: 'setup' } })).toBe('COMBO: JAB › CROSS');
    expect(planLine({ ...base, plan: { setup: ['jab', 'jab'], payoff: ['cross', 'hook'], payoffZone: 'head', note: null, step: 2, phase: 'payoff' } })).toBe('SETUP: JAB › JAB → PAYOFF: CROSS › HOOK · HEAD');
    expect(readLine({ ...base, read: 'NO BITE: LOW FEINT' })).toBe('READ · NO BITE: LOW FEINT');
  });
});
