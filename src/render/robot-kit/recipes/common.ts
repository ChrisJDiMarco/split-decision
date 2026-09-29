// Helpers shared by the humanoid recipes: plates on the faces of a limb that hangs along -z,
// limb frames (the exposed skeleton), cable runs and joint forks.
import * as THREE from 'three/webgpu';
import { DECAL } from '../types';
import type { DecalSpec, SurfOpts } from '../geom/attrs';
import type { FrameBuilder } from '../geom/part-builder';
import { sleeve } from '../geom/prims';
import { prismStations, roundedRectProfile } from '../geom/sweep';
import type { RecipeContext } from './context';
import { cable, limbShell, slab, V, type Vec } from './mech';

export type Face = 'front' | 'back' | 'outer' | 'inner';

const CURVED_TAPER_DAMPING = 0.6; // curved plates taper less than flat ones so they clear the core

/** Outward normal of a limb face; `side` is +1 for left limbs, -1 for right, 0 for centre. */
export function faceNormal(face: Face, side: number): Vec {
  const s = side === 0 ? 1 : side;
  switch (face) {
    case 'front': return V(1, 0, 0);
    case 'back': return V(-1, 0, 0);
    case 'outer': return V(0, s, 0);
    case 'inner': return V(0, -s, 0);
  }
}

export interface LimbPlateOpts {
  width: number;
  thick?: number;
  taper?: number; // width at the bottom end relative to the top
  accent?: string; // style accent name; applied if the style lists it
  decal?: DecalSpec;
  bolts?: 'corners' | 'edges' | 'none';
  tilt?: number; // radians, lean the plate's top outward
  shift?: number; // lateral shift along the plate width
  slot?: 'paint' | 'frame' | 'mech';
}

/** Armor plate on one face of a limb running down -z, between zTop and zBot. */
export function limbPlate(ctx: RecipeContext, fb: FrameBuilder, face: Face, zTop: number, zBot: number, offset: number, o: LimbPlateOpts): void {
  const n = faceNormal(face, ctx.side);
  const u0 = V(0, 0, -1);
  // Positive tilt leans the plate's top end outward (along n).
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().crossVectors(n, u0).normalize(), o.tilt ?? 0);
  const u = u0.clone().applyQuaternion(tilt);
  const nn = n.clone().applyQuaternion(tilt);
  const v = new THREE.Vector3().crossVectors(nn, u);
  const thick = o.thick ?? ctx.style.plate;
  const center = V(0, 0, (zTop + zBot) / 2).addScaledVector(n, offset + thick / 2).addScaledVector(v, o.shift ?? 0);
  const accent = !!o.accent && ctx.style.accents.has(o.accent);
  const surf: SurfOpts = { accent, decal: o.decal };
  if (ctx.style.round && !o.tilt) {
    curvedLimbPlate(ctx, fb, n, zTop, zBot, offset, thick, surf, o);
    return;
  }
  slab(fb, ctx.style, { center, u, v, lenU: zTop - zBot, lenV: o.width, thick, taper: o.taper, surf, bolts: o.bolts, slot: o.slot });
}

/** Rounded styles wrap limb armor around the limb axis instead of using flat slabs. */
function curvedLimbPlate(ctx: RecipeContext, fb: FrameBuilder, n: Vec, zTop: number, zBot: number, offset: number, thick: number, surf: SurfOpts, o: LimbPlateOpts): void {
  const angle = Math.atan2(n.y, n.x);
  const rIn = offset;
  const half = o.width / 2 / (rIn + thick);
  const taper = o.taper ? 1 + (o.taper - 1) * CURVED_TAPER_DAMPING : 1;
  limbShell(fb, rIn, thick, angle - half, angle + half, zTop, zBot, { taper, surf, slot: o.slot });
  if ((o.bolts ?? 'corners') === 'none') return;
  const size = ctx.style.boltSize;
  const margin = (size * 2.8) / (rIn + thick);
  for (const a of [angle - half + margin, angle + half - margin]) {
    for (const [z, t] of [[zTop - size * 2.8, 1], [zBot + size * 2.8, taper]]) {
      const r = (rIn + thick) * t;
      const dir = V(Math.cos(a), Math.sin(a), 0);
      fb.bolt(V(dir.x * r, dir.y * r, z), dir, size, ctx.style.boltKind);
    }
  }
}

/** Rounded-rectangle skeleton section down -z (the limb's structural core). */
export function limbCore(ctx: RecipeContext, fb: FrameBuilder, zTop: number, zBot: number, w: number, d: number, o: { taper?: number; slot?: 'frame' | 'paint' | 'mech'; round?: number; surf?: SurfOpts } = {}): void {
  const r = Math.min(w, d) * (o.round ?? (ctx.style.round ? 0.42 : 0.22));
  const profile = roundedRectProfile(d, w, r, { cornerSegs: ctx.style.round ? 3 : 1, cell: 0.045 });
  const len = zTop - zBot;
  const st = prismStations(0, len, Math.min(w, d) * 0.12, { taperTop: o.taper, segs: Math.max(1, Math.round(len / 0.05)), endSegs: ctx.style.round ? 3 : 1, openBottom: true, openTop: true, inset: [0.82, 0.82] });
  const flip = new THREE.Matrix4().makeScale(1, 1, -1).setPosition(0, 0, zTop);
  fb.add(o.slot ?? 'frame', sleeve(profile, st), flip, { cavity: 0.45, ...o.surf });
}

/** Cable bundle running down a limb face, with slight sag between clips. */
export function limbCables(ctx: RecipeContext, fb: FrameBuilder, face: Face, zTop: number, zBot: number, offset: number, count: number, radius: number): void {
  const n = faceNormal(face, ctx.side);
  const v = new THREE.Vector3().crossVectors(n, V(0, 0, -1));
  const colors = [ctx.style.cable, ctx.style.cable, ctx.style.signal, ctx.style.hose];
  for (let i = 0; i < count; i++) {
    const lateral = (i - (count - 1) / 2) * radius * 2.4;
    const pts: Vec[] = [];
    const steps = 5;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const sag = Math.sin(t * Math.PI) * radius * (1.5 + (i % 2));
      pts.push(V(0, 0, zTop + (zBot - zTop) * t).addScaledVector(n, offset + sag).addScaledVector(v, lateral));
    }
    cable(fb, pts, radius * (i === count - 1 ? 1.25 : 1), colors[i % colors.length]);
  }
}

/** Number / label decal on a plate facing `axis`, sized to a sub-rect of the plate. */
export function numberDecal(axis: DecalSpec['axis'], rect: [number, number, number, number] = [0.15, 0.2, 0.85, 0.8]): DecalSpec {
  return { kind: DECAL.NUMBER, axis, rect };
}

export function labelDecal(axis: DecalSpec['axis'], rect: [number, number, number, number] = [0.05, 0.3, 0.95, 0.7], rotate = false): DecalSpec {
  return { kind: DECAL.LABEL, axis, rect, rotate };
}

export function warningDecal(axis: DecalSpec['axis'], rect: [number, number, number, number] = [0.1, 0.25, 0.9, 0.75]): DecalSpec {
  return { kind: DECAL.WARNING, axis, rect };
}

/** A sibling part of the same design, if it exists. */
export function partPos(ctx: RecipeContext, id: string): Vec | null {
  const p = ctx.design.parts.find((q) => q.id === id);
  return p ? V(...p.pos) : null;
}
