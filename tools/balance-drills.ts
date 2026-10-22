// Balance drills (docs/design/balance-engine.md §8): headless, in the minimal world of
// tests/control/helpers.ts with the real physics systems (src/physics/systems), one drill per child
// process, at most --jobs at once. Every drill writes its numbers as JSON; the parent prints a summary
// against the section 8 targets and saves everything under tests/balance/.out/ (git-ignored).
//
//   approach   two fighters of one design, 3-6 m apart across the cage centre, each turned 0, ±15 or
//              ±30° off the line, both on close_distance (no strikes) for 14 s: they walk in and
//              hold. Both are measured. (The pace stage turns close_distance at the edge of range into
//              a step-in jab, tactics.ts PACE.edgeJabAggression: off here, the drill is footwork only.)
//   push       a lone fighter shoved at the torso for 0.1 s from 8 directions: standing, mid-swing
//              walking, or just arrived. ΔV rises by 0.1 m/s to the first fall (--quick: 1.1 m/s only).
//   shuffle    at 1.4 m from a standing opponent: a 0.4 m square (forward, back, left, right, each
//              back to the start), then circling each way.
//   strikes    (§8, "20 of each strike and kick at a standing opponent"; P3 speed and impact) every
//              strike ability of a design thrown --trials times at a mirror opponent standing in its
//              guard, from the distances its tactics throw it at (the skill's own throw window), a
//              little off-line each time: lands, contact speed and impulse (the damage model's impact
//              event), peak striker speed before contact, start to contact, elbow at contact, the
//              thrower's centre-of-mass speed into the shot, falls and capture steps.
//   hits       (§8, Phase 4) a lone fighter's torso or head hit with 20, 40 or 73 N·s (over 12 ms) from 8
//              directions: did it stay up, recovery steps, time to stable, the reaction modes it went through
//              (absorb, recover, brace); if it fell, as for falls
//   falls      a shove past capture (--fall-dvs, default 2.2 m/s) from 8 directions: when the brace started, what
//              touched the canvas first (canvas-contact.ts) and when, and the get-up after (first movement, stable)
//   getups     (strike-power.md §4.6) laid face down, on its back and on each side, dropped three ways: standing
//              within 5 s, first movement to stable standing against the per-design targets
//   poses      get-ups from recorded fall endings (--getup-poses file.jsonl, tests/balance/capture-falls.ts: how
//              fighters really lay in sparring fights when their get-up began): standing within 5 s and 10 s, the
//              hand-over to balance within 10 s (the fights' get-up success), each clip variant tried, by orientation
//   fight      (the fight-clean pass) fight conditions the other drills lack, every fall dissected by
//              tests/balance/fall-anatomy.ts (what started it, catch steps, brace, gyro):
//                exchange  two fighters 1.1 m apart in the drill world (no cage), both on the sparring
//                          stand-in's intents every 0.5 s: guard on guard, blows both ways, strikes from
//                          a step, combos of single strikes, absorbs, for --fight-s seconds
//                press     one fighter walks into the other's guard and ties him up (clinch, aggression 0.9)
//                          while he holds his guard: body, guard and leg contact, the pushes of the clinch range
//                replay    a sparring fight in the real arena (cage included), re-run deterministically to
//                          the recorded falls: each fall's anatomy and a state line every 0.1 s over the
//                          FIGHT_REPLAY_LEAD_S before it (--pairs savate:haymaker --seeds 1,2)
//              per trial: falls (self: no blow of his ≥ 20 N·s in the 1.5 s before), catch steps, time in
//              'recover', time with no sole pressing on the canvas, leg-on-leg contact, strikes, and the
//              balance metrics (§8) of both fighters
//
// usage:
//   npx tsx tools/balance-drills.ts [--drills approach,push,shuffle,strikes] [--designs firecracker,savate,haymaker,pylon]
//                                   [--trials 8] [--skills jab,cross,...] [--window range|guard] [--approach] [--guard down]
//                                   [--balance legacy|dcm] [--jobs 2] [--quick] [--label name] [--situations stance] [--ladder-from 0.6]
//   npx tsx tools/balance-drills.ts --drills hits,falls,getups [--impulses 20,40,73] [--hit-parts torso,head]
//                                   [--hit-situations stance,walk] [--fall-dvs 2.2] [--getup-seeds 3] [--getup-orients face_down,back]
//   npx tsx tools/balance-drills.ts --drills poses --getup-poses tests/balance/fixtures/fall-endings.jsonl [--getup-max 40]
//                                   [--getup-path legacy|dcm|all]   recorded fall endings (of the drill's own path by default)
//   npx tsx tools/balance-drills.ts --drills fight [--scenarios exchange,press] [--pairs savate:haymaker,...] [--seeds 1,2,...]
//                                   [--fight-s 12]       fight conditions (replay: --scenarios replay --fight-s 90)
//   npx tsx tools/balance-drills.ts --summary <saved.json>   re-print a saved run's summary
//   npx tsx tools/balance-drills.ts --job '<json>'        one drill in this process, JSON on stdout
//   --tune BALANCE_TUNING.stanceAnkleKp=1,FOOTWORK_TUNING.walkGapM=0.03   A/B a tuning table value
//   --mocap steps|1|0|style   mocap footwork (SD_MOCAP_FOOTWORK): clip steps (the default), steps and style, neither, style only
//   --ring 1|0                ring IQ's footwork rules (SD_RING_IQ)
//   --motors 'savate.elbow=qdd.rs03,...' [--centroid DIR]   an actuator variant (tools/motor-variants.ts) and its
//                             centroid tables (tools/mocap/centroid-tables.ts --motors ... --out DIR)
//   (the drill children set it before they run; the tables are the engine's exported tunables)
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimEvent } from '../src/core/protocol';
import type { Vec3 } from '../src/core/types';
import { controllerOf, controlSystem } from '../src/physics/control';
import { CONTROL } from '../src/physics/control/balance/config';
import { COM_REF } from '../src/physics/control/balance/com-ref';
import { FOOTWORK_TUNING } from '../src/physics/control/balance/footsteps';
import { GYRO_POLICY } from '../src/physics/control/balance/gyro-policy';
import { BALANCE_TUNING, KICK_GATE } from '../src/physics/control/balance/index';
import { INERTIA } from '../src/physics/control/balance/inertialize';
import { MOCAP_STEPS } from '../src/physics/control/balance/mocap-steps';
import { MOCAP_STYLE } from '../src/physics/control/balance/mocap-style';
import { STEP_ADJUST } from '../src/physics/control/balance/step-adjust';
import { COUNTER_YAW, YAW_TUNING } from '../src/physics/control/controller';
import { PACE } from '../src/physics/control/tactics';
import { isStrikeSkill, SKILLS, type SkillId } from '../src/physics/control/skills';
import { BURST } from '../src/physics/control/strike-drive';
import { INVERSE_DYNAMICS } from '../src/physics/control/feedforward';
import { IMPEDANCE } from '../src/physics/control/balance/impedance';
import { REACTIONS } from '../src/physics/control/balance/reactions';
import { BEHAVIOURS } from '../src/physics/control/balance/behaviours';
import { GETUP_SPEED } from '../src/physics/control/getup-speed';
import { TRUNK_LIMIT } from '../src/physics/control/balance/trunk-limit';
import { KICK_DRIVE, KICK_RBAL, KICK_SET, ROUTE, STRIKE_P3 } from '../src/physics/control/mocap/strikes';
import { STRIKE_PATH } from '../src/physics/control/strike-path';
import { LUNGE } from '../src/physics/control/balance/index';
import { ENGINE_KICK, MOCAP_KICKS } from '../src/physics/control/mocap/skills';
import { KICK_CONTACT } from '../src/physics/control/skills/kicks';
import type { SimContext, SimSystem } from '../src/physics/sim-context';
import { SYSTEMS } from '../src/physics/systems';
import { BalanceRecorder, type BalanceMetrics } from '../tests/balance/recorder';
import { CanvasContacts, contactClass } from '../tests/balance/canvas-contact';
import { polygonDistance } from '../src/physics/control/support';
import { applyMotorVariants } from './motor-variants';
import { comPos, intent, isDown, makeSim, type Sim } from '../tests/control/helpers';
import { FallAnatomy, summarizeAnatomy, type FallAnatomyRec } from '../tests/balance/fall-anatomy';
import { sparringIntent } from '../src/physics/control';
import { anyContact } from '../src/physics/control/contacts';
import { buildContext } from '../src/physics/runtime';
import { compileWorld } from '../src/physics/world';
import type { MatchSetup } from '../src/core/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'tests', 'balance', '.out');
const DEG = Math.PI / 180;
const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'];
const LEAN_S = 0.8; // standing still after release: the recorder measures the standing lean
const APPROACH_S = 14;
const PUSH_S = 0.1;
const PUSH_WATCH_S = 4;
const STABLE_SPEED = 0.3; // m/s and rad/s: Euphoria's "stable"
const STABLE_HOLD_S = 0.2;
const BLOWUP_QVEL = 400;

type Situation = 'stance' | 'walk' | 'arrive';
export type Orient = 'face_down' | 'back' | 'side_l' | 'side_r';
/** A recorded fall ending (tests/balance/capture-falls.ts): the root pose (x, y zeroed) and joint angles when the get-up began. */
export interface FallPose { orient: Orient; root: number[]; joints: Record<string, number>; src?: string }
export type Job =
  | { kind: 'approach'; design: string; dist: number; angle: number; seconds: number; seed: number }
  | { kind: 'push'; design: string; situation: Situation; dir: number; dv: number; seed: number }
  | { kind: 'shuffle'; design: string; seed: number }
  | { kind: 'strike'; design: string; skill: SkillId; trial: number; seed: number }
  | { kind: 'hit'; design: string; part: 'torso' | 'head'; impulse: number; dir: number; situation: Situation; seed: number }
  | { kind: 'fall'; design: string; dir: number; dv: number; seed: number }
  | { kind: 'getup'; design: string; orient: Orient; seed: number; pose?: FallPose }
  | { kind: 'fight'; scenario: FightScenario; design: string; opp: string; seed: number; seconds: number };

export type FightScenario = 'exchange' | 'press' | 'replay';

export interface ApproachOut { kind: 'approach'; job: Job; robots: BalanceMetrics[]; controlUs: number; blowup: boolean }
export interface PushOut { kind: 'push'; job: Job; survived: boolean; steps: number; stableAfter: number; satPeak: number; applied: boolean }
/** Getting up, in seconds after the fall was detected (Infinity: never). */
export interface GetupTimes {
  moveAt: number; // the get-up's first movement (the settle on the canvas is over)
  upAt: number; // balance takes over (the 'getup' event)
  stableAt: number; // standing, risen, upright at stance height, stable (held STAND_HOLD_S)
  attempts: number;
  fails?: string[]; // why each failed attempt failed (mocap/getup.ts), in order
}
/**
 * Phase 4 (§6, §8): a hit (an impulse at the torso or head) or a shove past capture. Times are seconds
 * after the hit or shove ended (Infinity: never).
 */
export interface ReactOut {
  kind: 'hit' | 'fall';
  job: Job;
  applied: boolean;
  fell: boolean;
  steps: number; // touchdowns from the hit to stable (or to the fall)
  stableAfter: number;
  satPeak: number;
  xiOutPeak: number; // how far the DCM got outside the soles, m
  modes: Record<string, number>; // first time each balance mode was seen
  fallAt: number;
  braceAt: number;
  contactAt: number; // the first part other than a sole on the canvas
  contactParts: string[];
  getup: GetupTimes | null;
  braceWhy?: string; // what started the brace (reactions.ts)
  leanPeak: number; // the torso's largest lean while still up, rad
  leanAt: Record<string, number>; // first time the lean passed 0.4, 0.6, 0.8, 1.0 rad
}
export interface GetupOut { kind: 'getup'; job: Job; ok: boolean; fallAt: number; times: GetupTimes; why: string }
export interface ShuffleOut { kind: 'shuffle'; job: Job; metrics: BalanceMetrics; legs: Array<{ leg: string; arrived: number; steps: number }>; controlUs: number; blowup: boolean }
export interface StrikeOut {
  kind: 'strike';
  job: Job;
  started: boolean;
  mocap: boolean;
  dist: number; // COM to COM at the start, m
  landed: boolean; // the runner saw its striker touch him at speed
  impact: boolean; // ...and the damage model booked an impact from it
  vContact: number; // closing speed at the first impact (damage model), m/s
  vRunner: number; // striker speed the runner saw at contact
  vPeak: number; // fastest striker body speed before contact (or over the whole blow on a miss)
  impulse: number; // first impact's impulse, N·s
  workJ: number;
  part: string | null; // where it landed
  tContact: number; // s from the start to contact
  elbow: number; // striking elbow at contact, rad (0 = straight)
  comAlong: number; // thrower's COM speed toward him at contact, m/s
  torsoYawRate: number; // peak torso yaw rate before contact, rad/s
  fell: boolean;
  captureSteps: number;
  gyroPeak: number;
  end: string;
  step?: boolean; // --approach: the blow started from a step
  lunge?: boolean; // the blow stepped in from the stance (BalanceEngine.requestLunge)
}
/** One fighter through a fight drill (the seconds are its time on its feet). */
export interface FightFighter {
  design: string;
  upS: number;
  recoverS: number; // reactions in 'recover'
  airS: number; // neither sole pressing on the canvas
  legContactS: number; // his feet, shins or thighs touching ours
  captures: number;
  thrown: number;
  landed: number; // the runner saw it touch him and the damage model booked an impact from it
  falls: Array<{ t: number; self: boolean; maxHitNs: number; anatomy: FallAnatomyRec | null }>;
  metrics: BalanceMetrics;
  /** replay: state lines before each fall. */
  narrative?: string[];
}
export interface FightOut { kind: 'fight'; job: Job; seconds: number; fighters: [FightFighter, FightFighter]; blowup: boolean }
export type DrillOut = ApproachOut | PushOut | ShuffleOut | StrikeOut | ReactOut | GetupOut | FightOut;

// ------------------------------------------------------------------ one drill (child process)

/** The control system timed (µs per robot per physics step). */
function timedSystems(): { systems: SimSystem[]; us: () => number } {
  let ms = 0, steps = 0;
  const timed: SimSystem = {
    ...controlSystem,
    pre(c) {
      const t0 = performance.now();
      controlSystem.pre!(c);
      ms += performance.now() - t0;
      steps++;
    },
  };
  return { systems: SYSTEMS.map((s) => (s === controlSystem ? timed : s)), us: () => (ms * 1000) / Math.max(1, steps) / 2 };
}

function blownUp(ctx: SimContext): boolean {
  const v = ctx.data.qvel as Float64Array;
  for (let k = 0; k < ctx.model.nv; k++) if (!(Math.abs(v[k]) < BLOWUP_QVEL)) return true;
  return false;
}

/** Step the sim `s` seconds, sampling the recorders and clearing events; false on a blow-up. */
function run(sim: Sim, s: number, recorders: BalanceRecorder[], each?: (ctx: SimContext) => void): boolean {
  const { ctx } = sim;
  const n = Math.round(s / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    for (const r of recorders) r.sample(ctx);
    each?.(ctx);
    ctx.events.length = 0;
    if (i % 50 === 0 && blownUp(ctx)) return false;
  }
  return true;
}

async function approach(job: Extract<Job, { kind: 'approach' }>): Promise<ApproachOut> {
  const a = job.angle * DEG;
  const t = timedSystems();
  // Centred on the cage (its limit is 3.35 m from the centre: goals and landings stay inside it).
  const h = job.dist / 2;
  const sim = await makeSim({ design: job.design, x: -h, y: 0, yaw: a }, { design: job.design, x: h, y: 0, yaw: Math.PI + a }, { seed: job.seed, systems: t.systems });
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  const recs = [new BalanceRecorder(sim.ctx, 0, LEAN_S), new BalanceRecorder(sim.ctx, 1, LEAN_S)];
  let ok = run(sim, LEAN_S, recs);
  PACE.edgeJabAggression = Infinity; // footwork only: no step-in jab at the edge
  for (const r of sim.ctx.robots) r.intent = intent('close_distance', 'head', 0.5);
  if (ok) ok = run(sim, job.seconds, recs);
  const out: ApproachOut = { kind: 'approach', job, robots: recs.map((r) => r.result()), controlUs: t.us(), blowup: !ok };
  sim.dispose();
  return out;
}

async function lone(design: string, seed: number, systems: readonly SimSystem[]): Promise<Sim> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { seed, systems });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  sim.seconds(0.5);
  sim.release(0);
  return sim;
}

/**
 * Walk 3 m ahead and stop mid-swing ('walk'), or 1 m ahead and stop on arrival ('arrive'); 'stance'
 * is where the robot stands already. False if it never got there.
 */
function reachSituation(sim: Sim, situation: Situation, z0: number): boolean {
  if (situation === 'stance') return true;
  const { ctx } = sim;
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  const f = c.gait.currentFrame();
  const far = situation === 'walk' ? 3 : 1;
  c.goal = { x: f.x + Math.cos(f.heading) * far, y: f.y + Math.sin(f.heading) * far, heading: f.heading };
  const n = Math.round(12 / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    ctx.events.length = 0;
    if (situation === 'walk') {
      const side = c.gait.swingSide;
      const sw = side ? c.gait.feet[side] : null;
      // (The balance engine flies its own swings: their progress is the engine's.)
      const e = c.engine;
      const progress = e ? (e.swing.active ? e.swing.progress(ctx.time) : 0) : sw ? sw.t / sw.dur : 0;
      if (c.gait.phase === 'single' && sw && sw.phase === 'swing' && progress >= 0.4 && ctx.time > 2.5) return true;
    } else if (c.gait.bothPlanted()) {
      const g = c.goal!, cur = c.gait.currentFrame();
      if (Math.hypot(cur.x - g.x, cur.y - g.y) < 0.12) return true;
    }
    if (isDown(ctx, r, z0) || r.down) return false;
  }
  return false;
}

async function pushTrial(job: Extract<Job, { kind: 'push' }>): Promise<PushOut> {
  const sim = await lone(job.design, job.seed, SYSTEMS);
  const { ctx } = sim;
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  sim.seconds(1.2);
  const z0 = comPos(ctx, r)[2];
  if (!reachSituation(sim, job.situation, z0)) {
    sim.dispose();
    return { kind: 'push', job, survived: false, steps: 0, stableAfter: Infinity, satPeak: 0, applied: false };
  }
  const heading = c.gait.bothPlanted() ? c.gait.currentFrame().heading : c.lastSense!.heading - c.stance.pelvisYaw;
  const dirW = heading + job.dir * DEG;
  const f = (job.dv * c.mass) / PUSH_S;
  const force: Vec3 = [Math.cos(dirW) * f, Math.sin(dirW) * f, 0];
  const touch0 = c.probe.touchdowns;
  const body = r.parts.get('torso')!.body;
  const xf = ctx.data.xfrc_applied as Float64Array;
  let fell = false, satPeak = 0;
  const watch = (): void => {
    for (const e of ctx.events as SimEvent[]) if (e.kind === 'fall' && e.corner === 0) fell = true;
    ctx.events.length = 0;
    if (isDown(ctx, r, z0)) fell = true;
    satPeak = Math.max(satPeak, c.gyro?.saturation ?? 0);
  };
  for (let i = 0; i < Math.round(PUSH_S / ctx.dt); i++) {
    xf[body * 6] += force[0];
    xf[body * 6 + 1] += force[1];
    sim.step();
    xf[body * 6] -= force[0];
    xf[body * 6 + 1] -= force[1];
    watch();
  }
  if (job.situation !== 'stance') c.goal = null;
  const pushedAt = ctx.time;
  let stableSince = -1, stableAfter = Infinity;
  const n = Math.round(PUSH_WATCH_S / ctx.dt);
  const cv = ctx.data.cvel as Float64Array;
  for (let i = 0; i < n && !fell; i++) {
    sim.step();
    watch();
    const s = c.lastSense;
    if (!s || Number.isFinite(stableAfter)) continue;
    const speed = Math.hypot(s.comVel[0], s.comVel[1]);
    const rate = Math.hypot(cv[body * 6], cv[body * 6 + 1]);
    const stable = speed < STABLE_SPEED && rate < STABLE_SPEED && c.gait.bothPlanted() && !r.down;
    if (!stable) stableSince = -1;
    else if (stableSince < 0) stableSince = ctx.time;
    else if (ctx.time - stableSince >= STABLE_HOLD_S && !Number.isFinite(stableAfter)) stableAfter = stableSince - pushedAt;
  }
  const out: PushOut = { kind: 'push', job, survived: !fell, steps: c.probe.touchdowns - touch0, stableAfter, satPeak, applied: true };
  sim.dispose();
  return out;
}

// ------------------------------------------------------------------ Phase 4: hits, falls, get-ups

const HIT_S = 0.012; // a blow's contact time: its impulse arrives over this long
const REACT_WATCH_S = 4; // a hit that does not fell the robot is watched this long
const DOWN_WATCH_S = 12; // after a fall: this long for the get-up
const STAND_HOLD_S = 0.3;
const STAND_UP = 0.9; // torso up-axis z: standing upright
const STAND_HEIGHT = 0.9; // × stance pelvis height

/**
 * Watches one robot through a hit or a shove (and the get-up after a fall): recovery steps, time to
 * stable, the balance modes it went through, when it braced, what of it touched the canvas first
 * and when, and how long it took to get up.
 */
class ReactWatch {
  readonly out: ReactOut;
  private t0 = 0;
  private touch0 = 0;
  private stableSince = -1;
  private standSince = -1;
  private fallT = -1;
  private lastWhy = '';
  private readonly cc: CanvasContacts;
  private readonly torso: number;
  private readonly z0: number;
  private readonly heightRef: number;

  constructor(private readonly sim: Sim, kind: 'hit' | 'fall', job: Job) {
    const { ctx } = sim;
    const r = ctx.robots[0];
    this.out = {
      kind, job, applied: true, fell: false, steps: 0, stableAfter: Infinity, satPeak: 0, xiOutPeak: 0, modes: {},
      fallAt: Infinity, braceAt: Infinity, contactAt: Infinity, contactParts: [], getup: null, leanPeak: 0, leanAt: {},
    };
    this.cc = new CanvasContacts(ctx, r);
    this.torso = r.parts.get('torso')!.body;
    this.z0 = comPos(ctx, r)[2];
    this.heightRef = controllerOf(r)!.stance.pelvisHeight;
  }

  /** The hit (or shove) has been delivered: times count from here. */
  begin(touch0: number): void {
    this.t0 = this.sim.ctx.time;
    this.touch0 = touch0;
  }

  /** After every physics step (during the hit too); false once there is nothing more to watch. */
  step(during = false): boolean {
    const { ctx } = this.sim;
    const r = ctx.robots[0];
    const c = controllerOf(r)!;
    const o = this.out;
    const now = ctx.time - this.t0;
    for (const e of ctx.events as SimEvent[]) {
      if ((e.kind !== 'fall' && e.kind !== 'getup') || e.corner !== 0) continue;
      if (e.kind === 'fall' && this.fallT < 0) {
        this.fallT = ctx.time;
        o.fallAt = now;
        o.getup = { moveAt: Infinity, upAt: Infinity, stableAt: Infinity, attempts: 0 };
      }
      if (e.kind === 'getup' && o.getup && !Number.isFinite(o.getup.upAt)) o.getup.upAt = ctx.time - this.fallT;
    }
    ctx.events.length = 0;
    const mode = c.engine?.state.mode ?? 'legacy';
    if (!(mode in o.modes)) o.modes[mode] = during ? 0 : now;
    if (mode === 'brace' && !Number.isFinite(o.braceAt)) {
      o.braceAt = during ? 0 : now;
      o.braceWhy = c.engine?.reactions.braceWhy;
    }
    o.satPeak = Math.max(o.satPeak, c.gyro?.saturation ?? 0);
    if (!Number.isFinite(o.contactAt)) {
      const parts = this.cc.nonFoot(ctx);
      if (parts.length) {
        o.contactAt = during ? 0 : now;
        o.contactParts = parts;
      }
    }
    const s = c.lastSense;
    const cv = ctx.data.cvel as Float64Array;
    const rate = Math.hypot(cv[this.torso * 6], cv[this.torso * 6 + 1]);
    if (s && !o.fell && !Number.isFinite(o.contactAt)) {
      const lean = Math.acos(Math.max(-1, Math.min(1, s.upright)));
      o.leanPeak = Math.max(o.leanPeak, lean);
      for (const th of [0.4, 0.6, 0.8, 1.0]) if (lean > th && !(String(th) in o.leanAt)) o.leanAt[String(th)] = during ? 0 : now;
    }
    if (!o.fell && (this.fallT >= 0 || isDown(ctx, r, this.z0))) {
      o.fell = true;
      o.steps = c.probe.touchdowns - this.touch0;
    }
    if (!o.fell && s && c.gait.bothPlanted()) {
      const sup = c.gait.supportPolygon();
      if (sup.length >= 3) o.xiOutPeak = Math.max(o.xiOutPeak, polygonDistance(sup, [s.capture[0], s.capture[1]]).d);
    }
    if (during) return true;
    if (!o.fell) {
      if (Number.isFinite(o.stableAfter)) return now < o.stableAfter + 1;
      const speed = s ? Math.hypot(s.comVel[0], s.comVel[1]) : Infinity;
      const stable = speed < STABLE_SPEED && rate < STABLE_SPEED && c.gait.bothPlanted() && !r.down;
      if (!stable) this.stableSince = -1;
      else if (this.stableSince < 0) this.stableSince = ctx.time;
      else if (ctx.time - this.stableSince >= STABLE_HOLD_S) {
        o.stableAfter = this.stableSince - this.t0;
        o.steps = c.probe.touchdowns - this.touch0;
      }
      if (now >= REACT_WATCH_S) o.steps = c.probe.touchdowns - this.touch0;
      return now < REACT_WATCH_S;
    }
    // Down: time the get-up.
    const g = o.getup;
    if (!g || this.fallT < 0) return now < REACT_WATCH_S + DOWN_WATCH_S;
    const since = ctx.time - this.fallT;
    g.attempts = c.getUp.attempts;
    const why = c.getUp.clip?.reason;
    if (why && why !== this.lastWhy) {
      (g.fails ??= []).push(why);
      this.lastWhy = why;
    }
    if (!Number.isFinite(g.moveAt) && c.getUp.active && c.getUp.phase !== 'settle') g.moveAt = since;
    const standing = !r.down && !c.getUp.active && !c.rising && !!s && s.upright > STAND_UP && s.pelvisPos[2] > STAND_HEIGHT * this.heightRef
      && Math.hypot(s.comVel[0], s.comVel[1]) < STABLE_SPEED && rate < STABLE_SPEED && c.gait.bothPlanted();
    if (!standing) this.standSince = -1;
    else if (this.standSince < 0) this.standSince = ctx.time;
    else if (ctx.time - this.standSince >= STAND_HOLD_S && !Number.isFinite(g.stableAt)) g.stableAt = this.standSince - this.fallT;
    if (Number.isFinite(g.stableAt)) return false;
    return since < DOWN_WATCH_S;
  }
}

/** A blow (§8: torso and head hits of 20, 40 and 73 N·s), from `dir` degrees off the facing. */
async function hitTrial(job: Extract<Job, { kind: 'hit' }>): Promise<ReactOut> {
  const sim = await lone(job.design, job.seed, SYSTEMS);
  const { ctx } = sim;
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  sim.seconds(1.2);
  ctx.events.length = 0;
  const z0 = comPos(ctx, r)[2];
  const w = new ReactWatch(sim, 'hit', job);
  if (!reachSituation(sim, job.situation, z0)) {
    sim.dispose();
    w.out.applied = false;
    return w.out;
  }
  const heading = c.gait.bothPlanted() ? c.gait.currentFrame().heading : c.lastSense!.heading - c.stance.pelvisYaw;
  const dirW = heading + Math.PI + job.dir * DEG; // dir 0: the blow comes from straight ahead (pushes him back)
  const f = job.impulse / HIT_S;
  const force: Vec3 = [Math.cos(dirW) * f, Math.sin(dirW) * f, 0];
  const body = r.parts.get(job.part)!.body;
  const touch0 = c.probe.touchdowns;
  for (let i = 0; i < Math.round(HIT_S / ctx.dt); i++) {
    const xf = ctx.data.xfrc_applied as Float64Array;
    xf[body * 6] += force[0];
    xf[body * 6 + 1] += force[1];
    sim.step();
    const xf2 = ctx.data.xfrc_applied as Float64Array;
    xf2[body * 6] -= force[0];
    xf2[body * 6 + 1] -= force[1];
    w.step(true);
  }
  if (job.situation !== 'stance') c.goal = null;
  w.begin(touch0);
  while (w.step()) sim.step();
  sim.dispose();
  return w.out;
}

/** A shove past capture: what does the robot do on the way down, what lands first, how fast is it back up. */
async function fallTrial(job: Extract<Job, { kind: 'fall' }>): Promise<ReactOut> {
  const sim = await lone(job.design, job.seed, SYSTEMS);
  const { ctx } = sim;
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  sim.seconds(1.2);
  ctx.events.length = 0;
  const w = new ReactWatch(sim, 'fall', job);
  const heading = c.gait.bothPlanted() ? c.gait.currentFrame().heading : c.lastSense!.heading - c.stance.pelvisYaw;
  const dirW = heading + job.dir * DEG;
  const f = (job.dv * c.mass) / PUSH_S;
  const force: Vec3 = [Math.cos(dirW) * f, Math.sin(dirW) * f, 0];
  const body = r.parts.get('torso')!.body;
  const touch0 = c.probe.touchdowns;
  for (let i = 0; i < Math.round(PUSH_S / ctx.dt); i++) {
    const xf = ctx.data.xfrc_applied as Float64Array;
    xf[body * 6] += force[0];
    xf[body * 6 + 1] += force[1];
    sim.step();
    const xf2 = ctx.data.xfrc_applied as Float64Array;
    xf2[body * 6] -= force[0];
    xf2[body * 6 + 1] -= force[1];
    w.step(true);
  }
  w.begin(touch0);
  while (w.step()) sim.step();
  sim.dispose();
  return w.out;
}

/** The root orientation that lays the body face down, on its back or on a side (tests/control/getup-search.ts). */
const LAY: Record<Orient, [number, number, number, number]> = {
  face_down: [Math.cos(Math.PI / 4), 0, Math.sin(Math.PI / 4), 0],
  back: [Math.cos(-Math.PI / 4), 0, Math.sin(-Math.PI / 4), 0],
  side_l: [Math.cos(-Math.PI / 4), Math.sin(-Math.PI / 4), 0, 0],
  side_r: [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0, 0],
};

/** Laid on the canvas in `orient` (dropped from a little above it): how fast and how surely it gets up. */
async function getupTrial(job: Extract<Job, { kind: 'getup' }>): Promise<GetupOut> {
  const sim = await makeSim({ design: job.design, x: 0, y: 0, yaw: 0 }, { design: job.design, x: 8, y: 0, yaw: Math.PI }, { seed: job.seed, systems: SYSTEMS });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  const { ctx } = sim;
  sim.seconds(0.6); // the motion library attaches
  sim.release(0);
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  const a = r.rootQadr;
  const qpos = ctx.data.qpos as Float64Array;
  if (job.pose) {
    // A recorded fall ending: the body as it lay, still, just clear of the canvas; the servos start where it lies.
    for (let i = 0; i < 7; i++) qpos[a + i] = job.pose.root[i];
    qpos[a + 2] += 0.01;
    const qvel = ctx.data.qvel as Float64Array;
    for (let i = 0; i < 6; i++) qvel[r.rootDadr + i] = 0;
    r.joints.forEach((j, i) => {
      if (job.pose!.joints[j.name] !== undefined) qpos[j.qadr] = job.pose!.joints[j.name];
      qvel[j.dadr] = 0;
      r.targets[i] = qpos[j.qadr];
    });
  } else {
    const q = LAY[job.orient];
    qpos[a + 2] = 0.28 + 0.04 * ((job.seed - 1) % 3);
    for (let i = 0; i < 4; i++) qpos[a + 3 + i] = q[i];
  }
  ctx.mj.mj_forward(ctx.model, ctx.data);
  ctx.events.length = 0;
  const t0 = ctx.time;
  const times: GetupTimes = { moveAt: Infinity, upAt: Infinity, stableAt: Infinity, attempts: 0 };
  let fallAt = -1, standSince = -1;
  const torso = r.parts.get('torso')!.body;
  const n = Math.round(DOWN_WATCH_S / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    for (const e of ctx.events as SimEvent[]) {
      if ((e.kind !== 'fall' && e.kind !== 'getup') || e.corner !== 0) continue;
      if (e.kind === 'fall' && fallAt < 0) fallAt = ctx.time;
      if (e.kind === 'getup' && fallAt >= 0 && !Number.isFinite(times.upAt)) times.upAt = ctx.time - fallAt;
    }
    ctx.events.length = 0;
    if (fallAt < 0) continue;
    const since = ctx.time - fallAt;
    times.attempts = c.getUp.attempts;
    const why = c.getUp.clip?.reason;
    if (why && why !== (times.fails?.[times.fails.length - 1] ?? '')) (times.fails ??= []).push(why);
    if (!Number.isFinite(times.moveAt) && c.getUp.active && c.getUp.phase !== 'settle') times.moveAt = since;
    const s = c.lastSense;
    const cv = ctx.data.cvel as Float64Array;
    const rate = Math.hypot(cv[torso * 6], cv[torso * 6 + 1]);
    const standing = !r.down && !c.getUp.active && !c.rising && !!s && s.upright > STAND_UP && s.pelvisPos[2] > STAND_HEIGHT * c.stance.pelvisHeight
      && Math.hypot(s.comVel[0], s.comVel[1]) < STABLE_SPEED && rate < STABLE_SPEED && c.gait.bothPlanted();
    if (!standing) standSince = -1;
    else if (standSince < 0) standSince = ctx.time;
    else if (ctx.time - standSince >= STAND_HOLD_S) {
      times.stableAt = standSince - fallAt;
      break;
    }
  }
  const why = c.getUp.clip?.reason ?? '';
  sim.dispose();
  return { kind: 'getup', job, ok: Number.isFinite(times.stableAt), fallAt: fallAt >= 0 ? fallAt - t0 : Infinity, times, why };
}

async function shuffle(job: Extract<Job, { kind: 'shuffle' }>): Promise<ShuffleOut> {
  const t = timedSystems();
  const sim = await makeSim({ design: job.design, x: 0, y: 0, yaw: 0 }, { design: job.design, x: 1.4, y: 0, yaw: Math.PI }, { seed: job.seed, systems: t.systems });
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  const { ctx } = sim;
  const c = controllerOf(ctx.robots[0])!;
  const rec = new BalanceRecorder(ctx, 0, LEAN_S);
  let ok = run(sim, LEAN_S, [rec]);
  const opp = (): Vec3 => comPos(ctx, ctx.robots[1]);
  const home = c.gait.currentFrame();
  const legs: ShuffleOut['legs'] = [];
  const offsets: Array<[string, number, number]> = [
    ['forward', 0.4, 0], ['home', 0, 0], ['back', -0.4, 0], ['home', 0, 0],
    ['left', 0, 0.4], ['home', 0, 0], ['right', 0, -0.4], ['home', 0, 0],
  ];
  let goal: { x: number; y: number } | null = null;
  rec.goal = () => goal;
  for (const [leg, fx, fy] of offsets) {
    if (!ok) break;
    const x = home.x + fx, y = home.y + fy;
    const o = opp();
    goal = { x, y };
    c.goal = { x, y, heading: Math.atan2(o[1] - y, o[0] - x) };
    const t0 = ctx.time, s0 = c.probe.touchdowns;
    let arrived = Infinity;
    ok = run(sim, 2.5, [rec], () => {
      if (Number.isFinite(arrived) || !c.gait.bothPlanted()) return;
      const f = c.gait.currentFrame();
      if (Math.hypot(f.x - x, f.y - y) < 0.1) arrived = ctx.time - t0;
    });
    legs.push({ leg, arrived, steps: c.probe.touchdowns - s0 });
  }
  goal = null;
  for (const tactic of ['circle_left', 'circle_right'] as const) {
    if (!ok) break;
    ctx.robots[0].intent = intent(tactic, 'head', 0.5);
    const s0 = c.probe.touchdowns;
    ok = run(sim, 4, [rec]);
    legs.push({ leg: tactic, arrived: NaN, steps: c.probe.touchdowns - s0 });
  }
  const out: ShuffleOut = { kind: 'shuffle', job, metrics: rec.result(), legs, controlUs: t.us(), blowup: !ok };
  sim.dispose();
  return out;
}

const STRIKE_ZONE: Partial<Record<SkillId, 'head' | 'torso' | 'left_leg'>> = { front_kick: 'torso', low_kick: 'left_leg' };
const STRIKE_AGGRESSION = 0.8;
const STRIKE_WATCH_S = 1.5;
const STRIKE_MAX_S = 3.5;

/** The distances (COM to COM) the tactics throw `id` from: its sweet spot to its throw edge (tactics.ts). */
async function strikeWindow(design: string, id: SkillId): Promise<[number, number] | null> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
  sim.seconds(0.6); // the motion library attaches
  sim.release(0);
  sim.seconds(1.2); // standing in its guard: the guard's measured reach
  const c = controllerOf(sim.ctx.robots[0])!;
  const def = c.skillFor(id);
  const guard = c.guardReach();
  sim.dispose();
  if (!def) return null;
  const [lo, hi] = def.range(c.geo);
  // Never inside the guards' standoff (tactics.ts: footwork stops there; strikes thrown closer come
  // from a step, not a stance): spawned closer, the two guards start interlocked.
  const standoff = 2 * guard + 0.04;
  // --window guard (straight punches): from where his guard (a mirror's, as mine) is 75-95% of my
  // straight reach away, so the fist meets it near full extension.
  if (process.env.SD_STRIKE_WINDOW === 'guard' && def.kind === 'arm' && (id === 'jab' || id === 'cross' || id === 'overhand')) {
    const reach = hi - 0.8 * c.geo.torsoHalf[0];
    return [Math.max(standoff, guard + 0.75 * reach), Math.max(standoff + 0.06, guard + 0.95 * reach)];
  }
  const { sweet, throwAt } = def.approach ?? { sweet: 0.6, throwAt: 0.85 };
  const a = lo + sweet * (hi - lo), b = lo + throwAt * (hi - lo);
  return [Math.max(standoff, a), Math.max(standoff + 0.06, b)];
}

async function strikeTrial(job: Extract<Job, { kind: 'strike' }>): Promise<StrikeOut> {
  const win = await strikeWindow(job.design, job.skill);
  const k = job.trial;
  // Deterministic spread over the throw window, a little off-line and turned. --approach: a stride
  // or so beyond the throw edge, on an intent: the tactics walk in and throw (a step-in blow).
  const u = ((k * 0.618034) % 1);
  const approachMode = process.env.SD_STRIKE_APPROACH === '1';
  const dist = !win ? 1 : approachMode ? win[1] + 0.25 + 0.2 * u : win[0] + (win[1] - win[0]) * u;
  const dy = [0, 0.1, -0.1, 0.05, -0.05][k % 5];
  const dyaw = [0, 0.15, -0.15, -0.08, 0.08][k % 5];
  const out: StrikeOut = {
    kind: 'strike', job, started: false, mocap: false, dist, landed: false, impact: false, vContact: NaN, vRunner: NaN, vPeak: 0, impulse: NaN, workJ: NaN,
    part: null, tContact: NaN, elbow: NaN, comAlong: NaN, torsoYawRate: 0, fell: false, captureSteps: 0, gyroPeak: 0, end: '',
  };
  if (!win) return out;
  const sim = await makeSim({ design: job.design, x: -dist / 2, y: 0, yaw: 0 }, { design: job.design, x: dist / 2, y: dy, yaw: Math.PI + dyaw }, { seed: job.seed, systems: SYSTEMS });
  const { ctx } = sim;
  const [me, opp] = ctx.robots;
  sim.seconds(0.5);
  sim.release(0);
  sim.release(1);
  sim.seconds(1.0, () => { ctx.events.length = 0; });
  const c = controllerOf(me)!;
  const def = c.skillFor(job.skill)!;
  const z0 = comPos(ctx, me)[2];
  const cap0 = c.gait.captureSteps;
  const lunge0 = c.engine?.lunges ?? 0;
  // --guard down: his hands drop to his sides (a clean-shot measurement: what the blow carries when
  // nothing is in its way).
  if (process.env.SD_STRIKE_GUARD === 'down') {
    const oc = controllerOf(opp)!;
    for (const sd of ['l', 'r'] as const) {
      const a = oc.geo.arms[sd];
      oc.stance.guard[sd].fist = [a.shoulder[0] + 0.08, a.shoulder[1] * 1.15, a.shoulder[2] - 0.9 * (a.upper + a.fore)];
      oc.stance.guard[sd].pole = [-1, 0, 0];
    }
    sim.seconds(0.6, () => { ctx.events.length = 0; });
  }
  out.mocap = !!def.clip;
  if (approachMode) {
    me.intent = intent(job.skill as never, STRIKE_ZONE[job.skill] ?? 'head', STRIKE_AGGRESSION);
    const n0 = Math.round(STRIKE_MAX_S / ctx.dt);
    for (let i = 0; i < n0 && !c.skills.run; i++) {
      sim.step();
      for (const e of ctx.events as SimEvent[]) if (e.kind === 'fall' && e.corner === me.corner) out.fell = true;
      ctx.events.length = 0;
    }
    me.intent = null;
    out.started = !!c.skills.run && c.skills.run.def.id === job.skill;
    out.step = c.gait.phase === 'single';
    out.dist = Math.hypot(comPos(ctx, opp)[0] - comPos(ctx, me)[0], comPos(ctx, opp)[1] - comPos(ctx, me)[1]);
  } else out.started = c.startSkill(def, STRIKE_ZONE[job.skill] ?? 'head', STRIKE_AGGRESSION);
  if (!out.started) {
    sim.dispose();
    return out;
  }
  const t0 = ctx.time;
  const torso = me.parts.get('torso')!.body;
  const cv = () => ctx.data.cvel as Float64Array;
  const xp = () => ctx.data.xpos as Float64Array;
  let tips: number[] = [];
  const prev = new Map<number, Vec3>();
  let ended = -1;
  const n = Math.round((STRIKE_MAX_S + STRIKE_WATCH_S) / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    const now = ctx.time - t0;
    for (const e of ctx.events as SimEvent[]) {
      if (e.kind === 'fall' && e.corner === me.corner) out.fell = true;
      if (e.kind === 'impact' && e.striker === me.corner && e.victim === opp.corner && !e.push && !out.impact && c.skills.run) {
        out.impact = true;
        out.vContact = e.speed;
        out.impulse = e.impulseNs;
        out.workJ = e.workJ ?? NaN;
        out.part = e.part;
      }
    }
    ctx.events.length = 0;
    if (isDown(ctx, me, z0)) out.fell = true;
    out.gyroPeak = Math.max(out.gyroPeak, c.gyro?.saturation ?? 0);
    const run = c.skills.run;
    if (run && !tips.length) {
      const parts = run.strikers ?? def.strikers;
      tips = parts.filter((p) => /fist|foot|shin/.test(p)).map((p) => me.parts.get(p)?.body ?? -1).filter((b) => b >= 0);
    }
    if (run && !out.landed) {
      for (const b of tips) {
        const p: Vec3 = [xp()[b * 3], xp()[b * 3 + 1], xp()[b * 3 + 2]];
        const q = prev.get(b);
        if (q) out.vPeak = Math.max(out.vPeak, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / ctx.dt);
        prev.set(b, p);
      }
      if (xp()[torso * 3 + 2] > 0.3) out.torsoYawRate = Math.max(out.torsoYawRate, Math.abs(cv()[torso * 6 + 2]));
    }
    if (run?.landed && !out.landed) {
      out.landed = true;
      out.vRunner = run.landedSpeed;
      out.tContact = now;
      const side = (run.strikers?.[0] ?? def.strikers[0]).slice(-1);
      const ei = me.jointIndex.get(`elbow_${side}`);
      if (ei !== undefined) out.elbow = (ctx.data.qpos as Float64Array)[me.joints[ei].qadr];
      const a = comPos(ctx, me), b = comPos(ctx, opp);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const v = ctx.data.subtree_linvel as Float64Array;
      out.comAlong = (v[me.rootBody * 3] * (b[0] - a[0]) + v[me.rootBody * 3 + 1] * (b[1] - a[1])) / d;
    }
    if (!run && ended < 0) {
      ended = now;
      out.end = c.skills.lastEnd;
    }
    if (ended >= 0 && now > ended + STRIKE_WATCH_S) break;
    if (now > STRIKE_MAX_S && ended < 0) {
      ended = now;
      out.end = 'timeout';
    }
  }
  out.captureSteps = c.gait.captureSteps - cap0;
  out.lunge = (c.engine?.lunges ?? 0) > lunge0;
  sim.dispose();
  return out;
}

const TABLES: Record<string, Record<string, unknown>> = { REACTIONS, BEHAVIOURS, GETUP_SPEED, BALANCE_TUNING, FOOTWORK_TUNING, STEP_ADJUST, COM_REF, GYRO_POLICY, INERTIA, COUNTER_YAW, YAW_TUNING, MOCAP_STEPS, MOCAP_STYLE, PACE, BURST, STRIKE_P3, MOCAP_KICKS, KICK_CONTACT, ENGINE_KICK, KICK_GATE, KICK_DRIVE, KICK_RBAL, KICK_SET, ROUTE, STRIKE_PATH, LUNGE, INVERSE_DYNAMICS, IMPEDANCE, TRUNK_LIMIT };

/** SD_TUNE='TABLE.key=value,...': set numeric tunables before a drill (A/B runs). */
// ------------------------------------------------------------------ fight conditions (the fight-clean pass)

const FIGHT_INTENT_S = 0.5; // the sparring stand-in decides this often (as in tools/fight-metrics.ts)
const FIGHT_SELF_NS = 20; // a fall with no blow of his this big in the window before is self-inflicted
const FIGHT_SELF_WINDOW_S = 1.5;
const FIGHT_REPLAY_LEAD_S = 3; // replay: state lines this long before each fall
const FIGHT_GAP_M = 1.1; // exchange and press start this far apart (COM to COM, about the edge of range)

function newFighter(design: string): Omit<FightFighter, 'metrics'> {
  return { design, upS: 0, recoverS: 0, airS: 0, legContactS: 0, captures: 0, thrown: 0, landed: 0, falls: [] };
}

/** The arena world of a real fight (cage, canvas), both fighters released at their corners. */
async function arenaContext(red: string, blue: string, seed: number): Promise<SimContext> {
  const setup: MatchSetup = {
    fighters: [{ design: red, skin: 'factory', plan: '', temperament: 1 }, { design: blue, skin: 'neon', plan: '', temperament: 1 }],
    seed, timestep: 0.001, reactionDelayS: 0.3,
  };
  const loadMujoco = (await import('@mujoco/mujoco')).default;
  const ctx = buildContext(await loadMujoco(), compileWorld(setup), setup);
  for (const sys of SYSTEMS) sys.init?.(ctx);
  for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  return ctx;
}

async function fightTrial(job: Extract<Job, { kind: 'fight' }>): Promise<FightOut> {
  let ctx: SimContext;
  let stepOnce: () => void;
  let dispose = (): void => {};
  if (job.scenario === 'replay') {
    ctx = await arenaContext(job.design, job.opp, job.seed);
    const c0 = ctx;
    stepOnce = () => {
      for (const sys of SYSTEMS) sys.pre?.(c0);
      c0.mj.mj_step(c0.model, c0.data);
      c0.tick++;
      c0.time += c0.dt;
      for (const sys of SYSTEMS) sys.post?.(c0);
    };
    dispose = () => {
      c0.data.delete();
      c0.model.delete();
    };
  } else {
    const h = FIGHT_GAP_M / 2;
    const sim = await makeSim({ design: job.design, x: -h, y: 0, yaw: 0 }, { design: job.opp, x: h, y: 0, yaw: Math.PI }, { seed: job.seed, systems: SYSTEMS });
    sim.seconds(0.5);
    sim.release(0);
    sim.release(1);
    sim.seconds(0.8, () => { sim.ctx.events.length = 0; });
    ctx = sim.ctx;
    stepOnce = () => sim.step();
    dispose = () => sim.dispose();

  }
  const ctl = ctx.robots.map((r) => controllerOf(r)!);
  const recs = [new BalanceRecorder(ctx, 0, 0.3), new BalanceRecorder(ctx, 1, 0.3)];
  const anatomy = new FallAnatomy(ctx);
  const fighters = [newFighter(job.design), newFighter(job.opp)];
  const impacts: Array<{ t: number; victim: number; striker: number; n: number }> = [];
  const runs: Array<{ run: unknown; touched: boolean; impact: boolean } | null> = [null, null];
  const capt0 = ctl.map((c) => c.gait.captureSteps);
  const geomOwner = new Map<number, { c: number; part: string }>();
  for (const r of ctx.robots) for (const [id, part] of r.parts) for (const g of part.geoms) geomOwner.set(g, { c: r.corner, part: id });
  const feet = ctx.robots.map((r) => ({ l: new Set(r.parts.get('foot_l')!.geoms), r: new Set(r.parts.get('foot_r')!.geoms) }));
  const ring: string[][] = [[], []];
  const narrative: string[][] = [[], []];
  const intentEvery = Math.round(FIGHT_INTENT_S / ctx.dt);
  const n = Math.round(job.seconds / ctx.dt);
  const t0 = ctx.time;
  let blowup = false;
  for (let i = 0; i < n; i++) {
    if (i % intentEvery === 0) {
      for (const r of ctx.robots) {
        if (job.scenario === 'press') r.intent = r.corner === 0 ? intent('clinch', 'torso', 0.9) : intent('guard', 'head', 0.5);
        else r.intent = sparringIntent(ctx, r);
      }
    }
    stepOnce();
    for (const rec of recs) rec.sample(ctx);
    anatomy.sample(ctx);
    for (const e of ctx.events as SimEvent[]) {
      if (e.kind === 'impact' && e.striker !== null && e.victim !== null && e.striker !== e.victim) {
        impacts.push({ t: ctx.time, victim: e.victim, striker: e.striker, n: e.impulseNs });
        const cur = runs[e.striker];
        if (cur && !e.push) cur.impact = true;
      } else if (e.kind === 'fall') {
        const c = e.corner;
        let maxHit = 0;
        for (const h of impacts) if (h.victim === c && h.t >= ctx.time - FIGHT_SELF_WINDOW_S) maxHit = Math.max(maxHit, h.n);
        fighters[c].falls.push({ t: ctx.time - t0, self: maxHit <= FIGHT_SELF_NS, maxHitNs: maxHit, anatomy: null });
        if (job.scenario === 'replay') narrative[c].push(`--- fall at ${(ctx.time - t0).toFixed(2)} s (${maxHit <= FIGHT_SELF_NS ? 'self' : `hit ${maxHit.toFixed(0)} N·s`}):`, ...ring[c]);
      }
    }
    ctx.events.length = 0;
    if (i % 50 === 0 && blownUp(ctx)) {
      blowup = true;
      break;
    }
    if (ctx.tick % 2) continue;
    // Floor pressure under each foot and leg-on-leg contact, one contact scan per control tick.
    const floor = [{ l: 0, r: 0 }, { l: 0, r: 0 }];
    let legs = false;
    const d = ctx.data;
    const nc = d.ncon as number;
    if (nc) {
      const cons = d.contact;
      const efc = d.efc_force as Float64Array;
      try {
        for (let k = 0; k < nc; k++) {
          const con = cons.get(k);
          const g1 = con.geom1 as number, g2 = con.geom2 as number, adr = con.efc_address as number;
          con.delete();
          const a = geomOwner.get(g1), b = geomOwner.get(g2);
          if (a && b) {
            if (a.c !== b.c && /^(foot|shin|thigh)_/.test(a.part) && /^(foot|shin|thigh)_/.test(b.part)) legs = true;
            continue;
          }
          const f = efc[adr];
          if (!(f > 0)) continue;
          for (const c of [0, 1]) for (const sd of ['l', 'r'] as const) if (feet[c][sd].has(g1) || feet[c][sd].has(g2)) floor[c][sd] += f;
        }
      } finally {
        cons.delete();
      }
    }
    const dt = ctx.dt * 2;
    for (const c of [0, 1]) {
      const k = ctl[c];
      const r = ctx.robots[c];
      const f = fighters[c];
      const run = k.skills.run;
      if (run !== (runs[c]?.run ?? null)) {
        if (runs[c]?.touched && runs[c]?.impact) f.landed++; // the runner saw the touch and the damage model an impact
        runs[c] = run && (run.def.kind === 'arm' || run.def.kind === 'leg') ? { run, touched: false, impact: false } : null;
        if (runs[c]) f.thrown++;
      }
      if (runs[c] && run?.landed) runs[c]!.touched = true;
      const up = !r.down && !k.getUp.active && !k.rising;
      if (!up) continue;
      f.upS += dt;
      if (k.engine?.reactions.mode === 'recover') f.recoverS += dt;
      if (floor[c].l <= 0 && floor[c].r <= 0) f.airS += dt;
      if (legs) f.legContactS += dt;
      if (job.scenario === 'replay' && ctx.tick % 100 === 0) {
        const s = k.lastSense, e = k.engine;
        if (s && e) {
          const o = ctl[1 - c].lastSense ?? s;
          const dist = Math.hypot(o.com[0] - s.com[0], o.com[1] - s.com[1]);
          const ux = (o.com[0] - s.com[0]) / Math.max(1e-6, dist), uy = (o.com[1] - s.com[1]) / Math.max(1e-6, dist);
          const sup = k.gait.supportPolygon();
          const out = sup.length >= 3 ? polygonDistance(sup, e.state.xi).d : NaN;
          ring[c].push(`${(ctx.time - t0).toFixed(2)} ${(run ? `${run.def.id}/${run.phase}` : r.skill).padEnd(16)} ${k.gait.phase.padEnd(6)} ${e.reactions.mode.padEnd(7)} v ${f2(s.comVel[0] * ux + s.comVel[1] * uy)}/${f2(-s.comVel[0] * uy + s.comVel[1] * ux)} ξ err ${f2(Math.hypot(e.state.xi[0] - e.state.xiRef[0], e.state.xi[1] - e.state.xiRef[1]))} out ${f2(out)} gyro ${f2(k.gyro?.saturation ?? 0)}/${f2(r.gyro?.health ?? 0)} dist ${f2(dist)} him ${ctx.robots[1 - c].skill}`);
          if (ring[c].length > FIGHT_REPLAY_LEAD_S * 10) ring[c].shift();
        }
      }
    }
    if (job.scenario === 'replay' && ctx.robots.some((r) => r.koReason)) break;
  }
  for (const c of [0, 1]) {
    fighters[c].captures = ctl[c].gait.captureSteps - capt0[c];
    fighters[c].falls.forEach((fl, i) => { fl.anatomy = anatomy.falls[c][i] ?? null; });
  }
  const out: FightOut = {
    kind: 'fight', job, seconds: ctx.time - t0, blowup,
    fighters: [0, 1].map((c) => ({ ...fighters[c], metrics: recs[c].result(), ...(job.scenario === 'replay' ? { narrative: narrative[c] } : {}) })) as [FightFighter, FightFighter],
  };
  dispose();
  return out;
}

export function summarizeFight(outs: FightOut[], scenario: FightScenario): string[] {
  const rs = outs.filter((o) => (o.job as Extract<Job, { kind: 'fight' }>).scenario === scenario);
  if (!rs.length) return [];
  const lines = [`fight drill: ${scenario} (${rs.length} trials${rs.some((o) => o.blowup) ? ', BLOW-UPS' : ''})`];
  const byDesign = new Map<string, FightFighter[]>();
  for (const o of rs) for (const f of o.fighters) byDesign.set(f.design, [...(byDesign.get(f.design) ?? []), f]);
  const all = rs.flatMap((o) => o.fighters);
  const row = (name: string, fs: FightFighter[]): string => {
    const up = fs.reduce((a, f) => a + f.upS, 0);
    const min = Math.max(1e-6, up / 60);
    const self = fs.reduce((a, f) => a + f.falls.filter((x) => x.self).length, 0);
    const hit = fs.reduce((a, f) => a + f.falls.filter((x) => !x.self).length, 0);
    const m = fs.map((f) => f.metrics);
    const avg = (k: keyof BalanceMetrics) => mean(m.map((x) => x[k] as number).filter(Number.isFinite));
    return `  ${name.padEnd(11)} self-falls ${f2((self / min) * 2)}/2min (${self}), with a hit ${hit}; catch steps ${f1(fs.reduce((a, f) => a + f.captures, 0) / min)}/min; ` +
      `recovering ${pct(fs.reduce((a, f) => a + f.recoverS, 0) / Math.max(1e-6, up))}, no sole on the canvas ${pct(fs.reduce((a, f) => a + f.airS, 0) / Math.max(1e-6, up))}, ` +
      `leg contact ${pct(fs.reduce((a, f) => a + f.legContactS, 0) / Math.max(1e-6, up))}; strikes ${fs.reduce((a, f) => a + f.landed, 0)}/${fs.reduce((a, f) => a + f.thrown, 0)} landed; ` +
      `torso rate ${f2(avg('torsoRateLow'))}/${f2(avg('torsoRateHigh'))}, tilt peak ${f1(avg('tiltPeakDeg'))}°, DCM err ${f1(avg('dcmErrCm'))} cm, COP jump ${f1(maxOf(m.map((x) => x.copJumpCm)))} cm, gyro ${f2(avg('gyroSatFootwork'))}`;
  };
  for (const [d, fs] of byDesign) lines.push(row(d, fs));
  lines.push(row('all', all));
  lines.push(...summarizeAnatomy(all.flatMap((f) => f.falls.filter((x) => x.self && x.anatomy).map((x) => x.anatomy!))));
  if (scenario === 'replay') for (const o of rs) for (const f of o.fighters) if (f.narrative?.length) lines.push(`  ${f.design} in ${(o.job as Extract<Job, { kind: 'fight' }>).design} v ${(o.job as Extract<Job, { kind: 'fight' }>).opp} seed ${o.job.seed}:`, ...f.narrative.map((l) => `    ${l}`));
  return lines;
}

function applyTune(spec: string | undefined): void {
  if (!spec) return;
  for (const item of spec.split(',')) {
    const [path, raw] = item.split('=');
    const [table, key] = path.split('.');
    const t = TABLES[table];
    const v = Number(raw);
    if (!t || !(key in t) || typeof t[key] !== 'number' || !Number.isFinite(v)) throw new Error(`--tune: unknown or non-numeric ${item}`);
    t[key] = v;
  }
}

export async function runJob(job: Job): Promise<DrillOut> {
  applyTune(process.env.SD_TUNE);
  applyMotorVariants(process.env.SD_MOTORS);
  switch (job.kind) {
    case 'approach': return approach(job);
    case 'push': return pushTrial(job);
    case 'shuffle': return shuffle(job);
    case 'strike': return strikeTrial(job);
    case 'hit': return hitTrial(job);
    case 'fall': return fallTrial(job);
    case 'getup': return getupTrial(job);
    case 'fight': return fightTrial(job);
  }
}

// ------------------------------------------------------------------ the parent: jobs, ladders, summary

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function runChild(job: Job, balance: string): Promise<DrillOut> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, '--job', JSON.stringify(job)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, SD_BALANCE: balance, SD_TUNE: arg('tune', ''), ...(arg('window', '') ? { SD_STRIKE_WINDOW: arg('window', '') } : {}), ...(arg('guard', '') ? { SD_STRIKE_GUARD: arg('guard', '') } : {}), ...(arg('motors', '') ? { SD_MOTORS: arg('motors', '') } : {}), ...(arg('centroid', '') ? { SD_CENTROID_DIR: arg('centroid', '') } : {}), ...(process.argv.includes('--approach') ? { SD_STRIKE_APPROACH: '1' } : {}), ...(arg('mocap', '') ? { SD_MOCAP_FOOTWORK: arg('mocap', '') } : {}), ...(arg('ring', '') ? { SD_RING_IQ: arg('ring', '') } : {}) },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || !line) reject(new Error(`${JSON.stringify(job)} exited ${code}`));
      else resolve(JSON.parse(line, revive) as DrillOut);
    });
  });
}

/** Times that never came (Infinity) travel as null in JSON: back to Infinity. */
const NEVER_KEYS = new Set(['stableAfter', 'fallAt', 'braceAt', 'contactAt', 'moveAt', 'upAt', 'stableAt', 'timeTo13', 'arrivedAt']);
function revive(key: string, value: unknown): unknown {
  return value === null && NEVER_KEYS.has(key) ? Infinity : value;
}

/** A queue of tasks run at most `jobs` at a time; a task may queue more (push ladders). */
async function pool(tasks: Array<() => Promise<void>>, jobs: number): Promise<void> {
  const worker = async () => {
    for (let t = tasks.shift(); t; t = tasks.shift()) await t();
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : String(x));
const ok = (pass: boolean) => (pass ? 'PASS' : 'FAIL');

export function summarizeApproach(outs: ApproachOut[], design: string): string[] {
  const rs = outs.filter((o) => o.job.design === design).flatMap((o) => o.robots.map((m) => ({ m, job: o.job as Extract<Job, { kind: 'approach' }>, o })));
  if (!rs.length) return [];
  const falls = rs.filter(({ m }) => m.falls.length > 0);
  const closing = rs.filter(({ m }) => m.closingSeconds > 0.5).map(({ m }) => m.closingSpeed);
  const four = rs.filter(({ job }) => job.dist === 4).map(({ m }) => m.timeTo13);
  const minSpeed = design === 'firecracker' ? 0.55 : 0.6;
  const cs = mean(closing), t4 = maxOf(four);
  const single = mean(rs.map(({ m }) => m.singleInside2));
  const after = rs.map(({ m }) => m.stepsAfterArrive).sort((a, b) => a - b);
  const low = mean(rs.map(({ m }) => m.torsoRateLow)), high = mean(rs.map(({ m }) => m.torsoRateHigh));
  const tilt = rs.map(({ m }) => m.tiltPeakDeg);
  const pstd = mean(rs.map(({ m }) => m.pelvisStdCm));
  const jump = rs.map(({ m }) => m.copJumpCm);
  const dcm = mean(rs.map(({ m }) => m.dcmErrCm));
  const lim = mean(rs.map(({ m }) => m.servoLimitShare));
  const sat = mean(rs.map(({ m }) => m.gyroSatFootwork));
  const res = mean(rs.map(({ m }) => m.reserveAtTouchdown));
  const us = mean(outs.filter((o) => o.job.design === design).map((o) => o.controlUs));
  return [
    `  approach-and-hold ${rs.length} fighter-drills (${outs.filter((o) => o.blowup).length} blow-ups)`,
    `    falls                          ${falls.length}${falls.length ? ` (${falls.map(({ job, m }) => `${job.dist}m/${job.angle}°@${f1(m.falls[0].t)}s ${m.falls[0].activity}`).join(', ')})` : ''}   target 0   ${ok(falls.length === 0)}`,
    `    closing speed beyond 1.3 m     ${f2(cs)} m/s   target >= ${minSpeed}   ${ok(cs >= minSpeed)}`,
    `    4 m to 1.3 m (worst)           ${f1(t4)} s (each ${four.map(f1).join(' ')})   target <= 3.5   ${ok(t4 <= 3.5)}`,
    `    single support inside 2 m      ${pct(single)}   target <= 50%   ${ok(single <= 0.5)}`,
    `    steps after arriving           median ${after[Math.floor(after.length / 2)]}, max ${after[after.length - 1]}   target <= 2`,
    `    torso rate below / above 3 Hz  ${f2(low)} / ${f2(high)} rad/s RMS   target <= 0.30 / 0.25   ${ok(low <= 0.3 && high <= 0.25)}`,
    `    tilt peak beyond stance lean   mean ${f1(mean(tilt))}°, worst ${f1(maxOf(tilt))}° (lean ${f1(mean(rs.map(({ m }) => m.standingLeanDeg)))}°)   target <= 6   ${ok(maxOf(tilt) <= 6)}`,
    `    pelvis height std              ${f2(pstd)} cm   target <= 1.5   ${ok(pstd <= 1.5)}`,
    `    planned-COP jump per tick      worst ${f1(maxOf(jump))} cm, mean worst ${f1(mean(jump))} cm, p99 ${f1(mean(rs.map(({ m }) => m.copJumpP99Cm)))} cm   target <= 2   ${ok(maxOf(jump) <= 2)}`,
    `    DCM error RMS                  ${f1(dcm)} cm   target <= 2   ${ok(dcm <= 2)}`,
    `    planted-leg servo at limit     ${pct(lim)}   target <= 3%   ${ok(lim <= 0.03)}`,
    `    gyro saturation in footwork    ${f2(sat)} (peak ${f2(maxOf(rs.map(({ m }) => m.gyroSatPeak)))})   target <= 0.10   ${ok(sat <= 0.1)}`,
    `    reserve at touchdown           mean ${f2(res)}, min ${f2(Math.min(...rs.map(({ m }) => m.reserveAtTouchdownMin)))}   target >= 0.6   ${ok(res >= 0.6)}`,
    `    torque reserve (planted legs)  worst servo's share of its torque p50 ${pct(mean(rs.map(({ m }) => m.torqueShareP50 ?? NaN)))}, p95 ${pct(mean(rs.map(({ m }) => m.torqueShareP95 ?? NaN)))}; at the limit by group ankle ${pct(mean(rs.map(({ m }) => m.limitByGroup?.ankle ?? NaN)))} knee ${pct(mean(rs.map(({ m }) => m.limitByGroup?.knee ?? NaN)))} hip ${pct(mean(rs.map(({ m }) => m.limitByGroup?.hip ?? NaN)))}; feed-forward clamped ${pct(mean(rs.map(({ m }) => m.ffClampShare ?? NaN)))} of ticks`,
    `    control cost                   ${f1(us)} µs per robot per step   target < 40   ${ok(us < 40)}`,
    `    mocap footwork                 clip steps ${pct(mean(rs.map(({ m }) => m.clipLiftShare ?? 0)))} of swings (+${pct(mean(rs.map(({ m }) => m.followLiftShare ?? 0)))} followed), ${pct(mean(rs.map(({ m }) => m.clipMoveShare ?? 0)))} of moving time; style on ${pct(mean(rs.map(({ m }) => m.styleShare ?? 0)))}; picks ${rs.reduce((a, { m }) => a + (m.picks ?? 0), 0)}, fallbacks ${rs.reduce((a, { m }) => a + (m.fallbacks ?? 0), 0)}`,
  ];
}

export function summarizePush(outs: PushOut[], design: string, situation: Situation): string[] {
  const rs = outs.filter((o) => o.job.design === design && (o.job as Extract<Job, { kind: 'push' }>).situation === situation);
  if (!rs.length) return [];
  if (arg('dvs', '')) {
    // Fixed levels: survival by level, and steps and time to stable over the survived.
    const levels = [...new Set(rs.map((o) => (o.job as Extract<Job, { kind: 'push' }>).dv))].sort((a, b) => a - b);
    const ok = rs.filter((o) => o.survived && o.applied);
    const steps = ok.map((o) => o.steps).sort((a, b) => a - b);
    const stable = ok.map((o) => o.stableAfter).filter(Number.isFinite).sort((a, b) => a - b);
    const within2 = ok.filter((o) => o.steps <= 2).length;
    return [`  push (${situation}) by level: ${levels.map((dv) => { const l = rs.filter((o) => (o.job as Extract<Job, { kind: 'push' }>).dv === dv); return `${dv.toFixed(1)}: ${l.filter((o) => o.survived).length}/${l.length}`; }).join(', ')}`
      + `; failed ${rs.filter((o) => !o.survived).map((o) => `${(o.job as Extract<Job, { kind: 'push' }>).dir}°@${(o.job as Extract<Job, { kind: 'push' }>).dv}`).join(' ') || 'none'}`
      + `; steps median ${steps[Math.floor(steps.length / 2)] ?? '-'} (≤ 2 in ${within2}/${ok.length}); stable after median ${f2(stable[Math.floor(stable.length / 2)] ?? NaN)} s`];
  }
  const dirs = [...new Set(rs.map((o) => (o.job as Extract<Job, { kind: 'push' }>).dir))].sort((a, b) => a - b);
  const cells = dirs.map((d) => {
    const list = rs.filter((o) => (o.job as Extract<Job, { kind: 'push' }>).dir === d);
    const survived = list.filter((o) => o.survived).map((o) => (o.job as Extract<Job, { kind: 'push' }>).dv);
    const best = survived.length ? Math.max(...survived) : 0;
    return { d, best, steps: list.filter((o) => o.survived).map((o) => o.steps), stable: list.filter((o) => o.survived).map((o) => o.stableAfter) };
  });
  const n11 = cells.filter((c) => c.best >= 1.1 - 1e-6).length;
  const steps = cells.flatMap((c) => c.steps).sort((a, b) => a - b);
  const stable = cells.flatMap((c) => c.stable).filter(Number.isFinite).sort((a, b) => a - b);
  return [
    `  push (${situation}): max ΔV survived by direction ${cells.map((c) => `${c.d}°:${f1(c.best)}`).join(' ')} m/s; 1.1 m/s survived ${n11}/${cells.length}` +
      `; steps median ${steps[Math.floor(steps.length / 2)] ?? '-'}; stable after median ${f2(stable[Math.floor(stable.length / 2)] ?? NaN)} s${rs.some((o) => !o.applied) ? ` (${rs.filter((o) => !o.applied).length} not applied)` : ''}`,
  ];
}

export function summarizeShuffle(outs: ShuffleOut[], design: string): string[] {
  const o = outs.find((x) => x.job.design === design);
  if (!o) return [];
  const m = o.metrics;
  return [
    `  shuffle: falls ${m.falls.length}${m.falls.length ? ` (${m.falls.map((x) => `${f1(x.t)}s ${x.activity}`).join(', ')})` : ''}, legs ${o.legs.map((l) => `${l.leg} ${Number.isFinite(l.arrived) ? f1(l.arrived) + 's' : l.leg.startsWith('circle') ? '' : 'never'}/${l.steps}st`).join(', ')}`,
    `    single support ${pct(m.singleInside2)}, torso rate ${f2(m.torsoRateLow)}/${f2(m.torsoRateHigh)}, tilt ${f1(m.tiltPeakDeg)}°, COP jump ${f1(m.copJumpCm)} cm, DCM err ${f1(m.dcmErrCm)} cm, servo at limit ${pct(m.servoLimitShare)}, gyro ${f2(m.gyroSatFootwork)}, control ${f1(o.controlUs)} µs${o.blowup ? ', BLOW-UP' : ''}`,
    `    torque reserve: worst planted servo p50 ${pct(m.torqueShareP50 ?? NaN)} / p95 ${pct(m.torqueShareP95 ?? NaN)} of its torque; at the limit ankle ${pct(m.limitByGroup?.ankle ?? NaN)} knee ${pct(m.limitByGroup?.knee ?? NaN)} hip ${pct(m.limitByGroup?.hip ?? NaN)}; feed-forward clamped ${pct(m.ffClampShare ?? NaN)}; gyro reserve at touchdown mean ${f2(m.reserveAtTouchdown)} min ${f2(m.reserveAtTouchdownMin)}`,
    `    mocap footwork: clip steps ${pct(m.clipLiftShare ?? 0)} of swings (+${pct(m.followLiftShare ?? 0)} followed), ${pct(m.clipMoveShare ?? 0)} of moving time, style on ${pct(m.styleShare ?? 0)}`,
  ];
}

const pctile = (xs: number[], q: number) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : NaN;
};

export function summarizeStrikes(outs: StrikeOut[], design: string): string[] {
  const all = outs.filter((o) => o.job.design === design);
  const rs = all.filter((o) => o.started);
  if (!all.length) return [];
  const lines: string[] = [`  strikes (standing mirror opponent${process.argv.includes('--approach') ? ', walked in on an intent' : ', from the throw window'}; ${all.length - rs.length} not started):`];
  const ids = [...new Set(rs.map((o) => (o.job as Extract<Job, { kind: 'strike' }>).skill))];
  for (const id of ids) {
    const t = rs.filter((o) => (o.job as Extract<Job, { kind: 'strike' }>).skill === id);
    const hit = t.filter((o) => o.impact);
    const v = hit.map((o) => o.vContact), imp = hit.map((o) => o.impulse);
    const clean = hit.filter((o) => o.part === 'head' || o.part === 'torso' || o.part === 'pelvis' || /thigh|shin/.test(o.part ?? '')).length;
    const steps = t.filter((o) => o.step).length;
    const lunges = t.filter((o) => o.lunge).length;
    lines.push(`    ${id.padEnd(10)} ${t[0].mocap ? 'mocap' : 'proc '} landed ${hit.length}/${t.length}${steps ? ` (${steps} from a step)` : ''}${lunges ? ` (${lunges} stepped in)` : ''} (clean ${clean}), falls ${t.filter((o) => o.fell).length}, capture steps ${t.reduce((a, o) => a + o.captureSteps, 0)}`
      + `; contact p50/p90 ${f1(pctile(v, 0.5))}/${f1(pctile(v, 0.9))} m/s (peak ${f1(pctile(t.map((o) => o.vPeak), 0.5))}), impulse p50/p90 ${f1(pctile(imp, 0.5))}/${f1(pctile(imp, 0.9))} N·s`
      + `, start→contact ${f2(pctile(hit.map((o) => o.tContact), 0.5))} s, elbow ${f2(pctile(hit.map((o) => o.elbow), 0.5))} rad, COM into it ${f2(pctile(hit.map((o) => o.comAlong), 0.5))} m/s, torso yaw ${f1(pctile(t.map((o) => o.torsoYawRate), 0.5))} rad/s, gyro ${f2(pctile(t.map((o) => o.gyroPeak), 0.9))}`);
  }
  const punches = rs.filter((o) => SKILLS[(o.job as Extract<Job, { kind: 'strike' }>).skill]?.kind === 'arm');
  const kicks = rs.filter((o) => SKILLS[(o.job as Extract<Job, { kind: 'strike' }>).skill]?.kind === 'leg');
  const per = (xs: StrikeOut[], k: number) => (xs.length ? (k * xs.filter((o) => o.fell).length) / xs.length : NaN);
  lines.push(`    falls per 50 punches ${f2(per(punches, 50))} (${punches.length}), per 10 kicks ${f2(per(kicks, 10))} (${kicks.length})   target <= 1 / <= 1`);
  return lines;
}

/** Get-up targets per design, first movement to stable standing (docs/design/strike-power.md §4.6): median, p90. */
const GETUP_TARGET: Record<string, [number, number]> = {
  firecracker: [1.5, 2.5], savate: [2.0, 3.0], pylon: [2.2, 3.0], haymaker: [2.5, 3.5], striker: [2.5, 3.5], bruiser: [4, 6], goliath: [4, 6],
};
const GETUP_WITHIN_S = 5; // success: standing within this long of going down (healthy legs: >= 95%)

/** Falls (from hits that felled the robot, and shoves past capture): the brace, what landed first, the get-up. */
export function summarizeFalls(outs: ReactOut[], design: string): string[] {
  const fs = outs.filter((o) => o.job.design === design && o.applied && o.fell);
  if (!fs.length) return [];
  const touched = fs.filter((o) => Number.isFinite(o.contactAt));
  const braced = touched.filter((o) => o.braceAt <= o.contactAt);
  const head = touched.filter((o) => o.contactParts.includes('head'));
  const cls = new Map<string, number>();
  for (const o of touched) {
    const k = [...new Set(o.contactParts.map(contactClass))].sort().join('+');
    cls.set(k, (cls.get(k) ?? 0) + 1);
  }
  const lead = braced.map((o) => o.contactAt - o.braceAt);
  const g = fs.map((o) => o.getup).filter((x): x is GetupTimes => !!x);
  const up5 = g.filter((x) => x.stableAt <= GETUP_WITHIN_S).length;
  const move = g.map((x) => x.stableAt - x.moveAt).filter(Number.isFinite);
  const total = g.map((x) => x.stableAt).filter(Number.isFinite);
  const [tm, tp] = GETUP_TARGET[design] ?? [2.5, 3.5];
  const share = (k: number, n: number) => (n ? k / n : NaN);
  return [
    `  falls ${fs.length} (${outs.filter((o) => o.job.design === design && o.kind === 'fall').length} shoves past capture, ${fs.filter((o) => o.kind === 'hit').length} from hits)`,
    `    brace before the first non-foot contact   ${pct(share(braced.length, touched.length))} (${braced.length}/${touched.length}), lead median ${f2(pctile(lead, 0.5))} s   target >= 90%   ${ok(share(braced.length, touched.length) >= 0.9)}`,
    `    head first                                ${pct(share(head.length, touched.length))} (${head.length}/${touched.length})   target <= 10%   ${ok(share(head.length, touched.length) <= 0.1)}`,
    `    first contact by part                     ${[...cls].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `    get-up: standing within ${GETUP_WITHIN_S} s of the fall ${up5}/${g.length}; first movement to stable median/p90 ${f2(pctile(move, 0.5))}/${f2(pctile(move, 0.9))} s (target ${tm}/${tp}); fall to stable ${f2(pctile(total, 0.5))}/${f2(pctile(total, 0.9))} s`,
  ];
}

/** Hits that did not fell the robot: recovery steps and time to stable (§8), by blow. */
export function summarizeHits(outs: ReactOut[], design: string): string[] {
  const hs = outs.filter((o) => o.job.design === design && o.kind === 'hit' && o.applied);
  if (!hs.length) return [];
  const lines: string[] = [];
  const keys = [...new Set(hs.map((o) => { const j = o.job as Extract<Job, { kind: 'hit' }>; return `${j.situation} ${j.part} ${j.impulse}`; }))];
  for (const k of keys) {
    const t = hs.filter((o) => { const j = o.job as Extract<Job, { kind: 'hit' }>; return `${j.situation} ${j.part} ${j.impulse}` === k; });
    const ok2 = t.filter((o) => !o.fell);
    const steps = ok2.map((o) => o.steps);
    const st = ok2.map((o) => o.stableAfter);
    const m = (name: string) => t.filter((o) => name in o.modes).length;
    lines.push(`    ${k.padEnd(18)} N·s: stayed up ${ok2.length}/${t.length}, steps median ${pctile(steps, 0.5)} (max ${steps.length ? Math.max(...steps) : '-'}), stable after median/p90 ${f2(pctile(st, 0.5))}/${f2(pctile(st, 0.9))} s, gyro peak ${f2(pctile(t.map((o) => o.satPeak), 0.5))}, DCM out ${f1(100 * pctile(t.map((o) => o.xiOutPeak), 0.5))} cm; absorb ${m('absorb')} recover ${m('recover')} brace ${m('brace')}`);
  }
  const up = hs.filter((o) => !o.fell);
  const stepped = up.filter((o) => o.steps > 0);
  const allSteps = up.map((o) => o.steps), recSteps = stepped.map((o) => o.steps);
  const st = up.map((o) => o.stableAfter), stRec = stepped.map((o) => o.stableAfter);
  const stMed = pctile(stRec, 0.5);
  return [
    `  hits ${hs.length}: stayed up ${up.length} (${stepped.length} with a recovery step); recovery steps median ${pctile(recSteps, 0.5)}   target <= 2   ${ok(pctile(recSteps, 0.5) <= 2)}; time to stable over recoveries median ${f2(stMed)} s, p90 ${f2(pctile(stRec, 0.9))} s   target <= 0.8   ${ok(stMed <= 0.8)} (all hits that stayed up: median ${f2(pctile(st, 0.5))}, p90 ${f2(pctile(st, 0.9))}, never ${st.filter((x) => !Number.isFinite(x)).length}; steps median ${pctile(allSteps, 0.5)})`,
    ...lines,
  ];
}

/** Laid on the canvas: get-up success and times, by orientation (strike-power.md §4.6). */
export function summarizeGetups(outs: GetupOut[], design: string): string[] {
  const gs = outs.filter((o) => o.job.design === design);
  if (!gs.length) return [];
  const [tm, tp] = GETUP_TARGET[design] ?? [2.5, 3.5];
  const move = gs.map((o) => o.times.stableAt - o.times.moveAt).filter(Number.isFinite);
  const total = gs.map((o) => o.times.stableAt).filter(Number.isFinite);
  const within = gs.filter((o) => o.times.stableAt <= GETUP_WITHIN_S).length;
  const mMed = pctile(move, 0.5), mP90 = pctile(move, 0.9);
  const by = (['face_down', 'back', 'side_l', 'side_r'] as const).map((or) => {
    const l = gs.filter((o) => (o.job as Extract<Job, { kind: 'getup' }>).orient === or);
    if (!l.length) return '';
    const t = l.map((o) => o.times.stableAt - o.times.moveAt).filter(Number.isFinite);
    return `${or} ${l.filter((o) => o.ok).length}/${l.length} ${f2(pctile(t, 0.5))} s`;
  }).filter(Boolean);
  const fails = gs.filter((o) => !o.ok).map((o) => `${(o.job as Extract<Job, { kind: 'getup' }>).orient}#${o.job.seed}: ${o.why || 'timeout'}`);
  return [
    `  get-ups (laid down) ${gs.length}: standing within ${GETUP_WITHIN_S} s ${within}/${gs.length} (${pct(within / gs.length)})   target >= 95%   ${ok(within / gs.length >= 0.95)}`,
    `    first movement to stable median ${f2(mMed)} s, p90 ${f2(mP90)} s   target ${tm} / ${tp}   ${ok(mMed <= tm && mP90 <= tp)}; down to stable median ${f2(pctile(total, 0.5))}, p90 ${f2(pctile(total, 0.9))} s; balance took over at median ${f2(pctile(gs.map((o) => o.times.upAt - o.times.moveAt), 0.5))} s after the first movement`,
    `    by orientation: ${by.join(', ')}${fails.length ? `; failed: ${fails.slice(0, 6).join(' | ')}` : ''}`,
  ];
}

/** Get-ups from recorded fall endings: standing, the hand-over to balance (the fights' measure), by orientation. */
export function summarizePoses(outs: GetupOut[], design: string): string[] {
  const gs = outs.filter((o) => o.job.design === design);
  if (!gs.length) return [];
  const n = gs.length;
  const s5 = gs.filter((o) => o.times.stableAt <= GETUP_WITHIN_S).length;
  const s10 = gs.filter((o) => o.times.stableAt <= 10).length;
  const up10 = gs.filter((o) => o.times.upAt <= 10).length;
  const by = (['face_down', 'back', 'side_l', 'side_r'] as const).map((or) => {
    const l = gs.filter((o) => (o.job as Extract<Job, { kind: 'getup' }>).orient === or);
    if (!l.length) return '';
    return `${or} up ${l.filter((o) => o.times.upAt <= 10).length}/${l.length} (${f2(pctile(l.map((o) => o.times.upAt), 0.5))} s)`;
  }).filter(Boolean);
  const fails = new Map<string, number>();
  for (const o of gs) for (const w of o.times.fails ?? []) {
    const k = w.replace(/ at [0-9.]+\/[0-9.]+ s/, '').replace(/\(pelvis [0-9.]+ m below the clip\)/, '').trim();
    fails.set(k, (fails.get(k) ?? 0) + 1);
  }
  return [
    `  get-ups (recorded falls) ${n}: handed over to balance within 10 s ${up10}/${n} (${pct(up10 / n)}), median ${f2(pctile(gs.map((o) => o.times.upAt), 0.5))} s   target >= 95%   ${ok(up10 / n >= 0.95)}`,
    `    standing (stable) within ${GETUP_WITHIN_S} s ${s5}/${n}, within 10 s ${s10}/${n}; fall to stable median ${f2(pctile(gs.map((o) => o.times.stableAt), 0.5))} s`,
    `    by orientation: ${by.join(', ')}${fails.size ? `; failed attempts: ${[...fails].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ×${v}`).join(' | ')}` : ''}`,
  ];
}

async function main(): Promise<void> {
  const ji = process.argv.indexOf('--job');
  if (ji >= 0) {
    const out = await runJob(JSON.parse(process.argv[ji + 1]) as Job);
    console.log(JSON.stringify(out));
    return;
  }
  const sumFile = arg('summary', '');
  const saved = sumFile ? JSON.parse(readFileSync(sumFile, 'utf8'), revive) as { results: DrillOut[]; designs: string[]; balance: string; label: string } : null;
  const drills = arg('drills', 'approach,push,shuffle').split(',');
  const designs = saved ? saved.designs : arg('designs', MODERN.join(',')).split(',');
  const balance = saved ? saved.balance : arg('balance', CONTROL.balance);
  // At most 2 at once on a shared Mac; speed mode (Chris, 2026-10-07) allows up to 7 heavy processes.
  const jobs = Math.min(7, Math.max(1, Number(arg('jobs', '2'))));
  const quick = process.argv.includes('--quick');
  const label = arg('label', quick ? 'quick' : 'full');
  const situations = arg('situations', 'stance,walk').split(',') as Situation[];
  const seed = Number(arg('seed', '1'));
  const results: DrillOut[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const t0 = performance.now();
  const add = (job: Job, then?: (o: DrillOut) => void) => tasks.push(async () => {
    const o = await runChild(job, balance);
    results.push(o);
    then?.(o);
  });
  for (const design of designs) {
    if (drills.includes('approach')) {
      const dists = quick ? [4] : [3, 4, 5, 6];
      const angles = quick ? [0, 30] : [0, 15, -15, 30, -30];
      for (const dist of dists) for (const angle of angles) add({ kind: 'approach', design, dist, angle, seconds: APPROACH_S, seed });
    }
    if (drills.includes('shuffle')) add({ kind: 'shuffle', design, seed });
    if (drills.includes('strikes')) {
      const want = arg('skills', '').split(',').filter(Boolean);
      const trials = Number(arg('trials', '8'));
      const d = (await import('../src/robots/designs')).design(design);
      const ids = (d.abilities as string[]).filter((a) => SKILLS[a as SkillId] && isStrikeSkill(SKILLS[a as SkillId]!) && (!want.length || want.includes(a))) as SkillId[];
      for (const skill of ids) for (let trial = 0; trial < trials; trial++) add({ kind: 'strike', design, skill, trial, seed: seed + trial });
    }
    if (drills.includes('hits')) {
      // §8: torso and head hits of 20, 40 and 73 N·s from 8 directions (--impulses, --hit-parts, --hit-situations).
      const imps = arg('impulses', '20,40,73').split(',').map(Number);
      const parts = arg('hit-parts', 'torso,head').split(',') as Array<'torso' | 'head'>;
      const sits = arg('hit-situations', 'stance').split(',') as Situation[];
      for (const situation of sits) for (const part of parts) for (const impulse of imps) for (let dir = 0; dir < 360; dir += 45) add({ kind: 'hit', design, part, impulse, dir, situation, seed });
    }
    if (drills.includes('falls')) {
      // Shoves past capture (--fall-dvs), 8 directions: the brace, what lands first, the get-up.
      for (const dv of arg('fall-dvs', '2.2').split(',').map(Number)) for (let dir = 0; dir < 360; dir += 45) add({ kind: 'fall', design, dir, dv, seed });
    }
    if (drills.includes('getups')) {
      const n = Number(arg('getup-seeds', '3'));
      const orients = arg('getup-orients', 'face_down,back,side_l,side_r').split(',') as Orient[];
      for (const orient of orients) for (let k = 1; k <= n; k++) add({ kind: 'getup', design, orient, seed: k });
    }
    if (drills.includes('poses')) {
      const file = arg('getup-poses', '');
      if (!file) throw new Error('--drills poses needs --getup-poses file.jsonl');
      const max = Number(arg('getup-max', '999'));
      // (A fixture may hold fall endings of both balance paths: the ones recorded on this drill's path, unless --getup-path all.)
      const path = arg('getup-path', balance);
      const poses = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FallPose & { design: string; seed?: number; t?: number; opp?: string; path?: string })
        .filter((p) => p.design === design && (path === 'all' || !p.path || p.path === path)).slice(0, max);
      poses.forEach((p, k) => add({ kind: 'getup', design, orient: p.orient, seed: k + 1, pose: { orient: p.orient, root: p.root, joints: p.joints, src: `${p.opp ?? '?'} s${p.seed ?? '?'} ${p.t ?? '?'} s` } }));
    }
    if (drills.includes('fight')) {
      // --pairs red:blue,... (default: this design against itself), --scenarios, --seeds, --fight-s.
      const pairs = arg('pairs', '').split(',').filter(Boolean).map((x) => x.split(':') as [string, string]).filter(([a]) => a === design);
      const scen = arg('scenarios', 'exchange,press').split(',') as FightScenario[];
      const seeds = arg('seeds', '1,2,3,4').split(',').map(Number);
      const secs = Number(arg('fight-s', '12'));
      for (const [a, b] of pairs.length ? pairs : [[design, design] as [string, string]]) for (const scenario of scen) for (const sd of seeds) add({ kind: 'fight', scenario, design: a, opp: b, seed: sd, seconds: secs });
    }
    if (drills.includes('push')) {
      // --dvs 1.0,1.1,1.2: every direction at each of these shoves (no ladder): a survival rate around a
      // level, which one ladder (stopped at its first fall) or one level cannot give.
      const dvs = arg('dvs', '').split(',').filter(Boolean).map(Number);
      for (const situation of situations) {
        if (dvs.length) {
          for (let dir = 0; dir < 360; dir += 45) for (const dv of dvs) add({ kind: 'push', design, situation, dir, dv, seed });
          continue;
        }
        for (let dir = 0; dir < 360; dir += 45) {
          // A ladder: 0.6 m/s up by 0.1 to the first fall (quick: 1.1 only).
          const ladder = (dv: number): void => void add({ kind: 'push', design, situation, dir, dv, seed }, (o) => {
            const p = o as PushOut;
            if (!quick && p.survived && p.applied && dv < 2.45) {
              ladder(Math.round((dv + 0.1) * 10) / 10);
            }
          });
          ladder(quick ? 1.1 : Number(arg('ladder-from', '0.6')));
        }
      }
    }
  }
  if (saved) {
    tasks.length = 0;
    results.push(...saved.results);
  }
  await pool(tasks, jobs);
  const tune = arg('tune', '');
  const mocap = arg('mocap', process.env.SD_MOCAP_FOOTWORK ?? 'steps');
  const ring = arg('ring', process.env.SD_RING_IQ ?? '1');
  const lines: string[] = [`balance drills (${balance}, mocap footwork ${mocap}, ring IQ ${ring}, ${label}${tune ? `, tune ${tune}` : ''}), wall ${((performance.now() - t0) / 1000).toFixed(0)} s`];
  for (const design of designs) {
    lines.push(`${design}:`);
    lines.push(...summarizeApproach(results.filter((o): o is ApproachOut => o.kind === 'approach'), design));
    lines.push(...summarizeShuffle(results.filter((o): o is ShuffleOut => o.kind === 'shuffle'), design));
    for (const situation of situations) lines.push(...summarizePush(results.filter((o): o is PushOut => o.kind === 'push'), design, situation));
    lines.push(...summarizeStrikes(results.filter((o): o is StrikeOut => o.kind === 'strike'), design));
    const react = results.filter((o): o is ReactOut => o.kind === 'hit' || o.kind === 'fall');
    lines.push(...summarizeHits(react, design));
    lines.push(...summarizeFalls(react, design));
    lines.push(...summarizeGetups(results.filter((o): o is GetupOut => o.kind === 'getup' && !o.job.pose), design));
    lines.push(...summarizePoses(results.filter((o): o is GetupOut => o.kind === 'getup' && !!o.job.pose), design));
  }
  if (drills.includes('fight')) {
    const fo = results.filter((o): o is FightOut => o.kind === 'fight');
    for (const sc of ['exchange', 'press', 'replay'] as const) lines.push(...summarizeFight(fo, sc));
  }
  // Phase 4 gate over all designs (§9): recovery steps, time to stable, brace before contact, head first.
  const react = results.filter((o): o is ReactOut => (o.kind === 'hit' || o.kind === 'fall') && o.applied);
  if (react.length) {
    const up = react.filter((o) => o.kind === 'hit' && !o.fell);
    const rec = up.filter((o) => o.steps > 0).map((o) => o.steps);
    const st = up.filter((o) => o.steps > 0).map((o) => o.stableAfter);
    const falls = react.filter((o) => o.fell && Number.isFinite(o.contactAt));
    const braced = falls.filter((o) => o.braceAt <= o.contactAt).length;
    const head = falls.filter((o) => o.contactParts.includes('head')).length;
    lines.push(`PHASE 4 GATE: recovery steps median ${pctile(rec, 0.5)} (${rec.length} hits that stepped)   <= 2 ${ok(pctile(rec, 0.5) <= 2)}; time to stable over recoveries median ${f2(pctile(st, 0.5))} s   <= 0.8 ${ok(pctile(st, 0.5) <= 0.8)}; hits survived ${up.length}/${react.filter((o) => o.kind === 'hit').length}; brace before contact ${pct(braced / Math.max(1, falls.length))} (${braced}/${falls.length})   >= 90% ${ok(braced >= 0.9 * falls.length && falls.length > 0)}; head first ${pct(head / Math.max(1, falls.length))} (${head}/${falls.length})   <= 10% ${ok(head <= 0.1 * falls.length)}`);
  }
  console.log(lines.join('\n'));
  if (saved) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${label}-${balance}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ balance, label, drills, designs, results, summary: lines }, null, 1));
  console.log(`saved ${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
