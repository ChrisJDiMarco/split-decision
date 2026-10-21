// Getting up the way the CMU actors did. Once the body lies still, the fall's orientation picks
// the clip family (face down, on the back, on a side), limb damage rules variants out, and the
// whole body plays the retargeted get-up: hands, knees and feet push on the canvas and physics
// decides whether the robot really comes up.
//   align    joints ease from how the body landed into the clip's first frame
//   play     the clip runs at the pace its joints allow; it waits (slows) while the body lags
//            the clip's pelvis height, as a heavy body pressing up does
//   stand    once the clip is on its feet alone and the soles are flat with the COM over them,
//            balance takes over and stands up the rest of the way (rise.ts)
//   fail     the body rolled the wrong way, stalled or fell back: lie still, try another variant
//            (after MAX_CLIP_TRIES the scripted get-up takes over; a wrecked leg stays down)
import type { Move, MoveLabel } from '../../../robots/motions';
import { CONTACT, mirrorContacts } from '../../../robots/motions';
import type { RobotRuntime } from '../../sim-context';
import type { Vec3 } from '../../../core/types';
import { addVelocityFeedforward } from '../feedforward';
import { SIDES, type HumanoidGeometry, type Side } from '../geometry';
import { armFK, armIK, clampAngle, legFK, legIK, newArmAngles, newLegAngles } from '../ik';
import { clamp, minJerk, mulMM, mulMtM, mulMtV, mulMV, rotZ, slerpMat, sub, type Mat3 } from '../math';
import { jointMap, newBodyCommand, solveBody, type BodyCommand, type JointMap } from '../posture';
import type { Sense } from '../sense';
import type { StanceParams } from '../stance';
import { convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from '../support';
import { getupSpeed, type GetupSpeed } from '../getup-speed';
import { GETUP_PLAN, type PlanEntry } from './getup-plan';
import type { MocapSet } from './library';
import { MotionPlayer } from './player';

// (alignment time and pace: GETUP_SPEED, getup-speed.ts)
const LAG_SLOW_M = 0.1; // pelvis this far below the clip's: slow down...
const LAG_STOP_M = 0.25; // ...and wait for it at this
const MIN_PACE = 0.12;
const MAX_WAIT_S = 2.5; // total time spent waiting on a lagging body before giving up
const MAX_EXTRA_S = 5; // a clip may take this much longer than its own length
const FELL_BACK_M = 0.3; // pelvis this far below the clip's after the clip has risen...
const FELL_BACK_S = 0.6; // ...for this long: the attempt has failed
const WRONG_WAY = 0.55; // torso forward-axis z past this the other way: rolled over, not up
export const MAX_CLIP_TRIES = 3;
// The pop-up off the back (the CMU 140_08/140_09 'getup_back' clips, also used lying on a side).
// Chris turned it off (2026-09-29) because it looked wrong, then back on once measured: without it a
// robot on its back mostly can't get up (HAYMAKER shoved over stayed down, tests/referee/break.test.ts).
// Move polish (docs/design/move-polish.md) is meant to fix how it looks. false = side clip, then scripted.
export const BACK_CLIP_GETUPS = true;
const backClip = (id: string): boolean => id.startsWith('getup_back');
const STAND_FLAT = 0.85; // sole up-axis z
const STAND_FOOT_M = 0.035;
const STAND_UPRIGHT = -0.1; // torso up-axis z: not hanging head-down off the hips
const STAND_MARGIN_M = 0.01;
const STAND_MAX_SPEED = 0.3; // m/s of the COM: balance takes over a body that has settled
const FLIGHT_HOLD_S = 0.12; // clip time: stop this short of an airborne moment (the actors hop up)
const HOLD_MAX_S = 1.5; // wall time held there waiting for the COM to settle over the feet
const FEET = CONTACT.FOOT_L | CONTACT.FOOT_R;
// Crouch: feet (and any hand still down) hold their spots while the pelvis carries the COM over
// the soles and comes upright.
const CROUCH_FLAT = 0.7;
const CROUCH_FOOT_M = 0.05;
const CROUCH_LEAD_S = 0.25; // the COM error is taken this far ahead (its velocity counts)
const CROUCH_KI = 2.5; // pelvis target speed per metre of COM error, 1/s
const CROUCH_KP = 0.6; // ...plus this much of the error at once
const CROUCH_UPRIGHT_TAU_S = 0.9; // the hips come upright (and the waist unbends) this fast
const CROUCH_TORSO_UP = 0.5; // torso up-axis z above which the waist may unbend
const CROUCH_WAIST_RAD = 0.6;
const CROUCH_MAX_S = 3;
const CROUCH_FEET_LOST_S = 0.25;
const HAND_DOWN_M = 0.16; // a fist this low is propping the body up
const HAND_PRESS_M = 0.01;
// Contact projection: a limb the clip has on the canvas is put on it.
const PRESS_M = 0.006; // pressed this far into the canvas: the limb bears load
const MAX_PROJECT_M = 0.15; // never moved further than this from the clip's own placement
const PROJECT_BLEND_S = 0.08;
const FOOT_WAIT_M = 0.04; // a foot the clip has planted, still this far up: the clip slows...
const FOOT_WAIT_PACE = 0.25; // ...to this
const HAND_LOOKAHEAD_S = 0.1; // clip time: a hand about to leave the canvas
const HANDS = CONTACT.HAND_L | CONTACT.HAND_R;
const footBit = (side: Side): number => (side === 'l' ? CONTACT.FOOT_L : CONTACT.FOOT_R);
const handBit = (side: Side): number => (side === 'l' ? CONTACT.HAND_L : CONTACT.HAND_R);

export type ClipGetUpResult = 'busy' | 'up' | 'fail';
export type LyingOrientation = 'face_down' | 'back' | 'side_l' | 'side_r';

export interface ClipOptions {
  projectFeet: boolean;
  projectHands: boolean;
  footWait: boolean;
  handGate: boolean;
}

const OPTION_SETS: Record<PlanEntry['opts'], ClipOptions> = {
  plain: { projectFeet: false, projectHands: false, footWait: false, handGate: false },
  hands: { projectFeet: false, projectHands: true, footWait: false, handGate: true },
};

/** Which way the body lies: from the torso's forward (x) and left (y) axes. */
export function lyingLabel(s: Sense): { label: MoveLabel; downSide: Side; orient: LyingOrientation } {
  const fwdZ = s.torsoRot[6], leftZ = s.torsoRot[7];
  const downSide: Side = leftZ < 0 ? 'l' : 'r';
  // (A braced fall leaves the body on a side turned well toward the front or the back: its own family's clips
  // start from there; the back clips used on a square side cannot start from a body turned face down.)
  if (fwdZ < -SIDE_TURN_Z) return { label: 'getup_face_down', downSide, orient: 'face_down' };
  if (fwdZ > SIDE_TURN_Z) return { label: 'getup_back', downSide, orient: 'back' };
  return { label: 'getup_side', downSide, orient: downSide === 'l' ? 'side_l' : 'side_r' };
}
/** Torso forward-axis z past which a body on its side counts as face down (or on its back): 0.5 as built. */
const SIDE_TURN_Z = 0.25;

/** A joint that cannot push: limp, seized, or driven off a circuit with no pressure left. */
function jointDead(r: RobotRuntime, name: string): boolean {
  const i = r.jointIndex.get(name);
  if (i === undefined) return true;
  const j = r.joints[i];
  if (j.state === 'limp' || j.state === 'seized') return true;
  return !!j.hydraulicCircuit && (r.hydraulics.get(j.hydraulicCircuit)?.pressure ?? 1) < 0.3;
}

export function legWrecked(r: RobotRuntime, side: Side): boolean {
  return ['hip_pitch', 'knee', 'ankle_pitch'].some((j) => jointDead(r, `${j}_${side}`)) || !(r.parts.get(`foot_${side}`)?.attached ?? false);
}

export function armWrecked(r: RobotRuntime, side: Side): boolean {
  return ['shoulder_pitch', 'elbow'].some((j) => jointDead(r, `${j}_${side}`)) || !(r.parts.get(`forearm_${side}`)?.attached ?? false);
}

/** Contact bits a clip leans on (played mirrored when `mirror`). */
function usedBits(move: Move, mirror: boolean): number {
  let bits = 0;
  for (let f = 0; f < move.frames; f++) bits |= move.contacts[f];
  if (!mirror) return bits;
  const swap = (a: number, b: number) => ((bits & a) ? b : 0) | ((bits & b) ? a : 0);
  return swap(CONTACT.FOOT_L, CONTACT.FOOT_R) | swap(CONTACT.HAND_L, CONTACT.HAND_R) | swap(CONTACT.KNEE_L, CONTACT.KNEE_R) | (bits & (CONTACT.HIPS | CONTACT.CHEST));
}

/** The side a clip's actor lies on at its first frame (side get-ups), from the pelvis quaternion. */
function clipDownSide(move: Move): Side {
  const [w, x, y, z] = [move.root[3], move.root[4], move.root[5], move.root[6]];
  const leftZ = 2 * (y * z + w * x); // R[2][1] of the quaternion
  return leftZ < 0 ? 'l' : 'r';
}

export class ClipGetUp {
  /** Tests and tuning: play this move id (if usable) instead of choosing. */
  static force: string | null = null;
  static forceMirror: boolean | null = null;
  /** Tests and tuning: these playback options for forced moves. */
  static opts: ClipOptions = { ...OPTION_SETS.plain };
  /** Playback options of the attempt in progress. */
  opts: ClipOptions = { ...OPTION_SETS.plain };
  stage: 'idle' | 'align' | 'play' | 'crouch' = 'idle';
  move: Move | null = null;
  tries = 0;
  /** Why the last attempt failed (diagnostics). */
  reason = '';
  private t = 0;
  private total = 0;
  private waited = 0;
  private lowFor = 0;
  private peakClipZ = 0;
  private held = 0;
  private feetLost = 0;
  private flightAt = Infinity;
  /** Variants (move|mirror|options) that failed during this knockdown. */
  private readonly failed = new Set<string>();
  private key = '';
  private readonly from: Float64Array;
  readonly player: MotionPlayer;
  private readonly jm: JointMap;
  private readonly cmd: BodyCommand = newBodyCommand();
  private readonly legA = newLegAngles();
  private readonly armA = newArmAngles();
  private readonly weights: Record<Side, { foot: number; hand: number }> = { l: { foot: 0, hand: 0 }, r: { foot: 0, hand: 0 } };
  private readonly crouch = {
    feet: { l: { x: 0, y: 0, yaw: 0 }, r: { x: 0, y: 0, yaw: 0 } } as Record<Side, FootPlace>,
    hands: { l: null, r: null } as Record<Side, Vec3 | null>,
    pos: [0, 0, 0] as Vec3,
    rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3,
    waist: 0,
  };

  /** The design's get-up speeds (getup-speed.ts), fixed when the robot is built. */
  private readonly speed: GetupSpeed;

  constructor(private readonly set: MocapSet, private readonly r: RobotRuntime, private readonly geo: HumanoidGeometry, private readonly stance: StanceParams) {
    this.speed = getupSpeed(r.design.id);
    this.player = new MotionPlayer(set, r.joints.length);
    this.from = new Float64Array(r.joints.length);
    this.jm = jointMap(r);
  }

  /** A new knockdown: every variant is available again. */
  reset(): void {
    this.failed.clear();
    this.tries = 0;
    this.stage = 'idle';
    this.move = null;
  }

  get label(): string {
    return this.stage === 'crouch' ? 'getup_crouch' : this.move?.label ?? 'getup';
  }

  /** A face-down clip is still on the menu for this knockdown (tries left, an arm and the legs to push with). */
  canFaceDown(): boolean {
    if (this.tries >= MAX_CLIP_TRIES || this.cannotRise() || (!GETUP_PLAN[this.r.design.id] && !ClipGetUp.force)) return false;
    return !!this.fromPlan('face_down') || !!this.choose('getup_face_down', 'l');
  }

  /** Both legs wrecked: this robot stays down. */
  cannotRise(): boolean {
    return legWrecked(this.r, 'l') && legWrecked(this.r, 'r');
  }

  /**
   * Pick a clip for the way the body lies; false when none is usable (every variant tried, or
   * the damage rules them all out). `qNow`: the measured joint angles (the align start).
   */
  begin(s: Sense, qNow: Float64Array, as?: LyingOrientation): boolean {
    if (this.tries >= MAX_CLIP_TRIES || this.cannotRise()) return false;
    // Only designs whose variants were searched (getup-plan.ts) get up from clips: on the iron-age
    // bodies the unsearched clips fail more often than the scripted get-up (GOLIATH 0/8 against
    // 8/8 laid four ways, two drops each).
    if (!GETUP_PLAN[this.r.design.id] && !ClipGetUp.force) return false;
    const lying = lyingLabel(s);
    // `as`: the body was just rolled onto its front (getup.ts): the face-down family whatever the last few degrees say.
    const { label, downSide, orient } = as === 'face_down' ? { ...lying, label: 'getup_face_down' as MoveLabel, orient: 'face_down' as LyingOrientation } : lying;
    const forced = ClipGetUp.force ? this.set.lib.moves.find((m) => m.id === ClipGetUp.force)?.label : undefined;
    // Back clips off: the plan's back/side entries are all 'getup_back' clips, so fromPlan skips them
    // and the side clip below is used (measured: PYLON on its back up in 4.6 s; the scripted get-up
    // never rose, so it stays the last resort).
    let pick = forced ? null : this.fromPlan(orient);
    if (!pick) {
      const own = BACK_CLIP_GETUPS || forced || label !== 'getup_back' ? this.choose(forced ?? label, downSide) : null;
      const alt = label === 'getup_side' ? (BACK_CLIP_GETUPS ? 'getup_back' : null) : 'getup_side';
      const any = own ?? (alt ? this.choose(alt, downSide) : null);
      if (any) pick = { ...any, opts: forced ? { ...ClipGetUp.opts } : { ...OPTION_SETS.plain }, key: `${any.move.id}|${any.mirror}|plain` };
    }
    if (!pick) return false;
    this.tries++;
    this.opts = pick.opts;
    this.key = pick.key;
    this.move = pick.move;
    this.player.play(pick.move, { mirror: pick.mirror, speed: this.speed.pace, mask: 'all' });
    this.from.set(qNow);
    this.stage = 'align';
    this.t = 0;
    this.total = 0;
    this.waited = 0;
    this.lowFor = 0;
    this.peakClipZ = 0;
    this.held = 0;
    this.flightAt = firstFlight(pick.move);
    for (const side of SIDES) this.weights[side].foot = this.weights[side].hand = 0;
    return true;
  }

  /** The design's searched variants for this orientation, best first, that are still usable. */
  private fromPlan(orient: LyingOrientation): { move: Move; mirror: boolean; opts: ClipOptions; key: string } | null {
    for (const e of GETUP_PLAN[this.r.design.id]?.[orient] ?? []) {
      const key = `${e.id}|${e.mirror}|${e.opts}`;
      if (this.failed.has(key) || (!BACK_CLIP_GETUPS && backClip(e.id))) continue;
      const move = this.set.lib.moves.find((m) => m.id === e.id);
      if (!move || !this.limbsAllow(move, e.mirror)) continue;
      return { move, mirror: e.mirror, opts: { ...OPTION_SETS[e.opts] }, key };
    }
    return null;
  }

  /** A limp arm rules out every clip that pushes with that hand; a wrecked leg every clip that
   *  stands or kneels on it. */
  private limbsAllow(move: Move, mirror: boolean): boolean {
    const bits = usedBits(move, mirror);
    if ((armWrecked(this.r, 'l') && bits & CONTACT.HAND_L) || (armWrecked(this.r, 'r') && bits & CONTACT.HAND_R)) return false;
    return !((legWrecked(this.r, 'l') && bits & (CONTACT.FOOT_L | CONTACT.KNEE_L)) || (legWrecked(this.r, 'r') && bits & (CONTACT.FOOT_R | CONTACT.KNEE_R)));
  }

  private choose(label: MoveLabel, downSide: Side): { move: Move; mirror: boolean } | null {
    const moves = this.set.byLabel.get(label) ?? [];
    let best: { move: Move; mirror: boolean; score: number } | null = null;
    for (const move of moves) {
      if (ClipGetUp.force && move.id !== ClipGetUp.force) continue;
      for (const mirror of [false, true]) {
        if (this.failed.has(`${move.id}|${mirror}|plain`)) continue;
        if (ClipGetUp.forceMirror !== null && mirror !== ClipGetUp.forceMirror) continue;
        // A side get-up must start on the side the body lies on.
        if (label === 'getup_side' && (clipDownSide(move) === downSide) === mirror) continue;
        if (!this.limbsAllow(move, mirror)) continue;
        // Shorter, cleaner clips first; alternate the mirror on retries.
        const score = move.duration + 8 * move.quality.footErr + (mirror ? 0.05 : 0) * (this.tries % 2 === 0 ? 1 : -1);
        if (!best || score < best.score) best = { move, mirror, score };
      }
    }
    return best;
  }

  /** The attempt just failed: this variant is out for the rest of this knockdown. */
  fail(): void {
    if (this.move) this.failed.add(this.key);
    this.stage = 'idle';
    this.move = null;
    this.player.stop();
  }

  /**
   * One control update: writes joint targets `q` (r.joints order, with the servo velocity
   * feed-forward folded in). Returns 'up' when balance should take over, 'fail' when this attempt
   * is lost.
   */
  update(s: Sense, q: Float64Array, dt: number): ClipGetUpResult {
    const p = this.player;
    const move = this.move;
    if (!move || this.stage === 'idle') return 'fail';
    this.t += dt;
    this.total += dt;
    const fail = (why: string): ClipGetUpResult => {
      this.reason = `${why} at ${p.tau.toFixed(2)}/${move.duration.toFixed(2)} s (${move.id})`;
      return 'fail';
    };
    if (this.stage === 'align') {
      const k = minJerk(this.t / this.speed.alignS);
      for (let i = 0; i < q.length; i++) q[i] = this.from[i] + (p.q[i] - this.from[i]) * k;
      if (this.t >= this.speed.alignS) {
        this.stage = 'play';
        this.t = 0;
      }
      return 'busy';
    }
    if (this.stage === 'crouch') return this.updateCrouch(s, q, dt, fail);
    const H = this.stance.pelvisHeight;
    // Pace: the clip waits for a body that has not followed it up yet, and holds on the ground
    // before a hop (the robot gets over its feet and stands up with balance instead).
    const clipZ = p.s.rootPos[2];
    this.peakClipZ = Math.max(this.peakClipZ, clipZ);
    const lag = clipZ - s.pelvisPos[2];
    let pace = lag <= LAG_SLOW_M ? 1 : clamp(1 - (lag - LAG_SLOW_M) / (LAG_STOP_M - LAG_SLOW_M), MIN_PACE, 1);
    if (pace < 1) this.waited += dt * (1 - pace);
    const holding = p.tau >= this.flightAt - FLIGHT_HOLD_S && this.held < HOLD_MAX_S;
    if (holding) {
      pace = 0;
      this.held += dt;
    }
    // A foot the clip has planted must really be down before the clip moves on.
    const bits = p.s.contacts;
    for (const side of SIDES) {
      if (this.opts.footWait && bits & footBit(side) && s.feet[side].height > FOOT_WAIT_M) {
        pace = Math.min(pace, FOOT_WAIT_PACE);
        this.waited += dt * (1 - FOOT_WAIT_PACE);
      }
    }
    p.step(dt, pace);
    q.set(p.q);
    this.projectContacts(s, q, dt);
    addVelocityFeedforward(this.r, q, p.qd);
    if (this.rolledOver(s)) return fail('rolled over');
    if (this.waited > MAX_WAIT_S) return fail(`stalled (pelvis ${lag.toFixed(2)} m below the clip)`);
    if (this.total > move.duration / this.speed.pace + MAX_EXTRA_S) return fail('timeout');
    // Fell back: the clip had the pelvis well up, the body is far below it.
    this.lowFor = this.peakClipZ > 0.5 * H && lag > FELL_BACK_M ? this.lowFor + dt : 0;
    if (this.lowFor > FELL_BACK_S) return fail('fell back');
    // Both feet down in the clip and under the body, and the hands about to leave the canvas (or
    // gone): from here balance does the rest, first getting the COM over the soles while any hand
    // still down props the body up.
    const ahead = this.contactsAt(p.tau + HAND_LOOKAHEAD_S);
    const handsLeaving = !this.opts.handGate || ((bits & HANDS) !== 0 && (ahead & HANDS) === 0);
    if ((bits & FEET) === FEET && (handsLeaving || (bits & HANDS) === 0) && this.feetDown(s)) {
      if (this.standing(s)) return 'up';
      // Off the back or a side (this.speed.crouch 0), the clip plays on: the actor's own weight shift over the
      // feet, not the crouch's (measured: the crouch sat SAVATE and FIRECRACKER back down and lost the feet).
      if (this.speed.crouch > 0 || move.label === 'getup_face_down') {
        this.enterCrouch(s);
        return 'busy';
      }
    }
    if (p.done) {
      if (this.standing(s)) return 'up';
      // Played to its end with the feet down but the body not over them yet: the crouch carries it there.
      if (this.feetDown(s)) {
        this.enterCrouch(s);
        return 'busy';
      }
      return fail('clip ended off balance');
    }
    return 'busy';
  }

  /** Contact flags of the clip at clip time `tau` (as played: mirrored if the clip is). */
  private contactsAt(tau: number): number {
    const m = this.move!;
    const c = m.contacts[Math.min(m.frames - 1, Math.max(0, Math.round(tau * m.fps)))];
    return this.player.mirror ? mirrorContacts(c) : c;
  }

  /**
   * Limbs the clip has on the canvas are put on it: the clip's foot or fist, relative to the body
   * as it really lies, lowered (or raised) onto the canvas, so the support the clip leans on is
   * really there (the robot's proportions and mass are not the actor's). Blended in and out.
   */
  private projectContacts(s: Sense, q: Float64Array, dt: number): void {
    const bits = this.player.s.contacts;
    const k = Math.min(1, dt / PROJECT_BLEND_S);
    for (const side of SIDES) {
      const w = this.weights[side];
      w.foot += ((bits & footBit(side) ? 1 : 0) - w.foot) * k;
      w.hand += ((bits & handBit(side) ? 1 : 0) - w.hand) * k;
      if (w.foot > 0.01 && this.opts.projectFeet) this.footToCanvas(s, side, q, w.foot);
      if (w.hand > 0.01 && this.opts.projectHands) this.fistToCanvas(s, side, q, w.hand);
    }
  }

  private footToCanvas(s: Sense, side: Side, q: Float64Array, w: number): void {
    const m = this.jm.leg[side];
    const a = this.legA;
    a.hipYaw = q[m.hipYaw]; a.hipRoll = q[m.hipRoll]; a.hipPitch = q[m.hipPitch];
    a.knee = q[m.knee]; a.anklePitch = q[m.anklePitch]; a.ankleRoll = q[m.ankleRoll];
    const g = this.geo.legs[side];
    const fk = legFK(g, a);
    const R = s.pelvisRot;
    const ank = mulMV(R, fk.ankle);
    const foot = mulMM(R, fk.footRot);
    const dz = clamp(g.soleDepth - PRESS_M - (s.pelvisPos[2] + ank[2]), -MAX_PROJECT_M, MAX_PROJECT_M);
    ank[2] += dz;
    legIK(g, mulMtV(R, ank), mulMtM(R, rotZ(Math.atan2(foot[3], foot[0]))), a);
    const lim = (n: string) => this.geo.limits.get(`${n}_${side}`);
    const put = (i: number, v: number, n: string) => { q[i] += (clampAngle(v, lim(n)) - q[i]) * w; };
    put(m.hipYaw, a.hipYaw, 'hip_yaw'); put(m.hipRoll, a.hipRoll, 'hip_roll'); put(m.hipPitch, a.hipPitch, 'hip_pitch');
    put(m.knee, a.knee, 'knee'); put(m.anklePitch, a.anklePitch, 'ankle_pitch'); put(m.ankleRoll, a.ankleRoll, 'ankle_roll');
  }

  private fistToCanvas(s: Sense, side: Side, q: Float64Array, w: number): void {
    const m = this.jm.arm[side];
    const a = this.armA;
    a.pitch = q[m.pitch]; a.roll = q[m.roll]; a.yaw = q[m.yaw]; a.elbow = q[m.elbow];
    const g = this.geo.arms[side];
    const fk = armFK(g, a);
    const T = s.torsoRot;
    const fist = mulMV(T, fk.fist);
    const dz = clamp(g.fistHalf - PRESS_M - (s.torsoPos[2] + fist[2]), -MAX_PROJECT_M, MAX_PROJECT_M);
    fist[2] += dz;
    const mid: Vec3 = [(g.shoulder[0] + fk.fist[0]) / 2, (g.shoulder[1] + fk.fist[1]) / 2, (g.shoulder[2] + fk.fist[2]) / 2];
    armIK(g, mulMtV(T, fist), sub(fk.elbow, mid), a);
    const lim = (n: string) => this.geo.limits.get(`${n}_${side}`);
    const put = (i: number, v: number, n: string) => { q[i] += (clampAngle(v, lim(n)) - q[i]) * w; };
    put(m.pitch, a.pitch, 'shoulder_pitch'); put(m.roll, a.roll, 'shoulder_roll'); put(m.yaw, a.yaw, 'shoulder_yaw'); put(m.elbow, a.elbow, 'elbow');
  }

  /** Both soles flat enough and on the canvas. */
  private feetDown(s: Sense): boolean {
    return SIDES.every((side) => s.feet[side].flat > CROUCH_FLAT && s.feet[side].height < CROUCH_FOOT_M) && s.pelvisPos[2] > this.speed.standHeight * this.stance.pelvisHeight;
  }

  private enterCrouch(s: Sense): void {
    const c = this.crouch;
    this.stage = 'crouch';
    this.t = 0;
    this.feetLost = 0;
    for (const side of SIDES) {
      const f = s.feet[side];
      c.feet[side] = { x: f.sole[0], y: f.sole[1], yaw: f.yaw };
      const fist = s.fists[side];
      c.hands[side] = fist[2] < HAND_DOWN_M ? [fist[0], fist[1], Math.max(this.geo.arms[side].fistHalf, fist[2] - HAND_PRESS_M)] : null;
    }
    c.pos = [...s.pelvisPos] as Vec3;
    c.rot = [...s.pelvisRot] as Mat3;
    c.waist = s.waistPitch;
  }

  /**
   * Hands (if down) and feet hold their spots on the canvas while the pelvis moves to put the COM
   * over the soles and the hips come upright; once the COM has settled there, balance takes over.
   */
  private updateCrouch(s: Sense, q: Float64Array, dt: number, fail: (why: string) => ClipGetUpResult): ClipGetUpResult {
    const c = this.crouch;
    const cx = (c.feet.l.x + c.feet.r.x) / 2, cy = (c.feet.l.y + c.feet.r.y) / 2;
    const ex = s.com[0] + s.comVel[0] * CROUCH_LEAD_S - cx, ey = s.com[1] + s.comVel[1] * CROUCH_LEAD_S - cy;
    // The pelvis target walks against the COM error (integral) plus a proportional push.
    c.pos[0] -= CROUCH_KI * ex * dt;
    c.pos[1] -= CROUCH_KI * ey * dt;
    // The hips bring the pelvis (and the torso with it) upright; the waist only unbends as far as
    // the torso has come up (a waist motor cannot lift a heavy torso from level).
    const upright = rotZ(Math.atan2(c.rot[3], c.rot[0]));
    c.rot = slerpMat(c.rot, upright, Math.min(1, dt / CROUCH_UPRIGHT_TAU_S));
    const waistGoal = s.upright > CROUCH_TORSO_UP ? CROUCH_WAIST_RAD : c.waist;
    c.waist += (Math.min(c.waist, waistGoal) - c.waist) * Math.min(1, dt / CROUCH_UPRIGHT_TAU_S);
    const cmd = this.cmd;
    cmd.pelvisPos = [c.pos[0] - CROUCH_KP * ex, c.pos[1] - CROUCH_KP * ey, c.pos[2]];
    cmd.pelvisRot = c.rot;
    cmd.waistPitch = c.waist;
    cmd.waistYaw = 0;
    cmd.neckYaw = 0;
    for (const side of SIDES) {
      const g = this.geo.legs[side];
      const f = c.feet[side];
      const leg = cmd.legs[side];
      leg.mode = 'foot';
      leg.measured = false;
      leg.ankleStiffness = 0.4;
      leg.ankle = [f.x - Math.cos(f.yaw) * g.footCenterX, f.y - Math.sin(f.yaw) * g.footCenterX, g.soleDepth];
      leg.footRot = rotZ(f.yaw);
      const arm = cmd.arms[side];
      const hand = c.hands[side];
      if (hand) {
        arm.mode = 'fist';
        arm.fist = mulMtV(s.torsoRot, sub(hand, s.torsoPos));
        arm.pole = [-0.3, side === 'l' ? 0.5 : -0.5, 0.4];
      } else {
        arm.mode = 'fist';
        arm.fist = [...this.stance.guard[side].fist] as Vec3;
        arm.pole = [...this.stance.guard[side].pole] as Vec3;
      }
    }
    solveBody(cmd, this.geo, this.jm, q, { pos: s.pelvisPos, rot: s.pelvisRot, shin: { l: s.feet.l.shinRot, r: s.feet.r.shinRot } });
    if (this.standing(s)) return 'up';
    if (this.t > CROUCH_MAX_S) return fail('could not get the COM over the feet');
    this.feetLost = this.feetDown(s) ? 0 : this.feetLost + dt;
    if (this.feetLost > CROUCH_FEET_LOST_S) return fail('lost the feet in the crouch');
    return 'busy';
  }

  /**
   * The body turned the other way from the clip's (a face-down get-up that tipped onto its back):
   * the pelvis forward axis points up where the clip's points down, or the reverse.
   */
  private rolledOver(s: Sense): boolean {
    const [w, x, y, z] = this.player.s.rootQuat;
    const clipFwdZ = 2 * (x * z - w * y); // R[2][0]
    return Math.abs(s.pelvisRot[6] - clipFwdZ) > 2 * WRONG_WAY && Math.sign(s.pelvisRot[6]) !== Math.sign(clipFwdZ);
  }

  /** Soles flat on the canvas, pelvis off it, COM settled with it and the capture point over the soles. */
  private standing(s: Sense): boolean {
    for (const side of SIDES) {
      const f = s.feet[side];
      if (f.flat < STAND_FLAT || f.height > STAND_FOOT_M) return false;
    }
    if (s.upright < STAND_UPRIGHT || s.pelvisPos[2] < this.speed.standHeight * this.stance.pelvisHeight) return false;
    if (Math.hypot(s.comVel[0], s.comVel[1]) > STAND_MAX_SPEED) return false;
    const soles = convexHull(SIDES.flatMap((side) => footCorners(this.geo, side, { x: s.feet[side].sole[0], y: s.feet[side].sole[1], yaw: s.feet[side].yaw })));
    const inside = (pt: P2) => polygonDistance(soles, pt).d <= -STAND_MARGIN_M;
    return inside([s.com[0], s.com[1]]) && inside([s.capture[0], s.capture[1]]);
  }
}

/** Clip time of the first airborne frame after the feet have been down (Infinity if none). */
function firstFlight(move: Move): number {
  let footed = false;
  for (let f = 0; f < move.frames; f++) {
    const c = move.contacts[f];
    if (c & FEET) footed = true;
    else if (footed && c === 0) return f / move.fps;
  }
  return Infinity;
}
