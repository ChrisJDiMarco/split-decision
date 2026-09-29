// Plays a replay snapshot: lead in at half speed, then the highlight at 0.25×.
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import { eventsBetween, findHighlight, frameIndexAt, samplePoses, type Highlight, type ReplayFrame } from './replay-buffer';

export const REPLAY = {
  LEAD_S: 3.0, // sim seconds shown before the highlight
  TAIL_S: 1.6, // after it
  SLOW_BEFORE_S: 0.8, // switch to slow motion this long before the highlight
  LEAD_SPEED: 0.5,
  SLOW_SPEED: 0.25,
  RAMP_PER_S: 4, // speed easing rate
  NO_HIGHLIGHT_S: 4, // with nothing notable, replay this much of the tail
} as const;

export interface ReplayTick {
  events: SimEvent[]; // events the playhead crossed this tick
  speed: number;
  done: boolean;
}

export class ReplayPlayer {
  readonly start: number;
  readonly end: number;
  readonly slowFrom: number;
  readonly highlight: Highlight | null;
  t: number;
  speed: number = REPLAY.LEAD_SPEED;
  private pose: Float32Array | undefined;

  constructor(private frames: readonly ReplayFrame[], highlight?: Highlight | null) {
    if (frames.length < 2) throw new Error('replay needs at least two frames');
    const first = frames[0].time;
    const last = frames[frames.length - 1].time;
    this.highlight = highlight === undefined ? findHighlight(frames) : highlight;
    if (this.highlight) {
      this.start = Math.max(first, this.highlight.time - REPLAY.LEAD_S);
      this.end = Math.min(last, this.highlight.time + REPLAY.TAIL_S);
      this.slowFrom = Math.max(this.start, this.highlight.time - REPLAY.SLOW_BEFORE_S);
    } else {
      this.start = Math.max(first, last - REPLAY.NO_HIGHLIGHT_S);
      this.end = last;
      this.slowFrom = this.start;
    }
    this.t = this.start;
    if (this.t >= this.slowFrom) this.speed = REPLAY.SLOW_SPEED;
  }

  get duration(): number {
    return this.end - this.start;
  }

  get progress(): number {
    return this.duration > 0 ? (this.t - this.start) / this.duration : 1;
  }

  update(dtWall: number): ReplayTick {
    const target = this.t >= this.slowFrom ? REPLAY.SLOW_SPEED : REPLAY.LEAD_SPEED;
    this.speed += (target - this.speed) * Math.min(1, dtWall * REPLAY.RAMP_PER_S);
    const t0 = this.t;
    this.t = Math.min(this.end, this.t + dtWall * this.speed);
    return { events: eventsBetween(this.frames, t0, this.t), speed: this.speed, done: this.t >= this.end };
  }

  poses(): Float32Array {
    this.pose = samplePoses(this.frames, this.t, this.pose);
    return this.pose;
  }

  telemetry(): [RobotTelemetry, RobotTelemetry] {
    return this.frames[frameIndexAt(this.frames, this.t)].telemetry;
  }
}
