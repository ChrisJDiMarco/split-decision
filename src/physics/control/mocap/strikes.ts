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
import { GRAVITY } from '../sense';
import { KICK_GATE, LUNGE } from '../balance/index';
import { arcTable, elbowPole, FistPath, JointPath, STRIKE_PATH, type ArcTable } from '../strike-path';
import type { MotionPlayer } from './player';
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
 * Strikes on the balance engine (docs/design/strike-power.md §2, balance-engine.md §5). A punch is
 * driven (strike-path.ts): the clip's windup loads the body, then the striking fist runs a path locked
 * through the first surface in its way at the fastest its joints' real motors allow, the hips and chest
 * turning into it ahead of the arm (proximal to distal) and the weight going forward; the clip is
 * time-warped onto that drive (its impact frame lands on the contact) and styles the rest of the body.
 * Kicks play as fast as the robot's own motors allow at every frame (the centroid tables' inverse
 * dynamics on each joint's torque-speed line). The legacy path plays both as before. Exported so tools
 * can sweep it; the worker never changes it.
 */
export const STRIKE_P3 = {
  punchRate: 2.5, // the clip's windup plays this fast at aggression 1 (× the human source) when the motors allow
  // The striking fist draws back this much in the windup (a real telegraph). A fist launched from its guard meets
  // his guard 8-15 cm later, inside the distance it needs to come up to speed: 0.07 against 0.03 raised the
  // straights' peak in sparring 5.4 → 6.0 m/s (32 fights) and the strike drill's 0.3-1.2 m/s per design.
  cockM: 0.07,
  // ...× this on a jab: the lead hand's quick shot barely draws back. A light jab's line drawn back 5-7 cm met his
  // guard glancing, under the damage model's 4 N·s event floor (FIRECRACKER's jab in the strike drill: 13 of 16
  // booked impacts at 0.03, 4 at 0.05, 3 at 0.07).
  jabCock: 0.45,
  loadShare: 0.15, // the hips and chest turn this share of the strike's turn away first (loading)
  turnShare: 1, // × the shapes' hip and chest turns
  // The trunk's turn into the blow accelerates steadily to the contact (its speed peaks as it lands),
  // no harder than the planted feet can hold: the waist's reaction goes through the stance hips into the
  // soles, whose friction holds at most μ·m·g·D/2 of yaw (D the feet's spread). This share of that.
  groundYawShare: 0.7,
  footMu: 0.9,
  // The kinetic chain's lead: the hips and chest start turning into the blow this long before the fist flies
  // (the fist waits, cocked), so the trunk has the time to come up to speed within the feet's grip by the
  // contact (½·α·t² of turn, α·t of speed) instead of only the fist's flight (0: the trunk and fist together).
  // Off: in the strike drill 0.05-0.1 s doubled the torso's yaw rate at the contact (FIRECRACKER's cross 4.9 →
  // 9.2 rad/s) but moved the fist's peak by under 0.3 m/s, and in sparring it cost pace and falls (the
  // FIRECRACKER pairings, 32 fights without the gyro-damage coupling: 31 self-falls with 0.05, 25 without;
  // landed 40.2 against 44.6 per minute).
  trunkLeadS: 0,
  jabLead: 0.5, // × trunkLeadS on a jab (it barely turns)
  overrunMax: 1.25, // after the contact the turn runs on at its speed to at most this × its amplitude
  shiftM: 0.07, // the weight goes this far toward him on a power punch...
  jabShift: 0.45, // ...this share of it on a jab
  hookShift: 0, // ...and on a lead hook, none: it pivots over the lead foot (the strikes test's walk-in falls did not track this share: 0, 0.45 and 1 each fell 1-3 in 5 before the fixes below)
  // Through the contact the drive runs on while the fist still moves freely (at least pressKeep of its
  // speed at the touch: a glancing touch on his guard), and stops once he has stopped it (pressOn 1: on to
  // its end regardless, STRIKE_PATH.throughM past the contact). Shoving on to the end into a heavy target
  // came back as a 0.5 m/s recoil and falls (SAVATE's stepped-in hooks at the strikes test's 2 m target),
  // and so did pressing 8 cm on; stopping dead at the first touch let a glancing touch of his guard end the
  // blow (FIRECRACKER's jab landed 1/8 in the strike drill against 6/8 pressing on).
  pressOn: 0,
  pressKeep: 0.6,
  // A capture step and a driven punch: 2, the punch rides it out (a fist in flight finishes the blow; a
  // cocked one thrown on the walk's own step waits one catch step out and flies once the stance has
  // settled); 1, only a fist in flight; 0, the step cancels the punch. (Strikes test walk-ins, FIRECRACKER
  // at the much taller target: jab and cross landed 3/5 each with 1, 5/5 and 4/5 with 2, no falls either
  // way. Every cocked blow riding a catch step out, the sparring fell 8 times in 371 punches against 4 in
  // 389 with 1: hence only the walk-in's.)
  flyThroughCapture: 2,
  // Hooks and uppercuts step in too (0: only the straight punches). Stepped into from a long stance, with
  // the drive shoving on through the contact, a hook's turn and his push-back made 2-5 catch steps and
  // falls in the strikes test's walk-in; with the stance capped (LUNGE.maxStanceShare) and the drive
  // stopping at the contact (pressOn 0) none in 30 walk-in punches, and the stepped-in hooks land.
  lungeHooks: 1,
  followS: 0.04, // after the contact the fist stays on him this long (then the recovery)
  whiffHoldS: 0.04, // a blow that met nothing holds its end this long
  recoverS: 0.2, // back to the guard (at aggression 0.5; shorter when aggressive)
  // The windup's wall time per punch at aggression 0.5 (× 1.3 − 0.6 × aggression): the telegraph the
  // opponent's reflexes read (a jab barely shows; an overhand loads).
  windupS: { jab: 0.06, cross: 0.09, hook: 0.1, uppercut: 0.1, overhand: 0.15 },
  maxFlightS: 0.5, // a drive still going after this long is over
  lungeMinM: 0.03, // a blow whose target is this far past its reach from the stance steps in...
  lungeMarginM: 0.04, // ...this much further than it falls short
  lungeContactShare: 0.12, // the fist should meet him this share of the arm's length short of its full reach
  lungeFlightS: 0.12, // the fist flies about this long: launched this long before the stepping foot plants
  lungeWaitS: 0.45, // a stepping-in blow launches after this long whatever the foot is doing
  lungeLateS: 0.1, // ...and lands this long after the foot (the body is still coming forward onto it; 0.04 met him short of the arm's end less often, contact 0.3-2 m/s slower)
  // A blow that needs the step but finds no settled stance (the feet mid-step, the body still moving)
  // holds its launch, cocked, this long for one; then it throws at what it can reach (routeAim). (0.3 cost
  // a chained combination its pace, the cross 1.06 s after the jab; 0.1 left FIRECRACKER's walk-in jabs
  // short of the much taller target.)
  stepWaitS: 0.2, // (and a windup never waits longer than its own time + lungeWaitS + this)
  launchHoldS: 0.2, // a blow whose thrower is not fit to throw at the launch (canStrike) waits cocked at most this long past its windup
  kickRate: 2.2, // as punchRate, for kicks
  kickShiftUpper: 0.5, // the clip's first upper-body frame is blended in this far while the weight goes onto the stance foot
  // The aim warp moves the kicking leg (a quarter of the body) off its clip path, and the COM with it:
  // the warp is capped so that shift stays within this share of the stance sole's half-length.
  kickWarpShare: 0.5,
};

/**
 * The trunk turn of each punch at contact (rad), for its canonical striking side: the hips (pelvis yaw
 * on the stance) and the chest (waist yaw) together; from the procedural shapes (skills/arm-strikes.ts).
 */
const PUNCH_TURN: Partial<Record<MoveLabel, { side: Side; pelvis: number; waist: number }>> = {
  jab: { side: 'l', pelvis: -0.1, waist: -0.3 },
  cross: { side: 'r', pelvis: 0.22, waist: 0.55 },
  hook: { side: 'l', pelvis: -0.2, waist: -0.55 },
  uppercut: { side: 'r', pelvis: 0.15, waist: 0.45 },
  overhand: { side: 'r', pelvis: 0.25, waist: 0.6 },
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
function motorRates(env: SkillEnv, move: Move, trunkShare: number, chain: readonly string[], sole?: { halfLength: number; halfWidth: number }): Float32Array | undefined {
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
  // r_bal (balance-engine.md §5.1): the centre of pressure the move implies beyond its COM goes with
  // the square of the playback rate (com + r²·Δp₁); on one foot it must stay inside that sole, so the
  // move plays no faster than r_bal = √(margin / |Δp₁|) per axis (a kick thrown off balance comes
  // slower instead of tipping the kicker).
  if (sole && KICK_RBAL.enabled) {
    const hl = Math.max(0.01, sole.halfLength - KICK_RBAL.marginM), hw = Math.max(0.01, sole.halfWidth - KICK_RBAL.marginM);
    for (let f = 0; f < t.n; f++) {
      const dx = Math.abs(t.dp[2 * f]), dy = Math.abs(t.dp[2 * f + 1]);
      const r = Math.min(dx > 1e-4 ? Math.sqrt(hl / dx) : Infinity, dy > 1e-4 ? Math.sqrt(hw / dy) : Infinity);
      out[f] = Math.min(out[f], Math.max(KICK_RBAL.minRate, r));
    }
  }
  return out;
}

/** The kick's balance rate cap (r_bal, motorRates), exported so tools can sweep it. */
export const KICK_RBAL = {
  enabled: 1,
  marginM: 0.015, // the implied COP stays this far inside the stance sole
  minRate: 0.3, // never slower than this × the source
};

const PUNCH_CHAIN = (s: Side) => [`shoulder_pitch_${s}`, `shoulder_roll_${s}`, `shoulder_yaw_${s}`, `elbow_${s}`];

// ---------------------------------------------------------------- punches

interface PunchScratch extends ClipPose {
  end: number; // clip time the punch is over (back in the guard)
  f0: Vec3; // clip fist where playback starts, torso frame
  fStart: Vec3; // the robot's guard fist the punch starts from, torso frame
  fImp: Vec3; // clip fist at the impact frame, torso frame
  cmd: Vec3; // the striking fist's commanded position last update, torso frame
  held: number; // s the clip has waited at the impact frame for the fist to arrive
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
      if (env.engine && env.dyn) return drivenBegin(env, run, label, side);
      const speed = PUNCH_SPEED * (0.7 + 0.3 * env.aggression);
      const pick = pickMove(env, label, side, speed, MAX_PUNCH_TRAVEL_M);
      if (!pick) return false;
      const played = playedSide(pick.move, pick.mirror)!;
      const from = Math.max(0, pick.move.phases.strike - PUNCH_LEAD_IN_S);
      p.play(pick.move, { mirror: pick.mirror, speed, mask: 'upper', from });
      const base = startPose(env, pick.move, pick.mirror, played);
      // The clip fist at the impact frame (torso frame), for the aim warp.
      p.seek(base.impact);
      const fImp = armFK(env.geo.arms[played], readArm(env, p.q, played, armA)).fist;
      p.seek(from);
      const f0 = armFK(env.geo.arms[played], readArm(env, p.q, played, armA)).fist;
      const end = Math.min(pick.move.duration, Math.max(pick.move.phases.recover, base.impact) + PUNCH_RECOVER_S);
      const fStart = [...env.stance.guard[played].fist] as Vec3;
      run.scratch.clip = { ...base, end, f0, fStart, fImp, cmd: [...fStart] as Vec3, held: 0 } satisfies PunchScratch;
      run.strikers = [`fist_${played}`, `forearm_${played}`];
      return true;
    },
    step(env, run, dt): ClipStep {
      if ((run.scratch.clip as DrivenPunch).driven) return drivenStep(env, run, dt);
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
      if (!run.landed && p.tau >= c.impact - 1e-3 && p.tau <= c.impact + 0.05 && c.held < ARRIVE_HOLD_S) {
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
            const aim = fistAim(env, run, sd);
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

// ---------------------------------------------------------------- driven punches (balance engine)

interface DrivenPunch extends ClipPose {
  driven: true;
  stage: 'windup' | 'strike' | 'recover';
  label: MoveLabel;
  end: number; // clip time the move is over
  drive: FistPath;
  arc: ArcTable | null;
  poleTo: Vec3; // the clip's elbow pole at the impact frame (torso frame)
  turnPelvis: number; // the hips' and the chest's turn at contact (rad, this side)
  turnWaist: number;
  turnK: number; // share of that turn the feet can hold by the contact (set as the strike starts)
  shift: number; // forward weight shift at contact (m)
  lunge: boolean; // the blow steps in (the target is past the arm's reach from the stance)
  walkStep: boolean; // ...on the walk's own step, already in the air (the tactics' step-in strike)
  lungeT: number; // c.t the step-in was granted
  wantStep: boolean; // the target is past the arm's reach but the feet could not step yet...
  wantSince: number; // ...since this c.t
  sLanded: number; // drive progress at the first contact (−1 before)
  vLanded: number; // measured fist speed then (m/s)
  pressed: boolean; // the contact has stopped the fist: the drive holds where it is
  prevFist: Vec3; // last tick's fist (world), for its speed
  /** Wall time the strike phase began, it landed, the recovery began. */
  tStrike: number;
  tLanded: number;
  tRecover: number;
  heldEnd: number; // s the drive has held its end (a whiff)
  /** Trunk turn, shift and the striking arm where the recovery starts from. */
  recPelvis: number;
  recWaist: number;
  recShift: number;
  recArm: ArmAngles;
  recoverS: number;
  windupS: number; // the windup's wall time
  leadS: number; // the trunk turns this long before the fist flies (the kinetic chain, STRIKE_P3.trunkLeadS)
  tcTrunk: number; // seconds from the trunk's start to the planned contact (the lead plus the fist's flight)
}

function drivenBegin(env: SkillEnv, run: SkillRun, label: MoveLabel, side: Side): boolean {
  const p = env.player!;
  const speed = STRIKE_P3.punchRate * (0.85 + 0.15 * env.aggression);
  const pick = pickMove(env, label, side, speed, MAX_PUNCH_TRAVEL_M);
  if (!pick) return false;
  const played = playedSide(pick.move, pick.mirror)!;
  const from = Math.max(0, pick.move.phases.strike - PUNCH_LEAD_IN_S);
  // The clip's own rates on the robot's motors (the windup's trunk and arms; the strike is driven).
  const rates = motorRates(env, pick.move, Math.max(PUNCH_TRUNK.waist, PUNCH_TRUNK.bend), PUNCH_CHAIN(played));
  p.play(pick.move, { mirror: pick.mirror, speed, mask: 'upper', from, rates });
  const base = startPose(env, pick.move, pick.mirror, played);
  const fistAt = (tau: number): Vec3 => {
    p.seek(tau);
    return armFK(env.geo.arms[played], readArm(env, p.q, played, armA)).fist;
  };
  const arc = arcTable(fistAt, base.strikeAt, base.impact);
  p.seek(base.impact);
  // The elbow at the impact: a share of the actor's (his elbow comes up and out on a cross; on these
  // arms that is the shoulder roll's work, the slowest joint of the path), the rest the guard's (down).
  const clipPole = elbowPole(env, played, readArm(env, p.q, played, armA));
  const gp = env.stance.guard[played].pole;
  const k = STRIKE_PATH.poleShare;
  const poleTo = normalize([gp[0] + (clipPole[0] - gp[0]) * k, gp[1] + (clipPole[1] - gp[1]) * k, gp[2] + (clipPole[2] - gp[2]) * k], [0, 0, -1]);
  p.seek(from);
  const end = Math.min(pick.move.duration, Math.max(pick.move.phases.recover, base.impact) + PUNCH_RECOVER_S);
  const turn = PUNCH_TURN[label];
  const sign = turn && turn.side !== played ? -1 : 1;
  const T = STRIKE_P3;
  run.scratch.clip = {
    ...base, driven: true, stage: 'windup', label, end, drive: new FistPath(), arc, poleTo,
    turnPelvis: (turn?.pelvis ?? 0) * sign * T.turnShare, turnWaist: (turn?.waist ?? 0) * sign * T.turnShare, turnK: 1,
    shift: T.shiftM * (label === 'jab' ? T.jabShift : label === 'hook' ? T.hookShift : 1), lunge: false, walkStep: false, lungeT: 0, wantStep: false, wantSince: 0,
    sLanded: -1, vLanded: 0, pressed: false, prevFist: [...env.s.fists[played]] as Vec3, tStrike: -1, tLanded: -1, tRecover: -1, heldEnd: 0, recPelvis: 0, recWaist: 0, recShift: 0, recArm: newArmAngles(),
    recoverS: T.recoverS * (1.3 - 0.6 * env.aggression),
    windupS: (T.windupS[label as keyof typeof T.windupS] ?? 0.1) * (1.3 - 0.6 * env.aggression),
    leadS: 0, tcTrunk: 0.1,
  } satisfies DrivenPunch;
  run.strikers = [`fist_${played}`, `forearm_${played}`];
  const c = run.scratch.clip as DrivenPunch;
  tryStepIn(env, run, c);
  return true;
}

/** Ask for the step-in now (stepIn); remembers whether one is still wanted, and since when. */
function tryStepIn(env: SkillEnv, run: SkillRun, c: DrivenPunch): void {
  const r = stepIn(env, run, c, Math.max(0, c.windupS - c.t));
  if (r === 'blocked') {
    if (!c.wantStep) c.wantSince = c.t;
    c.wantStep = true;
    return;
  }
  c.wantStep = false;
  if (r === 'stepping' || r === 'walking') {
    c.lunge = true;
    c.walkStep = r === 'walking';
    c.lungeT = c.t;
    // Thrown on the walk's own step (the tactics' step-in strike): a catch step as that step lands is
    // part of the entry, and the cocked blow rides it out (controller.ts, flyThroughCapture 2).
    if (c.walkStep) run.scratch.rideCapture = true;
  }
}

/**
 * From a set stance with the target past the arm's reach (the elbow at STRIKE_PATH.elbowEndRad, plus
 * what the trunk's turn and the weight shift add), the blow steps in (strike-power.md §2.6): the lead
 * foot lands as the fist does, the rear sole pushing (BalanceEngine.requestLunge). `windupS`: the
 * windup's expected wall time.
 */
function stepIn(env: SkillEnv, run: SkillRun, c: DrivenPunch, windupS: number): 'none' | 'stepping' | 'walking' | 'blocked' {
  const e = env.engine;
  if (!e) return 'none';
  if (!STRIKE_P3.lungeHooks && (c.label === 'hook' || c.label === 'uppercut')) return 'none';
  const side = c.side;
  const arm = env.geo.arms[side];
  const surf = fistAim(env, run, side, 0);
  const sh = arm.shoulder;
  const dist = Math.hypot(surf[0] - sh[0], surf[1] - sh[1], surf[2] - sh[2]);
  const dExt = Math.sqrt(arm.upper * arm.upper + arm.fore * arm.fore + 2 * arm.upper * arm.fore * Math.cos(STRIKE_PATH.elbowEndRad));
  const turn = Math.abs(c.turnPelvis + c.turnWaist);
  // The fist should meet him still accelerating, short of the arm's end (lungeContactShare of the arm
  // before full reach); the trunk's turn brings the shoulder about half its nominal reach (the feet's
  // grip limits it, chainTurn); a body already moving toward him brings it on over the fist's flight.
  const dx = env.opp.com[0] - env.s.com[0], dy = env.opp.com[1] - env.s.com[1];
  const closing = Math.max(0, (env.s.comVel[0] * dx + env.s.comVel[1] * dy) / (Math.hypot(dx, dy) || 1));
  const need = dist - (dExt - STRIKE_P3.lungeContactShare * (arm.upper + arm.fore)) - 0.5 * Math.abs(sh[1]) * Math.sin(turn) - closing * STRIKE_P3.lungeFlightS;
  if (need < STRIKE_P3.lungeMinM) return 'none';
  // A step already in the air (the tactics throw on the walk's step whose touchdown brings him in
  // range, tactics.ts stepInReady) carries the blow: no second step.
  if (e.state.touchIn >= 0) return 'walking';
  const land = env.s.time + Math.max(windupS + STRIKE_P3.lungeFlightS, LUNGE.unloadS + LUNGE.minSwingS);
  // The body (and the shoulder with it) comes about half a step forward by the contact: the step is twice the shortfall.
  return e.requestLunge(env.stance.lead, 2 * need + STRIKE_P3.lungeMarginM, env.heading, land, env.s.time) ? 'stepping' : 'blocked';
}

/** A stepping-in blow launches once its foot's touchdown is about one fist flight away (or it waited too long). */
function lungeLaunch(env: SkillEnv, c: DrivenPunch): boolean {
  const st = env.engine?.state;
  if (!st || c.t - c.lungeT >= STRIKE_P3.lungeWaitS) return true;
  return st.touchIn >= 0 && st.touchIn <= STRIKE_P3.lungeFlightS - STRIKE_P3.lungeLateS;
}

/**
 * The windup's step-in: a requested step launches the fist by its touchdown (lungeLaunch); the walk's
 * own step is waited out and the reach looked at again from where it lands (a second, requested step if
 * he is still out of reach); a step wanted but not possible yet (no set stance) is asked for again
 * for up to stepWaitS. True: launch now (as far as the feet go).
 */
function stepReady(env: SkillEnv, run: SkillRun, c: DrivenPunch): boolean {
  const T = STRIKE_P3;
  if (c.t >= c.windupS + T.lungeWaitS + T.stepWaitS) return true;
  const st = env.engine?.state;
  if (c.lunge && c.walkStep && (!st || st.touchIn < 0)) {
    c.lunge = c.walkStep = false;
    tryStepIn(env, run, c);
  } else if (c.wantStep && !c.lunge) {
    if (c.t - c.wantSince < T.stepWaitS) tryStepIn(env, run, c);
    else c.wantStep = false;
  }
  if (c.lunge) return c.walkStep ? false : lungeLaunch(env, c);
  return !c.wantStep;
}

const trunkScratch = { pelvisYaw: 0, waistYaw: 0 };

function drivenStep(env: SkillEnv, run: SkillRun, dt: number): ClipStep {
  const p = env.player!;
  const c = run.scratch.clip as DrivenPunch;
  const T = STRIKE_P3;
  const d = c.drive;
  c.t += dt;
  const side = c.side;
  const guard = env.stance.guard[side];
  let phase: SkillPhase = 'windup', u = 0, progress = 0;
  // The striking fist's measured speed (world).
  const fw = env.s.fists[side];
  const vFist = dt > 0 ? Math.hypot(fw[0] - c.prevFist[0], fw[1] - c.prevFist[1], fw[2] - c.prevFist[2]) / dt : 0;
  c.prevFist[0] = fw[0];
  c.prevFist[1] = fw[1];
  c.prevFist[2] = fw[2];
  let pelvis = 0, waist = 0, shift = 0;
  const arm = env.cmd.arms[side];
  if (c.stage === 'windup') {
    // The clip's windup over the blow's own windup time (its motion is small: the hips and chest load,
    // the fist draws back a little): a quick, honest telegraph, not the actor's whole set-up.
    u = clamp(c.t / c.windupS, 0, 1);
    p.seek(c.tau0 + (c.strikeAt - c.tau0) * u);
    const k = minJerk(u);
    // The fist draws back a little along its line to him, from the guard; the hips and chest load.
    const aim = fistAim(env, run, side, 0);
    const g = guard.fist;
    const dir = normalize(sub(aim, g as Vec3), [1, 0, 0]);
    arm.mode = 'fist';
    const cock = T.cockM * (c.label === 'jab' ? T.jabCock : 1);
    arm.fist = [g[0] - dir[0] * cock * k, g[1] - dir[1] * cock * k, g[2] - dir[2] * cock * k];
    arm.pole = [...guard.pole] as Vec3;
    pelvis = -T.loadShare * c.turnPelvis * k;
    waist = -T.loadShare * c.turnWaist * k;
    shift = c.shift * 0.35 * k;
    progress = 0.3 * u;
    // A blow that steps in waits, cocked, for its foot: the fist flies so it lands as the foot plants
    // (the body has come forward by then), or after lungeWaitS whatever (stepReady).
    // A cocked blow that rode out a catch step (controller.ts, flyThroughCapture 2) flies only from a
    // settled stance (the engine's canStrike); still unsettled when the windup's time is up, it is dropped.
    const caught = (run.scratch.capSeen as number | undefined) ?? 0;
    // Any blow waits, cocked, for a body fit to throw at the launch (the engine's canStrike: not knocked off its
    // plan in the windup, no reaction under way, the gyro with momentum in hand), for at most launchHoldS
    // past its windup, then flies regardless (the fight-clean pass: launched at once from a body a blow had
    // just knocked about, punches threw their throwers).
    const fit = !!env.engine?.state.canStrike;
    if (caught && !fit && c.t >= c.windupS + T.lungeWaitS + T.stepWaitS) return { phase: 'windup', u, progress, done: true };
    const settled = caught ? fit : fit || c.t >= c.windupS + T.launchHoldS;
    if (settled && stepReady(env, run, c) && p.tau >= c.strikeAt - 1e-3) drivenStrike(env, run, c, arm.fist, arm.pole);
  }
  if (c.stage === 'strike') {
    phase = 'strike';
    // Through the contact the drive runs on only while the fist is not stopped (T.pressOn 0): the blow is
    // the fist's momentum, not the servos shoving on into a body that does not give.
    if (run.landed && c.sLanded < 0) {
      c.sLanded = d.s;
      c.vLanded = vFist;
    }
    if (run.landed && !T.pressOn && vFist < T.pressKeep * c.vLanded) c.pressed = true;
    // The trunk leads: for leadS the hips and chest turn into the blow while the fist waits, cocked (in the
    // torso frame: it turns with the chest), then the drive takes it (proximal to distal, strike-power §2.5).
    const tTrunk = c.t - c.tStrike;
    if (!c.pressed && tTrunk >= c.leadS) d.step(env, dt);
    const reach = Math.max(1e-3, Math.min(1, d.sContact));
    u = clamp(d.s / reach, 0, 1);
    // The clip's impact frame lands on the contact: its time follows the drive.
    p.seek(c.strikeAt + (c.impact - c.strikeAt) * u);
    arm.mode = 'joints';
    Object.assign(arm.angles, d.angles);
    chainTurn(c, tTrunk, c.tcTrunk, T, trunkScratch);
    pelvis = trunkScratch.pelvisYaw;
    waist = trunkScratch.waistYaw;
    shift = c.shift * (0.35 + 0.65 * minJerk(tTrunk / Math.max(0.05, c.tcTrunk)));
    // A capture step under way (the fist flies on, controller.ts): the weight stays where the step puts it.
    if (env.engine?.state.mode === 'recover') shift = 0;
    progress = 0.3 + 0.4 * u;
    if (run.landed && c.tLanded < 0) c.tLanded = c.t;
    if (d.done && !run.landed) c.heldEnd += dt;
    const over = (c.tLanded >= 0 && c.t - c.tLanded >= T.followS) || c.heldEnd >= T.whiffHoldS || d.t >= T.maxFlightS;
    if (over) {
      c.stage = 'recover';
      c.tRecover = c.t;
      c.recPelvis = pelvis;
      c.recWaist = waist;
      c.recShift = shift;
      Object.assign(c.recArm, d.angles);
    }
  }
  if (c.stage === 'recover') {
    phase = 'recover';
    u = clamp((c.t - c.tRecover) / c.recoverS, 0, 1);
    const k = minJerk(u);
    p.seek(c.impact + (c.end - c.impact) * u);
    arm.mode = 'joints';
    lerpArm(c.recArm, c.guard[side], k, arm.angles);
    pelvis = c.recPelvis * (1 - k);
    waist = c.recWaist * (1 - k);
    shift = c.recShift * (1 - k);
    progress = 0.7 + 0.3 * u;
  }
  // The other arm, the neck and the trunk's pitch, roll and dip: the clip's, as offsets on the stance.
  const w = Math.min(minJerk(c.t / BLEND_IN_S), c.stage === 'recover' ? 1 - minJerk(u) : 1);
  const other = side === 'l' ? 'r' : 'l';
  const oa = env.cmd.arms[other];
  oa.mode = 'joints';
  lerpArm(c.guard[other], readArm(env, p.q, other, armB), w, oa.angles);
  env.cmd.neckYaw += (p.q[env.jm.neckYaw] - env.cmd.neckYaw) * w;
  trunk(env, c, w, PUNCH_TRUNK);
  env.pose.pelvisYaw = pelvis;
  env.pose.waistYaw = env.stance.waistYaw + waist;
  env.pose.weightShift = [shift, 0];
  return { phase, u, progress, done: c.stage === 'recover' && u >= 1 };
}

/** The strike phase starts: the drive locks its aim through the first surface in the fist's way. */
function drivenStrike(env: SkillEnv, run: SkillRun, c: DrivenPunch, fist: Vec3, pole: Vec3): void {
  const side = c.side;
  const hit = routeAim(env, run, side, fist, punchReach(env, c));
  const R = env.s.torsoRot, o = env.s.torsoPos;
  const world: Vec3 = [
    o[0] + R[0] * hit[0] + R[1] * hit[1] + R[2] * hit[2],
    o[1] + R[3] * hit[0] + R[4] * hit[1] + R[5] * hit[2],
    o[2] + R[6] * hit[0] + R[7] * hit[1] + R[8] * hit[2],
  ];
  c.drive.begin(env, side, fist, world, pole, c.poleTo, c.arc, [env.opp.vel[0], env.opp.vel[1], 0]);
  c.stage = 'strike';
  c.tStrike = c.t;
  // How much of the turn the feet can hold by the contact: steady acceleration α = τ_ground / I_upper
  // (I_upper the joint-space inertia the waist yaw swings) covers ½·α·t² by then.
  const T = STRIKE_P3;
  const f = env.gait.feet;
  const spread = Math.hypot(f.l.place.x - f.r.place.x, f.l.place.y - f.r.place.y);
  const tauGround = T.groundYawShare * T.footMu * env.s.mass * GRAVITY * spread / 2;
  const I = Math.max(0.05, env.dyn?.inertia(env.jm.waistYaw) ?? 1);
  c.leadS = T.trunkLeadS * (c.label === 'jab' ? T.jabLead : 1);
  c.tcTrunk = c.leadS + Math.max(0.05, c.drive.tContact);
  const tc = c.tcTrunk;
  const reach = 0.5 * (tauGround / I) * tc * tc;
  const total = Math.abs(c.turnPelvis + c.turnWaist) * (1 + T.loadShare);
  c.turnK = total > 1e-3 ? Math.min(1, reach / total) : 1;
}

/**
 * Openings (strike-power.md §2.3: "aim at the first surface actually in the fist's path, guard
 * included, or route around it"): the zone's own surface point, or one a little off it (higher on the
 * head, beside it, lower on the body) whose straight line from the fist clears his guard, his fists and
 * forearms. Lines whose first contact the fist can reach (`reach`: from the shoulder, torso frame, by the
 * contact) come first; among them the clearest nearest the zone's centre wins, and with every line
 * blocked, the one whose first contact lies furthest away (the fist has the most room to get up to
 * speed). A head out of reach (a much taller man, or too far for the step) sends the blow to the body.
 * Returns that first contact (torso frame).
 */
function routeAim(env: SkillEnv, run: SkillRun, side: Side, from: Vec3, reach: number): Vec3 {
  const o = env.opp;
  const head = run.zone === 'head';
  const zone = run.aim ?? o.chest;
  const first = pickLine(env, side, from, zone, head ? ROUTE.head : ROUTE.body, reach);
  const point: Vec3 = [first.point[0], first.point[1], first.point[2]];
  if (first.reachable || !head) return point;
  const body = pickLine(env, side, from, o.chest, ROUTE.body, reach);
  return body.reachable ? [body.point[0], body.point[1], body.point[2]] : point;
}

const lineOut = { point: [0, 0, 0] as Vec3, reachable: false };

function pickLine(env: SkillEnv, side: Side, from: Vec3, zone: Vec3, offsets: Array<[number, number]>, reach: number): typeof lineOut {
  const o = env.opp;
  const sh = env.geo.arms[side].shoulder;
  const lat = normalize([-(zone[1] - env.s.torsoPos[1]), zone[0] - env.s.torsoPos[0], 0], [0, 1, 0]);
  const R = o.fistHalf + env.geo.arms[side].fistHalf + ROUTE.slackM;
  const guard: Array<[Vec3, Vec3]> = (['l', 'r'] as const).map((sd) => [env.toTorso(o.fists[sd]), env.toTorso(o.elbows[sd])]);
  let best: Vec3 | null = null, bestScore = -Infinity, bestReach = false;
  for (const [up, side2] of offsets) {
    const z: Vec3 = [zone[0] + lat[0] * side2, zone[1] + lat[1] * side2, zone[2] + up];
    const t = env.toTorso(z);
    const dir = normalize(sub(t, sh), [1, 0, 0]);
    const k = -o.frontDepth * 0.6;
    const surf: Vec3 = [t[0] + dir[0] * k, t[1] + dir[1] * k, t[2] + dir[2] * k];
    const d = sub(surf, from);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) continue;
    const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
    // The first point on the line within R of his guard (each forearm a segment, elbow to fist).
    let along = len;
    segOut.c = null;
    let obstacle: Vec3 | null = null;
    for (const [fst, elb] of guard) {
      const a = segmentHit(from, u, len, elb, fst, R);
      if (a < along) {
        along = a;
        obstacle = segOut.c;
      }
    }
    const clean = along >= len - 1e-6;
    let hit: Vec3 = clean ? surf : [from[0] + u[0] * along, from[1] + u[1] * along, from[2] + u[2] * along];
    // A blocked line meets his guard at the edge of the fist's sphere: a glancing touch that passes on little
    // of the fist's speed. ROUTE.square: a blow that must go into his guard goes into it square, the line
    // through the part of his forearm or glove it meets (a hard shot to the guard drives it back).
    if (!clean && obstacle && ROUTE.square) {
      const q = sub(obstacle, from);
      const lq = Math.hypot(q[0], q[1], q[2]);
      if (lq > R + 1e-3) hit = [from[0] + (q[0] * (lq - R)) / lq, from[1] + (q[1] * (lq - R)) / lq, from[2] + (q[2] * (lq - R)) / lq];
    }
    const reachable = Math.hypot(hit[0] - sh[0], hit[1] - sh[1], hit[2] - sh[2]) <= reach + ROUTE.reachSlackM;
    // Reachable lines first; then clean lines, nearest the centre; then the most room before the guard.
    const score = (reachable ? 100 : 0) + (clean ? 10 - Math.hypot(up, side2) : along);
    if (score > bestScore) {
      bestScore = score;
      best = hit;
      bestReach = reachable;
    }
  }
  if (best) copy3(lineOut.point, best);
  else copy3(lineOut.point, fistAimAt(env, zone, side));
  lineOut.reachable = best ? bestReach : false;
  return lineOut;
}

/** The zone's surface point toward this shoulder (fistAim for a given zone point, torso frame). */
function fistAimAt(env: SkillEnv, zone: Vec3, side: Side): Vec3 {
  const t = env.toTorso(zone);
  const dir = normalize(sub(t, env.geo.arms[side].shoulder), [1, 0, 0]);
  const k = -env.opp.frontDepth * 0.6;
  return [t[0] + dir[0] * k, t[1] + dir[1] * k, t[2] + dir[2] * k];
}

function copy3(out: Vec3, a: Vec3): void {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
}

/**
 * How far from the shoulder (torso frame, at the launch) the fist gets by the contact: the arm to the
 * drive's end bend, what the trunk's turn brings the shoulder (about half its nominal, the feet's grip;
 * chainTurn), the weight shift, half a granted step-in's stride (the body is halfway onto the new
 * stance by the contact) or the body's speed toward him over the flight, and the fist's own half-size.
 */
function punchReach(env: SkillEnv, c: DrivenPunch): number {
  const arm = env.geo.arms[c.side];
  const dExt = Math.sqrt(arm.upper * arm.upper + arm.fore * arm.fore + 2 * arm.upper * arm.fore * Math.cos(STRIKE_PATH.elbowEndRad));
  const turn = Math.abs(c.turnPelvis + c.turnWaist);
  // A requested step-in: half its stride. Otherwise (the walk's step, or none) the body's own speed
  // toward him over a fist's flight.
  let step = 0;
  if (c.lunge && !c.walkStep) step = 0.5 * (env.engine?.lastLungeM ?? 0);
  else {
    const dx = env.opp.com[0] - env.s.com[0], dy = env.opp.com[1] - env.s.com[1];
    const d = Math.hypot(dx, dy) || 1;
    step = Math.max(0, (env.s.comVel[0] * dx + env.s.comVel[1] * dy) / d) * STRIKE_P3.lungeFlightS;
  }
  return dExt + 0.5 * Math.abs(arm.shoulder[1]) * Math.sin(turn) + 0.65 * c.shift + step + arm.fistHalf;
}

/** Candidate offsets (up, sideways; m) around the zone's point: the head, the body. */
export const ROUTE = {
  head: [[0, 0], [0.06, 0], [0.04, 0.06], [0.04, -0.06], [0, 0.07], [0, -0.07]] as Array<[number, number]>,
  body: [[0, 0], [0, 0.08], [0, -0.08], [-0.1, 0], [-0.08, 0.07], [-0.08, -0.07]] as Array<[number, number]>,
  slackM: 0.01,
  // A line counts as reachable this far past the estimated reach (punchReach is a rough sum: the turn,
  // the shift and a step-in all add a little more or less): only a target well out of reach (a head far
  // above, as FIRECRACKER's at the 2 m iron-age targets) sends the blow elsewhere.
  reachSlackM: 0.1,
  // 1: a blow every line of which meets his guard goes into the guard square (pickLine). Aimed at the edge of
  // his guard the fist met it glancing: in the strike drill the fist came in at 4.2-6.7 m/s and the contact's
  // closing speed was 1.8-3.6 m/s; square, the straights' contact rose to 4.6-5.9 m/s (p50 per design). Off:
  // in sparring the square shot's recoil came back on the thrower (own-strike falls after 13-24 N·s hits on
  // his glove), and on the FIRECRACKER pairings it cost 9 self-falls in 32 fights for no contact speed (4.8
  // against 5.2 m/s without).
  square: 0,
};

/** segmentHit's sample point that gave the first hit (torso frame), or null. */
const segOut: { c: Vec3 | null } = { c: null };

/**
 * Distance along the ray from `p` (unit `u`, up to `len`) to the first point within `R` of segment a-b; `len` if none.
 * The segment's point it met is left in segOut.c (unchanged when there is none).
 */
function segmentHit(p: Vec3, u: Vec3, len: number, a: Vec3, b: Vec3, R: number): number {
  // Sample the segment (a few points are enough at these sizes) and take the earliest sphere hit.
  let first = len;
  for (let i = 0; i <= 4; i++) {
    const w = i / 4;
    const c: Vec3 = [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
    const rel = sub(c, p);
    const t = dot(rel, u);
    if (t <= 0 || t >= first + R) continue;
    const off2 = rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2] - t * t;
    if (off2 > R * R) continue;
    const at = Math.max(0, t - Math.sqrt(Math.max(0, R * R - off2)));
    if (at < first) {
      first = at;
      segOut.c = c;
    }
  }
  return first;
}

/**
 * The kinetic chain (strike-power.md §2.5): from the load, the hips and chest turn into the blow at a
 * steady acceleration that brings them to their turn (the share the feet can hold, turnK) as the fist
 * lands, so the trunk is turning fastest at the contact and the arm (the drive) adds its own speed on
 * top; after the contact the turn runs on at that speed a little (overrunMax) while the follow-through
 * lasts. The waist's reaction is held by the stance hips (hipYawKp) and the soles' friction.
 */
function chainTurn(c: DrivenPunch, t: number, tc: number, T: typeof STRIKE_P3, out: typeof trunkScratch): void {
  const x = t / Math.max(0.05, tc);
  const u = x <= 1 ? x * x : Math.min(T.overrunMax, 1 + 2 * (x - 1));
  const p0 = -T.loadShare * c.turnPelvis, w0 = -T.loadShare * c.turnWaist;
  const pt = c.turnPelvis * c.turnK, wt = c.turnWaist * c.turnK;
  out.pelvisYaw = p0 + (pt - p0) * u;
  out.waistYaw = w0 + (wt - w0) * u;
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
  /** Balance engine: the leg is driven from the chamber into the target (strike-path.ts) once the clip reaches driveAt. */
  drive: JointPath | null;
  driveAt: number;
  tLanded: number;
  heldEnd: number;
  rewindT: number; // wall time the driven rewind has run
  shiftDrop: number; // pelvis drop the weight shift took (a long stance), eased out after the lift
  liftT: number; // c.t the leg was lent
  recLeg: LegAngles; // the leg where the driven rewind starts from
  liftLeg: LegAngles; // the clip's leg at lift-off (where the rewind goes back to)
  landedAt?: number; // wall time (c.t) the kick landed
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
      // Balance engine: the rear leg kicks, whichever that is now (a walk can end with the feet swapped,
      // and kicking off the front foot first shifts the whole stance's length onto the rear one: longer
      // than the lift gate waits).
      const pick = pickMove(env, label, p3 ? rearLeg(env, side) : side, speed, Infinity);
      if (!pick) return false;
      const played = playedSide(pick.move, pick.mirror)!;
      // Balance engine: the robot's own motor rates (the kicking leg, the arms, the trunk at the clip's
      // full turn); the lift waits for the gyro to have the kick's angular momentum in hand.
      const stanceLeg = env.geo.legs[other(played)];
      const rates = p3 ? motorRates(env, pick.move, Math.max(KICK_TRUNK.waist, KICK_TRUNK.bend), KICK_CHAIN(played), { halfLength: stanceLeg.footHalfLength, halfWidth: stanceLeg.footHalfWidth }) : undefined;
      p.play(pick.move, { mirror: pick.mirror, speed, mask: 'legs', ...(rates ? { rates } : { limitScale: KICK_LIMIT_SCALE }) });
      const base = startPose(env, pick.move, pick.mirror, played);
      if (rates && env.engine) {
        const t = centroidSet(env.mocap.lib.design)?.tracks.get(pick.move.id);
        const lift = liftOf(pick.move, pick.mirror, played);
        let r = speed;
        for (let f = Math.floor(lift * pick.move.fps); f <= Math.min(rates.length - 1, Math.ceil(base.impact * pick.move.fps)); f++) r = Math.min(r, rates[f]);
        // The gyro covers what the stance sole cannot: the sole takes up to m·g·(its half-width) of
        // angular momentum rate over the leg's flight (the weak, sideways direction); the table's peak
        // is the actor's whole body, of which the robot (feet planted, the trunk a share) carries part.
        const flight = Math.max(0.05, (base.impact - lift) / Math.max(0.2, r));
        const sole = Math.max(0, env.geo.legs[other(played)].footHalfWidth - KICK_GATE.soleMarginM);
        const soles = env.s.mass * GRAVITY * sole * flight;
        env.engine.kickNeedNms = Math.max(0, KICK_GATE.momentumShare * (t?.Lpk ?? 0) * r - soles);
      }
      p.seek(base.impact);
      const aImp = legFK(env.geo.legs[played], readLeg(env, p.q, played, legA)).ankle;
      const driveAt = p3 ? kickDriveAt(env, p, played, liftOf(pick.move, pick.mirror, played), base.impact) : 0;
      p.seek(0);
      const f = env.gait.feet[played].place;
      run.scratch.clip = {
        ...base, stage: 'shift', liftAt: liftOf(pick.move, pick.mirror, played), aImp, waited: 0, cmd: [...aImp] as Vec3, held: 0,
        place: { x: f.x, y: f.y, yaw: f.yaw }, rewindFrom: 0, p3, aborted0: env.gait.abortedShifts,
        drive: null, driveAt, tLanded: -1, heldEnd: 0, rewindT: 0,
        recLeg: newLegAngles(), liftLeg: newLegAngles(), shiftDrop: 0, liftT: 0,
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
          upperBody(env, c, Math.min(1, c.t / 0.3) * (c.p3 ? STRIKE_P3.kickShiftUpper : 0.5));
          // Balance engine: from a long stance the pelvis comes down until the kicking leg can still reach
          // its sole with the pelvis over the stance foot (else the shift stalls on a straight rear knee).
          if (c.p3 && KICK_SET.enabled) {
            c.shiftDrop += (shiftDrop(env, c.side) - c.shiftDrop) * Math.min(1, dt / KICK_SET.dropTauS);
            env.pose.pelvisDrop = Math.max(env.pose.pelvisDrop, c.shiftDrop);
          }
          return { phase: 'windup', u: clamp(c.waited / LEG_SHIFT_WAIT_S, 0, 0.5), progress: 0, done: c.waited > LEG_SHIFT_WAIT_S + 0.2 };
        }
        c.stage = 'kick';
        c.liftT = c.t;
        p.seek(c.liftAt);
      }
      if (c.p3 && KICK_DRIVE.enabled && (c.stage === 'kick' || c.stage === 'rewind') && granted) return drivenKick(env, run, c, dt);
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
        // (Balance engine: a kick that has landed stops driving into him and comes back at once. Driven
        // on to the clip's impact frame into a braced target, it pushed the kicker off his one foot:
        // front kicks fell 3 in 8 on FIRECRACKER and SAVATE.)
        if (c.landedAt === undefined && run.landed) c.landedAt = c.t;
        const stop = run.landed && (p.tau >= c.impact || (c.p3 && c.t - (c.landedAt ?? c.t) >= KICK_FOLLOW_S));
        if (p.tau >= c.impact + KICK_FOLLOW_S || stop || p.done) {
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
      if (c.shiftDrop > 0) env.pose.pelvisDrop = Math.max(env.pose.pelvisDrop, c.shiftDrop * Math.exp(-(c.t - c.liftT) / KICK_SET.dropTauS));
      const phase: SkillPhase = c.stage === 'rewind' ? 'recover' : s.phase;
      const u = c.stage === 'rewind' ? clamp((c.rewindFrom - p.tau) / Math.max(1e-3, c.rewindFrom - c.liftAt), 0, 1) : s.phaseU;
      return { phase, u, progress: clamp(p.tau / m.duration, 0, 1), done: false };
    },
  };
}

/**
 * A kick's weight shift from a long stance (a walk often ends in one): the pelvis comes down so the
 * kicking leg, at most maxExt of its length, still reaches its sole with the pelvis over the stance foot.
 * OFF: in the strikes test's walk-ins the shift stalls (the lift gate wants the DCM within 2 cm of the
 * stance sole's centre and times out). SAVATE's rear knee was straight (0.998 of the leg) with the DCM
 * 13 cm short of the stance foot; with the drop the DCM got to 3-4 cm but then stalled along the
 * heading instead (the COM reference is leashed to the body, its 2 cm lead does not move it), and no
 * walk-in kick landed either way. Kept for the kick pass (balance-engine.md §5.3).
 */
export const KICK_SET = {
  enabled: 0,
  maxExt: 0.96,
  maxDropL: 0.12, // × leg length
  dropTauS: 0.08,
};

function shiftDrop(env: SkillEnv, side: Side): number {
  const st = other(side);
  const f = env.gait.feet;
  const leg = env.geo.legs[side];
  const L = leg.thigh + leg.shin;
  const sp = f[st].place, kp = f[side].place;
  const ch = Math.cos(env.heading), sh = Math.sin(env.heading);
  // The kicking hip with the pelvis centre over the stance sole.
  const hx = sp.x + ch * leg.hip[0] - sh * leg.hip[1], hy = sp.y + sh * leg.hip[0] + ch * leg.hip[1];
  const dh = Math.hypot(kp.x - hx, kp.y - hy);
  const reach = KICK_SET.maxExt * L;
  const maxDrop = KICK_SET.maxDropL * L;
  if (dh >= reach) return maxDrop;
  const zNom = env.stance.pelvisHeight + leg.hip[2] - leg.soleDepth;
  return clamp(zNom - Math.sqrt(reach * reach - dh * dh), 0, maxDrop);
}

/** The foot further from him along the heading (`fallback` with the feet level). */
function rearLeg(env: SkillEnv, fallback: Side): Side {
  const f = env.gait.feet;
  const ux = Math.cos(env.heading), uy = Math.sin(env.heading);
  const ahead = (f.l.place.x - f.r.place.x) * ux + (f.l.place.y - f.r.place.y) * uy;
  return Math.abs(ahead) < 0.03 ? fallback : ahead > 0 ? 'r' : 'l';
}

/**
 * Clip time the driven kick takes over: the chamber, the clip's most folded knee between lift-off and
 * the impact (the chamber itself is the clip's own motion), inside [lift + minChamberS, impact − minDriveS].
 */
function kickDriveAt(env: SkillEnv, p: MotionPlayer, side: Side, lift: number, impact: number): number {
  const knee = env.jm.leg[side].knee;
  let best = lift, fold = -Infinity;
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const tau = lift + ((impact - lift) * i) / n;
    p.seek(tau);
    if (p.q[knee] > fold) {
      fold = p.q[knee];
      best = tau;
    }
  }
  const lo = lift + KICK_DRIVE.minChamberS;
  return clamp(best, lo, Math.max(lo, impact - KICK_DRIVE.minDriveS));
}

/**
 * Driven kicks (balance engine), exported so tools can sweep them. OFF: in the kick drill (8 of each
 * kick per modern design at a standing opponent) the driven leg peaked at 4.5-7.7 m/s against the
 * clip-played kick's 2.6-5.0, but landed no more often and fell 0.6-3.8 times per 10 kicks against
 * 0-1.9: a heavy leg (a quarter of the body) swung that fast carries the capture point off the stance
 * sole, and the early catch step (or, held off, a fall) follows. Kept for the next pass (kick landing
 * forward with the leg's momentum, balance-engine §5.3 step 4).
 */
export const KICK_DRIVE = {
  enabled: 0,
  minChamberS: 0.05, // clip seconds of chamber after lift-off at least
  minDriveS: 0.06, // ...and of drive before the impact frame
  legSurfaceM: 0.08, // a leg target's surface sits this far in front of its centre line
  followS: 0.04,
  whiffHoldS: 0.04,
  rewindS: 0.22, // back to the chamber pose (at aggression 0.5)
  maxFlightS: 0.6,
  leanShare: 0, // counter-lean against the kicking leg's mass (counterLean; 1 made driven kicks worse: 0-3 of 8 landed)
  maxLean: 0.6, // sin of the steepest lean
};

const legC = newLegAngles();

/**
 * A kick on the balance engine, from lift-off: the clip chambers the leg (at the motors' own rate), then
 * at driveAt the ankle is driven along a path locked through his surface (strike-path.ts, the leg's
 * hip yaw, roll, pitch and knee on their torque-speed lines), bent by the clip's own arc, the clip
 * time-warped onto the drive (its impact frame lands on the contact); after the contact (or a whiff) the
 * leg comes back to its lift-off pose in joint space and the gait sets it down.
 */
function drivenKick(env: SkillEnv, run: SkillRun, c: KickScratch, dt: number): ClipStep {
  const p = env.player!;
  const gait = env.gait;
  const leg = env.cmd.legs[c.side];
  const K = KICK_DRIVE;
  let phase: SkillPhase = 'windup', u = 0;
  if (c.stage === 'kick' && !c.drive) {
    // From lift-off: the leg where it stands, through the clip's chamber, to his surface and past it;
    // the knee at the end pointing as the clip's does at its impact.
    const lg = env.geo.legs[c.side];
    const hip = lg.hip;
    p.seek(c.liftAt);
    readLeg(env, p.q, c.side, c.liftLeg);
    const start = newLegAngles();
    Object.assign(start, c.liftLeg);
    p.seek(c.driveAt);
    const chamber = newLegAngles();
    readLeg(env, p.q, c.side, chamber);
    p.seek(c.impact);
    const fk1 = legFK(lg, readLeg(env, p.q, c.side, legB));
    const pole1 = normalize(sub(fk1.knee, [(hip[0] + fk1.ankle[0]) / 2, (hip[1] + fk1.ankle[1]) / 2, (hip[2] + fk1.ankle[2]) / 2]), [1, 0, 0]);
    p.seek(c.liftAt);
    const d = new JointPath();
    d.begin(env, c.side, start, chamber, kickSurface(env, run, c.side), pole1, [env.opp.vel[0], env.opp.vel[1], 0]);
    c.drive = d;
  }
  const d = c.drive;
  if (c.stage === 'kick' && d) {
    phase = 'strike';
    d.step(env, dt);
    const reach = Math.max(1e-3, Math.min(1, d.sContact));
    u = clamp(d.s / reach, 0, 1);
    p.seek(c.liftAt + (c.impact - c.liftAt) * u);
    const clipLeg = readLeg(env, p.q, c.side, legA);
    leg.mode = 'joints';
    leg.angles.hipYaw = d.leg.hipYaw;
    leg.angles.hipRoll = d.leg.hipRoll;
    leg.angles.hipPitch = d.leg.hipPitch;
    leg.angles.knee = d.leg.knee;
    leg.angles.anklePitch = clipLeg.anklePitch;
    leg.angles.ankleRoll = clipLeg.ankleRoll;
    if (run.landed && c.tLanded < 0) c.tLanded = c.t;
    if (d.done && !run.landed) c.heldEnd += dt;
    if ((c.tLanded >= 0 && c.t - c.tLanded >= K.followS) || c.heldEnd >= K.whiffHoldS || d.t >= K.maxFlightS) {
      c.stage = 'rewind';
      c.rewindFrom = p.tau;
      c.rewindT = 0;
      Object.assign(c.recLeg, leg.angles);
    }
  }
  if (c.stage === 'rewind') {
    phase = 'recover';
    c.rewindT += dt;
    const T = K.rewindS * (1.3 - 0.6 * env.aggression);
    u = clamp(c.rewindT / T, 0, 1);
    const k = minJerk(u);
    p.seek(c.rewindFrom + (c.liftAt - c.rewindFrom) * u);
    const a = c.recLeg, b = c.liftLeg, o = legC;
    o.hipYaw = a.hipYaw + (b.hipYaw - a.hipYaw) * k;
    o.hipRoll = a.hipRoll + (b.hipRoll - a.hipRoll) * k;
    o.hipPitch = a.hipPitch + (b.hipPitch - a.hipPitch) * k;
    o.knee = a.knee + (b.knee - a.knee) * k;
    o.anklePitch = a.anklePitch + (b.anklePitch - a.anklePitch) * k;
    o.ankleRoll = a.ankleRoll + (b.ankleRoll - a.ankleRoll) * k;
    leg.mode = 'joints';
    Object.assign(leg.angles, o);
    if (u >= 1) {
      gait.returnSkillLeg(c.place, RETURN_SWING, env.s);
      c.stage = 'land';
    }
  }
  upperBody(env, c, 1);
  counterLean(env, c.side);
  return { phase, u, progress: clamp(p.tau / c.move.duration, 0, 1), done: false };
}

/**
 * The legs are a quarter of these robots' mass (a human's are a sixth): a kicking leg out toward him
 * carries the COM off the stance sole unless the upper body leans the other way. The lean that keeps the
 * whole COM where it was, m_leg·d_leg = m_up·h·sin(lean) (d the leg's COM off the stance foot in the
 * pelvis frame, h the upper body's lever over the hips), × KICK_DRIVE.leanShare, on top of the clip's own.
 */
function counterLean(env: SkillEnv, side: Side): void {
  const k = KICK_DRIVE.leanShare;
  if (k <= 0) return;
  const s = env.s;
  const st = env.gait.feet[other(side)].place;
  const L = s.legs[side];
  const h = s.heading;
  const dx = L.com[0] - st.x, dy = L.com[1] - st.y;
  const fwd = dx * Math.cos(h) + dy * Math.sin(h);
  const lat = -dx * Math.sin(h) + dy * Math.cos(h);
  const mUp = Math.max(1, s.mass - 2 * L.mass);
  const lever = Math.max(0.1, env.geo.pelvisToTorso[2] + env.geo.torsoCenter[2]);
  env.pose.pelvisPitch -= Math.asin(clamp((k * L.mass * fwd) / (mUp * lever), -KICK_DRIVE.maxLean, KICK_DRIVE.maxLean));
  env.pose.pelvisRoll += Math.asin(clamp((k * L.mass * lat) / (mUp * lever), -KICK_DRIVE.maxLean, KICK_DRIVE.maxLean));
}

/** The first surface of the kick's target (world): the zone's point pulled toward the kicking hip by its depth. */
function kickSurface(env: SkillEnv, run: SkillRun, side: Side): Vec3 {
  const s = env.s;
  const aim = run.aim ?? env.opp.chest;
  const local = mulMtV(s.pelvisRot, sub(aim, s.pelvisPos));
  const hip = env.geo.legs[side].hip;
  const dir = normalize(sub(local, hip), [1, 0, 0]);
  const legZone = run.zone === 'left_leg' || run.zone === 'right_leg';
  const k = -(legZone ? KICK_DRIVE.legSurfaceM : env.opp.frontDepth * 0.5);
  const q: Vec3 = [local[0] + dir[0] * k, local[1] + dir[1] * k, local[2] + dir[2] * k];
  const R = s.pelvisRot, o = s.pelvisPos;
  return [
    o[0] + R[0] * q[0] + R[1] * q[1] + R[2] * q[2],
    o[1] + R[3] * q[0] + R[4] * q[1] + R[5] * q[2],
    o[2] + R[6] * q[0] + R[7] * q[1] + R[8] * q[2],
  ];
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

