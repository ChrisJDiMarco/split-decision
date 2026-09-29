// Broadcast shot framing. Pure math in the physics frame (z-up, metres); the camera rig
// converts to three.js world space. Every shot is a function of the fighters' positions
// and the time since the cut, so it can be unit-tested without a renderer.
import { APOTHEM } from '../../core/arena-spec';
import type { Corner, Vec3 } from '../../core/types';

export type ShotKind =
  | 'wide' | 'cage_low' | 'ots' | 'follow' | 'overhead'
  | 'debris' | 'intro' | 'victory' | 'replay' | 'establish';

export interface Shot {
  kind: ShotKind;
  subject: Corner; // whose shot it is (ots: over this fighter's shoulder)
  side: 1 | -1; // which side of the fighter line the camera sits on
  anchor: Vec3 | null; // fixed point for debris / replay shots
  focusBody: number | null; // body the debris shot tracks
  angle: number; // base azimuth for orbiting shots, radians
}

export interface Subjects {
  pos: [Vec3, Vec3]; // fighter root / COM positions
  headZ: [number, number]; // head height above the canvas
  heading: [number, number];
  down: [boolean, boolean];
  bodyPos?: (body: number) => Vec3 | null;
}

export interface CameraPose {
  pos: Vec3;
  target: Vec3;
  fov: number;
}

export const FRAMING = {
  HARD_CAM_Y: -9.4,
  HARD_CAM_Z: 4.1,
  CAGE_CAM_R: APOTHEM + 0.75, // on the apron, shooting through the fence
  CAGE_CAM_Z: 0.55,
  INSIDE_R: APOTHEM - 0.3, // in-cage cameras stay this far inside the fence
  CHEST_Z: 1.0,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function mid(s: Subjects): Vec3 {
  const [a, b] = s.pos;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** Unit vector from fighter `from` to the other one, in the ground plane. */
function lineDir(s: Subjects, from: Corner): [number, number] {
  const a = s.pos[from];
  const b = s.pos[from === 0 ? 1 : 0];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len > 1e-3 ? [dx / len, dy / len] : [1, 0];
}

function separation(s: Subjects): number {
  return Math.hypot(s.pos[1][0] - s.pos[0][0], s.pos[1][1] - s.pos[0][1]);
}

/** Perpendicular to the fighter line on the shot's side (the 180° rule keeps side stable). */
function perp(s: Subjects, side: 1 | -1): [number, number] {
  const [dx, dy] = lineDir(s, 0);
  return [-dy * side, dx * side];
}

function rotate2(v: [number, number], a: number): [number, number] {
  const c = Math.cos(a);
  const sn = Math.sin(a);
  return [v[0] * c - v[1] * sn, v[0] * sn + v[1] * c];
}

/**
 * Keep an in-cage camera inside the fence without pushing it into the fighters: slide it
 * toward `focus` along the line of sight, and widen the lens so the framing holds.
 */
export function placeInside(focus: Vec3, desired: Vec3, fov: number, radius: number = FRAMING.INSIDE_R): { pos: Vec3; fov: number } {
  if (Math.hypot(desired[0], desired[1]) <= radius) return { pos: desired, fov };
  const f2: [number, number] = [focus[0], focus[1]];
  const fr = Math.hypot(f2[0], f2[1]);
  const from: [number, number] = fr < radius ? f2 : [(f2[0] / fr) * radius * 0.9, (f2[1] / fr) * radius * 0.9];
  const dx = desired[0] - from[0];
  const dy = desired[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const edge = rayToCircle(from, [dx / len, dy / len], radius);
  const want = Math.hypot(desired[0] - focus[0], desired[1] - focus[1], desired[2] - focus[2]);
  const got = Math.max(0.5, Math.hypot(edge[0] - focus[0], edge[1] - focus[1], desired[2] - focus[2]));
  const half = (fov * Math.PI) / 360;
  const wider = (Math.atan(Math.tan(half) * (want / got)) * 360) / Math.PI;
  return { pos: [edge[0], edge[1], desired[2]], fov: Math.min(75, wider) };
}

/** Point where the ray from `o` along `d` leaves the circle of radius R (o inside it). */
export function rayToCircle(o: [number, number], d: [number, number], R: number): [number, number] {
  const b = o[0] * d[0] + o[1] * d[1];
  const c = o[0] * o[0] + o[1] * o[1] - R * R;
  const s = -b + Math.sqrt(Math.max(0, b * b - c));
  return [o[0] + d[0] * s, o[1] + d[1] * s];
}

const DEBRIS_IGNORE_M = 0.9; // the victim lies at the anchor; don't count it as a blocker
const FIGHTER_CLEARANCE_M = 0.55;

/** Ground-plane distance from `b` to the segment a→t is at least the fighter clearance. */
function clearOf(a: Vec3, t: Vec3, b: Vec3): boolean {
  const dx = t[0] - a[0];
  const dy = t[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / len2));
  return Math.hypot(a[0] + dx * u - b[0], a[1] + dy * u - b[1]) >= FIGHTER_CLEARANCE_M;
}

const NEAR_CAMERA_M = 1.6; // a fighter this close to the lens fills the frame

type Framer = (shot: Shot, s: Subjects, t: number) => CameraPose;

const FRAMERS: Record<ShotKind, Framer> = {
  wide(_shot, s) {
    const m = mid(s);
    const sep = separation(s);
    return {
      pos: [m[0] * 0.35, FRAMING.HARD_CAM_Y, FRAMING.HARD_CAM_Z],
      target: [m[0] * 0.85, m[1] * 0.85, FRAMING.CHEST_Z * 0.9],
      fov: clamp(22 + sep * 3.5, 24, 40),
    };
  },
  cage_low(shot, s, t) {
    const m = mid(s);
    const target: Vec3 = [m[0], m[1], FRAMING.CHEST_Z + 0.1];
    const push = Math.min(0.5, t * 0.07); // slow push-in toward the action
    const fov = clamp(30 + separation(s) * 3, 34, 48);
    const n = rotate2(perp(s, shot.side), shot.angle);
    const edge = rayToCircle([m[0], m[1]], n, FRAMING.CAGE_CAM_R);
    return { pos: [edge[0] - n[0] * push, edge[1] - n[1] * push, FRAMING.CAGE_CAM_Z], target, fov };
  },
  ots(shot, s) {
    const me = s.pos[shot.subject];
    const them = s.pos[shot.subject === 0 ? 1 : 0];
    const d = lineDir(s, shot.subject);
    const side: [number, number] = [-d[1] * shot.side, d[0] * shot.side];
    const target: Vec3 = [them[0], them[1], FRAMING.CHEST_Z + 0.15];
    const placed = placeInside(target, [me[0] - d[0] * 1.7 + side[0] * 0.6, me[1] - d[1] * 1.7 + side[1] * 0.6, s.headZ[shot.subject] + 0.3], 44);
    return { pos: placed.pos, target, fov: placed.fov };
  },
  follow(shot, s, t) {
    const me = s.pos[shot.subject];
    const them = s.pos[shot.subject === 0 ? 1 : 0];
    const d = lineDir(s, shot.subject);
    const n = rotate2(perp(s, shot.side), t * 0.06);
    const target: Vec3 = [me[0] * 0.7 + them[0] * 0.3, me[1] * 0.7 + them[1] * 0.3, FRAMING.CHEST_Z + 0.05];
    const placed = placeInside(target, [me[0] + n[0] * 4.2 - d[0] * 0.9, me[1] + n[1] * 4.2 - d[1] * 0.9, 1.45], 40);
    return { pos: placed.pos, target, fov: placed.fov };
  },
  overhead(shot, s, t) {
    const m = mid(s);
    const off = rotate2([0, -2.2], t * 0.05 + shot.angle); // tilted toward the hard-cam side
    return { pos: [m[0] + off[0], m[1] + off[1], 8.8], target: [m[0], m[1], 0.4], fov: 42 };
  },
  debris(shot, s) {
    const tracked = shot.focusBody !== null ? s.bodyPos?.(shot.focusBody) ?? null : null;
    const focus = tracked ?? shot.anchor ?? mid(s);
    const a = shot.anchor ?? focus;
    const n = rotate2(perp(s, shot.side), shot.angle);
    const target: Vec3 = [focus[0], focus[1], Math.max(0.2, focus[2])];
    const placed = placeInside(a, [a[0] + n[0] * 3.4, a[1] + n[1] * 3.4, 1.6], 38);
    return { pos: placed.pos, target, fov: placed.fov };
  },
  intro(shot, s, t) {
    const me = s.pos[shot.subject];
    const a = shot.angle + t * 0.18;
    const target: Vec3 = [me[0], me[1], s.headZ[shot.subject] * 0.6];
    const placed = placeInside(target, [me[0] + Math.cos(a) * 3.4, me[1] + Math.sin(a) * 3.4, 1.35], 38);
    return { pos: placed.pos, target, fov: placed.fov };
  },
  victory(shot, s, t) {
    const me = s.pos[shot.subject];
    const a = shot.angle + t * 0.12;
    const target: Vec3 = [me[0], me[1], s.headZ[shot.subject] - 0.3];
    const placed = placeInside(target, [me[0] + Math.cos(a) * 3.2, me[1] + Math.sin(a) * 3.2, 0.5], 38);
    return { pos: placed.pos, target, fov: placed.fov };
  },
  establish(shot, _s, t) {
    const a = shot.angle + t * 0.045; // slow crane around the whole cage
    return { pos: [Math.cos(a) * 8.2, Math.sin(a) * 8.2, 3.4 + Math.sin(t * 0.1) * 0.4], target: [0, 0, 0.9], fov: 40 };
  },
  replay(shot, s, t) {
    const c = shot.anchor ?? mid(s);
    const a = shot.angle + t * 0.2;
    const target: Vec3 = [c[0], c[1], clamp(c[2], 0.7, 1.5)];
    const placed = placeInside(target, [c[0] + Math.cos(a) * 3.8, c[1] + Math.sin(a) * 3.8, 1.1 + 0.2 * Math.sin(t * 0.4)], 34);
    return { pos: placed.pos, target, fov: placed.fov };
  },
};

export function shotPose(shot: Shot, subjects: Subjects, t: number): CameraPose {
  return FRAMERS[shot.kind](shot, subjects, t);
}

/** The shot side that keeps the camera on the hard-cam half of the fighter line (y < 0). */
export function hardCamSide(s: Subjects): 1 | -1 {
  const n = perp(s, 1);
  return n[1] <= 0 ? 1 : -1;
}

const RESOLVE_TURNS = [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4];
const RESOLVED: ReadonlySet<ShotKind> = new Set<ShotKind>(['cage_low', 'debris', 'replay']);

/**
 * Called once at a cut: rotate the shot (via `angle`) to the first orientation whose sight
 * line no fighter blocks and no fighter hugs the lens. Deciding at the cut keeps the camera
 * from swinging mid-shot. Fighters at the shot's anchor (a victim under its own flying
 * head) don't count as blockers.
 */
export function resolveShot(shot: Shot, s: Subjects): Shot {
  if (!RESOLVED.has(shot.kind)) return shot;
  const anchor = shot.anchor;
  const blockers = anchor ? s.pos.filter((p) => Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) > DEBRIS_IGNORE_M) : s.pos;
  for (const turn of RESOLVE_TURNS) {
    const cand = { ...shot, angle: shot.angle + turn };
    const pose = shotPose(cand, s, 0);
    const ok = blockers.every((b) => clearOf(pose.pos, pose.target, b) && Math.hypot(pose.pos[0] - b[0], pose.pos[1] - b[1]) > NEAR_CAMERA_M);
    if (ok) return cand;
  }
  return shot;
}
