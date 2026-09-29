// Metal-impact sparks: CPU-integrated hot particles drawn as camera-facing velocity
// streaks (a motion-blurred look like a real 1/60 s exposure). Colors are HDR so the
// post bloom catches them. Sparks bounce and sometimes split on the canvas, and cool
// from white-yellow to orange to a dull red.
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cameraPosition, cross, float, length, mix, normalize, positionGeometry, select,
  smoothstep, uv, vec3, vec4,
} from 'three/tsl';
import type { Any } from './tsl-any';
import { FLOOR_Y, GRAVITY, clamp, decay, randomInCone, range, type Rng } from './coords';
import { sparkCount, sparkSpeed } from './scaling';

const MAX_SPARKS = 4096;
/** Exposure time used to stretch streaks, seconds. */
const SHUTTER_S = 1 / 50;
const MIN_STREAK_M = 0.006;
/** Aerodynamic drag on a ~0.3 mm glowing steel particle, per second. */
const DRAG = 1.1;
const BOUNCE_RESTITUTION = 0.32;
const BOUNCE_FRICTION = 0.55;
const SPLIT_CHANCE = 0.35;

// Per-particle CPU state (struct of arrays).
interface SparkState {
  pos: Float32Array;
  vel: Float32Array;
  age: Float32Array;
  life: Float32Array;
  heat: Float32Array; // starting temperature 0..1
  width: Float32Array;
  buoy: Float32Array; // gravity multiplier: 1 = falls, negative = rising ember
  bounces: Uint8Array;
}

export interface SparkBurstOptions {
  /** Extra multiplier on the count (e.g. harder materials throw more). */
  countScale?: number;
  /** Aim the burst: sparks spray mostly tangent to the surface with this normal. */
  normal?: THREE.Vector3;
}

export class SparkSystem {
  readonly object: THREE.Mesh;
  private readonly s: SparkState;
  private count = 0;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
    this.s = {
      pos: new Float32Array(MAX_SPARKS * 3),
      vel: new Float32Array(MAX_SPARKS * 3),
      age: new Float32Array(MAX_SPARKS),
      life: new Float32Array(MAX_SPARKS),
      heat: new Float32Array(MAX_SPARKS),
      width: new Float32Array(MAX_SPARKS),
      buoy: new Float32Array(MAX_SPARKS),
      bounces: new Uint8Array(MAX_SPARKS),
    };
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.aPos = dynamicAttr(3);
    this.aVel = dynamicAttr(3);
    this.aCol = dynamicAttr(4);
    this.geometry.setAttribute('iPos', this.aPos);
    this.geometry.setAttribute('iVel', this.aVel);
    this.geometry.setAttribute('iCol', this.aCol);
    // One zero-width instance is always drawn so the pipeline compiles at load, not on
    // the first hit of the fight.
    this.geometry.instanceCount = 1;
    this.object = new THREE.Mesh(this.geometry, streakMaterial());
    this.object.frustumCulled = false;
    this.object.renderOrder = 20;
    this.object.name = 'vfx.sparks';
  }

  get alive(): number {
    return this.count;
  }

  /** A burst from a metal impact. Returns how many sparks were spawned. */
  burst(pos: THREE.Vector3, energyJ: number, opts: SparkBurstOptions = {}): number {
    const n = Math.round(sparkCount(energyJ) * (opts.countScale ?? 1));
    const speed = sparkSpeed(energyJ);
    const normal = opts.normal ?? UP;
    for (let i = 0; i < n; i++) {
      // Sparks shear off tangent to the contact: mostly along the surface, a few
      // straight out of it, on both sides (both bodies shed metal).
      const tangentBias = this.rng() < 0.75;
      randomInCone(this.rng, this.rng() < 0.5 ? normal : NEG.copy(normal).negate(), tangentBias ? 1.35 : 0.7, DIR);
      DIR.y += 0.25; // a hit kicks material upward on average
      DIR.normalize();
      const molten = this.rng() < 0.08; // fat, slow globules that glow longer
      const v = speed * (molten ? range(this.rng, 0.25, 0.55) : range(this.rng, 0.45, 1.25));
      this.spawn(pos, DIR.multiplyScalar(v), {
        life: molten ? range(this.rng, 0.9, 1.7) : range(this.rng, 0.25, 1.05),
        heat: range(this.rng, 0.82, 1),
        width: molten ? range(this.rng, 0.007, 0.011) : range(this.rng, 0.0025, 0.0055),
        buoy: 1,
      });
    }
    return n;
  }

  /** Slow rising embers from an overheated part. */
  embers(pos: THREE.Vector3, vel: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      DIR.set(range(this.rng, -0.4, 0.4), range(this.rng, 0.3, 1.1), range(this.rng, -0.4, 0.4)).add(vel);
      this.spawn(pos, DIR, {
        life: range(this.rng, 0.6, 1.6),
        heat: range(this.rng, 0.45, 0.7),
        width: range(this.rng, 0.003, 0.005),
        buoy: -0.08,
      });
    }
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, p: { life: number; heat: number; width: number; buoy: number }): void {
    const s = this.s;
    let i = this.count;
    if (i >= MAX_SPARKS) i = Math.floor(this.rng() * MAX_SPARKS); // overwrite a random old one
    else this.count++;
    s.pos[i * 3] = pos.x; s.pos[i * 3 + 1] = pos.y; s.pos[i * 3 + 2] = pos.z;
    s.vel[i * 3] = vel.x; s.vel[i * 3 + 1] = vel.y; s.vel[i * 3 + 2] = vel.z;
    s.age[i] = 0;
    s.life[i] = p.life;
    s.heat[i] = p.heat;
    s.width[i] = p.width;
    s.buoy[i] = p.buoy;
    s.bounces[i] = 0;
  }

  update(dt: number): void {
    const s = this.s;
    const drag = decay(DRAG, dt);
    let i = 0;
    while (i < this.count) {
      s.age[i] += dt;
      if (s.age[i] >= s.life[i]) {
        this.kill(i);
        continue;
      }
      this.integrate(i, dt, drag);
      i++;
    }
    this.upload();
  }

  private integrate(i: number, dt: number, drag: number): void {
    const s = this.s;
    const o = i * 3;
    s.vel[o + 1] -= GRAVITY * s.buoy[i] * dt;
    s.vel[o] *= drag; s.vel[o + 1] *= drag; s.vel[o + 2] *= drag;
    s.pos[o] += s.vel[o] * dt;
    s.pos[o + 1] += s.vel[o + 1] * dt;
    s.pos[o + 2] += s.vel[o + 2] * dt;
    if (s.pos[o + 1] < FLOOR_Y && s.vel[o + 1] < 0) this.bounce(i);
  }

  private bounce(i: number): void {
    const s = this.s;
    const o = i * 3;
    s.pos[o + 1] = FLOOR_Y + 0.002;
    const vy = -s.vel[o + 1];
    s.vel[o + 1] = vy * BOUNCE_RESTITUTION * range(this.rng, 0.6, 1.2);
    s.vel[o] *= BOUNCE_FRICTION;
    s.vel[o + 2] *= BOUNCE_FRICTION;
    s.bounces[i]++;
    s.heat[i] *= 0.85; // the canvas steals heat
    s.life[i] = Math.min(s.life[i], s.age[i] + 0.45);
    // A hot spark hitting the floor hard often bursts into two smaller ones.
    if (s.bounces[i] === 1 && vy > 1.5 && this.count < MAX_SPARKS - 2 && this.rng() < SPLIT_CHANCE) {
      POS.set(s.pos[o], s.pos[o + 1], s.pos[o + 2]);
      for (let k = 0; k < 2; k++) {
        DIR.set(range(this.rng, -1, 1), range(this.rng, 0.2, 0.8), range(this.rng, -1, 1)).normalize()
          .multiplyScalar(vy * range(this.rng, 0.25, 0.6));
        this.spawn(POS, DIR, { life: range(this.rng, 0.12, 0.35), heat: s.heat[i] * 0.9, width: s.width[i] * 0.7, buoy: 1 });
      }
    }
  }

  private kill(i: number): void {
    const s = this.s;
    const last = --this.count;
    if (i === last) return;
    s.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
    s.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
    s.age[i] = s.age[last];
    s.life[i] = s.life[last];
    s.heat[i] = s.heat[last];
    s.width[i] = s.width[last];
    s.buoy[i] = s.buoy[last];
    s.bounces[i] = s.bounces[last];
  }

  private upload(): void {
    const s = this.s;
    const n = this.count;
    const pos = this.aPos.array as Float32Array;
    const vel = this.aVel.array as Float32Array;
    const col = this.aCol.array as Float32Array;
    pos.set(s.pos.subarray(0, n * 3));
    vel.set(s.vel.subarray(0, n * 3));
    for (let i = 0; i < n; i++) {
      const t = clamp(s.heat[i] * Math.pow(1 - s.age[i] / s.life[i], 0.9), 0, 1);
      blackbody(t, COL);
      col[i * 4] = COL.r; col[i * 4 + 1] = COL.g; col[i * 4 + 2] = COL.b;
      col[i * 4 + 3] = s.width[i];
    }
    if (n === 0) col[3] = 0; // the spare instance has zero width
    for (const a of [this.aPos, this.aVel, this.aCol]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
    this.geometry.instanceCount = Math.max(1, n);
  }

  clear(): void {
    this.count = 0;
    this.upload();
  }

  dispose(): void {
    this.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const NEG = new THREE.Vector3();
const DIR = new THREE.Vector3();
const POS = new THREE.Vector3();
const COL = new THREE.Color();

function dynamicAttr(itemSize: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARKS * itemSize), itemSize);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

/**
 * Incandescent steel color for a normalized temperature t (1 ≈ 1600 °C white-yellow,
 * 0.5 ≈ 900 °C orange, 0.2 ≈ dull cherry red). HDR: values above 1 feed the bloom.
 */
export function blackbody(t: number, out: THREE.Color): THREE.Color {
  const g = Math.pow(clamp((t - 0.18) / 0.82, 0, 1), 1.35);
  const b = Math.pow(clamp((t - 0.62) / 0.38, 0, 1), 1.8);
  const intensity = 0.2 + Math.pow(t, 2.6) * 9;
  return out.setRGB(intensity, intensity * (0.08 + 0.82 * g), intensity * (0.01 + 0.7 * b));
}

/** Camera-facing streak from the spark's position back along its velocity. */
function streakMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const iPos: Any = attribute('iPos', 'vec3');
  const iVel: Any = attribute('iVel', 'vec3');
  const iCol: Any = attribute('iCol', 'vec4');
  m.positionNode = Fn(() => {
    const along: Any = positionGeometry.y.add(0.5); // 0 tail .. 1 head
    const across = positionGeometry.x; // -0.5 .. 0.5
    const streak: Any = iVel.mul(SHUTTER_S);
    const len: Any = length(streak);
    const dir: Any = (select as Any)(len.greaterThan(1e-5), streak.div(len), vec3(0, 1, 0));
    const shown: Any = len.max(MIN_STREAK_M);
    const tail: Any = iPos.sub(dir.mul(shown));
    const toCam = normalize(cameraPosition.sub(iPos));
    const side: Any = normalize(cross(dir, toCam).add(vec3(1e-4, 0, 0)));
    return mix(tail, iPos, along).add(side.mul(across.mul(iCol.w)));
  })();
  const u = uv();
  const core = float(1).sub(u.x.sub(0.5).mul(2).abs().pow(2)); // soft across the width
  const tailFade = smoothstep(0, 0.7, u.y); // brightest at the head
  m.colorNode = vec4(iCol.xyz.mul(core).mul(tailFade), 1);
  return m;
}
