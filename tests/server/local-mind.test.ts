import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { configFromEnv, isLoopbackUrl, LocalMind } from '../../server/local-mind';
import {
  assemble, choiceConfidence, labelProbabilities, optionLabel, planRows, promptFor, renderQuestion, renderState,
  scoreConfidence, shortModelName, temperaturesFor,
} from '../../server/systemone-adapter';
import { buildQuestions } from '../../src/brain/questions';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { frame, RED_SETUP, scene } from '../brain/fixtures';
import { config, parsePrompt, startBridge, startMockOllama, startMockSystemOne, type Listening } from './helpers';

const open: Listening[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => s.close())); });
const keep = <T extends Listening>(s: T) => { open.push(s); return s; };

/** A real brain request: the full question set for a fighter in striking range. */
function brainRequest() {
  const sc = scene('bruiser', 'striker');
  const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
  const s = readSituation(fc, frame(sc, 40, 1.0, { blue: { windup: 0.5, skill: 'low_kick' } }));
  const state = serializeState(fc, s, [{ action: 'low_kick', time: 38 }], { round: 2, rounds: 3, remainingS: 100 }, 'jab');
  const qs = buildQuestions(fc, s.opp);
  return { model: 'jev-1.13.0', state, questions: qs.questions };
}

async function post(url: string, body: unknown) {
  const r = await fetch(`${url}/api/local-jev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, json: (await r.json()) as Record<string, any> };
}

describe('adapter (decider prompt and readout)', () => {
  test('renders the plain state-first layout decider was trained on', () => {
    expect(promptFor('{"a":1}', 'Pick one', ['jab', 'cross: a straight punch'])).toBe(
      'Context:\n{"a":1}\n\nQuestion: Pick one\nOptions:\n(A) jab\n(B) cross: a straight punch\nAnswer: (',
    );
    expect(optionLabel(0)).toBe('A');
    expect(optionLabel(25)).toBe('Z');
    expect(optionLabel(26)).toBe('AA');
  });

  test('renders the three question types like decider/systemone.py', () => {
    expect(renderQuestion({ type: 'choice', instructions: 'Where?', criteria: { head: 'the head', body: null } }).options).toEqual(['head: the head', 'body']);
    expect(renderQuestion({ type: 'noul', instructions: 'Lunge?' }).options).toEqual(['no', 'yes']);
    const sc = renderQuestion({ type: 'score', instructions: 'How hard?', criteria: ['soft', 'medium', 'hard'] });
    expect(sc.options).toEqual(['0: soft', '1: medium', '2: hard']);
    expect(() => renderQuestion({ type: 'choice', instructions: 'x', criteria: { only: null } })).toThrow(/2\.\.255/);
    expect(() => renderQuestion({ type: 'noul' })).toThrow(/instructions/);
    expect(() => renderQuestion({ type: 'wat', instructions: 'x' })).toThrow(/unknown/);
  });

  test('writes indices into long arrays (decider annotate_indices)', () => {
    const s = JSON.parse(renderState({ xs: [1, 2, 3, 4, 5, 6, 7, 8], ys: [1, 2] }));
    expect(s.xs[7]).toEqual({ _index: 7, value: 8 });
    expect(s.ys).toEqual([1, 2]);
  });

  test('letter log probabilities / T reproduce softmax(logits / T) over the labels', () => {
    const logits = [2.0, 0.5, -1.0];
    const lse = Math.log(logits.map(Math.exp).reduce((a, b) => a + b, 0) + 50); // plus the rest of a vocabulary
    const top = [{ token: 'A', logprob: logits[0] - lse }, { token: 'B', logprob: logits[1] - lse }, { token: 'C', logprob: logits[2] - lse }, { token: ' x', logprob: -9 }];
    const T = 1.3;
    const want = logits.map((l) => Math.exp(l / T));
    const sum = want.reduce((a, b) => a + b, 0);
    labelProbabilities(top, ['A', 'B', 'C'], T).forEach((p, i) => expect(p).toBeCloseTo(want[i] / sum, 10));
  });

  test('a label outside the top-k gets a floor, and no label at all is an error', () => {
    const p = labelProbabilities([{ token: 'A', logprob: -0.1 }, { token: 'B', logprob: -2 }], ['A', 'B', 'C'], 1);
    expect(p[2]).toBeGreaterThan(0);
    expect(p[2]).toBeLessThan(p[1]);
    expect(() => labelProbabilities([{ token: 'hello', logprob: -0.1 }], ['A', 'B'], 1)).toThrow(/option letter/);
  });

  test('confidence formulas match TypeSafe', () => {
    expect(choiceConfidence([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0);
    expect(choiceConfidence([1, 0, 0])).toBeCloseTo(1);
    expect(scoreConfidence([0, 0, 1, 0, 0])).toBeCloseTo(1);
    expect(scoreConfidence([0.5, 0.5])).toBeCloseTo(choiceConfidence([0.5, 0.5]));
  });

  test('isolated score levels: one yes/no row per level, combined as P(fits)', () => {
    const req = { state: 's', questions: { agg: { type: 'score', instructions: 'How aggressive?', criteria: ['calm', 'busy', 'wild'] } } };
    const { rows, rendered } = planRows(req, true);
    expect(rows).toHaveLength(3);
    expect(rows[1].prompt).toContain('How aggressive?\nProposed answer: busy\nDoes the proposed answer fit?\nOptions:\n(A) no\n(B) yes\nAnswer: (');
    const a = assemble(rows, rendered, [[0.9, 0.1], [0.2, 0.8], [0.9, 0.1]]);
    expect(a.agg.type).toBe('score');
    if (a.agg.type === 'score') {
      expect(a.agg.probabilities['1']).toBeCloseTo(0.8, 3);
      expect(a.agg.score).toBeCloseTo(1, 1);
    }
    expect(planRows(req, false).rows).toHaveLength(1);
  });

  test('model names and temperatures', () => {
    expect(shortModelName('hf.co/Mapika/decider-4b-GGUF:Q4_K_M')).toBe('decider-4b');
    expect(shortModelName('decider-2b')).toBe('decider-2b');
    expect(temperaturesFor('hf.co/Mapika/decider-2b-GGUF:Q4_K_M').noul).toBe(1.624);
    expect(temperaturesFor('decider-4b', 'choice=1.5,bogus=3').choice).toBe(1.5);
  });
});

describe('bridge /api/local-jev (ollama backend)', () => {
  test('full round trip: a real brain request, all three question types', async () => {
    const ollama = keep(await startMockOllama({ favour: 'jab' }));
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const req = brainRequest();
    const { status, json, headers } = await post(bridge.url, req);
    expect(status).toBe(200);
    expect(json.model).toBe('decider-4b');
    const ids = Object.keys(req.questions);
    expect(Object.keys(json.answers).sort()).toEqual([...ids].sort());
    for (const [id, q] of Object.entries(req.questions)) {
      const a = json.answers[id];
      expect(a.type).toBe(q.type);
      if (a.type === 'choice') {
        const sum = Object.values(a.probabilities as Record<string, number>).reduce((x, y) => x + y, 0);
        expect(sum).toBeCloseTo(1, 2);
        expect(Object.keys(a.probabilities).sort()).toEqual(Object.keys((q as { criteria: object }).criteria).sort());
        expect(a.confidence).toBeGreaterThan(0);
      } else if (a.type === 'noul') {
        expect(a.noul).toBeGreaterThanOrEqual(0);
        expect(a.noul).toBeLessThanOrEqual(1);
      } else {
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(Object.keys(a.probabilities).length - 1);
      }
    }
    expect(json.answers.tactic.choice).toBe('jab');
    // One Ollama call per row: 4 list questions + 2 score questions × 5 isolated levels.
    expect(ollama.requests).toHaveLength(4 + 2 * 5);
    for (const r of ollama.requests) {
      expect(r).toMatchObject({ raw: true, stream: false, logprobs: true, top_logprobs: 20, options: { num_predict: 1, temperature: 0 } });
      // Every row starts with the same state, so Ollama's prefix cache pays for it once.
      expect(String(r.prompt).startsWith(`Context:\n${JSON.stringify(req.state)}`)).toBe(true);
    }
    expect(Number(headers.get('x-local-jev-latency-ms'))).toBeGreaterThanOrEqual(0);
  });

  test('a choice with more options than top_logprobs still answers every option', async () => {
    const ollama = keep(await startMockOllama({ pick: (p) => p.labels.length - 1 }));
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const criteria = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`move${i}`, null]));
    const { status, json } = await post(bridge.url, { state: { x: 1 }, questions: { m: { type: 'choice', instructions: 'Which?', criteria } } });
    expect(status).toBe(200);
    expect(Object.keys(json.answers.m.probabilities)).toHaveLength(30);
    expect(parsePrompt(String(ollama.requests[0].prompt)).labels.at(-1)).toBe('AD');
  });

  test('invalid requests are 400/422 and never reach the runtime', async () => {
    const ollama = keep(await startMockOllama());
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const bad = await fetch(`${bridge.url}/api/local-jev`, { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    const r = await post(bridge.url, { state: {}, questions: { q: { type: 'choice', instructions: 'x', criteria: { a: null } } } });
    expect(r.status).toBe(422);
    expect(ollama.requests).toHaveLength(0);
  });

  test('a slow runtime times out with 504', async () => {
    const ollama = keep(await startMockOllama({ delayMs: 400 }));
    const bridge = keep(await startBridge(config({ url: ollama.url, timeoutMs: 150 })));
    const t0 = performance.now();
    const r = await post(bridge.url, { state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } });
    expect(r.status).toBe(504);
    expect(performance.now() - t0).toBeLessThan(380);
  });

  test('the concurrency cap holds and a full queue answers 429', async () => {
    const ollama = keep(await startMockOllama({ delayMs: 60 }));
    const bridge = keep(await startBridge(config({ url: ollama.url, maxConcurrent: 1, maxQueue: 1 })));
    const body = { state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } };
    const rs = await Promise.all([post(bridge.url, body), post(bridge.url, body), post(bridge.url, body)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 429]);
    expect(ollama.maxConcurrent).toBe(1);
  });

  test('runtime down → 503; model not pulled → 503 with the ollama message', async () => {
    const down = keep(await startBridge(config({ url: 'http://127.0.0.1:9' })));
    const r1 = await post(down.url, { state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } });
    expect(r1.status).toBe(503);
    const ollama = keep(await startMockOllama({ model: 'something-else' }));
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const r2 = await post(bridge.url, { state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } });
    expect(r2.status).toBe(503);
    expect(r2.json.error).toContain('not found');
  });

  test('an Ollama without logprobs is a clear 502', async () => {
    const ollama = keep(await startMockOllama({ noLogprobs: true }));
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const r = await post(bridge.url, { state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } });
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('logprobs');
  });

  test('never forwards off this machine: a non-loopback URL is refused before any fetch', async () => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return new Response('{}'); }) as typeof fetch;
    for (const url of ['https://api.typesafe.ai', 'http://10.0.0.5:11434', 'http://example.com']) {
      const mind = new LocalMind(config({ url, fetchImpl }));
      await expect(mind.decide({ state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } }, AbortSignal.timeout(500))).rejects.toThrow(/loopback/);
      expect((await mind.health()).ok).toBe(false);
    }
    expect(fetched).toBe(0);
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8000')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8000')).toBe(true);
  });

  test('never follows a redirect from the local runtime (it could point off this machine)', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => { seen.push(init ?? {}); throw new TypeError('fetch failed'); }) as typeof fetch;
    for (const backend of ['ollama', 'systemone'] as const) {
      const mind = new LocalMind(config({ backend, fetchImpl }));
      await mind.decide({ state: 's', questions: { q: { type: 'noul', instructions: 'ok?' } } }, AbortSignal.timeout(500)).catch(() => {});
      await mind.health();
    }
    expect(seen.length).toBe(4);
    expect(seen.every((i) => i.redirect === 'error')).toBe(true);
  });

  test('health: ok with a latency when the model answers; not ok with a reason otherwise', async () => {
    const ollama = keep(await startMockOllama());
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const h = await (await fetch(`${bridge.url}/api/local-jev/health`)).json();
    expect(h).toMatchObject({ ok: true, model: 'decider-4b', backend: 'ollama' });
    expect(typeof h.latencyMs).toBe('number');
    const missing = keep(await startMockOllama({ model: 'other' }));
    const b2 = keep(await startBridge(config({ url: missing.url })));
    const h2 = await (await fetch(`${b2.url}/api/local-jev/health`)).json();
    expect(h2.ok).toBe(false);
    expect(h2.error).toContain('ollama pull');
    const b3 = keep(await startBridge(config({ url: 'http://127.0.0.1:9' })));
    expect((await (await fetch(`${b3.url}/api/local-jev/health`)).json()).ok).toBe(false);
  });
});

describe('bridge /api/local-jev (systemone passthrough backend)', () => {
  test('passes the body through with the local model name and returns the answers', async () => {
    const native = keep(await startMockSystemOne((qs) => Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0.25 } : { type: q.type, stub: true }]))));
    const bridge = keep(await startBridge(config({ backend: 'systemone', url: native.url, model: 'Mapika/decider-2b' })));
    const req = brainRequest();
    const { status, json } = await post(bridge.url, req);
    expect(status).toBe(200);
    expect(native.requests[0].model).toBe('Mapika/decider-2b');
    expect(native.requests[0].questions).toEqual(req.questions);
    expect(json.answers.opp_commit).toEqual({ type: 'noul', noul: 0.25 });
    expect(json.usage.input_tokens).toBe(321);
    const h = await (await fetch(`${bridge.url}/api/local-jev/health`)).json();
    expect(h).toMatchObject({ ok: true, model: 'decider-2b', backend: 'systemone' });
  });
});

describe('config', () => {
  test('defaults to Ollama on loopback with decider-4b; env overrides', () => {
    const d = configFromEnv({});
    expect(d).toMatchObject({ backend: 'ollama', url: 'http://127.0.0.1:11434', model: 'hf.co/Mapika/decider-4b-GGUF:Q4_K_M', timeoutMs: 3000, isolatedLevels: true });
    const s = configFromEnv({ LOCAL_JEV_BACKEND: 'systemone', LOCAL_JEV_URL: 'http://127.0.0.1:8009/', LOCAL_JEV_MODEL: 'jaredpalmer/kev-4b', LOCAL_JEV_TIMEOUT_MS: '5000', LOCAL_JEV_ISOLATED_LEVELS: '0' });
    expect(s).toMatchObject({ backend: 'systemone', url: 'http://127.0.0.1:8009', model: 'jaredpalmer/kev-4b', timeoutMs: 5000, isolatedLevels: false });
  });
});

describe('bridge latency', () => {
  test('added latency over calling the runtime directly', async () => {
    const ollama = keep(await startMockOllama());
    const bridge = keep(await startBridge(config({ url: ollama.url })));
    const body = { state: { a: 1 }, questions: { q: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null, c: null } } } };
    const gen = { model: 'hf.co/Mapika/decider-4b-GGUF:Q4_K_M', prompt: promptFor('{"a":1}', 'Which?', ['a', 'b', 'c']), raw: true, stream: false, logprobs: true, top_logprobs: 20, options: { num_predict: 1 } };
    const N = 60;
    const direct: number[] = [];
    const via: number[] = [];
    const inBridge: number[] = [];
    for (let i = 0; i < N + 5; i++) {
      let t0 = performance.now();
      await (await fetch(`${ollama.url}/api/generate`, { method: 'POST', body: JSON.stringify(gen) })).json();
      const d = performance.now() - t0;
      t0 = performance.now();
      const r = await post(bridge.url, body);
      const v = performance.now() - t0;
      if (i < 5) continue; // warm-up
      direct.push(d);
      via.push(v);
      inBridge.push(Number(r.headers.get('x-local-jev-bridge-ms')));
    }
    const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
    const line = `[bridge latency] n=${N} direct p50 ${p50(direct).toFixed(2)} ms · via bridge p50 ${p50(via).toFixed(2)} ms (p90 ${p90(via).toFixed(2)}) · added p50 ${(p50(via) - p50(direct)).toFixed(2)} ms · in-bridge work p50 ${p50(inBridge).toFixed(2)} ms`;
    if (process.env.LATENCY_REPORT) appendFileSync(process.env.LATENCY_REPORT, `${line}\n`);
    expect(p50(via) - p50(direct)).toBeLessThan(10);
  });
});
