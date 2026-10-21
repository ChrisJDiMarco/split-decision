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
//   balance (§8 of docs/design/balance-engine.md)
//                               self-falls split by activity (stepping, standing, striking,
//                               kicking, rising), falls per 50 punches and per 10 kicks, torso
//                               rate below/above 3 Hz, tilt peak, pelvis height std, planned-COP
//                               jump per tick, DCM error, planted-leg servos at their limit, gyro
//                               saturation in footwork and free momentum at touchdown
//                               (tests/balance/recorder.ts; SD_BALANCE=legacy|dcm picks the path)
//   damage (strike-power.md §5.1) contact speed by striking surface, clean share, impulse / absorbed
//                               work per strike, joint health lost by channel and role, failures,
//                               injuries, dents per design, get-up times (tools/damage-metrics.ts)
//   mocap footwork (Phase 5)    share of swings that were clip steps (geometry and rhythm from the
//                               motion-matched clip), share followed (the planner's steps with the
//                               clip's clock and style on them), style-on share; SD_MOCAP_FOOTWORK=0|1
//   ring IQ (docs/design/ring-iq.md)
//                               time with the two bodies in contact while neither throws and neither
//                               asks for a clinch; time at outside / edge / pocket range; strikes
//                               started out of their range (too far, too close); share of pocket
//                               entries made with a strike; strikes thrown per minute
//
// usage:
//   npx tsx tools/fight-metrics.ts [--seconds 120] [--seeds 1,2,3] [--designs bruiser,striker,goliath]
//                                  [--jobs 3] [--out file.json]      every ordered matchup, in parallel
//   npx tsx tools/fight-metrics.ts --pairs savate:haymaker,firecracker:pylon [--seconds 90] [--seeds 1,2]
//   npx tsx tools/fight-metrics.ts --fight <red> <blue> <seconds> <seed> [--json] [--log]
//   any of the above with --balance legacy|dcm (the balance path the fights run on)
//   and --mocap steps|1|0|style (mocap footwork on the dcm path: clip steps (the default), with the
//   style layer, neither, style only)
//   SD_TUNE='MOCAP_STYLE.arms=0,BALANCE_TUNING.kp=1.8' sets tuning-table values in every fight
//   --mind sparring|house   who decides: the sparring stand-in (default; an intent every 0.5 s) or
//                           the real Brain with the House Mind (src/brain, no network: combos, setups,
//                           feints, reflexes), fed 60 Hz telemetry with the game's 0.3 s reaction delay
//   --combos body           House Mind runs: drop the brain-sequenced combo steps (what the brain would
//                           send with COMBO_SEQUENCING = 'body'; the body runs each combination whole)
//   reactions (Phase 4, tests/balance/reaction-recorder.ts): blows the body felt, absorbs, pre-braces, braces;
//   recoveries (steps, time to steady); falls (brace before the first non-foot contact, what touched first);
//   get-ups (first movement and fall to stable standing)
//   pace (tests/balance/pace-recorder.ts): idle-in-range share and why, the first two-way exchange,
//   committed strikes per minute, combo completion, feint reads and bites against a no-feint baseline
import loadMujoco from '@mujoco/mujoco';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Brain } from '../src/brain/brain';
import { JevLink } from '../src/brain/link';
import type { RobotTelemetry, SimEvent, TargetZone, WorldMeta } from '../src/core/protocol';
import type { Corner, MatchSetup } from '../src/core/types';
import { controllerOf, controlSystem, sparringIntent } from '../src/physics/control';
import { COM_REF } from '../src/physics/control/balance/com-ref';
import { FOOTWORK_TUNING } from '../src/physics/control/balance/footsteps';
import { BALANCE_TUNING, KICK_GATE, LUNGE } from '../src/physics/control/balance/index';
import { MOCAP_STEPS } from '../src/physics/control/balance/mocap-steps';
import { MOCAP_STYLE } from '../src/physics/control/balance/mocap-style';
import { anyContact } from '../src/physics/control/contacts';
import { KICK_RBAL, ROUTE, STRIKE_P3 } from '../src/physics/control/mocap/strikes';
import { STRIKE_PATH } from '../src/physics/control/strike-path';
import { INVERSE_DYNAMICS } from '../src/physics/control/feedforward';
import { IMPEDANCE } from '../src/physics/control/balance/impedance';
import { GYRO_POLICY } from '../src/physics/control/balance/gyro-policy';
import { STEP_ADJUST } from '../src/physics/control/balance/step-adjust';
import { REACTIONS } from '../src/physics/control/balance/reactions';
import { BEHAVIOURS } from '../src/physics/control/balance/behaviours';
import { GETUP_SPEED } from '../src/physics/control/getup-speed';
import { RingIq, type Zone } from '../src/physics/control/ring-iq';
import type { SkillRun } from '../src/physics/control/skills/types';
import { buildContext } from '../src/physics/runtime';
import type { SimContext, SimSystem } from '../src/physics/sim-context';
import { SYSTEMS } from '../src/physics/systems';
import { buildTelemetry } from '../src/physics/systems/telemetry';
import { compileWorld } from '../src/physics/world';
import { exchanges, PaceRecorder, type PaceReport } from '../tests/balance/pace-recorder';
import { activityOf, BalanceRecorder, type BalanceMetrics } from '../tests/balance/recorder';
import { ReactionRecorder, summarizeReactions, type ReactionMetrics } from '../tests/balance/reaction-recorder';
import { DamageRecorder, damageSummary, type FighterDamage } from './damage-metrics';

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
const ENTRY_STRIKE_S = 0.3; // a strike starting this soon after a pocket entry counts as entering with it
const FRAME_S = 1 / 60; // House Mind runs: telemetry frames to the brains at this rate
const HOUSE_TEMPERAMENT = 1.2; // the game's corners default to 1.1 and 1.3

interface ImpactRec {
  t: number;
  striker: number;
  victim: number;
  part: string | null;
  impulse: number;
}

interface FallRec {
  t: number;
  activity: string; // stepping, standing, striking, kicking, rising, victory
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
  /** The footing it started from: 'step' (a foot in the air), 'moving' (two feet, COM over 0.3 m/s), 'set'. */
  footing?: 'step' | 'moving' | 'set';
}

interface RingReport {
  /** Seconds sampled on the feet (the denominator of the zone shares). */
  seconds: number;
  zones: Record<Zone, number>; // seconds
  contactS: number; // seconds in contact, neither striking nor asking for a clinch
  started: number; // strikes started
  tooFar: number; // ...from beyond their range
  tooClose: number; // ...from inside it
  entries: number; // times this fighter came into the pocket
  entriesWithStrike: number; // ...with a strike of his under way (or starting within ENTRY_STRIKE_S)
}

interface FighterReport {
  corner: number;
  design: string;
  ring: RingReport;
  falls: FallRec[];
  strikes: { thrown: number; committed: number; landed: number; headTargeted: number; headLanded: number; byId: Record<string, { thrown: number; landed: number; falls: number }>; byFooting?: Record<string, { committed: number; landed: number }> };
  approach: { metres: number; seconds: number; speed: number };
  selfKd: { strict: number; loose: number };
  getUp: { falls: number; counted: number; up: number; solid: number; censored: number; meanS: number };
  downS: number;
  steps: number;
  captureSteps: number;
  gyroSatMean: number;
  gyroSatMax: number;
  balance: BalanceMetrics;
  /** Phase 4 reactions: blows felt, recoveries, braces, what landed first, get-up times (tests/balance/reaction-recorder.ts). */
  reactions?: ReactionMetrics;
  /** Strikes delivered and what the damage model did (tools/damage-metrics.ts). */
  damage?: FighterDamage;
}

export interface FightReport {
  balancePath: string;
  /** Who decided: 'sparring' (the stand-in) or 'house' (the Brain's House Mind). */
  mind?: string;
  /** Pacing (tests/balance/pace-recorder.ts). */
  pace?: PaceReport & { firstExchange: number | null; twoWay: number; committed: [number, number] };
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

const TUNABLES: Record<string, Record<string, unknown>> = { BALANCE_TUNING, FOOTWORK_TUNING, COM_REF, MOCAP_STEPS, MOCAP_STYLE, STRIKE_P3, STRIKE_PATH, LUNGE, ROUTE, KICK_GATE, KICK_RBAL, INVERSE_DYNAMICS, IMPEDANCE, GYRO_POLICY, STEP_ADJUST, REACTIONS, BEHAVIOURS, GETUP_SPEED };

/** SD_TUNE='TABLE.key=value,...': set numeric tunables before a fight (A/B runs, as balance-drills --tune). */
function applyTune(spec: string | undefined): void {
  if (!spec) return;
  for (const item of spec.split(',')) {
    const [path, raw] = item.split('=');
    const [table, key] = path.split('.');
    const t = TUNABLES[table];
    const v = Number(raw);
    if (!t || !(key in t) || typeof t[key] !== 'number' || !Number.isFinite(v)) throw new Error(`SD_TUNE: unknown or non-numeric ${item}`);
    t[key] = v;
  }
}

export async function runFight(red: string, blue: string, seconds: number, seed: number, log = false): Promise<FightReport> {
  applyTune(process.env.SD_TUNE);
  const mind = process.env.SD_MIND === 'house' ? 'house' : 'sparring';
  const temperament = mind === 'house' ? HOUSE_TEMPERAMENT : 1;
  const setup: MatchSetup = {
    fighters: [
      { design: red, skin: 'factory', plan: '', temperament },
      { design: blue, skin: 'neon', plan: '', temperament },
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
  const recorders = [new BalanceRecorder(ctx, 0, 0.3), new BalanceRecorder(ctx, 1, 0.3)];
  const reactRecs = ctx.robots.map((r) => (ctl[r.corner].engine ? new ReactionRecorder(ctx, r) : null));
  const pace = new PaceRecorder(ctl);
  // House Mind: the real Brain (src/brain), no network, fed telemetry frames; its intents land after
  // the game's reaction delay, as in the worker.
  const delayTicks = Math.round(setup.reactionDelayS / ctx.dt);
  const frameEvery = Math.max(1, Math.round(FRAME_S / ctx.dt));
  const frameEvents: SimEvent[] = [];
  // --combos body: what COMBO_SEQUENCING = 'body' (src/brain/sequencer.ts) would send: the combination
  // intent only, none of the brain-sequenced steps (the brain still holds its cadence while its plan runs).
  const bodyCombos = process.env.SD_COMBOS === 'body';
  const brains = mind === 'house' ? houseBrains(ctx, setup, (c, intent, issuedAtTick) => {
    if (bodyCombos && intent.comboPlan?.step !== undefined) return;
    ctx.robots[c].pendingIntents.push({ applyAtTick: Math.max(ctx.tick, issuedAtTick + delayTicks), intent });
  }) : [];
  const damageRec = new DamageRecorder(ctx);
  // Ring IQ: each fighter's own zones (his strikes, the other's reach), body-to-body contact.
  const rings = ctl.map((c) => new RingIq(c));
  const ringRep: RingReport[] = [0, 1].map(() => ({ seconds: 0, zones: { outside: 0, edge: 0, pocket: 0 }, contactS: 0, started: 0, tooFar: 0, tooClose: 0, entries: 0, entriesWithStrike: 0 }));
  const lastZone: Array<Zone | null> = [null, null];
  const pendingEntry: number[] = [-1, -1]; // time of a pocket entry still waiting for its strike
  const geomOwner = new Map<number, number>();
  for (const r of ctx.robots) for (const part of r.parts.values()) for (const g of part.geoms) geomOwner.set(g, r.corner);
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
          t: ctx.time, activity: activityOf(history[c], ctx.time), selfStrict: strictHit <= SELF_KD_IMPULSE_NS, selfLoose: looseHit <= SELF_KD_IMPULSE_NS, maxHitNs: strictHit,
          doing, gyroPeak, getupAt: null, refellAt: null, outcome: 'censored', solid: null,
        });
        if (current[c]) closeStrike(c);
        timeline.push(`${stamp()}s  ${name(c)} DOWN${strictHit <= SELF_KD_IMPULSE_NS ? ' (self)' : ` (hit ${strictHit.toFixed(0)} N·s)`} ${activityOf(history[c], ctx.time)}, doing ${doing.join(',')} gyro ${gyroPeak.toFixed(2)}`);
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
    if (!brains.length && i % intentEvery === 0) for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
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
    for (const rec of recorders) rec.sample(ctx);
    for (const rec of reactRecs) rec?.sample(ctx);
    for (const e of ctx.events) {
      onEvent(e);
      damageRec.onEvent(e, ctx.time);
    }
    if (brains.length) frameEvents.push(...ctx.events);
    ctx.events.length = 0;
    if (brains.length && ctx.tick % frameEvery === 0) {
      const telemetry = [buildTelemetry(ctx, ctx.robots[0], SYSTEMS), buildTelemetry(ctx, ctx.robots[1], SYSTEMS)] as [RobotTelemetry, RobotTelemetry];
      const events = frameEvents.splice(0);
      for (const b of brains) b.onFrame({ tick: ctx.tick, time: ctx.time, events, telemetry });
      await Promise.resolve();
    }

    // Strike runs: one record per strike skill run, closed when the runner lets go of it.
    for (const c of [0, 1]) {
      const run = ctl[c].skills.run;
      if (current[c] && current[c]!.run !== run) closeStrike(c);
      if (run && !current[c] && (run.def.kind === 'arm' || run.def.kind === 'leg')) {
        const me = ctx.robots[c], him = ctx.robots[1 - c];
        const sc = ctx.data.subtree_com as Float64Array;
        const d = Math.hypot(sc[him.rootBody * 3] - sc[me.rootBody * 3], sc[him.rootBody * 3 + 1] - sc[me.rootBody * 3 + 1]);
        const [lo, hi] = run.def.range(ctl[c].geo);
        const rr = ringRep[c];
        rr.started++;
        // A blow started from a step (the balance engine's step-in strike) is judged where the step
        // lands: the DCM at the touchdown, to his COM.
        const st = ctl[c].engine?.state as { xiTouch?: [number, number] } | undefined;
        const dLand = st?.xiTouch && ctl[c].gait.phase === 'single' ? Math.hypot(sc[him.rootBody * 3] - st.xiTouch[0], sc[him.rootBody * 3 + 1] - st.xiTouch[1]) : d;
        if (Math.min(d, dLand) > hi) rr.tooFar++;
        else if (d < lo) rr.tooClose++;
        if (pendingEntry[c] >= 0 && ctx.time - pendingEntry[c] <= ENTRY_STRIKE_S) {
          rr.entriesWithStrike++;
          pendingEntry[c] = -1;
        }
        current[c] = {
          run,
          rec: {
            id: run.def.id, zone: run.zone, start: ctx.time, end: ctx.time, committed: false, runnerLanded: false, landedAt: null, maxImpulse: 0, headImpulse: 0, landed: false,
            footing: ctl[c].gait.phase === 'single' ? 'step' : Math.hypot((ctx.data.subtree_linvel as Float64Array)[me.rootBody * 3], (ctx.data.subtree_linvel as Float64Array)[me.rootBody * 3 + 1]) > 0.3 ? 'moving' : 'set',
          },
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
      pace.sample(ctx, dt);
      const com = ctx.data.subtree_com as Float64Array;
      const vel = ctx.data.subtree_linvel as Float64Array;
      // Body to body contact with neither throwing nor asking for a clinch: walking into the guards.
      const striking = (c: number) => { const k = ctl[c].skills.run?.def.kind; return k === 'arm' || k === 'leg' || k === 'grapple'; };
      const clinch = (c: number) => ctx.robots[c].intent?.tactic === 'clinch';
      const idle = !striking(0) && !striking(1) && !clinch(0) && !clinch(1) && !ctx.robots[0].down && !ctx.robots[1].down;
      const touching = idle && anyContact(ctx.data, (g1, g2) => {
        const a = geomOwner.get(g1), b = geomOwner.get(g2);
        return a !== undefined && b !== undefined && a !== b;
      });
      for (const c of [0, 1]) {
        const r = ctx.robots[c], o = ctx.robots[1 - c];
        const a = r.rootBody * 3, b = o.rootBody * 3;
        const dx = com[b] - com[a], dy = com[b + 1] - com[a + 1];
        const dist = Math.hypot(dx, dy);
        if (!r.down && !o.down && !ctl[c].getUp.active && !ctl[c].rising) {
          const rr = ringRep[c];
          const z = RingIq.zoneAt(rings[c].read(ctx.time), dist);
          rr.seconds += dt;
          rr.zones[z] += dt;
          if (touching) rr.contactS += dt;
          if (z === 'pocket' && lastZone[c] !== null && lastZone[c] !== 'pocket') {
            rr.entries++;
            if (striking(c)) rr.entriesWithStrike++;
            else pendingEntry[c] = ctx.time;
          }
          if (pendingEntry[c] >= 0 && ctx.time - pendingEntry[c] > ENTRY_STRIKE_S) pendingEntry[c] = -1;
          lastZone[c] = z;
        } else lastZone[c] = null;
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
      ring: ringRep[c],
      falls: falls[c],
      strikes: {
        thrown: list.length,
        committed: list.filter((s) => s.committed).length,
        landed: list.filter((s) => s.landed).length,
        headTargeted: list.filter((s) => s.landed && s.zone === 'head').length,
        headLanded: list.filter((s) => s.landed && s.zone === 'head' && s.headImpulse > 0).length,
        byId,
        byFooting: list.filter((s) => s.committed).reduce<Record<string, { committed: number; landed: number }>>((m, s) => {
          const k = s.footing ?? 'set';
          const b = (m[k] ??= { committed: 0, landed: 0 });
          b.committed++;
          if (s.landed) b.landed++;
          return m;
        }, {}),
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
      balance: recorders[c].result(),
      reactions: reactRecs[c]?.result(),
      damage: damageRec.fighter(c as 0 | 1),
    };
  });
  const landedAll = strikes.flat().filter((s) => s.landed);
  const firstLanded = landedAll.reduce<number | null>((m, s) => (s.landedAt !== null && (m === null || s.landedAt < m) ? s.landedAt : m), null);
  const lastFall = koCorner !== null ? falls[koCorner][falls[koCorner].length - 1] : undefined;
  blocks.sort((a, b) => a - b);
  const starts = [0, 1].map((c) => strikes[c].filter((s) => s.committed).map((s) => s.start)) as [number[], number[]];
  const ex = exchanges(starts);
  return {
    balancePath: `${process.env.SD_BALANCE ?? 'default'}${process.env.SD_MOCAP_FOOTWORK ? ` mocap ${process.env.SD_MOCAP_FOOTWORK}` : ''}${process.env.SD_RING_IQ ? ` ring ${process.env.SD_RING_IQ}` : ''}`,
    mind,
    pace: { ...pace.finish(), firstExchange: ex.first, twoWay: ex.twoWay, committed: [starts[0].length, starts[1].length] },
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

/** Two Brains on the House Mind (src/brain: no network), as tests/brain/measure-iq.ts runs them. */
function houseBrains(ctx: SimContext, setup: MatchSetup, onIntent: (c: Corner, intent: NonNullable<SimContext['robots'][number]['intent']>, issuedAtTick: number) => void): Brain[] {
  const link = new JevLink({ ask: () => Promise.reject(new Error('offline: House Mind')), retryMs: 1e9 });
  const meta: WorldMeta = {
    nbody: 0, timestep: ctx.dt, props: [],
    robots: ([0, 1] as Corner[]).map((corner) => ({ corner, design: setup.fighters[corner].design, prefix: '', parts: [] })),
  };
  const brains = ([0, 1] as Corner[]).map((corner) => new Brain({ corner, meta, seed: setup.seed, link, source: 'house', fighter: setup.fighters[corner], onIntent }));
  for (const b of brains) b.start();
  return brains;
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
  // Balance (§8): self-falls by activity, falls per strike, smoothness and effort.
  const byActivity = new Map<string, number>();
  for (const { x } of fs) for (const fl of x.falls) if (fl.selfStrict) byActivity.set(fl.activity, (byActivity.get(fl.activity) ?? 0) + 1);
  const stepStand = (byActivity.get('stepping') ?? 0) + (byActivity.get('standing') ?? 0);
  let punches = 0, punchFalls = 0, kicks = 0, kickFalls = 0;
  for (const { x } of fs) {
    for (const [id, st] of Object.entries(x.strikes.byId)) {
      if (['front_kick', 'low_kick', 'head_kick'].includes(id)) { kicks += st.thrown; kickFalls += st.falls; }
      else { punches += st.thrown; punchFalls += st.falls; }
    }
  }
  const bm = fs.map(({ x }) => x.balance).filter(Boolean);
  const avg = (k: keyof BalanceMetrics) => bm.reduce((a, m) => a + (m[k] as number), 0) / Math.max(1, bm.length);
  const worst = (k: keyof BalanceMetrics) => bm.reduce((a, m) => Math.max(a, m[k] as number), 0);
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
    'balance (docs/design/balance-engine.md §8):',
    `  self-falls by activity (strict, per fighter per 2 min): ${[...byActivity].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${perTwoMin(v).toFixed(2)} (${v})`).join(', ') || 'none'}`,
    `  self-falls while stepping or standing   ${stepStand}   target 0   ${ok(stepStand === 0)}`,
    `  falls per 50 punches / per 10 kicks      ${((50 * punchFalls) / Math.max(1, punches)).toFixed(1)} (${punchFalls}/${punches}) / ${((10 * kickFalls) / Math.max(1, kicks)).toFixed(1)} (${kickFalls}/${kicks})   target <= 1 / <= 1`,
    `  torso rate below / above 3 Hz            ${avg('torsoRateLow').toFixed(2)} / ${avg('torsoRateHigh').toFixed(2)} rad/s RMS`,
    `  tilt peak beyond lean                    mean ${avg('tiltPeakDeg').toFixed(1)}°, worst ${worst('tiltPeakDeg').toFixed(1)}°`,
    `  pelvis height std (no skill running)     ${avg('pelvisStdCm').toFixed(2)} cm`,
    `  planned-COP jump per tick                worst ${worst('copJumpCm').toFixed(1)} cm, p99 ${avg('copJumpP99Cm').toFixed(1)} cm`,
    `  DCM error RMS                            ${avg('dcmErrCm').toFixed(1)} cm`,
    `  planted-leg servo at limit (no skill)    ${pct(avg('servoLimitShare'))}`,
    `  gyro saturation (no skill) / at touchdown free   ${avg('gyroSatFootwork').toFixed(2)} / ${avg('reserveAtTouchdown').toFixed(2)}`,
    `  single support inside 2 m                ${pct(avg('singleInside2'))}`,
    ...damageSummary(fights),
    ...(fs.some(({ x }) => x.reactions) ? summarizeReactions(fs.flatMap(({ x }) => (x.reactions ? [x.reactions] : [])), perTwoMin) : []),
    'mocap footwork (Phase 5):',
    `  clip steps ${pct(avg('clipLiftShare'))} of swings (+${pct(avg('followLiftShare'))} the planner's, clip clock following), clip-driven ${pct(avg('clipMoveShare'))} of moving time, style on ${pct(avg('styleShare'))} of the time up`,
    ...ringLines(fs.map(({ x }) => x), minutes),
    ...paceLines(fights, minutes),
  ];
  return lines.join('\n');
}

function ringLines(fs: FighterReport[], minutes: number): string[] {
  const rs = fs.map((f) => f.ring).filter(Boolean);
  if (!rs.length) return [];
  const sum = (k: (r: RingReport) => number) => rs.reduce((a, r) => a + k(r), 0);
  const secs = Math.max(1e-6, sum((r) => r.seconds));
  const started = sum((r) => r.started);
  return [
    'ring IQ (docs/design/ring-iq.md):',
    `  time at outside / edge / pocket          ${pct(sum((r) => r.zones.outside) / secs)} / ${pct(sum((r) => r.zones.edge) / secs)} / ${pct(sum((r) => r.zones.pocket) / secs)}`,
    `  contact with no strike and no clinch     ${(sum((r) => r.contactS) / 2).toFixed(1)} s (${pct(sum((r) => r.contactS) / secs)} of the time)   target about 0`,
    `  strikes started too far / too close      ${sum((r) => r.tooFar)} / ${sum((r) => r.tooClose)} of ${started}`,
    `  pocket entries with a strike             ${pct(sum((r) => r.entriesWithStrike) / Math.max(1, sum((r) => r.entries)))} (${sum((r) => r.entriesWithStrike)}/${sum((r) => r.entries)})`,
    `  strikes thrown per minute (both)         ${(started / Math.max(1e-6, minutes)).toFixed(1)}`,
  ];
}

function footingLine(fights: FightReport[]): string {
  const by = new Map<string, { committed: number; landed: number }>();
  for (const f of fights) for (const x of f.fighters) for (const [k, v] of Object.entries(x.strikes.byFooting ?? {})) {
    const b = by.get(k) ?? { committed: 0, landed: 0 };
    b.committed += v.committed;
    b.landed += v.landed;
    by.set(k, b);
  }
  return [...by].map(([k, v]) => `${k} ${v.committed} (${pct(v.landed / Math.max(1, v.committed))})`).join(', ') || '-';
}

function outLine(fs: PaceReport['fighters'][number][]): string {
  const m = new Map<string, number>();
  for (const x of fs) for (const [k, v] of Object.entries(x.outOfRange ?? {})) m.set(k, (m.get(k) ?? 0) + v);
  const tot = [...m.values()].reduce((a, b) => a + b, 0);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${pct(v / Math.max(1e-6, tot))}`).join(', ') || '-';
}

/** Pacing and commitment (tests/balance/pace-recorder.ts). */
function paceLines(fights: FightReport[], minutes: number): string[] {
  const ps = fights.filter((f) => f.pace);
  if (!ps.length) return [];
  const fs = ps.flatMap((f) => f.pace!.fighters);
  const sum = (k: (x: (typeof fs)[number]) => number) => fs.reduce((a, x) => a + k(x), 0);
  const inRange = Math.max(1e-6, sum((x) => x.inRangeS));
  const idle = sum((x) => x.idleS);
  const by = new Map<string, number>();
  for (const x of fs) for (const [k, v] of Object.entries(x.idleBy)) by.set(k, (by.get(k) ?? 0) + (v ?? 0));
  const committed = ps.reduce((a, f) => a + f.pace!.committed[0] + f.pace!.committed[1], 0);
  const twoWay = ps.reduce((a, f) => a + f.pace!.twoWay, 0);
  const firstEx = ps.map((f) => f.pace!.firstExchange ?? f.length);
  const cs = { started: sum((x) => x.combos.started), completed: sum((x) => x.combos.completed), steps: sum((x) => x.combos.steps), thrown: sum((x) => x.combos.stepsThrown) };
  const closed = new Map<string, number>();
  for (const x of fs) for (const [k, v] of Object.entries(x.combos.closedBy)) closed.set(k, (closed.get(k) ?? 0) + v);
  const fe = { asked: sum((x) => x.feints.asked), windups: sum((x) => x.feints.windups), reads: sum((x) => x.feints.reads), bites: sum((x) => x.feints.bites) };
  const lv = new Map<string, { reads: number; bites: number }>();
  for (const x of fs) for (const [k, v] of Object.entries(x.feints.byLevel)) { const a = lv.get(k) ?? { reads: 0, bites: 0 }; a.reads += v.reads; a.bites += v.bites; lv.set(k, a); }
  const re = new Map<string, number>();
  for (const x of fs) for (const [k, v] of Object.entries(x.feints.reactions)) re.set(k, (re.get(k) ?? 0) + v);
  const base = { windows: sum((x) => x.baseline.windows), bites: sum((x) => x.baseline.bites) };
  const minds = [...new Set(ps.map((f) => f.mind ?? 'sparring'))].join(', ');
  return [
    `pace (${minds}):`,
    `  committed strikes per minute (both)      ${(committed / Math.max(1e-6, minutes)).toFixed(1)}   target >= 30 thrown, >= 20 landed`,
    `    by footing (committed, landed share): ${footingLine(ps)}`,
    `  idle in range                            ${pct(idle / inRange)} of ${inRange.toFixed(0)} fighter-s in range   target <= 20%`,
    `    why: ${[...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / Math.max(1e-6, idle))}`).join(', ') || '-'}`,
    `    out of its range by: ${outLine(fs)}`,
    `  first two-way exchange                   median ${median(firstEx).toFixed(1)} s; strikes traded within 1 s of one of his ${pct(twoWay / Math.max(1, committed))}`,
    `  combos                                   ${cs.started} started, ${pct(cs.completed / Math.max(1, cs.started))} complete, steps thrown ${pct(cs.thrown / Math.max(1, cs.steps))} (${[...closed].map(([k, v]) => `${k} ${v}`).join(', ') || '-'})`,
    `  feints                                   ${fe.asked} asked, ${fe.windups} windups on a feint intent, ${fe.reads} read, bit ${pct(fe.bites / Math.max(1, fe.reads))} (${[...lv].map(([k, v]) => `${k} ${v.bites}/${v.reads}`).join(', ') || '-'}; ${[...re].map(([k, v]) => `${k} ${v}`).join(', ') || '-'})`,
    `  no-feint baseline                        ${pct(base.bites / Math.max(1, base.windows))} of ${base.windows} windows`,
  ];
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
  const balance = arg('balance', '');
  if (balance) process.env.SD_BALANCE = balance; // the fight children read it at load
  const mocap = arg('mocap', '');
  if (mocap) process.env.SD_MOCAP_FOOTWORK = mocap; // likewise (1 | 0 | steps | style)
  const ring = arg('ring', '');
  if (ring) process.env.SD_RING_IQ = ring; // ring IQ's footwork rules (1 | 0)
  const mind = arg('mind', '');
  if (mind) process.env.SD_MIND = mind; // sparring | house
  const combos = arg('combos', '');
  if (combos) process.env.SD_COMBOS = combos; // brain | body (House Mind runs: see runFight)
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
  // --pairs savate:haymaker,firecracker:pylon runs just those matchups (red:blue), else every ordered pair.
  const pairs = arg('pairs', '').split(',').filter(Boolean).map((p) => p.split(':') as [string, string]);
  if (pairs.length) for (const [red, blue] of pairs) for (const seed of seeds) queue.push([red, blue, seed]);
  else for (const red of designs) for (const blue of designs) if (red !== blue) for (const seed of seeds) queue.push([red, blue, seed]);
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
