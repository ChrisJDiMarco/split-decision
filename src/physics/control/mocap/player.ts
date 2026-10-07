// MotionPlayer: plays one library move at control rate.
//   time warp   the clip clock advances at min(wanted speed, what the joints allow at this
//               frame) × the caller's pace, so the quick parts play as fast as the motors can
//               swing them and the slow parts (a weight shift, a set-up) can play faster than the
//               human source did
//   mirror      southpaw: the orthodox clip reflected through the library's joint mirror map
//   output      joint targets and their wall-time velocities in r.joints order, the pelvis
//               reference in the move frame, the contact flags and the phase
// No allocation per update.
import { newSample, sample, type MotionSample, type Move } from '../../../robots/motions';
import type { JointMask, MocapSet } from './library';

const MIN_RATE = 0.05;

export interface PlayOptions {
  mirror?: boolean;
  /** Wanted time scale (× the human source); the per-frame joint limit caps it. */
  speed?: number;
  /** Joints whose speed limits the playback (a punch is not slowed by the feet's bounce). */
  mask?: JointMask;
  /** Start this far into the clip (s at 1×). */
  from?: number;
  /** Scale on the per-frame joint-speed limit (< 1 for heavy limbs that cannot accelerate to it). */
  limitScale?: number;
  /**
   * Per-frame rate limits to use instead of the library's speed-only table (mocap/centroid.ts: what
   * the robot's motors allow on their torque-speed lines, and the balance warp). Read during the play.
   */
  rates?: Float32Array;
}

export class MotionPlayer {
  move: Move | null = null;
  mirror = false;
  /** Clip time, seconds at 1×. */
  tau = 0;
  /** Clip seconds per wall second at the last step. */
  rate = 0;
  speed = 1;
  limitScale = 1;
  readonly s: MotionSample;
  /** Joint targets and wall-time velocities, r.joints order (joints the clip lacks keep 0). */
  readonly q: Float64Array;
  readonly qd: Float64Array;
  private table: Float32Array | null = null;

  constructor(readonly set: MocapSet, joints: number) {
    this.s = newSample(set.lib.joints.length);
    this.q = new Float64Array(joints);
    this.qd = new Float64Array(joints);
  }

  get active(): boolean {
    return this.move !== null;
  }

  get done(): boolean {
    return !this.move || (!this.move.loop && this.tau >= this.move.duration);
  }

  play(move: Move, opts: PlayOptions = {}): void {
    this.move = move;
    this.mirror = !!opts.mirror;
    this.speed = opts.speed ?? 1;
    this.limitScale = opts.limitScale ?? 1;
    this.table = opts.rates ?? this.set.rates(move, opts.mask ?? 'all');
    this.tau = Math.max(0, Math.min(move.duration, opts.from ?? 0));
    this.rate = 0;
    this.evaluate();
  }

  stop(): void {
    this.move = null;
  }

  /** The fastest time scale the joints allow at clip time `tau`. */
  limitAt(tau: number): number {
    const m = this.move, t = this.table;
    if (!m || !t) return 1;
    const f = Math.min(t.length - 1, Math.max(0, Math.round((m.loop ? tau % m.duration : tau) * m.fps)));
    return t[f] * this.limitScale;
  }

  /** Advance the clip clock by `dt` wall seconds at `pace` (0 holds the pose) and sample it. */
  step(dt: number, pace = 1): void {
    const m = this.move;
    if (!m) return;
    this.rate = Math.max(MIN_RATE, Math.min(this.speed, this.limitAt(this.tau))) * Math.max(0, pace);
    this.tau += dt * this.rate;
    if (!m.loop && this.tau > m.duration) this.tau = m.duration;
    this.evaluate();
  }

  /** Jump to clip time `tau` (no playback rate: velocities are for pace 1). */
  seek(tau: number): void {
    if (!this.move) return;
    this.tau = this.move.loop ? tau : Math.max(0, Math.min(this.move.duration, tau));
    this.evaluate();
  }

  private evaluate(): void {
    const m = this.move!;
    sample(m, this.tau, { speed: 1, mirror: this.mirror, loop: m.loop }, this.s);
    const map = this.set.toRobot;
    const k = this.rate;
    for (let j = 0; j < map.length; j++) {
      const i = map[j];
      if (i < 0) continue;
      this.q[i] = this.s.q[j];
      this.qd[i] = this.s.qd[j] * k;
    }
  }

  /** Clip time (s at 1×) a wall duration from now covers at the current rate (for planning). */
  wallToClip(wall: number): number {
    return wall * Math.max(MIN_RATE, this.rate || Math.min(this.speed, this.limitAt(this.tau)));
  }
}
