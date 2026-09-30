// Tactics: the brain's Intent becomes footwork goals and skills, every control update.
//   footwork   hold_range / close_distance / circle / retreat set where the stance should be
//   strikes    walk into the skill's range, then throw it from a set stance; the tactic keeps
//              throwing it while it stands, at a rate set by aggression
//   commit     a strike can be abandoned in its windup (for a reflex or a defensive tactic),
//              never once the strike phase starts
//   reflex     counterIfLunge is armed in advance and fires here, without a brain round trip,
//              the moment the opponent's windup crosses REFLEX_WINDUP inside striking range
//   aggression faster footwork, shorter windups (the skill runner), shorter pauses between strikes
import type { Intent, MoveVector, Tactic, TargetZone } from '../../core/protocol';
import { APOTHEM } from '../../core/arena-spec';
import type { SimContext } from '../sim-context';
import { canUse, TACTIC_SKILL } from './abilities';
import type { HumanoidController } from './controller';
import type { Sense } from './sense';
import { isStrikeSkill, type SkillDef, type SkillId } from './skills';
import type { SkillEnv } from './skills/types';

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
const FEINT_AT = 0.6; // a feint is pulled at this fraction of its windup
const MAX_HOLD_S = { defense: 3, grapple: 2.5 } as const;
// Intent.move (player mode): a velocity request in the opponent-locked frame.
const MOVE_DEADBAND = 0.05; // |move| under this plants the feet
const MOVE_LOOKAHEAD_S = 0.8; // the goal is where the stance would be this far ahead at the asked speed
const MOVE_SAFE_SPEED = 0.25; // × √(g·z_c): the design's safe walking speed at |move| = 1
const MOVE_MIN_RANGE_M = 0.45; // walking at him never plans the stance closer than this (COM to COM)

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

export class TacticRunner {
  private latched = false;
  private nextStrikeAt = 0;
  private wasActive = false;
  private feint = false;
  private sidestepUntil = -1;
  private sidestepSign = 1;
  private holdStart = -1;

  constructor(private readonly c: HumanoidController) {}

  /** Without an intent (no brain attached) the robot is left to whoever drives it directly. */
  update(ctx: SimContext, s: Sense, env: SkillEnv): void {
    this.c.moveSpeed = null;
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
    if (!this.reflex(ctx, s, env, intent, dist)) this.run(ctx, s, env, intent.tactic, intent.target, aggression, dist, false);
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
    const room = dist - MOVE_MIN_RANGE_M;
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
    // Nothing from before the break carries over into FIGHT (a pulled feint, a sidestep, a latched reflex).
    this.feint = false;
    this.latched = false;
    this.sidestepUntil = -1;
    this.wasActive = this.c.skills.active();
    return true;
  }

  /** The runner just finished a skill: pause before the next one. */
  private trackCooldown(ctx: SimContext, aggression: number): void {
    const active = this.c.skills.active();
    if (this.wasActive && !active) this.nextStrikeAt = ctx.time + (0.9 - 0.6 * aggression);
    this.wasActive = active;
  }

  private reflex(ctx: SimContext, s: Sense, env: SkillEnv, intent: Intent, dist: number): boolean {
    const w = this.c.opp!.windup;
    if (w < REFLEX_RESET) this.latched = false;
    const counter = intent.counterIfLunge;
    if (!counter || this.latched || w < REFLEX_WINDUP || dist > THREAT_RANGE_M) return false;
    this.latched = true;
    if (this.c.skills.committed()) return false; // our own blow is already on its way
    this.c.skills.cancel(env);
    this.run(ctx, s, env, counter, intent.target, Math.max(0.7, intent.aggression), dist, true);
    return true;
  }

  private run(ctx: SimContext, s: Sense, env: SkillEnv, wanted: Tactic, zone: TargetZone, aggression: number, dist: number, now: boolean): void {
    const tactic = fallbackTactic(wanted, this.c.r.intent?.combo); // TODO(control-build)
    const runner = this.c.skills;
    // A defensive call abandons a strike that has not been committed yet.
    const running = runner.run;
    if (running && running.phase === 'windup' && isStrikeSkill(running.def) && DEFENSIVE.has(tactic) && !this.feint) runner.cancel(env);
    if (tactic === 'sidestep_counter') return this.sidestepCounter(ctx, s, env, zone, aggression, dist);
    if (FOOTWORK.has(tactic)) return this.footwork(s, tactic, dist);
    if (tactic === 'feint') return this.feintStrike(ctx, s, env, dist);
    const id = TACTIC_SKILL[tactic];
    const def = id ? this.usable(id) : null;
    if (!def) return this.footwork(s, 'close_distance', dist);
    if (def.kind === 'defense' || def.kind === 'grapple') return this.hold(ctx, s, def, zone, aggression, dist);
    this.strike(ctx, s, def, zone, aggression, dist, now);
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

  private footwork(s: Sense, tactic: Tactic, dist: number): void {
    switch (tactic) {
      case 'close_distance': return this.goalAt(s, this.closeRange(), 0);
      case 'circle_left': return this.goalAt(s, clampRange(dist), CIRCLE_RAD);
      case 'circle_right': return this.goalAt(s, clampRange(dist), -CIRCLE_RAD);
      case 'retreat': return this.goalAt(s, Math.min(dist + RETREAT_M, 2 * APOTHEM), 0);
      default: return this.goalAt(s, HOLD_RANGE_M, 0);
    }
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

  private strike(ctx: SimContext, s: Sense, def: SkillDef, zone: TargetZone, aggression: number, dist: number, now: boolean): void {
    if (this.c.skills.active()) return this.still();
    const [lo, hi] = def.range(this.c.geo);
    const { sweet, throwAt } = def.approach ?? { sweet: SWEET_SPOT, throwAt: THROW_ZONE };
    if (dist > lo + throwAt * (hi - lo) || dist < lo) return this.goalAt(s, lo + sweet * (hi - lo), 0);
    this.still();
    if (!now && ctx.time < this.nextStrikeAt) return;
    const ready = def.kind === 'leg' ? this.c.readyToKick() : this.c.readyToStrike();
    if (this.c.gait.phase !== 'double' || !this.c.gait.bothPlanted() || !ready) return;
    this.c.startSkill(def, zone === 'weapon' ? def.defaultZone : zone, aggression);
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
    if (dist > lo + THROW_ZONE * (hi - lo)) return this.goalAt(s, lo + SWEET_SPOT * (hi - lo), 0);
    this.still();
    if (this.c.gait.phase !== 'double' || !this.c.gait.bothPlanted()) return;
    if (this.c.startSkill(def, zone, aggression)) this.holdStart = ctx.time;
  }

  /** Show a windup and pull it before it commits: the opponent's reflexes read the telegraph. */
  private feintStrike(ctx: SimContext, s: Sense, env: SkillEnv, dist: number): void {
    const run = this.c.skills.run;
    if (run && this.feint) {
      if (run.phase === 'windup' && run.t >= FEINT_AT * run.durations.windup) {
        this.c.skills.cancel(env);
        this.feint = false;
        this.nextStrikeAt = ctx.time + 0.4;
      }
      return this.still();
    }
    this.feint = false;
    const def = this.usable('jab') ?? this.usable('cross');
    if (!def || this.c.skills.active()) return this.still();
    const hi = def.range(this.c.geo)[1];
    if (dist > hi + 0.3) return this.goalAt(s, hi, 0);
    this.still();
    if (ctx.time < this.nextStrikeAt || this.c.gait.phase !== 'double') return;
    this.feint = this.c.startSkill(def, 'head', 0.5);
  }

  /** Wait for the opponent to commit, step off its line, and answer from the new angle. */
  private sidestepCounter(ctx: SimContext, s: Sense, env: SkillEnv, zone: TargetZone, aggression: number, dist: number): void {
    const opp = this.c.opp!;
    if (ctx.time < this.sidestepUntil) return this.goalAt(s, clampRange(dist), this.sidestepSign * SIDESTEP_RAD);
    if (this.sidestepUntil > 0) {
      // Just stepped off: counter with the heaviest hand that reaches.
      this.sidestepUntil = -1;
      const def = this.usable('cross') ?? this.usable('hook');
      if (def) return this.strike(ctx, s, def, zone, aggression, dist, true);
    }
    if (opp.windup >= REFLEX_WINDUP * 0.8 && dist < THREAT_RANGE_M) {
      // Step away from the side the blow comes from: a right hand is answered by moving left.
      this.sidestepSign = opp.skill.endsWith('_r') || ['cross', 'overhand', 'low_kick', 'head_kick', 'rocket_punch', 'uppercut'].includes(opp.skill) ? 1 : -1;
      this.sidestepUntil = ctx.time + SIDESTEP_S;
      this.c.skills.cancel(env);
      return this.goalAt(s, clampRange(dist), this.sidestepSign * SIDESTEP_RAD);
    }
    this.goalAt(s, HOLD_RANGE_M * 0.9, 0);
  }

  private still(): void {
    this.c.goal = null;
  }

  /**
   * Where the opponent stands: its COM, or on the balance engine its COM moved by the part of its
   * DCM lead (ċ/ω₀) along the line between the two, where its approach or retreat carries it. Two
   * fighters walking in plan against where the other will stop, not where it was, so neither walks
   * into the other and backs off again. (Across the line it is left out: a stepping opponent's
   * sway would swing the bearing.)
   */
  private oppPoint(s: Sense): readonly number[] {
    const opp = this.c.opp!;
    if (!this.c.engine) return opp.com;
    const dx = s.com[0] - opp.com[0], dy = s.com[1] - opp.com[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return opp.com;
    const ux = dx / d, uy = dy / d;
    const w = Math.sqrt(9.81 / Math.max(0.3, opp.com[2]));
    const lead = (opp.vel[0] * ux + opp.vel[1] * uy) / w;
    return [opp.com[0] + ux * lead, opp.com[1] + uy * lead, opp.com[2]];
  }

  /** Stand `d` from the opponent, rotated `turn` around it, facing it, inside the cage. */
  private goalAt(s: Sense, d: number, turn: number): void {
    const o = this.oppPoint(s);
    const ang = Math.atan2(s.com[1] - o[1], s.com[0] - o[0]) + turn;
    let x = o[0] + Math.cos(ang) * d;
    let y = o[1] + Math.sin(ang) * d;
    const rr = Math.hypot(x, y);
    if (rr > ARENA_LIMIT_M) {
      x *= ARENA_LIMIT_M / rr;
      y *= ARENA_LIMIT_M / rr;
    }
    this.c.goal = { x, y, heading: Math.atan2(o[1] - y, o[0] - x) };
  }
}

const clampRange = (d: number): number => Math.max(0.85, Math.min(1.4, d));

