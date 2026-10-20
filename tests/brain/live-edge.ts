// Ring IQ, the edge: a small live Jev A/B on the wording of a weapon one step out. From the edge
// (none of my weapons lands, some land after one step) Jev mostly closed or held on 'needs a step in'.
// Each state is serialized twice, A 'needs a step in' and B 'lands with a step in' (RANGE_WORDING,
// src/brain/ranges.ts: the from_here line and the tactic options), and Jev is asked the same questions.
//   step-in strike   the top choice is a strike that lands after one step (the body throws it off the step)
//   misfit           the top choice is a strike that is too far, too close or out of action
//   close / hold     the top choice is footwork or defence (close_distance, hold_range, guard ...)
//   step mass        probability on strikes (and the combo) that land with a step
// States: modern matchups at gaps where the fighter's weapons are one step out, by the body's own
// ranges (fixtures, not a fight dump), with the opponent standing, advancing or winding up.
// Not a test: run it by hand against the dev server (npm run dev). At most MAX_CALLS requests, logged.
// usage: npx tsx tests/brain/live-edge.ts [--states 10] [--log out.json]
import { writeFileSync } from 'node:fs';
import { askJev, JevError, type JevChoiceAnswer } from '../../src/brain/jev-client';
import { buildQuestions } from '../../src/brain/questions';
import { RANGE_WORDING, rangeTable, weaponFit } from '../../src/brain/ranges';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation, type FighterContext, type Situation } from '../../src/brain/situation';
import { isStrike } from '../../src/brain/tactics';
import type { RobotTelemetry, Tactic } from '../../src/core/protocol';
import type { Corner } from '../../src/core/types';
import { frame, scene } from './fixtures';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const ENDPOINT = process.env.JEV_ENDPOINT ?? 'http://localhost:5297/api/jev';
const MAX_CALLS = 20;
const N_STATES = Math.min(Number(opt('states', '10')), MAX_CALLS / 2);
const LOG = opt('log', '');
const DRY = args.includes('--dry'); // list the states and both wordings, no requests
const CLOCK = { round: 1, rounds: 3, remainingS: 120 };
const PLAN = 'Fight smart: take what he gives you.';
const PAIRS: Array<[string, string]> = [['savate', 'haymaker'], ['firecracker', 'pylon'], ['savate', 'pylon'], ['haymaker', 'firecracker'], ['pylon', 'savate']];
const OPP: Array<{ what: string; blue: Partial<RobotTelemetry> }> = [
  { what: 'standing', blue: {} },
  { what: 'advancing', blue: { velocity: [-0.6, 0, 0] } },
  { what: 'winding up', blue: { windup: 0.3, skill: 'jab' } },
];

type Kind = 'step-in strike' | 'misfit' | 'combo' | 'close' | 'hold/defend';

/** An edge gap for red: no weapon of his lands, his longest lands after one step (a third of the way into the step band). */
function edgeGap(red: string): number | null {
  const sc = scene(red, red);
  const t = rangeTable(sc.red);
  if (!t) return null;
  const longest = Math.max(...[...t.byTactic.values()].filter((w) => sc.red.abilities.includes(w.tactic as never)).map((w) => w.edge));
  return longest + t.step / 3;
}

interface State { red: string; blue: string; gap: number; opp: string; fc: FighterContext; s: Situation }

function states(): State[] {
  const out: State[] = [];
  for (let k = 0; out.length < N_STATES && k < 40; k++) {
    const [red, blue] = PAIRS[k % PAIRS.length];
    const opp = OPP[Math.floor(k / PAIRS.length) % OPP.length];
    const gap = edgeGap(red);
    if (gap === null) continue;
    const sc = scene(red, blue);
    const fc = makeFighterContext(0 as Corner, sc.red, sc.blue, { design: red, skin: 'factory', plan: PLAN, temperament: 1.2 });
    const s = readSituation(fc, { ...frame(sc, 20 + k, gap, { red: { openings: [], stance: 'orthodox' }, blue: { stance: 'orthodox', ...opp.blue } }), tick: 20000 + k * 97 });
    const fits = s.range?.mine ?? [];
    if (!fits.some((w) => w.fit === 'step') || fits.some((w) => w.fit === 'lands')) continue;
    out.push({ red, blue, gap, opp: opp.what, fc, s });
  }
  return out;
}

function kindOf(fc: FighterContext, s: Situation, t: Tactic): Kind {
  if (t === 'combo') return 'combo';
  if (isStrike(t)) return weaponFit(fc.design, s.range, t) === 'step' ? 'step-in strike' : 'misfit';
  return t === 'close_distance' ? 'close' : 'hold/defend';
}

function stepMass(fc: FighterContext, s: Situation, a: JevChoiceAnswer): number {
  let m = 0;
  for (const [t, p] of Object.entries(a.probabilities)) if (t === 'combo' || (isStrike(t as Tactic) && weaponFit(fc.design, s.range, t as Tactic) === 'step')) m += p;
  return m;
}

const picked = states();
const tally: Record<'A' | 'B', { n: number; kinds: Record<string, number>; stepMass: number }> = {
  A: { n: 0, kinds: {}, stepMass: 0 },
  B: { n: 0, kinds: {}, stepMass: 0 },
};
const log: unknown[] = [];
let calls = 0;
outer: for (const st of picked) {
  for (const variant of ['A', 'B'] as const) {
    if (calls >= MAX_CALLS) break outer;
    RANGE_WORDING.step = variant === 'A' ? 'needs' : 'lands';
    const state = serializeState(st.fc, st.s, [], CLOCK, null);
    const qs = buildQuestions(st.fc, st.s.opp, { range: st.s.range });
    if (DRY) {
      const q = qs.questions.tactic;
      const opts = q.type === 'choice' ? Object.entries(q.criteria).filter(([, c]) => /step in/.test(c ?? '')).map(([k, c]) => `${k}: ${c}`).join(' | ') : '';
      console.log(`${variant} ${st.red} v ${st.blue} gap ${st.gap.toFixed(2)} (${st.opp}): distance ${state.geometry.distance}; from_here ${state.geometry.from_here}; ${opts}`);
      continue;
    }
    calls++;
    try {
      const res = await askJev(state, qs.questions, AbortSignal.timeout(10_000), { endpoint: ENDPOINT });
      const a = res.answers.tactic;
      if (a?.type !== 'choice') throw new Error('no tactic answer');
      const top = a.choice as Tactic;
      const kind = kindOf(st.fc, st.s, top);
      const mass = stepMass(st.fc, st.s, a);
      const t = tally[variant];
      t.n++;
      t.kinds[kind] = (t.kinds[kind] ?? 0) + 1;
      t.stepMass += mass;
      const best = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ');
      console.log(`#${calls} ${variant} ${st.red} v ${st.blue} gap ${st.gap.toFixed(2)} m, he is ${st.opp}: [${best}] → ${kind} | step mass ${mass.toFixed(2)} | ${res.inputTokens} in-tok`);
      log.push({ variant, red: st.red, blue: st.blue, gap: Number(st.gap.toFixed(3)), opp: st.opp, from_here: state.geometry.from_here, tactic: a, kind, stepMass: mass, inputTokens: res.inputTokens, latencyMs: Math.round(res.latencyMs) });
    } catch (e) {
      console.log(`call ${calls} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
      break outer;
    }
  }
}
RANGE_WORDING.step = 'lands';
const summary = Object.fromEntries((['A', 'B'] as const).map((v) => [v, { n: tally[v].n, kinds: tally[v].kinds, meanStepMass: Number((tally[v].stepMass / Math.max(1, tally[v].n)).toFixed(3)) }]));
console.log(`calls ${calls}`);
console.log('A needs a step in    ', JSON.stringify(summary.A));
console.log('B lands with a step in', JSON.stringify(summary.B));
if (LOG) writeFileSync(LOG, JSON.stringify({ calls, summary, log }, null, 2));
