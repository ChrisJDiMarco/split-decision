// Head gaze. Runs after control and writes only the neck targets, so the body's motion is whatever
// the controller planned and the head does what a fighter's head does:
//   track   fixate the opponent's head, re-fixating in saccade-like snaps (hold, then jump)
//   threat  snap to an incoming strike: the opponent's fastest-closing fist or foot, or his windup
//   aim     glance at the target zone just before throwing (own strike in its windup)
//   down    on the canvas or rising: look at the spot the lower hand is planting on
//   scan    before the bell and when nobody is in reach: sweep either side of the opponent
// A knocked-out robot's head is left alone (the controller has already let its joints go).
//
// Neck interface: a GazeCommand carries yaw and pitch relative to the torso. neck_yaw exists on every
// humanoid today; if a design gains a 'neck_pitch' joint (the balance-engine build), its target is
// written from the same command (chin tuck under threat, looking down to the canvas), no other change.
//
// lock (telemetry, 0..1) flares when the fighter commits to a big shot: a flourish, a flashy move,
// a power shot, or a pre-armed reflex (Intent.onOpening / counterIfLunge) firing. The render kit
// turns it into a lens flare; physics ignores it.
import { FLASHY_MOVES, type GazeMode } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';

const UPDATE_EVERY_TICKS = 5; // 200 Hz gaze decisions; the neck target is rewritten every step
const SACCADE_DEG = 7; // re-fixate at once past this error
const MICRO_DEG = 1.5; // below this the eyes, not the neck, absorb the drift
const DWELL_MIN_S = 0.3; // fixation hold before a small corrective saccade
const DWELL_SPAN_S = 0.4;
const RANGE_MARGIN_RAD = 0.05;
const THREAT_WINDUP = 0.25; // opponent telegraph that draws the eyes
const THREAT_CLOSING_MS = 2.5; // an effector closing faster than this (m/s)...
const THREAT_RANGE_M = 1.8; // ...from within this far is an incoming strike
const SCAN_RANGE_M = 4.0; // nobody within this: scan
const SCAN_OFFSETS_DEG = [0, -24, 0, 22];
const SCAN_HOLD_S = 0.7;
const LOCK_DECAY_S = 0.35;
const CHIN_TUCK_RAD = 0.22; // neck pitch down under threat (only if a neck_pitch joint exists)
const DOWN_PITCH_RAD = 0.6;
const FALL_UPRIGHT = 0.55; // torso up-axis z below this: falling, look for the canvas

const NON_STRIKES = new Set(['stance', 'step', 'guard', 'clinch', 'out', 'sprint', 'walk']);
const BIG_SHOTS = new Set<string>(['overhand', 'uppercut', 'head_kick', 'rocket_punch', 'hammer_smash', 'jaw_crush', 'lunge', ...FLASHY_MOVES]);
const EFFECTORS = ['fist_l', 'fist_r', 'foot_l', 'foot_r'] as const;
const ZONE_PART: Record<string, string> = {
  head: 'head', torso: 'torso', left_arm: 'forearm_l', right_arm: 'forearm_r', left_leg: 'shin_l', right_leg: 'shin_r', weapon: 'torso',
};

/**
 * Stabilisation input (the balance engine sets r.mem.gazeStabilize = true on its path): between
 * saccades the neck counter-turns the torso's own yaw since the fixation, so the head stays locked on
 * its target in the world while the hips and chest turn under it (a still head that tracks its target
 * is the cheapest cue of competence). The fixation itself is still this system's.
 */
export const GAZE_STABILIZE_KEY = 'gazeStabilize';

export interface GazeCommand {
  yaw: number; // neck yaw relative to the torso, rad
  pitch: number; // neck pitch, rad, + looks down (used only where a neck_pitch joint exists)
}

interface GazeState {
  neck: number; // r.targets index of neck_yaw (−1: none)
  pitch: number; // r.targets index of neck_pitch (−1: none yet)
  range: [number, number];
  head: number; // body ids
  torso: number;
  oppBodies: Record<string, number>;
  fists: [number, number];
  fixYaw: number;
  fixTorsoYaw: number; // torso world yaw when the fixation was taken (stabilisation)
  cmd: GazeCommand;
  nextSaccadeT: number;
  mode: GazeMode;
  point: Vec3;
  lock: number;
  lastSkill: string;
  prevEff: Float64Array; // opponent effector positions at the last update
  hasPrev: boolean;
  scanIndex: number;
  scanT: number;
}

const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Deterministic 0..1 noise (never ctx.rng: the gaze must not shift anyone else's random stream). */
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function stateOf(ctx: SimContext, r: RobotRuntime): GazeState | null {
  const cached = r.mem.gaze as GazeState | null | undefined;
  if (cached !== undefined) return cached;
  const neck = r.jointIndex.get('neck_yaw') ?? -1;
  const head = r.parts.get('head');
  const torso = r.parts.get('torso');
  const opp = ctx.robots[r.corner === 0 ? 1 : 0];
  const fl = r.parts.get('fist_l'), fr = r.parts.get('fist_r');
  if (neck < 0 || !head || !torso || !fl || !fr) {
    r.mem.gaze = null;
    return null;
  }
  const oppBodies: Record<string, number> = {};
  for (const [id, p] of opp.parts) oppBodies[id] = p.body;
  const def = r.design.parts.flatMap((p) => p.joints ?? []).find((j) => j.name === 'neck_yaw')!;
  const st: GazeState = {
    neck,
    pitch: r.jointIndex.get('neck_pitch') ?? -1,
    range: [def.rangeDeg[0] * DEG + RANGE_MARGIN_RAD, def.rangeDeg[1] * DEG - RANGE_MARGIN_RAD],
    head: head.body,
    torso: torso.body,
    oppBodies,
    fists: [fl.body, fr.body],
    fixYaw: r.targets[neck],
    fixTorsoYaw: torsoYaw(ctx.data.xmat as Float64Array, torso.body),
    cmd: { yaw: r.targets[neck], pitch: 0 },
    nextSaccadeT: 0,
    mode: 'scan',
    point: [0, 0, 0],
    lock: 0,
    lastSkill: r.skill,
    prevEff: new Float64Array(EFFECTORS.length * 3),
    hasPrev: false,
    scanIndex: 0,
    scanT: 0,
  };
  r.mem.gaze = st;
  return st;
}

function bodyPos(xpos: Float64Array, b: number): Vec3 {
  return [xpos[b * 3], xpos[b * 3 + 1], xpos[b * 3 + 2]];
}

function isStrike(skill: string): boolean {
  return !NON_STRIKES.has(skill) && !skill.startsWith('getup');
}

/** A committed big shot: flourish, flashy or power move, or a pre-armed reflex firing. */
function isBigCommit(r: RobotRuntime, skill: string): boolean {
  const it = r.intent;
  if (BIG_SHOTS.has(skill)) return true;
  if (!it) return false;
  if (it.flourish) return true;
  if (it.counterIfLunge === skill && it.tactic !== skill) return true;
  return !!it.onOpening && Object.values(it.onOpening).includes(skill as never) && it.tactic !== skill;
}

/** The opponent's fastest-closing effector within reach, or null. */
function incoming(st: GazeState, xpos: Float64Array, me: Vec3, dt: number): Vec3 | null {
  let best: Vec3 | null = null;
  let bestSpeed = THREAT_CLOSING_MS;
  EFFECTORS.forEach((id, k) => {
    const b = st.oppBodies[id];
    if (b === undefined) return;
    const p = bodyPos(xpos, b);
    const o = k * 3;
    if (st.hasPrev) {
      const d0 = Math.hypot(st.prevEff[o] - me[0], st.prevEff[o + 1] - me[1], st.prevEff[o + 2] - me[2]);
      const d1 = Math.hypot(p[0] - me[0], p[1] - me[1], p[2] - me[2]);
      const closing = (d0 - d1) / dt;
      if (d1 < THREAT_RANGE_M && closing > bestSpeed) {
        bestSpeed = closing;
        best = p;
      }
    }
    st.prevEff[o] = p[0];
    st.prevEff[o + 1] = p[1];
    st.prevEff[o + 2] = p[2];
  });
  st.hasPrev = true;
  return best;
}

/** Torso-frame yaw and pitch of a world point seen from the head's neck joint. */
function toCommand(xpos: Float64Array, xmat: Float64Array, st: GazeState, p: Vec3): GazeCommand {
  const h = st.head * 3;
  const dx = p[0] - xpos[h], dy = p[1] - xpos[h + 1], dz = p[2] - xpos[h + 2];
  const m = st.torso * 9; // rows of the torso rotation: local = Rᵀ·world
  const lx = xmat[m] * dx + xmat[m + 3] * dy + xmat[m + 6] * dz;
  const ly = xmat[m + 1] * dx + xmat[m + 4] * dy + xmat[m + 7] * dz;
  const lz = xmat[m + 2] * dx + xmat[m + 5] * dy + xmat[m + 8] * dz;
  return { yaw: Math.atan2(ly, lx), pitch: Math.atan2(-lz, Math.hypot(lx, ly)) };
}

function decide(ctx: SimContext, r: RobotRuntime, st: GazeState, dt: number): void {
  const opp = ctx.robots[r.corner === 0 ? 1 : 0];
  const xpos = ctx.data.xpos as Float64Array;
  const xmat = ctx.data.xmat as Float64Array;
  const me = bodyPos(xpos, st.head);
  const oppHead = bodyPos(xpos, st.oppBodies.head ?? st.oppBodies.torso);
  const threat = incoming(st, xpos, me, dt);
  const upright = xmat[st.torso * 9 + 8];

  // Lock-on: arms on entering a big shot's windup, holds through it, decays after.
  const skill = r.skill;
  const winding = r.windup > 0.02 && isStrike(skill);
  if (skill !== st.lastSkill && isStrike(skill) && isBigCommit(r, skill)) st.lock = 1;
  else if (!(winding && st.lock > 0.99)) st.lock *= Math.exp(-dt / LOCK_DECAY_S);
  st.lastSkill = skill;

  let mode: GazeMode;
  let point: Vec3;
  let pitch = 0;
  if (r.down || skill.startsWith('getup') || (ctx.released && upright < FALL_UPRIGHT)) {
    mode = 'down';
    const [a, b] = st.fists.map((f) => bodyPos(xpos, f));
    const low = a[2] <= b[2] ? a : b;
    point = [low[0], low[1], 0];
    pitch = DOWN_PITCH_RAD;
  } else if (winding) {
    mode = 'aim';
    const part = ZONE_PART[r.intent?.target ?? 'head'] ?? 'head';
    point = bodyPos(xpos, st.oppBodies[part] ?? st.oppBodies.torso);
  } else if (threat || (opp.windup > THREAT_WINDUP && isStrike(opp.skill))) {
    mode = 'threat';
    point = threat ?? oppHead;
    pitch = CHIN_TUCK_RAD;
  } else if (!ctx.released || Math.hypot(oppHead[0] - me[0], oppHead[1] - me[1]) > SCAN_RANGE_M) {
    mode = 'scan';
    st.scanT += dt;
    if (st.scanT > SCAN_HOLD_S) {
      st.scanT = 0;
      st.scanIndex = (st.scanIndex + 1) % SCAN_OFFSETS_DEG.length;
    }
    const a = SCAN_OFFSETS_DEG[st.scanIndex] * DEG;
    const dx = oppHead[0] - me[0], dy = oppHead[1] - me[1];
    point = [me[0] + dx * Math.cos(a) - dy * Math.sin(a), me[1] + dx * Math.sin(a) + dy * Math.cos(a), oppHead[2]];
  } else {
    mode = 'track';
    point = oppHead;
  }

  const want = toCommand(xpos, xmat, st, point);
  const yaw = clamp(want.yaw, st.range[0], st.range[1]);
  const err = Math.abs(yaw - st.fixYaw);
  // Saccades: a new mode or a big error snaps at once; a small one waits out the fixation dwell.
  if (mode !== st.mode || err > SACCADE_DEG * DEG || (err > MICRO_DEG * DEG && ctx.time >= st.nextSaccadeT)) {
    st.fixYaw = yaw;
    st.fixTorsoYaw = torsoYaw(xmat, st.torso);
    st.nextSaccadeT = ctx.time + DWELL_MIN_S + DWELL_SPAN_S * hash01(ctx.tick + r.corner * 7919);
  }
  st.mode = mode;
  st.point = point;
  st.cmd = { yaw: st.fixYaw, pitch: mode === 'aim' ? clamp(want.pitch, -0.3, 0.4) : pitch };
}

export const gazeSystem: SimSystem = {
  name: 'gaze',
  pre(ctx) {
    for (const r of ctx.robots) {
      const st = stateOf(ctx, r);
      if (!st || r.koReason) continue;
      const head = r.parts.get('head');
      if (head && !head.attached) continue;
      if (ctx.tick % UPDATE_EVERY_TICKS === 0) decide(ctx, r, st, ctx.dt * UPDATE_EVERY_TICKS);
      r.targets[st.neck] = r.mem[GAZE_STABILIZE_KEY] === true ? stabilized(ctx, st) : st.cmd.yaw;
      if (st.pitch >= 0) r.targets[st.pitch] = st.cmd.pitch;
    }
  },
  telemetry(_ctx, r, out) {
    const st = r.mem.gaze as GazeState | null | undefined;
    if (!st) return;
    out.gaze = { point: [st.point[0], st.point[1], st.point[2]], mode: st.mode, lock: r.koReason ? 0 : st.lock };
  },
};

function torsoYaw(xmat: Float64Array, torso: number): number {
  return Math.atan2(xmat[torso * 9 + 3], xmat[torso * 9]);
}

/** The fixation held in the world: the neck takes back the torso's yaw since it was taken. */
function stabilized(ctx: SimContext, st: GazeState): number {
  const d = torsoYaw(ctx.data.xmat as Float64Array, st.torso) - st.fixTorsoYaw;
  return clamp(st.cmd.yaw - Math.atan2(Math.sin(d), Math.cos(d)), st.range[0], st.range[1]);
}

/** Test/metrics hook: the gaze command and the neck's current tracking error (rad). */
export function gazeProbe(ctx: SimContext, r: RobotRuntime): { mode: GazeMode; cmd: GazeCommand; neckErr: number; desiredYaw: number } | null {
  const st = r.mem.gaze as GazeState | null | undefined;
  if (!st) return null;
  const q = ctx.data.qpos[r.joints[st.neck].qadr] as number;
  const want = toCommand(ctx.data.xpos as Float64Array, ctx.data.xmat as Float64Array, st, st.point);
  return { mode: st.mode, cmd: st.cmd, neckErr: Math.abs(q - st.cmd.yaw), desiredYaw: want.yaw };
}
