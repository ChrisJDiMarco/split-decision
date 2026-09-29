// Live check of the fighter-intelligence questions against /api/jev via the dev server
// (npx tsx tests/brain/live-openings.ts). At most 6 calls; stops at the first failure.
// Risks are the values the openings system measured on fresh robots in tests/openings.
import type { Opening, RobotTelemetry } from '../../src/core/protocol';
import { openingMenu } from '../../src/brain/gambles';
import { askJev, JevError } from '../../src/brain/jev-client';
import { getupQuestion, buildQuestions } from '../../src/brain/questions';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { designCombos } from '../../src/brain/style';
import { TACTIC_INFO } from '../../src/brain/tactics';
import { frame, scene } from './fixtures';

const ENDPOINT = 'http://localhost:5297/api/jev';
const RISK: Record<string, Record<string, number>> = {
  savate: { tornado_kick: 0.64, spinning_back_kick: 0.33, jump_kick: 0.5, jumping_knee: 0.35, superman_punch: 0.26, spinning_backfist: 0.12, kip_up: 0.58 },
  pylon: { tornado_kick: 0.62, spinning_back_kick: 0.34, jump_kick: 0.49, jumping_knee: 0.35, superman_punch: 0.26, spinning_backfist: 0.13, kip_up: 0.57 },
  firecracker: { tornado_kick: 0.36, spinning_back_kick: 0.25, jump_kick: 0.22, jumping_knee: 0.18, superman_punch: 0.16, spinning_backfist: 0.1, kip_up: 0.29 },
  haymaker: { tornado_kick: 0.79, spinning_back_kick: 0.36, jump_kick: 0.62, jumping_knee: 0.42, superman_punch: 0.3, spinning_backfist: 0.12, kip_up: 0.75 },
};
interface Case { red: string; blue: string; d: number; openings: Opening[]; blue_tel?: Partial<RobotTelemetry>; temperament: number; record?: { yours: string; his: string }; down?: boolean }
const cases: Case[] = [
  { red: 'savate', blue: 'haymaker', d: 1.0, openings: ['turned_away'], temperament: 1.2, blue_tel: { heading: 0, skill: 'stance' } },
  { red: 'savate', blue: 'haymaker', d: 0.95, openings: ['missed_recovering', 'low_guard'], temperament: 1.0, blue_tel: { skill: 'hook', skillPhase: 0.8 } },
  { red: 'pylon', blue: 'firecracker', d: 1.2, openings: ['on_cage', 'gyro_saturated'], temperament: 1.4 },
  { red: 'firecracker', blue: 'haymaker', d: 0.8, openings: ['weak_left_leg', 'off_balance'], temperament: 1.6, record: { yours: 'your superman punches: 1 of 2 landed', his: 'his hooks keep landing' } },
  { red: 'haymaker', blue: 'savate', d: 0.9, openings: ['stunned'], temperament: 0.8 },
  { red: 'firecracker', blue: 'haymaker', d: 1.5, openings: [], temperament: 1.2, down: true },
];
cases.splice(Number(process.env.SKIP ?? 4), Number(process.env.SKIP_N ?? 1)); // the reachability probe used one of the 6 calls
const lat: number[] = [];
for (const [n, c] of cases.entries()) {
  const sc = scene(c.red, c.blue);
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: c.red, skin: 'livery', plan: 'Stay patient, punish mistakes, go for the finish when he is hurt.', temperament: c.temperament });
  const blueJoints = sc.blue.parts.flatMap((p) => (p.joints ?? []).map((j) => ({ name: j.name, health: j.name === 'knee_l' && c.openings.includes('weak_left_leg') ? 0.3 : 1, state: (j.name === 'knee_l' && c.openings.includes('weak_left_leg') ? 'degraded' : 'ok') as 'ok' | 'degraded', tempC: 40, torqueFrac: 0.2 })));
  const f = frame(sc, 60 + n * 5, c.d, {
    red: { openings: c.openings, moveRisk: RISK[c.red], stance: 'orthodox', facingOffDeg: -11, ...(c.down ? { down: true, upright: 0.15, balance: 0 } : {}) },
    blue: { joints: blueJoints, ...(c.blue_tel ?? {}) },
  });
  const s = readSituation(fc, f);
  const state = serializeState(fc, s, [{ action: 'hook', time: 58 + n * 5 }], { round: 2, rounds: 3, remainingS: 95 }, 'jab', c.record ?? null);
  const questions = c.down
    ? { getup_style: getupQuestion(RISK[c.red].kip_up) }
    : buildQuestions(fc, s.opp, { menu: openingMenu(fc.design, s.me, c.openings, (t) => TACTIC_INFO[t].description, false), combos: designCombos(fc.design) }).questions;
  try {
    const res = await askJev(state, questions, AbortSignal.timeout(10_000), { endpoint: ENDPOINT });
    lat.push(res.latencyMs);
    const top = (id: string) => {
      const a = res.answers[id];
      if (!a) return '-';
      if (a.type === 'noul') return `P(yes)=${a.noul.toFixed(2)}`;
      return Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ');
    };
    console.log(`#${n + 1} ${c.red} vs ${c.blue} [${c.openings.join(', ') || (c.down ? 'DOWN' : '-')}] T=${c.temperament}: ${res.latencyMs.toFixed(0)} ms, ${res.inputTokens} in-tok`);
    if (c.down) console.log(`   getup_style ${top('getup_style')}`);
    else {
      console.log(`   opening_move [${top('opening_move')}]`);
      console.log(`   tactic [${top('tactic')}] | combo [${top('combo')}]`);
    }
    if (n === 0) console.log('   STATE.you', JSON.stringify(state.you), '\n   STATE.opponent', JSON.stringify(state.opponent));
  } catch (e) {
    console.log(`call ${n + 1} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
    break;
  }
}
if (lat.length) {
  const s = [...lat].sort((a, b) => a - b);
  console.log(`n=${s.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)} ms min=${s[0].toFixed(0)} max=${s[s.length - 1].toFixed(0)}`);
}
