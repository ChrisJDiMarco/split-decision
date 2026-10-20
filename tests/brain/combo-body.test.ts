// Body sequencing (COMBO_SEQUENCING 'body', docs/design/fighter-iq-control-contract.md §2): the brain
// sends ONE combo intent, the body throws every step (RobotTelemetry.comboStep), and the brain only
// follows it for the MIND panel. No step intent ever goes out while the body runs the combination
// (one arriving after the body threw that step would be thrown twice), the read and the adapted
// payoff still show, and the mind decides again the moment the last step is in the air.
import { describe, expect, test } from 'vitest';
import { Brain } from '../../src/brain/brain';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink } from '../../src/brain/link';
import { BODY_PROOF_S, COMBO_SEQUENCING } from '../../src/brain/sequencer';
import type { BrainDecision } from '../../src/brain/types';
import type { FeintRead, Intent, RobotTelemetry, WeakSpot } from '../../src/core/protocol';
import { planLine, readLine, type MindView } from '../../src/ui/minds';
import { flush, frame, scene, type Scene } from './fixtures';

const KNEE: WeakSpot = { zone: 'left_leg', score: 0.62, reasons: [{ kind: 'joint_failing', part: 'knee_l', value: 0.4 }, { kind: 'lead_leg' }] };
const IQ: Partial<RobotTelemetry> = { openings: [], stance: 'orthodox', facingOffDeg: -10, weakSpots: [KNEE], habits: [{ kind: 'bites', level: 'high', n: 3, of: 4 }] };
const REACTION_S = 0.3;
const read = (seq: number, time: number, over: Partial<FeintRead> = {}): FeintRead =>
  ({ seq, time, level: 'high', limb: 'arm', skill: 'jab', deliberate: true, bit: true, reactions: ['covered'], ...over });

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

/** A fighter whose Jev answers at once with `prefer`, and whose answers can be held back (`hold`). */
function fighter(sc: Scene, prefer: Record<string, string>) {
  const clock = { t: 0 };
  const intents: Array<{ intent: Intent; at: number }> = [];
  const decisions: BrainDecision[] = [];
  const held: Array<() => void> = [];
  const ctl = { hold: false };
  const link = new JevLink({
    now: () => clock.t,
    ask: (_s, q) => new Promise((resolve) => {
      const go = () => resolve(answer(q, { opening_move: 'none', on_opening: 'nothing', ...prefer }));
      if (ctl.hold) held.push(go);
      else go();
    }),
  });
  const brain = new Brain({
    corner: 0, meta: sc.meta, seed: 3, link, fighter: { design: sc.meta.robots[0].design, skin: 'factory', plan: 'Set him up.', temperament: 0.4 },
    onIntent: (_c, i) => intents.push({ intent: i, at: clock.t / 1000 }), onDecision: (d) => decisions.push(d),
  });
  brain.start();
  return { brain, intents, decisions, clock, held, ctl };
}
type Fighter = ReturnType<typeof fighter>;

/** The intent the body runs at time t: the last one issued at least REACTION_S earlier (the worker's delay). */
function applied(f: Fighter, t: number): Intent | null {
  for (let i = f.intents.length - 1; i >= 0; i--) if (f.intents[i].at <= t - REACTION_S + 1e-9) return f.intents[i].intent;
  return null;
}

/**
 * A body that runs combinations whole (the balance engine): while the applied intent is a whole combo
 * it publishes comboStep = steps started so far, one every `stepS`, from when the intent applied.
 */
function wholeBody(f: Fighter, stepS = 0.35, extra: (t: number, step: number | undefined) => Partial<RobotTelemetry> = () => ({})) {
  let since: { key: string; t: number } | null = null;
  return (t: number): Partial<RobotTelemetry> => {
    const i = applied(f, t);
    const whole = i?.tactic === 'combo' && i.comboPlan?.step === undefined && !!i.combo?.length;
    const key = whole ? i!.combo!.join('>') : '';
    if (!whole) since = null;
    else if (since?.key !== key) since = { key, t };
    let comboStep: number | undefined;
    if (since) {
      const k = Math.floor((t - since.t) / stepS) + 1;
      // One step after the last has started, the last blow is over: the body ends the combination.
      comboStep = k <= i!.combo!.length ? k : undefined;
    }
    return { ...IQ, intent: i, ...(comboStep !== undefined ? { comboStep, skill: 'jab' } : { skill: 'stance' }), ...extra(t, comboStep) };
  };
}

async function play(f: Fighter, sc: Scene, from: number, to: number, red: (t: number) => Partial<RobotTelemetry>) {
  for (let t = from; t < to; t += 1 / 60) {
    f.clock.t = t * 1000;
    f.brain.onFrame(frame(sc, t, 1.0, { red: red(t) }));
    await flush();
  }
}

describe('combinations run whole in the body', () => {
  test('the contract switch is on', () => {
    expect(COMBO_SEQUENCING).toBe('body');
  });

  test('one combo intent, no step intents; the MIND panel follows the body step by step', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    const body = wholeBody(f);
    await play(f, sc, 0, 0.3, body);
    const combo = f.intents.find((x) => x.intent.tactic === 'combo')!;
    expect(combo.intent).toMatchObject({ combo: ['feint', 'low_kick'], comboPlan: { setup: 1, payoffZone: 'left_leg' } });
    expect(combo.intent.comboPlan?.step).toBeUndefined();
    const n = f.intents.length;
    // Until the body has thrown the last step: nothing more goes out, the plan shows its step.
    const startAt = combo.at;
    await play(f, sc, 0.3, startAt + REACTION_S + 0.3, body);
    expect(f.intents.slice(n)).toEqual([]);
    expect(f.brain.latest!.plan).toMatchObject({ setup: ['feint high'], payoff: ['low kick'], step: 0, phase: 'setup' });
    expect(planLine(f.brain.latest as MindView)).toBe('SETUP: FEINT HIGH → PAYOFF: LOW KICK · LEFT KNEE 40%');
    await play(f, sc, startAt + REACTION_S + 0.3, startAt + REACTION_S + 0.36, body);
    // The payoff (step 1) is in the air: the plan is done and the mind decides again at once.
    expect(f.intents.slice(n).some((x) => x.intent.comboPlan?.step !== undefined)).toBe(false);
    expect(f.intents.length).toBeGreaterThan(n);
    expect(f.decisions.some((d) => d.trigger === 'plan_done')).toBe(true);
  });

  test('the read of his answer and the adapted payoff show while the body runs it', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'fake_high_go_low' });
    let pulledAt = Infinity;
    const body = wholeBody(f, 0.5, (t, step) => {
      if (step === 1 && pulledAt === Infinity) pulledAt = t + 0.2;
      return t >= pulledAt ? { reads: [read(1, pulledAt, { reactions: ['retreated'] })] } : {};
    });
    await play(f, sc, 0, 0.3, body);
    const at = f.intents.find((x) => x.intent.tactic === 'combo')!.at;
    await play(f, sc, 0.3, at + REACTION_S + 0.45, body);
    const now = f.brain.latest as MindView;
    expect(readLine(now)).toBe('READ · HE BIT: STEPPED BACK');
    expect(f.brain.latest!.plan?.payoff).toEqual(['front kick']); // the long shot the body throws instead
    expect(f.intents.filter((x) => x.intent.comboPlan?.step !== undefined)).toEqual([]);
  });

  test('a model mind: hold range while it decides, so the standing combo intent never re-throws its first step', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'jab-cross-low_kick' });
    const body = wholeBody(f);
    await play(f, sc, 0, 0.3, body);
    const at = f.intents.find((x) => x.intent.tactic === 'combo')!.at;
    f.ctl.hold = true; // Jev is slow with the next answer
    const n = f.intents.length;
    await play(f, sc, 0.3, at + REACTION_S + 3 * 0.35 + 0.05, body);
    const after = f.intents.slice(n).map((x) => x.intent);
    expect(after[0]).toMatchObject({ tactic: 'hold_range' });
    expect(after.every((i) => i.tactic !== 'combo' && i.comboPlan?.step === undefined)).toBe(true);
    const reset = f.decisions.find((d) => d.reason === 'combination thrown: reset while deciding')!;
    expect(reset.mind).toBe('jev');
    // The answer still applies after the reset.
    f.ctl.hold = false;
    for (const go of f.held.splice(0)) go();
    await play(f, sc, at + REACTION_S + 1.1, at + REACTION_S + 1.2, body);
    expect(f.intents.length).toBeGreaterThan(n + 1);
  });

  test('the last blow is never pulled: nothing goes out until it is past its windup (committed)', async () => {
    // The body pulls a strike still in its windup for a defensive intent (hold_range, guard, circle):
    // the reset (or the next mind's guard) must not arrive while the payoff is still winding up.
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'jab-cross-low_kick' });
    const WINDUP_S = 0.15;
    let stepAt: { step: number; t: number } | null = null;
    const body = wholeBody(f, 0.35, (t, step) => {
      if (step === undefined) { stepAt = null; return {}; }
      if (stepAt?.step !== step) stepAt = { step, t };
      return { committed: t - stepAt.t >= WINDUP_S };
    });
    await play(f, sc, 0, 0.3, body);
    const at = f.intents.find((x) => x.intent.tactic === 'combo')!.at;
    f.ctl.hold = true;
    const n = f.intents.length;
    const lastStart = at + REACTION_S + 2 * 0.35; // comboStep 3 (= every step started) from here
    await play(f, sc, 0.3, lastStart + WINDUP_S - 0.02, body);
    expect(f.intents.slice(n)).toEqual([]); // the payoff is winding up: nothing goes out yet
    await play(f, sc, lastStart + WINDUP_S - 0.02, lastStart + WINDUP_S + 0.05, body);
    expect(f.intents.slice(n)[0]?.intent).toMatchObject({ tactic: 'hold_range' }); // committed: reset now
    f.ctl.hold = false;
    for (const go of f.held.splice(0)) go();
  });

  test('a model mind: a plan dropped mid-way (he got out of range) also resets while it decides', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'jab-cross-low_kick' });
    const body = wholeBody(f);
    await play(f, sc, 0, 0.3, body);
    const at = f.intents.find((x) => x.intent.tactic === 'combo')!.at;
    await play(f, sc, 0.3, at + REACTION_S + 0.4, body); // step 2 of 3 running
    f.ctl.hold = true;
    const n = f.intents.length;
    for (let t = at + REACTION_S + 0.4; t < at + REACTION_S + 0.6; t += 1 / 60) {
      f.clock.t = t * 1000;
      f.brain.onFrame(frame(sc, t, 3.0, { red: body(t) })); // he is far away now
      await flush();
    }
    expect(f.intents.slice(n)[0]?.intent).toMatchObject({ tactic: 'hold_range' });
    expect(f.decisions.some((d) => d.reason === 'combination dropped: reset while deciding' && d.trigger === 'plan_aborted')).toBe(true);
    f.ctl.hold = false;
    for (const go of f.held.splice(0)) go();
  });

  test('a body that drops the combination (a reflex fired first) ends the plan: the mind decides again', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'jab-cross-low_kick' });
    let dropAt = Infinity;
    const body = wholeBody(f, 0.35, (t, step) => {
      if (step === 1 && dropAt === Infinity) dropAt = t + 0.1;
      return t >= dropAt ? { comboStep: undefined, skill: 'cross' } : {};
    });
    await play(f, sc, 0, 0.3, body);
    const at = f.intents.find((x) => x.intent.tactic === 'combo')!.at;
    await play(f, sc, 0.3, at + REACTION_S + 0.2, body);
    expect(f.decisions.some((d) => d.trigger === 'plan_done')).toBe(true);
    expect(f.intents.filter((x) => x.intent.comboPlan?.step !== undefined)).toEqual([]);
  });

  test('a body that never runs combinations whole (legacy): the brain steps it after BODY_PROOF_S, each step once', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'combo', combo: 'jab-cross-low_kick' });
    // Legacy: the applied intent shows, comboStep never; the body throws whatever single tactic stands.
    let skill = 'stance';
    let since = -1;
    let last: Intent | null = null;
    const body = (t: number): Partial<RobotTelemetry> => {
      const i = applied(f, t);
      if (i !== last) { last = i; since = t; }
      const tactic = i?.tactic === 'combo' ? i.combo![0] : i?.tactic;
      skill = tactic && ['jab', 'cross', 'low_kick'].includes(tactic) && t - since < 0.3 ? tactic : 'stance';
      return { ...IQ, intent: i, skill };
    };
    await play(f, sc, 0, 0.3, body);
    const at = f.intents.find((x) => x.intent.tactic === 'combo')!.at;
    await play(f, sc, 0.3, at + REACTION_S + 2.5, body);
    // This plan's steps: from its combo intent up to the next decision of the mind.
    const first = f.intents.findIndex((x) => x.intent.tactic === 'combo');
    const next = f.intents.findIndex((x, k) => k > first && x.intent.comboPlan?.step === undefined && x.intent.tactic !== 'hold_range');
    const steps = f.intents.slice(first + 1, next < 0 ? undefined : next).filter((x) => x.intent.comboPlan?.step !== undefined).map((x) => x.intent.tactic);
    expect(steps).toEqual(['cross', 'low_kick']);
    expect(BODY_PROOF_S).toBeLessThan(0.1);
  });
});

describe('which mind made a decision', () => {
  test('House Mind decisions say house; Jev answers say jev', async () => {
    const sc = scene('savate', 'pylon');
    const f = fighter(sc, { tactic: 'jab' });
    await play(f, sc, 0, 0.5, () => ({ ...IQ }));
    expect(f.decisions.filter((d) => d.source === 'jev').every((d) => d.mind === 'jev')).toBe(true);
    f.brain.setSource('house');
    await play(f, sc, 0.5, 1.2, () => ({ ...IQ }));
    const house = f.decisions.filter((d) => d.source === 'fallback');
    expect(house.length).toBeGreaterThan(0);
    expect(house.every((d) => d.mind === 'house')).toBe(true);
  });
});
