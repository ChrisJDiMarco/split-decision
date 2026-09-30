// Referee-break check: headless fights through the real physics systems (as tools/fight-metrics.ts
// runs them), measuring what happens while a fighter is on the canvas. The break is tracked here
// independently of src/physics/systems/referee.ts: it starts on a 'fall' and ends at a KO, or at
// FIGHT: the referee's 'fight' event when the referee runs, and the moment every fighter has been
// off the canvas for GRACE_S without it (--no-referee: when the fight would resume on its own).
// 'up' (every fighter off the canvas GRACE_S) is recorded either way, so the same numbers compare.
//
//   strikes     started by the standing fighter while his opponent is down or rising, and started
//               by anyone during a break; impacts on a downed fighter, split into in-flight (the
//               strike started before the break), illegal (started during it) and body contact
//   room        standing fighter's COM distance from the downed one: at the fall, minimum, at FIGHT,
//               time to reach NEUTRAL_M; fence clearance (min, seconds under PIN_M)
//   get-ups     fall → up, fall → FIGHT, the wait for room between them, fully up within KO_DOWN_S
//               (success rate), knockdowns and KOs; a fall within REFALL_S of FIGHT; how soon they
//               re-engage after FIGHT (closer than ENGAGED_M, a first strike)
//   self-falls  the standing fighter falling during a break
//   cost        control (and referee, when present) µs per robot per physics step
//   referee     'break' / 'fight' events from SimContext.referee.log (0/0 before the rule existed),
//               the FIGHT reasons, and whether the telemetry published exactly the logged events
//   determinism --determinism runs chosen fights twice in separate processes and compares a
//               signature of every event and the final state
//
// Brains: 'finisher' mirrors the house-mind fallback today ("opponent down: close the distance,
// then a finisher"); 'sparring' is src/physics/control/sparring.ts. A forced knockdown shoves one
// fighter over at --forced-at seconds (0 = off) and watches the other. 'fence' (forced, finisher
// after the fall) keeps red on his spawn spot so blue falls between him and the centre (--no-fence skips it).
//
// usage:
//   npx tsx tools/referee-check.ts [--pairs savate:haymaker,...] [--seeds 1,2] [--seconds 90]
//        [--brains finisher,sparring] [--forced-at 6] [--forced-seconds 40] [--jobs 2]
//        [--determinism] [--no-referee] [--out file.json]
//   npx tsx tools/referee-check.ts --fight <red> <blue> <seconds> <seed> <brain> <forcedAt> [--json]
import loadMujoco from '@mujoco/mujoco';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APOTHEM, ARENA } from '../src/core/arena-spec';
import type { Intent, RefereeLogEvent, SimEvent, Tactic } from '../src/core/protocol';
import type { MatchSetup } from '../src/core/types';
import { controllerOf, sparringIntent } from '../src/physics/control';
import { KO_DOWN_S } from '../src/physics/damage/constants';
import { buildContext } from '../src/physics/runtime';
import type { RobotRuntime, SimContext, SimSystem } from '../src/physics/sim-context';
import { SYSTEMS } from '../src/physics/systems';
import { buildTelemetry } from '../src/physics/systems/telemetry';
import { compileWorld } from '../src/physics/world';

const INTENT_EVERY_S = 0.5;
const GRACE_S = 1.0; // fully up this long ends the break (matches the referee rule)
const NEUTRAL_M = 2.5; // the neutral distance the rule sends the standing fighter to
const NEUTRAL_TOL_M = 0.15;
const PIN_M = 0.5; // COM this close to a fence flat: pinned
const MIN_IMPACT_NS = 4; // the damage model's own event floor
const IMPACT_TAIL_S = 0.1;
const BLOWUP_QVEL = 400;
const SELF_IMPULSE_NS = 20;
const FORCE_DV = 1.6; // m/s of COM velocity in the shove (lateral)
const FORCE_S = 0.1;
const FORCE_ENGAGED_M = 1.1; // shove once they are in striking range...
const FORCE_WAIT_S = 6; // ...or this long after --forced-at regardless
const FINISH_CLOSE_M = 1.4;
const REFALL_S = 2; // a fall this soon after FIGHT: he was not really steady
const ENGAGED_M = 1.3; // re-engaged after FIGHT: this close...
const RESUME_WATCH_S = 10; // ...watched this long
const FRAME_STEPS = 33; // telemetry every ~33 ms, as the worker sends frames
// Mirrors src/brain/tactics.ts FINISHER_ORDER (house-mind's "opponent down: finish").
const FINISHER_ORDER: readonly Tactic[] = ['rocket_punch', 'hammer_smash', 'head_kick', 'overhand', 'jaw_crush', 'ram', 'hook', 'cross', 'uppercut', 'lunge', 'front_kick', 'low_kick', 'shield_bash', 'jab'];

type Brain = 'finisher' | 'sparring' | 'fence';

interface BreakRec {
  t0: number;
  t1: number | null;
  end: 'fight' | 'ko' | 'censored';
  down: number[]; // corners down at the start
  standing: number[];
  double: boolean;
  refalls: number; // a downed fighter falling again during his get-up
  pulled: number; // strikes in their windup at the fall that were abandoned before committing
  spotTurnDeg: number | null; // how far round the downed fighter the referee's first neutral spot is from straight back
  bearing0: number; // downed → standing at the fall
  startedVsDown: number; // strikes started by a standing fighter while the opponent was down/rising
  startedInBreak: number; // strikes started by anyone during the break
  startedIds: string[];
  landedInFlight: number;
  landedIllegal: number;
  contact: number; // body contact (no strike running) on the downed fighter
  distStart: number;
  distMin: number;
  distEnd: number;
  reachNeutralS: number | null;
  fenceMin: number;
  pinnedS: number;
  selfFalls: number;
  getupS: number | null; // fall → 'getup' (off the canvas, rising)
  upS: number | null; // fall → fully up (rise done)
  upGraceS: number | null; // fall → every fighter off the canvas GRACE_S (FIGHT without the referee)
  distUp: number | null; // distance at that moment
  reason: string | null; // the referee's FIGHT reason
  refallAfterFight: boolean; // someone fell within REFALL_S of FIGHT
  resumeCloseS: number | null; // FIGHT → closer than ENGAGED_M
  resumeStrikeS: number | null; // FIGHT → a strike started
}

interface FallRec { t: number; corner: number; forced: boolean; upAt: number | null; outcome: 'up' | 'late' | 'ko' | 'censored' }

export interface CheckReport {
  red: string;
  blue: string;
  seed: number;
  brain: Brain;
  forcedAt: number;
  forcedFell: boolean | null;
  seconds: number;
  length: number;
  end: string;
  breaks: BreakRec[];
  falls: FallRec[];
  kos: number;
  refereeEvents: { break: number; fight: number };
  fightReasons: Record<string, number>;
  eventsPublished: boolean | null; // telemetry carried exactly the logged events (null: no referee)
  controlUs: number;
  refereeUs: number;
  signature: string;
  wall: number;
  timeline: string[];
}

const now = () => performance.now();

function finisherIntent(ctx: SimContext, r: RobotRuntime): Intent {
  const base = sparringIntent(ctx, r);
  const opp = ctx.robots[1 - r.corner];
  if (r.down || !opp.down) return base;
  const c = ctx.data.subtree_com as Float64Array;
  const a = r.rootBody * 3, b = opp.rootBody * 3;
  const dist = Math.hypot(c[b] - c[a], c[b + 1] - c[a + 1]);
  const fin = FINISHER_ORDER.find((t) => r.design.abilities.includes(t as never)) ?? 'close_distance';
  return dist < FINISH_CLOSE_M
    ? { ...base, tactic: fin, target: 'head', aggression: 1, settledLocally: false }
    : { ...base, tactic: 'close_distance', target: 'head', aggression: 0.9, settledLocally: false };
}

/** COM distance to the nearest fence flat. */
function fenceClearance(x: number, y: number): number {
  let m = -Infinity;
  for (let k = 0; k < ARENA.SIDES; k++) {
    const a = (k / ARENA.SIDES) * Math.PI * 2;
    m = Math.max(m, x * Math.cos(a) + y * Math.sin(a));
  }
  return APOTHEM - m;
}

export async function runCheck(red: string, blue: string, seconds: number, seed: number, brain: Brain, forcedAt: number): Promise<CheckReport> {
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
  const cost: Record<string, number> = { control: 0, referee: 0 };
  // --no-referee: the same code without the referee system (no orders ever), the "before" of an A/B.
  const noReferee = process.argv.includes('--no-referee');
  const systems: SimSystem[] = SYSTEMS.filter((s) => !(noReferee && s.name === 'referee')).map((s) => {
    if (!(s.name in cost) || !s.pre) return s;
    const pre = s.pre;
    return { ...s, pre(c: SimContext) { const t0 = now(); pre(c); cost[s.name] += now() - t0; } };
  });
  for (const s of systems) s.init?.(ctx);
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  const ctl = ctx.robots.map((r) => controllerOf(r)!);

  const timeline: string[] = [];
  const stamp = () => ctx.time.toFixed(2).padStart(6);
  const name = (c: number) => ctx.robots[c].design.id;
  const hash = createHash('sha256');
  const breaks: BreakRec[] = [];
  const falls: FallRec[] = [];
  const refereeEvents = { break: 0, fight: 0 };
  const upSince = [0, 0];
  const strikeRun: Array<{ run: unknown; id: string; start: number; end: number | null; committed: boolean } | null> = [null, null];
  const lastStrike: Array<{ id: string; start: number; end: number } | null> = [null, null];
  const impacts: Array<{ t: number; victim: number; impulse: number }> = [];
  let cur: BreakRec | null = null;
  let resume: BreakRec | null = null; // the last break that ended in FIGHT, watched for REFALL_S / RESUME_WATCH_S
  let seenLog = 0;
  const published: RefereeLogEvent[][] = [[], []];
  let end = 'timeout';
  let kos = 0;
  let forcedFell: boolean | null = forcedAt > 0 ? false : null;
  let forceSteps = 0;
  let forceTries = 0;
  const forceStep = Math.round(forcedAt / ctx.dt);
  let pushFrom = -1; // tick of the first shove: once engaged (or FORCE_WAIT_S after forcedAt)
  let pushAt = -1; // sim time of the first shove
  const victim = 1;
  // 'fence': red guards on his spawn spot (2.1 m off centre) until the shove, so blue comes to him and
  // falls between him and the centre: backing straight off would put red in the fence.
  const guardIntent: Intent = { tactic: 'guard', target: 'head', aggression: 0.3, confidence: 1, source: 'fallback' };
  const pick = (c: SimContext, r: RobotRuntime): Intent =>
    brain === 'sparring' ? sparringIntent(c, r) : brain === 'fence' && r.corner === 0 && !forcedFell ? guardIntent : finisherIntent(c, r);

  const downNow = (c: number) => ctx.robots[c].down || ctl[c].getUp.active || ctl[c].rising;
  const comXY = (c: number): [number, number] => {
    const com = ctx.data.subtree_com as Float64Array;
    const b = ctx.robots[c].rootBody * 3;
    return [com[b], com[b + 1]];
  };
  const dist = () => {
    const [ax, ay] = comXY(0), [bx, by] = comXY(1);
    return Math.hypot(bx - ax, by - ay);
  };
  /** The strike (current or just ended) an impact by `c` at time t belongs to. */
  const strikeOf = (c: number, t: number) => {
    const s = strikeRun[c];
    if (s) return { id: s.id, start: s.start };
    const l = lastStrike[c];
    return l && t - l.end <= IMPACT_TAIL_S ? l : null;
  };

  const startBreak = (c: number) => {
    const d = dist();
    cur = {
      t0: ctx.time, t1: null, end: 'censored', down: [c], standing: [1 - c].filter((o) => !downNow(o)), double: downNow(1 - c),
      startedVsDown: 0, startedInBreak: 0, startedIds: [], landedInFlight: 0, landedIllegal: 0, contact: 0,
      distStart: d, distMin: d, distEnd: d, reachNeutralS: d >= NEUTRAL_M - NEUTRAL_TOL_M ? 0 : null,
      fenceMin: Infinity, pinnedS: 0, selfFalls: 0, refalls: 0, pulled: 0, spotTurnDeg: null, bearing0: 0, getupS: null, upS: null,
      upGraceS: null, distUp: null, reason: null, refallAfterFight: false, resumeCloseS: null, resumeStrikeS: null,
    };
    const [sx, sy] = comXY(1 - c), [dx, dy] = comXY(c);
    cur.bearing0 = Math.atan2(sy - dy, sx - dx);
    breaks.push(cur);
  };

  const onEvent = (e: SimEvent) => {
    hash.update(`${ctx.tick}:${e.kind}:${'corner' in e ? e.corner : ''}:${e.kind === 'impact' ? e.impulseNs.toFixed(6) : ''}|`);
    switch (e.kind) {
      case 'impact': {
        if (e.striker === null || e.victim === null || e.striker === e.victim || e.impulseNs < MIN_IMPACT_NS) return;
        impacts.push({ t: ctx.time, victim: e.victim, impulse: e.impulseNs });
        const b = cur as BreakRec | null;
        if (!b || !downNow(e.victim)) return;
        const s = strikeOf(e.striker, ctx.time);
        if (!s) b.contact++;
        else if (s.start <= b.t0) b.landedInFlight++;
        else b.landedIllegal++;
        timeline.push(`${stamp()}s  ${name(e.striker)} hits DOWNED ${name(e.victim)} ${e.part ?? '?'} ${e.impulseNs.toFixed(0)} N·s (${s ? `${s.id} ${s.start <= b.t0 ? 'in flight' : 'started in break'}` : 'contact'})`);
        return;
      }
      case 'fall': {
        const c = e.corner;
        const recent = impacts.filter((h) => h.victim === c && h.t >= ctx.time - 1.5).reduce((m, h) => Math.max(m, h.impulse), 0);
        const forced = forcedAt > 0 && c === victim && forceSteps > 0 && ctx.time - pushAt < 7 && !falls.some((f) => f.forced);
        if (forced) forcedFell = true;
        falls.push({ t: ctx.time, corner: c, forced, upAt: null, outcome: 'censored' });
        const r = resume as BreakRec | null;
        if (r && r.t1 !== null && ctx.time - r.t1 <= REFALL_S) {
          r.refallAfterFight = true;
          timeline.push(`${stamp()}s  ${name(c)} falls ${(ctx.time - r.t1).toFixed(2)} s after FIGHT`);
        }
        const b = cur as BreakRec | null;
        if (b) {
          if (b.down.includes(c)) b.refalls++;
          else b.double = true;
          if (b.standing.includes(c)) {
            b.selfFalls++;
            b.standing = b.standing.filter((s) => s !== c);
          }
          if (!b.down.includes(c)) b.down.push(c);
        } else startBreak(c);
        timeline.push(`${stamp()}s  ${name(c)} DOWN${forced ? ' (forced shove)' : recent > SELF_IMPULSE_NS ? ` (hit ${recent.toFixed(0)} N·s)` : ' (self)'}${b ? ' during a break' : ''}, dist ${dist().toFixed(2)} m`);
        return;
      }
      case 'getup': {
        const b = cur as BreakRec | null;
        if (b && b.getupS === null && b.down.includes(e.corner)) b.getupS = ctx.time - b.t0;
        timeline.push(`${stamp()}s  ${name(e.corner)} off the canvas (rising)`);
        return;
      }
      case 'ko': kos++; timeline.push(`${stamp()}s  KO ${name(e.corner)} (${e.reason})`); return;
      default: return;
    }
  };

  const steps = Math.round(seconds / ctx.dt);
  const intentEvery = Math.round(INTENT_EVERY_S / ctx.dt);
  const t0 = now();
  for (let i = 0; i < steps; i++) {
    if (i % intentEvery === 0) for (const r of ctx.robots) r.intent = pick(ctx, r);
    // Forced knockdown: shove the victim sideways (across the line between them) until he falls.
    if (forcedAt > 0 && pushFrom < 0 && i >= forceStep && (dist() < FORCE_ENGAGED_M || i >= forceStep + (brain === 'fence' ? 3 : 1) * FORCE_WAIT_S / ctx.dt)) {
      pushFrom = i;
      pushAt = ctx.time;
    }
    const pushing = pushFrom >= 0 && forcedFell === false && forceTries < 3;
    const torso = ctx.robots[victim].parts.get('torso')!.body;
    const xf = ctx.data.xfrc_applied as Float64Array;
    let fx = 0, fy = 0;
    if (pushing) {
      const into = (i - pushFrom) % 2000; // a shove every 2 s until one fells him
      if (into < FORCE_S / ctx.dt) {
        if (into === 0) forceTries++;
        const [ax, ay] = comXY(0), [bx, by] = comXY(1);
        const d = Math.max(1e-6, Math.hypot(bx - ax, by - ay));
        const f = ((FORCE_DV * (1 + 0.5 * (forceTries - 1))) * ctl[victim].mass) / FORCE_S;
        fx = (-(by - ay) / d) * f;
        fy = ((bx - ax) / d) * f;
        xf[torso * 6] += fx;
        xf[torso * 6 + 1] += fy;
        forceSteps++;
      }
    }
    for (const s of systems) s.pre?.(ctx);
    mj.mj_step(ctx.model, ctx.data);
    if (fx || fy) {
      xf[torso * 6] -= fx;
      xf[torso * 6 + 1] -= fy;
    }
    ctx.tick++;
    ctx.time += ctx.dt;
    let bad = false;
    for (let k = 0; k < ctx.model.nv; k++) if (!(Math.abs(ctx.data.qvel[k]) < BLOWUP_QVEL)) { bad = true; break; }
    if (bad) {
      end = 'blowup';
      timeline.push(`${stamp()}s  BLOW-UP`);
      break;
    }
    for (const s of systems) s.post?.(ctx);

    // Strike starts.
    for (const c of [0, 1]) {
      const run = ctl[c].skills.run;
      const sr = strikeRun[c];
      if (sr && sr.run !== run) {
        lastStrike[c] = { id: sr.id, start: sr.start, end: ctx.time };
        strikeRun[c] = null;
        const b = cur as BreakRec | null;
        if (b && sr.start <= b.t0 && !sr.committed) {
          b.pulled++;
          timeline.push(`${stamp()}s  ${name(c)} ${sr.id} pulled in its windup`);
        }
      }
      if (run && strikeRun[c] && run.phase !== 'windup') strikeRun[c]!.committed = true;
      if (run && !strikeRun[c] && (run.def.kind === 'arm' || run.def.kind === 'leg' || run.def.kind === 'grapple')) {
        strikeRun[c] = { run, id: run.def.id, start: ctx.time, end: null, committed: run.phase !== 'windup' };
        const r = resume as BreakRec | null;
        if (r && r.t1 !== null && r.resumeStrikeS === null && !cur) r.resumeStrikeS = ctx.time - r.t1;
        const b = cur as BreakRec | null;
        if (b) {
          b.startedInBreak++;
          if (downNow(1 - c)) b.startedVsDown++;
          b.startedIds.push(`${name(c)}.${run.def.id}`);
          timeline.push(`${stamp()}s  ${name(c)} STARTS ${run.def.id} in the break (opponent ${downNow(1 - c) ? 'down' : 'up'}, dist ${dist().toFixed(2)} m)`);
        }
      }
    }

    // Events after the strike starts: a strike the controller started in the same tick as the fall
    // (its update ran first) was started before anyone could know; it counts as in flight.
    for (const e of ctx.events) onEvent(e);
    ctx.events.length = 0;

    // Fully up, break room and break end.
    for (const c of [0, 1]) upSince[c] = downNow(c) || ctx.robots[c].koReason ? ctx.time : upSince[c];
    const b = cur as BreakRec | null;
    if (b) {
      const d = dist();
      const spot = b.standing.length ? ctx.referee?.spots[b.standing[0]] : null;
      if (spot && b.spotTurnDeg === null) {
        const o = comXY(b.down[0]);
        const turn = Math.atan2(spot[1] - o[1], spot[0] - o[0]) - b.bearing0;
        b.spotTurnDeg = Math.abs((Math.atan2(Math.sin(turn), Math.cos(turn)) * 180) / Math.PI);
        if (b.spotTurnDeg > 1) timeline.push(`${stamp()}s  neutral spot turned ${b.spotTurnDeg.toFixed(0)}° round him (fence), spot ${spot.map((v) => v.toFixed(2)).join(',')}`);
      }
      b.distMin = Math.min(b.distMin, d);
      b.distEnd = d;
      if (b.reachNeutralS === null && d >= NEUTRAL_M - NEUTRAL_TOL_M) b.reachNeutralS = ctx.time - b.t0;
      for (const s of b.standing) {
        if (downNow(s)) continue;
        const [x, y] = comXY(s);
        const fc = fenceClearance(x, y);
        b.fenceMin = Math.min(b.fenceMin, fc);
        if (fc < PIN_M) b.pinnedS += ctx.dt;
      }
      if (b.upS === null && b.down.every((c) => !downNow(c))) b.upS = ctx.time - b.t0;
      if (b.upGraceS === null && [0, 1].every((c) => ctx.time - upSince[c] >= GRACE_S)) {
        b.upGraceS = ctx.time - b.t0;
        b.distUp = d;
      }
      // FIGHT: the referee's call when he runs; else the moment everyone has been up GRACE_S.
      const log = ctx.referee?.log ?? [];
      const call = log.slice(seenLog).find((e) => e.kind === 'fight');
      seenLog = log.length;
      if (ctx.robots.some((r) => r.koReason)) {
        b.end = 'ko';
        b.t1 = ctx.time;
        cur = null;
      } else if (noReferee ? b.upGraceS !== null : call) {
        b.end = 'fight';
        b.t1 = ctx.time;
        b.reason = call && call.kind === 'fight' ? call.reason ?? null : null;
        cur = null;
        resume = b;
        timeline.push(`${stamp()}s  FIGHT (break ${(b.t1 - b.t0).toFixed(1)} s${b.reason ? `, ${b.reason}` : ''}, min dist ${b.distMin.toFixed(2)} m, at FIGHT ${d.toFixed(2)} m)`);
      }
    } else seenLog = ctx.referee?.log.length ?? 0;
    const r = resume as BreakRec | null;
    if (r && r.t1 !== null) {
      if (r.resumeCloseS === null && dist() < ENGAGED_M) r.resumeCloseS = ctx.time - r.t1;
      if (ctx.time - r.t1 > RESUME_WATCH_S || cur) resume = null;
    }
    // Telemetry as the worker sends it: what the referee publishes.
    if (i % FRAME_STEPS === 0) for (const c of [0, 1]) published[c].push(...(buildTelemetry(ctx, ctx.robots[c], systems).referee?.events ?? []));
    for (const f of falls) if (f.upAt === null && !downNow(f.corner) && f.t < ctx.time) f.upAt = ctx.time;
    const ko = ctx.robots.find((r) => r.koReason);
    if (ko) {
      end = ko.koReason!;
      break;
    }
  }
  const length = ctx.time;
  for (const c of [0, 1]) published[c].push(...(buildTelemetry(ctx, ctx.robots[c], systems).referee?.events ?? []));
  const logged = JSON.stringify(ctx.referee?.log ?? []);
  const eventsPublished = noReferee ? null : published.every((p) => JSON.stringify(p) === logged);
  const fightReasons: Record<string, number> = {};
  for (const e of ctx.referee?.log ?? []) if (e.kind === 'fight') fightReasons[e.reason ?? '?'] = (fightReasons[e.reason ?? '?'] ?? 0) + 1;
  for (const e of ctx.referee?.log ?? []) {
    refereeEvents[e.kind]++;
    timeline.push(`${e.time.toFixed(2).padStart(6)}s  referee ${e.kind === 'break' ? `BREAK (down ${e.down.join('+')})` : `FIGHT after ${e.breakS.toFixed(1)} s (${e.reason ?? '?'})`}`);
  }
  timeline.sort((a, b) => parseFloat(a) - parseFloat(b));
  for (const f of falls) {
    if (f.upAt !== null) f.outcome = f.upAt - f.t <= KO_DOWN_S ? 'up' : 'late';
    else if (ctx.robots[f.corner].koReason && f === falls.filter((g) => g.corner === f.corner).at(-1)) f.outcome = 'ko';
    else f.outcome = length - f.t >= KO_DOWN_S ? 'late' : 'censored';
  }
  const q = ctx.data.qpos as Float64Array;
  for (let k = 0; k < ctx.model.nq; k++) hash.update(q[k].toFixed(9));
  return {
    red, blue, seed, brain, forcedAt, forcedFell, seconds, length, end, breaks, falls, kos, refereeEvents, fightReasons, eventsPublished,
    controlUs: (cost.control * 1000) / Math.max(1, ctx.tick) / 2,
    refereeUs: (cost.referee * 1000) / Math.max(1, ctx.tick) / 2,
    signature: hash.digest('hex').slice(0, 16),
    wall: (now() - t0) / 1000,
    timeline,
  };
}

// ------------------------------------------------------------------ reporting

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');

function fightLine(r: CheckReport): string {
  const bs = r.breaks;
  return `${r.red} v ${r.blue} s${r.seed} ${r.brain}${r.forcedAt ? ` forced@${r.forcedAt}${r.forcedFell ? '' : ' (no fall)'}` : ''}: ${r.length.toFixed(1)} s ${r.end}, ` +
    `falls ${r.falls.length}, breaks ${bs.length} (fight ${bs.filter((b) => b.end === 'fight').length}), ` +
    `started vs down ${sum(bs.map((b) => b.startedVsDown))}, landed on down in-flight ${sum(bs.map((b) => b.landedInFlight))} illegal ${sum(bs.map((b) => b.landedIllegal))} contact ${sum(bs.map((b) => b.contact))}, ` +
    `min dist ${f2(Math.min(...bs.map((b) => b.distMin)))} m, ref events ${r.refereeEvents.break}/${r.refereeEvents.fight}, control ${r.controlUs.toFixed(1)} µs ref ${r.refereeUs.toFixed(2)} µs, sig ${r.signature}`;
}

export function summarize(rs: CheckReport[]): string {
  const bs = rs.flatMap((r) => r.breaks);
  const withStanding = bs.filter((b) => b.standing.length);
  const falls = rs.flatMap((r) => r.falls);
  const counted = falls.filter((f) => f.outcome !== 'censored');
  const up = counted.filter((f) => f.outcome === 'up');
  const minutes = sum(rs.map((r) => r.length)) / 60;
  const fightS = bs.filter((b) => b.end === 'fight' && b.t1 !== null).map((b) => b.t1! - b.t0);
  const reach = withStanding.map((b) => b.reachNeutralS);
  const fought = withStanding.filter((b) => b.end === 'fight' && b.t1 !== null);
  return [
    `${rs.length} runs, ${minutes.toFixed(1)} min, ${bs.length} breaks (${bs.filter((b) => b.double).length} double, ${sum(bs.map((b) => b.refalls))} refalls in the get-up, ends: fight ${bs.filter((b) => b.end === 'fight').length}, ko ${bs.filter((b) => b.end === 'ko').length}, censored ${bs.filter((b) => b.end === 'censored').length})`,
    `strikes started vs a downed opponent   ${sum(bs.map((b) => b.startedVsDown))}   (any start in a break ${sum(bs.map((b) => b.startedInBreak))}: ${[...new Set(bs.flatMap((b) => b.startedIds))].join(', ') || '-'})`,
    `strikes pulled in their windup         ${sum(bs.map((b) => b.pulled))}`,
    `impacts on a downed fighter            in-flight ${sum(bs.map((b) => b.landedInFlight))}, illegal ${sum(bs.map((b) => b.landedIllegal))}, body contact ${sum(bs.map((b) => b.contact))}`,
    `distance from the downed fighter       at fall median ${f2(median(withStanding.map((b) => b.distStart)))} m, min median ${f2(median(withStanding.map((b) => b.distMin)))} / worst ${f2(Math.min(...withStanding.map((b) => b.distMin)))} m, when he is up median ${f2(median(withStanding.filter((b) => b.distUp !== null).map((b) => b.distUp!)))} m`,
    `distance at FIGHT                      median ${f2(median(fought.map((b) => b.distEnd)))} m, min ${f2(Math.min(...fought.map((b) => b.distEnd)))} m, >= ${(NEUTRAL_M - NEUTRAL_TOL_M).toFixed(2)} m in ${fought.filter((b) => b.distEnd >= NEUTRAL_M - NEUTRAL_TOL_M).length}/${fought.length}`,
    `reach ${NEUTRAL_M} m                          ${reach.filter((x) => x !== null).length}/${reach.length} breaks, median ${f2(median(reach.filter((x): x is number => x !== null)))} s`,
    `neutral spot turned round him         ${withStanding.filter((b) => (b.spotTurnDeg ?? 0) > 1).length} breaks (max ${f2(Math.max(0, ...withStanding.map((b) => b.spotTurnDeg ?? 0)))}°)`,
    `fence                                  min clearance ${f2(Math.min(...withStanding.map((b) => b.fenceMin)))} m, pinned (< ${PIN_M} m) ${f2(sum(withStanding.map((b) => b.pinnedS)))} s total over ${withStanding.filter((b) => b.pinnedS > 0).length} breaks`,
    `fall → FIGHT                           median ${f2(median(fightS))} s (max ${f2(Math.max(...fightS))}), fall → fully up median ${f2(median(bs.filter((b) => b.upS !== null).map((b) => b.upS!)))} s, up ${GRACE_S} s → FIGHT median ${f2(median(fought.filter((b) => b.upGraceS !== null).map((b) => b.t1! - b.t0 - b.upGraceS!)))} s (max ${f2(Math.max(...fought.filter((b) => b.upGraceS !== null).map((b) => b.t1! - b.t0 - b.upGraceS!)))})`,
    `FIGHT reasons                          ${Object.entries(fought.reduce<Record<string, number>>((m, b) => ({ ...m, [b.reason ?? 'no referee']: (m[b.reason ?? 'no referee'] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
    `after FIGHT                            fell within ${REFALL_S} s ${fought.filter((b) => b.refallAfterFight).length}/${fought.length}, closer than ${ENGAGED_M} m median ${f2(median(fought.filter((b) => b.resumeCloseS !== null).map((b) => b.resumeCloseS!)))} s (${fought.filter((b) => b.resumeCloseS !== null).length}/${fought.length} within ${RESUME_WATCH_S} s), first strike median ${f2(median(fought.filter((b) => b.resumeStrikeS !== null).map((b) => b.resumeStrikeS!)))} s (${fought.filter((b) => b.resumeStrikeS !== null).length}/${fought.length})`,
    `get-up within ${KO_DOWN_S} s                    ${up.length}/${counted.length} (${counted.length ? ((100 * up.length) / counted.length).toFixed(0) : '-'}%), censored ${falls.length - counted.length}`,
    `knockdowns / KOs per fight             ${(falls.length / rs.length).toFixed(2)} / ${(sum(rs.map((r) => r.kos)) / rs.length).toFixed(2)} (ends: ${Object.entries(rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.end]: (m[r.end] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    `standing fighter self-falls in breaks  ${sum(bs.map((b) => b.selfFalls))}`,
    `control cost                           median ${f2(median(rs.map((r) => r.controlUs)))} µs per robot per step, referee ${median(rs.map((r) => r.refereeUs)).toFixed(3)} µs`,
    `blow-ups                               ${rs.filter((r) => r.end === 'blowup').length}`,
    `referee events published in telemetry  ${rs.filter((r) => r.eventsPublished === true).length}/${rs.filter((r) => r.eventsPublished !== null).length} runs exact`,
  ].join('\n');
}

// ------------------------------------------------------------------ CLI

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type Job = [string, string, number, number, Brain, number];

async function runChild(job: Job): Promise<CheckReport> {
  const script = fileURLToPath(import.meta.url);
  const [red, blue, secs, seed, brain, forcedAt] = job;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, '--fight', red, blue, String(secs), String(seed), brain, String(forcedAt), '--json', ...(process.argv.includes('--no-referee') ? ['--no-referee'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || !line) reject(new Error(`${job.join(' ')} exited ${code}`));
      else resolve(JSON.parse(line) as CheckReport);
    });
  });
}

async function main(): Promise<void> {
  const fi = process.argv.indexOf('--fight');
  if (fi >= 0) {
    const [red, blue, secs, seed, brain, forcedAt] = process.argv.slice(fi + 1, fi + 7);
    const report = await runCheck(red, blue, Number(secs), Number(seed), (brain ?? 'finisher') as Brain, Number(forcedAt ?? 0));
    if (process.argv.includes('--json')) console.log(JSON.stringify(report));
    else {
      console.log(report.timeline.join('\n'));
      console.log(fightLine(report));
      console.log(summarize([report]));
    }
    return;
  }
  const seconds = Number(arg('seconds', '90'));
  const seeds = arg('seeds', '1,2').split(',').map(Number);
  const brains = arg('brains', 'finisher,sparring').split(',') as Brain[];
  const forcedAt = Number(arg('forced-at', '6'));
  const forcedSeconds = Number(arg('forced-seconds', '40'));
  const jobs = Math.min(2, Math.max(1, Number(arg('jobs', '2')))); // never more than two heavy processes
  const pairs = arg('pairs', 'savate:haymaker,firecracker:pylon,haymaker:pylon,savate:firecracker').split(',').map((p) => p.split(':') as [string, string]);
  const queue: Job[] = [];
  for (const brain of brains) for (const [r, b] of pairs) for (const seed of seeds) queue.push([r, b, seconds, seed, brain, 0]);
  if (forcedAt > 0) for (const brain of brains) for (const [r, b] of pairs) queue.push([r, b, forcedSeconds, 1, brain, forcedAt]);
  if (forcedAt > 0 && !process.argv.includes('--no-fence')) for (const [r, b] of pairs) queue.push([r, b, forcedSeconds, 1, 'fence', 1]);
  if (process.argv.includes('--determinism')) {
    const [r, b] = pairs[0];
    queue.push([r, b, seconds, seeds[0], brains[0], 0], [r, b, forcedSeconds, 1, brains[0], forcedAt || 6]);
  }
  const results: CheckReport[] = [];
  const t0 = now();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const r = await runChild(job);
      results.push(r);
      console.log(fightLine(r));
      for (const l of r.timeline) if (/STARTS|DOWNED|FIGHT|DOWN|KO/.test(l)) console.log(`    ${l}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  const key = (r: CheckReport) => `${r.brain}|${r.red}|${r.blue}|${r.seed}|${r.forcedAt}|${r.seconds}`;
  results.sort((a, b) => key(a).localeCompare(key(b)));
  // Determinism: identical jobs must give identical signatures.
  const groups = new Map<string, string[]>();
  for (const r of results) groups.set(key(r), [...(groups.get(key(r)) ?? []), r.signature]);
  const repeated = [...groups].filter(([, s]) => s.length > 1);
  const unique = [...new Map(results.map((r) => [key(r), r])).values()];
  for (const brain of [...brains, 'fence' as const]) {
    const set = unique.filter((r) => r.brain === brain);
    const fights = set.filter((r) => !r.forcedAt);
    const forced = set.filter((r) => r.forcedAt);
    if (fights.length) console.log(`\n=== ${brain}: fights (${fights.length})\n${summarize(fights)}`);
    if (forced.length) console.log(`\n=== ${brain}: forced knockdowns (${forced.length})\n${summarize(forced)}`);
  }
  if (repeated.length) console.log(`\ndeterminism: ${repeated.map(([k, s]) => `${k} ${s.every((x) => x === s[0]) ? 'IDENTICAL' : `DIFFERENT ${s.join(' ')}`}`).join('; ')}`);
  console.log(`(wall ${((now() - t0) / 1000).toFixed(0)} s)`);
  const out = arg('out', '');
  if (out) writeFileSync(out, JSON.stringify(results, null, 1));
}

await main();
