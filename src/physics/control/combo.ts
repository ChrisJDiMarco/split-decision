// Combinations run whole in the body (docs/design/fighter-iq-control-contract.md §2). An intent with
// tactic 'combo' and no comboPlan.step is the whole thing: TacticRunner (tactics.ts) throws its steps
// in order, each at its zone, chaining the next step's windup from COMBO.chainAt of the last blow's
// recovery (no single-strike cooldown), holding guard for a step's tempo, selling its feints
// (feint.ts), and throwing the payoff at max(aggression, 0.8) within COMBO.payoffWaitS of the setup,
// or at once on a fresh bite, adapted to his answer. A brain-sequenced step of the combo the body is
// already running is absorbed; one that comes after the body finished it runs as a single tactic.
// This file holds the run's state and the pure rules; TacticRunner drives it.
import type { FeintRead, Intent, Tactic, TargetZone } from '../../core/protocol';
import type { SkillRun } from './skills/types';

/** Combo tuning (exported so tools can sweep it; the worker never changes it). */
export const COMBO = {
  chainAt: 0.7, // the next step's windup starts at this share of the previous blow's recovery
  payoffAggression: 0.8,
  payoffWaitS: 0.1, // the payoff goes within this of the setup ending (at once on a fresh bite)
  reachSlackM: 0.8, // he is this far beyond a step's range: the combination is off
  beatS: 0.3, // a step the body has no move for (a stance switch) is a short beat in stance
  stepTimeoutS: 1.4, // a step that cannot start (out of range, off balance) is skipped after this
  exitS: 0.7, // after a combination, step back to the edge this long (unless pressing)
};

export const FEINT_TACTICS: ReadonlySet<Tactic> = new Set<Tactic>(['feint', 'feint_left', 'feint_right']);
const LEG_ZONES: ReadonlySet<TargetZone> = new Set<TargetZone>(['left_leg', 'right_leg']);

/** The step list that identifies a combination ('' without one). */
export function comboKey(i: Intent | null): string {
  return i?.combo?.length ? i.combo.join('>') : '';
}

/** Run the whole combination in the body: tactic 'combo' with steps and no brain-sequenced step. */
export function wholeCombo(i: Intent): boolean {
  return i.tactic === 'combo' && i.comboPlan?.step === undefined && (i.combo?.length ?? 0) > 0;
}

export class ComboRun {
  readonly key: string;
  readonly steps: Tactic[];
  readonly zones: TargetZone[];
  readonly setup: number;
  readonly tempo: readonly number[];
  readonly payoffZone: TargetZone;
  /** The newest feint read of this fighter when the combination started (a bite must be newer). */
  readonly readSeq0: number;
  /** The next step to throw. */
  i = 0;
  /** The run of the last step thrown (its windup started), and when the last step ended. */
  current: SkillRun | null = null;
  lastEndAt = -1;
  /** When step i became due (its timeout), and the beat before it (tempo) running until. */
  dueAt: number;
  beatUntil = -1;
  /** When the setup's last step ended (the payoff's clock), and his answer to it once read. */
  setupEndedAt = -1;
  read: FeintRead | null = null;

  constructor(intent: Intent, time: number, readSeq0: number) {
    this.key = comboKey(intent);
    this.steps = [...intent.combo!];
    const plan = intent.comboPlan;
    this.zones = this.steps.map((t, k) => stepZone(t, plan?.zones[k] ?? intent.target));
    this.setup = plan ? Math.min(plan.setup, this.steps.length) : 0;
    this.tempo = plan?.tempo ?? [];
    this.payoffZone = plan?.payoffZone ?? intent.target;
    this.readSeq0 = readSeq0;
    this.dueAt = time;
  }

  /** Steps from `setup` on are the payoff. */
  payoff(k = this.i): boolean {
    return k >= this.setup;
  }
}

/** The zone a step aims at: a low kick at a leg, a front kick at the body, the rest where asked. */
export function stepZone(t: Tactic, zone: TargetZone): TargetZone {
  if (t === 'low_kick') return LEG_ZONES.has(zone) ? zone : 'left_leg';
  if (t === 'front_kick' && zone === 'head') return 'torso';
  return zone === 'weapon' ? 'head' : zone;
}

/**
 * The payoff for his answer to the setup (§2.4): he retreated, so a long shot instead (the first of
 * `long` he can throw); he countered, covered, flinched or did not bite, so the planned move.
 */
export function adaptPayoff(planned: Tactic, zone: TargetZone, read: FeintRead | null, long: readonly Tactic[]): { tactic: Tactic; zone: TargetZone } {
  if (read?.reactions.includes('retreated') && long.length) {
    const t = long[0];
    return { tactic: t, zone: t === 'front_kick' ? 'torso' : 'head' };
  }
  return { tactic: planned, zone };
}
