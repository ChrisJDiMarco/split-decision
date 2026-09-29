// Footwork played from the motion library: shuffles and walks cover ground (approach, retreat,
// circling) in the rhythm the CMU boxers used, with balance underneath.
//   steps      each clip is read as a list of foot swings (a foot's contact dropping and coming
//              back); a swing lifts when the clip lifts it (the clip waits for a foot still in
//              the air) and lands where the clip puts it relative to the stance foot, turned to
//              face the opponent and steered toward the goal
//   COM        the clip's pelvis path is the COM reference (the gait's `external` plan), anchored
//              to where the body really is at every lift-off, so balance tracks the clip's pace
//              and never a position the robot is not at; the ankles, the gyro and the swing
//              re-aiming (stepping.ts) absorb the rest
//   style      the arms, waist and neck follow the clip's guard; the pelvis bobs with it
//   chaining   one-shot shuffles chain while the goal is still far; walks loop
// The fine stance planner (stepping.ts) squares the feet up once the goal is close.
import type { Vec3 } from '../../../core/types';
import type { Move, MoveLabel } from '../../../robots/motions';
import { matFromQuat } from '../../../robots/motions/math';
import type { Gait, StanceFrame } from '../gait';
import { other } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import { armIK, legFK, newArmAngles, newLegAngles, type ArmAngles } from '../ik';
import { clamp, mulMV, rot2, wrapAngle } from '../math';
import type { BodyCommand, JointMap } from '../posture';
import type { Sense } from '../sense';
import type { SkillPose } from '../skills/types';
import type { StanceParams } from '../stance';
import type { FootPlace } from '../support';
import type { MocapSet } from './library';
import { MotionPlayer } from './player';

export type FootworkDir = 'forward' | 'back' | 'left' | 'right';

const LABELS: Record<FootworkDir, MoveLabel[]> = {
  forward: ['shuffle_forward', 'walk_forward'],
  back: ['shuffle_back', 'walk_back'],
  left: ['shuffle_left'],
  right: ['shuffle_right'],
};

const MIN_SWING_S = 0.1; // clip seconds: shorter contact gaps are flicker
const WALK_WIDTH = 1.9; // × hip offset: sole centres apart across a walk
const LAT_CAPTURE = 0.35; // × that width: a landing sole's centre this far outside the capture point
/** Footwork tuning (exported so tools can sweep it; the worker never changes it). */
export const FOOTWORK = {
  startM: 0.45, // goal this far from the stance frame: cover the ground with clip footwork
  stopM: 0.28, // ...no new swing once it is this close (the stance planner finishes)
  walkFromM: 1.3, // further than this, walk rather than shuffle
  speed: 1.4, // wanted time scale at aggression 1 (motors cap it per frame)
  maxHoldS: 0.6, // a step that cannot start (a foot still down) this long ends the footwork
  maxSteerM: 0.12, // landing moved at most this far toward the goal (steering)
  liftMinM: 0.035, 
  liftMaxM: 0.1, 
  style: 0.65, // share of the clip's guard in the arms while moving (the rest: our guard)
  bobMaxM: 0.035, 
  maxStepSep: 0.62, // × leg length, swing sole from the stance sole
  // The COM reference may speed up or slow down no faster than the soles can push it: a ≈ ω²·(COP
  // offset), about 1.5 m/s² for a sole's half-length, a little more with the gyro core helping.
  maxAccel: 1.6, // m/s²
  maxSpeed: 0.72, // m/s: the reference never runs faster than this
  swingMinS: 0.22, // a swing takes at least this...
  swingMaxS: 0.4, // ...and at most this (a quicker cadence than the actors' walks: a heavy swing
  // leg must get ahead of a body that keeps falling forward over the stance foot)
  hurryOutM: 0.04, // capture point this far past the feet in double support: step now
  walkToeOut: 0.08, // rad
  minStepScale: 0.45, // a step starting from rest is this share of the clip's
  enabled: 0, // 1: clip footwork covers ground (0: the stance planner, stepping.ts, does)
  maxAhead: 0.45, // × leg length: a landing at most this far along the travel past the stance sole
  maxTravel: 0.55, // × leg length: a swing moves its foot at most this far
  allowWalk: 1, // 0: shuffles only (the feet never pass)
  swayLead: 0.12, // clip s before a swing's lift-off that the weight starts over
  slotPlace: 1, // shuffles land in the stance slots around the travelling COM (0: the clip's steps)
  slotLead: 0.1, // s of COM travel past touchdown the stance frame is centred on
  posHold: 0.05, // m: the reference's position leash on the body
  sway: 0.7, // how far toward the stance sole the COM reference sways (0 midline .. 1 over the sole)
  swayGain: 6, // 1/s: sway speed per metre left to go
  maxSwaySpeed: 0.6, // m/s
};


interface ClipSwing {
  side: Side; // as played
  lift: number; // clip s
  land: number;
  apex: number; // m above the canvas
  delta: Vec3; // landing sole − stance sole at touchdown, move frame
}

const swingsCache = new WeakMap<Move, { normal?: ClipSwing[]; mirror?: ClipSwing[] }>();

export class ClipFootwork {
  active = false;
  dir: FootworkDir = 'forward';
  /** Feet passing each other (a walk), not a stance-keeping shuffle. */
  walking = false;
  /** Why the last footwork ended (diagnostics). */
  reason = '';
  /** The last swing started (diagnostics). */
  lastSwing = '';
  private move: Move | null = null;

  private swings: ClipSwing[] = [];
  private next = 0; // index of the next swing to start
  private cycle = 0; // clip time added to the swings of a looping clip (walks) per lap
  private yaw = 0; // move frame heading (toward the opponent)
  private held = 0;
  private stopping = false;
  private z0 = 0;
  /** The foot the COM reference sways over (a pending or running swing's stance foot). */
  private sway: Side | null = null;
  /** The COM reference: position and velocity, integrated with the acceleration limit. */
  private refPos: [number, number] = [0, 0];
  private refVel: [number, number] = [0, 0];
  private refAcc: [number, number] = [0, 0];
  private readonly player: MotionPlayer;
  private readonly guard: Record<Side, ArmAngles>;
  private readonly armTmp = newArmAngles();
  private lastSteps = 0;

  constructor(private readonly set: MocapSet, joints: number, private readonly geo: HumanoidGeometry, private readonly jm: JointMap, private readonly stance: StanceParams) {
    this.player = new MotionPlayer(set, joints);
    this.guard = { l: newArmAngles(), r: newArmAngles() };
    for (const side of ['l', 'r'] as const) armIK(geo.arms[side], stance.guard[side].fist, stance.guard[side].pole, this.guard[side]);
  }

  /** Should the stance frame `goal` be reached with clip footwork (far enough off)? */
  wants(gait: Gait, goal: StanceFrame | null): boolean {
    if (!FOOTWORK.enabled || !goal || !gait.bothPlanted()) return false;
    const cur = gait.currentFrame();
    return Math.hypot(goal.x - cur.x, goal.y - cur.y) > FOOTWORK.startM;
  }

  /** Stop at once: the current swing lands under the gait, the gait plans the COM again. */
  cancel(gait: Gait, why = 'cancelled'): void {
    if (!this.active) return;
    this.active = false;
    this.reason = why;
    this.move = null;
    this.player.stop();
    gait.external = null;
  }

  /**
   * One control update toward `goal`, facing `bearing`. Returns true while the footwork owns the
   * feet (the stance planner then stays out).
   */
  update(s: Sense, gait: Gait, goal: StanceFrame | null, bearing: number, aggression: number, dt: number): boolean {
    if (gait.airborne()) {
      this.cancel(gait, 'airborne');
      return false;
    }
    const cur = gait.bothPlanted() ? gait.currentFrame() : null;
    const dist = goal && cur ? Math.hypot(goal.x - cur.x, goal.y - cur.y) : Infinity;
    if (!this.active) {
      if (!goal || !cur || dist <= FOOTWORK.startM || gait.phase !== 'double') return false;
      if (!this.begin(s, gait, goal, bearing, aggression)) return false;
    }
    if (!goal || dist < FOOTWORK.stopM) this.stopping = true;
    // Finished: the last swing is down (or none started) and there is nothing more to do.
    if (this.stopping && gait.phase === 'double') {
      this.cancel(gait, 'arrived');
      return false;
    }
    const p = this.player;
    // Start the clip's next swing when its clip time comes (the clip waits for the gait).
    let pace = 1;
    const sw = this.swings[this.next];
    // The body is already falling past the feet: the clip's next swing goes now, not on schedule.
    const hurry = gait.phase === 'double' && gait.supportDistance([s.capture[0], s.capture[1]]) > FOOTWORK.hurryOutM;
    this.sway = null;
    if (sw && !this.stopping && (p.tau >= sw.lift + this.cycle || hurry)) {
      if (hurry && p.tau < sw.lift + this.cycle) p.seek(sw.lift + this.cycle);
      const plan = gait.phase === 'double' && gait.bothPlanted() ? this.planSwing(s, gait, sw, goal, bearing) : null;
      // The foot goes only if the step catches the body; until then the weight shifts over the
      // foot that stays (the reference sways toward it) and the clip waits.
      if (plan && !gait.captures(sw.side, plan.target, plan.dur, s)) this.sway = other(sw.side);
      if (plan && !this.sway) {
        this.startSwing(gait, sw, plan);
        this.next++;
        if (this.next >= this.swings.length && this.move?.loop) {
          this.next = 0;
          this.cycle += this.move.duration;
        }
        this.held = 0;
      } else {
        pace = 0;
        this.held += dt;
        if (this.held > FOOTWORK.maxHoldS) {
          this.cancel(gait, 'step never freed');
          return false;
        }
      }
    }
    // Shortly before a swing the weight starts over to the foot that will stay; on one foot it
    // stays over it until the swing lands.
    if (!this.sway && sw && !this.stopping && gait.phase === 'double' && p.tau >= sw.lift + this.cycle - FOOTWORK.swayLead) this.sway = other(sw.side);
    if (gait.phase === 'single' && gait.swingSide) this.sway = other(gait.swingSide);
    // Re-anchor at every touchdown: the reference restarts from where the body is.
    if (gait.stepsTaken !== this.lastSteps) {
      this.lastSteps = gait.stepsTaken;
      this.anchor(s);
    }
    p.step(dt, pace);
    if (p.done) {
      // One-shot clip over: chain another while the goal is still far, else stop after landing.
      if (this.stopping || !goal || dist < FOOTWORK.stopM * 2) this.stopping = true;
      else if (gait.phase === 'double') this.begin(s, gait, goal, bearing, aggression);
    }
    this.reference(s, gait, dt);
    return true;
  }

  /** Arms, waist, neck and pelvis bob from the clip (call after the skills, only with none running). */
  style(pose: SkillPose, cmd: BodyCommand): void {
    if (!this.active || !this.move) return;
    const q = this.player.q;
    for (const side of ['l', 'r'] as const) {
      const m = this.jm.arm[side];
      const g = this.guard[side];
      const a = this.armTmp;
      a.pitch = g.pitch + (q[m.pitch] - g.pitch) * FOOTWORK.style;
      a.roll = g.roll + (q[m.roll] - g.roll) * FOOTWORK.style;
      a.yaw = g.yaw + (q[m.yaw] - g.yaw) * FOOTWORK.style;
      a.elbow = g.elbow + (q[m.elbow] - g.elbow) * FOOTWORK.style;
      const arm = cmd.arms[side];
      arm.mode = 'joints';
      Object.assign(arm.angles, a);
    }
    pose.waistPitch += (q[this.jm.waistPitch] - pose.waistPitch) * FOOTWORK.style * 0.5;
    pose.pelvisDrop = clamp(this.z0 - this.player.s.rootPos[2], -FOOTWORK.bobMaxM, FOOTWORK.bobMaxM);
  }

  private begin(s: Sense, gait: Gait, goal: StanceFrame, bearing: number, aggression: number): boolean {
    const cur = gait.currentFrame();
    const [along, left] = rot2(goal.x - cur.x, goal.y - cur.y, -bearing);
    const dir: FootworkDir = Math.abs(along) >= Math.abs(left) ? (along >= 0 ? 'forward' : 'back') : left >= 0 ? 'left' : 'right';
    const far = FOOTWORK.allowWalk > 0 && Math.hypot(along, left) > FOOTWORK.walkFromM;
    const pick = this.pick(dir, far);
    if (!pick) return false;
    this.dir = dir;
    this.move = pick.move;
    this.walking = pick.move.label.startsWith('walk');

    this.swings = swingsOf(this.set, this.geo, pick.move, pick.mirror);
    if (!this.swings.length) return false;
    this.next = 0;
    this.cycle = 0;
    this.player.play(pick.move, { mirror: pick.mirror, speed: FOOTWORK.speed * (0.7 + 0.3 * aggression), mask: 'legs' });
    this.z0 = this.player.s.rootPos[2];
    this.yaw = bearing;
    this.active = true;
    this.stopping = false;
    this.held = 0;
    this.reason = '';
    this.lastSteps = gait.stepsTaken;
    if (!gait.external) this.refVel = [s.comVel[0], s.comVel[1]];
    this.anchor(s);
    return true;
  }

  /** The clip for a direction: travel best aligned with it; walks for long distances. */
  private pick(dir: FootworkDir, far: boolean): { move: Move; mirror: boolean } | null {
    const want: [number, number] = dir === 'forward' ? [1, 0] : dir === 'back' ? [-1, 0] : dir === 'left' ? [0, 1] : [0, -1];
    let best: { move: Move; mirror: boolean; score: number } | null = null;
    for (const label of LABELS[dir]) {
      const walk = label.startsWith('walk');
      if (walk && !far) continue;
      for (const move of this.set.byLabel.get(label) ?? []) {
        for (const mirror of [false, true]) {
          const tx = move.travel[0], ty = move.travel[1] * (mirror ? -1 : 1);
          const n = Math.hypot(tx, ty);
          if (n < 0.15) continue;
          const align = (tx * want[0] + ty * want[1]) / n;
          if (align < 0.6) continue;
          const score = align + (walk === far ? 0.5 : 0) + Math.min(0.5, n / move.duration) * 0.3 - (mirror ? 0.05 : 0);
          if (!best || score > best.score) best = { move, mirror, score };
        }
      }
    }
    return best;
  }

  private anchor(s: Sense): void {
    this.refPos = [s.com[0], s.com[1]];
  }

  /** Lift `sw.side` now: land where the clip puts it from the stance sole, steered to the goal. */
  private planSwing(s: Sense, gait: Gait, sw: ClipSwing, goal: StanceFrame | null, bearing: number): { target: FootPlace; dur: number } {
    void s;
    this.yaw = bearing;
    const stance = gait.feet[other(sw.side)].place;
    // A body still getting up to speed takes shorter steps than the clip's.
    const clipV = Math.hypot(this.player.s.rootVel[0], this.player.s.rootVel[1]) * Math.max(0.2, this.player.rate || this.player.speed);
    const scale = clipV > 0.1 ? clamp(Math.hypot(s.comVel[0], s.comVel[1]) / clipV, FOOTWORK.minStepScale, 1) : 1;
    // Place the landing in the facing frame (x toward the opponent, y left), relative to the COM:
    // along the line of travel as the clip steps, across it as this robot's hips need (the actors'
    // feet land close to the midline, where these thighs would collide), and outside where the
    // capture point will be (the lateral balance of every step).
    const [sx, sy] = rot2(stance.x - s.com[0], stance.y - s.com[1], -this.yaw);
    const cy = rot2(s.capture[0] - s.com[0], s.capture[1] - s.com[1], -this.yaw)[1];
    const sep = this.walking ? WALK_WIDTH * Math.abs(this.geo.legs.l.hip[1]) : 2 * Math.abs(this.stance.slots.l.y);
    // Along the line of travel: the clip's step, at most maxAhead × leg length past the stance sole.
    const reach = FOOTWORK.maxAhead * this.geo.legLength;
    let tx = clamp(sx + sw.delta[0] * scale, sx - reach, sx + reach);
    let ty = sy + sw.delta[1];
    if (sw.side === 'l') ty = Math.max(ty, sy + sep, cy + LAT_CAPTURE * sep);
    else ty = Math.min(ty, sy - sep, cy - LAT_CAPTURE * sep);
    const [dx, dy] = rot2(tx, ty, this.yaw);
    let x = s.com[0] + dx, y = s.com[1] + dy;
    const rate0 = Math.max(0.2, this.player.rate || this.player.speed);
    const dur0 = clamp((sw.land - sw.lift) / rate0, FOOTWORK.swingMinS, FOOTWORK.swingMaxS);
    if (FOOTWORK.slotPlace > 0 && !this.walking) {
      // Shuffling: the foot lands in its slot of the fighting stance, re-centred on where the COM
      // reference will be at touchdown (plus a lead), so the lead foot stays the lead and the
      // stance travels with the body.
      // Centred on where the body will really be (its own velocity), not the reference.
      const lead = FOOTWORK.slotLead;
      const fx = s.com[0] + s.comVel[0] * (dur0 + lead), fy = s.com[1] + s.comVel[1] * (dur0 + lead);
      const slot = gait.slot(sw.side, { x: fx, y: fy, heading: this.yaw });
      x = slot.x;
      y = slot.y;
    }
    if (goal) {
      // Steering: the landing slides a little toward where the goal wants this foot (along the
      // line of travel only; the width comes from the clip).
      const slot = gait.slot(sw.side, goal);
      const ux = Math.cos(this.yaw), uy = Math.sin(this.yaw);
      const e = clamp((slot.x - x) * ux + (slot.y - y) * uy, -FOOTWORK.maxSteerM, FOOTWORK.maxSteerM) * 0.5;
      x += ux * e;
      y += uy * e;
    }
    // Walking, the feet point along the walk (a turned-out rear foot, stood on, twists under the
    // swing); shuffling, they keep the fighting stance's angles.
    const yaw = wrapAngle(this.yaw + (this.walking ? (sw.side === 'l' ? FOOTWORK.walkToeOut : -FOOTWORK.walkToeOut) : this.stance.slots[sw.side].yaw));
    let target: FootPlace = gait.constrainTarget(sw.side, { x, y, yaw }, FOOTWORK.maxStepSep * this.geo.legLength);
    // A heavy leg flung far twists the whole body round the stance sole: cap the swing's travel.
    const from = gait.feet[sw.side].place;
    const travel = Math.hypot(target.x - from.x, target.y - from.y), maxTravel = FOOTWORK.maxTravel * this.geo.legLength;
    if (travel > maxTravel) {
      const k = maxTravel / travel;
      target = gait.constrainTarget(sw.side, { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, yaw }, FOOTWORK.maxStepSep * this.geo.legLength);
    }
    const rate = Math.max(0.2, this.player.rate || this.player.speed);
    const dur = clamp((sw.land - sw.lift) / rate, FOOTWORK.swingMinS, FOOTWORK.swingMaxS);
    return { target, dur };
  }

  private startSwing(gait: Gait, sw: ClipSwing, plan: { target: FootPlace; dur: number }): void {
    const from = gait.feet[sw.side].place;
    gait.driveStep(sw.side, plan.target, plan.dur, clamp(sw.apex, FOOTWORK.liftMinM, FOOTWORK.liftMaxM));
    this.lastSwing = `${sw.side} from ${from.x.toFixed(2)},${from.y.toFixed(2)} to ${plan.target.x.toFixed(2)},${plan.target.y.toFixed(2)} in ${plan.dur.toFixed(2)} s`;
    this.lastSteps = gait.stepsTaken;
  }

  /**
   * The COM reference: it follows the clip's pelvis velocity (turned to face the opponent) with the
   * acceleration the soles can deliver, integrated from where the body was at the last lift-off or
   * touchdown (so it never asks the robot to be somewhere it is not).
   */
  private reference(s: Sense, gait: Gait, dt: number): void {
    if (s.time < 0) return;
    const p = this.player;
    let [vx, vy] = this.stopping ? [0, 0] : rot2(p.s.rootVel[0] * p.rate, p.s.rootVel[1] * p.rate, this.yaw);
    // Sway: across the line of travel the reference moves over the foot that stays (lateral
    // weight transfer), as a spring-damper toward it; along it, it keeps the clip's pace.
    const vn = Math.hypot(vx, vy);
    const ux = vn > 0.05 ? vx / vn : Math.cos(this.yaw), uy = vn > 0.05 ? vy / vn : Math.sin(this.yaw);
    const nx = -uy, ny = ux;
    const place = this.sway ? gait.feet[this.sway].place : null;
    const mid: [number, number] = [(gait.feet.l.place.x + gait.feet.r.place.x) / 2, (gait.feet.l.place.y + gait.feet.r.place.y) / 2];
    const aim = place ? [mid[0] + (place.x - mid[0]) * FOOTWORK.sway, mid[1] + (place.y - mid[1]) * FOOTWORK.sway] : mid;
    const offN = (aim[0] - this.refPos[0]) * nx + (aim[1] - this.refPos[1]) * ny;
    const velN = this.refVel[0] * nx + this.refVel[1] * ny;
    const wantN = clamp(FOOTWORK.swayGain * offN, -FOOTWORK.maxSwaySpeed, FOOTWORK.maxSwaySpeed);
    const along = vx * ux + vy * uy;
    vx = ux * along + nx * wantN;
    vy = uy * along + ny * wantN;
    void velN;
    const v = Math.hypot(vx, vy);
    if (v > FOOTWORK.maxSpeed) {
      vx *= FOOTWORK.maxSpeed / v;
      vy *= FOOTWORK.maxSpeed / v;
    }
    const dv = FOOTWORK.maxAccel * dt;
    for (let i = 0; i < 2; i++) {
      const want = i === 0 ? vx : vy;
      const nv = this.refVel[i] + clamp(want - this.refVel[i], -dv, dv);
      this.refAcc[i] = (nv - this.refVel[i]) / Math.max(dt, 1e-3);
      this.refVel[i] = nv;
      this.refPos[i] += nv * dt;
    }
    const ext = gait.external ?? { pos: [0, 0] as [number, number], vel: [0, 0] as [number, number], acc: [0, 0] as [number, number] };
    // Velocity-led: the position term only holds the body within `posHold` of the integrated
    // reference (a walking body is a falling body; its position is the feet's business).
    const ex = clamp(s.com[0] - this.refPos[0], -FOOTWORK.posHold, FOOTWORK.posHold), ey = clamp(s.com[1] - this.refPos[1], -FOOTWORK.posHold, FOOTWORK.posHold);
    this.refPos[0] = s.com[0] - ex;
    this.refPos[1] = s.com[1] - ey;
    ext.pos = [this.refPos[0], this.refPos[1]];
    ext.vel = [this.refVel[0], this.refVel[1]];
    ext.acc = [this.refAcc[0], this.refAcc[1]];
    gait.external = ext;
  }
}

/**
 * The foot swings of a clip as played: a foot's contact off for at least MIN_SWING_S and back on,
 * with where it lands relative to the other sole (move frame) and how high it travels.
 */
function swingsOf(set: MocapSet, geo: HumanoidGeometry, move: Move, mirror: boolean): ClipSwing[] {
  const cache = swingsCache.get(move) ?? {};
  const key = mirror ? 'mirror' : 'normal';
  const hit = cache[key];
  if (hit) return hit;
  const out: ClipSwing[] = [];
  const p = new MotionPlayer(set, set.toLib.length);
  const bits = (f: number) => {
    const c = move.contacts[f];
    return mirror ? ((c & 1 ? 2 : 0) | (c & 2 ? 1 : 0)) : c & 3;
  };
  for (const side of ['l', 'r'] as const) {
    const bit = side === 'l' ? 1 : 2;
    let off = -1;
    for (let f = 1; f < move.frames; f++) {
      const on = (bits(f) & bit) !== 0, was = (bits(f - 1) & bit) !== 0;
      if (was && !on) off = f;
      if (!was && on && off >= 0) {
        const lift = off / move.fps, land = f / move.fps;
        if (land - lift >= MIN_SWING_S) {
          p.play(move, { mirror });
          let apex = 0;
          for (let k = off; k <= f; k += 3) {
            p.seek(k / move.fps);
            apex = Math.max(apex, soleWorld(p, geo, side)[2]);
          }
          p.seek(land);
          const a = soleWorld(p, geo, side), b = soleWorld(p, geo, other(side));
          out.push({ side, lift, land, apex, delta: [a[0] - b[0], a[1] - b[1], 0] });
        }
        off = -1;
      }
    }
  }
  out.sort((a, b) => a.lift - b.lift);
  cache[key] = out;
  swingsCache.set(move, cache);
  return out;
}

/** Sole centre of `side` in the move frame for the player's current sample. */
function soleWorld(p: MotionPlayer, geo: HumanoidGeometry, side: Side): Vec3 {
  const set = p.set;
  const leg = newLegAngles();
  const q = p.s.q;
  const lj = (name: string) => q[set.lib.joints.indexOf(`${name}_${side}`)];
  leg.hipYaw = lj('hip_yaw');
  leg.hipRoll = lj('hip_roll');
  leg.hipPitch = lj('hip_pitch');
  leg.knee = lj('knee');
  leg.anklePitch = lj('ankle_pitch');
  leg.ankleRoll = lj('ankle_roll');
  const g = geo.legs[side];
  const fk = legFK(g, leg);
  const sole = mulMV(fk.footRot, [g.footCenterX, 0, -g.soleDepth]);
  const local: Vec3 = [fk.ankle[0] + sole[0], fk.ankle[1] + sole[1], fk.ankle[2] + sole[2]];
  const R = matFromQuat(p.s.rootQuat);
  const w = mulMV(R as never, local);
  const r = p.s.rootPos;
  return [r[0] + w[0], r[1] + w[1], r[2] + w[2]];
}
