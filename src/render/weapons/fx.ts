// Weapon effects: pooled billboard particles (fire, smoke, glow), tracers, brass casings, shock
// rings and two pooled lights. Everything lives in the physics frame (z-up, metres) under
// stage.physicsRoot, so positions match telemetry and poses directly.
import * as THREE from 'three/webgpu';

export type V3 = THREE.Vector3;

// ---------------------------------------------------------------- textures

function canvasTexture(size: number, paint: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowTex = () => canvasTexture(128, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  r.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});

/** A lumpy soft puff: several offset blobs, so smoke and fire don't read as perfect discs. */
const puffTex = () => canvasTexture(128, (g, s) => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, d = rnd() * s * 0.2;
    const x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d, rad = s * (0.18 + rnd() * 0.2);
    const r = g.createRadialGradient(x, y, 0, x, y, rad);
    r.addColorStop(0, 'rgba(255,255,255,0.55)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }
});

/** A spiky muzzle-flash star. */
const starTex = () => canvasTexture(128, (g, s) => {
  g.translate(s / 2, s / 2);
  for (let i = 0; i < 6; i++) {
    g.rotate(Math.PI / 3);
    const r = g.createLinearGradient(0, 0, s / 2, 0);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.beginPath();
    g.moveTo(0, -s * 0.05);
    g.lineTo(s / 2, 0);
    g.lineTo(0, s * 0.05);
    g.fill();
  }
  const c = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.22);
  c.addColorStop(0, 'rgba(255,255,255,1)');
  c.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = c;
  g.fillRect(-s / 2, -s / 2, s, s);
});

// ---------------------------------------------------------------- particles

export interface ParticleOpts {
  pos: V3;
  vel?: V3;
  life: number;
  size: [number, number]; // start, end (m)
  colors: THREE.Color[]; // colour over life (HDR values > 1 bloom)
  alpha?: [number, number];
  drag?: number; // 1/s
  gravity?: number; // m/s² along -z (negative rises)
  spin?: number;
  tag?: string; // e.g. 'flame0': the flamethrower's damage probe counts its own particles
}

interface Particle {
  sprite: THREE.Sprite;
  mat: THREE.SpriteNodeMaterial;
  vel: THREE.Vector3;
  age: number;
  o: ParticleOpts;
  active: boolean;
}

const IDLE = 1e-5;
const tmpC = new THREE.Color();

class ParticlePool {
  private readonly items: Particle[] = [];
  private next = 0;

  constructor(parent: THREE.Object3D, n: number, map: THREE.Texture, additive: boolean, order: number) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteNodeMaterial({
        map, transparent: true, depthWrite: false, fog: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(IDLE);
      sprite.frustumCulled = false;
      sprite.renderOrder = order;
      parent.add(sprite);
      this.items.push({ sprite, mat, vel: new THREE.Vector3(), age: 0, o: null as unknown as ParticleOpts, active: false });
    }
  }

  spawn(o: ParticleOpts) {
    const p = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    p.o = o;
    p.age = 0;
    p.active = true;
    p.vel.copy(o.vel ?? ZERO);
    p.sprite.position.copy(o.pos);
    p.mat.rotation = Math.random() * Math.PI * 2;
    this.paint(p, 0);
  }

  private paint(p: Particle, t: number) {
    const o = p.o;
    const cs = o.colors;
    const f = t * (cs.length - 1);
    const i = Math.min(cs.length - 2, Math.floor(f));
    if (cs.length === 1) tmpC.copy(cs[0]);
    else tmpC.copy(cs[i]).lerp(cs[i + 1], f - i);
    p.mat.color.copy(tmpC);
    const a = o.alpha ?? [1, 0];
    p.mat.opacity = a[0] + (a[1] - a[0]) * t;
    p.sprite.scale.setScalar(Math.max(IDLE, o.size[0] + (o.size[1] - o.size[0]) * Math.sqrt(t)));
  }

  update(dt: number) {
    for (const p of this.items) {
      if (!p.active) continue;
      p.age += dt;
      const t = p.age / p.o.life;
      if (t >= 1) {
        p.active = false;
        p.sprite.scale.setScalar(IDLE);
        continue;
      }
      const drag = Math.exp(-(p.o.drag ?? 0) * dt);
      p.vel.multiplyScalar(drag);
      p.vel.z -= (p.o.gravity ?? 0) * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      if (p.sprite.position.z < 0.02) {
        p.sprite.position.z = 0.02;
        p.vel.z = Math.abs(p.vel.z) * 0.2;
      }
      if (p.o.spin) p.mat.rotation += p.o.spin * dt;
      this.paint(p, t);
    }
  }

  /** Live particles within `r` of `c` (the flamethrower's damage probe). */
  countNear(c: V3, r: number, filter?: (o: ParticleOpts) => boolean): number {
    let n = 0;
    const r2 = r * r;
    for (const p of this.items) if (p.active && (!filter || filter(p.o)) && p.sprite.position.distanceToSquared(c) < r2) n++;
    return n;
  }

  clear() {
    for (const p of this.items) {
      p.active = false;
      p.sprite.scale.setScalar(IDLE);
    }
  }
}

const ZERO = new THREE.Vector3();

// ---------------------------------------------------------------- tracers

interface Tracer { mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; pos: V3; vel: V3; age: number; life: number; active: boolean }
const Y = new THREE.Vector3(0, 1, 0);

class TracerPool {
  private readonly items: Tracer[] = [];
  private next = 0;
  constructor(parent: THREE.Object3D, n: number) {
    const geo = new THREE.CylinderGeometry(0.006, 0.012, 1, 6, 1, true);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      mat.color.setRGB(6, 3.4, 1.1);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      parent.add(mesh);
      this.items.push({ mesh, mat, pos: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, life: 0, active: false });
    }
  }
  spawn(pos: V3, vel: V3, life: number, length: number, color?: THREE.Color) {
    const t = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    t.pos.copy(pos);
    t.vel.copy(vel);
    t.age = 0;
    t.life = life;
    t.active = true;
    t.mesh.visible = true;
    t.mesh.scale.set(1, length, 1);
    if (color) t.mat.color.copy(color);
    else t.mat.color.setRGB(6, 3.4, 1.1);
    t.mesh.quaternion.setFromUnitVectors(Y, tmpV.copy(vel).normalize());
    t.mesh.position.copy(pos);
  }
  update(dt: number) {
    for (const t of this.items) {
      if (!t.active) continue;
      t.age += dt;
      if (t.age >= t.life) {
        t.active = false;
        t.mesh.visible = false;
        continue;
      }
      t.pos.addScaledVector(t.vel, dt);
      t.mesh.position.copy(t.pos);
      t.mat.opacity = 1 - (t.age / t.life) * 0.5;
    }
  }
  clear() { for (const t of this.items) { t.active = false; t.mesh.visible = false; } }
}
const tmpV = new THREE.Vector3();

// ---------------------------------------------------------------- brass casings

class CasingPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos: THREE.Vector3[] = [];
  private readonly vel: THREE.Vector3[] = [];
  private readonly rot: THREE.Euler[] = [];
  private readonly spin: THREE.Vector3[] = [];
  private readonly age: number[] = [];
  private next = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(1, 1, 1);
  constructor(parent: THREE.Object3D, private readonly n: number) {
    const geo = new THREE.CylinderGeometry(0.006, 0.006, 0.035, 8);
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xc8962e, metalness: 1, roughness: 0.25 });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < n; i++) {
      this.pos.push(new THREE.Vector3(0, 0, -10));
      this.vel.push(new THREE.Vector3());
      this.rot.push(new THREE.Euler());
      this.spin.push(new THREE.Vector3());
      this.age.push(99);
      this.write(i);
    }
    parent.add(this.mesh);
  }
  eject(pos: V3, vel: V3) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i].copy(pos);
    this.vel[i].copy(vel);
    this.spin[i].set((Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60);
    this.age[i] = 0;
  }
  private write(i: number) {
    this.q.setFromEuler(this.rot[i]);
    this.m.compose(this.pos[i], this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
  }
  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] > 8) continue;
      this.age[i] += dt;
      const p = this.pos[i], v = this.vel[i];
      v.z -= 9.81 * dt;
      p.addScaledVector(v, dt);
      if (p.z < 0.006) {
        p.z = 0.006;
        if (v.z < 0) v.z = -v.z * 0.35;
        v.x *= 0.7;
        v.y *= 0.7;
        this.spin[i].multiplyScalar(0.6);
      }
      const r = this.rot[i];
      r.x += this.spin[i].x * dt;
      r.y += this.spin[i].y * dt;
      r.z += this.spin[i].z * dt;
      if (this.age[i] > 8) p.set(0, 0, -10);
      this.write(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() {
    for (let i = 0; i < this.n; i++) { this.age[i] = 99; this.pos[i].set(0, 0, -10); this.write(i); }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- shock rings

interface Ring { mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; age: number; life: number; size: number; active: boolean }

class RingPool {
  private readonly items: Ring[] = [];
  private next = 0;
  constructor(parent: THREE.Object3D, n: number, private readonly camera: THREE.Camera) {
    const geo = new THREE.RingGeometry(0.85, 1, 48);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 23;
      parent.add(mesh);
      this.items.push({ mesh, mat, age: 0, life: 0.35, size: 1, active: false });
    }
  }
  spawn(pos: V3, size: number, color: THREE.Color, flat = false) {
    const r = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    r.mesh.position.copy(pos);
    r.age = 0;
    r.life = 0.35;
    r.size = size;
    r.active = true;
    r.mesh.visible = true;
    r.mat.color.copy(color);
    r.mesh.userData.flat = flat;
    if (flat) r.mesh.rotation.set(0, 0, 0);
  }
  update(dt: number) {
    const cam = this.camera.getWorldPosition(tmpV);
    for (const r of this.items) {
      if (!r.active) continue;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) { r.active = false; r.mesh.visible = false; continue; }
      r.mesh.scale.setScalar(0.05 + r.size * (1 - Math.pow(1 - t, 3)));
      r.mat.opacity = (1 - t) * (1 - t);
      if (!r.mesh.userData.flat) r.mesh.lookAt(cam);
    }
  }
  clear() { for (const r of this.items) { r.active = false; r.mesh.visible = false; } }
}

// ---------------------------------------------------------------- the effects bundle

export const C = {
  white: new THREE.Color(6, 6, 6),
  muzzle: new THREE.Color(3.2, 2.0, 0.7),
  fireHot: new THREE.Color(4.5, 2.8, 1.0),
  fire: new THREE.Color(3.2, 1.1, 0.22),
  fireDeep: new THREE.Color(1.6, 0.35, 0.05),
  ember: new THREE.Color(0.5, 0.08, 0.02),
  pilot: new THREE.Color(0.6, 1.4, 6),
  smokeLight: new THREE.Color(0.55, 0.53, 0.5),
  smokeDark: new THREE.Color(0.12, 0.11, 0.1),
  plasma: new THREE.Color(1.2, 4.5, 9),
};

export class WeaponFx {
  readonly root = new THREE.Group();
  readonly fire: ParticlePool;
  readonly glow: ParticlePool;
  readonly smoke: ParticlePool;
  readonly tracers: TracerPool;
  readonly casings: CasingPool;
  readonly rings: RingPool;
  private readonly lights: { light: THREE.PointLight; decay: number }[] = [];
  private nextLight = 0;

  constructor(camera: THREE.Camera) {
    this.root.name = 'weapons.fx';
    const glow = glowTex(), puff = puffTex(), star = starTex();
    this.smoke = new ParticlePool(this.root, 260, puff, false, 18);
    this.fire = new ParticlePool(this.root, 420, puff, true, 20);
    this.glow = new ParticlePool(this.root, 140, glow, true, 21);
    this.star = new ParticlePool(this.root, 40, star, true, 24);
    this.tracers = new TracerPool(this.root, 90);
    this.casings = new CasingPool(this.root, 160);
    this.rings = new RingPool(this.root, 10, camera);
    // A fixed light count: lights never get added mid-fight, so no shader recompiles.
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffa040, 0, 9, 2);
      light.castShadow = false;
      this.root.add(light);
      this.lights.push({ light, decay: 20 });
    }
  }
  readonly star: ParticlePool;

  /** Light the scene from `pos` for a moment (muzzle flash, explosion, flame). */
  light(pos: V3, intensity: number, color: number, decayPerS = 22) {
    let pick = this.lights[this.nextLight];
    // Re-use the weakest light so a big blast is never cut short by a small flash.
    for (const l of this.lights) if (l.light.intensity < pick.light.intensity) pick = l;
    if (pick.light.intensity > intensity) return;
    this.nextLight = (this.nextLight + 1) % this.lights.length;
    pick.light.position.copy(pos);
    pick.light.color.setHex(color);
    pick.light.intensity = intensity;
    pick.decay = decayPerS;
  }

  muzzleFlash(pos: V3, dir: V3, scale: number) {
    this.star.spawn({ pos, life: 0.045, size: [0.22 * scale, 0.32 * scale], colors: [C.muzzle], alpha: [0.85, 0.1] });
    this.glow.spawn({ pos, life: 0.06, size: [0.22 * scale, 0.3 * scale], colors: [C.fire], alpha: [0.45, 0] });
    for (let i = 0; i < 3; i++) {
      this.fire.spawn({
        pos, vel: tmpV.copy(dir).multiplyScalar(4 + Math.random() * 5).add(rand3(1.2)).clone(),
        life: 0.07 + Math.random() * 0.04, size: [0.05 * scale, 0.16 * scale], colors: [C.fire, C.fireDeep], alpha: [0.7, 0], drag: 12,
      });
    }
    this.smoke.spawn({
      pos: pos.clone().addScaledVector(dir, 0.1), vel: tmpV.copy(dir).multiplyScalar(1.2).add(rand3(0.3)).clone(),
      life: 0.9 + Math.random() * 0.6, size: [0.08 * scale, 0.55 * scale], colors: [C.smokeLight, C.smokeDark], alpha: [0.35, 0], drag: 2.5, gravity: -0.35,
    });
    this.light(pos, 4 * scale, 0xffb050, 45);
  }

  explosion(pos: V3, scale: number) {
    this.star.spawn({ pos, life: 0.07, size: [0.5 * scale, 0.8 * scale], colors: [C.fireHot], alpha: [0.6, 0] });
    this.glow.spawn({ pos, life: 0.18, size: [0.6 * scale, 1.0 * scale], colors: [C.fire, C.fireDeep], alpha: [0.45, 0] });
    for (let i = 0; i < 18; i++) {
      const v = rand3(1).normalize().multiplyScalar((2.5 + Math.random() * 4.5) * scale);
      v.z = Math.abs(v.z) * 0.8 + 0.5;
      this.fire.spawn({
        pos: pos.clone().add(rand3(0.12 * scale)), vel: v, life: 0.35 + Math.random() * 0.45,
        size: [0.14 * scale, (0.35 + Math.random() * 0.35) * scale], colors: [C.fireHot, C.fire, C.fireDeep, C.ember],
        alpha: [0.75, 0], drag: 5, gravity: -1.5, spin: (Math.random() - 0.5) * 3,
      });
    }
    for (let i = 0; i < 8; i++) {
      const v = rand3(1).normalize().multiplyScalar((0.8 + Math.random() * 1.8) * scale);
      v.z = Math.abs(v.z) + 0.6;
      this.smoke.spawn({
        pos: pos.clone().add(rand3(0.25 * scale)), vel: v, life: 2 + Math.random() * 2,
        size: [0.25 * scale, (0.8 + Math.random() * 0.5) * scale], colors: [C.smokeDark, C.smokeLight], alpha: [0.4, 0], drag: 1.6, gravity: -0.6, spin: (Math.random() - 0.5) * 0.8,
      });
    }
    // Hot sparks: tiny, fast, falling.
    for (let i = 0; i < 16; i++) {
      const v = rand3(1).normalize().multiplyScalar(6 + Math.random() * 9);
      v.z = Math.abs(v.z) + 1;
      this.glow.spawn({ pos, vel: v, life: 0.5 + Math.random() * 0.6, size: [0.05, 0.02], colors: [C.fireHot, C.fire], alpha: [1, 0.3], drag: 1.2, gravity: 9.81 });
    }
    this.rings.spawn(pos, 1.1 * scale, new THREE.Color(1.2, 0.8, 0.45));
    const ground = pos.clone();
    ground.z = 0.03;
    if (pos.z < 1.2) this.rings.spawn(ground, 1.6 * scale, new THREE.Color(0.7, 0.5, 0.35), true);
    this.light(pos, 40 * scale, 0xff8a30, 8);
  }

  update(dt: number) {
    this.fire.update(dt);
    this.glow.update(dt);
    this.smoke.update(dt);
    this.star.update(dt);
    this.tracers.update(dt);
    this.casings.update(dt);
    this.rings.update(dt);
    for (const l of this.lights) l.light.intensity *= Math.exp(-l.decay * dt);
  }

  clear() {
    this.fire.clear();
    this.glow.clear();
    this.smoke.clear();
    this.star.clear();
    this.tracers.clear();
    this.casings.clear();
    this.rings.clear();
    for (const l of this.lights) l.light.intensity = 0;
  }
}

export function rand3(s: number): THREE.Vector3 {
  return new THREE.Vector3((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s);
}
