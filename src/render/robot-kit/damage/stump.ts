// Torn socket left behind when a part comes off: a snapped actuator shaft, a bent bracket and
// a bundle of frayed wires with bare copper ends that spark. The same builder dresses the
// underside of the flying debris part.
import * as THREE from 'three/webgpu';
import { FrameBuilder, newObjState, type KitObjState } from '../geom/part-builder';
import { cylinder, lathe, tube } from '../geom/prims';
import { alongZ, quatZTo, rng } from '../geom/xf';
import type { KitMaterials } from '../types';

const WIRE_COLORS = ['#b3261e', '#d8b21c', '#1f4fb0', '#1a1a1a', '#e6e6e6', '#2f8f3a', '#c45a12'];

export interface Stump {
  group: THREE.Group;
  obj: KitObjState;
  sparks: THREE.Object3D[]; // markers at the live wire ends
}

/**
 * Build a torn socket in a frame where `dir` points from the socket out into the space the
 * part used to fill. `radius` scales the bundle.
 */
export function buildStump(mats: KitMaterials, dir: THREE.Vector3, radius: number, seed: number, name: string): Stump {
  const rand = rng(seed);
  const fb = new FrameBuilder(name, seed);
  const d = dir.clone().normalize();
  const q = quatZTo(d);
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const side2 = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  // Snapped output shaft: a stub with a jagged, tilted end.
  const shaftR = radius * 0.28;
  fb.add('mech', lathe([[0, 0, 1], [shaftR * 1.5, 0, 1], [shaftR * 1.5, shaftR * 0.6, 1], [shaftR, shaftR * 0.7, 1], [shaftR, shaftR * 2.2, 1], [shaftR * 0.7, shaftR * 2.9, 1], [shaftR * 0.2, shaftR * 2.4, 1], [0, shaftR * 2.6, 1]], 9), alongZ(new THREE.Vector3(), d, rand() * 6), { edgeMin: 0.5, cavity: 0.4 });
  // Torn bracket stubs.
  for (let i = 0; i < 2; i++) {
    const a = rand() * Math.PI * 2;
    const p = side.clone().multiplyScalar(Math.cos(a) * radius * 0.75).addScaledVector(side2, Math.sin(a) * radius * 0.75);
    const bend = d.clone().addScaledVector(side, (rand() - 0.5) * 0.9).normalize();
    fb.add('frame', cylinder(radius * 0.07, 0, radius * (0.5 + rand() * 0.5), 6, radius * 0.02), alongZ(p, bend), { edgeMin: 0.6 });
  }
  const sparks: THREE.Object3D[] = [];
  const count = 7 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r0 = radius * (0.15 + rand() * 0.45);
    const start = side.clone().multiplyScalar(Math.cos(a) * r0).addScaledVector(side2, Math.sin(a) * r0).addScaledVector(d, -radius * 0.1);
    const out = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(side2, Math.sin(a));
    const len = radius * (0.5 + rand() * 1.1);
    const pts = [start];
    for (let k = 1; k <= 4; k++) {
      const t = k / 4;
      pts.push(start.clone()
        .addScaledVector(d, len * t)
        .addScaledVector(out, len * t * t * (0.4 + rand() * 0.8))
        .addScaledVector(side, (rand() - 0.5) * radius * 0.25));
    }
    const wr = radius * (0.025 + rand() * 0.02);
    fb.add('wire', tube(pts, wr, 5, 3), undefined, { color: WIRE_COLORS[i % WIRE_COLORS.length], variant: 0 });
    // Bare copper strands at the torn end.
    const tip = pts[pts.length - 1];
    const tipDir = tip.clone().sub(pts[pts.length - 2]).normalize();
    fb.add('wire', cylinder(wr * 0.6, 0, wr * 5, 5, wr * 0.2), alongZ(tip, tipDir), { color: '#d9823f', variant: 1 });
    if (i % 2 === 0) {
      const marker = new THREE.Object3D();
      marker.position.copy(tip).addScaledVector(tipDir, wr * 5);
      marker.name = `${name}:spark${i}`;
      fb.object(marker);
      sparks.push(marker);
    }
  }
  const obj = newObjState(0.5);
  obj.glow = 0;
  const built = fb.finalize(mats, obj);
  return { group: built.group, obj, sparks };
}
