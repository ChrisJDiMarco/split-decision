// Live check of the brain request shape against /api/jev via the dev server (npx tsx tests/brain/live-jev.ts).
// At most 10 calls; stops at the first failure (503 = Keychain prompt not yet approved).
import { askJev, JevError } from '../../src/brain/jev-client';
import { buildQuestions } from '../../src/brain/questions';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { frame, RED_SETUP, scene } from './fixtures';

const ENDPOINT = 'http://localhost:5297/api/jev';
const MAX_CALLS = Number(process.env.MAX_CALLS ?? 9);

const sc = scene('bruiser', 'striker');
const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
const variants = [
  { d: 1.0, blue: { windup: 0.5, skill: 'low_kick' } },
  { d: 1.6, blue: { velocity: [-1.2, 0, 0] as [number, number, number] } },
  { d: 0.9, blue: { upright: 0.6, balance: 0.2 } },
  { d: 2.6, blue: {} },
  { d: 1.0, blue: { down: true, skill: 'getup' } },
];
const latencies: number[] = [];
for (let i = 0; i < MAX_CALLS; i++) {
  const v = variants[i % variants.length];
  const f = frame(sc, 40 + i, v.d, { blue: v.blue });
  const me = f.telemetry[0];
  me.joints = me.joints.map((j) => (j.name === 'knee_l' ? { ...j, health: 0.55, state: 'degraded' } : j));
  me.parts = me.parts.map((p) => (p.id === 'head' ? { ...p, hp: 0.5 } : p));
  const s = readSituation(fc, f);
  const state = serializeState(fc, s, [{ action: 'low_kick', time: 38 + i }], { round: 2, rounds: 3, remainingS: 100 }, 'jab');
  const qs = buildQuestions(fc, s.opp);
  try {
    const res = await askJev(state, qs.questions, AbortSignal.timeout(10_000), { endpoint: ENDPOINT });
    latencies.push(res.latencyMs);
    const t = res.answers.tactic;
    const top = t?.type === 'choice' ? Object.entries(t.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ') : '?';
    const oc = res.answers.opp_commit;
    const ag = res.answers.aggression;
    const tg = res.answers.target;
    const ct = res.answers.counter_if_lunge;
    console.log(`#${i + 1} d=${v.d} ${s.band}/${s.oppPhase}: ${res.latencyMs.toFixed(0)} ms, ${res.inputTokens} in-tok | tactic [${top}] conf ${t?.type === 'choice' ? t.confidence.toFixed(2) : '?'} | target ${tg?.type === 'choice' ? tg.choice : '?'} | opp_commit ${oc?.type === 'noul' ? oc.noul.toFixed(2) : '?'} | counter ${ct?.type === 'choice' ? ct.choice : '?'} | aggression ${ag?.type === 'score' ? ag.score.toFixed(2) : '?'}`);
    if (i === 0) console.log('STATE', JSON.stringify(state));
  } catch (e) {
    console.log(`call ${i + 1} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
    break;
  }
}
if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b);
  console.log(`n=${s.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)} ms min=${s[0].toFixed(0)} max=${s[s.length - 1].toFixed(0)}`);
}
