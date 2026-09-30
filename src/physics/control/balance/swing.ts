// Swing-foot trajectories (docs/design/balance-engine.md §3.5). The sole lifts first, travels, then
// sets down. Its horizontal path (x, y and yaw) is a quintic from the commanded position, velocity
// and acceleration to the landing with zero velocity and acceleration, so when the step adjuster
// moves the landing mid-swing the plan restarts from where the command is and the foot never
// jumps. The height rises to the apex and comes down with a little speed left (a foot that floats
// down to the canvas lands late); a swing past its time presses on down until it touches.
// A heavy leg lags its servo: the command runs `lead` seconds ahead of the clock.
import { clamp, minJerk, wrapAngle } from '../math';
import type { FootPlace } from '../support';

const TRAVEL_START = 0.1; // share of the swing spent lifting before the foot travels
const TRAVEL_END = 0.9; // ...and setting down after it arrives
const LATE_PRESS_M = 0.02; // a late foot is pressed this far below the canvas
const LATE_PRESS_S = 0.12;

/** Quintic from (p0, v0, a0) to (p1, 0, 0) over T: coefficients c0..c5. */
function quintic(p0: number, v0: number, a0: number, p1: number, T: number, c: Float64Array, o: number): void {
  const d = p1 - p0;
  const T2 = T * T, T3 = T2 * T;
  c[o] = p0;
  c[o + 1] = v0;
  c[o + 2] = a0 / 2;
  c[o + 3] = (20 * d - 12 * v0 * T - 3 * a0 * T2) / (2 * T3);
  c[o + 4] = (-30 * d + 16 * v0 * T + 3 * a0 * T2) / (2 * T3 * T);
  c[o + 5] = (12 * d - 6 * v0 * T - a0 * T2) / (2 * T3 * T2);
}

export class Swing {
  active = false;
  t0 = 0; // lift-off time
  T = 0.3; // planned swing time
  apex = 0.03;
  startZ = 0;
  lead = 0;
  from: FootPlace = { x: 0, y: 0, yaw: 0 };
  target: FootPlace = { x: 0, y: 0, yaw: 0 };
  /** Commanded state (for re-planning and the leg command). */
  readonly pos = new Float64Array(3); // x, y, yaw
  readonly vel = new Float64Array(3);
  readonly acc = new Float64Array(3);
  z = 0;
  private qt0 = 0; // start of the current quintic (command time: clock + lead)
  private qT = 0.1; // its duration
  private lastTe = -Infinity; // command time of the last sample (pos, vel, acc hold that state)
  private readonly c = new Float64Array(18);
  private frozen = false;

  /** Lift now (time `t`) from `from` (sole at height `fromZ`) to `target` in `T` seconds. */
  start(t: number, from: FootPlace, fromZ: number, target: FootPlace, T: number, apex: number, lead: number): void {
    this.active = true;
    this.t0 = t;
    this.T = Math.max(0.08, T);
    this.apex = apex;
    this.startZ = Math.max(0, fromZ);
    this.lead = lead;
    this.frozen = false;
    this.from = { ...from };
    this.target = { x: target.x, y: target.y, yaw: from.yaw + wrapAngle(target.yaw - from.yaw) };
    this.pos[0] = from.x;
    this.pos[1] = from.y;
    this.pos[2] = from.yaw;
    this.vel.fill(0);
    this.acc.fill(0);
    this.z = this.startZ;
    this.lastTe = -Infinity;
    this.plan(t + TRAVEL_START * this.T, this.T * (TRAVEL_END - TRAVEL_START));
  }

  stop(): void {
    this.active = false;
  }

  /** Swing progress 0..1 (past 1 when late). */
  progress(t: number): number {
    return (t - this.t0) / this.T;
  }

  remaining(t: number): number {
    return Math.max(0, this.t0 + this.T - t);
  }

  /** The landing may still move (the last 15% of the swing is frozen). */
  adjustable(t: number): boolean {
    return this.active && !this.frozen && this.progress(t) < 0.85;
  }

  /** Move the landing: a new quintic from the commanded state to `target` over the travel left. */
  retarget(t: number, target: FootPlace): void {
    if (!this.active) return;
    if (this.progress(t) >= 0.85) {
      this.frozen = true;
      return;
    }
    this.target = { x: target.x, y: target.y, yaw: this.pos[2] + wrapAngle(target.yaw - this.pos[2]) };
    this.replan(t);
  }

  /** Land sooner: the swing ends `left` seconds from now (never later than planned). */
  hurry(t: number, left: number): void {
    if (!this.active) return;
    const newEnd = t + left;
    if (newEnd >= this.t0 + this.T - 1e-3) return;
    // Keep the lift-off; shrink what remains so the foot arrives at newEnd.
    this.T = Math.max(t - this.t0 + left, 0.06);
    this.replan(t);
  }

  /** Re-plan the travel from the commanded state to the target, ending at the travel end. */
  private replan(t: number): void {
    const begin = this.t0 + TRAVEL_START * this.T, end = this.t0 + TRAVEL_END * this.T;
    if (this.lastTe <= begin) {
      // Not travelling yet: start from rest where the foot is.
      this.vel.fill(0);
      this.acc.fill(0);
      this.plan(begin, Math.max(0.03, end - begin));
      return;
    }
    void t;
    this.qt0 = this.lastTe;
    this.qT = Math.max(0.02, end - this.lastTe);
    quintic(this.pos[0], this.vel[0], this.acc[0], this.target.x, this.qT, this.c, 0);
    quintic(this.pos[1], this.vel[1], this.acc[1], this.target.y, this.qT, this.c, 6);
    quintic(this.pos[2], this.vel[2], this.acc[2], this.target.yaw, this.qT, this.c, 12);
  }

  /** Evaluate the command at time `t`: writes pos (x, y, yaw) and z. */
  sample(t: number): void {
    if (!this.active) return;
    const te = t + this.lead;
    this.lastTe = te;
    let tau = te - this.qt0;
    const T = this.qT;
    if (tau < 0) tau = 0;
    if (tau > T) tau = T;
    for (let i = 0; i < 3; i++) {
      const o = i * 6, c = this.c;
      const p = c[o] + tau * (c[o + 1] + tau * (c[o + 2] + tau * (c[o + 3] + tau * (c[o + 4] + tau * c[o + 5]))));
      const v = c[o + 1] + tau * (2 * c[o + 2] + tau * (3 * c[o + 3] + tau * (4 * c[o + 4] + tau * 5 * c[o + 5])));
      const a = 2 * c[o + 2] + tau * (6 * c[o + 3] + tau * (12 * c[o + 4] + tau * 20 * c[o + 5]));
      this.pos[i] = p;
      this.vel[i] = te - this.qt0 > T ? 0 : v;
      this.acc[i] = te - this.qt0 > T ? 0 : a;
    }
    const u = clamp((te - this.t0) / this.T, 0, 1);
    const late = t > this.t0 + this.T ? Math.min(1, (t - this.t0 - this.T) / LATE_PRESS_S) : 0;
    const descend = this.startZ * (1 - minJerk(u / TRAVEL_END));
    // Lift keeps the real clock: the sole stays up until the foot has arrived over its landing.
    const uz = clamp((t - this.t0) / this.T, 0, 1);
    this.z = descend + this.apex * Math.sin(Math.PI * uz) - LATE_PRESS_M * late;
  }

  private plan(start: number, T: number): void {
    this.qt0 = start;
    this.qT = T;
    quintic(this.pos[0], 0, 0, this.target.x, T, this.c, 0);
    quintic(this.pos[1], 0, 0, this.target.y, T, this.c, 6);
    quintic(this.pos[2], 0, 0, this.target.yaw, T, this.c, 12);
  }

}
