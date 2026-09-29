// Runs a setup → payoff combination one step at a time, until the control build runs Intent.combo
// with its comboPlan in the body (docs/design/fighter-iq-control-contract.md). Each step goes out as
// its own intent (the current controller runs one tactic per intent); the next one follows when the
// body has thrown this one (its strike skill started and ended) or its time is up. After the setup it
// waits a beat for the physics read of his answer, then picks the payoff from it:
//   covered / flinched / no bite   the planned payoff, at the zone the setup was meant to open
//   retreated                      he stepped away: a long shot instead (front kick, cross)
//   countered                      he threw back: the payoff also arms as an opening reflex, so it
//                                  lands on his whiff or overcommit without another decision
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

/** TODO(control-build): 'body' once the controller runs Intent.combo + comboPlan itself. */
export const COMBO_SEQUENCING: 'brain' | 'body' = 'brain';

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

export class ComboSequencer {
  private run: Running | null = null;

  get active(): boolean { return this.run !== null; }

  /** Begin a plan whose first step's intent (`base`) has just gone out. */
  start(spec: PlanSpec, base: Intent, s: Situation): void {
    // The body is already throwing the first step (the combo opens with the strike in the air):
    // that is step 0, so its end moves the plan on instead of waiting out STEP_TIMEOUT_S.
    const inAir = isStrikeSkill(s.me.skill) && skillAction(s.me.skill) === spec.steps[0];
    this.run = {
      ...spec, base, i: 0, stepAt: s.time, started: inAir, endedAt: null,
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
