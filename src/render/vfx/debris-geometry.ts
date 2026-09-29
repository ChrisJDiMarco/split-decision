// Low-poly hard-surface debris: hex bolts, nuts, jagged armor shards, bent plate and
// tiny chips. Each builder also returns support points (the hull extremes) that the
// rigid-body solver uses for floor contact, so a bolt settles on its side instead of
// standing on end.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Rng } from './coords';

export interface DebrisShape {
  geometry: THREE.BufferGeometry;
  support: THREE.Vector3[];
  radius: number; // bounding sphere radius
  massKg: number;
}

/** Steel density used to size fragment mass. */
const STEEL_KG_M3 = 7850;

/** 26 directions of a k-DOP; the most extreme vertex along each is a support point. */
const KDOP_DIRS: THREE.Vector3[] = (() => {
  const out: THREE.Vector3[] = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (x || y || z) out.push(new THREE.Vector3(x, y, z).normalize());
  }
  return out;
})();

export function supportPoints(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const pos = geometry.getAttribute('position');
  const v = new THREE.Vector3();
  const picked = new Map<string, THREE.Vector3>();
  for (const d of KDOP_DIRS) {
    let best = -Infinity;
    let bestIdx = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const s = v.dot(d);
      if (s > best) { best = s; bestIdx = i; }
    }
    v.fromBufferAttribute(pos, bestIdx);
    picked.set(`${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`, v.clone());
  }
  return [...picked.values()];
}

function finish(geometry: THREE.BufferGeometry, volumeM3: number): DebrisShape {
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return {
    geometry,
    support: supportPoints(geometry),
    radius: geometry.boundingSphere!.radius,
    massKg: volumeM3 * STEEL_KG_M3,
  };
}

/** M20-class hex bolt: hex head, washer face, shank. Long axis along +y. */
export function boltShape(length = 0.075, shankR = 0.01): DebrisShape {
  const headR = shankR * 1.75;
  const headH = shankR * 1.3;
  const head = new THREE.CylinderGeometry(headR, headR, headH, 6, 1).toNonIndexed();
  head.translate(0, length / 2 + headH / 2, 0);
  const washer = new THREE.CylinderGeometry(headR * 0.92, headR * 0.92, headH * 0.18, 16, 1).toNonIndexed();
  washer.translate(0, length / 2 + headH * 0.02, 0);
  const shank = new THREE.CylinderGeometry(shankR, shankR * 0.96, length, 10, 1).toNonIndexed();
  const g = mergeGeometries([head, washer, shank])!;
  head.dispose(); washer.dispose(); shank.dispose();
  g.center();
  const volume = Math.PI * shankR * shankR * length + 2.6 * headR * headR * headH;
  return finish(g, volume);
}

/** Hex nut. */
export function nutShape(r = 0.017): DebrisShape {
  const g = new THREE.CylinderGeometry(r, r, r * 0.85, 6, 1).toNonIndexed();
  return finish(g, 2.6 * r * r * r * 0.85 * 0.8);
}

/** A jagged irregular fragment: a box whose corners are pulled around at random. */
export function shardShape(rng: Rng, size: THREE.Vector3): DebrisShape {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z, 1, 1, 1);
  const pos = g.getAttribute('position');
  const jitter = new Map<string, THREE.Vector3>();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${Math.sign(v.x)},${Math.sign(v.y)},${Math.sign(v.z)}`;
    if (!jitter.has(key)) {
      jitter.set(key, new THREE.Vector3(
        (rng() - 0.5) * size.x * 0.7,
        (rng() - 0.5) * size.y * 0.6,
        (rng() - 0.5) * size.z * 0.7,
      ));
    }
    v.add(jitter.get(key)!);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.toNonIndexed();
  g.dispose();
  flat.center();
  return finish(flat, size.x * size.y * size.z * 0.55);
}

/** A torn, slightly bent piece of armor plate. */
export function plateShape(rng: Rng, w: number, d: number, t: number): DebrisShape {
  const g = new THREE.BoxGeometry(w, t, d, 4, 1, 3);
  const pos = g.getAttribute('position');
  const bend = (rng() - 0.5) * 3;
  const tear = rng() * 0.4 + 0.2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = pos.getY(i) + bend * x * x + Math.sin(z * 40 + x * 13) * t * 0.3;
    // Torn edge: pull one edge's vertices in by a ragged amount.
    const ragged = z > 0 ? 1 - tear * (0.5 + 0.5 * Math.sin(x * 97)) : 1;
    pos.setXYZ(i, x, y, z * ragged);
  }
  const flat = g.toNonIndexed();
  g.dispose();
  flat.center();
  return finish(flat, w * d * t * 0.8);
}
