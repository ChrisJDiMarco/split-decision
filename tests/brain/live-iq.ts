// Live check of fighter IQ against /api/jev via the dev server (npx tsx tests/brain/live-iq.ts):
// realistic weak-spot, habit and read states, the full question set with setup → payoff combos in
// the combo question. At most 6 calls; stops at the first failure.
import { askJev, JevError } from '../../src/brain/jev-client';
import { readyCombos } from '../../src/brain/limbs';
import { buildQuestions } from '../../src/brain/questions';
import { serializeState } from '../../src/brain/serializer';
import { setupCombos } from '../../src/brain/setups';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { designCombos } from '../../src/brain/style';
import type { Habit, RobotTelemetry, WeakSpot } from '../../src/core/protocol';
import { frame, scene } from './fixtures';

const ENDPOINT = 'http://localhost:5297/api/jev';
const MAX_CALLS = Math.min(6, Number(process.env.MAX_CALLS ?? 6));
const RISK = { tornado_kick: 0.55, spinning_back_kick: 0.3, jump_kick: 0.42, jumping_knee: 0.3, superman_punch: 0.22, spinning_backfist: 0.1, kip_up: 0.35 };
const KNEE: WeakSpot = { zone: 'left_leg', score: 0.62, reasons: [{ kind: 'joint_failing', part: 'knee_l', value: 0.4 }, { kind: 'narrow_base', value: 4.9 }, { kind: 'lead_leg' }] };
const JAW: WeakSpot = { zone: 'head', score: 0.55, reasons: [{ kind: 'glass_jaw', value: 0.84 }, { kind: 'armor_cracked', part: 'head', value: 0.5 }] };
const OPEN_R: WeakSpot = { zone: 'head', score: 0.41, side: 'right', reasons: [{ kind: 'guard_open', side: 'right' }] };
const BODY: WeakSpot = { zone: 'torso', score: 0.3, reasons: [{ kind: 'narrow_base', value: 4.9 }, { kind: 'gyro_drained', value: 0.4 }] };
const BITES_HIGH: Habit[] = [{ kind: 'bites', level: 'high', n: 3, of: 4 }, { kind: 'circles', side: 'left', n: 3, of: 4 }];
const NO_BITE_HIGH: Habit[] = [{ kind: 'bites', level: 'high', n: 0, of: 4 }, { kind: 'bites', level: 'low', n: 3, of: 3 }];
const DROPS: Habit[] = [{ kind: 'drops_hand', side: 'right', after: 'cross', n: 3, of: 4 }, { kind: 'counters', n: 3, of: 4 }];

const cases: Array<{ name: string; red: string; blue: string; tel: Partial<RobotTelemetry> }> = [
  { name: 'SAVATE v PYLON: knee 40%, he bites high', red: 'savate', blue: 'pylon', tel: { weakSpots: [KNEE, BODY], habits: BITES_HIGH } },
  { name: 'SAVATE v PYLON: knee 40%, never bites high, bites low', red: 'savate', blue: 'pylon', tel: { weakSpots: [KNEE, BODY], habits: NO_BITE_HIGH } },
  { name: 'HAYMAKER v PYLON: glass jaw + cracked head', red: 'haymaker', blue: 'pylon', tel: { weakSpots: [JAW, KNEE], habits: BITES_HIGH } },
  { name: 'FIRECRACKER v HAYMAKER: he counters feints, drops right hand', red: 'firecracker', blue: 'haymaker', tel: { weakSpots: [OPEN_R], habits: DROPS } },
  { name: 'PYLON v SAVATE: just read a bite (covered high)', red: 'pylon', blue: 'savate', tel: { weakSpots: [KNEE], habits: BITES_HIGH, reads: [{ seq: 5, time: 39.6, level: 'high', limb: 'arm', skill: 'jab', deliberate: true, bit: true, reactions: ['covered'] }] } },
  { name: 'SAVATE v HAYMAKER: nothing learned yet', red: 'savate', blue: 'haymaker', tel: {} },
];

const latencies: number[] = [];
for (let i = 0; i < Math.min(MAX_CALLS, cases.length); i++) {
  const c = cases[i];
  const sc = scene(c.red, c.blue);
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: c.red, skin: 'factory', temperament: 1.1, plan: 'Find what he bites on, set him up, and hit what opens.' });
  const f = frame(sc, 40, 1.0, { red: { openings: [], moveRisk: { ...RISK }, stance: 'orthodox', facingOffDeg: -10, ...c.tel } });
  const s = readSituation(fc, f);
  const state = serializeState(fc, s, [{ action: 'jab', time: 38.5 }], { round: 2, rounds: 3, remainingS: 95 }, 'jab');
  const setups = setupCombos(fc.design, s.me, s.opp);
  const qs = buildQuestions(fc, s.opp, { combos: readyCombos(s.me, designCombos(fc.design)), setups });
  try {
    const res = await askJev(state, qs.questions, AbortSignal.timeout(10_000), { endpoint: ENDPOINT });
    latencies.push(res.latencyMs);
    const top = (id: string, n = 3) => {
      const a = res.answers[id];
      return a?.type === 'choice' ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ') : '?';
    };
    console.log(`#${i + 1} ${c.name}: ${res.latencyMs.toFixed(0)} ms, ${res.inputTokens} in-tok`);
    console.log(`   setups offered: ${setups.map((x) => x.id).join(', ')}`);
    console.log(`   combo [${top('combo')}]`);
    console.log(`   tactic [${top('tactic')}] | target [${top('target', 2)}]`);
    if (i === 0) console.log('   STATE.opponent', JSON.stringify(state.opponent));
  } catch (e) {
    console.log(`call ${i + 1} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
    break;
  }
}
if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b);
  console.log(`n=${s.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)} ms min=${s[0].toFixed(0)} max=${s[s.length - 1].toFixed(0)}`);
}
