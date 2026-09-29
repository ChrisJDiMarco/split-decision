// Support-polygon geometry: foot rectangles on the canvas, their convex hull, and signed
// distances used by balance (is the capture point inside?) and by the gait (where to step).
import type { HumanoidGeometry, Side } from './geometry';

export type P2 = [number, number];

export interface FootPlace {
  x: number; // sole centre, world
  y: number;
  yaw: number;
}

/** The four sole corners of a flat foot, counter-clockwise. */
export function footCorners(geo: HumanoidGeometry, side: Side, f: FootPlace, shrink = 0): P2[] {
  const g = geo.legs[side];
  const hx = Math.max(0.01, g.footHalfLength - shrink), hy = Math.max(0.01, g.footHalfWidth - shrink);
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  const pts: P2[] = [];
  for (const [ax, ay] of [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]) {
    pts.push([f.x + c * ax - s * ay, f.y + s * ax + c * ay]);
  }
  return pts;
}

/** Convex hull (monotone chain), counter-clockwise. */
export function convexHull(points: P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const crossZ = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Signed distance from p to a convex CCW polygon: negative inside (depth), positive outside.
 * Also returns the closest point on the boundary.
 */
export function polygonDistance(poly: P2[], p: P2): { d: number; closest: P2 } {
  let inside = true;
  let best = Infinity;
  let closest: P2 = [p[0], p[1]];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey || 1e-12;
    // CCW polygon: inside is to the left of every edge.
    if (ex * (p[1] - a[1]) - ey * (p[0] - a[0]) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2));
    const qx = a[0] + ex * t, qy = a[1] + ey * t;
    const dd = Math.hypot(p[0] - qx, p[1] - qy);
    if (dd < best) {
      best = dd;
      closest = [qx, qy];
    }
  }
  return { d: inside ? -best : best, closest };
}

/** Clamp a point into a convex polygon (returns the point itself when inside). */
export function clampToPolygon(poly: P2[], p: P2): P2 {
  const { d, closest } = polygonDistance(poly, p);
  return d <= 0 ? p : closest;
}
