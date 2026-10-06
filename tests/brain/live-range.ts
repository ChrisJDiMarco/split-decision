// Ring IQ, mind side: a small live Jev A/B on frozen fight states (dumped by measure-range.ts --dump).
// Each state is serialized twice, old (no range facts: the reach band, plain tactic options) and new
// (from_here, his_weapons, reach edge, meeting time, options annotated by range), and Jev is asked the
// same questions. Compared: does the chosen tactic fit the gap (by the body's own skill ranges)?
//   fit mass     probability Jev puts on strikes that land from here or one step in
//   misfit mass  ... on strikes that are too close, too far or out of action
//   top          the chosen tactic: a strike that fits, a strike that does not, or footwork/defence
// Not a test: run it by hand against the dev server (npm run dev). At most MAX_CALLS requests, logged.
// usage: npx tsx tests/brain/live-range.ts states.json [--states 12] [--log out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { askJev, JevError, type JevChoiceAnswer } from '../../src/brain/jev-client';
import { buildQuestions } from '../../src/brain/questions';
import { RANGE_FACTS, weaponFit, type StrikeFit } from '../../src/brain/ranges';
import { serializeState } from '../../src/brain/serializer';
import { makeFighterContext, readSituation, type FighterContext, type Situation } from '../../src/brain/situation';
import { isStrike } from '../../src/brain/tactics';
import type { RobotTelemetry, Tactic } from '../../src/core/protocol';
import type { Corner } from '../../src/core/types';
import { DESIGNS } from '../../src/robots/designs';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const ENDPOINT = process.env.JEV_ENDPOINT ?? 'http://localhost:5297/api/jev';
const MAX_CALLS = 24;
const N_STATES = Math.min(Number(opt('states', '12')), MAX_CALLS / 2);
const LOG = opt('log', '');
const CLOCK = { round: 1, rounds: 3, remainingS: 120 };
const PLAN = 'Fight smart: take what he gives you.';

interface Dump { red: string; blue: string; seed: number; time: number; tick: number; gap: number; telemetry: [RobotTelemetry, RobotTelemetry] }
type Zone = 'pocket' | 'edge' | 'outside';

function contextOf(d: Dump, corner: Corner): FighterContext {
  const mine = corner === 0 ? d.red : d.blue, his = corner === 0 ? d.blue : d.red;
  return makeFighterContext(corner, DESIGNS[mine], DESIGNS[his], { design: mine, skin: 'factory', plan: PLAN, temperament: 1.2 });
}

function situation(fc: FighterContext, d: Dump, facts: boolean): Situation {
  RANGE_FACTS.enabled = facts;
  try {
    return readSituation(fc, { tick: d.tick, time: d.time, events: [], telemetry: d.telemetry });
  } finally {
    RANGE_FACTS.enabled = true;
  }
}

/** Where this fighter stands by its own weapons: something lands, one step in, or nothing reaches. */
function zoneOf(s: Situation): Zone | null {
  const mine = s.range?.mine ?? [];
  if (!mine.length) return null;
  if (mine.some((w) => w.fit === 'lands')) return 'pocket';
  if (mine.some((w) => w.fit === 'step')) return 'edge';
  return mine.every((w) => w.fit === 'far') ? 'outside' : null;
}

/** N states, a third per zone, alternating corners and spread over the matchups. */
function pick(dumps: Dump[]): Array<{ d: Dump; corner: Corner; zone: Zone }> {
  const byZone: Record<Zone, Array<{ d: Dump; corner: Corner; zone: Zone }>> = { pocket: [], edge: [], outside: [] };
  dumps.forEach((d, i) => {
    const corner = (i % 2) as Corner;
    const zone = zoneOf(situation(contextOf(d, corner), d, true));
    if (zone) byZone[zone].push({ d, corner, zone });
  });
  const out: Array<{ d: Dump; corner: Corner; zone: Zone }> = [];
  const zones: Zone[] = ['pocket', 'edge', 'outside'];
  for (let k = 0; out.length < N_STATES && zones.some((z) => byZone[z].length); k++) {
    const z = zones[k % 3];
    const pool = byZone[z];
    if (!pool.length) continue;
    // Spread: take from the matchup seen least so far.
    const seen = (m: string) => out.filter((o) => `${o.d.red}:${o.d.blue}` === m).length;
    pool.sort((a, b) => seen(`${a.d.red}:${a.d.blue}`) - seen(`${b.d.red}:${b.d.blue}`));
    out.push(pool.shift()!);
  }
  return out;
}

interface Score { top: Tactic; topFit: StrikeFit | null; fitMass: number; misfitMass: number; strikeMass: number }

function score(fc: FighterContext, truth: Situation, a: JevChoiceAnswer): Score {
  let fitMass = 0, misfitMass = 0, strikeMass = 0;
  for (const [t, p] of Object.entries(a.probabilities)) {
    if (t === 'combo' || !isStrike(t as Tactic)) continue;
    const f = weaponFit(fc.design, truth.range, t as Tactic);
    if (f === null) continue;
    strikeMass += p;
    if (f === 'lands' || f === 'step') fitMass += p;
    else misfitMass += p;
  }
  const top = a.choice as Tactic;
  return { top, topFit: isStrike(top) && top !== 'combo' ? weaponFit(fc.design, truth.range, top) : null, fitMass, misfitMass, strikeMass };
}

const dumps = JSON.parse(readFileSync(args[0], 'utf8')) as Dump[];
const chosen = pick(dumps);
const log: unknown[] = [];
const tally = { old: [] as Array<Score & { zone: Zone }>, new: [] as Array<Score & { zone: Zone }> };
let calls = 0;
outer: for (const { d, corner, zone } of chosen) {
  const fc = contextOf(d, corner);
  const truth = situation(fc, d, true);
  for (const variant of ['old', 'new'] as const) {
    if (calls >= MAX_CALLS) break outer;
    const s = variant === 'new' ? truth : situation(fc, d, false);
    const state = serializeState(fc, s, [], CLOCK, null);
    const qs = buildQuestions(fc, s.opp, { range: s.range });
    calls++;
    try {
      const res = await askJev(state, qs.questions, AbortSignal.timeout(10_000), { endpoint: ENDPOINT });
      const a = res.answers.tactic;
      if (a?.type !== 'choice') throw new Error('no tactic answer');
      const sc = score(fc, truth, a);
      tally[variant].push({ ...sc, zone });
      log.push({ variant, zone, matchup: `${d.red} v ${d.blue}`, corner, gap: Number(d.gap.toFixed(2)), geometry: state.geometry, tactic: a, inputTokens: res.inputTokens, latencyMs: Math.round(res.latencyMs), score: sc });
      const topP = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ');
      console.log(`#${calls} ${variant} ${zone} ${d.red} v ${d.blue} (${corner ? 'blue' : 'red'}) gap ${d.gap.toFixed(2)} m: [${topP}] top fit ${sc.topFit ?? '-'} | strike mass fits ${sc.fitMass.toFixed(2)} / misfit ${sc.misfitMass.toFixed(2)} | ${res.inputTokens} in-tok`);
    } catch (e) {
      console.log(`call ${calls} failed: ${e instanceof JevError ? `HTTP ${e.status} ${e.message}` : e}`);
      break outer;
    }
  }
}

function summary(rows: Array<Score & { zone: Zone }>) {
  const n = rows.length || 1;
  const strikesTop = rows.filter((r) => r.topFit !== null);
  const misfitTop = strikesTop.filter((r) => !(r.topFit === 'lands' || r.topFit === 'step')).length;
  const closeOutside = rows.filter((r) => r.zone === 'outside').length;
  return {
    n: rows.length,
    meanFitMass: rows.reduce((a, r) => a + r.fitMass, 0) / n,
    meanMisfitMass: rows.reduce((a, r) => a + r.misfitMass, 0) / n,
    misfitShareOfStrikeMass: rows.reduce((a, r) => a + r.misfitMass, 0) / Math.max(1e-9, rows.reduce((a, r) => a + r.strikeMass, 0)),
    topStrikes: strikesTop.length,
    topStrikesMisfit: misfitTop,
    pocketTopStrikeThatLands: rows.filter((r) => r.zone === 'pocket' && r.topFit === 'lands').length + `/${rows.filter((r) => r.zone === 'pocket').length}`,
    outsideTopStrikeTooFar: rows.filter((r) => r.zone === 'outside' && r.topFit === 'far').length + `/${closeOutside}`,
  };
}
const out = { calls, old: summary(tally.old), new: summary(tally.new) };
console.log('OLD', JSON.stringify(out.old));
console.log('NEW', JSON.stringify(out.new));
if (LOG) writeFileSync(LOG, JSON.stringify({ summary: out, log }, null, 2));
