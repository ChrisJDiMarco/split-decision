// The skills a fighter with a motion library throws from mocap: same ids, telegraphs and joint
// requirements as the procedural set (so tactics, abilities, the sparring brain and the metrics
// are unchanged), played by the clip. Punches keep the procedural ranges; kicks take theirs from
// the clips. The library's front, low and head kicks are all rear-leg kicks, so the mocap front
// kick is thrown with the rear (right) leg.
import { other } from '../gait';
import type { HumanoidGeometry, Side } from '../geometry';
import { CROSS, HOOK, JAB, OVERHAND, UPPERCUT } from '../skills/arm-strikes';
import { FRONT_KICK, HEAD_KICK, LOW_KICK } from '../skills/kicks';
import type { SkillDef, SkillEnv, SkillId, SkillRun } from '../skills/types';
import { mocapStrikesEnabled, type MocapSet } from './library';
import { kickClip, punchClip } from './strikes';

const RETURN_SWING = { shift: 0, shiftFraction: 1, swing: 0.3, lift: 0.04 };
// Kick ranges from the clips themselves: the foot lands `natural` metres ahead of where the pelvis
// started (the median over the design's moves); the aim warp can reach a little past that and
// fold back a good deal short of it.
const REACH_PAST_M = 0.1;
const REACH_SHORT_M = 0.3;
const MOCAP_APPROACH = { sweet: 0.7, throwAt: 0.9 };

const ranges = new WeakMap<HumanoidGeometry, Map<SkillId, [number, number]>>();

/**
 * COM-to-COM kick ranges for a fighter from its own library (the geometry object identifies
 * the fighter's controller). Called once the library is attached.
 */
export function registerMocapRanges(geo: HumanoidGeometry, set: MocapSet): void {
  const map = new Map<SkillId, [number, number]>();
  for (const id of Object.keys(KICK_DEFS) as SkillId[]) {
    const d = (set.byLabel.get(id as never) ?? [])
      .filter((m) => m.target)
      .map((m) => Math.hypot(m.target![0], m.target![1]))
      .sort((a, b) => a - b);
    if (!d.length) continue;
    const natural = d[Math.floor(d.length / 2)];
    map.set(id, [natural - REACH_SHORT_M, natural + REACH_PAST_M]);
  }
  ranges.set(geo, map);
}

function punchEnd(env: SkillEnv): void {
  env.player?.stop();
}

/** A kick cancelled or finished: the leg goes back to the gait where it stood. */
function kickEnd(env: SkillEnv, run: SkillRun): void {
  env.player?.stop();
  const side = (run.scratch.clip as { side?: Side } | undefined)?.side ?? run.def.side!;
  const place = (run.scratch.clip as { place?: { x: number; y: number; yaw: number } } | undefined)?.place;
  if (env.gait.skillLegActive() === side) env.gait.returnSkillLeg(place ?? env.gait.partnerSlot(side), RETURN_SWING, env.s);
  else env.gait.cancelSkillRequest();
}

const LEG = (s: Side | null) => (s ? [`hip_pitch_${s}`, `hip_roll_${s}`, `knee_${s}`, `hip_pitch_${other(s)}`, `knee_${other(s)}`] : []);

function rangeOf(base: SkillDef) {
  return (geo: HumanoidGeometry): [number, number] => ranges.get(geo)?.get(base.id) ?? base.range(geo);
}

/**
 * Punches keep the procedural range (the arm's geometric reach with planted feet). The clips'
 * own distances are 0.15-0.4 m longer (the actors stepped into their punches, the robot does
 * not): thrown from there, a punch lands short.
 */
function punch(base: SkillDef): SkillDef {
  return { ...base, clip: punchClip(base.id as never, base.side!), end: punchEnd, ready: undefined, strikeTime: undefined };
}

function kick(base: SkillDef, side: Side): SkillDef {
  return {
    ...base, side, requires: LEG, strikers: [`foot_${side}`, `shin_${side}`], range: rangeOf(base), approach: MOCAP_APPROACH,
    clip: kickClip(base.id as never, side), end: kickEnd, ready: undefined, strikeTime: undefined,
  };
}

/**
 * Mocap kicks are built (kickClip) but off: in the strike drill (every modern design, 12 s per
 * kick at a standing opponent) they landed 4 of 21 with 9 falls, against 11 of 28 with 6 falls for
 * the procedural kicks. A heavy leg lags the actors' roundhouse path (the foot arrives late and
 * low) and the swinging leg's momentum throws the capture point off the stance sole before the
 * impact. The procedural kicks stay until that is solved.
 */
export const MOCAP_KICKS = { enabled: false };

const PUNCHES: Partial<Record<SkillId, SkillDef>> = {
  jab: punch(JAB),
  cross: punch(CROSS),
  hook: punch(HOOK),
  uppercut: punch(UPPERCUT),
  overhand: punch(OVERHAND),
};

const KICK_DEFS: Partial<Record<SkillId, SkillDef>> = {
  front_kick: kick(FRONT_KICK, 'r'),
  low_kick: kick(LOW_KICK, 'r'),
  head_kick: kick(HEAD_KICK, 'r'),
};

export const MOCAP_SKILLS: Partial<Record<SkillId, SkillDef>> = { ...PUNCHES, ...KICK_DEFS };

/** The mocap version of a skill if this library has moves for it. */
export function mocapSkill(set: MocapSet | null, id: SkillId): SkillDef | null {
  if (!set || !mocapStrikesEnabled()) return null;
  const def = PUNCHES[id] ?? (MOCAP_KICKS.enabled ? KICK_DEFS[id] : undefined);
  if (!def) return null;
  return (set.byLabel.get(id as never)?.length ?? 0) > 0 ? def : null;
}
