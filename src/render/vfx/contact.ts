// Contact marks that make a landed hit readable: an air shockwave ring that races out along the
// struck surface (or a flat dust ring on the canvas under a hard landing), and a brief, small
// flash on the struck part's surface. Both are flat quads oriented by the impact normal, so they
// hug the contact instead of hanging in the air like a glare sprite. Everything is pooled and
// one idle instance of each is always drawn, so the pipelines compile at load, not on the
// first hit. Flash strength is capped low (it should just catch the bloom), fades near the
// lens and dims in replays, like the glare caps in flash.ts.
import * as THREE from 'three/webgpu';
import {
  Fn, abs, attribute, cameraFar, cameraNear, cross, float, length, linearDepth, normalize, positionGeometry,
  select, smoothstep, uv, vec3, vec4, viewportLinearDepth, mix,
} from 'three/tsl';
import type { Any } from './tsl-any';
import { clamp } from './coords';

const MAX_RINGS = 16;
const MAX_FLASHES = 12;
/** Rings and flashes sit this far off the struck surface, toward the striker, so they don't z-fight it. */
const SURFACE_OFFSET_M = 0.02;
const SOFT_DEPTH_M = 0.06;
const LENS_FADE_NEAR_M = 1.0;
const LENS_FADE_FAR_M = 2.6;
const REPLAY_SCALE = 0.35;
/** Peak HDR brightness of a full-strength surface flash (the bloom threshold is 1.6). */
const FLASH_PEAK = 1.9;
const IDLE_SCALE = 1e-5;

export interface RingOptions {
  /** Final radius, metres. */
  radius: number;
  /** Life in effect seconds. */
  life: number;
  /** Peak opacity 0..1. */
  alpha: number;
  /** 0 air shock (pale), 1 canvas dust (beige). */
  tint: number;
}

interface Mark {
  pos: THREE.Vector3;
  nrm: THREE.Vector3;
  age: number;
  life: number;
  r0: number;
  r1: number;
  alpha: number;
  tint: number;
}

/** A pool of oriented quads with one shared material. */
class QuadPool {
  readonly mesh: THREE.Mesh;
  readonly marks: Mark[] = [];
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aNrm: THREE.InstancedBufferAttribute;
  private readonly aShape: THREE.InstancedBufferAttribute; // radius, age01, alpha, tint

  constructor(private readonly max: number, material: THREE.Material, name: string, renderOrder: number) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.aPos = dynamicAttr(max, 3);
    this.aNrm = dynamicAttr(max, 3);
    this.aShape = dynamicAttr(max, 4);
    (this.aNrm.array as Float32Array)[1] = 1; // the idle instance faces up, zero size
    this.geometry.setAttribute('iPos', this.aPos);
    this.geometry.setAttribute('iNrm', this.aNrm);
    this.geometry.setAttribute('iShape', this.aShape);
    this.geometry.instanceCount = 1;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = name;
  }

  add(m: Mark): void {
    if (this.marks.length >= this.max) this.marks.shift(); // recycle the oldest
    this.marks.push(m);
  }

  update(dt: number, radiusAt: (m: Mark, t: number) => number, alphaAt: (m: Mark, t: number) => number): void {
    for (const m of this.marks) m.age += dt;
    for (let i = this.marks.length - 1; i >= 0; i--) if (this.marks[i].age >= this.marks[i].life) this.marks.splice(i, 1);
    const pos = this.aPos.array as Float32Array;
    const nrm = this.aNrm.array as Float32Array;
    const shape = this.aShape.array as Float32Array;
    const n = this.marks.length;
    for (let k = 0; k < n; k++) {
      const m = this.marks[k];
      const t = clamp(m.age / m.life, 0, 1);
      pos[k * 3] = m.pos.x; pos[k * 3 + 1] = m.pos.y; pos[k * 3 + 2] = m.pos.z;
      nrm[k * 3] = m.nrm.x; nrm[k * 3 + 1] = m.nrm.y; nrm[k * 3 + 2] = m.nrm.z;
      shape[k * 4] = radiusAt(m, t);
      shape[k * 4 + 1] = t;
      shape[k * 4 + 2] = alphaAt(m, t);
      shape[k * 4 + 3] = m.tint;
    }
    if (n === 0) {
      shape[0] = IDLE_SCALE;
      shape[2] = 0;
    }
    for (const a of [this.aPos, this.aNrm, this.aShape]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = Math.max(1, n);
  }

  clear(): void {
    this.marks.length = 0;
    this.update(0, () => 0, () => 0);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Surface-aligned billboard: the quad lies in the plane whose normal is iNrm. */
function orientedQuad(m: THREE.MeshBasicNodeMaterial): { iShape: Any } {
  const iPos: Any = attribute('iPos', 'vec3');
  const iNrm: Any = attribute('iNrm', 'vec3');
  const iShape: Any = attribute('iShape', 'vec4');
  m.positionNode = Fn(() => {
    const n: Any = normalize(iNrm);
    const ref: Any = (select as Any)(abs(n.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
    const t1: Any = normalize(cross(ref, n));
    const t2: Any = cross(n, t1);
    const c: Any = positionGeometry.xy;
    const d: Any = iShape.x.mul(2);
    return iPos.add(t1.mul(c.x.mul(d))).add(t2.mul(c.y.mul(d)));
  })();
  return { iShape };
}

/** Fade where the quad cuts into opaque geometry, so rings never draw a hard seam across armor. */
function softFade(): Any {
  const sceneZ = viewportLinearDepth.mul(cameraFar.sub(cameraNear));
  const fragZ = linearDepth().mul(cameraFar.sub(cameraNear));
  return smoothstep(0, SOFT_DEPTH_M, sceneZ.sub(fragZ));
}

function ringMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const { iShape } = orientedQuad(m);
  const d: Any = length(uv().sub(0.5)).mul(2); // 0 centre .. 1 rim
  const age: Any = iShape.y;
  // A thick, soft shock front early on that thins as it expands, with a faint wake inside it.
  const width: Any = mix(float(0.42), float(0.1), age);
  const front: Any = float(1).sub(smoothstep(float(0), width, abs(d.sub(0.82))));
  const wake: Any = smoothstep(float(0.2), float(0.8), d).mul(float(1).sub(smoothstep(float(0.8), float(0.9), d))).mul(0.22);
  const shape: Any = front.add(wake).mul(float(1).sub(smoothstep(float(0.96), float(1), d)));
  const air = vec3(0.93, 0.93, 0.9);
  const dust = vec3(0.62, 0.58, 0.51);
  m.colorNode = vec4(mix(air, dust, iShape.w), 1);
  m.opacityNode = shape.mul(iShape.z).mul(softFade());
  return m;
}

function flashMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  const { iShape } = orientedQuad(m);
  const d: Any = length(uv().sub(0.5)).mul(2);
  const core: Any = float(1).sub(d).max(0).pow(2.4);
  const k: Any = core.mul(iShape.z).mul(softFade());
  m.colorNode = vec4(vec3(1.0, 0.86, 0.66).mul(k).mul(FLASH_PEAK), 1);
  return m;
}

const CAM = new THREE.Vector3();

export class ContactSystem {
  readonly object = new THREE.Group();
  private readonly rings: QuadPool;
  private readonly flashes: QuadPool;
  private scale = 1;

  constructor(private readonly camera?: THREE.Camera) {
    this.object.name = 'vfx.contact';
    this.rings = new QuadPool(MAX_RINGS, ringMaterial(), 'vfx.contact.rings', 11);
    this.flashes = new QuadPool(MAX_FLASHES, flashMaterial(), 'vfx.contact.flashes', 22);
    this.object.add(this.rings.mesh, this.flashes.mesh);
  }

  get alive(): number {
    return this.rings.marks.length + this.flashes.marks.length;
  }

  get ringCount(): number {
    return this.rings.marks.length;
  }

  get flashCount(): number {
    return this.flashes.marks.length;
  }

  setReplay(replaying: boolean): void {
    this.scale = replaying ? REPLAY_SCALE : 1;
  }

  /**
   * A shockwave ring in the plane of the struck surface. `normal` points into the victim (the
   * direction it was pushed); the ring sits just outside the surface on the striker's side.
   */
  ring(pos: THREE.Vector3, normal: THREE.Vector3, o: RingOptions): void {
    const nrm = normal.clone().normalize();
    this.rings.add({
      pos: pos.clone().addScaledVector(nrm, -SURFACE_OFFSET_M),
      nrm,
      age: 0,
      life: o.life,
      r0: o.radius * 0.3, // already visible while hit-stop holds the first frame
      r1: o.radius,
      alpha: clamp(o.alpha, 0, 1),
      tint: o.tint,
    });
  }

  /** A small, brief flash lying on the struck surface; strength 0..1 (capped, never a white-out). */
  flash(pos: THREE.Vector3, normal: THREE.Vector3, strength: number, radius: number): void {
    const peak = clamp(strength, 0, 1) * this.scale * this.lensFade(pos);
    if (peak < 0.02) return;
    const nrm = normal.clone().normalize();
    this.flashes.add({
      pos: pos.clone().addScaledVector(nrm, -SURFACE_OFFSET_M),
      nrm,
      age: 0,
      life: 0.05 + 0.04 * clamp(strength, 0, 1),
      r0: radius,
      r1: radius * 1.35,
      alpha: peak,
      tint: 0,
    });
  }

  private lensFade(pos: THREE.Vector3): number {
    if (!this.camera) return 1;
    const d = this.camera.getWorldPosition(CAM).distanceTo(pos);
    return clamp((d - LENS_FADE_NEAR_M) / (LENS_FADE_FAR_M - LENS_FADE_NEAR_M), 0, 1);
  }

  update(dt: number): void {
    this.rings.update(
      dt,
      (m, t) => m.r0 + (m.r1 - m.r0) * (1 - Math.pow(1 - t, 3)),
      (m, t) => m.alpha * Math.pow(1 - t, 1.4),
    );
    this.flashes.update(
      dt,
      (m, t) => m.r0 + (m.r1 - m.r0) * t,
      (m, t) => m.alpha * (1 - t) * (1 - t),
    );
  }

  clear(): void {
    this.rings.clear();
    this.flashes.clear();
  }

  dispose(): void {
    this.rings.dispose();
    this.flashes.dispose();
  }
}

function dynamicAttr(max: number, itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(max * itemSize), itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}
