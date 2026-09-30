// The brain during a referee break (src/physics/systems/referee.ts): the body obeys the referee, so the
// brain settles every tick locally at low aggression, arms no reflexes and asks no model (Jev or the
// LOCAL mind); the downed fighter's one kip-up question stays. FIGHT forces a fresh decision at once.
// The House Mind never goes for a finish on a downed man.
import { describe, expect, test } from 'vitest';
import { Brain } from '../../src/brain/brain';
import { BREAK_AGGRESSION, houseMind, obviousDecision } from '../../src/brain/house-mind';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink } from '../../src/brain/link';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import type { BrainDecision, MindSource } from '../../src/brain/types';
import type { Intent, RefereeTelemetry, RobotTelemetry } from '../../src/core/protocol';
import { answerFor, flush, frame, scene, type Scene } from './fixtures';

const RISK = { tornado_kick: 0.55, spinning_back_kick: 0.3, jump_kick: 0.42, jumping_knee: 0.3, superman_punch: 0.22, spinning_backfist: 0.1, kip_up: 0.35 };
const ref = (role: RefereeTelemetry['role'], breakS = 1): RefereeTelemetry => ({ break: true, role, breakS });
const OFF: RefereeTelemetry = { break: false };

interface Tel { red: Partial<RobotTelemetry>; blue: Partial<RobotTelemetry> }
const standing = (): Tel => ({ red: { moveRisk: { ...RISK }, openings: ['low_guard'], referee: OFF }, blue: { referee: OFF } });
/** Blue is down and getting up; red is sent to the neutral corner. */
const blueDown = (): Tel => ({
  red: { moveRisk: { ...RISK }, openings: [], referee: ref('neutral') },
  blue: { down: true, upright: 0.1, referee: ref('down') },
});
/** Red is down (kip-up possible); blue is at the neutral corner. */
const redDown = (): Tel => ({
  red: { down: true, upright: 0.1, moveRisk: { ...RISK }, referee: ref('down') },
  blue: { referee: ref('neutral') },
});

function rig(sc: Scene, source: MindSource = 'jev', deferred = false) {
  const clock = { t: 0 };
  const calls: Array<Record<string, JevQuestion>> = [];
  const pending: Array<() => void> = [];
  const ask = (_s: unknown, q: Record<string, JevQuestion>): Promise<JevResult> => {
    calls.push(q);
    const res = answerFor(q, 'hook');
    if (!deferred) return Promise.resolve(res);
    return new Promise((resolve) => pending.push(() => resolve(res)));
  };
  const link = new JevLink({ now: () => clock.t, ask });
  const intents: Array<{ intent: Intent; tick: number }> = [];
  const decisions: BrainDecision[] = [];
  const brain = new Brain({
    corner: 0, meta: sc.meta, seed: 4, link, localLink: link, source,
    fighter: { design: sc.meta.robots[0].design, skin: 'factory', plan: 'Finish him when he is down.', temperament: 1.3 },
    onIntent: (_c, intent, tick) => intents.push({ intent, tick }), onDecision: (d) => decisions.push(d),
  });
  brain.start();
  const run = async (from: number, to: number, tel: () => Tel, distance = 1.0) => {
    for (let t = from; t < to; t += 1 / 60) {
      clock.t = t * 1000;
      brain.onFrame(frame(sc, t, distance, tel()));
      await flush();
    }
  };
  return { brain, calls, intents, decisions, run, pending };
}

describe('brain during a referee break', () => {
  for (const source of ['jev', 'local'] as const) {
    test(`${source}: the standing fighter holds at low aggression, arms nothing and asks the model nothing`, async () => {
      const sc = scene('savate', 'haymaker');
      const b = rig(sc, source);
      await b.run(0, 1, standing);
      const asked = b.calls.length;
      expect(asked).toBeGreaterThan(0); // fighting: the model decides
      const n = b.intents.length;
      await b.run(1, 4, blueDown);
      expect(b.calls.length).toBe(asked);
      const held = b.intents.slice(n).map((x) => x.intent);
      expect(held.length).toBeGreaterThan(4);
      for (const i of held) {
        expect(i.tactic).toBe('hold_range');
        expect(i.aggression).toBeLessThanOrEqual(BREAK_AGGRESSION);
        expect(i.onOpening).toBeUndefined();
        expect(i.counterIfLunge).toBe('guard');
      }
      expect(b.decisions.at(-1)!.reason).toBe('referee break: neutral corner');
      expect(b.decisions.at(-1)!.onOpening).toBeNull();
      // He is back up, the neutral man still walking: waiting for FIGHT, still no calls.
      await b.run(4, 5, () => ({ red: { moveRisk: { ...RISK }, referee: ref('hold') }, blue: { referee: ref('hold') } }));
      expect(b.calls.length).toBe(asked);
      expect(b.decisions.at(-1)!.reason).toBe('referee break: waiting for FIGHT');
    });
  }

  test('the downed fighter keeps its one kip-up question, and says it is getting up while it rises', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc);
    await b.run(0, 2, redDown);
    expect(b.calls).toHaveLength(1);
    expect(Object.keys(b.calls[0])).toEqual(['getup_style']);
    // Off the canvas but still rising out of the crouch: the referee still counts him down.
    await b.run(2, 3, () => ({ red: { moveRisk: { ...RISK }, referee: ref('down') }, blue: { referee: ref('neutral') } }));
    expect(b.calls).toHaveLength(1);
    expect(b.decisions.at(-1)!.reason).toBe('down: getting up');
    expect(b.intents.at(-1)!.intent.tactic).toBe('guard');
  });

  test('FIGHT forces a fresh decision at once: the first intent after it is not the break\'s', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc);
    await b.run(0, 2, blueDown);
    const asked = b.calls.length;
    const n = b.intents.length;
    await b.run(2, 2 + 1 / 60, standing); // the FIGHT frame
    expect(b.calls.length).toBe(asked + 1); // asked on the edge, not at the next cadence tick
    await b.run(2 + 1 / 60, 2.1, standing);
    const after = b.intents.slice(n);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].intent.tactic).not.toBe('hold_range');
    expect(after[0].tick).toBeGreaterThanOrEqual(2000);
    expect(b.decisions.find((d) => d.tick >= 2000)?.trigger).toBe('referee_fight');
  });

  test('the MIND panel read-out follows the break, even after the capped history is full', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc);
    await b.run(0, 20, standing); // well past HISTORY_LEN (60) decisions
    expect(b.decisions.length).toBeGreaterThan(60);
    expect(b.brain.latest!.reason).not.toMatch(/referee/); // the HUD reads it every frame
    await b.run(20, 21, blueDown);
    expect(b.brain.latest!.reason).toBe('referee break: neutral corner');
    expect(b.brain.latest!.tactic).toBe('hold_range');
  });

  // The controller flags the fall a control tick or two before the referee's next update, so the
  // first frame of a knockdown can carry `down` and the 'fall' event without `referee.break` yet.
  const fallFrame = (t: number, fell: 0 | 1, red: Partial<RobotTelemetry>, blue: Partial<RobotTelemetry>) =>
    frame(scene('savate', 'haymaker'), t, 1.0, { red, blue, events: [{ kind: 'fall', corner: fell }] });

  test('the knockdown frame before the referee\'s flag asks the standing fighter\'s model nothing', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc);
    await b.run(0, 1, standing);
    const asked = b.calls.length;
    b.brain.onFrame(fallFrame(1, 1, { moveRisk: { ...RISK }, referee: OFF }, { down: true, upright: 0.1, referee: OFF }));
    await flush();
    await b.run(1 + 1 / 60, 2, blueDown);
    expect(b.calls.length).toBe(asked);
    expect(b.decisions.at(-1)!.reason).toBe('referee break: neutral corner');
  });

  test('the kip-up question asked on the knockdown frame is answered, not thrown away when the flag lands', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc, 'jev', true);
    await b.run(0, 1, standing);
    for (const resolve of b.pending.splice(0)) resolve();
    await flush();
    const asked = b.calls.length;
    b.brain.onFrame(fallFrame(1, 0, { down: true, upright: 0.1, moveRisk: { ...RISK }, referee: OFF }, { referee: OFF }));
    await flush();
    expect(b.calls.slice(asked).map((q) => Object.keys(q))).toEqual([['getup_style']]);
    await b.run(1 + 1 / 60, 1.5, redDown);
    for (const resolve of b.pending.splice(0)) resolve();
    await b.run(1.5, 2, redDown);
    expect(b.decisions.some((d) => d.source === 'jev' && /^down: (going for the kip-up|safe get-up)/.test(d.reason ?? ''))).toBe(true);
  });

  test('while the kip-up question is out, the downed fighter covers up at once: no pre-knockdown combo or reflex', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc, 'jev', true);
    await b.run(0, 1, standing);
    for (const resolve of b.pending.splice(0)) resolve();
    await flush();
    const n = b.intents.length;
    b.brain.onFrame(fallFrame(1, 0, { down: true, upright: 0.1, moveRisk: { ...RISK }, referee: OFF }, { referee: OFF }));
    await flush();
    expect(b.pending).toHaveLength(1); // the kip-up question, unanswered
    const held = b.intents.slice(n);
    expect(held).toHaveLength(1);
    expect(held[0].intent).toMatchObject({ tactic: 'guard', aggression: BREAK_AGGRESSION });
    expect(held[0].intent.onOpening).toBeUndefined();
    expect(held[0].intent.combo).toBeUndefined();
    expect(held[0].intent.getupStyle).toBeUndefined(); // undecided until Jev answers
    expect(b.decisions.at(-1)!.reason).toBe('down: getting up');
  });

  test('an answer asked before the knockdown is never applied during the break', async () => {
    const sc = scene('savate', 'haymaker');
    const b = rig(sc, 'jev', true);
    await b.run(0, 0.2, standing);
    expect(b.pending.length).toBeGreaterThan(0);
    const n = b.intents.length;
    await b.run(0.2, 0.5, blueDown);
    for (const resolve of b.pending.splice(0)) resolve();
    await b.run(0.5, 1, blueDown);
    expect(b.intents.slice(n).every((x) => x.intent.tactic === 'hold_range')).toBe(true);
  });
});

describe('House Mind on a downed man', () => {
  test('never goes for the finish, with or without the referee\'s view', () => {
    const sc = scene('haymaker', 'savate');
    const fc = makeFighterContext(0, sc.red, sc.blue, { design: 'haymaker', skin: 'factory', plan: '', temperament: 1.4 });
    for (const distance of [0.6, 1.0, 1.6, 3]) {
      for (let tick = 0; tick < 40; tick++) {
        const bare = readSituation(fc, { ...frame(sc, tick / 10, distance, { red: { moveRisk: { ...RISK } }, blue: { down: true, upright: 0.1 } }), tick });
        const d = houseMind(fc, bare, 7);
        expect(d.reason).not.toMatch(/finish/);
        expect(d.aggression).toBeLessThanOrEqual(BREAK_AGGRESSION);
        expect(d.onOpening).toBeUndefined();
        const held = readSituation(fc, { ...frame(sc, tick / 10, distance, { red: { referee: ref('neutral') }, blue: { down: true, upright: 0.1, referee: ref('down') } }), tick });
        expect(obviousDecision(fc, held, 7)).toMatchObject({ tactic: 'hold_range', reason: 'referee break: neutral corner' });
      }
    }
  });
});
