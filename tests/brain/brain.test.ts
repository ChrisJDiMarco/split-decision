import { describe, expect, test } from 'vitest';
import { Brain, MAX_IN_FLIGHT } from '../../src/brain/brain';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink, RETRY_MS } from '../../src/brain/link';
import type { Intent, SimEvent } from '../../src/core/protocol';
import type { Corner } from '../../src/core/types';
import type { BrainDecision } from '../../src/brain/types';
import { answerFor, flush, frame, RED_SETUP, scene, type Scene } from './fixtures';

const FRAME_S = 1 / 60;

interface Call { questions: Record<string, JevQuestion>; state: unknown; resolve: (r: JevResult) => void; reject: (e: unknown) => void }

/** A controllable Jev: every call is recorded and settled by the test (or automatically). */
function mockAsk(auto?: (q: Record<string, JevQuestion>) => JevResult) {
  const calls: Call[] = [];
  const ask = (state: unknown, questions: Record<string, JevQuestion>) => new Promise<JevResult>((resolve, reject) => {
    calls.push({ state, questions, resolve, reject });
    if (auto) resolve(auto(questions));
  });
  return { calls, ask };
}

function harness(sc: Scene, link: JevLink, seed = 3) {
  const intents: Array<{ intent: Intent; tick: number }> = [];
  const decisions: BrainDecision[] = [];
  const brain = new Brain({
    corner: 0, meta: sc.meta, fighter: RED_SETUP, seed, link,
    onIntent: (_c, intent, tick) => intents.push({ intent, tick }),
    onDecision: (d) => decisions.push(d),
  });
  brain.start();
  return { brain, intents, decisions };
}

/** Runs frames at 60 Hz with a fake wall clock that tracks sim time. */
async function run(brain: Brain, sc: Scene, clock: { t: number }, from: number, to: number, distance: number | ((t: number) => number), events?: (t: number) => SimEvent[]) {
  for (let t = from; t < to - 1e-9; t += FRAME_S) {
    clock.t = t * 1000;
    const d = typeof distance === 'number' ? distance : distance(t);
    brain.onFrame(frame(sc, t, d, { events: events?.(t) ?? [] }));
    await flush();
  }
}

const cage = (t: number): SimEvent[] => [{ kind: 'cage', corner: 1, pos: [4, 0, 1], speed: 1 + t }];

describe('cadence', () => {
  test('about 4 Hz in striking range, about 2 Hz at mid range', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const near = mockAsk((q) => answerFor(q, 'jab'));
    const a = harness(sc, new JevLink({ ask: near.ask, now: () => clock.t }));
    await run(a.brain, sc, clock, 0, 2, 1.0);
    expect(near.calls.length).toBeGreaterThanOrEqual(7);
    expect(near.calls.length).toBeLessThanOrEqual(9);

    const mid = mockAsk((q) => answerFor(q, 'jab'));
    const b = harness(sc, new JevLink({ ask: mid.ask, now: () => clock.t }));
    await run(b.brain, sc, clock, 0, 2, 2.6);
    expect(mid.calls.length).toBeGreaterThanOrEqual(3);
    expect(mid.calls.length).toBeLessThanOrEqual(5);
  });

  test('obvious ticks settle locally with no call', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const m = mockAsk((q) => answerFor(q, 'jab'));
    const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 2, 5.5);
    expect(m.calls.length).toBe(0);
    expect(h.intents.length).toBeGreaterThanOrEqual(3);
    expect(h.intents.every((i) => i.intent.tactic === 'close_distance' && i.intent.settledLocally)).toBe(true);
    expect(h.brain.statsSnapshot.settledLocal).toBe(h.intents.length);
  });

  test('never more than 2 requests in flight, even under a storm of interrupts', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const m = mockAsk(); // never answers
    const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 3, 1.0, cage);
    expect(m.calls.length).toBe(MAX_IN_FLIGHT);
    expect(h.brain.inFlightCount).toBe(MAX_IN_FLIGHT);
  });

  test('the shared link holds all fighters to 8 requests per second', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const sent: number[] = [];
    const m = mockAsk((q) => { sent.push(clock.t); return answerFor(q, 'jab'); });
    const link = new JevLink({ ask: m.ask, now: () => clock.t });
    const brains = [0, 1, 2, 3].map((i) => harness(sc, link, i).brain);
    for (let t = 0; t < 3; t += FRAME_S) {
      clock.t = t * 1000;
      for (const b of brains) b.onFrame(frame(sc, t, 1.0, { events: cage(t) }));
      await flush();
    }
    for (const t0 of sent) expect(sent.filter((t) => t >= t0 && t < t0 + 1000).length).toBeLessThanOrEqual(8);
    expect(sent.length).toBeGreaterThanOrEqual(20);
  });

  test('a saturated link splits its budget fairly between the two corners', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const link = new JevLink({ ask: async (_s, q) => answerFor(q, 'guard', 0.2), now: () => clock.t }); // low confidence: fast re-asks
    const mk = (corner: Corner) => new Brain({
      corner, meta: sc.meta, fighter: RED_SETUP, seed: 5, link, onIntent: () => {},
    });
    const brains = [mk(0), mk(1)];
    brains.forEach((b) => b.start());
    for (let t = 0; t < 10; t += FRAME_S) {
      clock.t = t * 1000;
      for (const b of brains) b.onFrame(frame(sc, t, 1.0, { events: cage(t) }));
      await flush();
    }
    const [red, blue] = brains.map((b) => b.statsSnapshot.requests);
    expect(red + blue).toBeGreaterThan(60);
    expect(Math.abs(red - blue)).toBeLessThanOrEqual(2);
  });
});

describe('interrupts and stale answers', () => {
  test('a big hit forces an immediate re-query', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const m = mockAsk((q) => answerFor(q, 'jab'));
    const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }));
    const hit = (t: number): SimEvent[] => (Math.abs(t - 0.2) < FRAME_S / 2
      ? [{ kind: 'impact', pos: [0, 0, 1], normal: [1, 0, 0], impulseNs: 120, speed: 6, energyJ: 300, striker: 1, victim: 0, part: 'head', metal: true }]
      : []);
    await run(h.brain, sc, clock, 0, 0.3, 2.6, hit); // mid range: normal cadence is 0.5 s
    expect(m.calls.length).toBe(2);
    expect(h.decisions[1].trigger).toBe('big_hit');
  });

  test('an answer whose coarse state changed in flight is dropped', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const m = mockAsk();
    const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 0.05, 1.0);
    expect(m.calls.length).toBe(1);
    await run(h.brain, sc, clock, 0.05, 0.1, 2.6); // backed out to mid range while waiting
    m.calls[0].resolve(answerFor(m.calls[0].questions, 'hook'));
    await flush();
    expect(h.brain.statsSnapshot.droppedStale).toBe(1);
    expect(h.intents.some((i) => i.intent.tactic === 'hook')).toBe(false);
  });

  test('an older answer landing after a newer one is dropped as superseded', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const m = mockAsk();
    const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 0.3, 1.0);
    expect(m.calls.length).toBe(2);
    m.calls[1].resolve(answerFor(m.calls[1].questions, 'cross'));
    await flush();
    m.calls[0].resolve(answerFor(m.calls[0].questions, 'hook'));
    await flush();
    expect(h.intents.map((i) => i.intent.tactic)).toEqual(['cross']);
    expect(h.brain.statsSnapshot.droppedSuperseded).toBe(1);
    expect(h.intents[0].tick).toBe(h.decisions[0].tick);
  });
});

describe('fallback', () => {
  function http503(counter: { n: number }): typeof fetch {
    return (async () => {
      counter.n++;
      return new Response(JSON.stringify({ error: 'Jev key unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  }

  test('503 hands control to the House Mind and retries only every 10 s', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const hits = { n: 0 };
    const link = new JevLink({ fetchImpl: http503(hits), endpoint: 'http://test/api/jev', now: () => clock.t });
    const h = harness(sc, link);
    await run(h.brain, sc, clock, 0, 5, 1.0);
    expect(hits.n).toBe(1);
    expect(link.status).toBe('offline');
    expect(link.lastErrorStatus).toBe(503);
    expect(h.brain.decisionSource).toBe('fallback');
    expect(h.brain.source).toBe('jev');
    expect(h.brain.linkStatus).toEqual({ kind: 'offline', label: 'JEV OFFLINE → HOUSE' });
    // A combination the House Mind throws commits it for its steps (sequenced, no re-decisions), and
    // these static frames never show the body throwing, so each step runs to its timeout.
    expect(h.intents.length).toBeGreaterThan(6);
    expect(h.intents.every((i) => i.intent.source === 'fallback')).toBe(true);
    await run(h.brain, sc, clock, 5, RETRY_MS / 1000 + 0.5, 1.0);
    expect(hits.n).toBe(2);
  });

  test('recovers to Jev when a retry probe succeeds', async () => {
    const sc = scene();
    const clock = { t: 0 };
    let fail = true;
    const m = mockAsk();
    const link = new JevLink({ ask: (s, q) => (fail ? Promise.reject(new Error('down')) : m.ask(s, q)), now: () => clock.t });
    const h = harness(sc, link);
    await run(h.brain, sc, clock, 0, 1, 1.0);
    expect(link.offline).toBe(true);
    fail = false;
    await run(h.brain, sc, clock, 1, 10.6, 1.0);
    expect(m.calls.length).toBe(1);
    m.calls[0].resolve(answerFor(m.calls[0].questions, 'jab'));
    await flush();
    expect(link.status).toBe('online');
  });

  test('a timeout falls back', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('timeout', 'TimeoutError')));
    })) as typeof fetch;
    const link = new JevLink({ fetchImpl: hang, endpoint: 'http://test/api/jev', timeoutMs: 30, now: () => clock.t });
    const h = harness(sc, link);
    h.brain.onFrame(frame(sc, 0, 1.0));
    await new Promise((r) => setTimeout(r, 80));
    expect(link.offline).toBe(true);
    expect(link.lastError).toContain('timed out');
    expect(h.intents[0]?.intent.source).toBe('fallback');
  });

  test('while offline, far-apart ticks are House Mind decisions, not Jev ones', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const link = new JevLink({ ask: () => Promise.reject(new Error('down')), now: () => clock.t });
    const h = harness(sc, link);
    await run(h.brain, sc, clock, 0, 0.5, 1.0); // in range: the first call fails, link goes offline
    expect(link.offline).toBe(true);
    const before = h.intents.length;
    await run(h.brain, sc, clock, 0.5, 3, 5.5); // far apart while offline
    const far = h.intents.slice(before);
    expect(far.length).toBeGreaterThan(0);
    expect(far.every((i) => i.intent.source === 'fallback' && !i.intent.settledLocally)).toBe(true);
    expect(h.decisions.slice(before).every((d) => d.source === 'fallback')).toBe(true);
  });

  test('an upstream error object becomes a readable message', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'invalid api key', type: 'auth' } }), { status: 401 })) as typeof fetch;
    const link = new JevLink({ fetchImpl, endpoint: 'http://test/api/jev', now: () => clock.t });
    const h = harness(sc, link);
    await run(h.brain, sc, clock, 0, 0.1, 1.0);
    expect(link.lastErrorStatus).toBe(401);
    expect(link.lastError).toBe('invalid api key');
  });

  test('a malformed answer counts as a failure', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const link = new JevLink({ ask: async () => ({ answers: {}, latencyMs: 50, inputTokens: 10, outputTokens: 0 }), now: () => clock.t });
    const h = harness(sc, link);
    await run(h.brain, sc, clock, 0, 0.1, 1.0);
    expect(link.offline).toBe(true);
    expect(h.intents[0].intent.source).toBe('fallback');
  });
});

describe('determinism and stats', () => {
  test('same seed, same frames, same answers → same decisions', async () => {
    const runOnce = async () => {
      const sc = scene();
      const clock = { t: 0 };
      const m = mockAsk((q) => answerFor(q, 'jab', 0.7));
      const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }), 99);
      await run(h.brain, sc, clock, 0, 3, (t) => 1.0 + 0.1 * Math.sin(t));
      return h.intents.map((i) => `${i.tick}:${i.intent.tactic}:${i.intent.target}`);
    };
    const a = await runOnce();
    expect(a.length).toBeGreaterThan(5);
    expect(await runOnce()).toEqual(a);
  });

  test('records latency percentiles and token usage', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const m = mockAsk((q) => answerFor(q, 'jab'));
    const h = harness(sc, new JevLink({ ask: m.ask, now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 1, 1.0);
    const st = h.brain.statsSnapshot;
    expect(st.answered).toBe(m.calls.length);
    expect(st.latency.p50).toBe(120);
    expect(st.inputTokens).toBe(900 * st.answered);
    expect(h.brain.latest?.source).toBe('jev');
    expect(h.brain.latest?.tacticProbs.jab).toBeCloseTo(0.7);
  });
});
