// Tactics: the brain's Intent becomes footwork goals and skills, every control update.
//   footwork   hold_range / close_distance / circle / retreat set where the stance should be
//   strikes    walk into the skill's range, then throw it; the tactic keeps throwing it while it
//              stands, at a rate set by aggression
//   commit     a strike can be abandoned in its windup (for a reflex or a defensive tactic),
//              never once the strike phase starts
//   reflex     counterIfLunge is armed in advance and fires here, without a brain round trip,
//              the moment the opponent's windup crosses REFLEX_WINDUP inside striking range
//   aggression faster footwork, shorter windups (the skill runner), shorter pauses between strikes
//   combos     an intent with tactic 'combo' runs whole in the body (combo.ts): steps chained from
//              the last blow's recovery, tempo beats, sold feints, an adapted payoff
//   feints     the real strike's windup, sold and telegraphed past the reflex threshold, pulled by
//              choice (feint.ts); a low feint is a kick's weight shift and hip turn
// Pace (balance engine): a strike in range starts from the footing the body has (canStrikeNow: still
// moving with the DCM settled inside the soles, or from a step whose landing catches it); mid-step it
// finishes that step and throws (no new step lifts meanwhile, at most STRIKE_WAIT_S); walking in, the
// lead step that brings it in range carries an arm strike (enter WITH the blow), the stance goal
// always a real step in (no stall just outside range); close_distance at the edge of range is a
// step-in jab; aggression past PRESSURE_AGG presses (holds the pocket, cuts the cage, stays in after
// a combination), below it a combination ends with a step back out to the edge (docs/design/ring-iq.md).
import type { Intent, MoveVector, Tactic, TargetZone } from '../../core/protocol';
import { APOTHEM } from '../../core/arena-spec';
import type { SimContext } from '../sim-context';
import { canUse, TACTIC_SKILL } from './abilities';
import { adaptPayoff, COMBO, ComboRun, comboKey, FEINT_TACTICS, stepZone, wholeCombo } from './combo';
import type { HumanoidController } from './controller';
import { FEINT, feintDue, feintOf, feintSkill, fixFeintWindup } from './feint';
import { RING_IQ, RingIq } from './ring-iq';
import type { Sense } from './sense';
import { isStrikeSkill, type SkillDef, type SkillId } from './skills';
import type { SkillEnv, SkillRun } from './skills/types';

const REFLEX_WINDUP = 0.55; // opponent windup that fires a pre-armed counter
const REFLEX_RESET = 0.2; // ... re-armed once it falls back below this
const THREAT_RANGE_M = 1.35; // COM distance inside which an opponent's windup is a threat
const ARENA_LIMIT_M = APOTHEM - 0.9; // keep the stance goal this far inside the fence
const HOLD_RANGE_M = 1.2; // just outside a typical reach
const RETREAT_M = 0.8;
const CIRCLE_RAD = 0.45;
const SIDESTEP_RAD = 0.55;
const SIDESTEP_S = 0.7;
const SWEET_SPOT = 0.6; // where in a skill's range the feet aim
const THROW_ZONE = 0.85; // walking in, throw once this far into the range (not at its very edge)
const MAX_HOLD_S = { defense: 3, grapple: 2.5 } as const;
// Intent.move (player mode): a velocity request in the opponent-locked frame.
const MOVE_DEADBAND = 0.05; // |move| under this plants the feet
const MOVE_LOOKAHEAD_S = 0.8; // the goal is where the stance would be this far ahead at the asked speed
const MOVE_SAFE_SPEED = 0.25; // × √(g·z_c): the design's safe walking speed at |move| = 1
const MOVE_MIN_RANGE_M = 0.45; // walking at him never plans the stance closer than this (COM to COM)
// Ring IQ (docs/design/ring-iq.md), balance engine only: footwork never plans the stance into guard
// contact, and in range it holds its ground instead of chasing every sway of the opponent.
const GUARD_CLEARANCE_M = 0.08; // the stance stops this far short of the two guards touching (angled, bladed guards reach a little further)
const CLOSE_MARGIN_M = 0.08; // closing in, the stance aims this much further out (a walk's momentum carries it a few cm on)
// In range: a hold starts with the range between just short of the guards touching and this far
// past the goal range, and lasts until the range leaves [touching − SHORT − KEEP, goal + RANGE_HOLD_OUT_M].
const RANGE_HOLD_IN_M = 0.12;
const RANGE_HOLD_OUT_M = 0.22;
const RANGE_HOLD_SHORT_M = 0.03; // ...a hold may start this much inside the guards' standoff...
const RANGE_HOLD_KEEP_M = 0.02; // ...and once holding, keeps going this much further in (hysteresis)
const RANGE_HOLD_GAP_S = 0.05; // a hold not renewed within this long is over
const RANGE_HOLD_SPEED = 0.25; // m/s: a hold starts only from a body this close to rest
const GAP_SHARE_PRIOR = 0.3; // m/s: two fighters closing split the gap by their speeds (plus this each)

/**
 * Pace (exported so tools can sweep it; the worker never changes it). The pause after a skill is
 * cooldown[0] − cooldown[1] × aggression seconds: the legacy path keeps its own, the balance engine
 * throws again sooner (it throws from the footing it has).
 */
export const PACE = {
  cooldownLegacy: [0.9, 0.6] as const,
  cooldownEngine: [0.42, 0.32] as const,
  strikeWaitS: 0.45, // a strike in range holds the feet at most this long for the body to be ready...
  strikeReleaseS: 0.25, // ...then lets the footwork square the stance this long before holding again
  stepInMinM: 0.13, // walking in to strike, the stance goal is at least this much nearer (a real step)
  stepInReachM: 0.06, // a step whose touchdown DCM is within the throw edge plus this carries the blow
  edgeJabAggression: 0.45, // close_distance at the edge of range is a step-in jab from this aggression
  pressureAggression: 0.7, // from here footwork presses: the pocket, the cage cut, no step out after combos
  pressInM: 0.04, // pressing, hold_range keeps the lead weapon's throw edge less this
  cutRad: 0.35, // pressing, the approach swings at most this far toward the cage centre
};

/**
 * TODO(control-build): safe fallbacks for the fighter-intelligence tactics until the control build
 * performs them from mocap. Each runs the nearest move the controller already has; a combo runs
 * its first strike. Remove this map once MotionPlayer implements the real moves.
 */
const CONTROL_FALLBACK: Partial<Record<Tactic, Tactic>> = {
  tornado_kick: 'head_kick', spinning_back_kick: 'front_kick', jump_kick: 'front_kick', jumping_knee: 'front_kick',
  superman_punch: 'cross', spinning_backfist: 'hook', switch_stance: 'hold_range',
  pivot_left: 'circle_left', pivot_right: 'circle_right', feint_left: 'feint', feint_right: 'feint',
};

/** TODO(control-build): the tactic the current controller can run for `tactic`. */
export function fallbackTactic(tactic: Tactic, combo?: readonly Tactic[]): Tactic {
  if (tactic === 'combo') return fallbackTactic(combo?.find((t) => t !== 'combo') ?? 'jab');
  return CONTROL_FALLBACK[tactic] ?? tactic;
}

const FOOTWORK = new Set<Tactic>(['hold_range', 'close_distance', 'circle_left', 'circle_right', 'retreat']);
const DEFENSIVE = new Set<Tactic>(['guard', 'retreat', 'hold_range', 'circle_left', 'circle_right', 'sidestep_counter']);
/** Long shots for a payoff when he stepped away from the setup, best first. */
const LONG_SHOTS: readonly Tactic[] = ['front_kick', 'cross', 'jab'];

export class TacticRunner {
  private latched = false;
  private nextStrikeAt = 0;
  private wasActive = false;
  private sidestepUntil = -1;
  private sidestepSign = 1;
  private holdStart = -1;
  /** The stance frame held in range (balance engine), and when the hold was last renewed. */
  private held: { x: number; y: number } | null = null;
  private heldAt = -Infinity;
  /** Ring IQ (docs/design/ring-iq.md): zones from the strikes both bodies throw (balance engine). */
  readonly ring: RingIq;
  /** The intent last seen (a new one may start, abort or absorb a combination). */
  private lastIntent: Intent | null = null;
  /** The combination the body is running (combo.ts). */
  combo: ComboRun | null = null;
  /** After a combination: stepping back out to the edge until then (ring IQ). */
  private exitUntil = -1;
  /** The feint on show (pulled at its sold share), and when the last one was pulled. */
  private feintRun: SkillRun | null = null;
  private feintPulledAt = -Infinity;
  /** A strike due in range is holding the feet since then; and no holding again before. */
  private pendingSince = -1;
  private pendingOffUntil = -1;
  /** Diagnostics (tools): combinations started / completed / aborted, steps thrown. */
  readonly comboStats = { started: 0, completed: 0, aborted: 0, steps: 0 };

  constructor(private readonly c: HumanoidController) {
    this.ring = new RingIq(c);
  }

  /** The robot went down: whatever was under way is over. */
  onFall(): void {
    if (this.combo) this.endCombo(false);
    this.feintRun = null;
    this.pendingSince = -1;
    this.exitUntil = -1;
  }

  /** Without an intent (no brain attached) the robot is left to whoever drives it directly. */
  update(ctx: SimContext, s: Sense, env: SkillEnv): void {
    this.c.moveSpeed = null;
    this.c.strikePending = false;
    // Ring IQ: a walk toward him ends at the edge of range (or just outside his reach); the entry is
    // the step-drag's (and the strike's), never a walk into the guards.
    this.c.walkEnd = this.c.engine && this.c.opp && RING_IQ.enabled ? RingIq.approachRange(this.ring.read(ctx.time)) : 0;
    // REFEREE BREAK HOOK (src/physics/systems/referee.ts): while a fighter is down, the referee's
    // order beats the intent (brain or player alike): no new blows or reflexes, a blow still in its
    // windup is pulled, the feet go to the neutral spot (or hold). r.intent itself is left untouched.
    if (this.refereeBreak(ctx, env)) return;
    const intent = this.c.r.intent;
    const opp = this.c.opp;
    if (!opp || !intent) return;
    const dist = Math.hypot(opp.com[0] - s.com[0], opp.com[1] - s.com[1]);
    const aggression = intent.aggression;
    this.c.timing = { ...this.c.timing, swing: 0.3 * (1.2 - 0.4 * aggression) * (this.c.r.design.abilities.includes('sprint') ? 0.85 : 1) };
    this.trackCooldown(ctx, aggression);
    this.trackIntent(ctx, intent);
    this.pullFeint(ctx, env);
    if (!this.reflex(ctx, s, env, intent, dist)) {
      if (this.combo) this.runCombo(ctx, s, env, intent, dist);
      else if (ctx.time < this.exitUntil) this.exit(s, dist);
      else this.run(ctx, s, env, intent.tactic, intent.target, aggression, dist, intent.comboPlan?.step !== undefined);
    }
    // Player mode: the footwork follows Intent.move; the tactic only picked the strike or defence.
    if (intent.move) this.followMove(s, intent.move, dist);
  }

  /**
   * Intent.move (docs/design/player-mode-integration.md): the vector is a velocity request in the
   * opponent-locked frame (forward = straight at him, strafe = to this fighter's own right, counter-
   * clockwise around him seen from above), scaled to the design's safe walking speed; {0, 0} plants
   * the feet where they are. It becomes a stance goal the asked speed would reach shortly; the
   * balance engine owns the footholds and may slow or refuse any step (a saturated gyro, a bad leg,
   * a strike under way).
   */
  private followMove(s: Sense, m: MoveVector, dist: number): void {
    const mag = Math.min(1, Math.hypot(m.forward, m.strafe));
    if (mag < MOVE_DEADBAND) {
      this.c.goal = null;
      return;
    }
    const o = this.c.opp!.com;
    const ux = (o[0] - s.com[0]) / Math.max(1e-6, dist), uy = (o[1] - s.com[1]) / Math.max(1e-6, dist);
    const speed = mag * MOVE_SAFE_SPEED * (9.81 / s.omega0); // √(g·z_c) = g / ω₀
    const k = (speed * MOVE_LOOKAHEAD_S) / Math.hypot(m.forward, m.strafe);
    // Forward along the line to him, strafe to this fighter's right (−y of its facing): (uy, −ux).
    let dx = (m.forward * ux + m.strafe * uy) * k;
    let dy = (m.forward * uy - m.strafe * ux) * k;
    const cur = this.c.gait.bothPlanted() ? this.c.gait.currentFrame() : { x: s.com[0], y: s.com[1], heading: 0 };
    // Never plan the stance into him.
    const along = dx * ux + dy * uy;
    // (Balance engine: never into his guard either, ring IQ.)
    const room = dist - (this.c.engine && RING_IQ.enabled ? Math.max(MOVE_MIN_RANGE_M, this.ring.read(s.time).standoff) : MOVE_MIN_RANGE_M);
    if (along > room) {
      const cut = along - Math.max(0, room);
      dx -= ux * cut;
      dy -= uy * cut;
    }
    let x = cur.x + dx, y = cur.y + dy;
    const rr = Math.hypot(x, y);
    if (rr > ARENA_LIMIT_M) {
      x *= ARENA_LIMIT_M / rr;
      y *= ARENA_LIMIT_M / rr;
    }
    this.c.goal = { x, y, heading: Math.atan2(o[1] - y, o[0] - x) };
    this.c.moveSpeed = speed;
  }

  /** Referee break hook (see update): obeys the referee's order; true while there is one. */
  private refereeBreak(ctx: SimContext, env: SkillEnv): boolean {
    const order = ctx.referee?.orders[this.c.r.corner];
    if (!order) return false;
    const run = this.c.skills.run;
    // A guard may stay up; a clinch lets go; anything else is pulled only while still in its windup.
    if (run && (run.def.kind === 'grapple' || (run.phase === 'windup' && run.def.kind !== 'defense'))) this.c.skills.cancel(env, run.def.kind === 'grapple');
    this.c.goal = order.goal;
    // Nothing from before the break carries over into FIGHT (a pulled feint, a sidestep, a latched
    // reflex, a combination under way, a strike waiting for the feet).
    this.feintRun = null;
    this.latched = false;
    this.sidestepUntil = -1;
    this.pendingSince = -1;
    this.exitUntil = -1;
    if (this.combo) this.endCombo(false);
    this.lastIntent = this.c.r.intent;
    this.wasActive = this.c.skills.active();
    return true;
  }

  /** The runner just finished a skill: pause before the next one (a combination does not). */
  private trackCooldown(ctx: SimContext, aggression: number): void {
    const active = this.c.skills.active();
    const [a, b] = this.c.engine ? PACE.cooldownEngine : PACE.cooldownLegacy;
    if (this.wasActive && !active) this.nextStrikeAt = ctx.time + Math.max(0.05, a - b * aggression);
    this.wasActive = active;
  }

  /**
   * A new intent (every intent message, even one identical to the last): a combination that differs
   * from the one running stops it; a whole combination starts; a brain-sequenced step of the one the
   * body is running is absorbed (the body is on it already).
   */
  private trackIntent(ctx: SimContext, intent: Intent): void {
    if (intent === this.lastIntent) return;
    this.lastIntent = intent;
    this.exitUntil = -1;
    const key = comboKey(intent);
    if (this.combo && this.combo.key !== key) this.endCombo(false);
    if (wholeCombo(intent) && !this.combo) {
      this.combo = new ComboRun(intent, ctx.time, this.c.feintRead(ctx)?.seq ?? 0);
      this.comboStats.started++;
    }
  }

  private endCombo(done: boolean): void {
    if (!this.combo) return;
    if (done) this.comboStats.completed++;
    else this.comboStats.aborted++;
    this.combo = null;
  }

  /** Pull a feint on show once its sold share of the windup is out (by choice: the physics reads it). */
  private pullFeint(ctx: SimContext, env: SkillEnv): void {
    const run = this.feintRun;
    if (!run) return;
    if (this.c.skills.run !== run) {
      this.feintRun = null; // it ended some other way (a knockdown, a reflex)
      return;
    }
    const lent = run.def.kind === 'leg' && this.c.gait.skillLegActive() === run.def.side;
    if (!feintDue(run, lent)) return;
    this.c.skills.cancel(env);
    this.feintRun = null;
    this.feintPulledAt = ctx.time;
    if (this.combo?.current === run) this.stepEnded(ctx.time);
  }

  private reflex(ctx: SimContext, s: Sense, env: SkillEnv, intent: Intent, dist: number): boolean {
    const w = this.c.opp!.windup;
    if (w < REFLEX_RESET) this.latched = false;
    const counter = intent.counterIfLunge;
    if (!counter || this.latched || w < REFLEX_WINDUP || dist > THREAT_RANGE_M) return false;
    this.latched = true;
    if (this.c.skills.committed()) return false; // our own blow is already on its way
    this.c.skills.cancel(env);
    this.feintRun = null;
    if (this.combo) this.endCombo(false); // he struck first: the combination is off
    this.run(ctx, s, env, counter, intent.target, Math.max(0.7, intent.aggression), dist, true);
    return true;
  }

  /** `now`: throw without the single-strike cooldown (a reflex, a brain-sequenced combination step). */
  private run(ctx: SimContext, s: Sense, env: SkillEnv, wanted: Tactic, zone: TargetZone, aggression: number, dist: number, now: boolean): void {
    // (A brain-sequenced step, comboPlan.step set, runs as a single tactic without the cooldown, also
    // when the body has run that combination whole already: the brain is behind the body.)
    const intent = this.c.r.intent;
    if (wanted === 'feint_left' || wanted === 'feint_right') return void this.feint(ctx, s, zone, wanted === 'feint_left' ? 'l' : 'r', aggression, dist, false);
    const tactic = fallbackTactic(wanted, intent?.combo); // TODO(control-build)
    const runner = this.c.skills;
    // A defensive call abandons a strike that has not been committed yet (a feint on show is pulled at its point).
    const running = runner.run;
    if (running && running.phase === 'windup' && isStrikeSkill(running.def) && DEFENSIVE.has(tactic) && running !== this.feintRun) runner.cancel(env);
    if (tactic === 'sidestep_counter') return this.sidestepCounter(ctx, s, env, zone, aggression, dist);
    if (tactic === 'close_distance' && this.edgeJab(ctx, s, aggression, dist)) return;
    if (FOOTWORK.has(tactic)) return this.footwork(s, tactic, dist, aggression);
    if (tactic === 'feint') return void this.feint(ctx, s, zone, undefined, aggression, dist, false);
    const id = TACTIC_SKILL[tactic];
    const def = id ? this.usable(id) : null;
    if (!def) return this.footwork(s, 'close_distance', dist, aggression);
    if (def.kind === 'defense' || def.kind === 'grapple') return this.hold(ctx, s, def, zone, aggression, dist);
    this.strike(ctx, s, env, def, zone, aggression, dist, now, false);
  }

  /** The skill for `id` if this robot can still run it, else the nearest usable strike. */
  private usable(id: SkillId): SkillDef | null {
    const def = this.c.skillFor(id);
    if (def && canUse(this.c.r, def) && (id === 'guard' || this.c.r.design.abilities.includes(id as never))) return def;
    if (def?.kind === 'defense') return null;
    const kind = def?.kind ?? 'arm';
    const pool = this.c.r.design.abilities.map((a) => this.c.skillFor(a as SkillId)).filter((d): d is SkillDef => !!d && isStrikeSkill(d) && canUse(this.c.r, d));
    return pool.find((d) => d.kind === kind) ?? pool[0] ?? null;
  }

  private footwork(s: Sense, tactic: Tactic, dist: number, aggression: number): void {
    switch (tactic) {
      case 'close_distance': return this.goalAt(s, this.c.engine ? Math.max(this.closeRange(), this.standoff() + CLOSE_MARGIN_M) : this.closeRange(), 0, true, aggression);
      case 'circle_left': return this.goalAt(s, this.circleRange(s, dist), CIRCLE_RAD);
      case 'circle_right': return this.goalAt(s, this.circleRange(s, dist), -CIRCLE_RAD);
      case 'retreat': return this.goalAt(s, Math.min(dist + RETREAT_M, 2 * APOTHEM), 0);
      default: return this.goalAt(s, this.c.engine && RING_IQ.enabled ? this.holdRange(s, aggression) : HOLD_RANGE_M, 0, true, aggression);
    }
  }

  /**
   * Balance engine, hold_range: just outside his longest reach (ring IQ's 'outside'), never in the
   * guards. Pressing (aggression past PACE.pressureAggression), the pocket instead: just inside the
   * lead weapon's throw edge, so the next blow lands from where the feet are.
   */
  private holdRange(s: Sense, aggression: number): number {
    const f = this.ring.read(s.time);
    if (aggression >= PACE.pressureAggression) {
      const lead = this.leadWeapon();
      if (lead) return Math.max(f.standoff + 0.02, lead.edge - PACE.pressInM);
    }
    return Math.max(f.standoff + 0.05, f.hisReach + 0.08);
  }

  /** Circling keeps the range it has (within limits), and on the balance engine stays out of the guards. */
  private circleRange(s: Sense, dist: number): number {
    const d = clampRange(dist);
    return this.c.engine && RING_IQ.enabled ? Math.max(d, this.ring.read(s.time).standoff + 0.02) : d;
  }

  /** Inside the shortest reach among this robot's strikes: where it can throw anything. */
  private closeRange(): number {
    let best = HOLD_RANGE_M;
    for (const a of this.c.r.design.abilities) {
      const d = this.c.skillFor(a as SkillId);
      if (!d || !isStrikeSkill(d)) continue;
      const [lo, hi] = d.range(this.c.geo);
      best = Math.min(best, lo + SWEET_SPOT * (hi - lo));
    }
    return best;
  }

  /** The lead hand's quick strike (the jab, else the first arm strike it has) and its throw edge. */
  private leadWeapon(): { def: SkillDef; edge: number } | null {
    const def = this.usable('jab');
    if (!def || def.kind !== 'arm') return null;
    const [lo, hi] = def.range(this.c.geo);
    return { def, edge: lo + (def.approach?.throwAt ?? THROW_ZONE) * (hi - lo) };
  }

  /**
   * Ring IQ (docs/design/ring-iq.md, the mind side's note (a)): close_distance at the edge, one
   * step from the lead weapon's range, is not a walk into the guards but a step-in jab. Balance
   * engine only; true while it runs that strike.
   */
  private edgeJab(ctx: SimContext, s: Sense, aggression: number, dist: number): boolean {
    if (!this.c.engine || !RING_IQ.enabled || aggression < PACE.edgeJabAggression) return false;
    const lead = this.leadWeapon();
    if (!lead) return false;
    const stride = 0.38 * this.c.geo.legLength;
    if (dist <= lead.edge || dist > lead.edge + stride) return false;
    this.strike(ctx, s, null, lead.def, 'head', aggression, dist, false, false);
    return true;
  }

  /**
   * Throw `def` from the footing the body has, or walk into its range first. Returns true when the
   * strike started this tick. `chain`: a combination step may start from the last blow's recovery.
   */
  private strike(ctx: SimContext, s: Sense, env: SkillEnv | null, def: SkillDef, zone: TargetZone, aggression: number, dist: number, now: boolean, chain: boolean): boolean {
    const run = this.c.skills.run;
    if (run) {
      if (!chain || !env || !this.chainable(run)) {
        this.still();
        return false;
      }
      this.c.skills.handOff(env);
      if (this.combo?.current === run) this.stepEnded(ctx.time);
    }
    const e = this.c.engine;
    const [lo, hi] = def.range(this.c.geo);
    const { sweet, throwAt } = def.approach ?? { sweet: SWEET_SPOT, throwAt: THROW_ZONE };
    const edge = lo + throwAt * (hi - lo);
    // A player's strike goes from where he stands (docs/design/player-mode-integration.md §6): a whiff is his.
    const player = this.c.r.intent?.source === 'player';
    if (!player && (dist > edge || dist < lo)) {
      this.pendingSince = -1;
      const want = this.strikeRange(lo + sweet * (hi - lo), edge);
      // Walking in, the goal is always a real step nearer (a goal inside the feet's tolerance stalls
      // the body just short of range for good); the step that brings an arm strike in range carries it.
      this.goalAt(s, e && dist > edge ? Math.min(want, dist - PACE.stepInMinM) : want, 0, false);
      if (e && def.kind === 'arm' && dist > edge && (now || ctx.time >= this.nextStrikeAt) && this.stepInReady(edge)) return this.start(def, zone, aggression);
      return false;
    }
    this.still();
    if (!now && ctx.time < this.nextStrikeAt) return false;
    const ready = def.kind === 'leg' ? this.c.readyToKick() : this.c.canStrikeNow();
    if (ready && (e || (this.c.gait.phase === 'double' && this.c.gait.bothPlanted()))) return this.start(def, zone, aggression);
    // Not yet: the step in the air lands, then the blow (no new step meanwhile, for a while).
    if (e) this.pend(ctx);
    return false;
  }

  private start(def: SkillDef, zone: TargetZone, aggression: number): boolean {
    const ok = this.c.startSkill(def, zone === 'weapon' ? def.defaultZone : zone, aggression);
    if (ok) this.pendingSince = -1;
    return ok;
  }

  /** A strike due in range holds the feet (balance engine) for at most PACE.strikeWaitS, then lets them go a while. */
  private pend(ctx: SimContext): void {
    if (ctx.time < this.pendingOffUntil) return;
    if (this.pendingSince < 0) this.pendingSince = ctx.time;
    if (ctx.time - this.pendingSince <= PACE.strikeWaitS) {
      this.c.strikePending = true;
      return;
    }
    this.pendingSince = -1;
    this.pendingOffUntil = ctx.time + PACE.strikeReleaseS;
  }

  /**
   * Balance engine: the lead step in the air will bring the body into range (its DCM at the
   * touchdown within the throw edge), and the engine lets an arm strike go from it (canStrike from a
   * step whose landing catches the DCM).
   */
  private stepInReady(edge: number): boolean {
    const e = this.c.engine!;
    const g = this.c.gait;
    if (g.phase !== 'single' || !e.state.canStrike) return false;
    const o = this.c.opp!.com;
    const t = e.state.xiTouch;
    return Math.hypot(o[0] - t[0], o[1] - t[1]) <= edge + PACE.stepInReachM && this.c.canStrikeNow();
  }

  /** A blow in its recovery past COMBO.chainAt (punches only: a kick's leg comes down first). */
  private chainable(run: SkillRun): boolean {
    if (run.def.kind !== 'arm' || run.phase !== 'recover') return false;
    const u = run.u ?? run.t / Math.max(1e-3, run.durations.recover);
    return u >= COMBO.chainAt;
  }

  /** Guard and clinch: start it (walking in first for a clinch), then hold it while the tactic stands. */
  private hold(ctx: SimContext, s: Sense, def: SkillDef, zone: TargetZone, aggression: number, dist: number): void {
    const run = this.c.skills.run;
    if (run?.def === def) {
      const limit = MAX_HOLD_S[def.kind as keyof typeof MAX_HOLD_S] ?? 2;
      if (run.phase === 'strike' && ctx.time - this.holdStart < limit) this.c.skills.sustain();
      return this.still();
    }
    if (this.c.skills.active()) return this.still();
    const [lo, hi] = def.range(this.c.geo);
    if (dist > lo + THROW_ZONE * (hi - lo)) return this.goalAt(s, lo + SWEET_SPOT * (hi - lo), 0, false);
    this.still();
    if (this.c.gait.phase !== 'double' || !this.c.gait.bothPlanted()) return;
    if (this.c.startSkill(def, zone, aggression)) this.holdStart = ctx.time;
  }

  /**
   * Show a feint (feint.ts): the faked strike's own windup, sold, pulled at its point (pullFeint).
   * Shown from where that strike would land, or a step out. Returns true when one started this tick.
   * A lone feint tactic shows the next one no sooner than FEINT.restS after the last pull.
   */
  private feint(ctx: SimContext, s: Sense, zone: TargetZone, hand: 'l' | 'r' | undefined, aggression: number, dist: number, inCombo: boolean): boolean {
    if (this.feintRun || this.c.skills.active()) {
      this.still();
      return false;
    }
    const base = feintSkill(this.c, zone, hand);
    if (!base) {
      this.still();
      return false;
    }
    const hi = base.range(this.c.geo)[1];
    if (dist > hi + 0.3) {
      this.goalAt(s, hi, 0, false);
      return false;
    }
    this.still();
    if (!inCombo && ctx.time < Math.max(this.nextStrikeAt, this.feintPulledAt + FEINT.restS)) return false;
    const ready = base.kind === 'leg' ? this.c.readyToKick() && this.c.gait.phase === 'double' && this.c.gait.bothPlanted() : this.c.canStrikeNow();
    if (!ready) {
      if (this.c.engine) this.pend(ctx);
      return false;
    }
    if (!this.c.startSkill(feintOf(base), zone === 'weapon' ? 'head' : zone, aggression)) return false;
    const run = this.c.skills.run!;
    fixFeintWindup(run);
    this.feintRun = run;
    this.pendingSince = -1;
    return true;
  }

  // ---------------------------------------------------------------- combinations (combo.ts)

  /** The last step thrown has ended (handed over, pulled or finished). */
  private stepEnded(time: number): void {
    const cb = this.combo;
    if (!cb) return;
    cb.current = null;
    cb.lastEndAt = time;
    cb.dueAt = time;
    if (cb.i === cb.setup && cb.setup > 0) cb.setupEndedAt = time;
  }

  /** One update of the combination the body runs: its next step, its beat, its payoff. */
  private runCombo(ctx: SimContext, s: Sense, env: SkillEnv, intent: Intent, dist: number): void {
    const cb = this.combo!;
    const t = ctx.time;
    const opp = this.c.opp!;
    if (opp.down || opp.robot.down) return this.endCombo(false);
    const run = this.c.skills.run;
    if (cb.current && run !== cb.current) this.stepEnded(t);
    if (cb.i >= cb.steps.length) {
      // Every step thrown: done once the last one is over.
      if (run) return this.still();
      this.endCombo(true);
      if (this.c.engine && RING_IQ.enabled && intent.aggression < PACE.pressureAggression) this.exitUntil = t + COMBO.exitS;
      return this.still();
    }
    let step = cb.steps[cb.i];
    let zone = cb.zones[cb.i];
    // The beat before this step (tempo): guard up in stance, nothing thrown, counted from the end of
    // the step before.
    const beat = cb.tempo[cb.i] ?? 0;
    if (beat > 0 && cb.beatUntil < 0) {
      if (run) return this.still();
      cb.beatUntil = t + beat;
    }
    if (cb.beatUntil > t) return this.still();
    // The payoff: within COMBO.payoffWaitS of the setup, at once on a fresh read; adapted to it.
    if (cb.i === cb.setup && cb.setup > 0) {
      const read = this.c.feintRead(ctx);
      if (read && read.seq > cb.readSeq0) cb.read = read;
      if (!cb.read && !run && cb.setupEndedAt >= 0 && t - cb.setupEndedAt < COMBO.payoffWaitS) return this.still();
      const long = LONG_SHOTS.filter((x) => this.usable(TACTIC_SKILL[x]!)?.id === x);
      const p = adaptPayoff(step, zone, cb.read, long);
      step = p.tactic;
      zone = p.zone;
    }
    const aggression = cb.payoff() ? Math.max(intent.aggression, COMBO.payoffAggression) : intent.aggression;
    let started = false;
    if (FEINT_TACTICS.has(step)) {
      if (run && this.chainable(run)) {
        this.c.skills.handOff(env);
        if (cb.current === run) this.stepEnded(t);
      }
      started = this.feint(ctx, s, zone, step === 'feint_left' ? 'l' : step === 'feint_right' ? 'r' : undefined, aggression, dist, true);
    } else {
      const tactic = fallbackTactic(step);
      const id = TACTIC_SKILL[tactic];
      const def = id ? this.usable(id) : null;
      if (!def || !isStrikeSkill(def)) {
        // A step the body has no blow for (a stance switch, a pivot): a short beat in stance.
        if (run) return this.still();
        if (cb.beatUntil < 0) cb.beatUntil = t + COMBO.beatS;
        if (t < cb.beatUntil) return this.still();
        return this.advance(cb, t, null);
      }
      const hi = def.range(this.c.geo)[1];
      if (dist > hi + COMBO.reachSlackM) return this.endCombo(false); // he is gone: the combination is off
      started = this.strike(ctx, s, env, def, stepZone(step, zone), aggression, dist, true, true);
    }
    if (started) return this.advance(cb, t, this.c.skills.run);
    // A step that cannot start in time is skipped (out of range, off balance): keep the pace.
    if (!run && t - cb.dueAt > COMBO.stepTimeoutS) this.advance(cb, t, null);
  }

  private advance(cb: ComboRun, t: number, run: SkillRun | null): void {
    cb.current = run;
    cb.i++;
    cb.beatUntil = -1;
    cb.dueAt = t;
    if (run) this.comboStats.steps++;
    if (!run) cb.lastEndAt = t;
    if (!run && cb.i === cb.setup && cb.setup > 0) cb.setupEndedAt = t;
  }

  /** After a combination (not pressing): back out to the edge of range, facing him (ring IQ). */
  private exit(s: Sense, dist: number): void {
    if (this.c.skills.active()) return this.still();
    const back = this.c.engine && RING_IQ.enabled ? RingIq.approachRange(this.ring.read(s.time)) : HOLD_RANGE_M;
    if (dist >= back - 0.02) return this.still();
    this.goalAt(s, back, 0, false);
  }

  /** Wait for the opponent to commit, step off its line, and answer from the new angle. */
  private sidestepCounter(ctx: SimContext, s: Sense, env: SkillEnv, zone: TargetZone, aggression: number, dist: number): void {
    const opp = this.c.opp!;
    if (ctx.time < this.sidestepUntil) return this.goalAt(s, clampRange(dist), this.sidestepSign * SIDESTEP_RAD);
    if (this.sidestepUntil > 0) {
      // Just stepped off: counter with the heaviest hand that reaches.
      this.sidestepUntil = -1;
      const def = this.usable('cross') ?? this.usable('hook');
      if (def) return void this.strike(ctx, s, env, def, zone, aggression, dist, true, false);
    }
    if (opp.windup >= REFLEX_WINDUP * 0.8 && dist < THREAT_RANGE_M) {
      // Step away from the side the blow comes from: a right hand is answered by moving left.
      this.sidestepSign = opp.skill.endsWith('_r') || ['cross', 'overhand', 'low_kick', 'head_kick', 'rocket_punch', 'uppercut'].includes(opp.skill) ? 1 : -1;
      this.sidestepUntil = ctx.time + SIDESTEP_S;
      this.c.skills.cancel(env);
      this.feintRun = null;
      return this.goalAt(s, clampRange(dist), this.sidestepSign * SIDESTEP_RAD);
    }
    this.goalAt(s, HOLD_RANGE_M * 0.9, 0);
  }

  private still(): void {
    this.c.goal = null;
  }

  /**
   * Balance engine: how far from the opponent to plan the stance so that `d` is where the two end up.
   * Two fighters closing on each other each re-aim at the other every step: each planning the whole
   * gap meets the other guard to guard. So the gap beyond `d` is split by their speeds toward each
   * other (each with a small prior, so two fighters starting together each plan half, and one who
   * stands still leaves the whole gap to the other).
   */
  private sharedRange(s: Sense, d: number): number {
    const opp = this.c.opp!;
    const dx = s.com[0] - opp.com[0], dy = s.com[1] - opp.com[1];
    const dist = Math.hypot(dx, dy);
    if (dist <= d || dist < 1e-6) return d;
    const ux = dx / dist, uy = dy / dist;
    const vHim = Math.max(0, opp.vel[0] * ux + opp.vel[1] * uy);
    const vMe = Math.max(0, -(s.comVel[0] * ux + s.comVel[1] * uy));
    const share = (vMe + GAP_SHARE_PRIOR) / (vMe + vHim + 2 * GAP_SHARE_PRIOR);
    return d + (dist - d) * (1 - share);
  }

  /**
   * COM-to-COM range at which the two guards would touch, plus a little clearance (balance engine).
   * Footwork stops here; a strike that reaches from here is thrown from here, a shorter one walks in.
   */
  private standoff(): number {
    const opp = this.c.opp?.robot.mem.control as HumanoidController | undefined;
    const mine = this.c.guardReach();
    return mine + (opp?.guardReach ? opp.guardReach() : mine) + GUARD_CLEARANCE_M;
  }

  /** Where to stand to throw a strike whose sweet spot is `sweet` and which reaches from `reach`. */
  private strikeRange(sweet: number, reach: number): number {
    if (!this.c.engine) return sweet;
    const off = this.standoff();
    return off <= reach - 0.03 ? Math.max(sweet, off) : sweet;
  }

  /**
   * Stand `d` from the opponent, rotated `turn` around it, facing it, inside the cage. `footwork`:
   * on the balance engine, footwork shares the gap with an opponent walking in (sharedRange) and
   * holds its ground once in range (holdInRange). Walking in to throw, feint or clinch does neither:
   * it needs its own range now, and that may be inside the guards' standoff, where a hold, or a
   * goal that only ever covers part of the gap to a fighter standing still, stops it short for good
   * (the feet do not take steps shorter than FOOTWORK_TUNING.holdTol). Pressing (balance engine,
   * aggression past PACE.pressureAggression), footwork comes in from the cage centre's side: a
   * fighter backing off is cut off against the fence instead of followed round it.
   */
  private goalAt(s: Sense, dWant: number, turn: number, footwork = true, aggression = 0): void {
    const o = this.c.opp!.com;
    // (A COM-to-COM range; the goal is the stance frame, whose centre stands behind the COM.)
    const d = this.c.engine ? (turn === 0 && footwork ? this.sharedRange(s, dWant) : dWant) + this.c.comLead() : dWant;
    let ang = Math.atan2(s.com[1] - o[1], s.com[0] - o[0]) + turn;
    if (this.c.engine && turn === 0 && footwork && aggression >= PACE.pressureAggression) ang += this.cageCut(ang, o);
    let x = o[0] + Math.cos(ang) * d;
    let y = o[1] + Math.sin(ang) * d;
    const rr = Math.hypot(x, y);
    if (rr > ARENA_LIMIT_M) {
      x *= ARENA_LIMIT_M / rr;
      y *= ARENA_LIMIT_M / rr;
    }
    if (this.c.engine && turn === 0 && footwork && this.holdInRange(s, dWant)) return;
    if (!footwork) this.held = null;
    this.c.goal = { x, y, heading: Math.atan2(o[1] - y, o[0] - x) };
  }

  /**
   * Cutting the cage: the angle (rad) to swing the approach toward the side of him that faces the
   * cage centre, more the nearer he is to the fence (none with him in the middle).
   */
  private cageCut(ang: number, o: readonly number[]): number {
    const r = Math.hypot(o[0], o[1]);
    const near = Math.min(1, Math.max(0, (r - 0.5) / Math.max(0.5, ARENA_LIMIT_M - 0.5)));
    if (near <= 0) return 0;
    const toCentre = Math.atan2(-o[1], -o[0]);
    const off = Math.atan2(Math.sin(toCentre - ang), Math.cos(toCentre - ang));
    return Math.max(-PACE.cutRad, Math.min(PACE.cutRad, off)) * near;
  }

  /**
   * Balance engine, in range: hold the stance where it stands, facing the opponent, instead of
   * chasing every sway of his (both fighters re-aim at each other every tick, so two goals that
   * chase each other never settle). The feet step again once the range is off by more than the
   * hold band. The held frame stays the goal, so the stance is still a target the feet stand on.
   * The range is measured from this body's DCM (where its momentum carries it) to his COM.
   */
  private holdInRange(s: Sense, d: number): boolean {
    const g = this.c.gait;
    const opp = this.c.opp!;
    const o = opp.com;
    const xi = this.c.engine!.state.xi;
    const dist = Math.hypot(o[0] - xi[0], o[1] - xi[1]);
    const renewed = this.held !== null && s.time - this.heldAt <= RANGE_HOLD_GAP_S;
    const settled = renewed || (g.phase === 'double' && g.bothPlanted() && Math.hypot(s.comVel[0], s.comVel[1]) < RANGE_HOLD_SPEED);
    // The band around the goal range, never reaching into the guards (unless the goal itself is
    // inside them: a short strike walked into).
    const band = renewed ? RANGE_HOLD_OUT_M : RANGE_HOLD_IN_M;
    // (A hold under way keeps going a little further in than one may start: the other way round,
    // a range between the two limits made the hold flicker on and off every tick, the goal with it.)
    const touch = this.standoff() - (renewed ? RANGE_HOLD_SHORT_M + RANGE_HOLD_KEEP_M : RANGE_HOLD_SHORT_M);
    const near = d < touch ? d - band : Math.max(touch, d - band);
    const far = d + band;
    if (dist < near || dist > far || !settled) {
      this.held = null;
      return false;
    }
    if (!renewed) {
      // Where the feet are going to stand: the end of the steps still planned (an arrival's last
      // drag), else where they stand now.
      const e = this.c.engine!;
      const f = e.planner.count > e.planner.next || !g.bothPlanted() ? e.planner.endFrame : g.currentFrame();
      this.held = { x: f.x, y: f.y };
    }
    this.heldAt = s.time;
    const h = this.held!;
    this.c.goal = { x: h.x, y: h.y, heading: Math.atan2(opp.com[1] - h.y, opp.com[0] - h.x) };
    return true;
  }
}

const clampRange = (d: number): number => Math.max(0.85, Math.min(1.4, d));
