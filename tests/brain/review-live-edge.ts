// Review probe (not a test): the 'lands with a step in' wording (RANGE_WORDING 'lands') in the states the
// builder's A/B (live-edge.ts) did not ask: at the edge with him WINDING UP (does Jev step into his blow?),
// and a MIXED gap (the jab lands, longer weapons one step out: does Jev take a step-in kick over the punch
// that lands?). One request per state, B wording only. At most 10 requests.
// usage: npx tsx tests/brain/review-live-edge.ts [--log out.json] [--dry]
import { writeFileSync } from 'node:fs';
import { askJev, JevError } from '../../src/brain/jev-client';
import { buildQuestions } from '../../src/brain/questions';
import { RANGE_WORDING, rangeTable, weaponFit } from '../../src/brain/ranges';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation } from '../../src/brain/situation';
import { isStrike } from '../../src/brain/tactics';
import type { Tactic } from '../../src/core/protocol';
import type { Corner } from '../../src/core/types';
import { frame, scene } from './fixtures';

const args = process.argv.slice(2);
const LOG = args.includes('--log') ? args[args.indexOf('--log') + 1] : '';
const DRY = args.includes('--dry');
const ENDPOINT = process.env.JEV_ENDPOINT ?? 'http://localhost:5297/api/jev';
const MAX_CALLS = 10;
const CLOCK = { round: 1, rounds: 3, remainingS: 120 };
const PLAN = 'Fight smart: take what he gives you.';
const PAIRS: Array<[string, string]> = [['savate', 'haymaker'], ['firecracker', 'pylon'], ['savate', 'pylon'], ['haymaker', 'firecracker'], ['pylon', 'savate']];
const KICKS = new Set(['low_kick', 'front_kick', 'head_kick', 'tornado_kick', 'spinning_back_kick']);
RANGE_WORDING.step = 'lands';

interface St { what: string; red: string; blue: string; gap: number; windup: boolean }
const states: St[] = [];
for (const [red, blue] of PAIRS) {
  const t = rangeTable(scene(red, red).red)!;
  const own = [...t.byTactic.values()].filter((w) => scene(red, blue).red.abilities.includes(w.tactic as never));
  const longest = Math.max(...own.map((w) => w.edge));
  states.push({ what: 'edge, he winds up', red, blue, gap: longest + t.step / 3, windup: true });
  // Mixed: just inside the jab's edge (it lands), the rest a step out if possible.
  const jab = own.find((w) => w.tactic === 'jab');
  if (jab) states.push({ what: 'mixed: jab lands', red, blue, gap: jab.edge - 0.01, windup: false });
}

const log: unknown[] = [];
let calls = 0;
const tally: Record<string, Record<string, number>> = {};
for (const st of states) {
  if (calls >= MAX_CALLS) break;
  const sc = scene(st.red, st.blue);
  const fc = makeFighterContext(0 as Corner, sc.red, sc.blue, { design: st.red, skin: 'factory', plan: PLAN, temperament: 1.2 });
  const s = readSituation(fc, { ...frame(sc, 20 + calls, st.gap, { red: { openings: [], stance: 'orthodox' }, blue: { stance: 'orthodox', ...(st.windup ? { windup: 0.3, skill: 'jab' } : {}) } }), tick: 30000 + calls * 97 });
  const fits = (s.range?.mine ?? []).map((w) => `${w.tactic}:${w.fit}`).join(' ');
  const state = serializeState(fc, s, [], CLOCK, null);
  const qs = buildQuestions(fc, s.opp, { range: s.range });
  if (DRY) { console.log(`${st.what} ${st.red} v ${st.blue} gap ${st.gap.toFixed(2)} | ${fits} | from_here ${state.geometry.from_here} | opp ${s.oppPhase}`); continue; }
  calls++;
  try {
    const res = await askJev(state, qs.questions, AbortSignal.timeout(15_000), { endpoint: ENDPOINT });
    const a = res.answers.tactic;
    if (a?.type !== 'choice') throw new Error('no tactic answer');
    const top = a.choice as Tactic;
    const fit = isStrike(top) ? weaponFit(fc.design, s.range, top) : null;
    const kind = top === 'combo' ? 'combo' : !isStrike(top) ? (top === 'close_distance' ? 'close' : 'hold/defend') : fit === 'lands' ? 'strike that lands' : fit === 'step' ? (KICKS.has(top) ? 'step-in kick' : 'step-in punch') : 'misfit';
    (tally[st.what] ??= {})[kind] = (tally[st.what][kind] ?? 0) + 1;
    const best = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ');
    console.log(`#${calls} ${st.what} ${st.red} v ${st.blue} gap ${st.gap.toFixed(2)} | ${fits} | [${best}] → ${kind}`);
    log.push({ ...st, fits, from_here: state.geometry.from_here, tactic: a, kind, latencyMs: Math.round(res.latencyMs) });
  } catch (e) {
    console.log(`call ${calls} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
    break;
  }
}
console.log(`calls ${calls}`, JSON.stringify(tally));
if (LOG) writeFileSync(LOG, JSON.stringify({ calls, tally, log }, null, 2));
