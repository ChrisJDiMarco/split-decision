// Tactics: the brain's Intent becomes footwork goals and skills, every control update.
//   footwork   hold_range / close_distance / circle / retreat set where the stance should be
//   strikes    walk into the skill's range, then throw it from a set stance; the tactic keeps
//              throwing it while it stands, at a rate set by aggression
//   commit     a strike can be abandoned in its windup (for a reflex or a defensive tactic),
//              never once the strike phase starts
//   reflex     counterIfLunge is armed in advance and fires here, without a brain round trip,
//              the moment the opponent's windup crosses REFLEX_WINDUP inside striking range
//   aggression faster footwork, shorter windups (the skill runner), shorter pauses between strikes
import type { Intent, Tactic, TargetZone } from '../../core/protocol';
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
    const intent = this.c.r.intent;
    const opp = this.c.opp;
    if (!opp || !intent) return;
    const dist = Math.hypot(opp.com[0] - s.com[0], opp.com[1] - s.com[1]);
    const aggression = intent.aggression;
    this.c.timing = { ...this.c.timing, swing: 0.3 * (1.2 - 0.4 * aggression) * (this.c.r.design.abilities.includes('sprint') ? 0.85 : 1) };
    this.trackCooldown(ctx, aggression);
    if (this.reflex(ctx, s, env, intent, dist)) return;
    this.run(ctx, s, env, intent.tactic, intent.target, aggression, dist, false);
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
    if (this.c.gait.phase !== 'double' || !this.c.gait.bothPlanted() || !this.c.readyToStrike()) return;
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

  /** Stand `d` from the opponent's COM, rotated `turn` around it, facing it, inside the cage. */
  private goalAt(s: Sense, d: number, turn: number): void {
    const o = this.c.opp!.com;
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
