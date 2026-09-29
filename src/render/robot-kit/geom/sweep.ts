// Profile sweep: the kit's workhorse generator. A closed 2D profile (in x/y) is placed at a
// series of stations along +z, each with its own scale and offset. Lathed actuator housings,
// chamfered boxes, tapered limb shells and armor plates are all sweeps. Hard corners in the
// profile and hard stations along z get split normals, so bevels catch crisp highlights.
// Every vertex carries an edge weight (aSurf.x) used by the skins for edge wear and edge lights.
import * as THREE from 'three/webgpu';

export interface PathPoint {
  x: number;
  y: number;
  e: number; // edge weight 0..1
  hard: boolean; // normal discontinuity at this point
}

/** Closed profile; the first point is repeated at the end with u = 1 for a clean UV seam. */
export interface Profile {
  x: number[];
  y: number[];
  nx: number[];
  ny: number[];
  e: number[];
  u: number[];
  meanRadius: number;
}

export interface Station {
  z: number;
  sx: number;
  sy?: number;
  ox?: number;
  oy?: number;
  smooth?: boolean; // share normals with both neighbouring strips at this station
  edge?: number; // edge weight of this ring
}

const EPS = 1e-9;

function segNormal(ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l]; // right-hand side of a CCW loop = outward
}

/** Build a profile from a closed CCW path (do not repeat the first point). */
export function profileFromPath(path: PathPoint[]): Profile {
  const n = path.length;
  const out: Profile = { x: [], y: [], nx: [], ny: [], e: [], u: [], meanRadius: 0 };
  const push = (p: PathPoint, nrm: [number, number]) => {
    out.x.push(p.x);
    out.y.push(p.y);
    out.nx.push(nrm[0]);
    out.ny.push(nrm[1]);
    out.e.push(p.e);
  };
  const segN = (i: number) => {
    const a = path[i];
    const b = path[(i + 1) % n];
    return segNormal(a.x, a.y, b.x, b.y);
  };
  const smoothN = (i: number): [number, number] => {
    const a = segN((i - 1 + n) % n);
    const b = segN(i);
    const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
    return [(a[0] + b[0]) / l, (a[1] + b[1]) / l];
  };
  for (let i = 0; i < n; i++) {
    const p = path[i];
    if (p.hard) {
      if (i > 0) push(p, segN(i - 1));
      push(p, segN(i));
    } else {
      push(p, smoothN(i));
    }
  }
  // Close the loop: repeat point 0 with its incoming normal (hard) or its smooth normal.
  const p0 = path[0];
  push(p0, p0.hard ? segN(n - 1) : smoothN(0));
  // Perimeter parameter.
  let total = 0;
  const cum = [0];
  for (let i = 1; i < out.x.length; i++) {
    total += Math.hypot(out.x[i] - out.x[i - 1], out.y[i] - out.y[i - 1]);
    cum.push(total);
  }
  out.u = cum.map((c) => (total > 0 ? c / total : 0));
  let r = 0;
  for (let i = 0; i < n; i++) r += Math.hypot(path[i].x, path[i].y);
  out.meanRadius = r / Math.max(1, n);
  return out;
}

export function circleProfile(radius: number, segments: number, edge = 0): Profile {
  const path: PathPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    path.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius, e: edge, hard: false });
  }
  return profileFromPath(path);
}

export interface RoundedPolyOpts {
  cornerSegs?: number; // 1 = hard chamfer, 2+ = rounded
  sideSegs?: number; // subdivisions of each straight side (for dents)
  cell?: number; // alternative to sideSegs: target segment length
  guard?: number; // distance of the edge-weight falloff point from each corner
  cornerEdge?: number; // edge weight on the corners
}

/**
 * Convex or concave CCW polygon with every corner chamfered or rounded by `radius`.
 * `radius` may be per-corner. Straight sides are subdivided and get guard points so the
 * edge weight falls off within `guard` of the bevel.
 */
export function roundedPolyProfile(corners: Array<[number, number]>, radius: number | number[], opts: RoundedPolyOpts = {}): Profile {
  const n = corners.length;
  const cornerSegs = Math.max(1, opts.cornerSegs ?? 3);
  const sideSegs = Math.max(1, opts.sideSegs ?? 1);
  const cornerEdge = opts.cornerEdge ?? 1;
  const path: PathPoint[] = [];
  const cut = (i: number) => (Array.isArray(radius) ? radius[i] : radius);
  const tangentPoints = corners.map((c, i) => {
    const prev = corners[(i - 1 + n) % n];
    const next = corners[(i + 1) % n];
    const lin = Math.hypot(c[0] - prev[0], c[1] - prev[1]) || 1;
    const lout = Math.hypot(next[0] - c[0], next[1] - c[1]) || 1;
    const r = Math.min(cut(i), lin * 0.45, lout * 0.45);
    const t1: [number, number] = [c[0] - ((c[0] - prev[0]) / lin) * r, c[1] - ((c[1] - prev[1]) / lin) * r];
    const t2: [number, number] = [c[0] + ((next[0] - c[0]) / lout) * r, c[1] + ((next[1] - c[1]) / lout) * r];
    return { t1, t2, c, r };
  });
  for (let i = 0; i < n; i++) {
    const { t1, t2, c, r } = tangentPoints[i];
    if (r <= EPS) {
      path.push({ x: c[0], y: c[1], e: cornerEdge, hard: true });
    } else if (cornerSegs === 1) {
      path.push({ x: t1[0], y: t1[1], e: cornerEdge, hard: true });
      path.push({ x: t2[0], y: t2[1], e: cornerEdge, hard: true });
    } else {
      for (let k = 0; k <= cornerSegs; k++) {
        const s = k / cornerSegs;
        const a = (1 - s) * (1 - s);
        const b = 2 * s * (1 - s);
        const d = s * s;
        path.push({ x: a * t1[0] + b * c[0] + d * t2[0], y: a * t1[1] + b * c[1] + d * t2[1], e: cornerEdge, hard: false });
      }
    }
    // Straight side to the next corner: guard points + subdivisions.
    const nextT1 = tangentPoints[(i + 1) % n].t1;
    const from = r <= EPS ? c : t2;
    const len = Math.hypot(nextT1[0] - from[0], nextT1[1] - from[1]);
    if (len <= EPS) continue;
    const guard = Math.min(opts.guard ?? Math.min(Math.max(r * 0.5, 0.003), 0.01), len * 0.3);
    const ts: number[] = [];
    if (guard > EPS) ts.push(guard / len);
    const segs = opts.cell ? Math.max(1, Math.ceil(len / opts.cell)) : sideSegs;
    for (let k = 1; k < segs; k++) ts.push(k / segs);
    if (guard > EPS) ts.push(1 - guard / len);
    ts.sort((p, q) => p - q);
    let last = -1;
    for (const t of ts) {
      if (t <= 0.001 || t >= 0.999 || t - last < 0.01) continue;
      last = t;
      path.push({ x: from[0] + (nextT1[0] - from[0]) * t, y: from[1] + (nextT1[1] - from[1]) * t, e: 0, hard: false });
    }
  }
  return profileFromPath(path);
}

/** Centered rectangle with chamfered (cornerSegs = 1) or rounded corners. */
export function roundedRectProfile(w: number, h: number, r: number, opts: RoundedPolyOpts = {}): Profile {
  const x = w / 2;
  const y = h / 2;
  return roundedPolyProfile([[x, -y], [x, y], [-x, y], [-x, -y]], r, opts);
}

/**
 * Thick arc (annular sector) profile for curved armor shells, centered on the origin.
 * Angles in radians, CCW from +x. Ends are chamfered by `bevel`.
 */
export function arcPlateProfile(rIn: number, rOut: number, a0: number, a1: number, bevel: number, segs: number): Profile {
  const path: PathPoint[] = [];
  const pt = (r: number, a: number, e: number, hard: boolean) => path.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, e, hard });
  const b = Math.min(bevel, (rOut - rIn) * 0.45);
  const ab = b / rOut; // angular size of the bevel on the outer arc
  // Outer arc (CCW a0 → a1), with chamfered corners.
  pt(rOut - b, a0, 1, true);
  pt(rOut, a0 + ab, 1, true);
  for (let k = 1; k < segs; k++) {
    const t = k / segs;
    const e = t < 0.08 || t > 0.92 ? 0.5 : 0;
    pt(rOut, a0 + ab + (a1 - a0 - 2 * ab) * t, e, false);
  }
  pt(rOut, a1 - ab, 1, true);
  pt(rOut - b, a1, 1, true);
  // Inner arc back (a1 → a0).
  pt(rIn, a1, 0.6, true);
  for (let k = 1; k < segs; k++) pt(rIn, a1 - (a1 - a0) * (k / segs), 0, false);
  pt(rIn, a0, 0.6, true);
  return profileFromPath(path);
}

// ---------------------------------------------------------------- sweep

interface RingNormals {
  bottom: Float32Array; // strip's normals at its first ring (xyz per profile point)
  top: Float32Array;
}

function sameStation(a: Station, b: Station): boolean {
  return a.z === b.z && a.sx === b.sx && (a.sy ?? a.sx) === (b.sy ?? b.sx) && (a.ox ?? 0) === (b.ox ?? 0) && (a.oy ?? 0) === (b.oy ?? 0);
}

function ringPoint(p: Profile, st: Station, j: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set((st.ox ?? 0) + st.sx * p.x[j], (st.oy ?? 0) + (st.sy ?? st.sx) * p.y[j], st.z);
}

function stripNormals(p: Profile, a: Station, b: Station): RingNormals {
  const n = p.x.length;
  const bottom = new Float32Array(n * 3);
  const top = new Float32Array(n * 3);
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const e = new THREE.Vector3();
  const ta = new THREE.Vector3();
  const tb = new THREE.Vector3();
  const na = new THREE.Vector3();
  const nb = new THREE.Vector3();
  for (let j = 0; j < n; j++) {
    ringPoint(p, a, j, pa);
    ringPoint(p, b, j, pb);
    e.subVectors(pb, pa);
    ta.set(-p.ny[j] * a.sx, p.nx[j] * (a.sy ?? a.sx), 0);
    tb.set(-p.ny[j] * b.sx, p.nx[j] * (b.sy ?? b.sx), 0);
    na.crossVectors(ta, e);
    nb.crossVectors(tb, e);
    const la = na.length();
    const lb = nb.length();
    if (la < EPS && lb < EPS) {
      na.set(p.nx[j], p.ny[j], 0);
      nb.copy(na);
    } else if (la < EPS) {
      na.copy(nb).normalize();
      nb.normalize();
    } else if (lb < EPS) {
      na.normalize();
      nb.copy(na);
    } else {
      na.normalize();
      nb.normalize();
    }
    na.toArray(bottom, j * 3);
    nb.toArray(top, j * 3);
  }
  return { bottom, top };
}

/**
 * Sweep a profile through stations. In the (radius, z) half-plane the station path must wrap
 * the solid counter-clockwise (bottom → outside → top); z may step back down for grooves.
 * Returns an indexed geometry with position, normal, uv and aSurf (x = edge weight).
 */
export function sweep(profile: Profile, stations: Station[]): THREE.BufferGeometry {
  const n = profile.x.length;
  const strips: Array<{ a: number; b: number; nrm: RingNormals }> = [];
  for (let s = 0; s < stations.length - 1; s++) {
    const a = stations[s];
    const b = stations[s + 1];
    if (sameStation(a, b)) continue;
    strips.push({ a: s, b: s + 1, nrm: stripNormals(profile, a, b) });
  }
  // Smooth stations share one normal between the two strips that meet there.
  for (let k = 0; k < strips.length - 1; k++) {
    const cur = strips[k];
    const next = strips[k + 1];
    if (cur.b !== next.a || !stations[cur.b].smooth) continue;
    for (let i = 0; i < n * 3; i += 3) {
      const x = cur.nrm.top[i] + next.nrm.bottom[i];
      const y = cur.nrm.top[i + 1] + next.nrm.bottom[i + 1];
      const z = cur.nrm.top[i + 2] + next.nrm.bottom[i + 2];
      const l = Math.hypot(x, y, z) || 1;
      cur.nrm.top[i] = next.nrm.bottom[i] = x / l;
      cur.nrm.top[i + 1] = next.nrm.bottom[i + 1] = y / l;
      cur.nrm.top[i + 2] = next.nrm.bottom[i + 2] = z / l;
    }
  }
  // v coordinate: cumulative length along (mean radius, z).
  const vAt: number[] = [0];
  for (let s = 1; s < stations.length; s++) {
    const a = stations[s - 1];
    const b = stations[s];
    const ra = profile.meanRadius * (a.sx + (a.sy ?? a.sx)) * 0.5;
    const rb = profile.meanRadius * (b.sx + (b.sy ?? b.sx)) * 0.5;
    vAt.push(vAt[s - 1] + Math.hypot(rb - ra, b.z - a.z));
  }
  const vTotal = vAt[vAt.length - 1] || 1;

  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const surf: number[] = [];
  const idx: number[] = [];
  const tmp = new THREE.Vector3();
  for (const strip of strips) {
    const base = pos.length / 3;
    const rings: Array<[number, Float32Array]> = [[strip.a, strip.nrm.bottom], [strip.b, strip.nrm.top]];
    for (const [si, nrm] of rings) {
      const st = stations[si];
      const collapsed = st.sx === 0 && (st.sy ?? st.sx) === 0;
      for (let j = 0; j < n; j++) {
        ringPoint(profile, st, j, tmp);
        pos.push(tmp.x, tmp.y, tmp.z);
        nor.push(nrm[j * 3], nrm[j * 3 + 1], nrm[j * 3 + 2]);
        uvs.push(profile.u[j], vAt[si] / vTotal);
        const e = Math.max(collapsed ? 0 : profile.e[j], st.edge ?? 0);
        surf.push(e, 0, 0, 0);
      }
    }
    const aCollapsed = stations[strip.a].sx === 0 && (stations[strip.a].sy ?? 0) === 0;
    const bCollapsed = stations[strip.b].sx === 0 && (stations[strip.b].sy ?? 0) === 0;
    for (let j = 0; j < n - 1; j++) {
      const a = base + j;
      const b = base + j + 1;
      const c = base + n + j + 1;
      const d = base + n + j;
      if (!aCollapsed) idx.push(a, b, c);
      if (!bCollapsed) idx.push(a, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(surf, 4));
  geo.setIndex(idx);
  return geo;
}

/**
 * Flat cap for any simple (possibly concave or off-center) profile at a station, facing
 * +z (`facing` = 1) or -z (-1). Used where collapsing to the center would be wrong.
 */
export function capGeometry(profile: Profile, st: Station, facing: 1 | -1): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const tmp = new THREE.Vector3();
  for (let j = 0; j < profile.x.length - 1; j++) {
    ringPoint(profile, st, j, tmp);
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - tmp.x) < 1e-7 && Math.abs(last.y - tmp.y) < 1e-7) continue;
    pts.push(new THREE.Vector2(tmp.x, tmp.y));
  }
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const surf: number[] = [];
  for (const p of pts) {
    pos.push(p.x, p.y, st.z);
    nor.push(0, 0, facing);
    uvs.push(p.x, p.y);
    surf.push(0, 0, 0, 0);
  }
  const idx: number[] = [];
  for (const [a, b, c] of tris) {
    const cross = (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
    if ((cross > 0) === (facing > 0)) idx.push(a, b, c);
    else idx.push(a, c, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(surf, 4));
  geo.setIndex(idx);
  return geo;
}

// ---------------------------------------------------------------- station helpers

export interface PrismOpts {
  taperTop?: number; // scale at z1 relative to z0
  taperAxes?: 'xy' | 'x' | 'y'; // which profile axes the taper scales (plates keep their thickness)
  segs?: number; // extra subdivisions along z
  capRings?: number; // concentric rings on the caps (for dents)
  inset?: [number, number]; // cap outline scale (x, y) after the chamfer
  endSegs?: number; // 1 = chamfered ends, 3+ = rounded ends
  openBottom?: boolean;
  openTop?: boolean;
}

/** Stations for a straight prism from z0 to z1 with chamfered (or rounded) ends and flat caps. */
export function prismStations(z0: number, z1: number, bevel: number, opts: PrismOpts = {}): Station[] {
  const segs = Math.max(1, opts.segs ?? 1);
  const t = opts.taperTop ?? 1;
  const [ix, iy] = opts.inset ?? [0.85, 0.85];
  const capRings = opts.capRings ?? 0;
  const endSegs = Math.max(1, opts.endSegs ?? 1);
  const len = z1 - z0;
  const b = Math.min(bevel, len * 0.3);
  const scaleAt = (z: number) => 1 + (t - 1) * ((z - z0) / (len || 1));
  // kx, ky: outline scale relative to the full wall (1 = wall, inset = cap outline).
  const at = (z: number, kx: number, ky: number, extra: Partial<Station> = {}): Station => {
    const s = scaleAt(z);
    const axes = opts.taperAxes ?? 'xy';
    return { z, sx: (axes === 'y' ? 1 : s) * kx, sy: (axes === 'x' ? 1 : s) * ky, ...extra };
  };
  const capRingsAt = (z: number) => {
    const rings: Station[] = [];
    for (let k = 1; k <= capRings; k++) rings.push(at(z, (ix * k) / (capRings + 1), (iy * k) / (capRings + 1)));
    return rings; // ascending scale
  };
  // Bevel rings from the cap outline (theta = 0) to the full wall (theta = 90°).
  const bevelRings = (zCap: number, dir: 1 | -1): Station[] => {
    const out: Station[] = [];
    for (let k = 0; k <= endSegs; k++) {
      const th = (k / endSegs) * (Math.PI / 2);
      const z = zCap + dir * b * (endSegs === 1 ? k : 1 - Math.cos(th));
      const w = endSegs === 1 ? k : Math.sin(th);
      out.push(at(z, ix + (1 - ix) * w, iy + (1 - iy) * w, { edge: 1, smooth: endSegs > 1 && k > 0 }));
    }
    return out;
  };
  const st: Station[] = [];
  if (!opts.openBottom) st.push({ z: z0, sx: 0, sy: 0 }, ...capRingsAt(z0));
  st.push(...bevelRings(z0, 1));
  const guard = Math.min(b * 1.2, len * 0.15);
  st.push(at(z0 + b + guard, 1, 1, { smooth: true }));
  for (let k = 1; k < segs; k++) {
    const z = z0 + b + guard + ((len - 2 * (b + guard)) * k) / segs;
    st.push(at(z, 1, 1, { smooth: true }));
  }
  st.push(at(z1 - b - guard, 1, 1, { smooth: true }));
  st.push(...bevelRings(z1, -1).reverse());
  if (!opts.openTop) st.push(...capRingsAt(z1).reverse(), { z: z1, sx: 0, sy: 0 });
  return st;
}

const LATHE_GUARD_MIN_M = 0.012; // segments longer than this get a zero-edge midpoint ring

/**
 * Stations for a lathe given (radius, z) pairs; radius 0 closes the part. `hard` marks crisp
 * rings. Long segments between crisp rings get a midpoint ring with zero edge weight, so edge
 * wear hugs the corners instead of covering whole faces.
 */
export function latheStations(pairs: Array<[number, number, (0 | 1)?]>, edgeOnHard = 1): Station[] {
  const out: Station[] = [];
  pairs.forEach(([r, z, hard], i) => {
    out.push({ z, sx: r, smooth: !hard, edge: hard ? edgeOnHard : 0 });
    const next = pairs[i + 1];
    if (!next || !hard || !next[2] || r === 0 || next[0] === 0) return;
    if (Math.hypot(next[0] - r, next[1] - z) < LATHE_GUARD_MIN_M) return;
    out.push({ z: (z + next[1]) / 2, sx: (r + next[0]) / 2, smooth: true, edge: 0 });
  });
  return out;
}
