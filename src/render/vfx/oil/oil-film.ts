// Oil film on the canvas, built from the fluid particles every frame on the GPU:
//   1. splat particles lying on the canvas into a 2D grid (atomic, bilinear);
//   2. blur the counts along x, then z (Gaussian), which gives a smooth coverage field;
//   3. write coverage to a texture and grow a persistent stain wherever oil has sat.
// A transparent overlay just above the canvas shades it: glossy amber-black where the
// oil is wet (with a meniscus highlight from the coverage gradient), a matte brown stain
// where it has soaked in. The stain never clears until clear().
import * as THREE from 'three/webgpu';
import {
  Fn, If, atomicAdd, atomicLoad, atomicStore, float, instanceIndex, instancedArray, int, ivec2, mix,
  positionWorld, smoothstep, texture, textureStore, transformNormalToView, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js';
import type { ParticleSystem } from 'threejs-particle-fluids';
import { FLOOR_Y } from '../coords';
import type { Any } from '../tsl-any';
import { OIL_DEEP, OIL_STAIN, OIL_THIN } from './oil-look';

/** Film grid covers a square this wide, centred on the arena (m). */
export const FILM_EXTENT_M = 12;
export const FILM_RES = 640;
/** Fixed-point scale for atomic splat weights. */
const FIXED = 4096;
/** Particles whose centre is within this many radii of the canvas count as film. */
const FILM_HEIGHT_RADII = 3.2;
/** Gaussian blur taps each side, and its sigma in texels. */
const TAPS = 4;
const SIGMA = 1.9;
/** How fast the stain catches up with the oil that sits on it, per second. */
const STAIN_RATE_PER_S = 0.35;
const STAIN_MAX = 0.85;

export class OilFilm {
  readonly mesh: THREE.Mesh;
  readonly kernels: ComputeNode[];
  private readonly clearKernel: ComputeNode;
  private readonly tex: THREE.StorageTexture;
  private readonly dt = uniform(1 / 60, 'float');

  constructor(particles: ParticleSystem, private readonly renderer: THREE.WebGPURenderer) {
    const n = FILM_RES * FILM_RES;
    const texel = FILM_EXTENT_M / FILM_RES;
    const r = particles.particleRadius;
    // Particles per texel in a single layer at rest spacing: normalises coverage to ~1.
    const layer = (texel / (2 * r)) ** 2;
    const acc = (instancedArray(n, 'int') as Any).setAtomic(true);
    const rowBlur = instancedArray(n, 'float');
    const stain = instancedArray(n, 'float');
    this.tex = new THREE.StorageTexture(FILM_RES, FILM_RES);
    this.tex.type = THREE.HalfFloatType;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;

    const weights = gaussian(TAPS, SIGMA);
    const half = FILM_EXTENT_M / 2;
    const toGrid = (x: Any): Any => x.add(half).div(texel).sub(0.5);

    const splat = Fn(() => {
      const p: Any = particles.positions.element(instanceIndex).xyz.toVar();
      const h: Any = p.y.sub(FLOOR_Y);
      If(h.greaterThan(-r).and(h.lessThan(r * FILM_HEIGHT_RADII)), () => {
        const g: Any = vec2(toGrid(p.x), toGrid(p.z)).toVar();
        If(g.x.greaterThanEqual(0).and(g.y.greaterThanEqual(0)).and(g.x.lessThan(FILM_RES - 1)).and(g.y.lessThan(FILM_RES - 1)), () => {
          const base: Any = g.floor().toVar();
          const f: Any = g.sub(base).toVar();
          // Particles hovering a little above the canvas count for less.
          const lift: Any = float(1).sub(smoothstep(r * 1.2, r * FILM_HEIGHT_RADII, h));
          for (let z = 0; z < 2; z++) {
            for (let x = 0; x < 2; x++) {
              const w: Any = (x ? f.x : f.x.oneMinus()).mul(z ? f.y : f.y.oneMinus()).mul(lift);
              const idx: Any = base.y.add(z).mul(FILM_RES).add(base.x.add(x)).toUint();
              atomicAdd(acc.element(idx), w.mul(FIXED).round().toInt());
            }
          }
        });
      });
    })().compute(particles.capacity).setName('OilFilm.splat');

    const blurRows = Fn(() => {
      const i: Any = instanceIndex;
      const cx: Any = i.mod(FILM_RES).toInt();
      const sum: Any = float(0).toVar();
      for (let k = -TAPS; k <= TAPS; k++) {
        const x: Any = cx.add(k).clamp(0, FILM_RES - 1);
        const j: Any = i.toInt().sub(cx).add(x).toUint();
        sum.addAssign((atomicLoad(acc.element(j)) as Any).toFloat().mul(weights[k + TAPS] / FIXED));
      }
      rowBlur.element(i).assign(sum);
    })().compute(n).setName('OilFilm.blurRows');

    const blurCols = Fn(() => {
      const i: Any = instanceIndex;
      // The row pass has read the splat; clear it for the next frame.
      atomicStore(acc.element(i), int(0));
      const cx: Any = i.mod(FILM_RES).toInt();
      const cz: Any = i.div(FILM_RES).toInt();
      const sum: Any = float(0).toVar();
      for (let k = -TAPS; k <= TAPS; k++) {
        const z: Any = cz.add(k).clamp(0, FILM_RES - 1);
        sum.addAssign(rowBlur.element(z.mul(FILM_RES).add(cx).toUint()).mul(weights[k + TAPS]));
      }
      const coverage: Any = sum.div(layer).toVar();
      const s: Any = stain.element(i);
      const target: Any = smoothstep(0.15, 0.8, coverage).mul(STAIN_MAX);
      If(target.greaterThan(s), () => {
        s.assign(s.add(target.sub(s).mul(this.dt.mul(STAIN_RATE_PER_S)).min(target.sub(s))));
      });
      textureStore(this.tex, ivec2(cx, cz), vec4(coverage, s, 0, 1)).toWriteOnly();
    })().compute(n).setName('OilFilm.blurCols');

    this.clearKernel = Fn(() => {
      stain.element(instanceIndex).assign(0);
      atomicStore(acc.element(instanceIndex), int(0));
      textureStore(this.tex, ivec2(instanceIndex.mod(FILM_RES).toInt(), instanceIndex.div(FILM_RES).toInt()), vec4(0, 0, 0, 1)).toWriteOnly();
    })().compute(n).setName('OilFilm.clear');

    this.kernels = [splat, blurRows, blurCols];
    this.mesh = this.overlay(texel);
  }

  /** Run the film passes (splat → blur → texture + stain). */
  update(dt: number): void {
    this.dt.value = dt;
    this.renderer.compute(this.kernels);
  }

  clear(): void {
    this.renderer.compute(this.clearKernel);
  }

  private overlay(texel: number): THREE.Mesh {
    const half = FILM_EXTENT_M / 2;
    const m = new THREE.MeshPhysicalNodeMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const uvAt = (dx: number, dz: number): Any =>
      vec2(positionWorld.x.add(half + dx * texel), positionWorld.z.add(half + dz * texel)).div(FILM_EXTENT_M);
    const film: Any = texture(this.tex, uvAt(0, 0));
    const c: Any = film.x;
    const stain: Any = film.y;
    const wet: Any = smoothstep(0.18, 0.42, c);
    const thick: Any = smoothstep(0.2, 0.75, c);
    // Surface slope from the coverage gradient: a bright meniscus rim, a flat pool.
    const gx: Any = texture(this.tex, uvAt(1, 0)).x.sub(texture(this.tex, uvAt(-1, 0)).x);
    const gz: Any = texture(this.tex, uvAt(0, 1)).x.sub(texture(this.tex, uvAt(0, -1)).x);
    const slope = 0.18;
    const nWorld: Any = vec3(gx.mul(-slope), 1, gz.mul(-slope)).normalize();
    m.normalNode = transformNormalToView(mix(vec3(0, 1, 0), nWorld, wet));
    const oil: Any = mix(vec3(OIL_THIN.r, OIL_THIN.g, OIL_THIN.b), vec3(OIL_DEEP.r, OIL_DEEP.g, OIL_DEEP.b), thick);
    m.colorNode = mix(vec3(OIL_STAIN.r, OIL_STAIN.g, OIL_STAIN.b), oil, wet);
    m.roughnessNode = mix(float(0.85), float(0.13), wet);
    m.metalnessNode = float(0);
    // A thin oil film on canvas reflects less than a deep pool (the weave breaks it up).
    m.specularIntensityNode = mix(float(0.2), float(0.6), thick);
    m.opacityNode = wet.mul(0.97).max(stain.mul(0.75));
    m.alphaTest = 0.004;
    const geo = new THREE.PlaneGeometry(FILM_EXTENT_M, FILM_EXTENT_M);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.y = FLOOR_Y + 0.0015;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.name = 'vfx.oil.film';
    return mesh;
  }

  dispose(): void {
    for (const k of [...this.kernels, this.clearKernel]) k.dispose();
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function gaussian(taps: number, sigma: number): number[] {
  const w = Array.from({ length: taps * 2 + 1 }, (_, k) => Math.exp(-((k - taps) ** 2) / (2 * sigma * sigma)));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}
