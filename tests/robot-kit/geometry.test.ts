import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { DESIGNS } from '../../src/robots/designs';
import { SKIN_IDS } from '../../src/render/robot-kit';
import { FrameBuilder, newObjState } from '../../src/render/robot-kit/geom/part-builder';
import { box, collar, drum, polyPrism, shell, tube } from '../../src/render/robot-kit/geom/prims';
import { MIRROR_Y } from '../../src/render/robot-kit/geom/xf';
import type { KitMaterials } from '../../src/render/robot-kit/types';
import { partDims } from '../../src/render/robot-kit/recipes/context';
import { registeredRecipes } from '../../src/render/robot-kit/recipes/registry';
import { buildTestRobot, meshBox } from './helpers';

// Building a full robot is heavy (7 designs, ~100k triangles each); allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

const ENVELOPE_TOLERANCE = 0.15; // fraction of the collision size on each side
const MIN_TOLERANCE_M = 0.012; // bevels and bolt heads on very thin parts
const TRIANGLE_BUDGET = 150_000;

function windingAgreement(geo: THREE.BufferGeometry): number {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const idx = geo.index!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), f = new THREE.Vector3();
  let good = 0;
  let total = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const [ia, ib, ic] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    f.subVectors(b, a).cross(c.clone().sub(a));
    if (f.lengthSq() < 1e-16) continue; // degenerate sliver
    n.fromBufferAttribute(nor, ia).add(new THREE.Vector3().fromBufferAttribute(nor, ib)).add(new THREE.Vector3().fromBufferAttribute(nor, ic));
    total++;
    if (f.dot(n) > 0) good++;
  }
  return good / Math.max(1, total);
}

function dummyMaterials(): KitMaterials {
  const m = new THREE.MeshBasicMaterial();
  return { paint: m, trim: m, glove: m, frame: m, mech: m, chrome: m, rubber: m, glow: m, lens: m, core: m, wire: m };
}

function outwardFraction(geo: THREE.BufferGeometry, centre: THREE.Vector3): number {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  let out = 0;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).sub(centre);
    n.fromBufferAttribute(nor, i);
    if (p.lengthSq() < 1e-10 || p.dot(n) >= -1e-6) out++;
  }
  return out / pos.count;
}

describe('primitives', () => {
  test('chamfered box normals point outward and contain no NaN', () => {
    const g = box(0.3, 0.2, 0.1, { bevel: 0.01 });
    const arr = g.getAttribute('position').array as Float32Array;
    expect(arr.every((v) => Number.isFinite(v))).toBe(true);
    expect(outwardFraction(g, new THREE.Vector3())).toBe(1);
    g.computeBoundingBox();
    const s = g.boundingBox!.getSize(new THREE.Vector3());
    expect(s.x).toBeCloseTo(0.3, 4);
    expect(s.y).toBeCloseTo(0.2, 4);
    expect(s.z).toBeCloseTo(0.1, 4);
  });

  test('triangle winding agrees with vertex normals on every primitive', () => {
    const fb = new FrameBuilder('t', 1);
    fb.add('mech', drum(0.08, 0.06, { fins: 3 }));
    fb.add('paint', shell(0.1, 0.115, -0.5, 1.2, -0.2, 0.1, { taper: 0.8 }));
    fb.add('paint', box(0.2, 0.1, 0.3, { round: true, taper: 0.7 }));
    fb.add('frame', polyPrism([[0.1, -0.05], [0.1, 0.05], [-0.05, 0.08], [-0.1, 0], [-0.05, -0.08]], 0, 0.2, { bevel: 0.01 }));
    fb.add('mech', collar(0.03, 0.05, -0.01, 0.02));
    fb.add('rubber', tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.1, 0.05, 0.1), new THREE.Vector3(0.2, 0, 0.3)], 0.01));
    fb.add('paint', box(0.2, 0.1, 0.3), MIRROR_Y); // mirrored placement must flip the winding back
    const built = fb.finalize(dummyMaterials(), newObjState(0));
    for (const mesh of built.meshes) expect(windingAgreement(mesh.geometry), mesh.name).toBeGreaterThan(0.995);
  });
});

describe('robot kit builds', () => {
  test('every humanoid kit id the designs use has a recipe', () => {
    const recipes = new Set(registeredRecipes());
    for (const d of Object.values(DESIGNS)) for (const p of d.parts) expect(recipes.has(p.visual.kit), `${d.id}/${p.id} → ${p.visual.kit}`).toBe(true);
  });

  for (const id of Object.keys(DESIGNS)) {
    test(`${id}: under ${TRIANGLE_BUDGET / 1000}k triangles per robot`, () => {
      const r = buildTestRobot(id);
      expect(r.view.triangles).toBeLessThan(TRIANGLE_BUDGET);
      expect(r.view.triangles).toBeGreaterThan(60_000);
    });

    test(`${id}: every part's visual stays within ±15% of its collision envelope`, () => {
      const r = buildTestRobot(id);
      for (const kit of r.view.parts.values()) {
        const d = partDims(kit.def);
        const allowed = new THREE.Box3(d.min.clone(), d.max.clone());
        // The joint region sits inside the parent's collision (its capsule end cap or box).
        const parent = r.design.parts.find((p) => p.id === kit.def.parent);
        if (parent) {
          const pd = partDims(parent);
          const cover = pd.radius > 0 ? pd.radius : Math.min(pd.size.x, pd.size.y, pd.size.z) / 2;
          allowed.union(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(cover, cover, cover).multiplyScalar(2)));
        }
        const size = allowed.getSize(new THREE.Vector3());
        const tol = new THREE.Vector3(
          Math.max(size.x * ENVELOPE_TOLERANCE, MIN_TOLERANCE_M),
          Math.max(size.y * ENVELOPE_TOLERANCE, MIN_TOLERANCE_M),
          Math.max(size.z * ENVELOPE_TOLERANCE, MIN_TOLERANCE_M),
        );
        const visual = meshBox(kit.content, ['chrome']);
        const label = `${id}/${kit.id}`;
        for (const a of ['x', 'y', 'z'] as const) {
          expect(visual.min[a], `${label} min.${a}`).toBeGreaterThanOrEqual(allowed.min[a] - tol[a]);
          expect(visual.max[a], `${label} max.${a}`).toBeLessThanOrEqual(allowed.max[a] + tol[a]);
          // Not a toy either: the visual fills most of the collision shape.
          expect(visual.max[a] - visual.min[a], `${label} size.${a}`).toBeGreaterThan(d.size[a] * 0.6);
        }
      }
    });
  }

  test('every skin builds for a design', () => {
    for (const skin of SKIN_IDS) {
      const r = buildTestRobot('bruiser', skin);
      expect(r.view.materials.paint.name).toContain(skin);
      r.view.dispose();
    }
  });
});
