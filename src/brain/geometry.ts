// Relative fight geometry from two telemetry snapshots (MuJoCo world frame, z-up).
// Everything here is numeric; bands.ts turns it into words for Jev.
import { APOTHEM, panels } from '../core/arena-spec';
import type { RobotTelemetry } from '../core/protocol';
import type { PartDef, RobotDesign } from '../core/types';

/** Parts that anchor limbs; a limb's reach is measured from the first part below these. */
const CORE_TAGS = new Set(['torso', 'pelvis', 'chassis']);
/** Parts that land blows. */
const STRIKER_TAGS = new Set(['fist', 'foot', 'hammer', 'jaw', 'spinner', 'shield', 'wheel']);
const DEFAULT_LIMB_M = 0.8;
const BODY_MARGIN_M = 0.2; // torso half-depth plus a little slack

export interface Geometry {
  distance: number; // horizontal COM-to-COM, m
  bearingRad: number; // opponent direction relative to my heading, CCW positive (left)
  oppBearingRad: number; // my direction relative to the opponent's heading
  closingSpeed: number; // m/s, positive when the gap is shrinking
  oppApproachSpeed: number; // m/s of the opponent's own motion toward me
  lateralSpeed: number; // m/s of the opponent across my line of sight
  cageGap: number; // m from my COM to the nearest fence panel
  cageBearingRad: number; // that panel's direction relative to my heading
  oppCageGap: number;
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

const PANELS = panels().map((p) => ({ nx: Math.cos(p.normalAngle), ny: Math.sin(p.normalAngle) }));

/** Distance to the nearest fence panel of the regular polygon, and that panel's outward normal angle. */
export function cageGap(x: number, y: number): { gap: number; normalAngle: number } {
  let best = -Infinity;
  let angle = 0;
  for (const p of PANELS) {
    const d = x * p.nx + y * p.ny;
    if (d > best) { best = d; angle = Math.atan2(p.ny, p.nx); }
  }
  return { gap: Math.max(0, APOTHEM - best), normalAngle: angle };
}

export function computeGeometry(me: RobotTelemetry, opp: RobotTelemetry): Geometry {
  const dx = opp.comWorld[0] - me.comWorld[0];
  const dy = opp.comWorld[1] - me.comWorld[1];
  const distance = Math.hypot(dx, dy);
  const ux = distance > 1e-6 ? dx / distance : 1;
  const uy = distance > 1e-6 ? dy / distance : 0;
  const rvx = opp.velocity[0] - me.velocity[0];
  const rvy = opp.velocity[1] - me.velocity[1];
  const dirToOpp = Math.atan2(dy, dx);
  const myCage = cageGap(me.comWorld[0], me.comWorld[1]);
  const oppCage = cageGap(opp.comWorld[0], opp.comWorld[1]);
  return {
    distance,
    bearingRad: wrapAngle(dirToOpp - me.heading),
    oppBearingRad: wrapAngle(dirToOpp + Math.PI - opp.heading),
    closingSpeed: -(rvx * ux + rvy * uy),
    oppApproachSpeed: -(opp.velocity[0] * ux + opp.velocity[1] * uy),
    lateralSpeed: Math.abs(-rvx * uy + rvy * ux),
    cageGap: myCage.gap,
    cageBearingRad: wrapAngle(myCage.normalAngle - me.heading),
    oppCageGap: oppCage.gap,
  };
}

function limbLength(part: PartDef, byId: Map<string, PartDef>): number {
  let len = 0;
  let cur: PartDef | undefined = part;
  while (cur?.parent) {
    const parent = byId.get(cur.parent);
    if (!parent || parent.tags.some((t) => CORE_TAGS.has(t))) break;
    len += Math.hypot(cur.pos[0], cur.pos[1], cur.pos[2]);
    cur = parent;
  }
  return len;
}

/** How far this design lands a blow from its COM, measured over its striking limbs. */
export function designReach(design: RobotDesign): number {
  const byId = new Map(design.parts.map((p) => [p.id, p]));
  let best = 0;
  for (const p of design.parts) {
    const striker = p.tags.some((t) => STRIKER_TAGS.has(t)) || p.geoms.some((g) => g.role === 'striker' || g.role === 'weapon');
    if (striker) best = Math.max(best, limbLength(p, byId));
  }
  return (best > 0 ? best : DEFAULT_LIMB_M) + BODY_MARGIN_M;
}
