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
  if (env.engine) env.engine.kickNeedNms = 0;
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

/** Engine kicks' reach from the weight shift (engineKick), exported so tools can sweep it. */
export const ENGINE_KICK = {
  shiftReachL: 0.12, // × leg length: the stance's half-length (0.14 L) less the COM's lead over its centre
};

/**
 * The same kick on the balance engine: the procedural kick's range and approach, which are the leg's
 * own reach from a planted stance, plus what the weight shift brings: these are rear-leg kicks, and the
 * shift puts the body over the front foot before the leg lifts, the kicking hip turning over beside it
 * (strikes.ts kickClip), so the hip the leg swings from stands about the stance's half-length
 * (stance.ts: 0.14 × leg length) further toward him than where the COM started, less the COM's own
 * lead over the stance centre (ENGINE_KICK.shiftReachL). Without it a kick's sweet spot lay inside
 * the two guards' standoff: walked in there, the guards met and his pushed the shift back off the
 * stance foot (sparring, 2026-10-21: 60% of kicks called off by the lift gate). The clips' own
 * distances include the actor stepping 0.5-1.1 m into the kick, which the robot does not.
 * (The brain's range facts, src/brain/ranges.ts, read the procedural kicks' ranges.)
 */
function engineKick(base: SkillDef, side: Side): SkillDef {
  return { ...kick(base, side), range: shiftedRange(base), approach: base.approach };
}

/** A rear-leg kick's range on the balance engine: the procedural reach plus the weight shift's (engineKick). */
function shiftedRange(base: SkillDef): SkillDef['range'] {
  return (geo: HumanoidGeometry): [number, number] => {
    const [lo, hi] = base.range(geo);
    const d = ENGINE_KICK.shiftReachL * geo.legLength;
    return [lo + d, hi + d];
  };
}

/**
 * The procedural kicks as the balance engine throws them: the rear-leg ones (low and head kick) reach
 * as far as the weight shift onto the front foot carries the hip (shiftedRange); the lead-leg front
 * kick shifts back onto the rear foot, its hip already ahead of the COM, and keeps its reach.
 */
const ENGINE_PROCEDURAL_DEFS: Partial<Record<SkillId, SkillDef>> = {
  front_kick: FRONT_KICK,
  low_kick: { ...LOW_KICK, range: shiftedRange(LOW_KICK) },
  head_kick: { ...HEAD_KICK, range: shiftedRange(HEAD_KICK) },
};

/**
 * Mocap kicks are built (kickClip) but off: in the strike drill (every modern design, 12 s per
 * kick at a standing opponent) they landed 4 of 21 with 9 falls, against 11 of 28 with 6 falls for
 * the procedural kicks. A heavy leg lags the actors' roundhouse path (the foot arrives late and
 * low) and the swinging leg's momentum throws the capture point off the stance sole before the
 * impact. The procedural kicks stay until that is solved.
 */
export const MOCAP_KICKS = {
  enabled: false,
  /**
   * On the balance engine: 1, the mocap kicks play where ENGINE_PROCEDURAL_KICKS does not keep the
   * procedural one (P3: motor-rate playback from the centroid tables, the pre-position over 1/ω₀, the lift
   * gate and the cancel, the landing by the step adjuster); 0, every kick is the procedural one
   * (ENGINE_PROCEDURAL_DEFS). 0 since the kick pass (2026-10-21): once the weight shift reached the lift
   * gate (ENGINE_KICK reach and PACE.kickRoomM room, BALANCE_TUNING.kickBodyFeedback, KICK_GATE.soleM), the
   * procedural kicks landed clean and hard after a walk-in (strike drill --approach, 16 of each: SAVATE
   * front, low and head kick 16/16/16 at 10.0/9.5/4.3 m/s, PYLON low and head kick 15/16 at 9.7 and 16/16
   * at 7.2 m/s, no falls) where the mocap kicks touched his guard at 1.1-1.5 m/s with 20-31 catch steps
   * per 16 (their r_bal rate cap plays them slowly to the impact, and the aim warp brings the foot in late).
   */
  engine: 0,
};

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

const ENGINE_KICK_DEFS: Partial<Record<SkillId, SkillDef>> = {
  front_kick: engineKick(FRONT_KICK, 'r'),
  low_kick: engineKick(LOW_KICK, 'r'),
  head_kick: engineKick(HEAD_KICK, 'r'),
};

export const MOCAP_SKILLS: Partial<Record<SkillId, SkillDef>> = { ...PUNCHES, ...KICK_DEFS };

/**
 * Balance engine: the kicks that stay procedural on a design, where the mocap kick does not yet pass
 * the kick drill against them (tools/balance-drills.ts --drills strikes, 8 of each kick at a standing
 * opponent, 2026-10-20, after the strike-pass motors). Mocap kicks fell 3 in 8 front kicks on
 * FIRECRACKER (procedural: none) and missed every PYLON front kick (procedural: 6 of 8); the procedural
 * low kick lands as often on FIRECRACKER and on HAYMAKER more often and far harder (8.6 m/s, 73 N·s at
 * the thigh against 1.9 m/s and 29 N·s). Everywhere else the mocap kick lands more often with no more falls.
 */
export const ENGINE_PROCEDURAL_KICKS: Readonly<Record<string, readonly SkillId[]>> = {
  firecracker: ['front_kick', 'low_kick'],
  haymaker: ['low_kick'],
  pylon: ['front_kick'],
};

/** The mocap version of a skill if this library has moves for it (`engine`: on the balance engine). */
export function mocapSkill(set: MocapSet | null, id: SkillId, engine = false): SkillDef | null {
  if (!set || !mocapStrikesEnabled()) return null;
  if (engine && (ENGINE_PROCEDURAL_KICKS[set.lib.design]?.includes(id) || (!MOCAP_KICKS.engine && ENGINE_PROCEDURAL_DEFS[id]))) return ENGINE_PROCEDURAL_DEFS[id] ?? null;
  const def = PUNCHES[id] ?? (engine && MOCAP_KICKS.engine ? ENGINE_KICK_DEFS[id] : MOCAP_KICKS.enabled ? KICK_DEFS[id] : undefined);
  if (!def) return null;
  return (set.byLabel.get(id as never)?.length ?? 0) > 0 ? def : null;
}
