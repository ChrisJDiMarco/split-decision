import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { DESIGNS } from '../../src/robots/designs';
import { SKIN_IDS, applyImpact, setPartState } from '../../src/render/robot-kit';
import { designLook } from '../../src/render/robot-kit/look';
import { skinFor } from '../../src/render/robot-kit/materials';
import { buildTestRobot, meshBox, poseRobot } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'];
const MODERN_TRIANGLE_BUDGET = 120_000;

/** Every mesh slot used under a part's own content. */
function slots(root: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.add(o.userData.slot as string);
  });
  return out;
}

describe('modern electric roster', () => {
  test('the four modern designs exist and use their own kit recipes', () => {
    const expected: Record<string, Record<string, string>> = {
      firecracker: { head: 'head.trio', torso: 'torso.pebble', fist_l: 'fist.glove', foot_l: 'leg.foot.round' },
      savate: { head: 'head.wedge', torso: 'torso.diamond', fist_l: 'fist.knuckle', shin_l: 'leg.shin.guard' },
      haymaker: { head: 'head.hammer', torso: 'torso.cowl', fist_l: 'fist.glove' },
      pylon: { head: 'head.lozenge', torso: 'torso.slim', fist_l: 'fist.knuckle' },
    };
    for (const id of MODERN) {
      const d = DESIGNS[id];
      expect(d, id).toBeDefined();
      for (const [part, kit] of Object.entries(expected[id])) expect(d.parts.find((p) => p.id === part)?.visual.kit, `${id}/${part}`).toBe(kit);
      expect(designLook(d).limbs, id).not.toBe('iron');
    }
  });

  for (const id of MODERN) {
    test(`${id}: under ${MODERN_TRIANGLE_BUDGET / 1000}k triangles, built in livery by default`, () => {
      const r = buildTestRobot(id, DESIGNS[id].defaultSkin);
      expect(DESIGNS[id].defaultSkin).toBe('livery');
      expect(r.view.triangles).toBeLessThan(MODERN_TRIANGLE_BUDGET);
      expect(r.view.triangles).toBeGreaterThan(50_000);
      // Fasteners are instanced, never merged into the part meshes.
      let instanced = 0;
      r.root.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) instanced += (o as THREE.InstancedMesh).count;
      });
      expect(instanced).toBeGreaterThan(0);
      r.view.dispose();
    });
  }

  test('the livery paints each design from its own palette', () => {
    for (const id of MODERN) {
      const d = DESIGNS[id];
      const skin = skinFor('livery', d);
      expect(skin.paint.color.toLowerCase(), id).toBe(d.palette!.primary.toLowerCase());
      expect(skin.frame.color.toLowerCase(), id).toBe(d.palette!.secondary.toLowerCase());
      expect(skin.trim.color.toLowerCase(), id).toBe(d.palette!.accent.toLowerCase());
    }
    // Different finishes give different paint roughness.
    expect(skinFor('livery', DESIGNS.firecracker).paint.rough).toBeLessThan(skinFor('livery', DESIGNS.haymaker).paint.rough);
  });

  test('gloved designs wear leather gloves and headgear; bare-fisted designs do not', () => {
    const fire = buildTestRobot('firecracker');
    expect(slots(fire.view.parts.get('fist_l')!.content).has('glove')).toBe(true);
    expect(slots(fire.view.parts.get('head')!.content).has('glove')).toBe(true); // padded headgear
    expect(slots(fire.view.parts.get('fist_l')!.content).has('trim')).toBe(true); // white cuffs
    const hay = buildTestRobot('haymaker');
    expect(slots(hay.view.parts.get('fist_r')!.content).has('glove')).toBe(true);
    const sav = buildTestRobot('savate');
    expect(slots(sav.view.parts.get('fist_l')!.content).has('glove')).toBe(false);
    expect(slots(sav.view.parts.get('shin_l')!.content).has('trim')).toBe(true); // bone foam guards
  });

  test('every skin builds on a modern design', () => {
    for (const skin of SKIN_IDS) {
      const r = buildTestRobot('pylon', skin);
      expect(r.view.materials.paint.name).toContain(skin);
      expect(r.view.materials.trim.name).toContain(skin);
      r.view.dispose();
    }
  });

  test('a glove dents and scuffs like armour', () => {
    const r = buildTestRobot('firecracker');
    poseRobot(r);
    const fist = r.view.parts.get('fist_l')!;
    const glove = fist.meshes.find((m) => m.userData.slot === 'glove')!;
    const pos = glove.geometry.getAttribute('position');
    const before = Float32Array.from(pos.array as Float32Array);
    const world = new THREE.Vector3().fromBufferAttribute(pos, Math.floor(pos.count / 3)).applyMatrix4(glove.matrixWorld);
    const centre = new THREE.Box3().setFromObject(glove).getCenter(new THREE.Vector3());
    applyImpact(r.view, 'fist_l', world, world.clone().sub(centre).normalize(), 300);
    let moved = 0;
    for (let k = 0; k < before.length; k++) if (Math.abs(before[k] - (pos.array as Float32Array)[k]) > 1e-5) moved++;
    expect(moved).toBeGreaterThan(0);
    const dmg = glove.geometry.getAttribute('aDamage');
    let scuffed = 0;
    for (let k = 0; k < dmg.count; k++) if (dmg.getX(k) > 0) scuffed++;
    expect(scuffed).toBeGreaterThan(0);
  });

  for (const id of MODERN) {
    test(`${id}: a knocked-off head flies whole and leaves a neck stump`, () => {
      const r = buildTestRobot(id);
      poseRobot(r);
      const head = r.view.parts.get('head')!;
      const tris = (root: THREE.Object3D) => {
        let n = 0;
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) n += (m.geometry.index?.count ?? 0) / 3;
        });
        return n;
      };
      expect(head.debris).not.toBeNull();
      setPartState(r.view, 'head', { attached: false });
      expect(head.debris!.visible).toBe(true);
      expect(head.content.visible).toBe(false);
      // The debris twin carries the full head: same slots, same geometry.
      expect(slots(head.debrisContent!)).toEqual(slots(head.content));
      expect(tris(head.debrisContent!)).toBe(tris(head.content));
      expect(meshBox(head.debrisContent!).isEmpty()).toBe(false);
      expect(head.stump).not.toBeNull();
      expect(head.sparkPoints.length).toBeGreaterThan(0);
    });
  }

  test('optics are not buried: a ray from in front reaches the foremost glow on each head first', () => {
    for (const id of MODERN) {
      const r = buildTestRobot(id);
      const head = r.view.parts.get('head')!;
      head.content.updateMatrixWorld(true);
      const glow = head.meshes.find((m) => m.userData.slot === 'glow')!;
      expect(glow, id).toBeDefined();
      const pos = glow.geometry.getAttribute('position');
      let best = 0;
      for (let i = 0; i < pos.count; i++) if (pos.getX(i) > pos.getX(best)) best = i;
      const p = new THREE.Vector3().fromBufferAttribute(pos, best);
      const origin = p.clone().add(new THREE.Vector3(1, 0, 0)).applyMatrix4(head.content.matrixWorld);
      const dir = new THREE.Vector3(-1, 0, 0).transformDirection(head.content.matrixWorld);
      const hits = new THREE.Raycaster(origin, dir).intersectObject(head.content, true);
      expect(hits[0]?.object.userData.slot, id).toBe('glow');
    }
  });
});
