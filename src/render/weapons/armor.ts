// Chippable outer shielding: every robot wears dozens of bolted armour plates over its torso, head,
// arms and legs. Each plate has its own health. Hits near it (punches, kicks, bullets, blasts, fire)
// wear it down: first it scorches and cracks, then it shears off and tumbles away as debris that
// bounces across the canvas. Presentation only: the physics body underneath is unchanged.
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as THREE from 'three/webgpu';
import type { Corner } from '../../core/types';
import type { RobotKitView } from '../robot-kit';
import { ensureAttributes } from '../robot-kit/geom/attrs';
import { newObjState, type KitObjState } from '../robot-kit/geom/part-builder';
import type { KitPart } from '../robot-kit/types';

const PLATE_HP = 110; // J of presentation energy at the plate's centre
const DEBRIS_LIFE_S = 9;
const MAX_DEBRIS = 220;

interface Plate {
  mesh: THREE.Mesh;
  part: KitPart;
  corner: Corner;
  hp: number;
  kit: KitObjState; // the robot shader's per-object wear (scratches, grime) and heat (glow)
  normal: THREE.Vector3; // outward, part frame
}

interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  rest: boolean;
}

export interface ArmorHost {
  physicsRoot: THREE.Group;
  /** A piece came off: throw sparks (physics-frame position, outward direction). */
  onShear(pos: THREE.Vector3, dir: THREE.Vector3): void;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

export class Armor {
  private plates: Plate[] = [];
  private debris: Debris[] = [];

  constructor(private readonly host: ArmorHost) {}

  /** New fight: bolt fresh plates onto every robot. */
  setViews(views: RobotKitView[]): void {
    for (const p of this.plates) p.mesh.removeFromParent();
    this.plates = [];
    this.clear();
    for (const view of views) {
      const paint = view.materials.paint, dark = view.materials.trim;
      for (const part of view.parts.values()) {
        const id = part.id;
        if (/fist|hand|foot|pelvis/.test(id)) continue;
        const box = localBox(part);
        if (box.isEmpty()) continue;
        const layout = id === 'torso' ? TORSO : id === 'head' ? HEAD : LIMB;
        for (const spec of layout) this.platesOn(view.corner, part, box, spec, paint, dark);
      }
    }
  }

  /** Remove all loose debris (new fight). */
  clear(): void {
    for (const d of this.debris) d.mesh.removeFromParent();
    this.debris = [];
  }

  /**
   * Damage plates around a hit. `pos` is physics-frame; `energyJ` the hit's presentation energy;
   * `dir` the direction the blow travelled (plates fly that way).
   */
  hit(victim: Corner, pos: THREE.Vector3, energyJ: number, dir: THREE.Vector3 | null): void {
    if (energyJ < 4) return;
    const root = this.host.physicsRoot;
    const radius = 0.12 + Math.min(0.5, Math.sqrt(energyJ) * 0.012);
    for (const p of this.plates) {
      if (p.corner !== victim || p.hp <= 0 || !p.mesh.parent) continue;
      const c = root.worldToLocal(p.mesh.getWorldPosition(tmp));
      const d = c.distanceTo(pos);
      if (d > radius) continue;
      const share = 1 - d / radius;
      p.hp -= energyJ * share * share;
      const wear = 1 - Math.max(0, p.hp) / PLATE_HP;
      // Scorched and dulled as it wears; a glowing edge just before it goes.
      p.kit.wear = Math.min(1, wear * 1.2);
      p.kit.heat = wear > 0.7 ? (wear - 0.7) * 1.6 : 0;
      if (p.hp <= 0) this.shear(p, c, dir);
    }
  }

  update(dt: number): void {
    for (const d of this.debris) {
      d.age += dt;
      if (d.rest) {
        if (d.age > DEBRIS_LIFE_S) d.mesh.position.z -= dt * 0.05; // sink away quietly
        continue;
      }
      d.vel.z -= 9.81 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      const r = Math.hypot(d.mesh.position.x, d.mesh.position.y);
      if (r > 3.6) {
        // The cage: bounce back in.
        tmp2.set(d.mesh.position.x, d.mesh.position.y, 0).normalize();
        const vn = d.vel.dot(tmp2);
        if (vn > 0) d.vel.addScaledVector(tmp2, -1.5 * vn);
      }
      if (d.mesh.position.z < 0.012) {
        d.mesh.position.z = 0.012;
        if (Math.abs(d.vel.z) < 0.6 && Math.hypot(d.vel.x, d.vel.y) < 0.3) {
          d.rest = true;
          d.mesh.rotation.x = Math.round(d.mesh.rotation.x / Math.PI) * Math.PI; // settle flat
          d.mesh.rotation.y = Math.round(d.mesh.rotation.y / Math.PI) * Math.PI;
          continue;
        }
        d.vel.z = -d.vel.z * 0.35;
        d.vel.x *= 0.6;
        d.vel.y *= 0.6;
        d.spin.multiplyScalar(0.55);
      }
    }
    this.debris = this.debris.filter((d) => {
      if (d.age < DEBRIS_LIFE_S + 3) return true;
      d.mesh.removeFromParent();
      return false;
    });
  }

  // ---------------------------------------------------------------- internals

  private shear(p: Plate, centre: THREE.Vector3, dir: THREE.Vector3 | null) {
    const root = this.host.physicsRoot;
    root.attach(p.mesh); // keep its world pose, now loose in the physics frame
    const out = p.normal.clone().transformDirection(p.part.attached.matrix).normalize();
    const v = out.multiplyScalar(1.5 + Math.random() * 2);
    if (dir) v.addScaledVector(dir.clone().normalize(), 2 + Math.random() * 2);
    v.z += 1.5 + Math.random() * 2;
    p.kit.heat = 0.7;
    this.debris.push({ mesh: p.mesh, vel: v, spin: new THREE.Vector3((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22), age: 0, rest: false });
    if (this.debris.length > MAX_DEBRIS) this.debris.shift()!.mesh.removeFromParent();
    this.host.onShear(centre, v);
    // The glow on the torn edge cools off.
    const kit = p.kit;
    const cool = () => { kit.heat *= 0.85; if (kit.heat > 0.02) setTimeout(cool, 60); else kit.heat = 0; };
    setTimeout(cool, 60);
  }

  private platesOn(corner: Corner, part: KitPart, box: THREE.Box3, spec: FaceSpec, paint: THREE.Material, dark: THREE.Material) {
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const { axis, sign, rows, cols } = spec;
    // The face's two in-plane axes.
    const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    const su = size.getComponent(u), sv = size.getComponent(v);
    const gap = 0.006;
    const pw = su / cols - gap, ph = sv / rows - gap;
    if (pw < 0.025 || ph < 0.025) return;
    const thick = THREE.MathUtils.clamp(Math.min(pw, ph) * 0.12, 0.007, 0.018);
    const n = new THREE.Vector3().setComponent(axis, sign);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (spec.skip?.(r, c)) continue;
        const pos = centre.clone();
        pos.setComponent(axis, (sign > 0 ? box.max : box.min).getComponent(axis) + sign * (thick / 2 + 0.002));
        pos.setComponent(u, box.min.getComponent(u) + (c + 0.5) * (su / cols));
        pos.setComponent(v, box.min.getComponent(v) + (r + 0.5) * (sv / rows));
        const dims = new THREE.Vector3().setComponent(axis, thick).setComponent(u, pw).setComponent(v, ph);
        const geo = ensureAttributes(new RoundedBoxGeometry(dims.x, dims.y, dims.z, 2, Math.min(thick * 0.45, 0.006)));
        const mesh = new THREE.Mesh(geo, (r + c) % 4 === 3 ? dark : paint);
        const kit = newObjState(Math.random());
        mesh.userData.kit = kit;
        mesh.position.copy(pos);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        part.attached.add(mesh);
        this.plates.push({ mesh, part, corner, hp: PLATE_HP * (0.8 + Math.random() * 0.5) * (part.id === 'torso' ? 1.3 : 1), kit, normal: n.clone() });
      }
    }
  }
}

interface FaceSpec { axis: 0 | 1 | 2; sign: 1 | -1; rows: number; cols: number; skip?: (r: number, c: number) => boolean }

// Part frames: x forward, y left, z up (limbs run along z).
const TORSO: FaceSpec[] = [
  { axis: 0, sign: 1, rows: 4, cols: 3 }, // chest
  { axis: 0, sign: -1, rows: 4, cols: 3 }, // back
  { axis: 1, sign: 1, rows: 3, cols: 2 }, // left flank
  { axis: 1, sign: -1, rows: 3, cols: 2 }, // right flank
];
const HEAD: FaceSpec[] = [
  { axis: 1, sign: 1, rows: 1, cols: 2 },
  { axis: 1, sign: -1, rows: 1, cols: 2 },
  { axis: 0, sign: -1, rows: 1, cols: 1 },
];
const LIMB: FaceSpec[] = [
  { axis: 0, sign: 1, rows: 3, cols: 1 }, // front
  { axis: 1, sign: 1, rows: 3, cols: 1 }, // outer/inner sides
  { axis: 1, sign: -1, rows: 3, cols: 1 },
  { axis: 0, sign: -1, rows: 2, cols: 1 },
];


/** The part's collision shapes' bounds in its own frame (exact, unlike the visuals, which carry joint housings). */
export function localBox(part: KitPart): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const g of part.def.geoms) {
    const sh = g.shape;
    if (sh.type === 'box') {
      const q = g.quat ? new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]) : new THREE.Quaternion();
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        v.set(sx * sh.halfSize[0], sy * sh.halfSize[1], sz * sh.halfSize[2]).applyQuaternion(q).add(new THREE.Vector3(...(g.pos ?? [0, 0, 0])));
        box.expandByPoint(v);
      }
    } else if (sh.type === 'sphere') {
      const c = new THREE.Vector3(...(g.pos ?? [0, 0, 0]));
      box.expandByPoint(v.copy(c).addScalar(sh.radius));
      box.expandByPoint(v.copy(c).addScalar(-sh.radius));
    } else {
      for (const e of [sh.from, sh.to]) {
        box.expandByPoint(v.set(e[0] + sh.radius, e[1] + sh.radius, e[2] + sh.radius));
        box.expandByPoint(v.set(e[0] - sh.radius, e[1] - sh.radius, e[2] - sh.radius));
      }
    }
  }
  return box;
}
