// Feints and bites, read in physics. A feint is a strike windup pulled by choice before it commits,
// once it has shown, that the robot meant as a feint: its intent asks for one (a feint tactic, or a
// combo with a feint step), or no mind drives it (a scripted feint). A windup pulled by its own
// reflex or a switch to defence is no feint: his attack usually caused it, so his strike would read
// as a counter to a feint nobody threw (in House Mind fights those were half of all "bites"). From
// the moment the windup starts until BITE_WINDOW_S after it is pulled, the other robot is watched:
//   covered    he started a guard, or his hands came up
//   retreated  he stepped away from the feint (back or to the side), faster than he was moving
//   flinched   he pulled a strike of his own, or his torso jolted: its velocity jumped well off its
//              own recent average (above the 99.9th percentile of fighting motion)
//   countered  he started a strike of his own
// Anything in the first REACT_MIN_S after the windup starts is too early to be an answer to it. A
// bite is published BITE_GRACE_S after it is seen (and the feint pulled); no bite, once the window
// has closed.
// Sampled every SAMPLE_EVERY ticks from cheap reads of MuJoCo state and the controllers.
import type { BiteReaction, FeintLevel, FeintRead, TargetZone } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import { controllerOf } from '../control';
import { readVec } from '../control/math';
import { views } from '../control/sense';
import type { SkillRun } from '../control/skills/types';
import type { RobotRuntime, SimContext } from '../sim-context';

export const SAMPLE_EVERY = 4; // ticks (4 ms at the 1 ms step)
export const BITE_WINDOW_S = 0.5; // after the feint is pulled: no answer by then is no bite
/** A bite is published this soon after it is seen (and the feint pulled), so a payoff can use it. */
export const BITE_GRACE_S = 0.06;
export const REACT_MIN_S = 0.05; // earliest answer counted, from the windup start
export const MIN_SHOWN = 0.3; // fraction of the windup that must show before the pull
export const FEINT_RANGE_M = 2.4; // no one to fool beyond this
export const HANDS_UP_M = 0.06; // fists rising this much against his chin is covering up
export const AWAY_SPEED_MPS = 0.35; // stepping away faster than before by this much
export const AWAY_MIN_M = 0.08; // ... and moving at least this far
/** Torso velocity this far off its recent average is a flinch. Sparring (SAVATE v HAYMAKER, 30 s): p99 1.1, p99.9 1.5 m/s. */
export const JOLT_MPS = 1.8;
const JOLT_TAU_S = 0.12; // the recent average (EMA)
export const READS_KEPT = 4;

const FEINT_TACTICS = new Set(['feint', 'feint_left', 'feint_right']);

export function levelOf(zone: TargetZone): FeintLevel {
  if (zone === 'head') return 'high';
  if (zone === 'left_leg' || zone === 'right_leg') return 'low';
  return 'body';
}

/** One cheap read of a robot for the bite rules. */
export interface ReactSample {
  t: number;
  com: Vec3;
  comVel: Vec3;
  fistTop: number | null; // the higher fist's height
  fistZ: { l: number; r: number } | null;
  chinZ: number | null; // neck pivot height (null once the head is off)
  torso: Vec3; // torso position
  jolt: number; // m/s: torso velocity off its own recent average (filled by stepFeints)
  run: SkillRun | null;
  lastEnd: string; // how his last skill ended ('done', 'cancelled', 'forced')
  down: boolean;
}

/** His fists came up against his own chin (whole-body bob does not count). */
function handsUp(base: ReactSample, s: ReactSample): boolean {
  if (s.fistTop === null || base.fistTop === null) return false;
  const rel = (x: ReactSample) => (x.fistTop as number) - (x.chinZ ?? 0);
  return rel(s) - rel(base) >= HANDS_UP_M;
}

export function sampleOf(ctx: SimContext, r: RobotRuntime): ReactSample {
  const v = views(ctx);
  const torso = r.parts.get('torso');
  const tb = torso?.attached ? torso.body : r.rootBody;
  const fl = r.parts.get('fist_l'), fr = r.parts.get('fist_r');
  const fistZ = fl?.attached && fr?.attached ? { l: v.xpos[fl.body * 3 + 2], r: v.xpos[fr.body * 3 + 2] } : null;
  const head = r.parts.get('head');
  return {
    t: ctx.time,
    com: readVec(v.subtreeCom, r.rootBody),
    comVel: readVec(v.subtreeLinvel, r.rootBody),
    fistTop: fistZ ? Math.max(fistZ.l, fistZ.r) : null,
    fistZ,
    chinZ: head?.attached ? v.xpos[head.body * 3 + 2] : null,
    torso: readVec(v.xpos, tb),
    jolt: 0,
    run: controllerOf(r)?.skills.run ?? null,
    lastEnd: controllerOf(r)?.skills.lastEnd ?? '',
    down: r.down,
  };
}

/** A feint in progress (or pulled, waiting out the bite window). */
export interface FeintWatch {
  run: SkillRun;
  skill: string;
  limb: 'arm' | 'leg';
  level: FeintLevel;
  deliberate: boolean;
  start: number;
  shown: number; // max windup fraction seen
  pulledAt: number | null;
  firstReactAt: number | null; // when his first answer was seen
  base: ReactSample; // the victim when the windup started
  baseAway: number; // his speed away from the feinter then (m/s)
  reactions: Set<BiteReaction>;
}

/** Unit vector (x, y) from `a` to `b`. */
function unit(a: Vec3, b: Vec3): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

/** His answers in one sample (pure). `feinter` is the feinter's COM now. */
export function reactionsIn(w: FeintWatch, s: ReactSample, feinter: Vec3): BiteReaction[] {
  if (s.t - w.start < REACT_MIN_S || s.down) return [];
  const out: BiteReaction[] = [];
  const run = s.run;
  if (run && run !== w.base.run) {
    if (run.def.kind === 'defense') out.push('covered');
    else if (run.def.kind === 'arm' || run.def.kind === 'leg') out.push('countered');
  }
  if (handsUp(w.base, s) && !out.includes('covered')) out.push('covered');
  const [ux, uy] = unit(feinter, s.com); // away from the feinter
  const away = s.comVel[0] * ux + s.comVel[1] * uy;
  const lateral = Math.abs(-s.comVel[0] * uy + s.comVel[1] * ux);
  const baseLat = Math.abs(-w.base.comVel[0] * uy + w.base.comVel[1] * ux);
  const moved = Math.hypot(s.com[0] - w.base.com[0], s.com[1] - w.base.com[1]);
  if (moved >= AWAY_MIN_M && (away - w.baseAway >= AWAY_SPEED_MPS || lateral - baseLat >= AWAY_SPEED_MPS * 1.3)) out.push('retreated');
  const pulledHisOwn = !!w.base.run && w.base.run.phase === 'windup' && run !== w.base.run && s.lastEnd === 'cancelled';
  if ((s.jolt >= JOLT_MPS && !out.includes('countered')) || pulledHisOwn) out.push('flinched');
  return out;
}

interface TorsoTrack { p: Vec3; t: number; v: Vec3; avg: Vec3 }

/** Torso velocity from the last sample, and how far it jumped off its recent average. Mutates `st`. */
function trackTorso(st: FeintState, c: 0 | 1, s: ReactSample): number {
  const prev = st.torso[c];
  if (!prev || s.t - prev.t <= 0 || s.t - prev.t > 0.05 || s.down) {
    st.torso[c] = { p: s.torso, t: s.t, v: [0, 0, 0], avg: [0, 0, 0] };
    return 0;
  }
  const dt = s.t - prev.t;
  const v: Vec3 = [(s.torso[0] - prev.p[0]) / dt, (s.torso[1] - prev.p[1]) / dt, (s.torso[2] - prev.p[2]) / dt];
  const jolt = Math.hypot(v[0] - prev.avg[0], v[1] - prev.avg[1], v[2] - prev.avg[2]);
  const k = 1 - Math.exp(-dt / JOLT_TAU_S);
  st.torso[c] = { p: s.torso, t: s.t, v, avg: [prev.avg[0] + k * (v[0] - prev.avg[0]), prev.avg[1] + k * (v[1] - prev.avg[1]), prev.avg[2] + k * (v[2] - prev.avg[2])] };
  return jolt;
}

export interface FeintState {
  watch: [FeintWatch | null, FeintWatch | null]; // per feinter
  torso: [TorsoTrack | null, TorsoTrack | null]; // per robot: torso velocity and its recent average
  seq: [number, number];
  reads: [FeintRead[], FeintRead[]]; // per feinter, newest last
  lastRun: [SkillRun | null, SkillRun | null]; // the last run watched per feinter: never watched twice
}

export function newFeintState(): FeintState {
  return { watch: [null, null], torso: [null, null], seq: [0, 0], reads: [[], []], lastRun: [null, null] };
}

/**
 * It meant this windup as a feint: no mind drives it (scripted), its tactic is a feint, a combo the
 * body runs whole has a feint step (physics cannot tell which step is running), or the brain-sequenced
 * step it is on is a feint.
 */
function deliberate(r: RobotRuntime): boolean {
  const i = r.intent;
  if (!i) return true;
  if (FEINT_TACTICS.has(i.tactic)) return true;
  const step = i.comboPlan?.step;
  if (i.tactic === 'combo' && step === undefined) return (i.combo ?? []).some((t) => FEINT_TACTICS.has(t));
  return FEINT_TACTICS.has(i.combo?.[step ?? 0] ?? '');
}

function startWatch(run: SkillRun, r: RobotRuntime, victim: ReactSample, feinter: ReactSample): FeintWatch {
  const [ux, uy] = unit(feinter.com, victim.com);
  return {
    run, skill: run.def.id, limb: run.def.kind === 'leg' ? 'leg' : 'arm', level: levelOf(run.zone), deliberate: deliberate(r),
    start: victim.t, shown: 0, pulledAt: null, firstReactAt: null, base: victim,
    baseAway: victim.comVel[0] * ux + victim.comVel[1] * uy, reactions: new Set(),
  };
}

/**
 * One sample for both robots: start watching a fresh strike windup, follow it, and resolve a pulled
 * one into a FeintRead after the bite window. Returns the reads resolved this sample (by feinter). Mutates `st`.
 */
export function stepFeints(ctx: SimContext, st: FeintState, samples: readonly [ReactSample, ReactSample]): Array<{ corner: 0 | 1; read: FeintRead }> {
  for (const c of [0, 1] as const) samples[c].jolt = trackTorso(st, c, samples[c]);
  const out: Array<{ corner: 0 | 1; read: FeintRead }> = [];
  for (const c of [0, 1] as const) {
    const o = c === 0 ? 1 : 0;
    const r = ctx.robots[c];
    const me = samples[c], him = samples[o];
    let w = st.watch[c];
    const run = me.run;
    if (w && (me.down || r.koReason)) w = st.watch[c] = null;
    if (w && w.pulledAt === null) {
      if (run === w.run) {
        if (run.phase !== 'windup') w = st.watch[c] = null; // it committed: a real strike, not a feint
        else w.shown = Math.max(w.shown, run.t / Math.max(1e-3, run.durations.windup));
      } else {
        const chose = controllerOf(r)?.skills.lastEnd === 'cancelled';
        if (!chose || w.shown < MIN_SHOWN || !w.deliberate) w = st.watch[c] = null;
        else w.pulledAt = ctx.time;
      }
    }
    if (w) {
      for (const x of reactionsIn(w, him, me.com)) {
        w.reactions.add(x);
        w.firstReactAt ??= ctx.time;
      }
      const bitSoon = w.firstReactAt !== null && w.pulledAt !== null && ctx.time - Math.max(w.pulledAt, w.firstReactAt) >= BITE_GRACE_S;
      if (w.pulledAt !== null && (bitSoon || ctx.time - w.pulledAt >= BITE_WINDOW_S)) {
        const reactions = [...w.reactions];
        const read: FeintRead = {
          seq: ++st.seq[c], time: ctx.time, level: w.level, limb: w.limb, skill: w.skill,
          deliberate: w.deliberate, bit: reactions.length > 0, reactions,
        };
        st.reads[c] = [...st.reads[c], read].slice(-READS_KEPT);
        out.push({ corner: c, read });
        w = st.watch[c] = null;
      }
    }
    if (!w && run && run.phase === 'windup' && (run.def.kind === 'arm' || run.def.kind === 'leg') && !me.down && !him.down
      && Math.hypot(him.com[0] - me.com[0], him.com[1] - me.com[1]) <= FEINT_RANGE_M && run !== st.lastRun[c]) {
      const fresh = startWatch(run, r, him, me);
      fresh.shown = run.t / Math.max(1e-3, run.durations.windup);
      st.watch[c] = fresh;
      st.lastRun[c] = run;
    }
  }
  return out;
}
