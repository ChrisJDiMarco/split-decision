// Runs one skill at a time through windup → strike → recover.
//   commit window   a strike can be abandoned during its windup (a reflex, a knockdown); once the
//                   strike phase starts it plays out
//   telegraph       r.windup ramps to the skill's telegraph during the windup, holds through the
//                   strike and decays in recovery: this is what the opponent's reflex reads
//   aim             tracks the target through the windup, then locks (with a velocity lead) as
//                   the strike starts: punches are ballistic, not homing
//   landing         confirmed by MuJoCo contacts between the striking parts and the opponent
import type { TargetZone } from '../../../core/protocol';
import type { Vec3 } from '../../../core/types';
import type { RobotRuntime, SimContext } from '../../sim-context';
import { anyContact } from '../contacts';
import { clamp, readVec } from '../math';
import { views } from '../sense';
import { zonePoint } from './targets';
import type { SkillDef, SkillEnv, SkillPhase, SkillRun } from './types';

const READY_TIMEOUT_S = 1.6; // a kick whose leg never frees up is abandoned
const LAND_MIN_SPEED = 0.8; // m/s of the striking part at contact
const FOLLOW_THROUGH_S = 0.06; // keep driving after contact
const MIN_CLOSING_SPEED = 0.4; // m/s: a striker still approaching this fast keeps striking
const MAX_STRIKE_STRETCH = 2.5; // ... for at most this multiple of the planned strike time
const SUSTAIN_S = 0.1;

export interface SkillStats {
  thrown: number;
  landed: number;
  lastLandedSpeed: number;
}

export class SkillRunner {
  run: SkillRun | null = null;
  readonly stats: SkillStats = { thrown: 0, landed: 0, lastLandedSpeed: 0 };
  /** How the last run ended (diagnostics): 'done', 'cancelled' or 'forced'. */
  lastEnd = '';
  private strikerGeoms = new Set<number>();
  private oppGeoms = new Set<number>();
  private strikerBody = -1;
  private prevStrikerPos: Vec3 | null = null;
  private strikerSpeed = 0;
  private closing = 0;

  constructor(private readonly me: RobotRuntime, private readonly opp: RobotRuntime) {}

  active(): boolean {
    return this.run !== null;
  }

  /** In the strike or recovery phase: cannot be cancelled by choice. */
  committed(): boolean {
    return this.run !== null && this.run.phase !== 'windup';
  }

  start(def: SkillDef, zone: TargetZone, aggression: number): boolean {
    if (this.run) return false;
    const a = clamp(aggression, 0, 1);
    this.run = {
      def,
      phase: 'windup',
      t: 0,
      durations: {
        windup: def.durations.windup * (1.3 - 0.6 * a),
        strike: def.durations.strike * (1.1 - 0.2 * a),
        recover: def.durations.recover * (1.3 - 0.6 * a),
      },
      zone,
      aim: null,
      landed: false,
      landedSpeed: 0,
      scratch: {},
    };
    this.bindStrikers(def);
    if (def.kind === 'arm' || def.kind === 'leg') this.stats.thrown++;
    return true;
  }

  /** Abandon the current skill (allowed in the windup, or when forced by a fall). */
  cancel(env: SkillEnv | null, force = false): boolean {
    if (!this.run || (this.committed() && !force)) return false;
    this.lastEnd = force ? 'forced' : 'cancelled';
    if (env) this.run.def.end?.(env, this.run);
    this.run = null;
    return true;
  }

  /** Keep a guard or clinch in its hold phase for another moment. */
  sustain(): void {
    const r = this.run;
    if (r && r.phase === 'strike' && (r.def.kind === 'defense' || r.def.kind === 'grapple')) r.durations.strike = Math.max(r.durations.strike, r.t + SUSTAIN_S);
  }

  /** How telegraphed the current skill is right now (0..1). */
  windup(): number {
    const r = this.run;
    if (!r) return 0;
    const u = r.u ?? clamp(r.t / Math.max(1e-3, r.durations[r.phase]), 0, 1);
    if (r.phase === 'windup') return r.def.telegraph * u;
    if (r.phase === 'strike') return r.def.telegraph;
    return r.def.telegraph * (1 - u);
  }

  /** Overall progress through all three phases (0..1). */
  progress(): number {
    const r = this.run;
    if (!r) return 0;
    if (r.progress !== undefined) return clamp(r.progress, 0, 1);
    const d = r.durations;
    const total = d.windup + d.strike + d.recover;
    const before = r.phase === 'windup' ? 0 : r.phase === 'strike' ? d.windup : d.windup + d.strike;
    return clamp((before + Math.min(r.t, d[r.phase])) / total, 0, 1);
  }

  update(ctx: SimContext, env: SkillEnv, dt: number): void {
    const r = this.run;
    if (!r) return;
    if (r.def.clip) return this.updateClip(ctx, env, r, dt);
    r.t += dt;
    if (r.phase === 'windup') {
      r.aim = this.leadAim(env, r);
      const ready = r.def.ready ? r.def.ready(env, r) : true;
      if (!ready && r.t > READY_TIMEOUT_S) {
        this.cancel(env, true);
        return;
      }
      if (ready && r.t >= r.durations.windup) {
        if (r.def.strikeTime) r.durations.strike = Math.max(r.durations.strike, r.def.strikeTime(env, r));
        this.enter(r, 'strike');
      }
    } else if (r.phase === 'strike') {
      this.trackStriker(ctx, dt);
      if (!r.landed) this.detectLanding(ctx, r);
      // Follow through a moment after contact, then recover; never pull back while the striker
      // is still driving toward the aim (a torque-limited limb may need longer than planned).
      // Guards and clinches just hold for their duration.
      const blow = r.def.kind === 'arm' || r.def.kind === 'leg';
      if (r.landed && r.scratch.landedAt === undefined) r.scratch.landedAt = r.t;
      const followDone = blow && r.landed && r.t >= (r.scratch.landedAt as number) + FOLLOW_THROUGH_S;
      const closing = blow && this.closingSpeed(r) > MIN_CLOSING_SPEED && r.t < r.durations.strike * MAX_STRIKE_STRETCH;
      if (followDone || (r.t >= r.durations.strike && !closing)) this.enter(r, 'recover');
    } else if (r.t >= r.durations.recover && (!r.def.ready || r.def.ready(env, r))) {
      r.def.end?.(env, r);
      this.run = null;
      return;
    }
    const u = clamp(r.t / Math.max(1e-3, r.durations[r.phase]), 0, 1);
    r.def.pose(env, r, u);
  }

  /**
   * A mocap skill: the clip's own timeline moves it through windup, strike and recovery. The aim
   * tracks the target through the windup and locks (with a velocity lead) as the strike starts.
   */
  private updateClip(ctx: SimContext, env: SkillEnv, r: SkillRun, dt: number): void {
    const clip = r.def.clip!;
    if (r.scratch.begun === undefined) {
      r.scratch.begun = true;
      r.aim = this.leadAim(env, r);
      if (!clip.begin(env, r)) {
        this.run = null;
        return;
      }
      if (r.strikers) this.bindParts(r.strikers);
    }
    r.t += dt;
    if (r.phase === 'windup') r.aim = this.leadAim(env, r);
    const st = clip.step(env, r, dt);
    r.u = st.u;
    r.progress = st.progress;
    if (st.phase !== r.phase) this.enter(r, st.phase);
    if (r.phase === 'strike' || (r.phase === 'recover' && r.t < FOLLOW_THROUGH_S)) {
      this.trackStriker(ctx, dt);
      if (!r.landed) this.detectLanding(ctx, r);
      if (r.landed && r.scratch.landedAt === undefined) r.scratch.landedAt = r.t;
    }
    if (st.done) {
      r.def.end?.(env, r);
      this.run = null;
      this.lastEnd = 'done';
    }
  }

  private enter(r: SkillRun, phase: SkillPhase): void {
    r.phase = phase;
    r.t = 0;
  }

  /** Aim at the zone, led by the opponent's velocity over the strike's flight time. */
  private leadAim(env: SkillEnv, r: SkillRun): Vec3 {
    const p = zonePoint(env.opp, r.zone);
    const lead = r.durations.strike * 0.6;
    return [p[0] + env.opp.vel[0] * lead, p[1] + env.opp.vel[1] * lead, p[2]];
  }

  private bindStrikers(def: SkillDef): void {
    this.bindParts(def.strikers);
  }

  private bindParts(strikers: readonly string[]): void {
    this.strikerGeoms.clear();
    this.oppGeoms.clear();
    this.strikerBody = -1;
    for (const id of strikers) {
      const part = this.me.parts.get(id);
      if (!part) continue;
      for (const g of part.geoms) this.strikerGeoms.add(g);
      if (this.strikerBody < 0) this.strikerBody = part.body;
    }
    for (const part of this.opp.parts.values()) if (part.attached) for (const g of part.geoms) this.oppGeoms.add(g);
    this.prevStrikerPos = null;
    this.strikerSpeed = 0;
    this.closing = 0;
  }

  private trackStriker(ctx: SimContext, dt: number): void {
    if (this.strikerBody < 0) return;
    const p = readVec(views(ctx).xpos, this.strikerBody);
    if (this.prevStrikerPos) {
      const d = Math.hypot(p[0] - this.prevStrikerPos[0], p[1] - this.prevStrikerPos[1], p[2] - this.prevStrikerPos[2]);
      this.strikerSpeed = Math.max(this.strikerSpeed * 0.5, d / dt);
      const aim = this.run?.aim;
      if (aim) {
        const now = Math.hypot(p[0] - aim[0], p[1] - aim[1], p[2] - aim[2]);
        const before = Math.hypot(this.prevStrikerPos[0] - aim[0], this.prevStrikerPos[1] - aim[1], this.prevStrikerPos[2] - aim[2]);
        this.closing = 0.6 * this.closing + 0.4 * ((before - now) / dt);
      }
    }
    this.prevStrikerPos = p;
  }

  /** How fast the striking part is still approaching its aim point, m/s. */
  private closingSpeed(r: SkillRun): number {
    return r.aim ? this.closing : 0;
  }

  private detectLanding(ctx: SimContext, r: SkillRun): void {
    // Too slow to count as a blow: no need to read the contacts at all.
    if (this.strikerGeoms.size === 0 || this.strikerSpeed < LAND_MIN_SPEED) return;
    const hit = anyContact(ctx.data, (a, b) => (this.strikerGeoms.has(a) && this.oppGeoms.has(b)) || (this.strikerGeoms.has(b) && this.oppGeoms.has(a)));
    if (!hit) return;
    r.landed = true;
    r.landedSpeed = this.strikerSpeed;
    if (r.def.kind === 'arm' || r.def.kind === 'leg') {
      this.stats.landed++;
      this.stats.lastLandedSpeed = this.strikerSpeed;
    }
  }
}
