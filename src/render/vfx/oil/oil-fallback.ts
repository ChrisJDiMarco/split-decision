// Oil without the GPU fluid solver (the WebGL2 path, or a device without the compute
// limits the solver needs): ballistic droplets that land and feed puddle decals. Each
// puddle spreads with the volume it has collected, stays glossy while it is fed, then
// soaks in and dries to a matte brown stain that never goes away.
import * as THREE from 'three/webgpu';
import { attribute, float, mix, texture, uv, vec2, vec3 } from 'three/tsl';
import { FLOOR_Y, GRAVITY, randomInCone, range, type Rng } from '../coords';
import type { Any } from '../tsl-any';
import {
  OIL_DEEP, OIL_STAIN, OIL_THIN, PUDDLE_MASK_VARIANTS, createPuddleMasks, type OilSystem,
} from './oil-look';
import { oilStreakMaterial, streakQuad } from './oil-streaks';

const MAX_DROPS = 2500;
const MAX_PUDDLES = 64;
const DROP_VOLUME_M3 = 1e-6; // 1 mL per visual droplet
const DROP_RADIUS_M = 0.0055;
const FILM_THICKNESS_M = 0.0025; // oil spreads on canvas to about this depth
const SPREAD_RATE_PER_S = 1.2; // how fast a puddle reaches its equilibrium size
const WET_HOLD_S = 5; // a fed puddle stays wet this long after the last drop
const DRY_RATE_PER_S = 0.045; // then soaks in over ~20 s
const MERGE_SLACK_M = 0.04;
/** Where the spare droplet instance waits, out of sight. */
const PARKED_Y = -100;
/** Two puddles merge once their centres are closer than this fraction of their radii sum. */
const MERGE_OVERLAP = 0.7;
const DRAG_PER_S = 0.25;

interface Puddle {
  x: number;
  z: number;
  volume: number;
  radius: number;
  wet: number;
  sinceFed: number;
  rot: number;
  variant: number;
  born: number;
}

export class FallbackOil implements OilSystem {
  readonly object = new THREE.Group();
  readonly kind = 'fallback' as const;
  private readonly drops: THREE.InstancedMesh;
  private readonly dropPosAttr: THREE.InstancedBufferAttribute;
  private readonly dropVelAttr: THREE.InstancedBufferAttribute;
  private readonly pos = new Float32Array(MAX_DROPS * 3);
  private readonly vel = new Float32Array(MAX_DROPS * 3);
  private count = 0;
  private readonly puddles: Puddle[] = [];
  private readonly puddleMesh: THREE.InstancedMesh;
  private readonly puddleAttr: THREE.InstancedBufferAttribute;
  private readonly masks: THREE.DataTexture;
  private time = 0;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
    this.object.name = 'vfx.oil.fallback';
    const quad = streakQuad();
    this.dropPosAttr = dynamicAttr(3);
    this.dropVelAttr = dynamicAttr(3);
    quad.setAttribute('iPos', this.dropPosAttr);
    quad.setAttribute('iVel', this.dropVelAttr);
    const streaks = oilStreakMaterial({
      pos: attribute('iPos', 'vec3'),
      vel: attribute('iVel', 'vec3'),
      width: float(DROP_RADIUS_M * 2),
    });
    this.drops = new THREE.InstancedMesh(quad, streaks, MAX_DROPS);
    // One spare instance parked far below the canvas is always drawn so the pipeline
    // compiles at load, not on the first leak.
    (this.dropPosAttr.array as Float32Array)[1] = PARKED_Y;
    this.drops.count = 1;
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 12;
    this.masks = createPuddleMasks();
    const plane = new THREE.PlaneGeometry(2, 2);
    plane.rotateX(-Math.PI / 2);
    this.puddleAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUDDLES * 4), 4);
    this.puddleAttr.setUsage(THREE.DynamicDrawUsage);
    plane.setAttribute('iPud', this.puddleAttr);
    this.puddleMesh = new THREE.InstancedMesh(plane, puddleMaterial(this.masks), MAX_PUDDLES);
    this.puddleMesh.count = 1; // spare instance: zero alpha until a puddle exists
    this.puddleMesh.receiveShadow = true;
    this.puddleMesh.frustumCulled = false;
    this.puddleMesh.renderOrder = 1;
    this.object.add(this.puddleMesh, this.drops);
  }

  get activeParticles(): number {
    return this.count;
  }

  spray(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, count: number, spread: number, inherit: THREE.Vector3): void {
    for (let k = 0; k < count; k++) {
      let i = this.count;
      if (i >= MAX_DROPS) i = Math.floor(this.rng() * MAX_DROPS);
      else this.count++;
      randomInCone(this.rng, dir, spread, V).multiplyScalar(speed * range(this.rng, 0.8, 1.1)).add(inherit);
      const lead = this.rng() / 60; // spread the frame's drops along the stream
      this.pos[i * 3] = pos.x + V.x * lead;
      this.pos[i * 3 + 1] = pos.y + V.y * lead;
      this.pos[i * 3 + 2] = pos.z + V.z * lead;
      this.vel[i * 3] = V.x; this.vel[i * 3 + 1] = V.y; this.vel[i * 3 + 2] = V.z;
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.stepDrops(dt);
    this.stepPuddles(dt);
  }

  private stepDrops(dt: number): void {
    const drag = Math.exp(-DRAG_PER_S * dt);
    let i = 0;
    while (i < this.count) {
      const o = i * 3;
      this.vel[o + 1] -= GRAVITY * dt;
      this.vel[o] *= drag; this.vel[o + 1] *= drag; this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] <= FLOOR_Y + DROP_RADIUS_M) {
        this.deposit(this.pos[o], this.pos[o + 2]);
        this.removeDrop(i);
        continue;
      }
      i++;
    }
    const pos = this.dropPosAttr.array as Float32Array;
    const vel = this.dropVelAttr.array as Float32Array;
    pos.set(this.pos.subarray(0, this.count * 3));
    vel.set(this.vel.subarray(0, this.count * 3));
    if (this.count === 0) pos[1] = PARKED_Y;
    for (const a of [this.dropPosAttr, this.dropVelAttr]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, this.count) * 3);
      a.needsUpdate = true;
    }
    this.drops.count = Math.max(1, this.count);
  }

  private removeDrop(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
  }

  private deposit(x: number, z: number): void {
    let best: Puddle | null = null;
    let bestD = Infinity;
    for (const p of this.puddles) {
      const d = Math.hypot(p.x - x, p.z - z);
      // Measure against the size the puddle is spreading to, not its current size.
      if (d < Math.max(p.radius, equilibriumRadius(p.volume)) + MERGE_SLACK_M && d < bestD) { best = p; bestD = d; }
    }
    if (!best) best = this.newPuddle(x, z);
    // Volume-weighted drift of the centre toward where the oil lands.
    const w = DROP_VOLUME_M3 / (best.volume + DROP_VOLUME_M3);
    best.x += (x - best.x) * w * 0.5;
    best.z += (z - best.z) * w * 0.5;
    best.volume += DROP_VOLUME_M3;
    best.wet = 1;
    best.sinceFed = 0;
  }

  private newPuddle(x: number, z: number): Puddle {
    const p: Puddle = {
      x, z, volume: 0, radius: 0.015, wet: 1, sinceFed: 0,
      rot: this.rng() * Math.PI * 2, variant: Math.floor(this.rng() * PUDDLE_MASK_VARIANTS), born: this.time,
    };
    if (this.puddles.length < MAX_PUDDLES) this.puddles.push(p);
    else {
      // Replace the driest, oldest stain.
      let idx = 0;
      for (let k = 1; k < this.puddles.length; k++) {
        const a = this.puddles[k];
        const b = this.puddles[idx];
        if (a.wet < b.wet || (a.wet === b.wet && a.born < b.born)) idx = k;
      }
      this.puddles[idx] = p;
    }
    return p;
  }

  /** Puddles that have spread into each other become one. */
  private mergeOverlapping(): void {
    for (let a = 0; a < this.puddles.length; a++) {
      for (let b = this.puddles.length - 1; b > a; b--) {
        const p = this.puddles[a];
        const q = this.puddles[b];
        if (Math.hypot(p.x - q.x, p.z - q.z) > (p.radius + q.radius) * MERGE_OVERLAP) continue;
        const w = q.volume / Math.max(p.volume + q.volume, 1e-12);
        p.x += (q.x - p.x) * w;
        p.z += (q.z - p.z) * w;
        p.volume += q.volume;
        p.radius = Math.max(p.radius, q.radius);
        p.wet = Math.max(p.wet, q.wet);
        p.sinceFed = Math.min(p.sinceFed, q.sinceFed);
        this.puddles.splice(b, 1);
      }
    }
  }

  private stepPuddles(dt: number): void {
    this.mergeOverlapping();
    const attr = this.puddleAttr.array as Float32Array;
    this.puddles.forEach((p, k) => {
      const target = equilibriumRadius(p.volume);
      p.radius += (target - p.radius) * (1 - Math.exp(-SPREAD_RATE_PER_S * dt));
      p.sinceFed += dt;
      if (p.sinceFed > WET_HOLD_S) p.wet = Math.max(0, p.wet - DRY_RATE_PER_S * dt);
      Q.setFromAxisAngle(Y, p.rot);
      // Overlapping puddles are layered by a hair so they never z-fight.
      P.set(p.x, FLOOR_Y + 0.0012 + k * 0.00002, p.z);
      S.set(p.radius, 1, p.radius);
      M.compose(P, Q, S);
      this.puddleMesh.setMatrixAt(k, M);
      attr[k * 4] = p.wet;
      attr[k * 4 + 1] = p.variant;
      attr[k * 4 + 2] = Math.min(1, p.volume / 2e-5); // tiny spots are faint
      attr[k * 4 + 3] = 0;
    });
    if (this.puddles.length === 0) attr[2] = 0;
    this.puddleMesh.count = Math.max(1, this.puddles.length);
    this.puddleMesh.instanceMatrix.needsUpdate = true;
    this.puddleAttr.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.puddles.length = 0;
    this.stepDrops(0);
    this.stepPuddles(0);
  }

  dispose(): void {
    this.drops.geometry.dispose();
    (this.drops.material as THREE.Material).dispose();
    this.puddleMesh.geometry.dispose();
    (this.puddleMesh.material as THREE.Material).dispose();
    this.masks.dispose();
  }
}

/** Radius oil of this volume spreads to on canvas. */
function equilibriumRadius(volumeM3: number): number {
  return Math.sqrt(volumeM3 / (Math.PI * FILM_THICKNESS_M));
}

function puddleMaterial(masks: THREE.DataTexture): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const iPud: Any = attribute('iPud', 'vec4');
  const maskUV = vec2(uv().x.add(iPud.y).div(PUDDLE_MASK_VARIANTS), uv().y);
  const mask: Any = texture(masks, maskUV);
  const wet: Any = iPud.x;
  const depth: Any = mask.g;
  const oil: Any = mix(vec3(OIL_THIN.r, OIL_THIN.g, OIL_THIN.b), vec3(OIL_DEEP.r, OIL_DEEP.g, OIL_DEEP.b), depth.pow(0.5));
  const stain = vec3(OIL_STAIN.r, OIL_STAIN.g, OIL_STAIN.b);
  m.colorNode = mix(stain, oil, wet);
  m.roughnessNode = mix(float(0.8), float(0.07), wet);
  m.metalnessNode = float(0);
  m.opacityNode = mask.r.mul(mix(float(0.5), float(0.97), wet)).mul(iPud.z);
  return m;
}

function dynamicAttr(itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * itemSize), itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

const V = new THREE.Vector3();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const Q = new THREE.Quaternion();
const M = new THREE.Matrix4();
