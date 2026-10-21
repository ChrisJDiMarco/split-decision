// Fall anatomy (the fight-clean pass, 2026-10-20): for every fall of a fighter, when the loss of balance
// that ended in it began and what came just before. Read-only; tools/fight-metrics.ts and the fight drill
// (tools/balance-drills.ts --drills fight) sample it after every physics step.
//
//   onset      the last time the balance engine's reaction left 'steady' before the fall (absorb or
//              recover), at most ONSET_MAX_S before it
//   trigger    what happened in [onset − BEFORE_S, onset + AFTER_S]: a blow taken (≥ HIT_NS, by the other
//              robot), the fighter's own strike starting, its step-in (BalanceEngine.requestLunge), leg on
//              leg contact with him (feet, shins, thighs), the cage; 'none' if nothing of these
//   recovery   catch steps between the onset and the fall, what started the brace (reactions.ts), the
//              gyro's fill at the onset and its peak, its health at the fall, the COM's top speed and the
//              torso's largest tilt over the episode, leg contacts during it
import { APOTHEM } from '../../src/core/arena-spec';
import type { SimEvent } from '../../src/core/protocol';
import { controllerOf, type HumanoidController } from '../../src/physics/control';
import { anyContact } from '../../src/physics/control/contacts';
import type { SimContext } from '../../src/physics/sim-context';

const ONSET_MAX_S = 8;
const BEFORE_S = 0.4;
const AFTER_S = 0.1;
const HIT_NS = 8;
const KEEP_S = 10; // history kept per fighter
const LEG = /^(foot|shin|thigh)_/;

interface Note { t: number; what: string; n?: number }
interface Sample { t: number; sat: number; tilt: number; v: number }

export interface FallAnatomyRec {
  t: number;
  onset: number;
  /** 'hit', 'own strike', 'step-in', 'leg contact', 'cage' (any of them), or ['none']. */
  trigger: string[];
  captures: number;
  brace: string;
  satOnset: number;
  satPeak: number;
  gyroHealth: number;
  vPeak: number;
  tiltPeakDeg: number;
  legContacts: number;
  /** The notes in the trigger window, for reading. */
  before: string[];
}

export class FallAnatomy {
  private readonly ctl: HumanoidController[];
  private readonly geom = new Map<number, { c: number; part: string }>();
  private readonly notes: Note[][] = [[], []];
  private readonly samples: Sample[][] = [[], []];
  private readonly modes: Array<Array<{ t: number; mode: string }>> = [[], []];
  private readonly prev = [0, 1].map(() => ({ mode: 'steady', capt: 0, lunges: 0, run: null as unknown }));
  private legPrev = false;
  private readonly torso: number[];
  readonly falls: FallAnatomyRec[][] = [[], []];

  constructor(ctx: SimContext) {
    this.ctl = ctx.robots.map((r) => controllerOf(r)!);
    for (const r of ctx.robots) for (const [id, part] of r.parts) for (const g of part.geoms) this.geom.set(g, { c: r.corner, part: id });
    this.torso = ctx.robots.map((r) => r.parts.get('torso')!.body);
  }

  /** After every physics step, before the caller clears ctx.events. */
  sample(ctx: SimContext): void {
    const t = ctx.time;
    for (const e of ctx.events as SimEvent[]) {
      if (e.kind === 'impact') {
        if (e.victim !== null && e.striker !== null && e.striker !== e.victim) {
          this.note(e.victim, t, `took ${e.part}<${e.strikerPart ?? '?'}${e.push ? ' push' : ''}`, e.impulseNs);
          this.note(e.striker, t, `gave ${e.strikerPart ?? '?'}>${e.part}${e.push ? ' push' : ''}`, e.impulseNs);
        } else if (e.victim !== null && e.striker === null && Math.hypot(e.pos[0], e.pos[1]) > APOTHEM - 0.35) this.note(e.victim, t, `cage ${e.part}`, e.impulseNs);
      } else if (e.kind === 'fall') this.close(ctx, e.corner, t);
    }
    if (ctx.tick % 2) return;
    let leg = false;
    anyContact(ctx.data, (g1, g2) => {
      const a = this.geom.get(g1), b = this.geom.get(g2);
      if (a && b && a.c !== b.c && LEG.test(a.part) && LEG.test(b.part)) leg = true;
      return leg;
    });
    if (leg && !this.legPrev) for (const c of [0, 1]) this.note(c, t, 'leg contact');
    this.legPrev = leg;
    const xm = ctx.data.xmat as Float64Array;
    for (const c of [0, 1]) {
      const k = this.ctl[c];
      const e = k.engine;
      const s = k.lastSense;
      if (!e || !s) continue;
      const p = this.prev[c];
      const mode = ctx.robots[c].down ? 'down' : e.reactions.mode;
      if (mode !== p.mode) {
        this.modes[c].push({ t, mode });
        if (mode === 'brace') this.note(c, t, `brace ${e.reactions.braceWhy}`);
      }
      if (k.gait.captureSteps !== p.capt) this.note(c, t, 'capture');
      if (e.lunges !== p.lunges) this.note(c, t, 'step-in');
      const run = k.skills.run;
      if (run && run !== p.run && (run.def.kind === 'arm' || run.def.kind === 'leg')) this.note(c, t, `strike ${run.def.id}`);
      p.mode = mode;
      p.capt = k.gait.captureSteps;
      p.lunges = e.lunges;
      p.run = run;
      if (ctx.tick % 20 === 0) {
        const tilt = (Math.acos(Math.max(-1, Math.min(1, xm[this.torso[c] * 9 + 8]))) * 180) / Math.PI;
        this.samples[c].push({ t, sat: k.gyro?.saturation ?? 0, tilt, v: Math.hypot(s.comVel[0], s.comVel[1]) });
      }
      this.trim(c, t);
    }
  }

  private note(c: number, t: number, what: string, n?: number): void {
    this.notes[c].push({ t, what, n });
  }

  private trim(c: number, t: number): void {
    const cut = t - KEEP_S;
    for (const list of [this.notes[c], this.samples[c], this.modes[c]] as Array<Array<{ t: number }>>) {
      let i = 0;
      while (i < list.length && list[i].t < cut) i++;
      if (i > 64) list.splice(0, i);
    }
  }

  private close(ctx: SimContext, c: number, t: number): void {
    const modes = this.modes[c].filter((m) => m.t < t - 0.002);
    let onset = t - ONSET_MAX_S;
    for (let i = modes.length - 1; i >= 0; i--) {
      const m = modes[i];
      if (m.mode === 'down') {
        onset = Math.max(onset, m.t);
        break;
      }
      if (m.mode !== 'steady' && (i === 0 || modes[i - 1].mode === 'steady')) {
        onset = Math.max(onset, m.t);
        break;
      }
    }
    const before = this.notes[c].filter((h) => h.t >= onset - BEFORE_S && h.t <= onset + AFTER_S);
    const during = this.notes[c].filter((h) => h.t > onset && h.t <= t);
    const trig = new Set<string>();
    for (const h of before) {
      if (h.what.startsWith('took') && (h.n ?? 0) >= HIT_NS) trig.add('hit');
      else if (h.what.startsWith('strike')) trig.add('own strike');
      else if (h.what === 'step-in') trig.add('step-in');
      else if (h.what === 'leg contact') trig.add('leg contact');
      else if (h.what.startsWith('cage')) trig.add('cage');
    }
    const sm = this.samples[c].filter((x) => x.t >= onset && x.t <= t);
    const satOn = this.samples[c].filter((x) => x.t <= onset).slice(-1)[0]?.sat ?? 0;
    this.falls[c].push({
      t, onset, trigger: trig.size ? [...trig] : ['none'],
      captures: during.filter((h) => h.what === 'capture').length,
      brace: during.find((h) => h.what.startsWith('brace'))?.what.slice(6) ?? '',
      satOnset: satOn, satPeak: sm.reduce((a, x) => Math.max(a, x.sat), 0), gyroHealth: ctx.robots[c].gyro?.health ?? 0,
      vPeak: sm.reduce((a, x) => Math.max(a, x.v), 0), tiltPeakDeg: sm.reduce((a, x) => Math.max(a, x.tilt), 0),
      legContacts: during.filter((h) => h.what === 'leg contact').length,
      before: before.map((h) => `${h.t.toFixed(2)} ${h.what}${h.n !== undefined ? ` ${h.n.toFixed(0)}` : ''}`),
    });
  }
}

/** One line per fall group: how the falls started and how the recoveries went. */
export function summarizeAnatomy(recs: FallAnatomyRec[]): string[] {
  if (!recs.length) return ['  fall anatomy: no falls'];
  const by = new Map<string, number>();
  for (const r of recs) for (const k of r.trigger) by.set(k, (by.get(k) ?? 0) + 1);
  const brace = new Map<string, number>();
  for (const r of recs) brace.set(r.brace || 'no brace', (brace.get(r.brace || 'no brace') ?? 0) + 1);
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const dead = recs.filter((r) => r.gyroHealth <= 0.05).length;
  return [
    `  fall anatomy (${recs.length} falls): started by ${[...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `    onset to fall median ${med(recs.map((r) => r.t - r.onset)).toFixed(2)} s, catch steps median ${med(recs.map((r) => r.captures))} (max ${Math.max(...recs.map((r) => r.captures))}), COM top speed median ${med(recs.map((r) => r.vPeak)).toFixed(2)} m/s, gyro fill at onset median ${med(recs.map((r) => r.satOnset)).toFixed(2)}, gyro destroyed in ${dead}`,
    `    brace started by ${[...brace].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  ];
}
