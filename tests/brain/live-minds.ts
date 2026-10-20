// Does the LOCAL mind fight as hard as the House Mind? The same states (modern matchups, at the edge and
// in the pocket by the body's own ranges) go to the LOCAL model through the dev server's bridge
// (/api/local-jev), its answer through the brain's own policy (parseAnswers → decide, the path every
// model answer takes), and to the House Mind. Compared: the share of decisions that attack (a strike or
// a combination), the mode (commit / probe / guard) and the aggression the body gets.
// Not a test: run it by hand with the dev server up and the local model pulled. No cloud Jev calls.
// usage: npx tsx tests/brain/live-minds.ts [--states 10] [--log out.json]
import { writeFileSync } from 'node:fs';
import { houseMind } from '../../src/brain/house-mind';
import { askJev, JevError } from '../../src/brain/jev-client';
import { decide, parseAnswers } from '../../src/brain/policy';
import { buildQuestions } from '../../src/brain/questions';
import { rangeTable } from '../../src/brain/ranges';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { isStrike } from '../../src/brain/tactics';
import type { Tactic } from '../../src/core/protocol';
import { frame, scene } from './fixtures';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const BASE = process.env.BASE ?? 'http://localhost:5297';
const N = Math.min(20, Number(opt('states', '10')));
const LOG = opt('log', '');
const CLOCK = { round: 1, rounds: 3, remainingS: 120 };
const PAIRS: Array<[string, string]> = [['savate', 'haymaker'], ['firecracker', 'pylon'], ['savate', 'pylon'], ['haymaker', 'firecracker'], ['pylon', 'savate']];

const attacks = (t: Tactic) => t === 'combo' || isStrike(t);
const rows: Array<{ zone: string; pair: string; local: { tactic: Tactic; mode: string; aggression: number; confidence: number }; house: { tactic: Tactic; aggression: number } }> = [];
for (let k = 0; k < N; k++) {
  const [red, blue] = PAIRS[k % PAIRS.length];
  const zone = k < N / 2 ? 'edge' : 'pocket';
  const sc = scene(red, blue);
  const t = rangeTable(sc.red)!;
  const longest = Math.max(...[...t.byTactic.values()].filter((w) => sc.red.abilities.includes(w.tactic as never)).map((w) => w.edge));
  const gap = zone === 'edge' ? longest + t.step / 3 : longest - 0.04;
  const fc = makeFighterContext(0, sc.red, sc.blue, { design: red, skin: 'factory', plan: 'Fight smart: take what he gives you.', temperament: 1.2 });
  const s = readSituation(fc, { ...frame(sc, 20 + k, gap, { red: { openings: [], stance: 'orthodox' }, blue: { stance: 'orthodox' } }), tick: 30000 + 131 * k });
  const qs = buildQuestions(fc, s.opp, { range: s.range });
  const state = serializeState(fc, s, [], CLOCK, null);
  try {
    const res = await askJev(state, qs.questions, AbortSignal.timeout(20_000), { endpoint: `${BASE}/api/local-jev` });
    const parsed = parseAnswers(res, qs);
    const d = decide({ parsed, situation: s, current: null, temperature: 1.2, seed: 7, corner: 0, tick: s.tick });
    const h = houseMind(fc, s, 7);
    rows.push({ zone, pair: `${red} v ${blue}`, local: { tactic: d.tactic, mode: d.mode, aggression: d.aggression, confidence: parsed.tacticConfidence }, house: { tactic: h.tactic, aggression: h.aggression } });
    console.log(`${zone} ${red} v ${blue} gap ${gap.toFixed(2)}: LOCAL ${d.tactic} (${d.mode}, conf ${parsed.tacticConfidence.toFixed(2)}, aggr ${d.aggression.toFixed(2)}) ${Math.round(res.latencyMs)} ms | HOUSE ${h.tactic} (aggr ${h.aggression.toFixed(2)})`);
  } catch (e) {
    console.log(`call ${k + 1} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
    break;
  }
}
const share = (xs: boolean[]) => `${xs.filter(Boolean).length}/${xs.length}`;
const mean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(2);
console.log(`LOCAL attacks ${share(rows.map((r) => attacks(r.local.tactic)))}, modes ${JSON.stringify(rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.local.mode]: (m[r.local.mode] ?? 0) + 1 }), {}))}, mean aggression ${mean(rows.map((r) => r.local.aggression))}`);
console.log(`HOUSE attacks ${share(rows.map((r) => attacks(r.house.tactic)))}, mean aggression ${mean(rows.map((r) => r.house.aggression))}`);
if (LOG) writeFileSync(LOG, JSON.stringify(rows, null, 2));
