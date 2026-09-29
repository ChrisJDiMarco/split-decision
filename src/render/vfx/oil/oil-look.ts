// Shared look of hydraulic fluid: a dark amber-black mineral oil that goes amber where
// it is thin, reflects the lights sharply while wet and dries to a matte brown stain.
import * as THREE from 'three/webgpu';
import { makeRng } from '../coords';

/** Thick oil seen in bulk: almost black with a warm cast. */
export const OIL_DEEP = new THREE.Color(0x0b0603);
/** Thin film: light passes through and it reads amber. */
export const OIL_THIN = new THREE.Color(0x5a2f08);
/** Dried stain soaked into the canvas. */
export const OIL_STAIN = new THREE.Color(0x2e1d10);
/** Hydraulic mineral oil density, kg/m³. */
export const OIL_DENSITY = 870;

/** Contract every oil implementation (GPU fluid or WebGL fallback) satisfies. */
export interface OilSystem {
  readonly object: THREE.Object3D;
  readonly kind: 'fluid' | 'fallback';
  spray(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, count: number, spread: number, inherit: THREE.Vector3): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
  /** Oil particles currently simulated (airborne or pooled). */
  readonly activeParticles: number;
}

const MASK_SIZE = 128;
const MASK_VARIANTS = 4;

/**
 * Irregular puddle masks (4 tiles in a row): a disc whose edge wanders with noise and
 * grows a few lobes, like oil running along the canvas weave.
 */
export function createPuddleMasks(): THREE.DataTexture {
  const w = MASK_SIZE * MASK_VARIANTS;
  const data = new Uint8Array(w * MASK_SIZE * 4);
  for (let v = 0; v < MASK_VARIANTS; v++) {
    const rng = makeRng(101 + v * 57);
    const lobes = Array.from({ length: 7 }, () => ({ a: rng() * Math.PI * 2, amp: 0.05 + rng() * 0.16, width: 0.25 + rng() * 0.5 }));
    const wobble = Array.from({ length: 5 }, (_, k) => ({ f: 3 + k * 2 + rng() * 2, p: rng() * 6.28, amp: 0.035 / (k + 1) }));
    for (let y = 0; y < MASK_SIZE; y++) {
      for (let x = 0; x < MASK_SIZE; x++) {
        const u = ((x + 0.5) / MASK_SIZE) * 2 - 1;
        const vv = ((y + 0.5) / MASK_SIZE) * 2 - 1;
        const r = Math.hypot(u, vv);
        const a = Math.atan2(vv, u);
        let edge = 0.66;
        for (const l of lobes) {
          const d = Math.atan2(Math.sin(a - l.a), Math.cos(a - l.a));
          edge += l.amp * Math.exp(-(d * d) / (l.width * l.width * 0.2));
        }
        for (const wv of wobble) edge += wv.amp * Math.sin(a * wv.f + wv.p);
        // Height-like thickness: thickest in the middle, a crisp meniscus at the rim.
        const inside = Math.max(0, Math.min(1, (edge - r) / 0.035));
        const depth = Math.max(0, Math.min(1, (edge - r) / Math.max(edge, 1e-3)));
        const i = (y * w + v * MASK_SIZE + x) * 4;
        data[i] = Math.round(inside * 255);
        data[i + 1] = Math.round(Math.sqrt(depth) * 255);
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, w, MASK_SIZE, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export const PUDDLE_MASK_VARIANTS = MASK_VARIANTS;
