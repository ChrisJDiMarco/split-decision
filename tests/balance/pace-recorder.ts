// Fight pacing and commitment (balance-engine pace stage; docs/design/ring-iq.md, docs/design/
// fighter-iq-control-contract.md), measured the way a viewer would judge it. Read-only: it samples
// the controllers, the intents and the openings system's feint reads; it changes nothing.
//
//   idle in range    the share of the time a fighter's longest weapon lands (ring IQ's edge and
//                    pocket) that no skill runs (no strike, feint, guard or clinch), both up, no
//                    referee break; split by why: a footwork tactic, the strike's own range, mid-
//                    step, the balance gate, the cooldown (or anything else), no intent
//   exchanges        the first time both fighters have thrown a committed strike within EXCHANGE_S
//                    of each other; the share of committed strikes thrown within EXCHANGE_S of one
//                    of his (two-way trading)
//   combos           a combo intent (tactic 'combo') opens a record; every strike or feint windup
//                    the body starts while the same combo stands counts as a step thrown; complete
//                    once all its steps were thrown; closed by a different intent, a knockdown or a
//                    timeout
//   feints           feint windups started on a feint intent; the openings system's reads of them
//                    (feints.ts: shown and pulled by choice) and his bites; against a no-feint
//                    baseline: windows of the same length with him in range and no windup of ours,
//                    judged by the same rules (reactionsIn)
import type { Intent, Tactic } from '../../src/core/protocol';
import type { Vec3 } from '../../src/core/types';
import { TACTIC_SKILL } from '../../src/physics/control/abilities';
import type { HumanoidController } from '../../src/physics/control/controller';
import { RingIq } from '../../src/physics/control/ring-iq';
import type { SkillRun } from '../../src/physics/control/skills/types';
import { fallbackTactic } from '../../src/physics/control/tactics';
import { BITE_WINDOW_S, latestRead, reactionsIn, sampleOf, type FeintWatch, type ReactSample } from '../../src/physics/openings';
import type { SimContext } from '../../src/physics/sim-context';

export const EXCHANGE_S = 1.0;
const FEINT_RANGE_M = 2.4; // feints.ts FEINT_RANGE_M
const BASELINE_EVERY_S = 0.25; // a no-feint window opens at most this often per fighter
const BASELINE_SHOWN_S = 0.2; // ...and lasts a typical sold windup plus the bite window
const COMBO_SLACK_S = 1.5;
const COMBO_STEP_S = 1.6;
const JOLT_TAU_S = 0.12; // feints.ts
const FOOTWORK = new Set<Tactic>(['hold_range', 'close_distance', 'circle_left', 'circle_right', 'retreat', 'sidestep_counter', 'switch_stance', 'pivot_left', 'pivot_right']);
const FEINTS = new Set<Tactic>(['feint', 'feint_left', 'feint_right']);

export type IdleCause = 'footwork tactic' | 'strike out of its range' | 'strike too close' | 'mid-step' | 'balance gate' | 'cooldown or other' | 'defence or clinch' | 'feint' | 'no intent';

export interface PaceFighter {
  inRangeS: number;
  idleS: number;
  idleBy: Partial<Record<IdleCause, number>>;
  /** Idle with a strike that does not reach: seconds by kind and by how far out (m past its throw edge, 5 cm bins). */
  outOfRange: Record<string, number>;
  /**
   * The 'balance gate' idle split by what the balance engine says blocks an arm strike now (its
   * strikeBlock: a reaction, the gyro reserve, the torso rate, a step, the DCM), or 'ready (cooldown)'
   * when the engine would let it go (the gate test above is the stricter readyToStrike) and only the
   * pause between strikes holds it, 'kick gate' for a kick.
   */
  gateBy?: Record<string, number>;
  combos: { started: number; completed: number; steps: number; stepsThrown: number; closedBy: Record<string, number> };
  feints: { asked: number; windups: number; reads: number; bites: number; byLevel: Record<string, { reads: number; bites: number }>; reactions: Record<string, number> };
  baseline: { windows: number; bites: number };
}

export interface PaceReport {
  fighters: [PaceFighter, PaceFighter];
}

interface ComboRec { list: string; steps: number; thrown: number; until: number }
interface BaseWatch { w: FeintWatch; end: number }

const newFighter = (): PaceFighter => ({
  inRangeS: 0, idleS: 0, idleBy: {}, outOfRange: {}, gateBy: {},
  combos: { started: 0, completed: 0, steps: 0, stepsThrown: 0, closedBy: {} },
  feints: { asked: 0, windups: 0, reads: 0, bites: 0, byLevel: {}, reactions: {} },
  baseline: { windows: 0, bites: 0 },
});

const comboKey = (i: Intent | null): string => (i?.combo?.length ? i.combo.join('>') : '');

export class PaceRecorder {
  readonly report: PaceReport = { fighters: [newFighter(), newFighter()] };
  private readonly rings: RingIq[];
  private readonly lastIntent: Array<Intent | null> = [null, null];
  private readonly lastRun: Array<SkillRun | null> = [null, null];
  private readonly lastSeq = [0, 0];
  private readonly combo: Array<ComboRec | null> = [null, null];
  private readonly base: Array<BaseWatch | null> = [null, null];
  private readonly nextBase = [0, 0];
  private readonly torso: Array<{ p: Vec3; t: number; avg: Vec3 } | null> = [null, null];
  private lastOut = '';
  private lastKick = false;

  constructor(private readonly ctl: HumanoidController[]) {
    this.rings = ctl.map((c) => new RingIq(c));
  }

  /** One sample, every few physics steps (dt seconds since the last). */
  sample(ctx: SimContext, dt: number): void {
    const samples = [sampleOf(ctx, ctx.robots[0]), sampleOf(ctx, ctx.robots[1])] as [ReactSample, ReactSample];
    for (const c of [0, 1] as const) samples[c].jolt = this.jolt(c, samples[c]);
    for (const c of [0, 1] as const) {
      this.intents(ctx, c);
      this.runs(ctx, c);
      this.reads(ctx, c);
      this.idle(ctx, c, dt);
      this.baseline(ctx, c, samples);
    }
  }

  /** Close what is still open at the end of the fight. */
  finish(): PaceReport {
    for (const c of [0, 1] as const) this.closeCombo(c, 'fight over');
    return this.report;
  }

  private up(ctx: SimContext, c: 0 | 1): boolean {
    const me = this.ctl[c];
    return !ctx.robots[c].down && !me.getUp.active && !me.rising && !ctx.robots[c].koReason;
  }

  // ---------------------------------------------------------------- combos and feint requests

  private intents(ctx: SimContext, c: 0 | 1): void {
    const r = ctx.robots[c];
    const i = r.intent;
    const open = this.combo[c];
    if (open && (!this.up(ctx, c) || ctx.time > open.until)) this.closeCombo(c, !this.up(ctx, c) ? 'down' : 'timeout');
    if (i === this.lastIntent[c]) return;
    this.lastIntent[c] = i;
    if (!i) return;
    const f = this.report.fighters[c];
    if (FEINTS.has(i.tactic)) f.feints.asked++;
    const key = comboKey(i);
    const cur = this.combo[c];
    if (cur && cur.list !== key) this.closeCombo(c, 'new intent');
    if (i.tactic === 'combo' && i.comboPlan?.step === undefined && key && !this.combo[c]) {
      const steps = i.combo!.length;
      const tempo = (i.comboPlan?.tempo ?? []).reduce((a, b) => a + b, 0);
      this.combo[c] = { list: key, steps, thrown: 0, until: ctx.time + steps * COMBO_STEP_S + tempo + COMBO_SLACK_S };
      f.combos.started++;
      f.combos.steps += steps;
    }
  }

  private closeCombo(c: 0 | 1, why: string): void {
    const rec = this.combo[c];
    if (!rec) return;
    const f = this.report.fighters[c].combos;
    const done = rec.thrown >= rec.steps;
    f.stepsThrown += Math.min(rec.thrown, rec.steps);
    if (done) f.completed++;
    const k = done ? 'complete' : why;
    f.closedBy[k] = (f.closedBy[k] ?? 0) + 1;
    this.combo[c] = null;
  }

  /** A strike (or feint) windup started: a combo step thrown, a feint windup on a feint intent. */
  private runs(ctx: SimContext, c: 0 | 1): void {
    const run = this.ctl[c].skills.run;
    if (run === this.lastRun[c]) return;
    this.lastRun[c] = run;
    if (!run || (run.def.kind !== 'arm' && run.def.kind !== 'leg')) return;
    const i = ctx.robots[c].intent;
    const rec = this.combo[c];
    if (rec) {
      rec.thrown++;
      if (rec.thrown >= rec.steps) this.closeCombo(c, 'complete');
    }
    if (i && (FEINTS.has(i.tactic) || (i.comboPlan?.step !== undefined && FEINTS.has(i.combo?.[i.comboPlan.step] as Tactic)))) this.report.fighters[c].feints.windups++;
  }

  private reads(ctx: SimContext, c: 0 | 1): void {
    const read = latestRead(ctx, c);
    if (!read || read.seq <= this.lastSeq[c]) return;
    this.lastSeq[c] = read.seq;
    const f = this.report.fighters[c].feints;
    f.reads++;
    if (read.bit) f.bites++;
    const lv = (f.byLevel[read.level] ??= { reads: 0, bites: 0 });
    lv.reads++;
    if (read.bit) lv.bites++;
    for (const x of read.reactions) f.reactions[x] = (f.reactions[x] ?? 0) + 1;
  }

  // ---------------------------------------------------------------- idle in range

  private idle(ctx: SimContext, c: 0 | 1, dt: number): void {
    const o = c === 0 ? 1 : 0;
    if (!this.up(ctx, c) || !this.up(ctx, o) || ctx.referee?.active) return;
    const me = this.ctl[c];
    const d = dist(ctx, c, o);
    if (d > this.rings[c].read(ctx.time).myEdge) return;
    const f = this.report.fighters[c];
    f.inRangeS += dt;
    if (me.skills.run) return;
    f.idleS += dt;
    const why = this.cause(ctx, c, d);
    f.idleBy[why] = (f.idleBy[why] ?? 0) + dt;
    if (why === 'strike out of its range' && this.lastOut) f.outOfRange[this.lastOut] = (f.outOfRange[this.lastOut] ?? 0) + dt;
    if (why === 'balance gate') {
      const g = (f.gateBy ??= {});
      const st = me.engine?.state;
      const k = !st ? 'legacy' : this.lastKick ? `kick gate: ${st.kickBlock || 'ready (cooldown)'}` : st.strikeBlock || 'ready (cooldown)';
      g[k] = (g[k] ?? 0) + dt;
    }
  }

  private cause(ctx: SimContext, c: 0 | 1, d: number): IdleCause {
    const me = this.ctl[c];
    const i = ctx.robots[c].intent;
    if (!i) return 'no intent';
    if (FEINTS.has(i.tactic)) return 'feint';
    const t = fallbackTactic(i.tactic, i.combo);
    if (FOOTWORK.has(t)) return 'footwork tactic';
    if (t === 'guard' || t === 'clinch') return 'defence or clinch';
    if (FEINTS.has(t)) return 'feint';
    const id = TACTIC_SKILL[t];
    const def = id ? me.skillFor(id) : undefined;
    if (!def) return 'cooldown or other';
    const [lo, hi] = def.range(me.geo);
    const throwAt = def.approach?.throwAt ?? 0.85;
    const edge = lo + throwAt * (hi - lo);
    if (d > edge) {
      this.lastOut = `${def.kind} +${(Math.floor((d - edge) / 0.05) * 5).toFixed(0)}cm`;
      return 'strike out of its range';
    }
    if (d < lo) return 'strike too close';
    if (!(me.gait.phase === 'double' && me.gait.bothPlanted())) return 'mid-step';
    this.lastKick = def.kind === 'leg';
    if (!(def.kind === 'leg' ? me.readyToKick() : me.readyToStrike())) return 'balance gate';
    return 'cooldown or other';
  }

  // ---------------------------------------------------------------- the no-feint baseline

  /** Torso velocity off its own recent average (feints.ts trackTorso). */
  private jolt(c: 0 | 1, s: ReactSample): number {
    const prev = this.torso[c];
    if (!prev || s.t - prev.t <= 0 || s.t - prev.t > 0.05 || s.down) {
      this.torso[c] = { p: s.torso, t: s.t, avg: [0, 0, 0] };
      return 0;
    }
    const dt = s.t - prev.t;
    const v: Vec3 = [(s.torso[0] - prev.p[0]) / dt, (s.torso[1] - prev.p[1]) / dt, (s.torso[2] - prev.p[2]) / dt];
    const jolt = Math.hypot(v[0] - prev.avg[0], v[1] - prev.avg[1], v[2] - prev.avg[2]);
    const k = 1 - Math.exp(-dt / JOLT_TAU_S);
    this.torso[c] = { p: s.torso, t: s.t, avg: [prev.avg[0] + k * (v[0] - prev.avg[0]), prev.avg[1] + k * (v[1] - prev.avg[1]), prev.avg[2] + k * (v[2] - prev.avg[2])] };
    return jolt;
  }

  /**
   * Windows with no windup of ours, judged by the feint rules: how often he "bites" on nothing.
   * A window in which we start a strike of our own is dropped (it is no longer a window without one).
   */
  private baseline(ctx: SimContext, c: 0 | 1, samples: [ReactSample, ReactSample]): void {
    const o = c === 0 ? 1 : 0;
    const me = samples[c], him = samples[o];
    const open = this.base[c];
    if (open) {
      const mine = me.run;
      if (mine && (mine.def.kind === 'arm' || mine.def.kind === 'leg')) {
        this.base[c] = null;
        return;
      }
      for (const x of reactionsIn(open.w, him, me.com)) open.w.reactions.add(x);
      if (ctx.time >= open.end || him.down || me.down) {
        const b = this.report.fighters[c].baseline;
        b.windows++;
        if (open.w.reactions.size) b.bites++;
        this.base[c] = null;
      }
      return;
    }
    if (ctx.time < this.nextBase[c] || me.down || him.down || me.run || ctx.referee?.active) return;
    if (Math.hypot(him.com[0] - me.com[0], him.com[1] - me.com[1]) > FEINT_RANGE_M) return;
    this.nextBase[c] = ctx.time + BASELINE_EVERY_S;
    const dx = him.com[0] - me.com[0], dy = him.com[1] - me.com[1];
    const n = Math.hypot(dx, dy) || 1;
    const w: FeintWatch = {
      run: null as unknown as SkillRun, skill: 'none', limb: 'arm', level: 'high', deliberate: true,
      start: ctx.time, shown: 1, pulledAt: ctx.time + BASELINE_SHOWN_S, firstReactAt: null, base: him,
      baseAway: (him.comVel[0] * dx + him.comVel[1] * dy) / n, reactions: new Set(),
    };
    this.base[c] = { w, end: ctx.time + BASELINE_SHOWN_S + BITE_WINDOW_S };
  }
}

function dist(ctx: SimContext, a: number, b: number): number {
  const sc = ctx.data.subtree_com as Float64Array;
  const ra = ctx.robots[a].rootBody * 3, rb = ctx.robots[b].rootBody * 3;
  return Math.hypot(sc[rb] - sc[ra], sc[rb + 1] - sc[ra + 1]);
}

/** Committed strike starts per fighter → the first two-way exchange and the share of strikes traded. */
export function exchanges(starts: [number[], number[]]): { first: number | null; twoWay: number; total: number } {
  let first: number | null = null;
  let twoWay = 0;
  for (const c of [0, 1] as const) {
    const mine = starts[c], his = starts[c === 0 ? 1 : 0];
    for (const t of mine) {
      const traded = his.some((h) => Math.abs(h - t) <= EXCHANGE_S);
      if (!traded) continue;
      twoWay++;
      const at = Math.max(t, his.find((h) => Math.abs(h - t) <= EXCHANGE_S)!);
      if (first === null || at < first) first = at;
    }
  }
  return { first, twoWay, total: starts[0].length + starts[1].length };
}
