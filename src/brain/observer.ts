// Watches the frame stream for one fighter: interrupts that deserve an immediate
// re-query, and the opponent's recent actions (read from physics skills, never from
// anything the opponent's builder wrote).
import type { Tactic } from '../core/protocol';
import type { Corner } from '../core/types';
import { skillAction } from './tactics';
import type { BrainFrame } from './types';

export type InterruptKind =
  | 'big_hit' | 'fell' | 'got_up' | 'opp_fell' | 'opp_got_up' | 'opp_windup' | 'cage' | 'part_lost' | 'joint_failed';

export const BIG_HIT_IMPULSE_NS = 40;
export const WINDUP_ALERT = 0.15;
const RECENT_KEEP = 3;
const RECENT_WINDOW_S = 6;

export interface RecentAction { action: Tactic; time: number }

export class FightObserver {
  private prevMeDown = false;
  private prevOppDown = false;
  private prevOppWindup = 0;
  private prevOppAction: Tactic | null = null;
  private recent: RecentAction[] = [];

  constructor(readonly corner: Corner) {}

  /** Returns this frame's interrupts (deduplicated) and records opponent actions. */
  update(frame: BrainFrame): InterruptKind[] {
    const me = frame.telemetry[this.corner];
    const opp = frame.telemetry[this.corner === 0 ? 1 : 0];
    const out = new Set<InterruptKind>();
    this.scanEvents(frame, out);
    if (me.down !== this.prevMeDown) out.add(me.down ? 'fell' : 'got_up');
    if (opp.down !== this.prevOppDown) out.add(opp.down ? 'opp_fell' : 'opp_got_up');
    if (opp.windup >= WINDUP_ALERT && this.prevOppWindup < WINDUP_ALERT) out.add('opp_windup');
    this.prevMeDown = me.down;
    this.prevOppDown = opp.down;
    this.prevOppWindup = opp.windup;
    this.trackAction(skillAction(opp.skill), frame.time);
    return [...out];
  }

  /** Opponent's last few actions, newest first. */
  recentActions(now: number): RecentAction[] {
    return this.recent.filter((r) => now - r.time <= RECENT_WINDOW_S).slice().reverse();
  }

  private scanEvents(frame: BrainFrame, out: Set<InterruptKind>) {
    for (const e of frame.events) {
      if (e.kind === 'impact' && e.victim === this.corner && e.impulseNs >= BIG_HIT_IMPULSE_NS) out.add('big_hit');
      else if (e.kind === 'cage') out.add('cage');
      else if (e.kind === 'detach') out.add('part_lost');
      else if (e.kind === 'joint' && e.corner === this.corner && (e.state === 'limp' || e.state === 'seized')) out.add('joint_failed');
      else if (e.kind === 'fall') out.add(e.corner === this.corner ? 'fell' : 'opp_fell');
      else if (e.kind === 'getup') out.add(e.corner === this.corner ? 'got_up' : 'opp_got_up');
    }
  }

  private trackAction(action: Tactic | null, time: number) {
    if (action && action !== this.prevOppAction) {
      this.recent = [...this.recent, { action, time }].slice(-RECENT_KEEP);
    }
    this.prevOppAction = action;
  }
}
