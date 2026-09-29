// Weak-spot map: where a fighter should hit its opponent right now, and why. Built from
//   damage      failing drives (health, state), gear slop and heat per zone; cracked shells
//   design      armour material and thickness per zone, a glass jaw (his head-break impulse against
//               your clean-shot power), a tall body on a narrow base, a light frame, slow hip drives
//   live state  guard gaps (guard.ts), a drained gyro, his lead leg, what keeps landing where
// The top few zones go to the brain, which words them for Jev ("his left knee is at 40% and his
// guard is high: low kick"). Pure functions of snapshots plus a static scouting report of his design.
import type { TargetZone, WeakReason, WeakSpot } from '../../core/protocol';
import type { MaterialId, PartDef, RobotDesign } from '../../core/types';
import { stanceOf } from './detect';
import type { GuardRead } from './guard';
import { gyroBudget } from './risk';
import type { BodySnapshot } from './snapshot';

// ---------------------------------------------------------------- scouting report (static, per design)

/**
 * Shell thickness per design (mm), from src/robots/designs (the builder does not keep its shell spec
 * on the RobotDesign): body/limb shells, head shell. Unknown designs: thickness left out.
 */
export const SHELL_MM: Record<string, { body: number; head: number }> = {
  firecracker: { body: 2.5, head: 2.5 },
  savate: { body: 2.5, head: 3 },
  haymaker: { body: 7, head: 8 },
  pylon: { body: 2.5, head: 3 },
};

/** Shell materials that give under repeated shots at the thickness the roster uses. */
const SOFT_SHELLS: ReadonlySet<MaterialId> = new Set(['polycarb', 'carbon']);
const SOFT_SHELL_MAX_MM = 4;
/**
 * A clean power shot's impulse per kg of the thrower: mirror-match head strikes measured 8 N·s for
 * the 38 kg bantam, 17 for the 83 kg SAVATE and 29 for the 103 kg HAYMAKER (designs/index.ts), about
 * 0.2-0.28 N·s per kg.
 */
export const CLEAN_SHOT_NS_PER_KG = 0.22;
export const GLASS_JAW_RATIO = 1.05; // his head pops to one of your clean shots below this
export const NARROW_BASE_RATIO = 4.5; // COM height / hip span (PYLON ≈ 4.9, the others 3.5-4.1)
export const LIGHT_FRAME_RATIO = 1.35; // you outweigh him by this much
export const SLOW_LEGS_RAD_S = 16; // hip pitch no-load speed (HAYMAKER's X12: 13.1; the others 22-34)

export interface DesignScout {
  design: string;
  armor: Partial<Record<TargetZone, { material: MaterialId; mm: number | null }>>;
  headBreakNs: number | null;
  hipSpan: number; // m between the hip joints
  hipSpeed: number; // rad/s, no-load at the hip pitch drive
  massKg: number;
}

/** Which target zone a part belongs to, from its tags (same rule as the brain's partZone). */
export function zoneOfPart(part: Pick<PartDef, 'tags'>): TargetZone | null {
  const t = new Set<string>(part.tags);
  if (t.has('head') || t.has('neck')) return 'head';
  if (t.has('hammer') || t.has('spinner') || t.has('jaw') || t.has('shield')) return 'weapon';
  const side = t.has('left') ? 'left' : t.has('right') ? 'right' : null;
  const arm = t.has('upperarm') || t.has('forearm') || t.has('fist') || t.has('finger');
  const leg = t.has('thigh') || t.has('shin') || t.has('foot') || t.has('leg') || t.has('wheel');
  if (side && arm) return `${side}_arm`;
  if (side && leg) return `${side}_leg`;
  if (t.has('torso') || t.has('pelvis') || t.has('chassis') || t.has('armor') || t.has('gyro')) return 'torso';
  return null;
}

export function scoutDesign(design: RobotDesign, massKg: number, hipSpeed: number): DesignScout {
  const shell = SHELL_MM[design.id];
  const armor: DesignScout['armor'] = {};
  for (const p of design.parts) {
    const zone = zoneOfPart(p);
    if (!zone || armor[zone]) continue;
    const g = p.geoms.find((x) => x.role === 'armor' || (zone === 'head' && x.role === 'sensor'));
    if (!g) continue;
    armor[zone] = { material: g.material, mm: shell ? (zone === 'head' ? shell.head : shell.body) : null };
  }
  const thighs = design.parts.filter((p) => p.tags.includes('thigh'));
  const hipSpan = thighs.length === 2 ? Math.abs(thighs[0].pos[1] - thighs[1].pos[1]) : 0.2;
  const head = design.parts.find((p) => p.tags.includes('head'));
  return { design: design.id, armor, headBreakNs: head?.detachable?.impulseNs ?? null, hipSpan, hipSpeed, massKg };
}

// ---------------------------------------------------------------- the map

export interface PartState { id: string; zone: TargetZone | null; hp: number; attached: boolean }

export interface WeakSpotInput {
  me: BodySnapshot;
  opp: BodySnapshot;
  scout: DesignScout;
  parts: readonly PartState[];
  guard: GuardRead | null;
  landed: Partial<Record<TargetZone, number>>; // my strikes that landed on each of his zones this fight
}

export const MAX_WEAK_SPOTS = 3;
export const MIN_WEAK_SCORE = 0.12;
const MAX_REASONS = 3;

// Reason weights (each adds to its zone's score, which is capped at 1).
const W = {
  jointWear: 0.9, // × (1 − health) of the worst drive
  jointState: { ok: 0, degraded: 0.1, limp: 0.3, seized: 0.3 } as const,
  slop: 0.2, // × slop fraction
  hot: 0.15,
  cracked: 0.6, // × (1 − hp) once hp < CRACKED_HP
  soft: 0.05,
  glass: 0.35,
  narrowTorso: 0.15,
  narrowLeg: 0.12,
  light: 0.15,
  slowLegs: 0.1,
  gyroTorso: 0.15, // × (1 − budget)
  gyroLeg: 0.1,
  headOpen: 0.35,
  headSideOpen: 0.2,
  bodyOpen: 0.25,
  armFailingHead: 0.15, // his arm on a side is failing: that side of his head is open
  leadLeg: 0.06,
  landedEach: 0.06,
  landedMax: 0.25,
};
const CRACKED_HP = 0.8;
const JOINT_WORN = 0.9;
const HOT = 0.8;
const SLOP_MIN = 0.15;
const GYRO_DRAINED = 0.6; // budget below this

const LEG_JOINT = /^(hip|knee|ankle)(_[a-z]+)?_([lr])$/;
const ARM_JOINT = /^(shoulder|elbow)(_[a-z]+)?_([lr])$/;

interface Acc { score: number; reasons: Array<{ w: number; r: WeakReason }>; side?: 'left' | 'right' }

function add(acc: Acc, w: number, r: WeakReason): void {
  if (w <= 0) return;
  acc.score += w;
  acc.reasons.push({ w, r });
}

function jointReasons(acc: Acc, opp: BodySnapshot, re: RegExp, side: 'l' | 'r'): void {
  let worst: { name: string; health: number; state: keyof typeof W.jointState; sev: number } | null = null;
  let slop = 0, heat = 0, slopJoint = '', hotJoint = '';
  for (const j of opp.joints) {
    const m = re.exec(j.name);
    if (!m || m[3] !== side) continue;
    const sev = W.jointWear * (1 - j.health) + W.jointState[j.state];
    if (!worst || sev > worst.sev) worst = { name: j.name, health: j.health, state: j.state, sev };
    if ((j.slop ?? 0) > slop) { slop = j.slop ?? 0; slopJoint = j.name; }
    if (j.heat > heat) { heat = j.heat; hotJoint = j.name; }
  }
  if (worst && (worst.health < JOINT_WORN || worst.state !== 'ok')) {
    add(acc, worst.sev, { kind: 'joint_failing', part: worst.name, value: worst.health });
  }
  if (slop >= SLOP_MIN) add(acc, W.slop * Math.min(1, slop), { kind: 'joint_slop', part: slopJoint, value: slop });
  if (heat >= HOT) add(acc, W.hot, { kind: 'joint_hot', part: hotJoint, value: heat });
}

function crackedReason(acc: Acc, parts: readonly PartState[], zone: TargetZone): void {
  let worst: PartState | null = null;
  for (const p of parts) if (p.zone === zone && p.attached && (!worst || p.hp < worst.hp)) worst = p;
  if (worst && worst.hp < CRACKED_HP) add(acc, W.cracked * (1 - worst.hp), { kind: 'armor_cracked', part: worst.id, value: worst.hp });
}

function softReason(acc: Acc, scout: DesignScout, zone: TargetZone): void {
  const a = scout.armor[zone];
  if (a && SOFT_SHELLS.has(a.material) && (a.mm === null || a.mm <= SOFT_SHELL_MAX_MM)) {
    add(acc, W.soft, { kind: 'soft_armor', part: a.material, ...(a.mm !== null ? { value: a.mm } : {}) });
  }
}

function landedReason(acc: Acc, n: number | undefined): void {
  if (n) add(acc, Math.min(W.landedMax, W.landedEach * n), { kind: 'keeps_landing', value: n });
}

/** His best targets right now, highest score first (at most MAX_WEAK_SPOTS, each ≥ MIN_WEAK_SCORE). */
export function weakSpots(input: WeakSpotInput): WeakSpot[] {
  const { me, opp, scout, parts, guard, landed } = input;
  if (opp.ko) return [];
  const acc = new Map<TargetZone, Acc>();
  const at = (z: TargetZone): Acc => {
    let a = acc.get(z);
    if (!a) { a = { score: 0, reasons: [] }; acc.set(z, a); }
    return a;
  };
  const headOn = opp.chinZ !== null;
  const baseRatio = scout.hipSpan > 0 ? opp.com[2] / scout.hipSpan : 0;
  const narrow = !opp.down && baseRatio >= NARROW_BASE_RATIO;
  const light = me.massKg / Math.max(1, opp.massKg);
  const budget = opp.gyro ? gyroBudget(opp) : 1;
  const lead = opp.feet && !opp.down ? (stanceOf(opp, me) === 'orthodox' ? 'l' : 'r') : null;

  // Head
  if (headOn) {
    const h = at('head');
    if (scout.headBreakNs !== null) {
      const ratio = scout.headBreakNs / Math.max(1, CLEAN_SHOT_NS_PER_KG * me.massKg);
      if (ratio < GLASS_JAW_RATIO) add(h, W.glass * Math.min(1, (GLASS_JAW_RATIO - ratio) / 0.5 + 0.4), { kind: 'glass_jaw', value: ratio });
    }
    crackedReason(h, parts, 'head');
    if (guard && !guard.center && !guard.left && !guard.right) add(h, W.headOpen, { kind: 'guard_open' });
    else if (guard && (!guard.left || !guard.right)) {
      const side = !guard.left ? 'left' : 'right';
      h.side = side;
      add(h, (!guard.center ? W.headOpen : W.headSideOpen), { kind: 'guard_open', side });
    }
    for (const s of ['l', 'r'] as const) {
      const arm: Acc = { score: 0, reasons: [] };
      jointReasons(arm, opp, ARM_JOINT, s);
      const failing = arm.reasons.find((x) => x.r.kind === 'joint_failing');
      if (failing && (failing.r.value ?? 1) < 0.6) {
        add(h, W.armFailingHead, failing.r);
        h.side ??= s === 'l' ? 'left' : 'right';
      }
    }
    softReason(h, scout, 'head');
    landedReason(h, landed.head);
  }

  // Torso
  const t = at('torso');
  crackedReason(t, parts, 'torso');
  if (guard && !guard.body) add(t, W.bodyOpen, { kind: 'guard_open' });
  if (narrow) add(t, W.narrowTorso, { kind: 'narrow_base', value: baseRatio });
  if (light >= LIGHT_FRAME_RATIO) add(t, W.light, { kind: 'light_frame', value: light });
  if (opp.gyro && budget < GYRO_DRAINED) add(t, W.gyroTorso * (1 - budget), { kind: 'gyro_drained', value: budget });
  softReason(t, scout, 'torso');
  landedReason(t, landed.torso);

  // Legs
  for (const s of ['l', 'r'] as const) {
    const zone: TargetZone = s === 'l' ? 'left_leg' : 'right_leg';
    if (parts.some((p) => p.zone === zone) && !parts.some((p) => p.zone === zone && p.attached)) continue;
    const g = at(zone);
    jointReasons(g, opp, LEG_JOINT, s);
    crackedReason(g, parts, zone);
    if (narrow) add(g, W.narrowLeg, { kind: 'narrow_base', value: baseRatio });
    if (scout.hipSpeed > 0 && scout.hipSpeed < SLOW_LEGS_RAD_S) add(g, W.slowLegs, { kind: 'slow_legs', value: scout.hipSpeed });
    if (opp.gyro && budget < GYRO_DRAINED) add(g, W.gyroLeg * (1 - budget), { kind: 'gyro_drained', value: budget });
    if (lead === s) add(g, W.leadLeg, { kind: 'lead_leg' });
    landedReason(g, landed[zone]);
  }

  return [...acc]
    .map(([zone, a]) => ({
      zone,
      score: Math.min(1, a.score),
      reasons: a.reasons.sort((x, y) => y.w - x.w).slice(0, MAX_REASONS).map((x) => x.r),
      ...(a.side ? { side: a.side } : {}),
    }))
    .filter((w) => w.score >= MIN_WEAK_SCORE && w.reasons.some((r) => r.kind !== 'lead_leg' && r.kind !== 'soft_armor'))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_WEAK_SPOTS);
}
