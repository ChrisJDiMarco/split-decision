// Range facts: which of a fighter's weapons land from the current gap. Built from the SAME range
// definitions the body throws with (src/physics/control/skills: def.range(geo), reached through the
// control layer's own tactic → skill map and fallbacks), so there is no second table to drift: when a
// skill's range changes, the words Jev reads and the House Mind's choices move with it.
// Pure: numbers in, numbers and words out. bands.ts rules apply (no raw floats in the words).
import type { RobotTelemetry, Tactic } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import { TACTIC_SKILL } from '../physics/control/abilities';
import { humanoidGeometry, isHumanoid } from '../physics/control/geometry';
import { isStrikeSkill, skillDef, type SkillDef, type SkillId } from '../physics/control/skills';
import { fallbackTactic } from '../physics/control/tactics';
import { abilityTactics, isStrike, TACTIC_INFO, tacticWords } from './tactics';

/**
 * One step in, as a fraction of leg length: the walk's longest stride (MAX_STRIDE in
 * src/physics/control/walk.ts, not exported while the balance build owns that file).
 */
export const STEP_LEG_FRACTION = 0.46;
/**
 * Walking in, the body throws a strike only once the gap is this far into the skill's range
 * (THROW_ZONE in src/physics/control/tactics.ts, not exported while the balance build owns that file;
 * a skill's own def.approach.throwAt overrides it). Past that point it steps first, so the last few cm
 * of def.range are "needs a step in", not "lands from here".
 */
export const THROW_ZONE = 0.85;
/** Reach differences under this read as even. */
const EVEN_REACH_M = 0.05;
/** Closing slower than this is not "closing" (bands.closingBand's 'steady'). */
const CLOSING_MIN_MS = 0.4;
const CM_ROUND = 5;

/**
 * A/B switch for measurement (tests/brain/measure-range.ts, the live Jev A/B): off, readRange returns
 * null and the mind reads the old coarse reach band. On in play.
 */
export const RANGE_FACTS = { enabled: true };

/** Where a weapon stands from the current gap: lands now, one step in, too close, too far. */
export type RangeFit = 'lands' | 'step' | 'close' | 'far';

export interface WeaponRange {
  tactic: Tactic;
  skill: string; // the control skill the body actually throws for it
  lo: number; // COM-to-COM metres, from def.range(geo)
  hi: number;
  edge: number; // the farthest gap the body throws it from without a step: lo + throwAt · (hi − lo)
  strikers: readonly string[]; // parts that must be attached
  joints: readonly string[]; // joints that must drive
}

export interface RangeTable {
  byTactic: Map<Tactic, WeaponRange>;
  step: number; // one step in, m
}

const TABLES = new WeakMap<RobotDesign, RangeTable | null>();

/**
 * The skill the body throws for tactic `t` on an undamaged `design`, as the control layer picks it
 * (tactics.ts run → usable): the tactic's own skill if the design has it, else the design's first
 * strike of the same kind (a flashy menu move on a body without its fallback skill), else its first strike.
 */
function bodySkill(design: RobotDesign, t: Tactic): SkillDef | null {
  const id = TACTIC_SKILL[fallbackTactic(t)];
  const def = id ? skillDef(id) : null;
  if (def && design.abilities.includes(id as never)) return def;
  if (def?.kind === 'defense') return null;
  const pool = design.abilities.map((a) => skillDef(a as SkillId)).filter((d): d is SkillDef => !!d && isStrikeSkill(d));
  return pool.find((d) => d.kind === (def?.kind ?? 'arm')) ?? pool[0] ?? null;
}

/** Every strike tactic the body can run for this design, with its landing range. Null: not a humanoid (no skill ranges). */
export function rangeTable(design: RobotDesign): RangeTable | null {
  if (TABLES.has(design)) return TABLES.get(design) ?? null;
  let table: RangeTable | null = null;
  if (isHumanoid(design)) {
    const geo = humanoidGeometry(design);
    const byTactic = new Map<Tactic, WeaponRange>();
    for (const t of Object.keys(TACTIC_INFO) as Tactic[]) {
      if (t === 'combo' || !isStrike(t)) continue;
      const def = bodySkill(design, t);
      if (!def || !isStrikeSkill(def)) continue;
      const [lo, hi] = def.range(geo);
      const edge = lo + (def.approach?.throwAt ?? THROW_ZONE) * (hi - lo);
      byTactic.set(t, { tactic: t, skill: def.id, lo, hi, edge, strikers: def.strikers, joints: def.requires(def.side) });
    }
    table = { byTactic, step: STEP_LEG_FRACTION * geo.legLength };
  }
  TABLES.set(design, table);
  return table;
}

/** Mirrors the body's strike(): it throws from lo..edge, steps back inside lo, walks in past edge. */
export function fitAt(w: Pick<WeaponRange, 'lo' | 'edge'>, distance: number, step: number): RangeFit {
  if (distance < w.lo) return 'close';
  if (distance <= w.edge) return 'lands';
  if (distance <= w.edge + step) return 'step';
  return 'far';
}

/** A tactic's fit from `distance` (null: not a ranged strike for this body, e.g. footwork or a non-humanoid). */
export function tacticFit(design: RobotDesign, tactic: Tactic, distance: number): RangeFit | null {
  const table = rangeTable(design);
  const w = table?.byTactic.get(tactic);
  return w && table ? fitAt(w, distance, table.step) : null;
}

/** A strike's fit for this fighter, or 'out' when damage took that weapon away (null: footwork, or no skill ranges). */
export type StrikeFit = RangeFit | 'out';

/** Lands now or one step away: a sensible thing to throw (or step in behind) from here. */
export function fitsHere(fit: StrikeFit | null): boolean {
  return fit === null || fit === 'lands' || fit === 'step';
}

/**
 * How tactic `t` fits this gap for this fighter: its working weapon's fit from `range` (Situation.range),
 * 'out' for one of its own strike abilities that damage took away, the fallback skill's fit for a move
 * that is not one of its abilities (a flashy move the body runs as a plain strike), null for footwork,
 * the combo, or no range facts.
 */
export function weaponFit(design: RobotDesign, range: RangeRead | null | undefined, t: Tactic): StrikeFit | null {
  if (!range || t === 'combo') return null;
  const mine = range.mine.find((w) => w.tactic === t);
  if (mine) return mine.fit;
  if (!rangeTable(design)?.byTactic.has(t)) return null;
  return abilityTactics(design).includes(t) ? 'out' : tacticFit(design, t, range.distance);
}

/** Can this body still throw it (strikers attached, joints driving)? Mirrors control/abilities.canUse from telemetry. */
export function weaponUsable(w: WeaponRange, tel: RobotTelemetry): boolean {
  for (const id of w.strikers) if (tel.parts.find((p) => p.id === id)?.attached === false) return false;
  for (const name of w.joints) {
    const j = tel.joints.find((x) => x.name === name);
    if (j && (j.state === 'limp' || j.state === 'seized')) return false;
  }
  return true;
}

/** The design's own strike abilities that still work, with their ranges. */
export function armedWeapons(design: RobotDesign, tel: RobotTelemetry): WeaponRange[] {
  const table = rangeTable(design);
  if (!table) return [];
  return abilityTactics(design).map((t) => table.byTactic.get(t)).filter((w): w is WeaponRange => !!w && weaponUsable(w, tel));
}

export interface WeaponFit { tactic: Tactic; fit: RangeFit }

/** Everything the mind needs about range this frame (numbers; the serializer turns them into words). */
export interface RangeRead {
  distance: number; // m, COM to COM: the gap these fits were read at
  mine: WeaponFit[]; // my working strike abilities
  his: WeaponFit[];
  myLongest: number; // m, the farthest gap one of my working weapons is thrown from (its edge; 0: none)
  hisLongest: number;
  /** Seconds until the first weapon on either side lands at the current closing speed (null: not closing, or already there). */
  meetS: number | null;
}

export function readRange(
  design: RobotDesign, me: RobotTelemetry, oppDesign: RobotDesign, opp: RobotTelemetry, distance: number, closingSpeed: number,
): RangeRead | null {
  const mt = RANGE_FACTS.enabled ? rangeTable(design) : null;
  if (!mt) return null;
  const ht = rangeTable(oppDesign);
  const mine = armedWeapons(design, me);
  const his = armedWeapons(oppDesign, opp);
  const myLongest = Math.max(0, ...mine.map((w) => w.edge));
  const hisLongest = Math.max(0, ...his.map((w) => w.edge));
  const edge = Math.max(myLongest, hisLongest);
  const meetS = closingSpeed >= CLOSING_MIN_MS && edge > 0 && distance > edge ? (distance - edge) / closingSpeed : null;
  return {
    distance,
    mine: mine.map((w) => ({ tactic: w.tactic, fit: fitAt(w, distance, mt.step) })),
    his: ht ? his.map((w) => ({ tactic: w.tactic, fit: fitAt(w, distance, ht.step) })) : [],
    myLongest, hisLongest, meetS,
  };
}

// ---------------------------------------------------------------- words

/** 'a', 'a and b', 'a, b and c'. */
function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function names(fits: readonly WeaponFit[], fit: RangeFit): string[] {
  return fits.filter((f) => f.fit === fit).map((f) => tacticWords(f.tactic));
}

const FIT_ORDER: readonly RangeFit[] = ['lands', 'step', 'close', 'far'];
const MINE_ALL: Record<RangeFit, string> = { lands: 'everything lands', step: 'everything needs a step in', close: 'too close for everything', far: 'everything too far' };

function mineGroup(names: readonly string[], fit: RangeFit, rest = false): string {
  const many = rest || names.length > 1;
  const who = rest ? 'the rest' : list(names);
  switch (fit) {
    case 'lands': return `${who} ${many ? 'land' : 'lands'}`;
    case 'step': return `${who} ${many ? 'need' : 'needs'} a step in`;
    case 'close': return `${who} too close`;
    default: return `${who} too far`;
  }
}

/**
 * 'jab and cross land; the rest need a step in' / 'everything lands': my working weapons grouped by fit,
 * the biggest group folded into "the rest" to keep the line short.
 */
export function fromHereWords(mine: readonly WeaponFit[]): string | null {
  if (!mine.length) return null;
  const groups = FIT_ORDER.map((fit) => ({ fit, names: names(mine, fit) })).filter((g) => g.names.length);
  if (groups.length === 1) return MINE_ALL[groups[0].fit];
  const biggest = groups.reduce((a, b) => (b.names.length >= a.names.length ? b : a));
  const parts = groups.filter((g) => g !== biggest).map((g) => mineGroup(g.names, g.fit));
  return [...parts, mineGroup(biggest.names, biggest.fit, true)].join('; ');
}

/** 'his jab and low kick reach you' / 'all his weapons one step off' / 'out of his range'. */
export function hisWeaponsWords(his: readonly WeaponFit[]): string | null {
  if (!his.length) return null;
  const lands = names(his, 'lands'), step = names(his, 'step');
  if (lands.length) return lands.length === his.length ? 'all his weapons reach you' : `his ${list(lands)} ${lands.length > 1 ? 'reach' : 'reaches'} you`;
  if (step.length) return step.length === his.length ? 'all his weapons one step off' : `his ${list(step)} one step off`;
  return his.every((f) => f.fit === 'close') ? 'too close for his weapons' : 'out of his range';
}

/** 'you out-reach him by ~15 cm' / 'he out-reaches you by ~20 cm' / 'even reach'. */
export function reachEdgeWords(myLongest: number, hisLongest: number): string | null {
  if (myLongest <= 0 || hisLongest <= 0) return null;
  const d = myLongest - hisLongest;
  if (Math.abs(d) < EVEN_REACH_M) return 'even reach';
  const cm = Math.max(CM_ROUND, Math.round((Math.abs(d) * 100) / CM_ROUND) * CM_ROUND);
  return d > 0 ? `you out-reach him by ~${cm} cm` : `he out-reaches you by ~${cm} cm`;
}

/** When the first blow can land at this closing speed, as a band (null: not closing, already in range, or far off). */
export function meetWords(meetS: number | null): string | null {
  if (meetS === null) return null;
  if (meetS < 0.5) return 'in range in under half a second';
  if (meetS < 1.2) return 'in range in about a second';
  if (meetS < 2.5) return 'in range in a couple of seconds';
  return null;
}

const FIT_NOTE: Record<StrikeFit, string> = { lands: 'lands from here', step: 'needs a step in', close: 'too close for it', far: 'too far from here', out: 'out of action' };

/** A tactic option's range note ('lands from here'), or null for footwork and bodies without skill ranges. */
export function fitNote(fit: StrikeFit | null): string | null {
  return fit ? FIT_NOTE[fit] : null;
}
