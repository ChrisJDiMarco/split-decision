// Analytic line-of-sight model of the arena for the camera director. Every solid thing a
// broadcast camera could be stuck behind is a capsule (segment + radius) in the physics
// frame (z-up, metres, canvas at z = 0): the padded posts, the top-rail pads, the lighting
// truss and its fixture cans. The chain link is not an occluder: it is thin and
// semi-transparent, and cage-side cameras shoot through it on purpose. Gate tubes (~4 cm)
// are thinner than a torso, so they can't hide a fighter either.
//
// The truss numbers mirror src/render/arena/lighting.ts (built in the three.js world, y-up;
// physics (x, y, z) = world (x, -z, y)). They are duplicated rather than imported so this
// module stays renderer-free and unit-testable; a test pins them to the lighting rig.
import { APOTHEM, ARENA, CIRCUMRADIUS, postPositions } from '../../core/arena-spec';
import type { Vec3 } from '../../core/types';

export const RIG = {
  TRUSS_Z: 7.4, // lighting.ts TRUSS_Y
  TRUSS_RADIUS: CIRCUMRADIUS + 1.0, // lighting.ts TRUSS_RADIUS
  TRUSS_HALF_DIAG: (0.3 / 2) * Math.SQRT2, // 0.3 m box section
  FIXTURE_Z: 7.4 - 0.15 - 0.25, // lighting.ts fixtureLayout hang height
  KEY_Z: 7.4 - 0.5, // lighting.ts KEY_Y (the key light's own can)
  FIXTURE_R: 0.25, // 0.13 m can, 0.38 m long, any aim
  POST_TOP_Z: ARENA.FENCE_HEIGHT_M + 0.12 + ARENA.POST_PAD_RADIUS_M * 0.35, // cage.ts post + squashed cap
  RAIL_Z: ARENA.FENCE_HEIGHT_M + ARENA.TOP_PAD_RADIUS_M * 0.3,
} as const;

export type OccluderKind = 'post' | 'rail' | 'truss' | 'fixture';

export interface Occluder {
  kind: OccluderKind;
  a: Vec3;
  b: Vec3;
  r: number;
}

/**
 * Extra clearance a sight line to a torso needs around vertical or chunky hardware: roughly
 * half a torso's width, so a post can't hide the fighter's body beside the ray. The top rail
 * is horizontal and 16 cm thick, so it only counts when it sits on the ray itself (it crosses
 * one torso sample, never the whole torso).
 */
export const SIGHT_MARGIN_M = 0.1;
const MARGIN_SCALE: Record<OccluderKind, number> = { post: 1, rail: 0, truss: 1, fixture: 1 };

function buildOccluders(): Occluder[] {
  const out: Occluder[] = [];
  const posts = postPositions();
  posts.forEach(([x, y], i) => {
    out.push({ kind: 'post', a: [x, y, 0], b: [x, y, RIG.POST_TOP_Z], r: ARENA.POST_PAD_RADIUS_M });
    const [nx, ny] = posts[(i + 1) % posts.length];
    out.push({ kind: 'rail', a: [x, y, RIG.RAIL_Z], b: [nx, ny, RIG.RAIL_Z], r: ARENA.TOP_PAD_RADIUS_M });
  });
  // Truss ring (same octagon phase as the posts) plus the centre cross.
  const ring: Vec3[] = [];
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    ring.push([Math.cos(a) * RIG.TRUSS_RADIUS, -Math.sin(a) * RIG.TRUSS_RADIUS, RIG.TRUSS_Z]);
  }
  ring.forEach((p, i) => out.push({ kind: 'truss', a: p, b: ring[(i + 1) % ring.length], r: RIG.TRUSS_HALF_DIAG }));
  const cross = RIG.TRUSS_RADIUS * Math.cos(Math.PI / ARENA.SIDES);
  out.push({ kind: 'truss', a: [-cross, 0, RIG.TRUSS_Z], b: [cross, 0, RIG.TRUSS_Z], r: RIG.TRUSS_HALF_DIAG });
  out.push({ kind: 'truss', a: [0, -cross, RIG.TRUSS_Z], b: [0, cross, RIG.TRUSS_Z], r: RIG.TRUSS_HALF_DIAG });
  // Fixture cans: two per side on the ring, four on the cross, the key light at the centre.
  const count = ARENA.SIDES * 2;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.2;
    const r = RIG.TRUSS_RADIUS * 0.97;
    const p: Vec3 = [Math.cos(a) * r, -Math.sin(a) * r, RIG.FIXTURE_Z];
    out.push({ kind: 'fixture', a: p, b: p, r: RIG.FIXTURE_R });
  }
  const inner = RIG.TRUSS_RADIUS * 0.55;
  for (const [x, y] of [[inner, 0], [-inner, 0], [0, inner], [0, -inner]] as const) {
    out.push({ kind: 'fixture', a: [x, y, RIG.FIXTURE_Z], b: [x, y, RIG.FIXTURE_Z], r: RIG.FIXTURE_R });
  }
  out.push({ kind: 'fixture', a: [0, 0, RIG.KEY_Z], b: [0, 0, RIG.KEY_Z], r: RIG.FIXTURE_R });
  return out;
}

export const ARENA_OCCLUDERS: readonly Occluder[] = buildOccluders();

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1: Vec3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: Vec3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
}

/** The first occluder that comes within its radius (+ `margin`, per kind) of the segment from → to, or null. */
export function firstBlocker(from: Vec3, to: Vec3, margin = SIGHT_MARGIN_M, occluders: readonly Occluder[] = ARENA_OCCLUDERS): Occluder | null {
  for (const o of occluders) {
    if (segmentDistance(from, to, o.a, o.b) < o.r + margin * MARGIN_SCALE[o.kind]) return o;
  }
  return null;
}

export interface ViewBasis {
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
}

/** Camera basis for a z-up look-at (a straight-down view uses +y as screen up). */
export function viewBasis(pos: Vec3, target: Vec3): ViewBasis {
  const f = sub(target, pos);
  const fl = Math.hypot(f[0], f[1], f[2]) || 1;
  const fwd: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
  let right: Vec3 = [fwd[1], -fwd[0], 0]; // fwd × z
  const rl = Math.hypot(right[0], right[1]);
  right = rl > 1e-6 ? [right[0] / rl, right[1] / rl, 0] : [1, 0, 0];
  const up: Vec3 = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return { fwd, right, up };
}

/** Half-width of a fighter's body around its centre line, for framing. */
export const BODY_HALF_WIDTH_M = 0.35;

/**
 * Vertical field of view (degrees) that fits every point in frame around the look-at axis,
 * each widened sideways by `pad` metres (a body, not a point), keeping `margin` of the
 * half-frame free at the edges. Infinity if a point is behind the lens.
 */
export function fitFov(pos: Vec3, target: Vec3, points: readonly Vec3[], aspect: number, margin = 0.12, pad = BODY_HALF_WIDTH_M): number {
  const { fwd, right, up } = viewBasis(pos, target);
  let need = 0;
  for (const p of points) {
    const v = sub(p, pos);
    const z = dot(v, fwd);
    if (z < 0.15) return Infinity;
    need = Math.max(need, Math.abs(dot(v, up)) / z, (Math.abs(dot(v, right)) + pad) / (z * aspect));
  }
  return (Math.atan(need / (1 - margin)) * 360) / Math.PI;
}

/** Screen-space sample grid (fractions of the half-frame) for the clutter test. */
const CLUTTER_GRID_X = [-0.7, -0.35, 0, 0.35, 0.7];
const CLUTTER_GRID_Y = [-0.6, 0, 0.6];
export const CLUTTER_RAYS = CLUTTER_GRID_X.length * CLUTTER_GRID_Y.length;

/** Hardware narrower than this fraction of the frame height is a line in the shot, not a blocker. */
const CLUTTER_MIN_SIZE = 0.1;

/**
 * How many rays of a coarse grid over the frame hit big arena hardware before they reach
 * the subject's depth. A post or truss beam right in front of the lens fills several; the
 * top rail or a near-side post seen from the hard cam is a thin line and doesn't count.
 */
export function frameClutter(pos: Vec3, target: Vec3, fov: number, aspect: number, occluders: readonly Occluder[] = ARENA_OCCLUDERS): number {
  const { fwd, right, up } = viewBasis(pos, target);
  const depth = Math.hypot(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
  const tanH = Math.tan((fov * Math.PI) / 360);
  const fovRad = (fov * Math.PI) / 180;
  // Only hardware that looks big from here: apparent width 2r / distance vs the frame height.
  const big = occluders.filter((o) => (2 * o.r) / Math.max(0.05, segmentDistance(pos, pos, o.a, o.b)) > CLUTTER_MIN_SIZE * fovRad);
  let hits = 0;
  for (const gy of CLUTTER_GRID_Y) {
    for (const gx of CLUTTER_GRID_X) {
      const dx = gx * tanH * aspect;
      const dy = gy * tanH;
      // Ray to the subject's depth plane along this pixel.
      const end: Vec3 = [
        pos[0] + (fwd[0] + right[0] * dx + up[0] * dy) * depth,
        pos[1] + (fwd[1] + right[1] * dx + up[1] * dy) * depth,
        pos[2] + (fwd[2] + right[2] * dx + up[2] * dy) * depth,
      ];
      if (firstBlocker(pos, end, 0, big)) hits++;
    }
  }
  return hits;
}

/** Is `p` inside the fence (with `inset` metres to spare)? Uses the octagon, not a circle. */
export function insideCage(p: Vec3, inset = 0): boolean {
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 1) / ARENA.SIDES) * Math.PI * 2;
    if (p[0] * Math.cos(a) + p[1] * Math.sin(a) > APOTHEM - inset) return false;
  }
  return true;
}
