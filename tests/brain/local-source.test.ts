// The mind source switch: JEV (cloud), LOCAL (open-source model via /api/local-jev), HOUSE (rules).
import { afterEach, describe, expect, test } from 'vitest';
import { Brain } from '../../src/brain/brain';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import { JevLink, type LinkHealth } from '../../src/brain/link';
import { createLocalLink, LOCAL_HEALTH_MS } from '../../src/brain/local-link';
import type { Intent } from '../../src/core/protocol';
import type { BrainDecision, MindSource } from '../../src/brain/types';
import { answerFor, flush, frame, RED_SETUP, scene, type Scene } from './fixtures';
import { config, startBridge, startMockOllama, type Listening } from '../server/helpers';

const FRAME_S = 1 / 60;

interface Call { questions: Record<string, JevQuestion>; resolve: (r: JevResult) => void; reject: (e: unknown) => void }
function mockAsk(auto?: (q: Record<string, JevQuestion>) => JevResult) {
  const calls: Call[] = [];
  const ask = (_state: unknown, questions: Record<string, JevQuestion>) => new Promise<JevResult>((resolve, reject) => {
    calls.push({ questions, resolve, reject });
    if (auto) resolve(auto(questions));
  });
  return { calls, ask };
}

/** Counts every network touch a link could make. */
function countingFetch() {
  const hits = { n: 0 };
  const fetchImpl = (async () => { hits.n++; return new Response('{}', { status: 500 }); }) as typeof fetch;
  return { hits, fetchImpl };
}

function harness(sc: Scene, link: JevLink, localLink: JevLink, source?: MindSource) {
  const intents: Array<{ intent: Intent; tick: number }> = [];
  const decisions: BrainDecision[] = [];
  const brain = new Brain({
    corner: 0, meta: sc.meta, fighter: RED_SETUP, seed: 3, link, localLink, ...(source ? { source } : {}),
    onIntent: (_c, intent, tick) => intents.push({ intent, tick }),
    onDecision: (d) => decisions.push(d),
  });
  brain.start();
  return { brain, intents, decisions };
}

async function run(brain: Brain, sc: Scene, clock: { t: number }, from: number, to: number, distance = 1.0) {
  for (let t = from; t < to - 1e-9; t += FRAME_S) {
    clock.t = t * 1000;
    brain.onFrame(frame(sc, t, distance));
    await flush();
  }
}

describe('mind source', () => {
  test("defaults to 'jev' and never touches the LOCAL link", async () => {
    const sc = scene();
    const clock = { t: 0 };
    const jev = mockAsk((q) => answerFor(q, 'jab'));
    const local = countingFetch();
    const h = harness(sc, new JevLink({ ask: jev.ask, now: () => clock.t }), createLocalLink({ fetchImpl: local.fetchImpl, endpoint: 'http://t/api/local-jev', now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 2);
    expect(h.brain.source).toBe('jev');
    expect(jev.calls.length).toBeGreaterThan(3);
    expect(local.hits.n).toBe(0);
    expect(h.brain.linkStatus).toEqual({ kind: 'jev', label: 'JEV' });
    expect(h.brain.latest?.link).toEqual({ kind: 'jev', label: 'JEV' });
  });

  test('LOCAL asks the local link only, and the HUD names the model', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const jev = countingFetch();
    const local = mockAsk((q) => ({ ...answerFor(q, 'jab'), latencyMs: 400 }));
    const localLink = new JevLink({ ask: local.ask, now: () => clock.t });
    localLink.model = 'decider-4b';
    const h = harness(sc, new JevLink({ fetchImpl: jev.fetchImpl, endpoint: 'http://t/api/jev', now: () => clock.t }), localLink, 'local');
    await run(h.brain, sc, clock, 0, 2);
    expect(jev.hits.n).toBe(0);
    expect(local.calls.length).toBeGreaterThan(3);
    expect(h.decisions.some((d) => d.source === 'jev' && d.tactic === 'jab')).toBe(true);
    expect(h.brain.linkStatus).toEqual({ kind: 'local', label: 'LOCAL · decider-4b' });
  });

  test('HOUSE makes zero network calls and shows HOUSE', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const jev = countingFetch();
    const local = countingFetch();
    const h = harness(sc,
      new JevLink({ fetchImpl: jev.fetchImpl, endpoint: 'http://t/api/jev', now: () => clock.t }),
      createLocalLink({ fetchImpl: local.fetchImpl, endpoint: 'http://t/api/local-jev', now: () => clock.t }), 'house');
    await run(h.brain, sc, clock, 0, 12); // past every retry and health interval
    await new Promise((r) => setTimeout(r, 20));
    expect(jev.hits.n + local.hits.n).toBe(0);
    expect(h.intents.length).toBeGreaterThan(5);
    expect(h.intents.every((i) => i.intent.source === 'fallback')).toBe(true);
    expect(h.brain.decisionSource).toBe('fallback');
    expect(h.brain.linkStatus).toEqual({ kind: 'house', label: 'HOUSE' });
    expect(h.brain.statsSnapshot.requests).toBe(0);
  });

  test('LOCAL unreachable → House Mind with LOCAL OFFLINE → HOUSE, health re-probed every few seconds, then recovery', async () => {
    const sc = scene();
    const clock = { t: 0 };
    let up = false;
    const probes: number[] = [];
    const health = async (): Promise<LinkHealth> => { probes.push(clock.t); return up ? { ok: true, model: 'decider-4b', latencyMs: 90 } : { ok: false, error: 'connection refused' }; };
    const local = mockAsk();
    const ask = (s: unknown, q: Record<string, JevQuestion>) => (up ? local.ask(s, q) : Promise.reject(new Error('Jev network error: fetch failed')));
    const localLink = createLocalLink({ ask, health, now: () => clock.t });
    const h = harness(sc, new JevLink({ ask: () => Promise.reject(new Error('never')), now: () => clock.t }), localLink, 'local');
    await run(h.brain, sc, clock, 0, 1);
    expect(localLink.offline).toBe(true);
    expect(h.brain.linkStatus).toEqual({ kind: 'offline', label: 'LOCAL OFFLINE → HOUSE' });
    expect(h.brain.latest?.link?.label).toBe('LOCAL OFFLINE → HOUSE');
    expect(h.intents.length).toBeGreaterThan(0);
    expect(h.intents.every((i) => i.intent.source === 'fallback')).toBe(true);
    await run(h.brain, sc, clock, 1, 10);
    // First probe once the first health interval is due after the failure, then one per LOCAL_HEALTH_MS.
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes.length).toBeLessThanOrEqual(Math.ceil(10_000 / LOCAL_HEALTH_MS));
    for (let i = 1; i < probes.length; i++) expect(probes[i] - probes[i - 1]).toBeGreaterThanOrEqual(LOCAL_HEALTH_MS - 20);
    expect(local.calls.length).toBe(0); // no decisions are sent while offline
    up = true;
    await run(h.brain, sc, clock, 10, 13.5);
    expect(localLink.status).toBe('online');
    expect(h.brain.linkStatus).toEqual({ kind: 'local', label: 'LOCAL · decider-4b' });
    expect(local.calls.length).toBeGreaterThan(0);
    const before = h.decisions.length;
    local.calls.at(-1)!.resolve(answerFor(local.calls.at(-1)!.questions, 'jab'));
    await flush();
    expect(h.decisions.slice(before).some((d) => d.source === 'jev')).toBe(true);
  });

  test('LOCAL answering too slowly goes offline to the House Mind', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const local = mockAsk((q) => ({ ...answerFor(q, 'jab'), latencyMs: 2400 }));
    const localLink = createLocalLink({ ask: local.ask, health: async () => ({ ok: false }), now: () => clock.t });
    const h = harness(sc, new JevLink({ ask: () => Promise.reject(new Error('never')), now: () => clock.t }), localLink, 'local');
    await run(h.brain, sc, clock, 0, 2);
    expect(local.calls.length).toBe(3);
    expect(localLink.offline).toBe(true);
    expect(localLink.lastError).toContain('too slow');
    expect(h.brain.linkStatus.label).toBe('LOCAL OFFLINE → HOUSE');
    expect(h.intents.at(-1)?.intent.source).toBe('fallback');
  });

  test('a late answer from before the link went offline does not bring LOCAL back (no flicker)', async () => {
    const clock = { t: 0 };
    const calls: Call[] = [];
    const ask = (_s: unknown, questions: Record<string, JevQuestion>) => new Promise<JevResult>((resolve, reject) => { calls.push({ questions, resolve, reject }); });
    const link = createLocalLink({ ask, health: async () => ({ ok: false, error: 'down' }), now: () => clock.t });
    const a = link.send({}, {});
    const b = link.send({}, {});
    calls[0].reject(new Error('502'));
    await a.catch(() => {});
    expect(link.offline).toBe(true);
    calls[1].resolve({ ...answerFor({}), latencyMs: 400 });
    await b;
    expect(link.offline).toBe(true); // only a healthy probe brings it back
  });

  test('a model that passes the probe but fails real decisions backs off instead of flapping every 3 s', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const probes: number[] = [];
    let asks = 0;
    const ask = () => { asks++; return Promise.reject(new Error('local systemone 502')); };
    const localLink = createLocalLink({ ask, health: async () => { probes.push(clock.t); return { ok: true, model: 'decider-4b' }; }, now: () => clock.t });
    const h = harness(sc, new JevLink({ ask: () => Promise.reject(new Error('never')), now: () => clock.t }), localLink, 'local');
    await run(h.brain, sc, clock, 0, 60);
    // Probes at ~3, 9, 21, 45 s (3 → 6 → 12 → 24 s), not every 3 s.
    expect(probes.length).toBeLessThanOrEqual(5);
    expect(asks).toBeLessThanOrEqual(6);
    for (let i = 2; i < probes.length; i++) expect(probes[i] - probes[i - 1]).toBeGreaterThan(probes[i - 1] - probes[i - 2]);
    expect(h.intents.every((i) => i.intent.source === 'fallback')).toBe(true);
  });

  test('hot swap with an answer in flight: the old mind\'s answer is never applied', async () => {
    const sc = scene();
    const clock = { t: 0 };
    const jev = mockAsk();
    const local = mockAsk();
    const h = harness(sc, new JevLink({ ask: jev.ask, now: () => clock.t }), new JevLink({ ask: local.ask, now: () => clock.t }));
    await run(h.brain, sc, clock, 0, 0.05);
    expect(jev.calls.length).toBe(1);
    h.brain.setSource('local');
    expect(h.brain.source).toBe('local');
    await run(h.brain, sc, clock, 0.05, 0.15);
    expect(local.calls.length).toBe(1); // the new mind asks at once, not blocked by the old in-flight slot
    const before = h.intents.length;
    jev.calls[0].resolve(answerFor(jev.calls[0].questions, 'jab'));
    await flush();
    expect(h.intents.length).toBe(before); // dropped
    local.calls[0].resolve(answerFor(local.calls[0].questions, 'cross'));
    await flush();
    expect(h.intents.length).toBe(before + 1);
    expect(h.intents.at(-1)?.intent.tactic).toBe(h.decisions.at(-1)?.tactic);
    expect(h.decisions.every((d) => d.tactic !== 'jab' || d.source !== 'jev')).toBe(true);
    // A failure arriving from the old mind after a swap does not hand a decision to the House Mind either.
    h.brain.setSource('house');
    const n = h.intents.length;
    await run(h.brain, sc, clock, 0.15, 0.4);
    expect(h.intents.length).toBeGreaterThan(n);
    expect(h.intents.slice(n).every((i) => i.intent.source === 'fallback')).toBe(true);
    h.brain.setSource('jev');
    expect(h.brain.linkStatus.kind).toBe('jev');
  });
});

describe('LOCAL end to end: brain → /api/local-jev bridge → mock Ollama', () => {
  const open: Listening[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });

  test('decisions come from the local model through the adapter', async () => {
    const ollama = await startMockOllama({ favour: 'jab' });
    open.push(ollama);
    const bridge = await startBridge(config({ url: ollama.url }));
    open.push(bridge);
    const sc = scene();
    const clock = { t: 0 };
    const localLink = createLocalLink({ endpoint: `${bridge.url}/api/local-jev` });
    const h = harness(sc, new JevLink({ ask: () => Promise.reject(new Error('cloud must not be called')), now: () => clock.t }), localLink, 'local');
    for (let t = 0; t < 1.5; t += FRAME_S) {
      clock.t = t * 1000;
      h.brain.onFrame(frame(sc, t, 1.0));
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(localLink.status).toBe('online');
    const model = h.decisions.filter((d) => d.source === 'jev');
    expect(model.length).toBeGreaterThan(0);
    expect(model.some((d) => d.tactic === 'jab')).toBe(true);
    expect(model[0].tacticProbs.jab).toBeGreaterThan(0.5);
    expect(h.brain.statsSnapshot.errors).toBe(0);
    expect(ollama.requests.length).toBeGreaterThan(10);
  });
});

describe('MIND panel labels', () => {
  const base = { tactic: 'jab', target: 'head', aggression: 0.5, tacticProbs: { jab: 1 }, oppCommit: null };
  test('chip and badge per mind', async () => {
    const { mindChip, offlineBadge } = await import('../../src/ui/minds');
    expect(mindChip({ ...base, source: 'jev', latencyMs: 265 })).toBe('JEV · 265 ms');
    expect(mindChip({ ...base, source: 'jev', latencyMs: 480, link: { kind: 'local', label: 'LOCAL · decider-4b' } })).toBe('LOCAL · decider-4b · 480 ms');
    expect(mindChip({ ...base, source: 'local', latencyMs: null, link: { kind: 'local', label: 'LOCAL · decider-4b' } })).toBe('LOCAL · decider-4b · RULE');
    expect(mindChip({ ...base, source: 'fallback', latencyMs: null, link: { kind: 'house', label: 'HOUSE' } })).toBe('HOUSE');
    expect(offlineBadge({ ...base, source: 'fallback', latencyMs: null, link: { kind: 'house', label: 'HOUSE' } })).toBeNull();
    expect(offlineBadge({ ...base, source: 'fallback', latencyMs: null, link: { kind: 'offline', label: 'LOCAL OFFLINE → HOUSE' } })).toBe('LOCAL OFFLINE → HOUSE');
    expect(offlineBadge({ ...base, source: 'fallback', latencyMs: null })).toBe('JEV OFFLINE · HOUSE MIND'); // callers without a link
  });
});
