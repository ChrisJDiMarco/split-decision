// Hand poses for the kit-drawn dexterous fingers (recipes/hands.ts). The grip comes from, in
// order: a harness override, the physics grip command (RobotTelemetry.grip), else what the body
// is doing: a fist to strike or guard, open to grab in the clinch, flat and braced when falling
// or getting up, relaxed otherwise. Physics phalanx bodies (a dexterous loadout in a real fight)
// follow their own poses and need nothing here; handPoseAngles gives FK the same poses.
import * as THREE from 'three/webgpu';
import type { RobotTelemetry } from '../../core/protocol';
import type { RobotDesign } from '../../core/types';
import { FINGER_FLEX, THUMB_FLEX } from './recipes/hands';
import type { FingerJoint, HandPose, HandState, RobotKitView } from './types';

const GRIP_RATE = 14; // 1/s: fingers close in ~0.15 s
const SPREAD_RATE = 10;

export const HAND_POSES = {
  fist: { grip: 1, spread: 0 },
  open: { grip: 0, spread: 0 },
  brace: { grip: 0, spread: 1 },
  relaxed: { grip: 0.42, spread: 0.1 },
  limp: { grip: 0.3, spread: 0.25 },
} as const satisfies Record<string, HandPose>;

const STRIKES = /^(jab|cross|hook|uppercut|overhand|rocket|superman|spinning_backfist|hammer|shield|guard|combo|feint)/;
const KICKS = /(kick|knee|sprint|lunge|ram)/;
const BRACE = /^(getup|rise|kip|fall|roll)/;

export function newHandState(): HandState {
  return { pose: { l: { ...HAND_POSES.relaxed }, r: { ...HAND_POSES.relaxed } }, override: {} };
}

/** The physics grip command (RobotTelemetry.grip, dexterous hands only). */
export function telemetryHands(tel: RobotTelemetry | undefined): { l: HandPose; r: HandPose } | null {
  const g = tel?.grip;
  if (!g || !Number.isFinite(g.l) || !Number.isFinite(g.r)) return null;
  // The physics commands closure only; spread the fingers when the command is open and the
  // robot is down or rising (a flat hand on the canvas).
  const brace = !!tel && (tel.down || BRACE.test(tel.skill));
  const pose = (v: number): HandPose => ({ grip: Math.min(1, Math.max(0, v)), spread: brace ? Math.max(0, 1 - v * 2) : 0 });
  return { l: pose(g.l), r: pose(g.r) };
}

/** What the hands should do given what the body is doing (no physics hand state). */
export function derivedHands(tel: RobotTelemetry | undefined): HandPose {
  if (!tel) return HAND_POSES.relaxed;
  const skill = tel.skill;
  if (skill === 'out') return HAND_POSES.limp;
  if (tel.down || BRACE.test(skill)) return HAND_POSES.brace;
  if (skill === 'clinch' || tel.intent?.tactic === 'clinch') return { grip: 0.18, spread: 0.1 };
  if (tel.windup > 0.05 || STRIKES.test(skill)) return HAND_POSES.fist;
  if (KICKS.test(skill)) return { grip: 0.9, spread: 0 };
  // In the fight the guard is up: loosely closed. Idle between rounds: relaxed.
  if (tel.intent && tel.intent.aggression > 0.2) return { grip: 0.78, spread: 0 };
  return HAND_POSES.relaxed;
}

function poseJoint(j: FingerJoint, p: HandPose): void {
  const curl = THREE.MathUtils.lerp(j.pose.open, j.pose.fist, p.grip);
  j.pivot.quaternion.setFromAxisAngle(j.axis, THREE.MathUtils.lerp(curl, j.pose.brace, p.spread));
}

/** Advance one robot's kit-drawn fingers. */
export function updateHands(view: RobotKitView, tel: RobotTelemetry | undefined, dt: number): void {
  const fingers = view.animated.fingers;
  if (fingers.length === 0) return;
  const h = view.hands;
  const phys = telemetryHands(tel);
  const auto = derivedHands(tel);
  for (const side of ['l', 'r'] as const) {
    const target = h.override[side] ?? phys?.[side] ?? auto;
    const cur = h.pose[side];
    cur.grip += (target.grip - cur.grip) * (1 - Math.exp(-GRIP_RATE * dt));
    cur.spread += (target.spread - cur.spread) * (1 - Math.exp(-SPREAD_RATE * dt));
  }
  for (const j of fingers) {
    const kit = view.parts.get(j.part);
    const side = kit?.def.tags.includes('right') ? 'r' : 'l';
    poseJoint(j, h.pose[side]);
  }
}

/** Joint angles (rad) that put a design's phalanx joints in a hand pose (FK previews, tests). */
export function handPoseAngles(design: RobotDesign, side: 'l' | 'r', p: HandPose): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of design.parts) {
    if (!part.tags.includes('finger') || !part.tags.includes(side === 'l' ? 'left' : 'right')) continue;
    const j = part.joints?.[0];
    if (!j) continue;
    const thumb = part.visual.params?.thumb === true;
    const seg = part.visual.params?.seg === 'd' ? 'd' : 'p';
    const pose = (thumb ? THUMB_FLEX : FINGER_FLEX)[seg];
    out[j.name] = THREE.MathUtils.lerp(THREE.MathUtils.lerp(pose.open, pose.fist, p.grip), pose.brace, p.spread);
  }
  return out;
}
