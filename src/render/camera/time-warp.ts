// Hit-stop and KO slow motion, as a presentation-only time scale for the physics worker.
//
// The worker steps MuJoCo at a fixed dt and only converts wall time into a number of steps
// (worker.ts: simDebt += wall * timescale), and intents are applied at tick stamps, so scaling
// time changes when frames are shown, never which states are computed: the fight's outcome is
// the same with this on or off. Checked 2026-09-29 by running one fight twice through the
// worker's scheduling rule with this class fed by the sim's own events: 8 hit-stops vs none,
// bit-identical final state and tick-stamped event timeline.
//
// - Hit-stop: a big clean strike (strength >= HIT.HIT_STOP at striking speed) drops time to
//   HITSTOP_SCALE for 50-110 ms of wall time, scaled by strength, then snaps back. At most one
//   starts every COOLDOWN_S; never during replays or outside the live fight.
// - KO / head knockoff: ~0.3x for ~1.2 s (after any hit-stop in progress), easing back to real
//   time, before the broadcast's KO replay.
// Pure logic, wall-clock driven, unit tested.
import type { SimEvent } from '../../core/protocol';
import { HIT, strikeStrength } from '../vfx/scaling';

export const TIME_WARP = {
  HITSTOP_SCALE: 0.03,
  HITSTOP_MIN_S: 0.05,
  HITSTOP_MAX_S: 0.11,
  /** Closing speed a strike needs for a hit-stop: a committed blow, not a shove. */
  HITSTOP_MIN_SPEED: 3,
  COOLDOWN_S: 0.4,
  SLOWMO_SCALE: 0.3,
  SLOWMO_S: 1.2,
  SLOWMO_EASE_IN_S: 0.08,
  SLOWMO_EASE_OUT_S: 0.3, // the last part of SLOWMO_S ramps back to 1
} as const;

export interface TimeWarpStats {
  hitStops: number;
  slowMos: number;
  skippedCooldown: number;
  lastHitStopMs: number;
  lastStrength: number;
}

export type WarpEvent = 'hitstop' | 'slowmo' | null;

export class TimeWarp {
  /** False disables hit-stop and slow motion entirely (URL ?hitstop=0, or the console). */
  enabled: boolean;
  readonly stats: TimeWarpStats = { hitStops: 0, slowMos: 0, skippedCooldown: 0, lastHitStopMs: 0, lastStrength: 0 };
  private clock = 0;
  private stopLeft = 0;
  private slowT = -1; // seconds into the slow-mo, -1 = none
  private slowQueued = false;
  private lastStopAt = -Infinity;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  /**
   * Feed a live frame's events. `live`: the fight (or the KO moment) is on screen and the sim
   * is running forward (not a replay, not a break). `tel`: the frame's telemetry, so a ground
   * scramble (striker down) never stops time. Returns what started, for debugging.
   */
  onEvents(events: readonly SimEvent[], live: boolean, tel?: readonly { down: boolean }[] | null): WarpEvent {
    if (!this.enabled || !live) return null;
    let started: WarpEvent = null;
    let best = 0;
    for (const e of events) {
      if (e.kind === 'ko' && e.reason !== 'down') this.slowQueued = true;
      else if (e.kind === 'detach' && e.part === 'head') this.slowQueued = true;
      else if (e.kind === 'impact' && e.speed >= TIME_WARP.HITSTOP_MIN_SPEED) {
        best = Math.max(best, strikeStrength(e, tel));
      }
    }
    if (best >= HIT.HIT_STOP && this.slowT < 0) {
      if (this.clock - this.lastStopAt >= TIME_WARP.COOLDOWN_S) {
        const k = (best - HIT.HIT_STOP) / (1 - HIT.HIT_STOP);
        this.stopLeft = TIME_WARP.HITSTOP_MIN_S + (TIME_WARP.HITSTOP_MAX_S - TIME_WARP.HITSTOP_MIN_S) * Math.min(1, Math.max(0, k));
        this.lastStopAt = this.clock;
        this.stats.hitStops++;
        this.stats.lastHitStopMs = this.stopLeft * 1000;
        this.stats.lastStrength = best;
        started = 'hitstop';
      } else {
        this.stats.skippedCooldown++;
      }
    }
    if (this.slowQueued && this.slowT < 0 && started === null && this.stopLeft <= 0) {
      this.beginSlow();
      started = 'slowmo';
    }
    return started;
  }

  /** Advance by wall time; returns the time scale to run the sim at (1 = real time). */
  update(dtWall: number, live: boolean): number {
    this.clock += dtWall;
    if (!this.enabled || !live) {
      this.cancel();
      return 1;
    }
    if (this.stopLeft > 0) {
      this.stopLeft -= dtWall;
      if (this.stopLeft > 0) return TIME_WARP.HITSTOP_SCALE;
      this.stopLeft = 0;
      if (this.slowQueued && this.slowT < 0) this.beginSlow();
    }
    if (this.slowT >= 0) {
      this.slowT += dtWall;
      const t = this.slowT;
      if (t >= TIME_WARP.SLOWMO_S) {
        this.slowT = -1;
        return 1;
      }
      return slowScale(t);
    }
    return 1;
  }

  /** Current state, for the HUD / debugging. */
  get active(): WarpEvent {
    if (this.stopLeft > 0) return 'hitstop';
    return this.slowT >= 0 ? 'slowmo' : null;
  }

  /** Drop any hit-stop or slow motion now (replay, break, new match). */
  cancel(): void {
    this.stopLeft = 0;
    this.slowT = -1;
    this.slowQueued = false;
  }

  private beginSlow(): void {
    this.slowQueued = false;
    this.slowT = 0;
    this.stats.slowMos++;
  }
}

/** Slow-mo profile: ease down to SLOWMO_SCALE, hold, ease back to 1 over the last SLOWMO_EASE_OUT_S. */
export function slowScale(t: number): number {
  const { SLOWMO_SCALE: lo, SLOWMO_S: len, SLOWMO_EASE_IN_S: ein, SLOWMO_EASE_OUT_S: eout } = TIME_WARP;
  if (t <= 0) return 1;
  if (t < ein) return 1 + (lo - 1) * smooth(t / ein);
  if (t < len - eout) return lo;
  if (t < len) return lo + (1 - lo) * smooth((t - (len - eout)) / eout);
  return 1;
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
