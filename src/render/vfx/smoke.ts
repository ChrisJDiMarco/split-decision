// Smoke and dust puffs: soft, self-lit billboards that rise on buoyancy, drift with a
// turbulent breeze, grow and thin out. Damage smoke runs from a light grey heat haze to
// thick black; canvas dust hugs the floor and spreads outward. Puffs are depth-sorted
// back to front every frame and fade softly where they meet the canvas or a robot.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cameraViewMatrix, cos, float, linearDepth, max, mix, normalize, positionGeometry,
  sin, smoothstep, texture, uniform, uv, vec2, vec3, vec4, viewportLinearDepth, cameraFar, cameraNear,
  cameraPosition, cameraWorldMatrix,
} from 'three/tsl';
import type { Any } from './tsl-any';
import { FLOOR_Y, clamp, decay, range, type Rng } from './coords';
import { PUFF_TILES, createPuffAtlas } from './puff-texture';

const MAX_PUFFS = 1400;
const FADE_IN = 0.1; // fraction of life spent fading in
const SOFT_DEPTH_M = 0.35; // soft-particle fade distance against opaque geometry

export interface PuffParams {
  life: number;
  size: number; // initial diameter, m
  growth: number; // extra diameter per √s
  opacity: number;
  dark: number; // 0 light haze .. 1 black
  buoyancy: number; // upward accel, m/s²
  drag: number; // per second
  glow: number; // 0..1 hot orange underlight from a burning vent
  tint: number; // 0 smoke grey, 1 canvas-dust beige
}

interface PuffState {
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  p: PuffParams[];
  rot: Float32Array;
  spin: Float32Array;
  tile: Float32Array;
}

export class SmokeSystem {
  readonly object: THREE.Mesh;
  private readonly s: PuffState;
  private count = 0;
  private time = 0;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aShape: THREE.InstancedBufferAttribute; // size, rotation, alpha, dark
  private readonly aLook: THREE.InstancedBufferAttribute; // tile, glow, tint, age01
  private readonly order: number[] = [];
  private readonly depth = new Float32Array(MAX_PUFFS);
  private readonly rng: Rng;
  private readonly atlas: THREE.DataTexture;
  /** Direction toward the dominant light (world). */
  readonly keyDir = uniform(new THREE.Vector3(0.15, 1, 0.1).normalize());
  readonly keyColor = uniform(new THREE.Color(1.0, 0.97, 0.92));
  readonly ambient = uniform(new THREE.Color(0.2, 0.22, 0.26));

  constructor(rng: Rng) {
    this.rng = rng;
    this.s = {
      pos: new Float32Array(MAX_PUFFS * 3),
      vel: new Float32Array(MAX_PUFFS * 3),
      age: new Float32Array(MAX_PUFFS),
      p: new Array<PuffParams>(MAX_PUFFS),
      rot: new Float32Array(MAX_PUFFS),
      spin: new Float32Array(MAX_PUFFS),
      tile: new Float32Array(MAX_PUFFS),
    };
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.aPos = dynamicAttr(3);
    this.aShape = dynamicAttr(4);
    this.aLook = dynamicAttr(4);
    this.geometry.setAttribute('iPos', this.aPos);
    this.geometry.setAttribute('iShape', this.aShape);
    this.geometry.setAttribute('iLook', this.aLook);
    // One invisible instance is always drawn so the pipeline compiles at load.
    this.geometry.instanceCount = 1;
    this.atlas = createPuffAtlas();
    this.object = new THREE.Mesh(this.geometry, this.material());
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.name = 'vfx.smoke';
  }

  get alive(): number {
    return this.count;
  }

  emit(pos: THREE.Vector3, vel: THREE.Vector3, p: PuffParams, jitter = 0.03): void {
    const s = this.s;
    let i = this.count;
    if (i >= MAX_PUFFS) i = this.oldest();
    else this.count++;
    s.pos[i * 3] = pos.x + range(this.rng, -jitter, jitter);
    s.pos[i * 3 + 1] = Math.max(FLOOR_Y + p.size * 0.25, pos.y + range(this.rng, -jitter, jitter));
    s.pos[i * 3 + 2] = pos.z + range(this.rng, -jitter, jitter);
    s.vel[i * 3] = vel.x; s.vel[i * 3 + 1] = vel.y; s.vel[i * 3 + 2] = vel.z;
    s.age[i] = 0;
    s.p[i] = p;
    s.rot[i] = this.rng() * Math.PI * 2;
    s.spin[i] = range(this.rng, -0.6, 0.6);
    s.tile[i] = Math.floor(this.rng() * PUFF_TILES * PUFF_TILES);
  }

  /** Damage smoke at level 0..1 (the telemetry smoke value decides the look). */
  smokePuff(pos: THREE.Vector3, vel: THREE.Vector3, level: number, dark: number, heat: number): void {
    const l = clamp(level, 0, 1);
    this.emit(pos, TMP.set(
      vel.x * 0.5 + range(this.rng, -0.12, 0.12),
      vel.y * 0.5 + range(this.rng, 0.15, 0.45),
      vel.z * 0.5 + range(this.rng, -0.12, 0.12),
    ), {
      life: range(this.rng, 2.2, 4.2) * (0.7 + l * 0.6),
      size: range(this.rng, 0.05, 0.1) * (0.8 + l * 0.6),
      growth: range(this.rng, 0.3, 0.55) * (0.6 + l * 0.8),
      opacity: 0.14 + 0.5 * l,
      dark,
      buoyancy: 0.7 + l * 0.9,
      drag: 1.3,
      glow: heat > 0.92 ? (heat - 0.92) * 12 : 0,
      tint: 0,
    }, 0.02);
  }

  /** Dust kicked off the canvas by a body slamming into it. */
  dust(pos: THREE.Vector3, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const v = range(this.rng, 0.4, 1) * Math.min(3.5, 0.6 + speed * 0.35);
      POS.set(pos.x + Math.cos(a) * 0.08, FLOOR_Y + 0.04, pos.z + Math.sin(a) * 0.08);
      this.emit(POS, TMP.set(Math.cos(a) * v, range(this.rng, 0.05, 0.35), Math.sin(a) * v), {
        life: range(this.rng, 1.4, 2.8),
        size: range(this.rng, 0.14, 0.28),
        growth: range(this.rng, 0.55, 1.0),
        opacity: range(this.rng, 0.28, 0.45),
        dark: 0,
        buoyancy: 0.12,
        drag: 2.2,
        glow: 0,
        tint: 1,
      }, 0.05);
    }
  }

  private oldest(): number {
    let best = 0;
    let bestT = -1;
    for (let i = 0; i < this.count; i++) {
      const t = this.s.age[i] / this.s.p[i].life;
      if (t > bestT) { bestT = t; best = i; }
    }
    return best;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    const s = this.s;
    let i = 0;
    while (i < this.count) {
      s.age[i] += dt;
      if (s.age[i] >= s.p[i].life) {
        this.kill(i);
        continue;
      }
      this.integrate(i, dt);
      i++;
    }
    this.upload(camera);
  }

  private integrate(i: number, dt: number): void {
    const s = this.s;
    const o = i * 3;
    const p = s.p[i];
    const t = s.age[i];
    // Buoyancy fades as the plume mixes with cool air.
    s.vel[o + 1] += p.buoyancy * Math.exp(-t * 0.6) * dt;
    // A slow breeze plus turbulence that grows with height and age.
    const turb = 0.35 + t * 0.15;
    const x = s.pos[o];
    const y = s.pos[o + 1];
    const z = s.pos[o + 2];
    s.vel[o] += (Math.sin(this.time * 0.9 + y * 2.3 + z * 1.7) * turb + 0.08) * dt;
    s.vel[o + 2] += Math.cos(this.time * 0.7 + y * 1.9 + x * 2.1) * turb * dt;
    const drag = decay(p.drag, dt);
    s.vel[o] *= drag; s.vel[o + 1] *= drag; s.vel[o + 2] *= drag;
    s.pos[o] += s.vel[o] * dt;
    s.pos[o + 1] += s.vel[o + 1] * dt;
    s.pos[o + 2] += s.vel[o + 2] * dt;
    const size = p.size + p.growth * Math.sqrt(t);
    const minY = FLOOR_Y + size * 0.3;
    if (s.pos[o + 1] < minY) {
      s.pos[o + 1] = minY;
      s.vel[o + 1] = Math.max(0, s.vel[o + 1]);
    }
    s.rot[i] += s.spin[i] * dt;
  }

  private kill(i: number): void {
    const s = this.s;
    const last = --this.count;
    if (i === last) return;
    s.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    s.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    s.age[i] = s.age[last];
    s.p[i] = s.p[last];
    s.rot[i] = s.rot[last];
    s.spin[i] = s.spin[last];
    s.tile[i] = s.tile[last];
  }

  private upload(camera: THREE.Object3D): void {
    const s = this.s;
    const n = this.count;
    const cam = camera.getWorldPosition(CAM);
    this.order.length = n;
    for (let i = 0; i < n; i++) {
      this.order[i] = i;
      const dx = s.pos[i * 3] - cam.x;
      const dy = s.pos[i * 3 + 1] - cam.y;
      const dz = s.pos[i * 3 + 2] - cam.z;
      this.depth[i] = dx * dx + dy * dy + dz * dz;
    }
    this.order.sort((a, b) => this.depth[b] - this.depth[a]); // far first
    const pos = this.aPos.array as Float32Array;
    const shape = this.aShape.array as Float32Array;
    const look = this.aLook.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = this.order[k];
      const p = s.p[i];
      const t = s.age[i] / p.life;
      const fade = Math.min(1, t / FADE_IN) * Math.pow(1 - t, 1.6);
      pos[k * 3] = s.pos[i * 3]; pos[k * 3 + 1] = s.pos[i * 3 + 1]; pos[k * 3 + 2] = s.pos[i * 3 + 2];
      shape[k * 4] = p.size + p.growth * Math.sqrt(s.age[i]);
      shape[k * 4 + 1] = s.rot[i];
      shape[k * 4 + 2] = p.opacity * fade;
      shape[k * 4 + 3] = p.dark;
      look[k * 4] = s.tile[i];
      look[k * 4 + 1] = p.glow * Math.pow(1 - t, 14);
      look[k * 4 + 2] = p.tint;
      look[k * 4 + 3] = t;
    }
    if (n === 0) shape.fill(0, 0, 4); // the spare instance has zero size and alpha
    for (const a of [this.aPos, this.aShape, this.aLook]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = Math.max(1, n);
  }

  private material(): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const iPos: Any = attribute('iPos', 'vec3');
    const iShape: Any = attribute('iShape', 'vec4');
    const iLook: Any = attribute('iLook', 'vec4');
    m.positionNode = Fn(() => {
      // Camera-facing billboard in world space from the camera's right/up axes.
      const c = cos(iShape.y);
      const sn = sin(iShape.y);
      const corner = positionGeometry.xy;
      const rotated = vec2(corner.x.mul(c).sub(corner.y.mul(sn)), corner.x.mul(sn).add(corner.y.mul(c)));
      const right = (cameraWorldMatrix as Any).element(0).xyz;
      const up = (cameraWorldMatrix as Any).element(1).xyz;
      return iPos.add(right.mul(rotated.x.mul(iShape.x))).add(up.mul(rotated.y.mul(iShape.x)));
    })();
    const tileUV = uv().add(vec2(iLook.x.mod(PUFF_TILES), iLook.x.div(PUFF_TILES).floor())).div(PUFF_TILES);
    const tex: Any = texture(this.atlas, tileUV);
    const density = tex.r;
    // Fake lighting: a sphere normal bent by the texture's density gradient.
    const q = uv().sub(0.5).mul(2);
    const grad = tex.gb.sub(0.5).mul(2);
    const nView = normalize(vec3(q.x.add(grad.x.mul(1.5)), q.y.add(grad.y.mul(1.5)), max(float(0.25), float(1).sub(q.dot(q)).sqrt())));
    const lView = normalize(cameraViewMatrix.mul(vec4(this.keyDir, 0)).xyz);
    const wrap = nView.dot(lView).mul(0.5).add(0.5);
    const selfShadow = float(1).sub(density.mul(0.55).mul(iShape.w.mul(0.5).add(0.5)));
    const lightSmoke: Any = mix(vec3(0.62, 0.63, 0.65), vec3(0.075, 0.07, 0.066), iShape.w);
    const dustColor = vec3(0.6, 0.57, 0.51);
    const albedo: Any = mix(lightSmoke, dustColor, iLook.z);
    const light: Any = (this.ambient as Any).add((this.keyColor as Any).mul(wrap.mul(selfShadow)));
    const lit: Any = albedo.mul(light);
    const glow = vec3(2.4, 0.75, 0.16).mul(iLook.y).mul(density).mul(float(1).sub(uv().y).pow(2));
    m.colorNode = lit.add(glow);
    // Soft particles: fade where the puff intersects opaque geometry.
    const sceneZ = viewportLinearDepth.mul(cameraFar.sub(cameraNear));
    const fragZ = linearDepth().mul(cameraFar.sub(cameraNear));
    const soft = smoothstep(0, SOFT_DEPTH_M, sceneZ.sub(fragZ));
    // Puffs very close to the camera thin out instead of filling the screen.
    const near = smoothstep(0.3, 1.2, cameraPosition.distance(iPos));
    m.opacityNode = density.pow(1.3).mul(iShape.z).mul(soft).mul(near);
    return m;
  }

  clear(): void {
    this.count = 0;
    this.upload(CAM_ORIGIN);
  }

  dispose(): void {
    this.geometry.dispose();
    this.atlas.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

const TMP = new THREE.Vector3();
const POS = new THREE.Vector3();
const CAM = new THREE.Vector3();
const CAM_ORIGIN = new THREE.Object3D();

function dynamicAttr(itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * itemSize), itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}
