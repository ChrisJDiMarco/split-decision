// Fight-quality metrics: headless fights (the real physics systems, the sparring stand-in brain,
// no rendering), measured the way a viewer would judge them.
//
//   self-inflicted knockdowns   falls with no opponent impact above SELF_KD_IMPULSE_NS on the
//                               fighter in the SELF_KD_WINDOW_S before the fall
//                               (strict: an impact the opponent struck; loose: any robot-on-robot
//                               contact touching the fighter)
//   get-up success              'getup' within GETUP_WINDOW_S of the fall and still up
//                               STAND_S later (solid: still up SOLID_S later, through the rise)
//   approach                    mean closing speed (own COM velocity toward the opponent) while
//                               the tactic is close_distance; time from release to the first
//                               landed strike
//   strikes                     landed robot-on-robot strikes per minute (both fighters): the
//                               skill runner saw its striker touch the opponent at speed and the
//                               damage model measured an impact from it; the share of head-targeted
//                               strikes that hit the head
//   fights                      length, how they end, 'down' KOs that followed a self-inflicted fall
//   health                      blow-ups, control cost per robot per physics step
//
// usage:
//   npx tsx tools/fight-metrics.ts [--seconds 120] [--seeds 1,2,3] [--designs bruiser,striker,goliath]
//                                  [--jobs 3] [--out file.json]      every ordered matchup, in parallel
//   npx tsx tools/fight-metrics.ts --fight <red> <blue> <seconds> <seed> [--json] [--log]
import loadMujoco from '@mujoco/mujoco';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SimEvent, TargetZone } from '../src/core/protocol';
import type { MatchSetup } from '../src/core/types';
import { controllerOf, controlSystem, sparringIntent } from '../src/physics/control';
import type { SkillRun } from '../src/physics/control/skills/types';
import { buildContext } from '../src/physics/runtime';
import type { SimContext, SimSystem } from '../src/physics/sim-context';
import { SYSTEMS } from '../src/physics/systems';
import { compileWorld } from '../src/physics/world';

const INTENT_EVERY_S = 0.5;
const SELF_KD_IMPULSE_NS = 20;
const SELF_KD_WINDOW_S = 1.5;
const GETUP_WINDOW_S = 10;
const STAND_S = 1;
const SOLID_S = 4; // through the whole rise out of the crouch
const APPROACH_MIN_DIST_M = 1.3; // closing speed only counts while still this far apart
const SAMPLE_EVERY_STEPS = 10;
const COST_BLOCK_S = 1;
const BLOWUP_QVEL = 400;
const IMPACT_TAIL_S = 0.1; // an impact event this soon after a strike ends still belongs to it
const MIN_LANDED_IMPULSE_NS = 4; // the damage model's own event floor

interface ImpactRec {
  t: number;
  striker: number;
  victim: number;
  part: string | null;
  impulse: number;
}

interface FallRec {
  t: number;
  selfStrict: boolean;
  selfLoose: boolean;
  maxHitNs: number; // biggest opponent impact on this fighter in the window
  doing: string[]; // skills in the SELF_KD_WINDOW_S before the fall
  gyroPeak: number;
  getupAt: number | null;
  refellAt: number | null;
  outcome: 'up' | 'late' | 'refell' | 'ko' | 'censored';
  solid: boolean | null;
}

interface StrikeRec {
  id: string;
  zone: TargetZone;
  start: number;
  end: number;
  committed: boolean;
  runnerLanded: boolean;
  landedAt: number | null;
  maxImpulse: number;
  headImpulse: number;
  landed: boolean;
}

interface FighterReport {
  corner: number;
  design: string;
  falls: FallRec[];
  strikes: { thrown: number; committed: number; landed: number; headTargeted: number; headLanded: number; byId: Record<string, { thrown: number; landed: number; falls: number }> };
  approach: { metres: number; seconds: number; speed: number };
  selfKd: { strict: number; loose: number };
  getUp: { falls: number; counted: number; up: number; solid: number; censored: number; meanS: number };
  downS: number;
  steps: number;
  captureSteps: number;
  gyroSatMean: number;
  gyroSatMax: number;
}

export interface FightReport {
  red: string;
  blue: string;
  seed: number;
  seconds: number;
  length: number;
  end: string; // KO reason ('head' | 'down' | 'power' | 'disabled'), 'timeout' or 'blowup'
  koCorner: number | null;
  koAfterSelfFall: boolean;
  firstLanded: number | null;
  landed: number;
  landedPerMin: number;
  headTargetedLanded: number;
  headHits: number;
  blowups: number;
  controlUs: { mean: number; median: number; worst: number };
  wall: number;
  fighters: FighterReport[];
  timeline: string[];
}

const now = () => performance.now();

export async function runFight(red: string, blue: string, seconds: number, seed: number, log = false): Promise<FightReport> {
  const setup: MatchSetup = {
    fighters: [
      { design: red, skin: 'factory', plan: '', temperament: 1 },
      { design: blue, skin: 'neon', plan: '', temperament: 1 },
    ],
    seed,
    timestep: 0.001,
    reactionDelayS: 0.3,
  };
  const mj = await loadMujoco();
  const ctx: SimContext = buildContext(mj, compileWorld(setup), setup);
  let controlMs = 0;
  const timedControl: SimSystem = {
    ...controlSystem,
    pre(c) {
      const t0 = now();
      controlSystem.pre!(c);
      controlMs += now() - t0;
    },
  };
  const systems = SYSTEMS.map((s) => (s === controlSystem ? timedControl : s));
  for (const s of systems) s.init?.(ctx);
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;

  const ctl = ctx.robots.map((r) => controllerOf(r)!);
  const impacts: ImpactRec[] = [];
  const timeline: string[] = [];
  const falls: FallRec[][] = [[], []];
  const strikes: StrikeRec[][] = [[], []];
  const current: Array<{ run: SkillRun; rec: StrikeRec } | null> = [null, null];
  const history: Array<Array<{ t: number; skill: string; sat: number }>> = [[], []];
  const approach = [{ m: 0, s: 0 }, { m: 0, s: 0 }];
  const downS = [0, 0];
  const sat = [{ sum: 0, n: 0, max: 0 }, { sum: 0, n: 0, max: 0 }];
  const blocks: number[] = [];
  let blockMs = 0, blockSteps = 0;
  let blowups = 0;
  let end = 'timeout';
  let koCorner: number | null = null;
  const t0 = now();
  const steps = Math.round(seconds / ctx.dt);
  const intentEvery = Math.round(INTENT_EVERY_S / ctx.dt);
  const blockSteps0 = Math.round(COST_BLOCK_S / ctx.dt);
  const stamp = () => ctx.time.toFixed(1).padStart(6);
  const name = (c: number) => ctx.robots[c].design.name;

  const closeStrike = (c: number) => {
    const cur = current[c];
    if (!cur) return;
    cur.rec.end = ctx.time;
    strikes[c].push(cur.rec);
    current[c] = null;
  };

  const strikeFor = (c: number, t: number): StrikeRec | null => {
    const cur = current[c];
    if (cur) return cur.rec;
    const last = strikes[c][strikes[c].length - 1];
    return last && t - last.end <= IMPACT_TAIL_S ? last : null;
  };

  const onEvent = (e: SimEvent) => {
    switch (e.kind) {
      case 'impact': {
        if (e.striker === null || e.victim === null || e.striker === e.victim) return;
        impacts.push({ t: ctx.time, striker: e.striker, victim: e.victim, part: e.part, impulse: e.impulseNs });
        const rec = strikeFor(e.striker, ctx.time);
        if (rec) {
          rec.maxImpulse = Math.max(rec.maxImpulse, e.impulseNs);
          if (e.part === 'head') rec.headImpulse = Math.max(rec.headImpulse, e.impulseNs);
        }
        if (log && e.impulseNs >= SELF_KD_IMPULSE_NS) timeline.push(`${stamp()}s  ${name(e.striker)} hits ${name(e.victim)} ${e.part ?? '?'} ${e.impulseNs.toFixed(0)} N·s`);
        return;
      }
      case 'fall': {
        const c = e.corner;
        const since = ctx.time - SELF_KD_WINDOW_S;
        let strictHit = 0, looseHit = 0;
        for (let i = impacts.length - 1; i >= 0 && impacts[i].t >= since; i--) {
          const h = impacts[i];
          if (h.victim === c) strictHit = Math.max(strictHit, h.impulse);
          if (h.victim === c || h.striker === c) looseHit = Math.max(looseHit, h.impulse);
        }
        const recent = history[c].filter((h) => h.t >= since);
        const doing = [...new Set(recent.map((h) => h.skill))];
        const gyroPeak = recent.reduce((m, h) => Math.max(m, h.sat), 0);
        // A refall during the STAND_S / SOLID_S after a get-up marks that get-up.
        for (const f of falls[c]) {
          if (f.getupAt !== null && f.refellAt === null && ctx.time - f.getupAt <= SOLID_S) f.refellAt = ctx.time;
        }
        falls[c].push({
          t: ctx.time, selfStrict: strictHit <= SELF_KD_IMPULSE_NS, selfLoose: looseHit <= SELF_KD_IMPULSE_NS, maxHitNs: strictHit,
          doing, gyroPeak, getupAt: null, refellAt: null, outcome: 'censored', solid: null,
        });
        if (current[c]) closeStrike(c);
        timeline.push(`${stamp()}s  ${name(c)} DOWN${strictHit <= SELF_KD_IMPULSE_NS ? ' (self)' : ` (hit ${strictHit.toFixed(0)} N·s)`} doing ${doing.join(',')} gyro ${gyroPeak.toFixed(2)}`);
        return;
      }
      case 'getup': {
        const f = falls[e.corner][falls[e.corner].length - 1];
        if (f && f.getupAt === null) f.getupAt = ctx.time;
        timeline.push(`${stamp()}s  ${name(e.corner)} back up${f ? ` after ${(ctx.time - f.t).toFixed(1)} s` : ''}`);
        return;
      }
      case 'detach': timeline.push(`${stamp()}s  ${name(e.corner)} lost ${e.part}`); return;
      case 'joint': if (log) timeline.push(`${stamp()}s  ${name(e.corner)} ${e.joint} → ${e.state}`); return;
      case 'ko': timeline.push(`${stamp()}s  KO! ${name(e.corner)} (${e.reason})`); return;
      default: return;
    }
  };

  for (let i = 0; i < steps; i++) {
    if (i % intentEvery === 0) for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
    for (const s of systems) s.pre?.(ctx);
    mj.mj_step(ctx.model, ctx.data);
    ctx.tick++;
    ctx.time += ctx.dt;
    let bad = false;
    for (let k = 0; k < ctx.model.nv; k++) if (!(Math.abs(ctx.data.qvel[k]) < BLOWUP_QVEL)) { bad = true; break; }
    if (bad) {
      blowups++;
      end = 'blowup';
      timeline.push(`${stamp()}s  BLOW-UP`);
      break;
    }
    for (const s of systems) s.post?.(ctx);
    for (const e of ctx.events) onEvent(e);
    ctx.events.length = 0;

    // Strike runs: one record per strike skill run, closed when the runner lets go of it.
    for (const c of [0, 1]) {
      const run = ctl[c].skills.run;
      if (current[c] && current[c]!.run !== run) closeStrike(c);
      if (run && !current[c] && (run.def.kind === 'arm' || run.def.kind === 'leg')) {
        current[c] = {
          run,
          rec: { id: run.def.id, zone: run.zone, start: ctx.time, end: ctx.time, committed: false, runnerLanded: false, landedAt: null, maxImpulse: 0, headImpulse: 0, landed: false },
        };
      }
      const cur = current[c];
      if (cur) {
        if (run!.phase !== 'windup') cur.rec.committed = true;
        if (run!.landed && !cur.rec.runnerLanded) {
          cur.rec.runnerLanded = true;
          cur.rec.landedAt = ctx.time;
        }
      }
    }

    blockSteps++;
    if (blockSteps >= blockSteps0) {
      blocks.push(((controlMs - blockMs) * 1000) / blockSteps / 2);
      blockMs = controlMs;
      blockSteps = 0;
    }

    if (ctx.tick % SAMPLE_EVERY_STEPS === 0) {
      const dt = ctx.dt * SAMPLE_EVERY_STEPS;
      const com = ctx.data.subtree_com as Float64Array;
      const vel = ctx.data.subtree_linvel as Float64Array;
      for (const c of [0, 1]) {
        const r = ctx.robots[c], o = ctx.robots[1 - c];
        const a = r.rootBody * 3, b = o.rootBody * 3;
        const dx = com[b] - com[a], dy = com[b + 1] - com[a + 1];
        const dist = Math.hypot(dx, dy);
        const saturation = ctl[c].gyro?.saturation ?? 0;
        history[c].push({ t: ctx.time, skill: r.skill, sat: saturation });
        if (history[c].length > 400) history[c].splice(0, 100);
        if (r.down) downS[c] += dt;
        sat[c].sum += saturation;
        sat[c].n++;
        sat[c].max = Math.max(sat[c].max, saturation);
        if (r.intent?.tactic === 'close_distance' && !r.down && !ctl[c].getUp.active && dist > APPROACH_MIN_DIST_M) {
          // subtree_linvel needs mj_subtreeVel, which the controller runs every control tick.
          approach[c].m += ((vel[a] * dx + vel[a + 1] * dy) / dist) * dt;
          approach[c].s += dt;
        }
      }
    }
    const ko = ctx.robots.find((r) => r.koReason);
    if (ko) {
      end = ko.koReason!;
      koCorner = ko.corner;
      break;
    }
  }
  for (const c of [0, 1]) closeStrike(c);
  const length = ctx.time;

  // Get-up outcomes.
  for (const c of [0, 1]) {
    for (const f of falls[c]) {
      const koHere = koCorner === c && end === 'down' && f === falls[c][falls[c].length - 1];
      if (f.getupAt === null) {
        f.outcome = koHere ? 'ko' : length - f.t >= GETUP_WINDOW_S ? 'late' : 'censored';
        continue;
      }
      if (f.refellAt !== null && f.refellAt - f.getupAt <= STAND_S) f.outcome = 'refell';
      else if (f.getupAt + STAND_S > length) f.outcome = 'censored';
      else f.outcome = f.getupAt + STAND_S <= f.t + GETUP_WINDOW_S ? 'up' : 'late';
      if (f.outcome === 'up' || f.outcome === 'refell') f.solid = f.refellAt === null && f.getupAt + SOLID_S <= length ? true : f.refellAt !== null ? false : null;
    }
  }

  const fighters: FighterReport[] = [0, 1].map((c) => {
    const r = ctx.robots[c];
    const list = strikes[c];
    const byId: FighterReport['strikes']['byId'] = {};
    for (const s of list) {
      s.landed = s.runnerLanded && s.maxImpulse >= MIN_LANDED_IMPULSE_NS;
      const b = (byId[s.id] ??= { thrown: 0, landed: 0, falls: 0 });
      b.thrown++;
      if (s.landed) b.landed++;
      if (falls[c].some((f) => f.t >= s.start && f.t <= s.end + 1)) b.falls++;
    }
    const counted = falls[c].filter((f) => f.outcome !== 'censored');
    const up = counted.filter((f) => f.outcome === 'up');
    const upTimes = falls[c].filter((f) => f.getupAt !== null).map((f) => f.getupAt! - f.t);
    return {
      corner: c,
      design: r.design.id,
      falls: falls[c],
      strikes: {
        thrown: list.length,
        committed: list.filter((s) => s.committed).length,
        landed: list.filter((s) => s.landed).length,
        headTargeted: list.filter((s) => s.landed && s.zone === 'head').length,
        headLanded: list.filter((s) => s.landed && s.zone === 'head' && s.headImpulse > 0).length,
        byId,
      },
      approach: { metres: approach[c].m, seconds: approach[c].s, speed: approach[c].s > 0 ? approach[c].m / approach[c].s : 0 },
      selfKd: { strict: falls[c].filter((f) => f.selfStrict).length, loose: falls[c].filter((f) => f.selfLoose).length },
      getUp: {
        falls: falls[c].length, counted: counted.length, up: up.length,
        solid: up.filter((f) => f.solid === true).length, censored: falls[c].length - counted.length,
        meanS: upTimes.length ? upTimes.reduce((a, b) => a + b, 0) / upTimes.length : 0,
      },
      downS: downS[c],
      steps: ctl[c].gait.stepsTaken,
      captureSteps: ctl[c].gait.captureSteps,
      gyroSatMean: sat[c].n ? sat[c].sum / sat[c].n : 0,
      gyroSatMax: sat[c].max,
    };
  });
  const landedAll = strikes.flat().filter((s) => s.landed);
  const firstLanded = landedAll.reduce<number | null>((m, s) => (s.landedAt !== null && (m === null || s.landedAt < m) ? s.landedAt : m), null);
  const lastFall = koCorner !== null ? falls[koCorner][falls[koCorner].length - 1] : undefined;
  blocks.sort((a, b) => a - b);
  return {
    red, blue, seed, seconds, length, end, koCorner,
    koAfterSelfFall: end === 'down' && !!lastFall?.selfStrict,
    firstLanded,
    landed: landedAll.length,
    landedPerMin: landedAll.length / Math.max(1e-6, length / 60),
    headTargetedLanded: fighters.reduce((a, f) => a + f.strikes.headTargeted, 0),
    headHits: fighters.reduce((a, f) => a + f.strikes.headLanded, 0),
    blowups,
    controlUs: {
      mean: (controlMs * 1000) / Math.max(1, ctx.tick) / 2,
      median: blocks.length ? blocks[Math.floor(blocks.length / 2)] : 0,
      worst: blocks.length ? blocks[blocks.length - 1] : 0,
    },
    wall: (now() - t0) / 1000,
    fighters,
    timeline,
  };
}

// ------------------------------------------------------------------ reporting

const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function fightLine(f: FightReport): string {
  const [a, b] = f.fighters;
  const who = (x: FighterReport) =>
    `${x.design.padEnd(7)} falls ${x.getUp.falls} (self ${x.selfKd.strict}/${x.selfKd.loose}) up ${x.getUp.up}/${x.getUp.counted} solid ${x.getUp.solid} ` +
    `strikes ${x.strikes.landed}/${x.strikes.thrown} head ${x.strikes.headLanded}/${x.strikes.headTargeted} approach ${x.approach.speed.toFixed(2)} m/s`;
  return `${f.red} v ${f.blue} s${f.seed}: ${f.length.toFixed(1)} s ${f.end}${f.koCorner !== null ? `(${f.fighters[f.koCorner].design})` : ''}` +
    `${f.koAfterSelfFall ? ' after SELF fall' : ''}, landed ${f.landed} (${f.landedPerMin.toFixed(1)}/min), first ${f.firstLanded?.toFixed(1) ?? '-'} s, ` +
    `control ${f.controlUs.median.toFixed(1)} µs${f.blowups ? ', BLOW-UP' : ''}\n    ${who(a)}\n    ${who(b)}`;
}

export function summarize(fights: FightReport[]): string {
  const fs = fights.flatMap((f) => f.fighters.map((x) => ({ f, x })));
  const fighterS = fights.reduce((a, f) => a + 2 * f.length, 0);
  const selfStrict = fs.reduce((a, { x }) => a + x.selfKd.strict, 0);
  const selfLoose = fs.reduce((a, { x }) => a + x.selfKd.loose, 0);
  const perTwoMin = (n: number) => (n / Math.max(1e-6, fighterS)) * 120;
  const counted = fs.reduce((a, { x }) => a + x.getUp.counted, 0);
  const up = fs.reduce((a, { x }) => a + x.getUp.up, 0);
  const solid = fs.reduce((a, { x }) => a + x.getUp.solid, 0);
  const apM = fs.reduce((a, { x }) => a + x.approach.metres, 0);
  const apS = fs.reduce((a, { x }) => a + x.approach.seconds, 0);
  const firsts = fights.map((f) => f.firstLanded ?? f.length);
  const minutes = fights.reduce((a, f) => a + f.length / 60, 0);
  const landed = fights.reduce((a, f) => a + f.landed, 0);
  const headT = fights.reduce((a, f) => a + f.headTargetedLanded, 0);
  const headH = fights.reduce((a, f) => a + f.headHits, 0);
  const lengths = fights.map((f) => f.length);
  const ends: Record<string, number> = {};
  for (const f of fights) ends[f.end] = (ends[f.end] ?? 0) + 1;
  const selfDownKo = fights.filter((f) => f.koAfterSelfFall).length;
  const blowups = fights.reduce((a, f) => a + f.blowups, 0);
  const cost = fights.map((f) => f.controlUs.median);
  const byDesign = new Map<string, { self: number; s: number; up: number; counted: number; apM: number; apS: number; landed: number; thrown: number }>();
  for (const { f, x } of fs) {
    const d = byDesign.get(x.design) ?? { self: 0, s: 0, up: 0, counted: 0, apM: 0, apS: 0, landed: 0, thrown: 0 };
    d.self += x.selfKd.strict;
    d.s += f.length;
    d.up += x.getUp.up;
    d.counted += x.getUp.counted;
    d.apM += x.approach.metres;
    d.apS += x.approach.seconds;
    d.landed += x.strikes.landed;
    d.thrown += x.strikes.thrown;
    byDesign.set(x.design, d);
  }
  const bySkill = new Map<string, { thrown: number; landed: number; falls: number }>();
  for (const { x } of fs) {
    for (const [id, s] of Object.entries(x.strikes.byId)) {
      const k = `${x.design}.${id}`;
      const b = bySkill.get(k) ?? { thrown: 0, landed: 0, falls: 0 };
      b.thrown += s.thrown;
      b.landed += s.landed;
      b.falls += s.falls;
      bySkill.set(k, b);
    }
  }
  const selfDoing = new Map<string, number>();
  for (const { x } of fs) for (const fl of x.falls) if (fl.selfStrict) for (const d of fl.doing) selfDoing.set(`${x.design}.${d}`, (selfDoing.get(`${x.design}.${d}`) ?? 0) + 1);
  const ok = (pass: boolean) => (pass ? 'PASS' : 'FAIL');
  const lines = [
    `${fights.length} fights, ${(fighterS / 2).toFixed(0)} s of fighting`,
    `self-inflicted knockdowns   ${perTwoMin(selfStrict).toFixed(2)} per fighter per 2 min (strict, ${selfStrict}), ${perTwoMin(selfLoose).toFixed(2)} (loose, ${selfLoose})   target <= 0.5   ${ok(perTwoMin(selfStrict) <= 0.5)}`,
    `get-up success              ${pct(up / Math.max(1, counted))} (${up}/${counted}), solid ${pct(solid / Math.max(1, counted))}   target >= 80%   ${ok(up / Math.max(1, counted) >= 0.8)}`,
    `approach speed              ${(apM / Math.max(1e-6, apS)).toFixed(2)} m/s over ${apS.toFixed(0)} s   target 0.5-1.0   ${ok(apM / apS >= 0.5 && apM / apS <= 1)}`,
    `first landed strike         median ${median(firsts).toFixed(1)} s (max ${Math.max(...firsts).toFixed(1)})   target < 5   ${ok(median(firsts) < 5)}`,
    `landed strikes / min        ${(landed / Math.max(1e-6, minutes)).toFixed(1)} (${landed})   target >= 15   ${ok(landed / minutes >= 15)}`,
    `head share of head strikes  ${pct(headH / Math.max(1, headT))} (${headH}/${headT})   target >= 25%   ${ok(headH / Math.max(1, headT) >= 0.25)}`,
    `fight length                median ${median(lengths).toFixed(1)} s, ends ${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(', ')}, down KOs after a self fall ${selfDownKo}`,
    `blow-ups                    ${blowups}   target 0   ${ok(blowups === 0)}`,
    `control cost                median ${median(cost).toFixed(1)} µs, worst fight ${Math.max(...cost).toFixed(1)} µs per robot per step   target < 40   ${ok(median(cost) < 40)}`,
    'per design:',
    ...[...byDesign].map(([d, v]) => `  ${d.padEnd(8)} self KD ${((v.self / Math.max(1e-6, v.s)) * 120).toFixed(2)}/2min, get-up ${v.up}/${v.counted}, approach ${(v.apM / Math.max(1e-6, v.apS)).toFixed(2)} m/s, landed ${v.landed}/${v.thrown}`),
    'per strike (thrown / landed / falls within 1 s):',
    ...[...bySkill].sort().map(([k, v]) => `  ${k.padEnd(22)} ${v.thrown} / ${v.landed} / ${v.falls}`),
    `self falls by activity: ${[...selfDoing].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------ CLI

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function runChild(red: string, blue: string, seconds: number, seed: number): Promise<FightReport> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, '--fight', red, blue, String(seconds), String(seed), '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || !line) reject(new Error(`${red} v ${blue} seed ${seed} exited ${code}`));
      else resolve(JSON.parse(line) as FightReport);
    });
  });
}

async function main(): Promise<void> {
  const fi = process.argv.indexOf('--fight');
  if (fi >= 0) {
    const [red = 'bruiser', blue = 'striker', secs = '120', seed = '1'] = process.argv.slice(fi + 1, fi + 5);
    const report = await runFight(red, blue, Number(secs), Number(seed), process.argv.includes('--log'));
    if (process.argv.includes('--json')) console.log(JSON.stringify(report));
    else {
      console.log(report.timeline.join('\n') || '(nothing happened)');
      console.log(fightLine(report));
      console.log(summarize([report]));
    }
    return;
  }
  const seconds = Number(arg('seconds', '120'));
  const seeds = arg('seeds', '1,2,3').split(',').map(Number);
  const designs = arg('designs', 'bruiser,striker,goliath').split(',');
  const jobs = Math.max(1, Number(arg('jobs', '3')));
  const queue: Array<[string, string, number]> = [];
  for (const red of designs) for (const blue of designs) if (red !== blue) for (const seed of seeds) queue.push([red, blue, seed]);
  const results: FightReport[] = [];
  const t0 = now();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const r = await runChild(job[0], job[1], seconds, job[2]);
      results.push(r);
      console.log(fightLine(r));
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  results.sort((a, b) => `${a.red}${a.blue}${a.seed}`.localeCompare(`${b.red}${b.blue}${b.seed}`));
  console.log(`\n${summarize(results)}\n(wall ${((now() - t0) / 1000).toFixed(0)} s)`);
  const out = arg('out', '');
  if (out) writeFileSync(out, JSON.stringify(results, null, 1));
}

await main();
