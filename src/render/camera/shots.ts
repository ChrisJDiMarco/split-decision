// Broadcast shot framing. Pure math in the physics frame (z-up, metres); the camera rig
// converts to three.js world space. Every shot is a function of the fighters' positions
// and the time since the cut, so it can be unit-tested without a renderer.
//
// Camera positions respect the arena (src/core/arena-spec.ts, src/render/arena/lighting.ts):
// cage-side cameras stand on the apron in the middle of a fence panel, halfway between two
// posts, shooting through the chain link at chest height; the overhead hangs below the
// lighting truss and never tilts up far enough to see it. shot-plan.ts checks the sight
// lines and picks the variant (`slot`) at the cut.
import { APOTHEM, panels } from '../../core/arena-spec';
import type { Corner, Vec3 } from '../../core/types';
import { fitFov } from './sightlines';

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
  /** Camera variant chosen at the cut: the fence panel for cage_low, the hard-cam position for wide. */
  slot?: number | null;
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

export const DEFAULT_ASPECT = 16 / 9;

export const FRAMING = {
  HARD_CAM_Y: -9.4,
  HARD_CAM_Z: 5.0, // high enough to see a centred fighter's feet over the top rail
  CAGE_CAM_OUT_M: 0.7, // cage-side lens this far outside the fence plane (on the apron)
  CAGE_CAM_PUSH_M: 0.3, // slow push toward the fence over the shot
  CAGE_CAM_Z: 1.2, // chest height of a standing fighter (COM ~1.05, head ~1.8)
  OVERHEAD_Z: 5.7, // below the fixture cans (~6.75 m) and the truss (7.25 m underside)
  OVERHEAD_BACK_M: 1.9, // horizontal offset toward the hard-cam side, for a slight tilt
  INSIDE_R: APOTHEM - 0.3, // in-cage cameras stay this far inside the fence
  CHEST_Z: 1.0,
} as const;

/** Hard-cam positions tried in order when a post or the top rail hides a fighter: [x offset, z offset]. */
export const WIDE_SLOTS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0.9, 0], [-0.9, 0], [0, 1.1], [1.8, 0.6], [-1.8, 0.6]];

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

/** Torso points a camera must see on fighter `c`: the COM and mid-chest. */
export function sightPoints(s: Subjects, c: Corner): Vec3[] {
  const [x, y, z] = s.pos[c];
  return [[x, y, z], [x, y, (z + Math.max(z, s.headZ[c])) / 2]];
}

/** Points that must be in frame for fighter `c`: hips to the top of the head. */
export function framePoints(s: Subjects, c: Corner): Vec3[] {
  const [x, y, z] = s.pos[c];
  return [[x, y, Math.max(0.1, z * 0.55)], [x, y, Math.max(z, s.headZ[c]) + 0.12]];
}

const bothFrame = (s: Subjects) => [...framePoints(s, 0), ...framePoints(s, 1)];

/** Mean chest height of the two fighters (drops when one is down). */
function chestZ(s: Subjects): number {
  const z = (c: Corner) => sightPoints(s, c)[1][2];
  return clamp((z(0) + z(1)) / 2, 0.35, 1.6);
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

const PANELS = panels();

const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * Fence panels for a cage-side shot, best first: the one the shot's sight line (from the
 * fighters' midpoint, perpendicular to their line, turned by `angle`) leaves the cage
 * through, then its neighbours outward.
 */
export function cagePanelOrder(shot: Shot, s: Subjects): number[] {
  const m = mid(s);
  const n = rotate2(perp(s, shot.side), shot.angle);
  const exit = rayToCircle([m[0], m[1]], n, APOTHEM);
  const az = Math.atan2(exit[1], exit[0]);
  return PANELS.map((p, i) => ({ i, gap: angleGap(p.normalAngle, az) }))
    .sort((a, b) => a.gap - b.gap)
    .map((p) => p.i);
}

type Framer = (shot: Shot, s: Subjects, t: number, aspect: number) => CameraPose;

const FRAMERS: Record<ShotKind, Framer> = {
  wide(shot, s, _t, aspect) {
    const m = mid(s);
    const sep = separation(s);
    const [dx, dz] = WIDE_SLOTS[shot.slot ?? 0] ?? WIDE_SLOTS[0];
    const pos: Vec3 = [m[0] * 0.35 + dx, FRAMING.HARD_CAM_Y, FRAMING.HARD_CAM_Z + dz];
    const target: Vec3 = [m[0] * 0.85, m[1] * 0.85, FRAMING.CHEST_Z * 0.9];
    return { pos, target, fov: clamp(Math.max(22 + sep * 3.5, fitFov(pos, target, bothFrame(s), aspect)), 24, 48) };
  },
  cage_low(shot, s, t, aspect) {
    const m = mid(s);
    const panel = PANELS[shot.slot ?? cagePanelOrder(shot, s)[0]];
    const n: [number, number] = [Math.cos(panel.normalAngle), Math.sin(panel.normalAngle)];
    const out = FRAMING.CAGE_CAM_OUT_M - Math.min(FRAMING.CAGE_CAM_PUSH_M, t * 0.08); // slow push-in
    const r = APOTHEM + out;
    const pos: Vec3 = [n[0] * r, n[1] * r, FRAMING.CAGE_CAM_Z];
    const target: Vec3 = [m[0], m[1], chestZ(s)];
    return { pos, target, fov: clamp(Math.max(34, fitFov(pos, target, bothFrame(s), aspect)), 30, 64) };
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
  follow(shot, s, t, aspect) {
    const me = s.pos[shot.subject];
    const them = s.pos[shot.subject === 0 ? 1 : 0];
    const d = lineDir(s, shot.subject);
    const n = rotate2(perp(s, shot.side), shot.angle + t * 0.06);
    const target: Vec3 = [me[0] * 0.7 + them[0] * 0.3, me[1] * 0.7 + them[1] * 0.3, FRAMING.CHEST_Z + 0.05];
    const placed = placeInside(target, [me[0] + n[0] * 4.2 - d[0] * 0.9, me[1] + n[1] * 4.2 - d[1] * 0.9, 1.45], 40);
    return { pos: placed.pos, target, fov: clamp(Math.max(placed.fov, fitFov(placed.pos, target, bothFrame(s), aspect)), 30, 62) };
  },
  overhead(shot, s, t, aspect) {
    const m = mid(s);
    const off = rotate2([0, -FRAMING.OVERHEAD_BACK_M], t * 0.05 + shot.angle); // tilted toward the hard-cam side
    const pos: Vec3 = [m[0] + off[0], m[1] + off[1], FRAMING.OVERHEAD_Z];
    const target: Vec3 = [m[0], m[1], 0.4];
    return { pos, target, fov: clamp(Math.max(42, fitFov(pos, target, bothFrame(s), aspect)), 40, 72) };
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
  replay(shot, s, t, aspect) {
    const c = replayFocus(shot, s);
    const a = shot.angle + t * 0.2;
    const target: Vec3 = [c[0], c[1], clamp(c[2], 0.7, 1.5)];
    const placed = placeInside(target, [c[0] + Math.cos(a) * 3.8, c[1] + Math.sin(a) * 3.8, 1.1 + 0.2 * Math.sin(t * 0.4)], 34);
    const keep = [target, ...framePoints(s, 0), ...framePoints(s, 1)];
    return { pos: placed.pos, target, fov: clamp(Math.max(placed.fov, fitFov(placed.pos, target, keep, aspect)), 30, 64) };
  },
};

/**
 * What a replay centres on: the impact point when the fighters are still around it (the
 * money moment), drifting toward them when the lead-in starts elsewhere. With no impact
 * (a self-inflicted fall) it centres between the fighters, weighted to the shot's subject.
 */
export function replayFocus(shot: Shot, s: Subjects): Vec3 {
  const me = s.pos[shot.subject];
  const them = s.pos[shot.subject === 0 ? 1 : 0];
  const pair: Vec3 = [me[0] * 0.65 + them[0] * 0.35, me[1] * 0.65 + them[1] * 0.35, me[2] * 0.65 + them[2] * 0.35];
  const a = shot.anchor;
  if (!a) return pair;
  const away = Math.hypot(a[0] - pair[0], a[1] - pair[1]);
  const w = clamp((away - 1.2) / 2.5, 0, 0.7); // 0 = the impact point, up to 0.7 toward the fighters
  return [a[0] + (pair[0] - a[0]) * w, a[1] + (pair[1] - a[1]) * w, a[2] + (pair[2] - a[2]) * w];
}

export function shotPose(shot: Shot, subjects: Subjects, t: number, aspect = DEFAULT_ASPECT): CameraPose {
  return FRAMERS[shot.kind](shot, subjects, t, aspect);
}

/** The shot side that keeps the camera on the hard-cam half of the fighter line (y < 0). */
export function hardCamSide(s: Subjects): 1 | -1 {
  const n = perp(s, 1);
  return n[1] <= 0 ? 1 : -1;
}
