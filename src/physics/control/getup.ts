// Falls and getting back up.
//   detect   torso tipped past ~63° or the pelvis below 55% of its stance height, for
//            FALL_CONFIRM_S: r.down, a 'fall' event, the skill and any borrowed leg abandoned
//   settle   joints go compliant (targets follow the measured angles, only damping resists)
//            until the body lies still
//   roll     face up or on a side: legs swing over, the waist twists the chest round toward
//            the canvas while the far arm reaches over, the far leg follows
//   press    hands beside the shoulders, push up to straight arms
//   pike     feet pulled in behind the hips: hands and toes, hips high
//   step in  one foot then the other swings forward and plants flat under the body's COM
//   sit back hands still down, the hips sink back until the COM is over the feet
//   (then)   balance takes over and rolls up through the hips to the stance (see rise.ts)
// Hands and feet are placed at points on the canvas relative to the body as it actually lies,
// through the limb IK solved from the measured pelvis and torso, so the sequence adapts to
// however the robot landed. Joint targets blend from where each phase started. A sequence that
// rolls the body back over, or stalls, lies still and starts again.
import type { Vec3 } from '../../core/types';
import type { SimContext } from '../sim-context';
import { SIDES, type HumanoidGeometry, type Side } from './geometry';
import type { ClipGetUp } from './mocap/getup';
import { clamp, minJerk, mulMM, mulMtM, mulMV, mulMtV, rotZ, sub, type Mat3 } from './math';
import { newBodyCommand, solveBody, type BodyCommand, type JointMap } from './posture';
import type { RollKey } from './roll-keys';
import type { Sense } from './sense';
import type { StanceParams } from './stance';
import { convexHull, footCorners, polygonDistance, type FootPlace, type P2 } from './support';

const FALL_CONFIRM_S = 0.15;
const DOWN_UPRIGHT = 0.45; // torso up-axis z below this is down
const DOWN_HEIGHT = 0.55; // pelvis below this fraction of stance height is down
const RISING_DOWN_HEIGHT = 0.3; // rising out of the crouch (folded by design): only a collapse counts
const SETTLE_MAX_S = 2.5;
const STILL_S = 0.12; // lying still this long ends the settle
const STILL_SPEED = 0.35; // m/s COM
const STILL_SPIN = 1.2; // rad/s torso
const MAX_ATTEMPT_S = 12; // a get-up that has not finished by now starts over
const PRONE_FWD_Z = -0.3; // torso x-axis z below this: chest (mostly) to the canvas
const FLIPPED_FWD_Z = 0.35; // chest back up: the push-up sequence has rolled the body over
const DEG = Math.PI / 180;

const PLANT_ANKLE_STIFFNESS = 0.3;
const SIT_MARGIN_M = 0.02; // COM and capture point this far inside the soles before the hands let go

/**
 * The choreography's pacing and placements, per design. The designs differ too much in mass split
 * and joint strength for one set to serve all three (the bruiser carries two thirds of its mass
 * above the waist; the goliath is the strongest per kilogram), so each was searched for over
 * shoved-over falls in several directions. Distances are fractions of arm reach (hands) or leg
 * length (feet).
 */
export interface GetUpTuning {
  speed: number; // push-up sequence phase durations ×
  rollSpeed: number; // roll key durations ×
  brace: number; // s held stiff in the stance once the fall is detected
  settleMin: number; // s before a body lying still may start to get up
  handOut: number; // hands this far outside the shoulders, × arm reach
  pikeBack: number; // pike: ankles pulled toward this far behind the hips, × leg length
  kneelAnkle: number; // rad, toes pointed while piking and tucking
  tuckFwd: number; // the stepping ankle passes this far ahead of its hip ...
  tuckHeight: number; // ... and this high, × leg length
  plantBack: number; // soles planted this far behind the body's COM, × leg length
  plantWidth: number; // soles this far out from the centre line, × hip offset
  pikeWaist: number; // rad of waist pitch in the pike
  plantWaist: number; // rad of waist pitch while the feet step in
  sitBack: number; // pelvis travel per metre the COM is ahead of the feet when sitting back
  sitDrop: number; // the pelvis sinks this fraction of its height as it sits back
  sitPitch: number; // rad the chest comes up as it sits back
  sitDur: number; // s
  sitHold: number; // s more allowed for the COM to arrive over the feet
  riseS: number; // s to stand up out of a full crouch
  /** After a roll, lie out straight and square before pushing up (instead of pushing up from
   *  wherever the roll left the hips and legs). */
  flatten?: boolean;
  /** Let go of the canvas only once readyToRise holds (else step the feet in again); without
   *  it the rise is tried from wherever the sit got to (a strong body's balance often saves it). */
  strictRise?: boolean;
}

/** For a humanoid design without its own entry: the mean of the three below. */
const DEFAULT_TUNING: GetUpTuning = {
  speed: 0.725, rollSpeed: 1.05, brace: 0.637, settleMin: 0.42, handOut: 0.202, pikeBack: 0.659,
  kneelAnkle: 0.539, tuckFwd: 0.028, tuckHeight: 0.214, plantBack: 0.226, plantWidth: 0.88,
  pikeWaist: 0.438, plantWaist: 0.789, sitBack: 1.273, sitDrop: 0.077, sitPitch: 0.282,
  sitDur: 0.494, sitHold: 0.338, riseS: 2.463,
};

const TUNING: Readonly<Record<string, GetUpTuning>> = {
  striker: {
    speed: 0.791, rollSpeed: 1.001, brace: 0.667, settleMin: 0.479, handOut: 0.208,
    pikeBack: 0.633, kneelAnkle: 0.428, tuckFwd: -0.002, tuckHeight: 0.189, plantBack: 0.277,
    plantWidth: 0.724, pikeWaist: 0.52, plantWaist: 0.762, sitBack: 1.154, sitDrop: 0.073,
    sitPitch: 0.222, sitDur: 0.431, sitHold: 0.322, riseS: 2.2,
  },
  bruiser: {
    speed: 0.697, rollSpeed: 1.203, brace: 0.586, settleMin: 0.37, handOut: 0.198, pikeBack: 0.7,
    kneelAnkle: 0.548, tuckFwd: -0.038, tuckHeight: 0.217, plantBack: 0.178, plantWidth: 1.027,
    pikeWaist: 0.281, plantWaist: 0.753, sitBack: 1.293, sitDrop: 0.079, sitPitch: 0.278,
    sitDur: 0.595, sitHold: 0.386, riseS: 2.409,
  },
  goliath: {
    speed: 0.688, rollSpeed: 0.947, brace: 0.657, settleMin: 0.412, handOut: 0.199,
    pikeBack: 0.646, kneelAnkle: 0.641, tuckFwd: 0.124, tuckHeight: 0.236, plantBack: 0.224,
    plantWidth: 0.888, pikeWaist: 0.514, plantWaist: 0.851, sitBack: 1.371, sitDrop: 0.079,
    sitPitch: 0.344, sitDur: 0.457, sitHold: 0.308, riseS: 2.781, flatten: true, strictRise: true,
  },
};

/** Tempo of the whole choreography (× every searched duration): the count is 10 s. */
const TEMPO = 0.8;
const SETTLE_TEMPO = 0.6;

export function getUpTuning(designId: string): GetUpTuning {
  const t = TUNING[designId] ?? DEFAULT_TUNING;
  return {
    ...t,
    speed: t.speed * TEMPO, rollSpeed: t.rollSpeed * TEMPO, sitDur: t.sitDur * TEMPO, sitHold: t.sitHold * TEMPO,
    brace: t.brace * SETTLE_TEMPO, settleMin: t.settleMin * SETTLE_TEMPO,
  };
}

type Group = 'arms' | 'legl' | 'legr';

interface Frame {
  fx: number; // head direction on the canvas
  fy: number;
  lx: number; // body-left direction on the canvas
  ly: number;
}

export type GetUpPhase = 'up' | 'settle' | 'clip' | 'legs' | 'roll' | 'arms' | 'hands' | 'press' | 'pike' | 'tuck_l' | 'plant_l' | 'tuck_r' | 'plant_r' | 'sit';

interface Phase {
  name: GetUpPhase;
  dur: number;
  hold: number;
  keep: Group[]; // held where the phase found them
  set(g: GetUp, s: Sense): void;
  /** Ends the phase early; if it never holds, the timeout sends the robot back to settle... */
  until?(g: GetUp, s: Sense): boolean;
  /** ...unless the phase is lenient: then the sequence goes on regardless... */
  lenient?: boolean;
  /** ...or it can be repaired: the feet step in again under where the body now is. */
  restep?: boolean;
}

/** Landed folded (kneeling, knees tucked): stretch the legs out first so the body lies flat. */
const LEGS_OUT: Phase[] = [{ name: 'legs', dur: 0.6, hold: 0.4, keep: ['arms'], set: (g) => { g.legsStraight(); g.waist(0); } }];
const FOLDED_HEIGHT = 0.36; // pelvis above this × stance height while lying: legs folded under

const PRONE: Phase[] = [
  // Arms out from under the chest (a fall lands on the guard), then hands beside the shoulders.
  { name: 'arms', dur: 0.4, hold: 0.1, keep: ['legl', 'legr'], set: (g) => { g.armsOut(); g.waist(0, null); } },
  // A roll leaves the waist twisted: it comes square in the pike, with the hips off the canvas.
  { name: 'hands', dur: 0.6, hold: 0.15, keep: ['legl', 'legr'], set: (g, s) => { g.hands(s, 0.08, 0); g.waist(0, null); } },
  { name: 'press', dur: 0.7, hold: 0.2, keep: ['legl', 'legr'], set: (g, s) => { g.hands(s, 0.08, 0.6); g.waist(-0.2, null); } },
  { name: 'pike', dur: 0.8, hold: 0.25, keep: [], set: (g, s) => { g.hands(s, 0, 0.5); g.kneel(s, 'l'); g.kneel(s, 'r'); g.waist(g.tun.pikeWaist); } },
  { name: 'tuck_l', dur: 0.45, hold: 0.05, keep: ['arms', 'legr'], set: (g, s) => { g.mark(s, 'l'); g.tuck(s, 'l'); g.waist(g.tun.plantWaist); } },
  { name: 'plant_l', dur: 0.4, hold: 0.3, keep: ['arms', 'legr'], set: (g, s) => { g.plant('l', s); g.waist(g.tun.plantWaist); } },
  { name: 'tuck_r', dur: 0.45, hold: 0.05, keep: ['arms', 'legl'], set: (g, s) => { g.mark(s, 'r'); g.tuck(s, 'r'); g.waist(g.tun.plantWaist); } },
  { name: 'plant_r', dur: 0.4, hold: 0.4, keep: ['arms', 'legl'], set: (g, s) => { g.plant('r', s); g.waist(g.tun.plantWaist); } },
  // Hands still down: the hips sink back until the COM is over the feet, so letting go of the
  // canvas leaves a body balanced on its soles. A body that cannot get there (the feet landed
  // too far behind, or it pitched forward over its hands) steps its feet in again first: rising
  // from there only falls, and a fall costs far more of the count than two more steps.
  { name: 'sit', dur: 1, hold: 1, keep: [], restep: true, set: (g, s) => g.sitBack(s), until: (g, s) => (g.tun.strictRise ? g.readyToRise(s) : g.overFeet(s)) },
];

/** The feet step in again, the rear one first, under where the COM is now, then sit back. */
function restep(first: Side): Phase[] {
  const second: Side = first === 'l' ? 'r' : 'l';
  const leg = (side: Side): Group => (side === 'l' ? 'legl' : 'legr');
  const step = (side: Side, other: Side): Phase[] => [
    { name: `tuck_${side}`, dur: 0.4, hold: 0.05, keep: ['arms', leg(other)], set: (g, s) => { g.mark(s, side); g.tuck(s, side); g.waist(g.tun.plantWaist); } },
    { name: `plant_${side}`, dur: 0.35, hold: 0.25, keep: ['arms', leg(other)], set: (g, s) => { g.plant(side, s); g.waist(g.tun.plantWaist); } },
  ];
  return [...step(first, second), ...step(second, first), { name: 'sit', dur: 1, hold: 1, keep: [], set: (g, s) => g.sitBack(s), until: (g, s) => g.readyToRise(s) }];
}
const RESTEP: Record<Side, Phase[]> = { l: restep('l'), r: restep('r') };
const MAX_RESTEPS = 1;
const RISE_MIN_UPRIGHT = -0.6; // torso up-axis z: a body hanging head-down off its hands cannot rise
const SIT_UPRIGHT = -0.3; // sitting back, the chest comes up at least to this torso up-axis z
const RISE_FOOT_FLAT = 0.9; // sole up-axis z
const RISE_FOOT_HEIGHT_M = 0.03;

/** Face up or on a side: roll onto the front, over the lower side (keys in roll-keys.ts). */
function rollPhases(keys: readonly RollKey[]): Phase[] {
  return keys.map((k, i) => ({
    name: 'roll' as const, dur: k.dur, hold: k.hold, keep: [],
    set: (g: GetUp) => g.rollPose(i),
    until: i === keys.length - 1 ? (_g: GetUp, s: Sense) => torsoFwdZ(s) < PRONE_FWD_Z : undefined,
  }));
}
const MIRRORED = new Set(['hip_roll', 'hip_yaw', 'shoulder_roll', 'shoulder_yaw', 'ankle_roll', 'waist_yaw']);

/**
 * The fall detector and scripted get-up for one robot. While `active`, it owns the joint targets.
 */
export class GetUp {
  phase: GetUpPhase = 'up';
  attempts = 0;
  /** Mocap get-ups (mocap/getup.ts), tried first once the body lies still; null: scripted only. */
  clip: ClipGetUp | null = null;
  private below = 0;
  private still = 0;
  private t = 0;
  private total = 0;
  private seq: Phase[] = PRONE;
  private index = 0;
  private frame: Frame | null = null;
  private readonly comAt: Record<Side, [number, number] | null> = { l: null, r: null };
  private fists: Record<Side, Vec3> = { l: [0, 0, 0], r: [0, 0, 0] };
  private readonly start: Float64Array;
  private readonly qik: Float64Array;
  private readonly cmd: BodyCommand = newBodyCommand();
  private readonly group: (Group | 'body')[];
  private readonly roll: Phase[];
  private waistPitch = 0;
  private waistYaw = 0;
  private rollSide: Side = 'r';
  private resteps = 0;
  private sit: { pelvis: Vec3; rot: Mat3; torsoRot: Mat3; torsoPos: Vec3; hands: Record<Side, Vec3>; shift: Vec3 } | null = null;

  constructor(
    private readonly geo: HumanoidGeometry,
    private readonly jm: JointMap,
    private readonly stance: StanceParams,
    private readonly brace: Float64Array,
    readonly tun: GetUpTuning,
    private readonly rollKeys: readonly RollKey[],
  ) {
    this.roll = rollPhases(rollKeys);
    const n = brace.length;
    this.start = new Float64Array(n);
    this.qik = new Float64Array(n);
    this.group = new Array<Group | 'body'>(n).fill('body');
    for (const side of SIDES) {
      const a = jm.arm[side], l = jm.leg[side];
      for (const i of [a.pitch, a.roll, a.yaw, a.elbow]) this.group[i] = 'arms';
      for (const i of [l.hipYaw, l.hipRoll, l.hipPitch, l.knee, l.anklePitch, l.ankleRoll]) this.group[i] = side === 'l' ? 'legl' : 'legr';
    }
  }

  get active(): boolean {
    return this.phase !== 'up';
  }

  /**
   * Watches for a fall while standing; true on the tick the robot goes down. `rising`: still
   * coming up out of the get-up crouch, which is low and folded by design.
   */
  detect(s: Sense, dt: number, rising = false): boolean {
    const H = this.stance.pelvisHeight;
    const low = rising ? s.pelvisPos[2] < RISING_DOWN_HEIGHT * H : s.upright < DOWN_UPRIGHT || s.pelvisPos[2] < DOWN_HEIGHT * H;
    this.below = low ? this.below + dt : 0;
    if (this.below < FALL_CONFIRM_S) return false;
    this.below = 0;
    this.attempts = 0;
    this.clip?.reset();
    this.enter('settle');
    return true;
  }

  /** What the body is doing, for telemetry: the clip's label while a mocap get-up plays. */
  get skillName(): string {
    return this.phase === 'clip' && this.clip ? `${this.clip.label}` : `getup_${this.phase}`;
  }

  /**
   * Advances the get-up and writes joint targets into `q` (`qNow`: measured angles). Returns
   * true on the tick both feet are planted under the body: time for balance to stand it up.
   */
  /** `fists`: where the fists are now (world): the hands stay put while the body sits back. */
  update(ctx: SimContext, s: Sense, qNow: Float64Array, q: Float64Array, dt: number, fists: Record<Side, Vec3>): boolean {
    void ctx;
    this.fists = fists;
    this.t += dt;
    this.total += dt;
    if (this.phase === 'settle') {
      // Fall stiff, like a plank in the fighting stance (a body that keeps its shape lands flat
      // on its front or back), then let the joints go compliant once it lies still.
      if (this.t < this.tun.brace) q.set(this.brace);
      else q.set(qNow);
      this.still = quiet(s) ? this.still + dt : 0;
      if ((this.t > this.tun.settleMin && this.still > STILL_S) || this.t > SETTLE_MAX_S) this.begin(s, qNow);
      return false;
    }
    if (this.phase === 'clip' && this.clip) {
      const res = this.clip.update(s, q, dt);
      if (res === 'up') {
        this.phase = 'up';
        return true;
      }
      if (res === 'fail') {
        this.clip.fail();
        this.enter('settle'); // lie still, then the next variant (or the scripted sequence)
      }
      return false;
    }
    if (this.total > MAX_ATTEMPT_S || (this.seq !== this.roll && this.seq !== LEGS_OUT && torsoFwdZ(s) > FLIPPED_FWD_Z)) {
      this.enter('settle'); // stalled, or rolled back over: lie still and start again
      return false;
    }
    const ph = this.seq[this.index];
    const [dur, hold] = this.timesOf(ph);
    ph.set(this, s);
    solveBody(this.cmd, this.geo, this.jm, this.qik, { pos: s.pelvisPos, rot: s.pelvisRot, shin: { l: s.feet.l.shinRot, r: s.feet.r.shinRot } });
    this.blend(ph, q, dur);
    if (ph.until && this.t >= dur && ph.until(this, s)) return this.seq === this.roll ? this.startSequence(this.tun.flatten ? LEGS_OUT : PRONE, q) : this.next(q);
    if (this.seq === LEGS_OUT && this.t >= ph.dur + ph.hold) return this.choose(s, q);
    if (this.t < dur + hold) return false;
    if (ph.restep && !this.tun.strictRise) return this.next(q);
    if (ph.restep && this.resteps < MAX_RESTEPS && s.upright > RISE_MIN_UPRIGHT) return this.restep(s, q);
    if (ph.until && !ph.lenient) {
      this.enter('settle'); // stuck: lie still, try again (the other way next time)
      return false;
    }
    return this.next(q);
  }

  /** Step both feet in again (the one farther behind the COM first) and sit back once more. */
  private restep(s: Sense, q: Float64Array): false {
    this.resteps++;
    this.sit = null;
    this.comAt.l = this.comAt.r = null;
    const f = this.frame ?? this.liveFrame(s);
    const behind = (side: Side) => (s.com[0] - s.feet[side].sole[0]) * f.fx + (s.com[1] - s.feet[side].sole[1]) * f.fy;
    return this.startSequence(RESTEP[behind('l') >= behind('r') ? 'l' : 'r'], q);
  }

  /** Phase duration and hold for this design. */
  private timesOf(ph: Phase): [number, number] {
    if (ph.name === 'sit') return [this.tun.sitDur, this.tun.sitHold];
    const k = this.seq === this.roll ? this.tun.rollSpeed : this.seq === LEGS_OUT ? 1 : this.tun.speed;
    return [ph.dur * k, ph.hold * k];
  }

  private blend(ph: Phase, q: Float64Array, dur: number): void {
    const k = minJerk(this.t / dur);
    for (let i = 0; i < q.length; i++) {
      const g = this.group[i];
      let target = this.qik[i];
      if (g === 'body') target = i === this.jm.waistPitch ? this.waistPitch : i === this.jm.waistYaw ? this.waistYaw : this.start[i];
      else if (ph.keep.includes(g)) target = this.start[i];
      q[i] = this.start[i] + (target - this.start[i]) * k;
    }
  }

  private next(q: Float64Array): boolean {
    if (this.index + 1 >= this.seq.length) {
      this.phase = 'up';
      return true;
    }
    this.index++;
    this.phase = this.seq[this.index].name;
    this.t = 0;
    this.start.set(q);
    return false;
  }

  private startSequence(seq: Phase[], from: Float64Array): false {
    this.seq = seq;
    this.index = 0;
    this.phase = seq[0].name;
    this.t = 0;
    this.start.set(from);
    return false;
  }

  /** Lying still: straighten out if folded, then push up from the front or roll onto it first. */
  private begin(s: Sense, qNow: Float64Array): void {
    this.attempts++;
    if (this.clip?.begin(s, qNow)) {
      this.enter('clip');
      return;
    }
    this.total = 0;
    this.resteps = 0;
    this.frame = null;
    this.sit = null;
    this.comAt.l = this.comAt.r = null;
    if (s.pelvisPos[2] > FOLDED_HEIGHT * this.stance.pelvisHeight) this.startSequence(LEGS_OUT, qNow);
    else this.choose(s, qNow);
  }

  private choose(s: Sense, q: Float64Array): false {
    if (torsoFwdZ(s) < PRONE_FWD_Z) return this.startSequence(PRONE, q);
    // Roll toward the lower side; alternate if the last roll that way got stuck.
    this.rollSide = s.torsoRot[7] > 0 ? 'r' : 'l';
    if (this.attempts % 2 === 0) this.rollSide = this.rollSide === 'l' ? 'r' : 'l';
    return this.startSequence(this.roll, q);
  }

  private enter(phase: GetUpPhase): void {
    this.phase = phase;
    this.t = 0;
    this.still = 0;
  }

  // ------------------------------------------------------------------ phase helpers

  /** Waist targets; a null yaw holds the twist the phase started with. */
  waist(pitch: number, yaw: number | null = 0): void {
    this.waistPitch = pitch;
    this.waistYaw = yaw ?? this.start[this.jm.waistYaw];
  }

  /**
   * Head and left directions of the body on the canvas, as it lies now. The body's left axis
   * stays level whether it lies flat, pikes or kneels, so the head direction is taken square to
   * it, on the side the head lies (or the chest faces, if upright).
   */
  private liveFrame(s: Sense): Frame {
    const T = s.torsoRot;
    const ln = Math.hypot(T[1], T[4]) || 1;
    const lx = T[1] / ln, ly = T[4] / ln;
    const lying = Math.hypot(T[2], T[5]) > 0.3;
    const sg = (lying ? ly * T[2] - lx * T[5] : ly * T[0] - lx * T[3]) >= 0 ? 1 : -1;
    return { fx: sg * ly, fy: -sg * lx, lx, ly };
  }

  /** Before a foot steps in: note where the body's COM is (the foot is placed relative to it). */
  mark(s: Sense, side: Side): void {
    this.frame ??= this.liveFrame(s);
    this.comAt[side] ??= [s.com[0], s.com[1]];
  }

  private hip(s: Sense, side: Side): Vec3 {
    const h = mulMV(s.pelvisRot, this.geo.legs[side].hip);
    return [s.pelvisPos[0] + h[0], s.pelvisPos[1] + h[1], s.pelvisPos[2] + h[2]];
  }

  /** Both fists on the canvas beside the shoulders, pushed `press` × reach into it (straightening the arms). */
  hands(s: Sense, fwd: number, press: number): void {
    const f = this.liveFrame(s);
    for (const side of SIDES) {
      const arm = this.geo.arms[side];
      const R = arm.upper + arm.fore;
      const sh = mulMV(s.torsoRot, arm.shoulder);
      const sg = side === 'l' ? 1 : -1;
      const w: Vec3 = [
        s.torsoPos[0] + sh[0] + f.fx * fwd * R + f.lx * sg * this.tun.handOut * R,
        s.torsoPos[1] + sh[1] + f.fy * fwd * R + f.ly * sg * this.tun.handOut * R,
        arm.fistHalf - press * R,
      ];
      const c = this.cmd.arms[side];
      c.mode = 'fist';
      c.fist = mulMtV(s.torsoRot, sub(w, s.torsoPos));
      // Elbows point back toward the feet and out, like a push-up.
      c.pole = mulMtV(s.torsoRot, [-f.fx * 0.6 + f.lx * sg * 0.5, -f.fy * 0.6 + f.ly * sg * 0.5, 0.6]);
    }
  }

  /** Pike: each ankle pulled toward a point behind its hip, knee down, toes pointed: the hips rise. */
  kneel(s: Sense, side: Side): void {
    const f = this.liveFrame(s);
    const h = this.hip(s, side);
    const L = this.geo.legLength;
    const leg = this.cmd.legs[side];
    leg.mode = 'point';
    leg.measured = true;
    leg.ankle = [h[0] - f.fx * this.tun.pikeBack * L, h[1] - f.fy * this.tun.pikeBack * L, this.geo.legs[side].soleDepth + 0.03];
    leg.kneePole = [0, 0, -1];
    leg.anklePitch = this.tun.kneelAnkle;
    leg.ankleRoll = 0;
  }

  /** Arms swept out wide along the canvas, elbows soft. */
  armsOut(): void {
    for (const side of SIDES) {
      const arm = this.cmd.arms[side];
      arm.mode = 'joints';
      arm.angles.pitch = -0.2;
      arm.angles.roll = (side === 'l' ? 1 : -1) * 1.2;
      arm.angles.yaw = 0;
      arm.angles.elbow = -0.4;
    }
  }

  /** Legs back in line behind the body. */
  legsStraight(): void {
    for (const side of SIDES) {
      const leg = this.cmd.legs[side];
      leg.mode = 'joints';
      leg.angles.hipYaw = 0;
      leg.angles.hipRoll = (side === 'l' ? 1 : -1) * 0.06;
      leg.angles.hipPitch = 0;
      leg.angles.knee = 0.1;
      leg.angles.anklePitch = 0.3;
      leg.angles.ankleRoll = 0;
    }
  }

  /** Swing the foot in under the hip, knee forward. */
  tuck(s: Sense, side: Side): void {
    const f = this.frame ?? this.liveFrame(s);
    const h = this.hip(s, side);
    const L = this.geo.legLength;
    const leg = this.cmd.legs[side];
    leg.mode = 'point';
    leg.measured = true;
    leg.ankle = [h[0] + f.fx * this.tun.tuckFwd * L, h[1] + f.fy * this.tun.tuckFwd * L, this.tun.tuckHeight * L];
    leg.kneePole = [f.fx, f.fy, 0];
    leg.anklePitch = this.tun.kneelAnkle;
    leg.ankleRoll = 0;
  }

  /** Put the sole down flat a little behind the body's COM, square to the frame. */
  plant(side: Side, s?: Sense): void {
    const f = this.frame;
    void s;
    const c = this.comAt[side];
    if (!f || !c) return;
    const g = this.geo.legs[side];
    const L = this.geo.legLength;
    const w = (side === 'l' ? 1 : -1) * this.tun.plantWidth * Math.abs(g.hip[1]);
    const sx = c[0] - f.fx * this.tun.plantBack * L + f.lx * w;
    const sy = c[1] - f.fy * this.tun.plantBack * L + f.ly * w;
    const yaw = Math.atan2(f.fy, f.fx);
    const leg = this.cmd.legs[side];
    leg.mode = 'foot';
    leg.measured = true;
    leg.ankleStiffness = PLANT_ANKLE_STIFFNESS;
    leg.ankle = [sx - Math.cos(yaw) * g.footCenterX, sy - Math.sin(yaw) * g.footCenterX, g.soleDepth];
    leg.footRot = rotZ(yaw);
  }

  /**
   * Both feet flat under the body, hands on the canvas ahead: the pelvis (and the torso with it)
   * is taken back and down until the COM sits over the soles. Legs and arms are solved from that
   * commanded pose, so both push the body there while hands and feet stay where they are.
   */
  sitBack(s: Sense): void {
    const f = this.frame ?? this.liveFrame(s);
    if (!this.sit) {
      const c = soleCentre(s);
      const back = Math.max(0, (s.com[0] - c[0]) * f.fx + (s.com[1] - c[1]) * f.fy) * this.tun.sitBack;
      // Raise the chest: turn the whole upper body about the body's left axis (negative = head up),
      // at least far enough that the torso no longer hangs head-down off the hands.
      const lift = this.tun.strictRise ? Math.asin(clamp(SIT_UPRIGHT, -1, 1)) - Math.asin(clamp(s.upright, -1, 1)) : 0;
      const up = axisAngle([f.lx, f.ly, 0], -Math.max(this.tun.sitPitch, lift));
      const rot = mulMM(up, s.pelvisRot);
      const pelvis: Vec3 = [s.pelvisPos[0] - f.fx * back, s.pelvisPos[1] - f.fy * back, s.pelvisPos[2] * (1 - this.tun.sitDrop)];
      const rel = mulMtV(s.pelvisRot, sub(s.torsoPos, s.pelvisPos));
      const relRot = mulMtM(s.pelvisRot, s.torsoRot);
      const tp = mulMV(rot, rel);
      this.sit = {
        pelvis,
        rot,
        torsoRot: mulMM(rot, relRot),
        torsoPos: [pelvis[0] + tp[0], pelvis[1] + tp[1], pelvis[2] + tp[2]],
        hands: { l: [...this.fists.l] as Vec3, r: [...this.fists.r] as Vec3 },
        shift: [0, 0, 0],
      };
    }
    const sit = this.sit;
    this.cmd.pelvisPos = sit.pelvis;
    this.cmd.pelvisRot = sit.rot;
    const torsoPos = sit.torsoPos;
    for (const side of SIDES) {
      this.plant(side);
      this.cmd.legs[side].measured = false;
      const sg = side === 'l' ? 1 : -1;
      const arm = this.cmd.arms[side];
      arm.mode = 'fist';
      arm.fist = mulMtV(sit.torsoRot, sub(sit.hands[side], torsoPos));
      arm.pole = mulMtV(sit.torsoRot, [-f.fx * 0.6 + f.lx * sg * 0.5, -f.fy * 0.6 + f.ly * sg * 0.5, 0.6]);
    }
    this.waist(this.start[this.jm.waistPitch], null);
  }

  /**
   * Time to let go of the canvas: the COM is over flat soles and heading nowhere, and the torso
   * is not hanging head-down off the hands (the rise could not unfold it in balance).
   */
  readyToRise(s: Sense): boolean {
    for (const side of SIDES) {
      const f = s.feet[side];
      if (f.flat < RISE_FOOT_FLAT || f.height > RISE_FOOT_HEIGHT_M) return false;
    }
    return s.upright > RISE_MIN_UPRIGHT && this.overFeet(s);
  }

  /** The COM, and where it is heading (the capture point), are inside the soles with a margin. */
  overFeet(s: Sense): boolean {
    const soles = convexHull([...footCorners(this.geo, 'l', solePlace(s, 'l')), ...footCorners(this.geo, 'r', solePlace(s, 'r'))]);
    const inside = (p: P2) => polygonDistance(soles, p).d <= -SIT_MARGIN_M;
    return inside([s.com[0], s.com[1]]) && inside([s.capture[0], s.capture[1]]);
  }

  /** Joint targets for roll key `i` (accumulated over the earlier keys), mirrored for a roll to the left. */
  rollPose(i: number): void {
    const pose: Record<string, number> = {};
    for (let k = 0; k <= i; k++) Object.assign(pose, this.rollKeys[k].pose);
    const mirror = this.rollSide === 'l';
    const get = (name: string, fallback: number): number => {
      if (!mirror) return (pose[name] ?? fallback) * DEG;
      const base = name.replace(/_(l|r)$/, '');
      const swapped = name.endsWith('_l') ? `${base}_r` : name.endsWith('_r') ? `${base}_l` : name;
      const v = pose[swapped];
      return v === undefined ? fallback * DEG : (MIRRORED.has(base) ? -v : v) * DEG;
    };
    for (const side of SIDES) {
      const leg = this.cmd.legs[side];
      leg.mode = 'joints';
      leg.angles.hipYaw = get(`hip_yaw_${side}`, 0);
      leg.angles.hipRoll = get(`hip_roll_${side}`, 0);
      leg.angles.hipPitch = get(`hip_pitch_${side}`, 0);
      leg.angles.knee = get(`knee_${side}`, 10);
      leg.angles.anklePitch = get(`ankle_pitch_${side}`, 20);
      leg.angles.ankleRoll = 0;
      const arm = this.cmd.arms[side];
      arm.mode = 'joints';
      arm.angles.pitch = get(`shoulder_pitch_${side}`, -30);
      arm.angles.roll = get(`shoulder_roll_${side}`, 0);
      arm.angles.yaw = get(`shoulder_yaw_${side}`, 0);
      arm.angles.elbow = get(`elbow_${side}`, -30);
    }
    this.waistPitch = get('waist_pitch', 0);
    this.waistYaw = get('waist_yaw', 0);
  }
}

/** Rotation by `a` about the unit axis `k` (Rodrigues). */
function axisAngle(k: Vec3, a: number): Mat3 {
  const c = Math.cos(a), sn = Math.sin(a), v = 1 - c;
  const [x, y, z] = k;
  return [
    c + x * x * v, x * y * v - z * sn, x * z * v + y * sn,
    y * x * v + z * sn, c + y * y * v, y * z * v - x * sn,
    z * x * v - y * sn, z * y * v + x * sn, c + z * z * v,
  ];
}

function solePlace(s: Sense, side: Side): FootPlace {
  const f = s.feet[side];
  return { x: f.sole[0], y: f.sole[1], yaw: f.yaw };
}

function soleCentre(s: Sense): [number, number] {
  return [(s.feet.l.sole[0] + s.feet.r.sole[0]) / 2, (s.feet.l.sole[1] + s.feet.r.sole[1]) / 2];
}

/** z of the torso's forward axis: −1 lying face down, +1 face up. */
function torsoFwdZ(s: Sense): number {
  return s.torsoRot[6];
}

function quiet(s: Sense): boolean {
  return Math.hypot(s.comVel[0], s.comVel[1], s.comVel[2]) < STILL_SPEED && Math.hypot(...s.torsoOmega) < STILL_SPIN;
}
