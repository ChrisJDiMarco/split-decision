// TSL helpers shared by the kit materials: projections, scratch fields, heat colour and a
// derivative-based bump for procedural heights (three's bumpMap only works with UV textures).
import * as THREE from 'three/webgpu';
import type { KitObjState } from '../geom/part-builder';
import {
  abs, faceDirection, float, max, min, mix, mx_fractal_noise_float, mx_noise_float, normalView, positionView, select,
  smoothstep, uniform, vec2, vec3, type Nd,
} from './tsl';

/** Fractal noise remapped to roughly 0..1 (MaterialX fBm sums octaves without normalising). */
export function fbm01(p: Nd, octaves: number, diminish = 0.5): Nd {
  let amp = 0;
  for (let k = 0; k < octaves; k++) amp += diminish ** k;
  return mx_fractal_noise_float(p, octaves, 2.0, diminish).div(amp * 2).add(0.5);
}

/** Dominant-axis planar coordinates (cheap triplanar for isotropic patterns). */
export function planar(p: Nd, n: Nd): Nd {
  const an = abs(n);
  return select(an.x.greaterThan(max(an.y, an.z)), p.yz, select(an.y.greaterThan(an.z), p.xz, p.xy));
}

/**
 * Thin scratch lines in two directions: 1 on a scratch, 0 elsewhere. Lines fade to a faint
 * average once a pixel covers more than a few of them, so distant armor does not glitter.
 */
export function scratchLines(q: Nd, scale: number): Nd {
  const s = q.mul(scale);
  const r = vec2(s.x.mul(0.8).add(s.y.mul(0.6)), s.y.mul(0.8).sub(s.x.mul(0.6)));
  const a = abs(mx_noise_float(vec3(s.x.mul(2.5), s.y.mul(45), 0.0)));
  const b = abs(mx_noise_float(vec3(r.x.mul(3.0), r.y.mul(55), 3.7)));
  const line = float(1).sub(smoothstep(0.0, 0.06, min(a, b)));
  const footprint = q.x.dFdx().abs().add(q.x.dFdy().abs()).add(q.y.dFdx().abs()).add(q.y.dFdy().abs());
  const resolved = float(1).sub(smoothstep(0.0015, 0.006, footprint));
  return mix(float(0.06), line, resolved);
}

/** Black-body-ish ramp for glowing metal, t in 0..1. */
export function heatColor(t: Nd): Nd {
  const dull = vec3(0.3, 0.01, 0.0);
  const hot = vec3(1.0, 0.12, 0.01);
  const white = vec3(1.0, 0.3, 0.05);
  return mix(mix(dull, hot, smoothstep(0.0, 0.55, t)), white, smoothstep(0.55, 1.0, t));
}

/** Perturb the view-space normal by a procedural height field given in metres. */
export function bumpNormal(height: Nd): Nd {
  const dHx = height.dFdx();
  const dHy = height.dFdy();
  const sx = positionView.dFdx();
  const sy = positionView.dFdy();
  const r1 = sy.cross(normalView);
  const r2 = normalView.cross(sx);
  const det = sx.dot(r1).mul(faceDirection);
  const grad = det.sign().mul(r1.mul(dHx).add(r2.mul(dHy)));
  return det.abs().mul(normalView).sub(grad).normalize();
}

/** A float uniform that reads `object.userData.kit[key]` for every object drawn. */
export function objectValue(key: keyof KitObjState, fallback: number): Nd {
  return uniform(fallback).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => {
    const kit = object?.userData?.kit as KitObjState | undefined;
    return kit ? kit[key] : fallback;
  });
}

export function srgb(hex: string): THREE.Color {
  return new THREE.Color(hex);
}
