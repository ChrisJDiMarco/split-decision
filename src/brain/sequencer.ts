// Follows a setup → payoff combination while it runs, for the MIND panel, and steps it itself only
// on a body that cannot run Intent.combo whole.
//   body sequencing (COMBO_SEQUENCING 'body', docs/design/fighter-iq-control-contract.md §2): the
//   brain sends ONE combo intent (no comboPlan.step) and the body throws every step itself, chained,
//   with its own payoff read. The brain sends no step intents (a step intent arriving after the body
//   already threw that step would be thrown a second time); it only follows the body's
//   RobotTelemetry.comboStep and his answer to the setup (the read) for the plan and READ lines, and
//   re-decides the moment the last step is in the air.
//   brain sequencing (the fallback): a body that shows no sign of running the combination whole (the
//   intent applied, no comboStep: the legacy balance path) gets it one step at a time, as before:
//   each step goes out as its own intent, the next one follows when the body has thrown this one
//   (its strike skill started and ended) or its time is up. After the setup it waits a beat for the
//   physics read of his answer, then picks the payoff from it:
//     covered / flinched / no bite   the planned payoff, at the zone the setup was meant to open
//     retreated                      he stepped away: a long shot instead (front kick, cross)
//     countered                      he threw back: the payoff also arms as an opening reflex, so it
//                                    lands on his whiff or overcommit without another decision
// While a plan runs the brain does not re-ask Jev on cadence (the fighter commits to the combo);
// anything serious (a knockdown, a big hit, range lost) aborts it.
import type { BiteReaction, FeintRead, Intent, Opening, RobotTelemetry, Tactic, TargetZone } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import { moveReady } from './limbs';
import { freshRead, readHud, zoneNote } from './scouting';
import { stepLabel } from './setups';
import type { Situation } from './situation';
import { canThrow } from './style';
import { skillAction, tacticWords, TACTIC_INFO } from './tactics';

/** The body runs Intent.combo whole (control/combo.ts); the brain steps it only for a body that does not. */
export const COMBO_SEQUENCING: 'brain' | 'body' = 'body';
/**
 * Body sequencing: a combo intent applied to the body (RobotTelemetry.intent) this long with no
 * comboStep means a body that does not run combinations whole (the legacy path): the brain steps it.
 * Two frames at 60 Hz, so a frame that falls between the intent applying and the next control update
 * is not mistaken for one.
 */
export const BODY_PROOF_S = 0.03;
/** ...and one that never shows the intent applied at all (telemetry without it) is stepped after this. */
export const BODY_WAIT_S = 1;

export const STEP_TIMEOUT_S = 1.4; // a step the body never throws (out of range, blocked) is skipped
export const FOOTWORK_STEP_S = 0.6; // a stance switch or a pause-step holds this long
export const READ_WAIT_S = 0.3; // after the setup: wait this long for the read of his answer
export const PLAN_SLACK_S = 1; // a plan older than this plus every step's timeout is dropped
export const PAYOFF_AGGRESSION = 0.8;
const FEINTS = new Set<Tactic>(['feint', 'feint_left', 'feint_right']);
const ABORT_BANDS = new Set(['mid range', 'far']);

/** Why no plan can run right now (down, he is down, out of range), or null. */
function blocked(s: Situation): string | null {
  if (s.me.down) return 'down';
  if (s.oppPhase === 'down') return 'he is down';
  if (ABORT_BANDS.has(s.band)) return 'out of range';
  return null;
}

export interface PlanSpec {
  steps: Tactic[];
  zones: TargetZone[];
  setup: number;
  payoffZone: TargetZone;
  fishing?: BiteReaction;
  tempo?: number[];
}

/** What the HUD shows of a running plan. */
export interface PlanView {
  setup: string[]; // 'feint high', 'jab'
  payoff: string[]; // 'low kick'
  payoffZone: TargetZone;
  note: string | null; // 'left knee 40%'
  step: number;
  phase: 'setup' | 'payoff';
  read: string | null; // the read of his answer to the setup, once in
}

interface Running extends PlanSpec {
  /** 'follow': the body runs it whole, the brain only follows; 'brain': the brain sends each step. */
  mode: 'follow' | 'brain';
  key: string; // the step list as sent (Intent.combo), to recognise the intent the body is running
  seen: boolean; // follow: the body has shown it running the combination (comboStep)
  appliedAt: number | null; // follow: when the intent was first seen applied without a comboStep
  base: Intent;
  i: number;
  stepAt: number; // when this step's intent went out
  started: boolean; // our strike skill for this step has started
  endedAt: number | null; // ... and ended (or the footwork step's time is up)
  readSeq: number; // the newest read seq when the plan started
  read: FeintRead | null;
  startedAt: number;
  lastSkill: string;
  note: string | null;
  held: boolean; // the beat before this step has been called (a rhythm break)
}

/** The next intent of a plan: step `index` (-1: the beat of a rhythm break). */
export type SeqStep = { index: number; intent: Intent; reason: string };

function isStrikeSkill(skill: string): boolean {
  const a = skillAction(skill);
  return !!a && TACTIC_INFO[a].kind === 'strike';
}

/** The step list that identifies a combination intent ('' without one). */
function keyOf(steps: readonly Tactic[] | undefined): string {
  return steps?.length ? steps.join('>') : '';
}

/** The body is running this combination's intent whole (tactic 'combo', no brain-sequenced step). */
function runningWhole(me: RobotTelemetry, key: string): boolean {
  const i = me.intent;
  return !!i && i.tactic === 'combo' && i.comboPlan?.step === undefined && keyOf(i.combo) === key;
}

/** The step a body-run combination is on: the last one it started (comboStep is the next to throw). */
function bodyStep(comboStep: number, steps: number): number {
  return Math.max(0, Math.min(steps - 1, comboStep - 1));
}

export class ComboSequencer {
  private run: Running | null = null;
  /** The body has been seen running a combination whole this fight (it publishes comboStep). */
  private bodyRuns = false;
  /** Step intents sent so far (brain sequencing only; zero while the body runs them). */
  stepsSent = 0;

  get active(): boolean { return this.run !== null; }

  /** The running plan is the body's (body sequencing), not stepped by the brain. */
  get following(): boolean { return this.run?.mode === 'follow'; }

  /**
   * Begin a plan whose combo intent (`base`) has just gone out. `follow`: the body runs it whole and
   * the brain only follows (it steps it after all if the body shows no sign of running it).
   */
  start(spec: PlanSpec, base: Intent, s: Situation, follow = COMBO_SEQUENCING === 'body'): void {
    // The body is already throwing the first step (the combo opens with the strike in the air):
    // that is step 0, so its end moves the plan on instead of waiting out STEP_TIMEOUT_S.
    const inAir = isStrikeSkill(s.me.skill) && skillAction(s.me.skill) === spec.steps[0];
    this.run = {
      ...spec, mode: follow ? 'follow' : 'brain', key: keyOf(base.combo ?? spec.steps), seen: false, appliedAt: null,
      base, i: 0, stepAt: s.time, started: inAir, endedAt: null,
      readSeq: s.me.reads?.[s.me.reads.length - 1]?.seq ?? 0, read: null, startedAt: s.time,
      lastSkill: s.me.skill, note: zoneNote(s.me.weakSpots, spec.payoffZone), held: false,
    };
  }

  abort(): void { this.run = null; }

  /**
   * A plan started now would be dropped on the next frame, and the drop re-asks Jev 0.1 s later: a
   * churn of combo intents and questions whenever Jev picks a combination at mid range or over a
   * downed opponent. Then the combo intent just goes out as it did before the sequencer.
   */
  canStart(s: Situation): boolean { return blocked(s) === null; }

  /** Why the plan must stop now, or null. */
  private abortReason(s: Situation, interrupts: readonly string[]): string | null {
    const r = this.run!;
    const b = blocked(s);
    if (b) return b;
    if (s.time - r.startedAt > PLAN_SLACK_S + STEP_TIMEOUT_S * r.steps.length + (r.tempo ?? []).reduce((a, b) => a + b, 0)) return 'too long';
    if (interrupts.some((i) => i === 'big_hit' || i === 'fell' || i === 'opp_fell' || i === 'part_lost' || i === 'joint_failed')) return interrupts[0];
    return null;
  }

  /**
   * One frame: follow the body through the current step and, when it is done, return the next
   * step's intent (or null). Returns 'aborted' when the plan stopped, 'done' when it finished.
   */
  update(s: Situation, interrupts: readonly string[], design: RobotDesign): SeqStep | 'aborted' | 'done' | null {
    const r = this.run;
    if (!r) return null;
    if (this.abortReason(s, interrupts)) { this.run = null; return 'aborted'; }
    if (r.mode === 'follow') {
      const f = this.follow(r, s, design);
      if (f !== 'step it') return f;
      // A body that does not run combinations whole (the legacy path) runs a combo intent as its first
      // step: from here the brain sends the rest, one step at a time, as before.
      r.mode = 'brain';
      r.stepAt = s.time;
      r.started = isStrikeSkill(s.me.skill) && skillAction(s.me.skill) === r.steps[0];
      r.lastSkill = s.me.skill;
    }
    this.track(r, s);
    const step = r.steps[r.i];
    const footwork = !FEINTS.has(step) && TACTIC_INFO[step].kind !== 'strike';
    if (r.endedAt === null) {
      if (footwork && s.time - r.stepAt >= FOOTWORK_STEP_S) r.endedAt = s.time;
      else if (s.time - r.stepAt >= STEP_TIMEOUT_S) r.endedAt = s.time;
      else return null;
    }
    const next = r.i + 1;
    if (next >= r.steps.length) { this.run = null; return 'done'; }
    const payoffNext = next === r.setup;
    if (payoffNext && !r.read && s.time - r.endedAt < READ_WAIT_S) return null;
    const pause = r.tempo?.[next] ?? 0;
    if (pause > 0 && s.time - r.endedAt < pause) {
      if (r.held) return null;
      // The beat: stop throwing (the standing step would repeat) and hold for a moment.
      r.held = true;
      return { index: -1, intent: { ...r.base, tactic: 'hold_range', comboPlan: this.planFor(r, r.i) }, reason: 'a beat: break the rhythm' };
    }
    return this.advance(r, next, s, design);
  }

  /**
   * Body sequencing: follow the body through the combination (its comboStep) and his answer to the
   * setup. 'done' once the last step is in the air (or the body dropped the combination), so the mind
   * decides what comes next while that blow lands; 'step it' when the body shows no sign of running it.
   */
  private follow(r: Running, s: Situation, design: RobotDesign): 'done' | 'step it' | null {
    const me = s.me;
    this.watchRead(r, s, design);
    const whole = runningWhole(me, r.key);
    if (whole && me.comboStep !== undefined) {
      r.seen = true;
      this.bodyRuns = true;
      r.i = bodyStep(me.comboStep, r.steps.length);
      // The last step has started: done once that blow is past its windup (RobotTelemetry.committed).
      // Not before: the next intent (the reset below, or the House Mind's guard or circle) would pull
      // a blow still in its windup, and the combination would lose its payoff.
      if (me.comboStep >= r.steps.length && me.committed !== false) { this.run = null; return 'done'; }
      return null;
    }
    if (r.seen) { this.run = null; return 'done'; } // finished, or dropped (a reflex, he went down)
    if (whole) {
      // Applied, and the body is not running it: a body that runs combinations dropped it at once
      // (his windup fired a reflex first); one that never does (legacy) runs its first step.
      if (this.bodyRuns) { this.run = null; return 'done'; }
      r.appliedAt ??= s.time;
      return s.time - r.appliedAt >= BODY_PROOF_S ? 'step it' : null;
    }
    return s.time - r.startedAt >= BODY_WAIT_S ? 'step it' : null;
  }

  /** The read of his answer to the setup, once in; a retreat turns the shown payoff into the long shot the body throws instead. */
  private watchRead(r: Running, s: Situation, design: RobotDesign): void {
    const read = freshRead(s.me, s.time);
    if (!read || read.seq <= r.readSeq || r.read) return;
    r.read = read;
    if (r.setup > 0 && r.setup < r.steps.length && r.i <= r.setup && read.reactions.includes('retreated')) {
      const long = (['front_kick', 'cross', 'jab'] as Tactic[]).find((t) => canThrow(design, t) && moveReady(s.me, t));
      if (long) {
        r.steps = r.steps.map((t, k) => (k === r.setup ? long : t));
        r.zones = r.zones.map((z, k) => (k === r.setup ? (long === 'front_kick' ? 'torso' : 'head') : z));
      }
    }
  }

  private track(r: Running, s: Situation): void {
    const skill = s.me.skill;
    if (skill !== r.lastSkill) {
      if (isStrikeSkill(skill) && s.time > r.stepAt) r.started = true;
      else if (r.started && isStrikeSkill(r.lastSkill) && r.endedAt === null) r.endedAt = s.time;
      r.lastSkill = skill;
    }
    const read = freshRead(s.me, s.time);
    if (read && read.seq > r.readSeq && !r.read) {
      r.read = read;
      // Physics read a pulled windup: the feint this step asked for has been shown.
      if (FEINTS.has(r.steps[r.i]) && r.endedAt === null) r.endedAt = s.time;
    }
  }

  private advance(r: Running, next: number, s: Situation, design: RobotDesign): SeqStep {
    let tactic = r.steps[next];
    let zone = r.zones[next] ?? r.payoffZone;
    let onOpening: Partial<Record<Opening, Tactic>> | undefined = r.base.onOpening;
    let reason: string;
    const payoff = next >= r.setup;
    if (payoff && next === r.setup) {
      const read = r.read;
      if (read?.reactions.includes('retreated')) {
        const long = (['front_kick', 'cross', 'jab'] as Tactic[]).find((t) => canThrow(design, t) && moveReady(s.me, t));
        if (long) { tactic = long; zone = long === 'front_kick' ? 'torso' : 'head'; }
      } else if (read?.reactions.includes('countered')) {
        onOpening = { missed_recovering: tactic, overcommitted: tactic };
      }
      const what = read ? (read.bit ? `he ${read.reactions.join(' and ')}` : 'no bite') : 'no read';
      reason = `payoff: ${what} → ${tacticWords(tactic)} to the ${zone.replace(/_/g, ' ')}`;
    } else {
      reason = r.setup === 0 ? `combo ${next + 1}/${r.steps.length}: ${tacticWords(tactic)}`
        : payoff ? `payoff ${next - r.setup + 1}: ${tacticWords(tactic)}` : `setup ${next + 1}/${r.setup}: ${stepLabel(tactic, zone)}`;
    }
    const pauseNow = (r.tempo?.[next] ?? 0) > 0;
    if (tactic !== r.steps[next] || zone !== r.zones[next]) {
      r.steps = r.steps.map((t, i) => (i === next ? tactic : t));
      r.zones = r.zones.map((z, i) => (i === next ? zone : z));
    }
    r.i = next;
    this.stepsSent++;
    r.held = false;
    r.stepAt = s.time;
    r.started = false;
    r.endedAt = null;
    r.lastSkill = s.me.skill;
    const intent: Intent = {
      ...r.base,
      tactic, target: zone,
      aggression: payoff ? Math.max(r.base.aggression, PAYOFF_AGGRESSION) : r.base.aggression,
      comboPlan: this.planFor(r, next),
      ...(onOpening ? { onOpening } : {}),
    };
    return { index: next, intent, reason: pauseNow ? `${reason} (after a beat)` : reason };
  }

  private planFor(r: Running, step: number): NonNullable<Intent['comboPlan']> {
    return {
      setup: r.setup, zones: [...r.zones], payoffZone: r.payoffZone, step,
      ...(r.fishing ? { fishing: r.fishing } : {}), ...(r.tempo ? { tempo: [...r.tempo] } : {}),
    };
  }

  view(): PlanView | null {
    const r = this.run;
    if (!r) return null;
    return {
      setup: r.steps.slice(0, r.setup).map((t, i) => stepLabel(t, r.zones[i])),
      payoff: r.steps.slice(r.setup).map((t) => tacticWords(t)),
      payoffZone: r.payoffZone,
      note: r.note,
      step: r.i,
      phase: r.i >= r.setup ? 'payoff' : 'setup',
      read: r.read ? readHud(r.read) : null,
    };
  }
}

/** A plan view for a combo intent the body runs itself (COMBO_SEQUENCING 'body'): shown, not stepped. */
export function staticPlanView(spec: PlanSpec, me: RobotTelemetry): PlanView {
  return {
    setup: spec.steps.slice(0, spec.setup).map((t, i) => stepLabel(t, spec.zones[i])),
    payoff: spec.steps.slice(spec.setup).map((t) => tacticWords(t)),
    payoffZone: spec.payoffZone,
    note: zoneNote(me.weakSpots, spec.payoffZone),
    step: 0,
    phase: 'setup',
    read: null,
  };
}
