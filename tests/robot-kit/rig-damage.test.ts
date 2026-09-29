import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { RobotTelemetry } from '../../src/core/protocol';
import { anchorPointsWorld, applyImpact, setPartState, sparkPoints, updateRobotKit } from '../../src/render/robot-kit';
import { jointAngles } from '../../src/render/robot-kit/rig/joints';
import type { PistonLinkage } from '../../src/render/robot-kit/types';
import { buildTestRobot, poseRobot } from './helpers';

// Building a full robot is heavy (7 designs, ~100k triangles each); allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

const DEG = Math.PI / 180;

function telemetry(r: ReturnType<typeof buildTestRobot>, over: Partial<RobotTelemetry> = {}): RobotTelemetry {
  const parts = [...r.view.parts.values()].map((k) => ({ id: k.id, hp: k.state.hp, smoke: 0, heat: k.state.heat, attached: k.state.attached, leak: 0 }));
  return {
    corner: r.view.corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
    battery: 1, gyroHealth: 1, gyroSaturation: 0, hydraulicPressure: {}, skill: 'idle', skillPhase: 0, windup: 0,
    parts, joints: [], damageTotal: 0, intent: null, ...over,
  };
}

/** Deterministic joint angles inside each joint's range. */
function randomPose(r: ReturnType<typeof buildTestRobot>, seed: number): Record<string, number> {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const q: Record<string, number> = {};
  for (const p of r.design.parts) for (const j of p.joints ?? []) {
    const [lo, hi] = j.rangeDeg;
    q[j.name] = (lo + (hi - lo) * (0.15 + 0.7 * rand())) * DEG;
  }
  return q;
}

describe('joint frames', () => {
  test('joint angles are recovered from body poses for every jointed part', () => {
    const r = buildTestRobot('bruiser');
    for (const seed of [1, 7, 42]) {
      const q = randomPose(r, seed);
      poseRobot(r, q);
      for (const kit of r.view.parts.values()) {
        const parent = kit.def.parent ? r.byPart.get(kit.def.parent) : null;
        if (!parent || !kit.def.joints?.length) continue;
        const out: number[] = [];
        jointAngles(kit.chain, parent.quaternion, kit.attached.quaternion, out);
        kit.def.joints.forEach((j, i) => expect(out[i], `${kit.id}/${j.name}`).toBeCloseTo(q[j.name], 4));
      }
    }
  });

  test('each stator frame turns with the joints before it, so the last frame + last joint = the body', () => {
    const r = buildTestRobot('goliath');
    poseRobot(r, randomPose(r, 3));
    updateRobotKit([r.view], null, 1 / 60);
    r.root.updateMatrixWorld(true);
    for (const kit of r.view.parts.values()) {
      if (kit.frames.length < 2) continue;
      const last = kit.frames[kit.frames.length - 1];
      const j = kit.def.joints![kit.frames.length - 1];
      const out: number[] = [];
      const parent = r.byPart.get(kit.def.parent!)!;
      jointAngles(kit.chain, parent.quaternion, kit.attached.quaternion, out);
      const q = last.group.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...j.axis), out[kit.frames.length - 1]));
      const body = kit.attached.getWorldQuaternion(new THREE.Quaternion());
      expect(Math.abs(q.dot(body)), kit.id).toBeGreaterThan(0.99999);
    }
  });

  test('hydraulic elbow pistons stay pinned to both bodies and extend as the elbow flexes', () => {
    const r = buildTestRobot('bruiser');
    const piston = r.view.linkages.find((l): l is PistonLinkage => l.kind === 'piston' && l.child === 'forearm_l');
    expect(piston).toBeDefined();
    const span = (elbow: number) => {
      poseRobot(r, { ...r.design.stance, elbow_l: elbow });
      updateRobotKit([r.view], null, 1 / 60);
      r.root.updateMatrixWorld(true);
      const eye = piston!.rod.getWorldPosition(new THREE.Vector3());
      const expected = piston!.anchorChild.clone().applyMatrix4(r.byPart.get('forearm_l')!.matrixWorld);
      expect(eye.distanceTo(expected)).toBeLessThan(1e-4);
      const pivot = piston!.barrel.getWorldPosition(new THREE.Vector3());
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(piston!.barrel.getWorldQuaternion(new THREE.Quaternion()));
      expect(axis.dot(eye.clone().sub(pivot).normalize())).toBeGreaterThan(0.9999);
      return pivot.distanceTo(eye);
    };
    const straight = span(-5 * DEG);
    const flexed = span(-140 * DEG);
    expect(flexed - straight).toBeGreaterThan(0.08);
    expect(piston!.barrelLength).toBeLessThanOrEqual(straight);
  });
});

test('hydraulic knees get twin pistons, electric knees get a drum', () => {
  const bruiser = buildTestRobot('bruiser');
  const striker = buildTestRobot('striker');
  const kneePistons = (r: ReturnType<typeof buildTestRobot>) => r.view.linkages.filter((l) => l.kind === 'piston' && l.child.startsWith('shin_')).length;
  expect(kneePistons(bruiser)).toBe(4);
  expect(kneePistons(striker)).toBe(0);
  // The ankle fork sits at the ankle joint even though the shin capsule stops short of it.
  const shin = bruiser.design.parts.find((p) => p.id === 'shin_l')!;
  const foot = bruiser.design.parts.find((p) => p.id === 'foot_l')!;
  expect(-foot.pos[2]).toBeGreaterThan(Math.abs((shin.geoms[0].shape as { to: number[] }).to[2]));
});

describe('damage visuals', () => {
  test('an impact dents the armor inward around the hit and scuffs it, leaving far vertices alone', () => {
    const r = buildTestRobot('bruiser');
    poseRobot(r);
    const torso = r.view.parts.get('torso')!;
    const paint = torso.meshes.find((m) => m.userData.slot === 'paint')!;
    const pos = paint.geometry.getAttribute('position');
    const before = Float32Array.from(pos.array as Float32Array);
    // Hit the chest plate head-on: pick the most forward paint vertex.
    let best = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getX(i) > pos.getX(best)) best = i;
    const local = new THREE.Vector3().fromBufferAttribute(pos, best);
    const world = local.clone().applyMatrix4(paint.matrixWorld);
    const normal = new THREE.Vector3(1, 0, 0).transformDirection(torso.attached.matrixWorld);
    applyImpact(r.view, 'torso', world, normal, 400);
    const after = pos.array as Float32Array;
    let moved = 0;
    let maxIn = 0;
    let farMoved = 0;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(after[i * 3] - before[i * 3], after[i * 3 + 1] - before[i * 3 + 1], after[i * 3 + 2] - before[i * 3 + 2]);
      const dist = new THREE.Vector3(before[i * 3], before[i * 3 + 1], before[i * 3 + 2]).distanceTo(local);
      if (dist > 0.2) farMoved = Math.max(farMoved, d);
      if (d > 1e-5) moved++;
      maxIn = Math.max(maxIn, before[i * 3] - after[i * 3]); // pushed back along -x
    }
    expect(moved).toBeGreaterThan(10);
    expect(maxIn).toBeGreaterThan(0.004);
    expect(maxIn).toBeLessThan(0.04);
    expect(farMoved).toBe(0);
    const dmg = paint.geometry.getAttribute('aDamage');
    expect(dmg.getX(best)).toBeGreaterThan(0.5);
    expect(dmg.getY(best)).toBeGreaterThan(0.5);
  });

  test('softer armor dents deeper for the same energy', () => {
    const depth = (id: string, part: string) => {
      const r = buildTestRobot(id);
      poseRobot(r);
      const kit = r.view.parts.get(part)!;
      const m = kit.meshes.find((x) => x.userData.slot === 'paint')!;
      const pos = m.geometry.getAttribute('position');
      const before = Float32Array.from(pos.array as Float32Array);
      const p = new THREE.Vector3().fromBufferAttribute(pos, 0).applyMatrix4(m.matrixWorld);
      applyImpact(r.view, part, p, new THREE.Vector3(0, 1, 0), 300);
      let max = 0;
      const a = pos.array as Float32Array;
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - before[i]));
      return max;
    };
    // Striker's torso is titanium (Brinell 334), Bruiser's is AR500 (Brinell 500).
    expect(depth('striker', 'torso')).toBeGreaterThan(depth('bruiser', 'torso'));
  });

  test('knocking the head off swaps in the detailed debris head and leaves a sparking neck stump', () => {
    const r = buildTestRobot('bruiser');
    poseRobot(r);
    const head = r.view.parts.get('head')!;
    expect(head.debris?.visible).toBe(false);
    setPartState(r.view, 'head', { attached: false });
    expect(head.content.visible).toBe(false);
    expect(head.debris?.visible).toBe(true);
    expect(head.stump).not.toBeNull();
    expect(head.stump!.parent).toBe(head.frames[0].group);
    expect(sparkPoints(r.view).length).toBeGreaterThan(2);
    // Debris carries the full head mesh (shared geometry) plus torn wiring underneath.
    const debrisMeshes: THREE.Mesh[] = [];
    head.debris!.traverse((o) => { if ((o as THREE.Mesh).isMesh) debrisMeshes.push(o as THREE.Mesh); });
    for (const m of head.meshes) expect(debrisMeshes.some((d) => d.geometry === m.geometry)).toBe(true);
    expect(head.debris!.getObjectByName('head:torn')).toBeDefined();
    const stumpGeos = new Set<THREE.BufferGeometry>();
    head.stump!.traverse((o) => { if ((o as THREE.Mesh).isMesh) stumpGeos.add((o as THREE.Mesh).geometry); });
    let disposed = 0;
    for (const g of stumpGeos) g.addEventListener('dispose', () => { disposed++; });
    setPartState(r.view, 'head', { attached: true });
    expect(head.content.visible).toBe(true);
    expect(head.debris?.visible).toBe(false);
    expect(head.stump).toBeNull();
    expect(disposed).toBe(stumpGeos.size); // the torn socket's geometry is freed, not leaked
  });

  test('a part carried off on its parent\'s debris just hides; it leaves no stump of its own', () => {
    const r = buildTestRobot('bruiser');
    poseRobot(r);
    const fist = r.view.parts.get('fist_l')!;
    expect(fist.debris).toBeNull();
    setPartState(r.view, 'fist_l', { attached: false });
    expect(fist.content.visible).toBe(false);
    expect(fist.stump).toBeNull();
    expect(fist.sparkPoints.length).toBe(0);
  });

  test('telemetry drives detach, dying optics, gyro glow and hot joints', () => {
    const r = buildTestRobot('goliath');
    poseRobot(r);
    const dt = 1 / 60;
    for (let i = 0; i < 120; i++) updateRobotKit([r.view], [telemetry(r, { gyroSaturation: 1, joints: [{ name: 'knee_l', health: 1, state: 'ok', tempC: 125, torqueFrac: 1 }] })], dt);
    expect(r.view.gyroSaturation).toBeGreaterThan(0.95);
    expect(r.view.parts.get('torso')!.obj.core).toBeGreaterThan(1);
    const knee = r.view.parts.get('shin_l')!.frames[0];
    expect(knee.obj.heat).toBeGreaterThan(0.9);
    const t = telemetry(r);
    t.parts = t.parts.map((p) => (p.id === 'head' ? { ...p, attached: false, hp: 0 } : p));
    updateRobotKit([r.view], [t], dt);
    const head = r.view.parts.get('head')!;
    expect(head.state.attached).toBe(false);
    expect(head.debrisObj!.glow).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 3; i++) updateRobotKit([r.view], [t], dt);
    expect(head.debrisObj!.glow).toBe(0);
  });

  test('armor glows on the joint housings\' temperature ramp, not at ordinary working temperatures', () => {
    // Bruiser's thighs hang off 90 °C hydraulic hip cylinders; physics reports heat = tempC / maxTempC.
    const r = buildTestRobot('bruiser');
    poseRobot(r);
    const thigh = r.view.parts.get('thigh_l')!;
    const hipJoints = thigh.def.joints!.map((j) => j.name);
    const at = (tempC: number) => {
      const t = telemetry(r, { joints: hipJoints.map((name) => ({ name, health: 1, state: 'ok' as const, tempC, torqueFrac: 0.3 })) });
      t.parts = t.parts.map((p) => (p.id === 'thigh_l' ? { ...p, heat: tempC / 90 } : p));
      updateRobotKit([r.view], [t], 1 / 60);
      return thigh.obj.heat;
    };
    expect(at(28)).toBe(0); // ambient
    expect(at(60)).toBeLessThan(0.2); // normal hard work: no visible glow (the shader starts at 0.35)
    expect(at(90)).toBeGreaterThan(0.95); // at the rating: fully hot
    expect(thigh.obj.heat).toBeCloseTo(thigh.frames[0].obj.heat, 2); // same ramp as its hip housing
  });

  test('heat and wear reach the shader state of both the part and its debris twin', () => {
    const r = buildTestRobot('striker');
    setPartState(r.view, 'head', { heat: 0.8, hp: 0.25 });
    const head = r.view.parts.get('head')!;
    expect(head.obj.heat).toBe(0.8);
    expect(head.debrisObj!.heat).toBe(0.8);
    expect(head.obj.wear).toBeCloseTo(0.75);
    const paint = head.meshes.find((m) => m.userData.slot === 'paint')!;
    expect(paint.userData.kit).toBe(head.obj);
  });
});

describe('anchors and joint state', () => {
  test('hydraulic seals and smoke vents are exposed in scene space', () => {
    const r = buildTestRobot('bruiser');
    poseRobot(r);
    const leaks = anchorPointsWorld(r.view, 'leak.');
    expect(leaks.some((a) => a.part === 'forearm_l' && a.name.startsWith('leak.piston'))).toBe(true);
    expect(leaks.some((a) => a.part.startsWith('shin_') && a.name.startsWith('leak.knee'))).toBe(true);
    const vents = anchorPointsWorld(r.view, 'vent');
    const torsoVent = vents.find((a) => a.part === 'torso')!;
    const smoke = r.design.parts.find((p) => p.id === 'torso')!.smokePoint!;
    const expected = new THREE.Vector3(...smoke).applyMatrix4(r.byPart.get('torso')!.matrixWorld);
    expect(torsoVent.pos.distanceTo(expected)).toBeLessThan(1e-6);
  });

  test('a failing joint scuffs its actuator housing', () => {
    const r = buildTestRobot('striker');
    const knee = r.view.parts.get('shin_r')!.frames[0];
    expect(knee.obj.wear).toBe(0);
    updateRobotKit([r.view], [telemetry(r, { joints: [{ name: 'knee_r', health: 0.3, state: 'limp', tempC: 40, torqueFrac: 0.2 }] })], 1 / 60);
    expect(knee.obj.wear).toBeCloseTo(0.7);
    updateRobotKit([r.view], [telemetry(r, { joints: [{ name: 'knee_r', health: 0.6, state: 'seized', tempC: 40, torqueFrac: 0 }] })], 1 / 60);
    expect(knee.obj.wear).toBeCloseTo(0.9);
  });
});

test('a rocket punch fires only the extended piston fist, then it bleeds back', () => {
  const r = buildTestRobot('goliath');
  // Left arm punching: shoulder pitched forward, elbow straight; right arm in guard.
  poseRobot(r, { ...r.design.stance, shoulder_pitch_l: -1.5, elbow_l: -0.1 });
  const rams = r.view.animated.rams;
  expect(rams.map((x) => x.part).sort()).toEqual(['fist_l', 'fist_r']);
  const left = rams.find((x) => x.part === 'fist_l')!;
  const right = rams.find((x) => x.part === 'fist_r')!;
  for (let i = 0; i < 10; i++) updateRobotKit([r.view], [telemetry(r, { skill: 'rocket_punch', skillPhase: 0.5 })], 1 / 60);
  expect(left.object.position.z).toBeCloseTo(-left.travel, 5);
  expect(right.object.position.length()).toBe(0);
  for (let i = 0; i < 60; i++) updateRobotKit([r.view], [telemetry(r, { skill: 'guard', skillPhase: 0 })], 1 / 60);
  expect(left.object.position.length()).toBeLessThan(left.travel * 0.01);
});

test('a hit on the gyro porthole dents the bezel but never buries the glowing core', () => {
  const r = buildTestRobot('bruiser');
  poseRobot(r);
  const torso = r.view.parts.get('torso')!;
  const core = torso.meshes.find((m) => m.userData.slot === 'core')!;
  const before = Float32Array.from(core.geometry.getAttribute('position').array as Float32Array);
  const centre = new THREE.Box3().setFromObject(core).getCenter(new THREE.Vector3());
  applyImpact(r.view, 'torso', centre, new THREE.Vector3(1, 0, 0).transformDirection(torso.attached.matrixWorld), 900);
  expect(Array.from(core.geometry.getAttribute('position').array as Float32Array)).toEqual(Array.from(before));
  const mech = torso.meshes.find((m) => m.userData.slot === 'mech')!;
  expect((mech.geometry.getAttribute('aDamage').array as Float32Array).some((v) => v > 0)).toBe(true);
});

test('the gyro core is visible through the porthole on every gyro design', () => {
  for (const id of ['bruiser', 'striker', 'goliath']) {
    const r = buildTestRobot(id);
    poseRobot(r);
    const torso = r.view.parts.get('torso')!;
    const core = torso.meshes.find((m) => m.userData.slot === 'core')!;
    torso.content.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(core);
    const c = box.getCenter(new THREE.Vector3());
    const R = box.getSize(new THREE.Vector3()).y / 2;
    // Look in along -x on a ring of rays; bars and rotor fins block some, the glow shows through most.
    const RAYS = 24;
    let seen = 0;
    for (let k = 0; k < RAYS; k++) {
      const a = (k / RAYS) * Math.PI * 2;
      const origin = new THREE.Vector3(c.x + 1, c.y + Math.cos(a) * R * 0.55, c.z + Math.sin(a) * R * 0.55);
      const hits = new THREE.Raycaster(origin, new THREE.Vector3(-1, 0, 0)).intersectObject(torso.content, true);
      if (hits[0]?.object.userData.slot === 'core') seen++;
    }
    expect(seen / RAYS, id).toBeGreaterThan(0.5);
  }
});

test('optics sit in front of their lenses so the eyes actually glow', () => {
  for (const id of ['bruiser', 'striker', 'goliath']) {
    const r = buildTestRobot(id);
    const head = r.view.parts.get('head')!;
    const glow = head.meshes.find((m) => m.userData.slot === 'glow')!;
    const lens = head.meshes.find((m) => m.userData.slot === 'lens')!;
    glow.geometry.computeBoundingBox();
    lens.geometry.computeBoundingBox();
    expect(glow.geometry.boundingBox!.max.x, id).toBeGreaterThan(lens.geometry.boundingBox!.max.x);
  }
});
