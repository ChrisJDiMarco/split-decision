// Ring buffer of the last few seconds of frames (poses, events, telemetry) on the main
// thread, with pose interpolation for smooth slow-motion playback.
import { KO_DOWN_S } from '../physics/damage/constants';
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner } from '../core/types';

export interface ReplayFrame {
  time: number; // sim seconds
  poses: Float32Array; // nbody * 7: x y z qw qx qy qz (physics frame, z-up)
  events: SimEvent[];
  telemetry: [RobotTelemetry, RobotTelemetry];
}

/**
 * A down-count KO fires KO_DOWN_S (20 s) after the knockdown and the replay starts after the KO hold,
 * so the window must reach back past both, plus the replay's lead-in, to still hold the blow.
 */
export const REPLAY_WINDOW_S = KO_DOWN_S + 8;
const DEFAULT_CAPACITY = Math.ceil(REPLAY_WINDOW_S * 60 * 1.15); // worker frames at 60/s, with headroom
/** A body that moved further than this between two frames teleported (debris un-parking). */
const TELEPORT_M = 1.0;

export class ReplayBuffer {
  private ring: Array<ReplayFrame | undefined>;
  private start = 0;
  private count = 0;

  constructor(readonly windowS = REPLAY_WINDOW_S, capacity = DEFAULT_CAPACITY) {
    this.ring = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.ring.fill(undefined);
    this.start = 0;
    this.count = 0;
  }

  at(i: number): ReplayFrame {
    if (i < 0 || i >= this.count) throw new RangeError(`replay index ${i} out of ${this.count}`);
    return this.ring[(this.start + i) % this.ring.length]!;
  }

  first(): ReplayFrame | null {
    return this.count ? this.at(0) : null;
  }

  last(): ReplayFrame | null {
    return this.count ? this.at(this.count - 1) : null;
  }

  /** Append a frame. Frames that don't advance time (paused sim) are ignored. */
  push(frame: ReplayFrame): boolean {
    const tail = this.last();
    if (tail && frame.time <= tail.time) return false;
    const cap = this.ring.length;
    if (this.count === cap) {
      this.start = (this.start + 1) % cap;
      this.count--;
    }
    this.ring[(this.start + this.count) % cap] = frame;
    this.count++;
    while (this.count > 1 && frame.time - this.at(0).time > this.windowS) {
      this.ring[this.start] = undefined;
      this.start = (this.start + 1) % cap;
      this.count--;
    }
    return true;
  }

  /** Immutable copy of the buffered frames, oldest first (what a replay plays from). */
  snapshot(): ReplayFrame[] {
    const out: ReplayFrame[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.at(i));
    return out;
  }
}

/** Index of the last frame with time <= t (clamped to [0, n-1]). */
export function frameIndexAt(frames: readonly ReplayFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0) return -1;
  if (t <= frames[0].time) return 0;
  if (t >= frames[hi].time) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Interpolated poses at sim time t, written into `out` (allocated when missing or wrong size). */
export function samplePoses(frames: readonly ReplayFrame[], t: number, out?: Float32Array): Float32Array {
  const i = frameIndexAt(frames, t);
  const a = frames[i];
  const b = frames[Math.min(i + 1, frames.length - 1)];
  const n = a.poses.length;
  const res = out && out.length === n ? out : new Float32Array(n);
  const span = b.time - a.time;
  const u = span > 0 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 0;
  for (let o = 0; o < n; o += 7) lerpPose(a.poses, b.poses, o, u, res);
  return res;
}

function lerpPose(pa: Float32Array, pb: Float32Array, o: number, u: number, out: Float32Array): void {
  const dx = pb[o] - pa[o];
  const dy = pb[o + 1] - pa[o + 1];
  const dz = pb[o + 2] - pa[o + 2];
  const teleported = dx * dx + dy * dy + dz * dz > TELEPORT_M * TELEPORT_M;
  const src = teleported ? (u < 0.5 ? pa : pb) : null;
  if (src) {
    for (let k = 0; k < 7; k++) out[o + k] = src[o + k];
    return;
  }
  out[o] = pa[o] + dx * u;
  out[o + 1] = pa[o + 1] + dy * u;
  out[o + 2] = pa[o + 2] + dz * u;
  // nlerp on the shorter arc
  const dot = pa[o + 3] * pb[o + 3] + pa[o + 4] * pb[o + 4] + pa[o + 5] * pb[o + 5] + pa[o + 6] * pb[o + 6];
  const sign = dot < 0 ? -1 : 1;
  let len = 0;
  for (let k = 3; k < 7; k++) {
    const v = pa[o + k] * (1 - u) + pb[o + k] * sign * u;
    out[o + k] = v;
    len += v * v;
  }
  const inv = len > 0 ? 1 / Math.sqrt(len) : 1;
  for (let k = 3; k < 7; k++) out[o + k] *= inv;
}

/** Events whose frame time lies in (t0, t1]. */
export function eventsBetween(frames: readonly ReplayFrame[], t0: number, t1: number): SimEvent[] {
  const out: SimEvent[] = [];
  if (!frames.length || t1 <= t0) return out;
  for (let i = frameIndexAt(frames, t0); i < frames.length; i++) {
    const f = frames[i];
    if (f.time > t1) break;
    if (f.time > t0) out.push(...f.events);
  }
  return out;
}

export interface Highlight {
  time: number;
  pos: [number, number, number] | null; // physics frame
  score: number;
}

/** The moment worth replaying: a detach beats any impact; otherwise the biggest hit. */
export function findHighlight(frames: readonly ReplayFrame[], fromT = -Infinity, toT = Infinity): Highlight | null {
  let best: Highlight | null = null;
  for (const f of frames) {
    if (f.time < fromT || f.time > toT) continue;
    for (const ev of f.events) {
      let score = 0;
      let pos: [number, number, number] | null = null;
      if (ev.kind === 'detach') { score = ev.part === 'head' ? 1e6 : 5e5; pos = ev.pos; }
      else if (ev.kind === 'impact' && ev.striker !== null) { score = ev.energyJ; pos = ev.pos; }
      else if (ev.kind === 'fall') score = 150;
      if (score > 0 && (!best || score > best.score)) best = { time: f.time, pos, score };
    }
  }
  return best;
}

/** The blow behind a knockdown lands at most this long before the fall registers. */
const KNOCKDOWN_BLOW_S = 1.5;

/**
 * The moment that decided a KO. A down-count KO fires long after the knockdown, so it replays the
 * loser's last fall before the KO and the biggest blow that caused it, not the count itself. Any other
 * KO (head off, power, disabled) replays the usual highlight up to the KO.
 */
export function findKoHighlight(frames: readonly ReplayFrame[], loser: Corner, koTime: number, reason: string): Highlight | null {
  if (reason !== 'down') return findHighlight(frames, -Infinity, koTime);
  let fallT: number | null = null;
  for (const f of frames) {
    if (f.time > koTime) break;
    if (f.events.some((e) => e.kind === 'fall' && e.corner === loser)) fallT = f.time;
  }
  if (fallT === null) return findHighlight(frames, -Infinity, koTime);
  let best: Highlight = { time: fallT, pos: null, score: 0 };
  for (const f of frames) {
    if (f.time > fallT) break;
    if (f.time < fallT - KNOCKDOWN_BLOW_S) continue;
    for (const ev of f.events) {
      if (ev.kind === 'impact' && ev.victim === loser && ev.striker !== null && ev.energyJ > best.score) {
        best = { time: f.time, pos: ev.pos, score: ev.energyJ };
      }
    }
  }
  return best;
}
