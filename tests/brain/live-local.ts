// Live check of the LOCAL mind through the dev server (npx tsx tests/brain/live-local.ts), once a
// local model is pulled. Prints the health, per-decision latency, and, with COMPARE=1, how often the
// local model's top tactic/target/counter matches cloud Jev on the same states (uses up to
// MAX_CALLS Jev calls). Stops at the first failure.
import { askJev, JevError, type JevResult } from '../../src/brain/jev-client';
import { buildQuestions } from '../../src/brain/questions';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { frame, RED_SETUP, scene } from './fixtures';

const BASE = process.env.BASE ?? 'http://localhost:5297';
const MAX_CALLS = Number(process.env.MAX_CALLS ?? 10);
const COMPARE = process.env.COMPARE === '1';

const health = await (await fetch(`${BASE}/api/local-jev/health`)).json();
console.log('health', JSON.stringify(health));
if (!health.ok) process.exit(1);

const sc = scene('bruiser', 'striker');
const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
const variants = [
  { d: 1.0, blue: { windup: 0.5, skill: 'low_kick' } },
  { d: 1.6, blue: { velocity: [-1.2, 0, 0] as [number, number, number] } },
  { d: 0.9, blue: { upright: 0.6, balance: 0.2 } },
  { d: 2.6, blue: {} },
  { d: 1.0, blue: { down: true, skill: 'getup' } },
];
const top = (r: JevResult, id: string) => { const a = r.answers[id]; return a?.type === 'choice' ? a.choice : null; };
const latencies: number[] = [];
const agree = { tactic: 0, target: 0, counter_if_lunge: 0, n: 0 };
for (let i = 0; i < MAX_CALLS; i++) {
  const v = variants[i % variants.length];
  const s = readSituation(fc, frame(sc, 40 + i, v.d, { blue: v.blue }));
  const state = serializeState(fc, s, [{ action: 'low_kick', time: 38 + i }], { round: 2, rounds: 3, remainingS: 100 }, 'jab');
  const qs = buildQuestions(fc, s.opp);
  try {
    const local = await askJev(state, qs.questions, AbortSignal.timeout(15_000), { endpoint: `${BASE}/api/local-jev` });
    latencies.push(local.latencyMs);
    let cmp = '';
    if (COMPARE) {
      const jev = await askJev(state, qs.questions, AbortSignal.timeout(10_000), { endpoint: `${BASE}/api/jev` });
      agree.n++;
      for (const id of ['tactic', 'target', 'counter_if_lunge'] as const) if (top(local, id) === top(jev, id)) agree[id]++;
      cmp = ` | jev tactic ${top(jev, 'tactic')}`;
    }
    console.log(`#${i + 1} ${s.band}/${s.oppPhase}: ${local.latencyMs.toFixed(0)} ms | local tactic ${top(local, 'tactic')} target ${top(local, 'target')}${cmp}`);
  } catch (e) {
    console.log(`call ${i + 1} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
    break;
  }
}
if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b);
  console.log(`local n=${s.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)} ms p90=${s[Math.floor(s.length * 0.9)].toFixed(0)} ms max=${s[s.length - 1].toFixed(0)} ms`);
}
if (agree.n) console.log(`agreement with Jev over ${agree.n}: tactic ${agree.tactic}, target ${agree.target}, counter ${agree.counter_if_lunge}`);
