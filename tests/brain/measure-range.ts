// Ring IQ, mind side: headless House-Mind fights on the real physics (no Jev calls), measuring how
// well the chosen strikes fit the range. Not a test: run it by hand.
//   in range     share of chosen strikes (a combo counts by its first strike) that land from the gap
//                when the intent applies (after the reaction delay), by the body's own skill ranges
//                (src/brain/ranges.ts); 'step' = one step in, 'close'/'far' = the wrong weapon
//   whiffs       strike runs that reached the strike phase and did not land, split by the gap when
//                they started (too far / too close / in range)
//   landed/min   strike runs whose striker touched him at speed with an impact >= 4 N·s (fight-metrics' rule)
//   --facts off  the A/B baseline: no range facts (ranges.RANGE_FACTS), the House Mind's old reach-band tree
//   --dump f     frozen fight states for the live Jev A/B (tests/brain/live-range.ts): a frame every
//                DUMP_EVERY_S with both up and the gap under DUMP_MAX_GAP_M
// usage: npx tsx tests/brain/measure-range.ts [--pairs savate:haymaker,firecracker:pylon] [--seconds 60] [--seeds 1,2] [--facts on|off] [--json out.json] [--dump states.json]
import loadMujoco from '@mujoco/mujoco';
import { writeFileSync } from 'node:fs';
import { Brain } from '../../src/brain/brain';
import { JevLink } from '../../src/brain/link';
import { RANGE_FACTS, rangeTable, type RangeFit } from '../../src/brain/ranges';
import { isStrike } from '../../src/brain/tactics';
import type { Intent, SimEvent, Tactic } from '../../src/core/protocol';
import type { Corner, MatchSetup } from '../../src/core/types';
import { controllerOf } from '../../src/physics/control';
import { TACTIC_SKILL } from '../../src/physics/control/abilities';
import { humanoidGeometry } from '../../src/physics/control/geometry';
import { isStrikeSkill, SKILLS, type SkillDef, type SkillId } from '../../src/physics/control/skills';
import { fallbackTactic } from '../../src/physics/control/tactics';
import type { RobotDesign } from '../../src/core/types';
import type { SkillRun } from '../../src/physics/control/skills/types';
import { buildContext } from '../../src/physics/runtime';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { compileWorld } from '../../src/physics/world';
import { DESIGNS } from '../../src/robots/designs';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PAIRS = opt('pairs', 'savate:haymaker,firecracker:pylon,savate:pylon,haymaker:firecracker').split(',').map((p) => p.split(':') as [string, string]);
const SECONDS = Number(opt('seconds', '60'));
const SEEDS = opt('seeds', '1,2').split(',').map(Number);
const JSON_OUT = opt('json', '');
const DUMP_OUT = opt('dump', '');
RANGE_FACTS.enabled = opt('facts', 'on') !== 'off';
const DUMP_EVERY_S = 3;
const DUMP_MAX_GAP_M = 2.2;
const FRAME_S = 1 / 60;
const REACTION_S = 0.12;
const MIN_LANDED_IMPULSE_NS = 4;
const IMPACT_TAIL_S = 0.1;

/**
 * The yardstick, independent of the helper under test (src/brain/ranges.ts): the body's own throw-or-step
 * decision (control/tactics.ts run → usable → strike: throws from lo..lo + throwAt·(hi − lo), walks in
 * past it), one step = the walk's longest stride (0.46 × leg length).
 */
function bodyFit(design: RobotDesign, t: Tactic, gap: number): RangeFit | null {
  const id = TACTIC_SKILL[fallbackTactic(t)];
  let def: SkillDef | undefined = id ? SKILLS[id] : undefined;
  if (!def || !design.abilities.includes(id as never)) {
    if (def?.kind === 'defense') return null;
    const pool = design.abilities.map((a) => SKILLS[a as SkillId]).filter((d): d is SkillDef => !!d && isStrikeSkill(d));
    def = pool.find((d) => d.kind === (def?.kind ?? 'arm')) ?? pool[0];
  }
  if (!def || !isStrikeSkill(def)) return null;
  const geo = humanoidGeometry(design);
  const [lo, hi] = def.range(geo);
  const edge = lo + (def.approach?.throwAt ?? 0.85) * (hi - lo);
  return gap < lo ? 'close' : gap <= edge ? 'lands' : gap <= edge + 0.46 * geo.legLength ? 'step' : 'far';
}

interface Tally { intents: Record<string, number>; chosen: number; fit: Record<RangeFit, number>; thrown: number; committed: number; landed: number; whiff: { far: number; close: number; inRange: number }; falls: number; breakStrikes: number }
const newTally = (): Tally => ({ intents: {}, chosen: 0, fit: { lands: 0, step: 0, close: 0, far: 0 }, thrown: 0, committed: 0, landed: 0, whiff: { far: 0, close: 0, inRange: 0 }, falls: 0, breakStrikes: 0 });

function strikeOf(intent: Intent): Tactic | null {
  if (intent.tactic === 'combo') return intent.combo?.find((t) => t !== 'combo' && isStrike(t)) ?? null;
  return isStrike(intent.tactic) ? intent.tactic : null;
}

async function fight(mj: Awaited<ReturnType<typeof loadMujoco>>, red: string, blue: string, seed: number) {
  const setup: MatchSetup = {
    fighters: [
      { design: red, skin: 'factory', plan: 'Fight smart: take what he gives you.', temperament: 1.2 },
      { design: blue, skin: 'neon', plan: 'Fight smart: take what he gives you.', temperament: 1.2 },
    ],
    seed, timestep: 0.001, reactionDelayS: REACTION_S,
  };
  const world = compileWorld(setup);
  const ctx = buildContext(mj, world, setup);
  for (const s of SYSTEMS) s.init?.(ctx);
  const link = new JevLink({ ask: () => Promise.reject(new Error('offline: House Mind')), retryMs: 1e9 });
  const meta = { nbody: 0, timestep: 0.001, robots: [0, 1].map((c) => ({ corner: c as Corner, design: setup.fighters[c].design, prefix: '', parts: [] })), props: [] };
  const tally = [newTally(), newTally()];
  const pending: Array<{ c: Corner; tick: number; strike: Tactic }> = [];
  const designs = [DESIGNS[red], DESIGNS[blue]];
  const brains = ([0, 1] as Corner[]).map((corner) => new Brain({
    corner, meta, seed, link, fighter: setup.fighters[corner],
    onIntent: (c: Corner, intent: Intent) => {
      const applyAt = ctx.tick + Math.round(REACTION_S / ctx.dt);
      ctx.robots[c].pendingIntents.push({ applyAtTick: applyAt, intent });
      const strike = strikeOf(intent);
      if (strike) pending.push({ c, tick: applyAt, strike });
      const kind = intent.tactic === 'combo' ? 'combo' : strike ? 'strike' : intent.tactic;
      tally[c].intents[kind] = (tally[c].intents[kind] ?? 0) + 1;
    },
  }));
  // The gap at the last brain frame (at most one frame old): building telemetry mid-frame would tick its detectors.
  let lastGap = Infinity;
  let breaks = 0;
  const gap = () => lastGap;
  let nextDump = DUMP_EVERY_S;
  const step = () => { for (const s of SYSTEMS) s.pre?.(ctx); mj.mj_step(ctx.model, ctx.data); ctx.tick++; ctx.time += ctx.dt; for (const s of SYSTEMS) s.post?.(ctx); };
  for (let i = 0; i < 300; i++) step();
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  for (const b of brains) b.start();
  const perFrame = Math.round(FRAME_S / ctx.dt);
  const current: Array<{ run: SkillRun; startGap: number; committed: boolean; runnerLanded: boolean; start: number; end: number; lo: number; hi: number } | null> = [null, null];
  const closed: Array<{ c: number; rec: NonNullable<(typeof current)[number]> }> = [];
  const impacts: Array<{ c: number; t: number; impulse: number }> = [];
  const t0 = performance.now();
  const start = ctx.time;
  let ended = false;
  for (let f = 0; f < SECONDS / FRAME_S && !ended; f++) {
    const frameEvents: SimEvent[] = [];
    for (let i = 0; i < perFrame; i++) {
      step();
      for (const e of ctx.events) {
        frameEvents.push(e);
        if (e.kind === 'impact' && e.striker !== null && e.victim !== null && e.striker !== e.victim) impacts.push({ c: e.striker, t: ctx.time, impulse: e.impulseNs });
        if (e.kind === 'ko') ended = true;
        if (e.kind === 'fall') tally[e.corner].falls++;
        if (e.kind === 'break') breaks++;
      }
      ctx.events.length = 0;
      for (const c of [0, 1]) {
        const run = controllerOf(ctx.robots[c])?.skills.run ?? null;
        const cur = current[c];
        if (cur && cur.run !== run) { cur.end = ctx.time; closed.push({ c, rec: cur }); current[c] = null; }
        if (run && !current[c] && (run.def.kind === 'arm' || run.def.kind === 'leg')) {
          if (ctx.referee?.orders[c]) tally[c].breakStrikes++;
          const table = rangeTable(designs[c]);
          const w = table ? [...table.byTactic.values()].find((x) => x.skill === run.def.id) : undefined;
          current[c] = { run, startGap: gap(), committed: false, runnerLanded: false, start: ctx.time, end: 0, lo: w?.lo ?? 0, hi: w?.hi ?? Infinity };
        }
        const now = current[c];
        if (now) {
          if (now.run.phase !== 'windup') now.committed = true;
          if (now.run.landed) now.runnerLanded = true;
        }
      }
    }
    const telemetry = [buildTelemetry(ctx, ctx.robots[0], SYSTEMS), buildTelemetry(ctx, ctx.robots[1], SYSTEMS)] as [ReturnType<typeof buildTelemetry>, ReturnType<typeof buildTelemetry>];
    const d = Math.hypot(telemetry[0].comWorld[0] - telemetry[1].comWorld[0], telemetry[0].comWorld[1] - telemetry[1].comWorld[1]);
    lastGap = d;
    if (DUMP_OUT && ctx.time - start >= nextDump && d < DUMP_MAX_GAP_M && !telemetry[0].down && !telemetry[1].down) {
      nextDump = ctx.time - start + DUMP_EVERY_S;
      dumps.push({ red, blue, seed, time: ctx.time, tick: ctx.tick, gap: d, telemetry: JSON.parse(JSON.stringify(telemetry)) });
    }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (ctx.tick < p.tick) continue;
      pending.splice(i, 1);
      if (telemetry[p.c].down || telemetry[p.c === 0 ? 1 : 0].down) continue;
      const fit = bodyFit(designs[p.c], p.strike, d);
      if (!fit) continue;
      tally[p.c].chosen++;
      tally[p.c].fit[fit]++;
    }
    for (const b of brains) b.onFrame({ tick: ctx.tick, time: ctx.time, events: frameEvents, telemetry });
    await Promise.resolve();
  }
  for (const c of [0, 1]) if (current[c]) { current[c]!.end = ctx.time; closed.push({ c, rec: current[c]! }); }
  const throws: Array<{ c: number; skill: string; frac: number; landed: boolean }> = [];
  for (const { c, rec } of closed) {
    const t = tally[c];
    t.thrown++;
    if (!rec.committed) continue;
    t.committed++;
    const impulse = Math.max(0, ...impacts.filter((e) => e.c === c && e.t >= rec.start && e.t <= rec.end + IMPACT_TAIL_S).map((e) => e.impulse));
    const landed = rec.runnerLanded && impulse >= MIN_LANDED_IMPULSE_NS;
    throws.push({ c, skill: rec.run.def.id, frac: Number(((rec.startGap - rec.lo) / Math.max(1e-6, rec.hi - rec.lo)).toFixed(2)), landed });
    if (landed) t.landed++;
    else if (rec.startGap > rec.hi) t.whiff.far++;
    else if (rec.startGap < rec.lo) t.whiff.close++;
    else t.whiff.inRange++;
  }
  const length = ctx.time - start;
  return { red, blue, seed, length, wall: (performance.now() - t0) / 1000, tally, impacts: impacts.length, breaks, ko: ended, throws };
}

function sum(ts: Tally[]): Tally {
  const out = newTally();
  for (const t of ts) {
    for (const [k, n] of Object.entries(t.intents)) out.intents[k] = (out.intents[k] ?? 0) + n;
    out.chosen += t.chosen; out.thrown += t.thrown; out.committed += t.committed; out.landed += t.landed;
    for (const k of Object.keys(out.fit) as RangeFit[]) out.fit[k] += t.fit[k];
    out.whiff.far += t.whiff.far; out.whiff.close += t.whiff.close; out.whiff.inRange += t.whiff.inRange;
    out.falls += t.falls; out.breakStrikes += t.breakStrikes;
  }
  return out;
}

const dumps: Array<{ red: string; blue: string; seed: number; time: number; tick: number; gap: number; telemetry: unknown }> = [];
const pct = (a: number, b: number) => `${b ? ((100 * a) / b).toFixed(0) : '-'}%`;
const mj = await loadMujoco();
const results = [];
for (const [red, blue] of PAIRS) for (const seed of SEEDS) {
  const r = await fight(mj, red, blue, seed);
  results.push(r);
  const t = sum(r.tally);
  const whiffs = t.whiff.far + t.whiff.close + t.whiff.inRange;
  console.log(`${red} v ${blue} seed ${seed}: ${r.length.toFixed(0)} s (${r.wall.toFixed(0)} s wall) | strikes chosen ${t.chosen}: lands ${pct(t.fit.lands, t.chosen)}, step ${pct(t.fit.step, t.chosen)}, close ${pct(t.fit.close, t.chosen)}, far ${pct(t.fit.far, t.chosen)} | thrown ${t.committed} landed ${t.landed} whiffs ${whiffs} (far ${t.whiff.far}, close ${t.whiff.close}, in ${t.whiff.inRange}) | landed/min ${(t.landed / (r.length / 60)).toFixed(1)} | falls ${t.falls} breaks ${r.breaks} strikes-in-break ${t.breakStrikes}${r.ko ? ' KO' : ''}`);
}
const all = sum(results.flatMap((r) => r.tally));
const minutes = results.reduce((a, r) => a + r.length, 0) / 60;
const whiffs = all.whiff.far + all.whiff.close + all.whiff.inRange;
const summary = {
  fights: results.length, minutes,
  chosen: all.chosen, landsShare: all.fit.lands / Math.max(1, all.chosen), landsOrStepShare: (all.fit.lands + all.fit.step) / Math.max(1, all.chosen),
  fit: all.fit, committed: all.committed, landed: all.landed, whiffs, whiff: all.whiff,
  falls: all.falls, breaks: results.reduce((a, r) => a + r.breaks, 0), breakStrikes: all.breakStrikes, kos: results.filter((r) => r.ko).length,
  whiffShare: whiffs / Math.max(1, all.committed), landedPerMin: all.landed / Math.max(1e-6, minutes), thrownPerMin: all.committed / Math.max(1e-6, minutes),
};
console.log(`TOTAL ${results.length} fights, ${minutes.toFixed(1)} min | chosen strikes ${all.chosen}: lands ${pct(all.fit.lands, all.chosen)}, lands+step ${pct(all.fit.lands + all.fit.step, all.chosen)}, close ${pct(all.fit.close, all.chosen)}, far ${pct(all.fit.far, all.chosen)} | thrown ${all.committed} (${summary.thrownPerMin.toFixed(1)}/min), landed ${all.landed} (${summary.landedPerMin.toFixed(1)}/min), whiffs ${whiffs} (${pct(whiffs, all.committed)}: far ${all.whiff.far}, close ${all.whiff.close}, in range ${all.whiff.inRange}) | falls ${all.falls}, breaks ${summary.breaks}, strikes started in a break ${all.breakStrikes}, KOs ${summary.kos}`);
const nIntents = Object.values(all.intents).reduce((a, b) => a + b, 0);
console.log(`intents ${nIntents}: ${Object.entries(all.intents).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, nIntents)}`).join(', ')}`);
console.log(`range facts ${RANGE_FACTS.enabled ? 'ON' : 'OFF'}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ facts: RANGE_FACTS.enabled, summary, results }, null, 2));
if (DUMP_OUT) { writeFileSync(DUMP_OUT, JSON.stringify(dumps)); console.log(`${dumps.length} frozen states → ${DUMP_OUT}`); }
