// Strikes played from the motion library (the SkillRunner runs them like any skill: commit
// window, telegraph, landing).
//   punches   feet stay planted; arms and neck follow the clip; a share of the clip's pelvis
//             turn, tilt, dip, waist bend and weight shift become posture offsets on the stance
//             (balance, the gait and the gyro keep it standing; the chest turns only with the
//             hips); up to the impact frame the striking fist runs from the guard to the live
//             target along the clip's own progress and bend (IK), so a clip thrown at a moving
//             head still lands on it, and the clip waits for a fist that lags its command
//   kicks     the gait shifts the weight onto the stance foot and lends the kicking leg; the
//             clip plays from lift-off with that leg in joint space (the aim warp bends the ankle's
//             path onto the target), the pelvis turning over as the clip does; after the impact
//             the clip rewinds to the chamber (a kick that lands comes back the way it went) and
//             the gait swings the foot down where it started
// Speed: each move plays as fast as its joints' motors allow at every frame (library.ts rate
// tables), up to PUNCH_SPEED / KICK_SPEED × the human source, scaled by aggression.
import type { Vec3 } from '../../../core/types';
import type { Move, MoveLabel } from '../../../robots/motions';
import { other } from '../gait';
import type { Side } from '../geometry';
import { armFK, armIK, legFK, legIKPoint, newArmAngles, newLegAngles, type ArmAngles, type LegAngles } from '../ik';
import { clamp, dot, minJerk, mulMtV, normalize, sub } from '../math';
import type { ClipSkill, ClipStep, SkillEnv, SkillPhase, SkillRun } from '../skills/types';
import { centroidSet } from './centroid';

const PUNCH_SPEED = 1.8; // wanted time scale at aggression 1 (× the human source); motors cap it
const KICK_SPEED = 1.6;
const BLEND_IN_S = 0.08;
const BLEND_OUT_CLIP_S = 0.12; // clip seconds before the end over which the guard comes back
// A fighter does not replay the actor's whole take: the punch starts this much clip time before
// its strike phase (the telegraph) and snaps back to the guard this much after its recovery starts.
const PUNCH_LEAD_IN_S = 0.15;
const PUNCH_RECOVER_S = 0.3;
/** Punch tuning (exported so tools can sweep it; the worker never changes it). */
export const PUNCH_TUNING = {
  warpShare: 0.4, // the aim warp bends this share of the path before the impact frame
  // On the way to the impact the clip waits for a fist that lags its command (a shoulder slower
  // than the elbow lets the arm straighten before it rises, and the blow drops into the chest).
  lagSlowM: 0.12, // fist this far behind its command: the clip slows...
  lagStopM: 0.3, // ...to MIN_PACE this far behind
  minPace: 0.15,
  // Up to the impact the striking fist runs from the guard to the aim along the clip's own chord
  // progress, keeping this share of the clip's bend away from that chord (a hook's loop, an
  // uppercut's scoop). The actor's hand starts wherever the actor held it; the robot's starts in
  // its guard, and an arm dropped to the actor's low start cannot rise in time (the blow sinks
  // into the chest).
  arc: 0.6,
};

/**
 * Strikes on the balance engine (docs/design/strike-power.md §2, balance-engine.md §5): played as
 * fast as the robot's own motors allow at every frame (the centroid tables' inverse dynamics on each
 * joint's torque-speed line, not a fixed share of no-load speed), the punch's peak-speed frame landing
 * on the first surface actually in the fist's path (his guard, else the target), then driven on through
 * it. The legacy path plays them as before. Exported so tools can sweep it; the worker never changes it.
 */
export const STRIKE_P3 = {
  punchRate: 2.5, // wanted time scale at aggression 1 (× the human source): the motors decide below it
  // A first contact nearer than the clip's own reach shortens every joint's travel: the motors take
  // that path faster (torque goes with travel × rate², so rate × 1/√(chord ratio)), up to this much.
  shortChordMax: 1.6,
  followM: 0.04, // the anchored path reaches the first surface plus this at the impact frame
  arriveHoldS: 0.06, // a fist that has not arrived waits at the impact frame at most this long
  guardSlackM: 0.03, // his fist is in the path within his fist's half-size plus mine plus this of the line
  minTravelM: 0.12, // a first surface nearer than this to where the fist starts is not warped to
  kickRate: 2.2, // as punchRate, for kicks
  // The aim warp moves the kicking leg (a quarter of the body) off its clip path, and the COM with it:
  // the warp is capped so that shift stays within this share of the stance sole's half-length.
  kickWarpShare: 0.5,
};

const KICK_CHAIN = (s: Side) => [`hip_yaw_${s}`, `hip_roll_${s}`, `hip_pitch_${s}`, `knee_${s}`];

const MAX_PUNCH_TRAVEL_M = 0.25; // punches that step further than this need footwork of their own
const SHIFT_FWD_M = 0.07; // the clip's weight transfer, clamped inside the stance's support
const SHIFT_SIDE_M = 0.05;
const FOLLOW_M = 0.1; // aim this far through the target surface
const PICK_TOP = 3; // pick among this many of the best moves (variety)
const ARRIVE_M = 0.07; // a fist further than this from where it is sent has not arrived yet...
const ARRIVE_HOLD_S = 0.2; // ...and the clip waits for it at the impact frame at most this long

const LEG_SHIFT_WAIT_S = 1.3; // a leg that never frees up abandons the kick
const KICK_FOLLOW_S = 0.05; // clip seconds past the impact frame before the rewind
const REWIND_SPEED = 1.3; // the rewind plays this fast (× source, motor-capped like the rest)
// A leg is heavy: its motors cannot accelerate it to the no-load-speed path the rate table
// allows for a light limb, and a path it lags cuts corners (the kick comes in low). Played slower.
const KICK_LIMIT_SCALE = 0.6;
const KICK_ARRIVE_M = 0.12;
const KICK_ARRIVE_HOLD_S = 0.25;
const RETURN_SWING = { shift: 0, shiftFraction: 1, swing: 0.3, lift: 0.04 };

// ---------------------------------------------------------------- clip helpers

/** Yaw, pitch, roll (Z·Y·X) of a quaternion [w, x, y, z]. */
function ypr(q: readonly number[]): [number, number, number] {
  const [w, x, y, z] = q;
  const r0 = 1 - 2 * (y * y + z * z), r3 = 2 * (x * y + w * z), r6 = 2 * (x * z - w * y);
  const r7 = 2 * (y * z + w * x), r8 = 1 - 2 * (x * x + y * y);
  return [Math.atan2(r3, r0), Math.asin(clamp(-r6, -1, 1)), Math.atan2(r7, r8)];
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export function readArm(env: SkillEnv, q: Float64Array, side: Side, out: ArmAngles): ArmAngles {
  const m = env.jm.arm[side];
  out.pitch = q[m.pitch];
  out.roll = q[m.roll];
  out.yaw = q[m.yaw];
  out.elbow = q[m.elbow];
  return out;
}

function readLeg(env: SkillEnv, q: Float64Array, side: Side, out: LegAngles): LegAngles {
  const m = env.jm.leg[side];
  out.hipYaw = q[m.hipYaw];
  out.hipRoll = q[m.hipRoll];
  out.hipPitch = q[m.hipPitch];
  out.knee = q[m.knee];
  out.anklePitch = q[m.anklePitch];
  out.ankleRoll = q[m.ankleRoll];
  return out;
}

export function lerpArm(a: ArmAngles, b: ArmAngles, w: number, out: ArmAngles): ArmAngles {
  out.pitch = a.pitch + (b.pitch - a.pitch) * w;
  out.roll = a.roll + (b.roll - a.roll) * w;
  out.yaw = a.yaw + (b.yaw - a.yaw) * w;
  out.elbow = a.elbow + (b.elbow - a.elbow) * w;
  return out;
}

/** The side a move strikes with as played (a mirrored clip strikes with the other side). */
const playedSide = (move: Move, mirror: boolean): Side | null => (move.side ? (mirror ? other(move.side) : move.side) : null);

/**
 * The best moves of a label for striking with `side`, as (move, mirror): the side as stored, or
 * the other side's moves mirrored. Scored on the striker speed the motors can actually deliver.
 */
function pickMove(env: SkillEnv, label: MoveLabel, side: Side, speed: number, maxTravel: number): { move: Move; mirror: boolean } | null {
  const set = env.mocap!;
  const cands: Array<{ move: Move; mirror: boolean; score: number }> = [];
  for (const move of set.byLabel.get(label) ?? []) {
    if (Math.hypot(move.travel[0], move.travel[1]) > maxTravel) continue;
    for (const mirror of [false, true]) {
      if (playedSide(move, mirror) !== side) continue;
      const imp = move.impact ?? move.reach ?? move.phases.recover;
      const rates = set.rates(move, label.endsWith('kick') ? 'legs' : 'upper');
      const rate = Math.min(speed, rates[Math.min(rates.length - 1, Math.round(imp * move.fps))]);
      // Same-side moves first; clean ones first.
      const score = move.peakSpeed * rate * (1 - move.quality.limitRate) * (mirror ? 0.85 : 1);
      cands.push({ move, mirror, score });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, PICK_TOP);
  const total = top.reduce((s, c) => s + c.score, 0);
  let roll = env.rng() * total;
  for (const c of top) {
    roll -= c.score;
    if (roll <= 0) return c;
  }
  return top[0];
}

/** Aim point for a fist in the torso frame: the zone's surface facing us, pushed through. */
function fistAim(env: SkillEnv, run: SkillRun, side: Side, follow = FOLLOW_M): Vec3 {
  const t = env.toTorso(run.aim ?? env.opp.chest);
  const dir = normalize(sub(t, env.geo.arms[side].shoulder), [1, 0, 0]);
  const k = follow - env.opp.frontDepth * 0.6;
  return [t[0] + dir[0] * k, t[1] + dir[1] * k, t[2] + dir[2] * k];
}

/**
 * Balance engine: the punch's anchor point (torso frame), the first contact plus STRIKE_P3.followM,
 * so the clip's peak-speed frame lands on whatever the fist meets first (his guard or the target);
 * the clip then drives on through it. Followed through the windup, locked in the world once the
 * strike phase starts (punches are ballistic, as the runner's aim).
 */
function punchAim(env: SkillEnv, run: SkillRun, c: { contact: Vec3 | null; fStart: Vec3; f0: Vec3; fImp: Vec3 }, side: Side, phase: SkillPhase): Vec3 {
  if (c.contact) return env.toTorso(c.contact);
  const surf = fistAim(env, run, side, 0);
  const hit = firstContact(env, side, surf, c.fStart);
  let aim: Vec3;
  if (hit) {
    const u = normalize(sub(hit, c.fStart), [1, 0, 0]);
    aim = [hit[0] + u[0] * STRIKE_P3.followM, hit[1] + u[1] * STRIKE_P3.followM, hit[2] + u[2] * STRIKE_P3.followM];
  } else aim = fistAim(env, run, side);
  if (phase !== 'windup') {
    // Locked: a shorter path than the clip's plays faster (its joints travel less).
    const clipChord = Math.hypot(c.fImp[0] - c.f0[0], c.fImp[1] - c.f0[1], c.fImp[2] - c.f0[2]);
    const chord = Math.hypot(aim[0] - c.fStart[0], aim[1] - c.fStart[1], aim[2] - c.fStart[2]);
    if (env.player && clipChord > 1e-3) env.player.limitScale = clamp(Math.sqrt(clipChord / Math.max(1e-3, chord)), 1, STRIKE_P3.shortChordMax);
    const R = env.s.torsoRot, o = env.s.torsoPos;
    c.contact = [
      o[0] + R[0] * aim[0] + R[1] * aim[1] + R[2] * aim[2],
      o[1] + R[3] * aim[0] + R[4] * aim[1] + R[5] * aim[2],
      o[2] + R[6] * aim[0] + R[7] * aim[1] + R[8] * aim[2],
    ];
  }
  return aim;
}

/**
 * The striking fist before the impact frame: the clip's progress along its own chord (start →
 * impact point), mapped onto the robot's chord (guard → aim), plus a share of the clip's bend
 * off its chord. Starts in the guard, arrives on the aim.
 */
function anchoredFist(cf: Vec3, c: { f0: Vec3; fStart: Vec3; fImp: Vec3 }, aim: Vec3): Vec3 {
  const d = sub(c.fImp, c.f0);
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const rel = sub(cf, c.f0);
  const prog = dd > 1e-6 ? (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / dd : 1;
  const k = PUNCH_TUNING.arc;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = c.fStart[i] + prog * (aim[i] - c.fStart[i]) + k * (rel[i] - prog * d[i]);
  return out;
}

/** 0 before the warp window, easing to 1 at the impact frame, held through the strike. */
function warpWeight(tau: number, impact: number, phase: SkillPhase, u: number): number {
  const from = impact * (1 - PUNCH_TUNING.warpShare);
  if (phase === 'recover') return 1 - minJerk(u / 0.5);
  if (tau >= impact) return 1;
  return tau <= from ? 0 : minJerk((tau - from) / Math.max(1e-3, impact - from));
}

interface ClipPose {
  move: Move;
  mirror: boolean;
  side: Side;
  yaw0: number;
  pitch0: number;
  roll0: number;
  x0: number;
  y0: number;
  z0: number;
  impact: number;
  strikeAt: number; // clip time the strike phase starts
  tau0: number; // clip time playback started from
  psi0: number; // clip chest yaw (pelvis + waist) at the start
  wp0: number; // clip waist pitch at the start
  t: number; // wall time since the run began
  guard: Record<Side, ArmAngles>; // the stance guard in joint space (blend target)
}

/**
 * The clip's trunk as posture offsets on the stance (weight `w`):
 *   hips    a share of the clip's pelvis turn (planted feet cannot follow an actor pivoting on
 *           the ball of the foot all the way), its tilt and dip
 *   torso   by the time the strike starts, the chest faces where the clip's does (the actor's
 *           stance was bladed differently): the waist turns whatever the hips do not
 *   weight  the clip's transfer, kept inside the stance's support
 */
function trunk(env: SkillEnv, c: ClipPose, w: number, t: TrunkShares): void {
  const p = env.player!;
  const s = p.s;
  const jm = env.jm;
  const [yaw, pitch, roll] = ypr(s.rootQuat);
  const blade = env.stance.pelvisYaw;
  const hips = clamp(wrap(yaw - c.yaw0) * t.turn, -t.maxTurn, t.maxTurn);
  const ease = minJerk(clamp((p.tau - c.tau0) / Math.max(0.05, c.strikeAt - c.tau0), 0, 1));
  const chest = wrap(yaw + p.q[jm.waistYaw]) + wrap(blade + env.stance.waistYaw - c.psi0) * (1 - ease);
  const waistYaw = wrap(chest - blade - hips);
  env.pose.pelvisYaw = hips * w;
  env.pose.waistYaw = env.stance.waistYaw + wrap(waistYaw - env.stance.waistYaw) * t.waist * w;
  env.pose.waistPitch = env.stance.waistPitch + clamp(p.q[jm.waistPitch] - c.wp0, -WAIST_PITCH_BACK, WAIST_PITCH_FWD) * t.bend * w;
  env.pose.pelvisPitch = (pitch - c.pitch0) * t.tilt * w;
  env.pose.pelvisRoll = (roll - c.roll0) * t.tilt * w;
  env.pose.pelvisDrop = clamp(c.z0 - s.rootPos[2], -0.03, MAX_DIP_M) * w;
  const dx = s.rootPos[0] - c.x0, dy = s.rootPos[1] - c.y0;
  env.pose.weightShift = [clamp(dx * t.shift, -SHIFT_FWD_M, SHIFT_FWD_M) * w, clamp(dy * t.shift, -SHIFT_SIDE_M, SHIFT_SIDE_M) * w];
}

interface TrunkShares {
  turn: number; // share of the clip's pelvis turn the hips take
  maxTurn: number; // rad
  tilt: number; // share of its pelvis pitch and roll
  shift: number; // share of its weight transfer
  waist: number; // share of its chest turn
  bend: number; // share of its waist bend
}

/**
 * Trunk shares for punches (exported so tools can sweep them; the worker never changes them).
 * No chest turn of its own: a heavy torso whipped round on the waist at the actors' speed twists
 * the planted feet (sole yaw friction is small) and throws the capture point out. Over 135 punches
 * thrown at the air, the full clip trunk took 75 capture steps and 3 falls; with the chest turning
 * only with the hips and half the waist bend, 33 and none (procedural punches: about 6 and none).
 */
export const PUNCH_TRUNK: TrunkShares = { turn: 0.45, maxTurn: 0.45, tilt: 0.6, shift: 1, waist: 0, bend: 0.5 };
const KICK_TRUNK: TrunkShares = { turn: 0.6, maxTurn: 0.9, tilt: 0.7, shift: 0, waist: 1, bend: 1 };
const WAIST_PITCH_FWD = 0.35;
const WAIST_PITCH_BACK = 0.3;
const MAX_DIP_M = 0.08;

function startPose(env: SkillEnv, move: Move, mirror: boolean, side: Side): ClipPose {
  const p = env.player!;
  const s = p.s;
  const [yaw0, pitch0, roll0] = ypr(s.rootQuat);
  const guard = {} as Record<Side, ArmAngles>;
  for (const sd of ['l', 'r'] as const) {
    const g = newArmAngles();
    armIK(env.geo.arms[sd], env.stance.guard[sd].fist, env.stance.guard[sd].pole, g);
    guard[sd] = g;
  }
  return {
    move, mirror, side, yaw0, pitch0, roll0,
    x0: s.rootPos[0], y0: s.rootPos[1], z0: s.rootPos[2],
    impact: move.impact ?? move.reach ?? move.phases.recover,
    strikeAt: move.phases.strike,
    tau0: p.tau,
    psi0: wrap(yaw0 + p.q[env.jm.waistYaw]),
    wp0: p.q[env.jm.waistPitch],
    t: 0, guard,
  };
}

/**
 * The playback rate limits of a move on this robot from its centroid table (null without one): per
 * frame the slower of the limbs' and the trunk's motor rates (the trunk at the share of the clip's
 * trunk motion the tracker plays), scaled by what damage, heat and the battery leave of the chain's
 * torque (the needed torque goes with the rate squared).
 */
function motorRates(env: SkillEnv, move: Move, trunkShare: number, chain: readonly string[]): Float32Array | undefined {
  const t = centroidSet(env.mocap!.lib.design)?.tracks.get(move.id);
  if (!t || t.n !== move.frames) return undefined;
  let left = 1;
  for (const name of chain) {
    const j = env.joint(name);
    if (j) left = Math.min(left, clamp(j.availableTorque / j.motor.stallTorqueNm, 0.05, 1));
  }
  const k = Math.sqrt(left);
  const share = Math.max(0.25, trunkShare);
  const out = new Float32Array(t.n);
  for (let f = 0; f < t.n; f++) out[f] = k * Math.min(t.rLimb[f], t.rTrunk[f] / share);
  return out;
}

/**
 * Where the striking fist's centre will first touch him (torso frame) on its way from `from` (where
 * it starts) to `aim` (the zone's surface): one of his fists if it sits in that path (the guard),
 * else the surface itself. Null when the guard is closer than STRIKE_P3.minTravelM to the fist (the
 * blow meets it right away whatever the timing).
 */
function firstContact(env: SkillEnv, side: Side, aim: Vec3, from: Vec3): Vec3 | null {
  const d = sub(aim, from);
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return null;
  const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const R = env.opp.fistHalf + env.geo.arms[side].fistHalf;
  let along = len;
  for (const sd of ['l', 'r'] as const) {
    const rel = sub(env.toTorso(env.opp.fists[sd]), from);
    const a = dot(rel, u);
    if (a <= 0 || a >= along + R) continue;
    const off = Math.hypot(rel[0] - a * u[0], rel[1] - a * u[1], rel[2] - a * u[2]);
    if (off > R + STRIKE_P3.guardSlackM) continue;
    // The two fists' centres come within R of each other this far along the path.
    along = Math.min(along, Math.max(0, a - Math.sqrt(Math.max(0, R * R - off * off))));
  }
  return along < STRIKE_P3.minTravelM ? null : [from[0] + u[0] * along, from[1] + u[1] * along, from[2] + u[2] * along];
}

const PUNCH_CHAIN = (s: Side) => [`shoulder_pitch_${s}`, `shoulder_roll_${s}`, `shoulder_yaw_${s}`, `elbow_${s}`];

// ---------------------------------------------------------------- punches

interface PunchScratch extends ClipPose {
  end: number; // clip time the punch is over (back in the guard)
  f0: Vec3; // clip fist where playback starts, torso frame
  fStart: Vec3; // the robot's guard fist the punch starts from, torso frame
  fImp: Vec3; // clip fist at the impact frame, torso frame
  cmd: Vec3; // the striking fist's commanded position last update, torso frame
  held: number; // s the clip has waited at the impact frame for the fist to arrive
  /** Balance engine: the first contact, locked (world) once the strike phase starts. */
  p3: boolean;
  contact: Vec3 | null;
}

const armA = newArmAngles();
const armB = newArmAngles();
const armC = newArmAngles();

/** A punch (label) thrown with `side` from a planted stance. */
export function punchClip(label: MoveLabel, side: Side): ClipSkill {
  return {
    begin(env, run) {
      const p = env.player;
      if (!p || !env.mocap) return false;
      const p3 = !!env.engine;
      const speed = p3 ? STRIKE_P3.punchRate * (0.85 + 0.15 * env.aggression) : PUNCH_SPEED * (0.7 + 0.3 * env.aggression);
      const pick = pickMove(env, label, side, speed, MAX_PUNCH_TRAVEL_M);
      if (!pick) return false;
      const played = playedSide(pick.move, pick.mirror)!;
      const from = Math.max(0, pick.move.phases.strike - PUNCH_LEAD_IN_S);
      const rates = p3 ? motorRates(env, pick.move, Math.max(PUNCH_TRUNK.waist, PUNCH_TRUNK.bend), PUNCH_CHAIN(played)) : undefined;
      p.play(pick.move, { mirror: pick.mirror, speed, mask: 'upper', from, rates });
      const base = startPose(env, pick.move, pick.mirror, played);
      // The clip fist at the impact frame (torso frame), for the aim warp.
      p.seek(base.impact);
      const fImp = armFK(env.geo.arms[played], readArm(env, p.q, played, armA)).fist;
      p.seek(from);
      const f0 = armFK(env.geo.arms[played], readArm(env, p.q, played, armA)).fist;
      const end = Math.min(pick.move.duration, Math.max(pick.move.phases.recover, base.impact) + PUNCH_RECOVER_S);
      const fStart = [...env.stance.guard[played].fist] as Vec3;
      run.scratch.clip = { ...base, end, f0, fStart, fImp, cmd: [...fStart] as Vec3, held: 0, p3, contact: null } satisfies PunchScratch;
      run.strikers = [`fist_${played}`, `forearm_${played}`];
      return true;
    },
    step(env, run, dt): ClipStep {
      const p = env.player!;
      const c = run.scratch.clip as PunchScratch;
      c.t += dt;
      // The clip waits at the impact frame for a fist its servos have not delivered yet (a heavy
      // arm lags a target moving at the motors' top speed): the blow lands, then the recovery.
      let pace = 1;
      const T = PUNCH_TUNING;
      if (!run.landed && p.tau < c.impact - 1e-3 && p.tau >= c.impact * (1 - T.warpShare) && T.lagStopM > T.lagSlowM) {
        const f = env.toTorso(env.s.fists[c.side]);
        const lag = Math.hypot(f[0] - c.cmd[0], f[1] - c.cmd[1], f[2] - c.cmd[2]);
        pace = clamp((T.lagStopM - lag) / (T.lagStopM - T.lagSlowM), T.minPace, 1);
      }
      if (!run.landed && p.tau >= c.impact - 1e-3 && p.tau <= c.impact + 0.05 && c.held < (c.p3 ? STRIKE_P3.arriveHoldS : ARRIVE_HOLD_S)) {
        const f = env.toTorso(env.s.fists[c.side]);
        if (Math.hypot(f[0] - c.cmd[0], f[1] - c.cmd[1], f[2] - c.cmd[2]) > ARRIVE_M) {
          pace = 0;
          c.held += dt;
        }
      }
      p.step(dt, pace);
      const s = p.s;
      const w = Math.min(minJerk(c.t / BLEND_IN_S), clamp((c.end - p.tau) / BLEND_OUT_CLIP_S, 0, 1));
      // Arms: the clip, with the striking fist's path bent onto the target near impact.
      for (const sd of ['l', 'r'] as const) {
        const clipArm = readArm(env, p.q, sd, armB);
        let angles = clipArm;
        if (sd === c.side) {
          const anchored = p.tau < c.impact;
          const k = anchored ? 1 : warpWeight(p.tau, c.impact, s.phase, s.phaseU);
          if (k > 0) {
            const fk = armFK(env.geo.arms[sd], clipArm);
            const aim = c.p3 ? punchAim(env, run, c, sd, s.phase) : fistAim(env, run, sd);
            const target: Vec3 = anchored
              ? anchoredFist(fk.fist, c, aim)
              : [fk.fist[0] + k * (aim[0] - c.fImp[0]), fk.fist[1] + k * (aim[1] - c.fImp[1]), fk.fist[2] + k * (aim[2] - c.fImp[2])];
            const sh = env.geo.arms[sd].shoulder;
            const pole = sub(fk.elbow, [(sh[0] + fk.fist[0]) / 2, (sh[1] + fk.fist[1]) / 2, (sh[2] + fk.fist[2]) / 2]);
            armIK(env.geo.arms[sd], target, pole, armC);
            angles = armC;
            c.cmd = armFK(env.geo.arms[sd], armC).fist;
          } else c.cmd = armFK(env.geo.arms[sd], clipArm).fist;
        }
        const arm = env.cmd.arms[sd];
        arm.mode = 'joints';
        lerpArm(c.guard[sd], angles, w, arm.angles);
      }
      // Trunk and neck: the clip's, as offsets on the stance.
      env.cmd.neckYaw += (p.q[env.jm.neckYaw] - env.cmd.neckYaw) * w;
      trunk(env, c, w, PUNCH_TRUNK);
      return { phase: s.phase, u: s.phaseU, progress: clamp(p.tau / c.end, 0, 1), done: p.done || p.tau >= c.end };
    },
  };
}

// ---------------------------------------------------------------- kicks

interface KickScratch extends ClipPose {
  stage: 'shift' | 'kick' | 'rewind' | 'land';
  cmd: Vec3; // the kicking ankle's commanded position last update, pelvis frame
  held: number; // s waited at the impact frame for the leg
  liftAt: number;
  aImp: Vec3; // clip ankle at the impact frame, pelvis frame
  waited: number;
  place: { x: number; y: number; yaw: number }; // where the kicking foot stood
  rewindFrom: number;
  /** Balance engine: the gait's aborted shifts when the kick began (the lift gate calling it off ends it). */
  p3: boolean;
  aborted0: number;
}

const legA = newLegAngles();
const legB = newLegAngles();

/** Clip time the kicking foot leaves the canvas (its contact bit drops), as played. */
function liftOf(move: Move, mirror: boolean, side: Side): number {
  const bit = (mirror ? other(side) : side) === 'l' ? 1 : 2; // stored side of the played leg
  for (let f = 1; f < move.frames; f++) if (!(move.contacts[f] & bit)) return f / move.fps;
  return move.phases.strike;
}

/** A kick with `side` (the clip's own rear-leg kicks, mirrored for the other leg). */
export function kickClip(label: MoveLabel, side: Side): ClipSkill {
  return {
    begin(env, run) {
      const p = env.player;
      if (!p || !env.mocap) return false;
      const p3 = !!env.engine;
      const speed = p3 ? STRIKE_P3.kickRate * (0.85 + 0.15 * env.aggression) : KICK_SPEED * (0.7 + 0.3 * env.aggression);
      const pick = pickMove(env, label, side, speed, Infinity);
      if (!pick) return false;
      const played = playedSide(pick.move, pick.mirror)!;
      // Balance engine: the robot's own motor rates (the kicking leg, the arms, the trunk at the clip's
      // full turn); the lift waits for the gyro to have the kick's angular momentum in hand.
      const rates = p3 ? motorRates(env, pick.move, Math.max(KICK_TRUNK.waist, KICK_TRUNK.bend), KICK_CHAIN(played)) : undefined;
      p.play(pick.move, { mirror: pick.mirror, speed, mask: 'legs', ...(rates ? { rates } : { limitScale: KICK_LIMIT_SCALE }) });
      const base = startPose(env, pick.move, pick.mirror, played);
      if (rates && env.engine) {
        const t = centroidSet(env.mocap.lib.design)?.tracks.get(pick.move.id);
        const lift = liftOf(pick.move, pick.mirror, played);
        let r = speed;
        for (let f = Math.floor(lift * pick.move.fps); f <= Math.min(rates.length - 1, Math.ceil(base.impact * pick.move.fps)); f++) r = Math.min(r, rates[f]);
        env.engine.kickNeedNms = (t?.Lpk ?? 0) * r;
      }
      p.seek(base.impact);
      const aImp = legFK(env.geo.legs[played], readLeg(env, p.q, played, legA)).ankle;
      p.seek(0);
      const f = env.gait.feet[played].place;
      run.scratch.clip = {
        ...base, stage: 'shift', liftAt: liftOf(pick.move, pick.mirror, played), aImp, waited: 0, cmd: [...aImp] as Vec3, held: 0,
        place: { x: f.x, y: f.y, yaw: f.yaw }, rewindFrom: 0, p3, aborted0: env.gait.abortedShifts,
      } satisfies KickScratch;
      run.strikers = [`foot_${played}`, `shin_${played}`];
      return true;
    },
    step(env, run, dt): ClipStep {
      const p = env.player!;
      const c = run.scratch.clip as KickScratch;
      const m = c.move;
      const gait = env.gait;
      c.t += dt;
      env.pose.holdFeet = true;
      const granted = gait.skillLegActive() === c.side;
      if (c.stage === 'shift') {
        // The weight goes onto the stance foot first; the clip waits at its first frame. (Balance
        // engine: a shift its lift gate called off is the end of this kick.)
        if (c.p3 && gait.abortedShifts !== c.aborted0) return { phase: 'windup', u: 0, progress: 0, done: true };
        if (!gait.requestSkillLeg(c.side, LEG_SHIFT_WAIT_S)) {
          c.waited += dt;
          upperBody(env, c, Math.min(1, c.t / 0.3) * 0.5);
          return { phase: 'windup', u: clamp(c.waited / LEG_SHIFT_WAIT_S, 0, 0.5), progress: 0, done: c.waited > LEG_SHIFT_WAIT_S + 0.2 };
        }
        c.stage = 'kick';
        p.seek(c.liftAt);
      }
      if (c.stage === 'kick') {
        // As with a punch, the clip waits at the impact frame for a leg that has not arrived.
        let pace = 1;
        if (!run.landed && p.tau >= c.impact - 1e-3 && p.tau <= c.impact + 0.05 && c.held < KICK_ARRIVE_HOLD_S) {
          const a = env.s.feet[c.side].ankle;
          const local = mulMtV(env.s.pelvisRot, sub(a, env.s.pelvisPos));
          if (Math.hypot(local[0] - c.cmd[0], local[1] - c.cmd[1], local[2] - c.cmd[2]) > KICK_ARRIVE_M) {
            pace = 0;
            c.held += dt;
          }
        }
        p.step(dt, pace);
        if (p.tau >= c.impact + KICK_FOLLOW_S || (run.landed && p.tau >= c.impact) || p.done) {
          c.stage = 'rewind';
          c.rewindFrom = p.tau;
        }
      } else if (c.stage === 'rewind') {
        const rate = Math.min(REWIND_SPEED, p.limitAt(p.tau));
        p.seek(Math.max(c.liftAt, p.tau - dt * rate));
        if (p.tau <= c.liftAt + 1e-3 && granted) {
          gait.returnSkillLeg(c.place, RETURN_SWING, env.s);
          c.stage = 'land';
        }
      }
      const s = p.s;
      if (c.stage === 'land' || !granted) {
        // Swinging down (or the leg was reclaimed for a catch step): the gait owns the leg.
        upperBody(env, c, 0.5);
        const done = gait.phase === 'double' || gait.phase === 'shift';
        return { phase: 'recover', u: 1, progress: 1, done };
      }
      // The kicking leg follows the clip in joint space, its ankle bent onto the target near impact.
      const clipLeg = readLeg(env, p.q, c.side, legA);
      const k = c.stage === 'rewind' ? 1 - minJerk((c.rewindFrom - p.tau) / Math.max(1e-3, c.rewindFrom - c.liftAt)) : warpWeight(p.tau, c.impact, 'strike', 0);
      const leg = env.cmd.legs[c.side];
      if (k > 0.001) {
        const fk = legFK(env.geo.legs[c.side], clipLeg);
        const aim = kickAim(env, run, c.side);
        const w: Vec3 = [aim[0] - c.aImp[0], aim[1] - c.aImp[1], aim[2] - c.aImp[2]];
        if (c.p3) {
          // Capped so the leg's share of the COM stays over the stance sole (warping the chain moves a
          // quarter of the body's mass with it).
          const legShare = env.s.legs[c.side].mass / Math.max(1, env.s.mass);
          const cap = (STRIKE_P3.kickWarpShare * Math.max(0.02, env.geo.legs[other(c.side)].footHalfLength - 0.015)) / Math.max(0.05, legShare);
          const n = Math.hypot(w[0], w[1]);
          if (n > cap) {
            w[0] *= cap / n;
            w[1] *= cap / n;
          }
        }
        const target: Vec3 = [fk.ankle[0] + k * w[0], fk.ankle[1] + k * w[1], fk.ankle[2] + k * w[2]];
        const hip = env.geo.legs[c.side].hip;
        const pole = sub(fk.knee, [(hip[0] + fk.ankle[0]) / 2, (hip[1] + fk.ankle[1]) / 2, (hip[2] + fk.ankle[2]) / 2]);
        legIKPoint(env.geo.legs[c.side], target, pole, legB);
        legB.anklePitch = clipLeg.anklePitch;
        legB.ankleRoll = clipLeg.ankleRoll;
        leg.mode = 'joints';
        Object.assign(leg.angles, legB);
        c.cmd = legFK(env.geo.legs[c.side], legB).ankle;
      } else {
        leg.mode = 'joints';
        Object.assign(leg.angles, clipLeg);
        c.cmd = legFK(env.geo.legs[c.side], clipLeg).ankle;
      }
      upperBody(env, c, 1);
      const phase: SkillPhase = c.stage === 'rewind' ? 'recover' : s.phase;
      const u = c.stage === 'rewind' ? clamp((c.rewindFrom - p.tau) / Math.max(1e-3, c.rewindFrom - c.liftAt), 0, 1) : s.phaseU;
      return { phase, u, progress: clamp(p.tau / m.duration, 0, 1), done: false };
    },
  };
}

/** Arms, waist, neck and pelvis offsets from the clip (weight `w`), for a kick. */
function upperBody(env: SkillEnv, c: ClipPose, w: number): void {
  const p = env.player!;
  const jm = env.jm;
  for (const sd of ['l', 'r'] as const) {
    const arm = env.cmd.arms[sd];
    if (w <= 0) continue;
    arm.mode = 'joints';
    lerpArm(c.guard[sd], readArm(env, p.q, sd, armB), w, arm.angles);
  }
  env.cmd.neckYaw += (p.q[jm.neckYaw] - env.cmd.neckYaw) * w;
  trunk(env, c, w, KICK_TRUNK);
}

/** Where the kicking ankle should arrive, in the measured pelvis frame: the zone, pushed through. */
function kickAim(env: SkillEnv, run: SkillRun, side: Side): Vec3 {
  const s = env.s;
  const aim = run.aim ?? env.opp.chest;
  const local = mulMtV(s.pelvisRot, sub(aim, s.pelvisPos));
  const hip = env.geo.legs[side].hip;
  const dir = normalize(sub(local, hip), [1, 0, 0]);
  const k = FOLLOW_M - env.opp.frontDepth * 0.5;
  return [local[0] + dir[0] * k, local[1] + dir[1] * k, local[2] + dir[2] * k];
}

