// What a polished move is scored against (move-polish.md §3.2): the library move as sample() returns
// it, posed on the robot's own kinematics (a scratch MjData, mj_forward per 60 Hz frame) to get the
// mass-aware COM, the planted soles, fists, knees and the striker where the clip puts them.
import { CONTACT, sample, type Move } from '../../src/robots/motions';
import { quatMul, quatNormalize, quatYaw } from '../../src/robots/motions/math';
import type { Placement } from '../../src/robots/motions/polish/player';
import { quantizeTrack, TRACK_STRIDE } from '../../src/robots/motions/polish/format';
import type { PolishWorld } from './world';

export type MoveKind = 'punch' | 'kick' | 'getup' | 'flashy';

export function moveKind(move: Move): MoveKind {
  if (move.label.startsWith('getup')) return 'getup';
  if (['tornado_kick', 'spinning_back_kick', 'jump_kick', 'jumping_knee', 'superman_punch', 'spinning_backfist'].includes(move.label)) return 'flashy';
  if (move.label.endsWith('kick')) return 'kick';
  return 'punch';
}

export interface Reference {
  move: Move;
  kind: MoveKind;
  place: Placement;
  frames: number;
  fps: number;
  com: Float64Array; // frames × 3, world
  pelvis: Float64Array; // frames × 3
  pelvisQuat: Float64Array; // frames × 4
  torsoUp: Float64Array; // frames × 3
  torsoR: Float64Array; // frames × 9 (row-major world = R · local)
  /** Pelvis heading per frame, unwrapped, read off its lateral axis (defined lying down too). */
  heading: Float64Array;
  contacts: Uint8Array; // clip contact flags per frame, short foot gaps bridged
  sole: Float64Array; // frames × 6 (left, right sole centres)
  corners: Float64Array; // frames × 24 (each sole's four bottom corners)
  fist: Float64Array; // frames × 6
  knee: Float64Array; // frames × 6 (shin origins)
  striker: Float64Array | null; // frames × 3
  strikerBody: number;
  /** Robot joint → pose-cost weight (mass moved by the joint, normalised to sum 1). */
  poseW: Float64Array;
  standComZ: number;
  /** COM height of the clip at its last frame (get-ups end standing). */
  endComZ: number;
}

/** Place the clip pose of frame f (or clip time) into a qpos vector. */
export function poseQpos(w: PolishWorld, move: Move, tau: number, place: Placement, qpos: Float64Array, mirror = false): void {
  const s = sample(move, Math.min(tau, move.duration), { speed: 1, mirror, loop: false });
  const r = w.r;
  const c = Math.cos(place.yaw), sn = Math.sin(place.yaw);
  const [px, py, pz] = s.rootPos;
  qpos[r.rootQadr] = place.x + c * px - sn * py;
  qpos[r.rootQadr + 1] = place.y + sn * px + c * py;
  qpos[r.rootQadr + 2] = pz;
  const q = quatNormalize(quatMul(quatYaw(place.yaw), s.rootQuat));
  for (let k = 0; k < 4; k++) qpos[r.rootQadr + 3 + k] = q[k];
  r.joints.forEach((j, i) => {
    const ch = w.joints[i].lib;
    if (ch >= 0) qpos[j.qadr] = s.q[ch];
  });
}

export function buildReference(w: PolishWorld, move: Move, place: Placement): Reference {
  const { mj, ctx, r, ids } = w;
  const model = ctx.model;
  const scratch = new mj.MjData(model);
  const n = move.frames;
  const com = new Float64Array(n * 3), pelvis = new Float64Array(n * 3), pelvisQuat = new Float64Array(n * 4), torsoUp = new Float64Array(n * 3);
  const torsoR = new Float64Array(n * 9);
  const sole = new Float64Array(n * 6), fist = new Float64Array(n * 6), knee = new Float64Array(n * 6);
  const corners = new Float64Array(n * 24); // both soles' bottom corners (x, y, z) per frame
  const strikerPart = move.striker;
  const strikerBody = strikerPart ? (r.parts.get(strikerPart)?.body ?? -1) : -1;
  const striker = strikerBody >= 0 ? new Float64Array(n * 3) : null;
  const qpos = new Float64Array(model.nq);
  qpos.set(ctx.data.qpos as Float64Array);
  const hz = w.footHalf[2];
  for (let f = 0; f < n; f++) {
    poseQpos(w, move, f / move.fps, place, qpos);
    (scratch.qpos as Float64Array).set(qpos);
    mj.mj_kinematics(model, scratch);
    mj.mj_comPos(model, scratch);
    const sc = scratch.subtree_com as Float64Array, xp = scratch.xpos as Float64Array, xm = scratch.xmat as Float64Array, xq = scratch.xquat as Float64Array;
    const gx = scratch.geom_xpos as Float64Array, gm = scratch.geom_xmat as Float64Array;
    for (let k = 0; k < 3; k++) {
      com[f * 3 + k] = sc[ids.root * 3 + k];
      pelvis[f * 3 + k] = xp[ids.pelvis * 3 + k];
      torsoUp[f * 3 + k] = xm[ids.torso * 9 + 2 + 3 * k];
      for (let s = 0; s < 2; s++) {
        fist[f * 6 + s * 3 + k] = xp[ids.fist[s] * 3 + k];
        knee[f * 6 + s * 3 + k] = xp[ids.shin[s] * 3 + k];
      }
      if (striker) striker[f * 3 + k] = xp[strikerBody * 3 + k];
    }
    for (let k = 0; k < 4; k++) pelvisQuat[f * 4 + k] = xq[ids.pelvis * 4 + k];
    for (let k = 0; k < 9; k++) torsoR[f * 9 + k] = xm[ids.torso * 9 + k];
    for (let s = 0; s < 2; s++) {
      const g = ids.footGeom[s];
      const o = g * 9;
      sole[f * 6 + s * 3] = gx[g * 3] - gm[o + 2] * hz;
      sole[f * 6 + s * 3 + 1] = gx[g * 3 + 1] - gm[o + 5] * hz;
      sole[f * 6 + s * 3 + 2] = gx[g * 3 + 2] - gm[o + 8] * hz;
      const [hx, hy] = w.footHalf;
      let c = 0;
      for (const [ax, ay] of [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]) {
        for (let k = 0; k < 3; k++) corners[f * 24 + s * 12 + c * 3 + k] = gx[g * 3 + k] + gm[o + k * 3] * ax + gm[o + k * 3 + 1] * ay - gm[o + k * 3 + 2] * hz;
        c++;
      }
    }
  }
  const heading = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const [w, x, y, z] = [pelvisQuat[f * 4], pelvisQuat[f * 4 + 1], pelvisQuat[f * 4 + 2], pelvisQuat[f * 4 + 3]];
    const h = Math.atan2(-2 * (x * y - w * z), 1 - 2 * (x * x + z * z));
    if (f === 0) heading[f] = h;
    else {
      let d = h - (heading[f - 1] % (2 * Math.PI));
      d = Math.atan2(Math.sin(d), Math.cos(d));
      heading[f] = heading[f - 1] + d;
    }
  }
  // Pose weights: the mass each joint swings (its child subtree), normalised.
  const bodyOf = model.jnt_bodyid as Int32Array;
  const sub = model.body_subtreemass as Float64Array;
  const poseW = new Float64Array(r.joints.length);
  let tot = 0;
  r.joints.forEach((_, i) => {
    const m = sub[bodyOf[ids.jnt[i]]];
    poseW[i] = m;
    tot += m;
  });
  for (let i = 0; i < poseW.length; i++) poseW[i] /= tot;
  // Standing COM height: the design's stance (pelvis root height).
  const standComZ = w.stancePelvisZ * 0.92;
  scratch.delete();
  return {
    move, kind: moveKind(move), place, frames: n, fps: move.fps, contacts: bridgedContacts(move), com, pelvis, pelvisQuat, torsoUp, torsoR, heading, sole, corners, fist, knee, striker, strikerBody,
    poseW, standComZ, endComZ: com[(n - 1) * 3 + 2],
  };
}

/**
 * The feedback's reference track (format TRACK_STRIDE): per clip frame the mass-aware COM and the torso
 * up-axis, in the move frame of `ref` (the optimiser plays at the origin, so world = move frame),
 * quantized exactly as stored.
 */
export function referenceTrack(ref: Reference): Float64Array {
  const out = new Float64Array(ref.frames * TRACK_STRIDE);
  const c = Math.cos(-ref.place.yaw), s = Math.sin(-ref.place.yaw);
  for (let f = 0; f < ref.frames; f++) {
    // The clip's COM on this robot can sit outside the soles it stands on (heavier limbs than the
    // actor's): the reference is that COM moved into the support (corners within 2.5 cm of the canvas,
    // shrunk by 2 cm), so the feedback never pulls toward a pose the robot cannot hold.
    let cx = ref.com[f * 3], cy = ref.com[f * 3 + 1];
    const pts: Array<[number, number]> = [];
    for (let k = 0; k < 8; k++) if (ref.corners[f * 24 + k * 3 + 2] < 0.025) pts.push([ref.corners[f * 24 + k * 3], ref.corners[f * 24 + k * 3 + 1]]);
    if (pts.length >= 3) [cx, cy] = intoHull(pts, [cx, cy], 0.02);
    const x = cx - ref.place.x, y = cy - ref.place.y;
    out[f * 6] = c * x - s * y;
    out[f * 6 + 1] = s * x + c * y;
    out[f * 6 + 2] = ref.com[f * 3 + 2];
    const ux = ref.torsoUp[f * 3], uy = ref.torsoUp[f * 3 + 1];
    out[f * 6 + 3] = c * ux - s * uy;
    out[f * 6 + 4] = s * ux + c * uy;
    out[f * 6 + 5] = ref.torsoUp[f * 3 + 2];
  }
  quantizeTrack(out);
  return out;
}

/** p moved into the convex hull of pts shrunk by `margin` (toward the centroid when the hull is thinner). */
export function intoHull(pts: Array<[number, number]>, p: [number, number], margin: number): [number, number] {
  const hull = hullOf(pts);
  if (hull.length < 3) return p;
  let cx = 0, cy = 0;
  for (const h of hull) {
    cx += h[0];
    cy += h[1];
  }
  cx /= hull.length;
  cy /= hull.length;
  // Signed distance to each edge (inside positive); walk from p toward the centroid until inside by margin.
  const depth = (x: number, y: number): number => {
    let m = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey) || 1e-9;
      m = Math.min(m, (ex * (y - a[1]) - ey * (x - a[0])) / len);
    }
    return m;
  };
  const dc = depth(cx, cy);
  const want = Math.min(margin, dc * 0.5);
  if (depth(p[0], p[1]) >= want) return p;
  let lo = 0, hi = 1;
  for (let it = 0; it < 30; it++) {
    const t = (lo + hi) / 2;
    if (depth(p[0] + (cx - p[0]) * t, p[1] + (cy - p[1]) * t) >= want) hi = t;
    else lo = t;
  }
  return [p[0] + (cx - p[0]) * hi, p[1] + (cy - p[1]) * hi];
}

function hullOf(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossZ = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Linear interpolation of a frames × k table at clip time tau (held past the ends). */
export function refAt(table: Float64Array, k: number, ref: Reference, tau: number, c: number): number {
  const x = Math.max(0, Math.min(ref.frames - 1, tau * ref.fps));
  const i = Math.min(ref.frames - 2, Math.floor(x)), w = x - i;
  return table[i * k + c] * (1 - w) + table[(i + 1) * k + c] * w;
}

/** Contact bits of the clip at clip time tau (nearest frame, as sample()), short gaps bridged. */
export function refContacts(ref: Reference, tau: number): number {
  const f = Math.max(0, Math.min(ref.frames - 1, Math.round(tau * ref.fps)));
  return ref.contacts[f];
}

/** Gaps shorter than this in a foot's contact (a boxer's bounce, 9 mm in SAVATE's cross) count as planted. */
export const BRIDGE_FRAMES = 5;

export function bridgedContacts(move: Move): Uint8Array {
  const n = move.frames;
  const out = Uint8Array.from(move.contacts);
  for (const bit of [CONTACT.FOOT_L, CONTACT.FOOT_R]) {
    let f = 0;
    while (f < n) {
      if (out[f] & bit) {
        f++;
        continue;
      }
      let g = f;
      while (g < n && !(out[g] & bit)) g++;
      if (f > 0 && g < n && g - f <= BRIDGE_FRAMES) for (let k = f; k < g; k++) out[k] |= bit;
      f = g;
    }
  }
  return out;
}

export const FOOT_BITS = [CONTACT.FOOT_L, CONTACT.FOOT_R] as const;
export const HAND_BITS = [CONTACT.HAND_L, CONTACT.HAND_R] as const;
export const KNEE_BITS = [CONTACT.KNEE_L, CONTACT.KNEE_R] as const;
