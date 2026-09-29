// PlayerDriver: turns held keys and presses into Intents, exactly the channel Jev uses. Pure
// logic (no DOM, no clock of its own) so it is unit-testable; PlayerMode feeds it input and
// telemetry and sends whatever intent it returns.
//
//   strikes   each press is buffered; presses within COMBO_WINDOW_S of the last chain into one
//             combination (Intent.combo, comboPlan.step = the step being thrown). The driver
//             sequences the chain itself (control runs only the first step of a 'combo' today):
//             a strike stays the tactic until telemetry shows it started and passed its commit
//             point, then the next buffered strike is sent at once, so it fires as soon as the
//             controller can throw again.
//   footwork  WASD is a vector relative to the opponent (Intent.move). Until control consumes
//             move, it maps onto the footwork tactics (see footworkTactic).
//   defence   Ctrl held = guard, C held = clinch, Space = slip (sidestep_counter for SLIP_HOLD_S),
//             Tab = feint. Space while down asks for a kip-up (getupStyle).
import type { Intent, MoveVector, Tactic, TargetZone } from '../core/protocol';
import {
  AGGRESSION, BUFFER_TTL_S, COMBO_WINDOW_S, COMMIT_PHASE, DEFAULT_COMMIT_PHASE, FEINT_HOLD_S, MAX_BUFFER, MOVE_STEP,
  SLIP_HOLD_S, START_TIMEOUT_S,
} from './config';
import type { HeldAction, PressAction } from './keymap';

/** Strike presses and the tactic (and hand) each asks for. */
export const STRIKE_ACTIONS: Partial<Record<PressAction, { tactic: Tactic; hand?: 'lead' | 'rear' }>> = {
  jab: { tactic: 'jab', hand: 'lead' },
  cross: { tactic: 'cross', hand: 'rear' },
  hook_lead: { tactic: 'hook', hand: 'lead' },
  hook_rear: { tactic: 'hook', hand: 'rear' },
  uppercut: { tactic: 'uppercut', hand: 'rear' },
  overhand: { tactic: 'overhand', hand: 'rear' },
  front_kick: { tactic: 'front_kick' },
  low_kick: { tactic: 'low_kick' },
  head_kick: { tactic: 'head_kick' },
  tornado_kick: { tactic: 'tornado_kick' },
  spinning_backfist: { tactic: 'spinning_backfist' },
};

/**
 * The footwork tactic that moves the fighter to its OWN left / right. Measured in physics
 * (tests/player/measure-latency.ts): today's control 'circle_left' steps to the fighter's right
 * (+turn is counter-clockwise around the opponent), so the names are crossed here. If control
 * renames them, flip this map; the latency script prints the check.
 */
export const CIRCLE_TO: Readonly<Record<'left' | 'right', Tactic>> = { left: 'circle_right', right: 'circle_left' };

/** Control skill ids that are not a thrown blow (stance, stepping, holds, get-ups). */
const NON_STRIKE_SKILLS = new Set(['', 'stance', 'step', 'guard', 'clinch', 'getup_rise', 'out', 'victory']);
export const isStrikeSkill = (skill: string): boolean => !NON_STRIKE_SKILLS.has(skill) && !skill.startsWith('getup');

const PUNCHES = new Set<Tactic>(['jab', 'cross', 'hook', 'uppercut', 'overhand', 'spinning_backfist', 'superman_punch']);

/** What the driver reads from this fighter's telemetry each frame. */
export interface SelfState {
  skill: string;
  skillPhase: number;
  down: boolean;
  /** The opponent's lead leg, for low kicks (his stance): orthodox leads with the left. */
  oppLeadLeg?: 'left_leg' | 'right_leg';
}

export interface Queued {
  tactic: Tactic;
  hand?: 'lead' | 'rear';
  t: number; // press time, s
  chain: number; // combination id: presses within COMBO_WINDOW_S share it
}

interface Active extends Queued {
  sentAt: number;
  started: boolean;
  combo: Tactic[]; // the whole chain this strike belongs to
  step: number; // its index in the chain
}

export type DriverPhase = 'idle' | 'strike' | 'guard' | 'clinch' | 'slip' | 'feint' | 'down';

/** A read-out for the HUD. */
export interface DriverView {
  phase: DriverPhase;
  current: Tactic | null; // the tactic standing right now
  buffer: Tactic[]; // strikes waiting
  combo: Tactic[] | null; // the chain being thrown
  aimBody: boolean;
  move: MoveVector;
}

export class PlayerDriver {
  aimBody = false;
  /**
   * The robot's abilities (RobotDesign.abilities), or null for all. A clinch on a robot that has
   * none is not sent: control would substitute its first strike and jab for as long as C is held.
   */
  abilities: ReadonlySet<string> | null = null;
  private queue: Queued[] = [];
  private active: Active | null = null;
  private sent: Queued[] = []; // strikes of the current chain already sent (for Intent.combo)
  private oneShot: { tactic: 'sidestep_counter' | 'feint'; until: number } | null = null;
  private chainId = 0;
  private lastPressT = -Infinity;
  private kipUp = false;
  private lastKey = '';
  private prevSkill = '';
  private prevPhase = 0;
  private held = new Set<HeldAction>();
  private move: MoveVector = { forward: 0, strafe: 0 };
  private phase: DriverPhase = 'idle';
  private currentTactic: Tactic | null = null;
  /** Fires when a strike is seen starting: its press time and the time it started (s). */
  onStrikeStarted: ((pressT: number, startT: number, tactic: Tactic) => void) | null = null;

  /** Replace the set of held actions (from the input layer). */
  setHeld(held: Iterable<HeldAction>): void {
    this.held = new Set(held);
    this.move = moveFrom(this.held);
  }

  /** A press at time `t` (s). Returns true if the press was used. */
  press(action: PressAction, t: number, self: SelfState | null = null): boolean {
    if (action === 'aim_body') {
      this.aimBody = !this.aimBody;
      return true;
    }
    if (action === 'slip') {
      if (self?.down) this.kipUp = true;
      else this.oneShot = { tactic: 'sidestep_counter', until: t + SLIP_HOLD_S };
      return true;
    }
    if (action === 'feint') {
      this.oneShot = { tactic: 'feint', until: t + FEINT_HOLD_S };
      return true;
    }
    const strike = STRIKE_ACTIONS[action];
    if (!strike) return false;
    if (t - this.lastPressT > COMBO_WINDOW_S) this.chainId++;
    this.lastPressT = t;
    this.queue.push({ ...strike, t, chain: this.chainId });
    while (this.queue.length > MAX_BUFFER) this.queue.shift();
    this.oneShot = null; // throwing ends a slip or feint
    return true;
  }

  /** Drop everything buffered (a knockdown, a reset). */
  clear(): void {
    this.queue = [];
    this.sent = [];
    this.active = null;
    this.oneShot = null;
    this.lastKey = '';
  }

  /** Forget the last sent intent, so the next update resends (after a world reset). */
  resync(): void {
    this.lastKey = '';
  }

  view(): DriverView {
    return {
      phase: this.phase,
      current: this.currentTactic,
      buffer: this.queue.map((q) => q.tactic),
      combo: this.active && this.active.combo.length > 1 ? this.active.combo : null,
      aimBody: this.aimBody,
      move: this.move,
    };
  }

  /**
   * Advance to time `now` (s) with this frame's telemetry (null before the first frame). Returns
   * the intent to send when it differs from the last one sent, else null.
   */
  update(now: number, self: SelfState | null): Intent | null {
    if (self) this.track(now, self);
    const intent = this.decide(now, self);
    const key = intentKey(intent);
    if (key === this.lastKey) return null;
    this.lastKey = key;
    return intent;
  }

  /** Watch the body: has the strike we sent started, and passed its commit point? */
  private track(now: number, self: SelfState): void {
    const newRun = isStrikeSkill(self.skill) && (self.skill !== this.prevSkill || self.skillPhase + 0.02 < this.prevPhase);
    this.prevSkill = self.skill;
    this.prevPhase = self.skillPhase;
    if (self.down) {
      this.queue = [];
      this.active = null;
      this.oneShot = null;
      return;
    }
    this.kipUp = false;
    const a = this.active;
    if (!a) return;
    if (!a.started) {
      if (newRun) {
        a.started = true;
        this.onStrikeStarted?.(a.t, now, a.tactic);
      } else if (now - a.sentAt > START_TIMEOUT_S) {
        this.active = null; // never got to throw it (out of reach, off balance): let it go
      }
      return;
    }
    const past = !isStrikeSkill(self.skill) || self.skillPhase >= (COMMIT_PHASE[self.skill] ?? DEFAULT_COMMIT_PHASE);
    if (past) this.active = null;
  }

  private decide(now: number, self: SelfState | null): Intent {
    if (self?.down) {
      this.phase = 'down';
      return this.intent('hold_range', 'head', AGGRESSION.footwork, { getupStyle: this.kipUp ? 'kip_up' : 'safe' });
    }
    if (!this.active) this.dispatch(now);
    const a = this.active;
    if (a) {
      this.phase = 'strike';
      const combo = a.combo.length > 1 ? a.combo : undefined;
      const zone = this.zoneFor(a.tactic, self);
      return this.intent(a.tactic, zone, AGGRESSION.strike, {
        hand: a.hand,
        ...(combo ? { combo, comboPlan: { setup: 0, zones: combo.map((t) => this.zoneFor(t, self)), payoffZone: zone, step: a.step } } : {}),
      });
    }
    if (this.held.has('clinch') && (!this.abilities || this.abilities.has('clinch'))) {
      this.phase = 'clinch';
      return this.intent('clinch', 'head', AGGRESSION.clinch);
    }
    if (this.held.has('guard')) {
      this.phase = 'guard';
      return this.intent('guard', 'head', AGGRESSION.guard);
    }
    if (this.oneShot && now < this.oneShot.until) {
      const slip = this.oneShot.tactic === 'sidestep_counter';
      this.phase = slip ? 'slip' : 'feint';
      return this.intent(this.oneShot.tactic, 'head', slip ? AGGRESSION.slip : AGGRESSION.feint);
    }
    this.oneShot = null;
    this.phase = 'idle';
    return this.intent(footworkTactic(this.move), 'head', AGGRESSION.footwork);
  }

  /** Send the next fresh buffered strike, if any. */
  private dispatch(now: number): void {
    while (this.queue.length && now - this.queue[0].t > BUFFER_TTL_S) this.queue.shift();
    const next = this.queue.shift();
    if (!next) return;
    this.sent = this.sent.filter((q) => q.chain === next.chain);
    const chain = [...this.sent, next, ...this.queue.filter((q) => q.chain === next.chain)];
    this.active = { ...next, sentAt: now, started: false, combo: chain.map((q) => q.tactic), step: this.sent.length };
    this.sent.push(next);
  }

  private zoneFor(tactic: Tactic, self: SelfState | null): TargetZone {
    if (tactic === 'low_kick') return self?.oppLeadLeg ?? 'left_leg';
    if (tactic === 'front_kick') return 'torso';
    if (PUNCHES.has(tactic) && this.aimBody) return 'torso';
    return 'head';
  }

  private intent(tactic: Tactic, target: TargetZone, aggression: number, extra: Partial<Intent> = {}): Intent {
    this.currentTactic = tactic;
    const out: Intent = { tactic, target, aggression, confidence: 1, source: 'player', move: { ...this.move }, ...extra };
    if (out.hand === undefined) delete out.hand;
    return out;
  }
}

/** WASD → a unit-bounded vector: forward = W − S, strafe = D − A, diagonals normalised. */
export function moveFrom(held: ReadonlySet<HeldAction>): MoveVector {
  const forward = (held.has('move_forward') ? 1 : 0) - (held.has('move_back') ? 1 : 0);
  const strafe = (held.has('move_right') ? 1 : 0) - (held.has('move_left') ? 1 : 0);
  const n = Math.hypot(forward, strafe);
  return n > 1 ? { forward: forward / n, strafe: strafe / n } : { forward, strafe };
}

/**
 * Today's controller has no continuous footwork, so the vector picks the nearest footwork tactic:
 * backing out wins (escape first), any sideways input circles (circling also closes to at most
 * ~1.4 m, so W+A walks in on an angle), W alone closes, nothing held holds range (~1.2 m).
 */
export function footworkTactic(m: MoveVector): Tactic {
  if (m.forward < -0.01) return 'retreat';
  if (m.strafe > 0.01) return CIRCLE_TO.right;
  if (m.strafe < -0.01) return CIRCLE_TO.left;
  if (m.forward > 0.01) return 'close_distance';
  return 'hold_range';
}

const bucket = (v: number) => Math.round(v / MOVE_STEP) * MOVE_STEP;

/** Two intents with the same key are the same order to the body (resending would be noise). */
export function intentKey(i: Intent): string {
  const m = i.move ? `${bucket(i.move.forward)},${bucket(i.move.strafe)}` : '-';
  return [i.tactic, i.target, i.aggression, i.hand ?? '', i.getupStyle ?? '', i.combo?.join('+') ?? '', i.comboPlan?.step ?? '', m].join('|');
}
