// Eyes, head lights and hand loadouts in the robot kit: moving optics follow the gaze with
// saccades, moods (lock-on, hit flash, damage, KO, battery) drive the optics within the glare
// cap, and every hands loadout builds inside the triangle budget with fingers that follow poses.
import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { RobotTelemetry } from '../../src/core/protocol';
import type { HandsOption, RobotDesign } from '../../src/core/types';
import { DESIGNS } from '../../src/robots/designs';
import { applyLoadout } from '../../src/robots/loadout';
import { HAND_POSES, applyImpact, derivedHands, handPoseAngles, updateRobotKit } from '../../src/render/robot-kit';
import type { EyeElement, RobotKitView } from '../../src/render/robot-kit/types';
import { buildTestRobot, poseRobot, type TestRobot } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

const ALL = Object.keys(DESIGNS);
const MODERN_BUDGET = 120_000;
const IRON_BUDGET = 150_000;
const GLOW_CAP = 1.4;
const DT = 1 / 60;

function tel(corner: 0 | 1, o: Partial<RobotTelemetry> = {}): RobotTelemetry {
  return {
    corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
    battery: 1, gyroHealth: 1, gyroSaturation: 0, hydraulicPressure: {}, skill: 'stance', skillPhase: 0, windup: 0,
    parts: [], joints: [], damageTotal: 0, intent: null, ...o,
  };
}

function run(views: RobotKitView[], t: RobotTelemetry[] | null, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) updateRobotKit(views, t, DT);
}

/** A physics-space point `ahead` metres in front of the head and `left` to its left. */
function pointFromHead(r: TestRobot, ahead: number, left: number, up = 0): [number, number, number] {
  const head = r.view.parts.get('head')!.attached;
  const p = new THREE.Vector3(ahead, left, up).applyQuaternion(head.quaternion).add(head.position);
  return [p.x, p.y, p.z + 0.1];
}

function offset(el: EyeElement): number {
  return el.object.position.clone().sub(el.rest).dot(el.u);
}

function slots(root: THREE.Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.add(o.userData.slot as string);
  });
  return out;
}

function withHands(id: string, hands: HandsOption): RobotDesign {
  return applyLoadout(DESIGNS[id], { design: id, hands });
}

describe('eyes and head lights', () => {
  test('every head carries moving optics inside its own content', () => {
    for (const id of ALL) {
      const r = buildTestRobot(id);
      const head = r.view.parts.get('head')!;
      const els = r.view.animated.eyes.filter((e) => e.part === 'head');
      expect(els.length, id).toBeGreaterThan(0);
      for (const el of els) {
        let o: THREE.Object3D | null = el.object;
        while (o && o !== head.content) o = o.parent;
        expect(o, `${id}: ${el.kind} under the head`).toBe(head.content);
      }
      r.view.dispose();
    }
  });

  test('optics follow the gaze left and right (pupils slide, slit hotspots run)', () => {
    for (const id of ALL) {
      const r = buildTestRobot(id);
      poseRobot(r);
      const lateral = r.view.animated.eyes.filter((e) => e.kind !== 'beacon' && Math.abs(e.u.y) > 0.6);
      const vertical = r.view.animated.eyes.filter((e) => e.kind === 'slider' && Math.abs(e.u.z) > 0.6);
      expect(lateral.length + vertical.length, id).toBeGreaterThan(0);
      r.view.eyes.override.gaze = { point: pointFromHead(r, 2, 1.1), mode: 'track' };
      run([r.view], null, 1);
      expect(r.view.eyes.yaw, id).toBeGreaterThan(0.3);
      for (const el of lateral) expect(offset(el) * Math.sign(el.u.y), `${id} ${el.kind} left`).toBeGreaterThan(el.travel * 0.3);
      r.view.eyes.override.gaze = { point: pointFromHead(r, 2, -1.1), mode: 'track' };
      run([r.view], null, 1);
      expect(r.view.eyes.yaw, id).toBeLessThan(-0.3);
      for (const el of lateral) expect(offset(el) * Math.sign(el.u.y), `${id} ${el.kind} right`).toBeLessThan(-el.travel * 0.3);
      // A vertical light bar's hotspot climbs when the gaze rises and sinks when it drops.
      if (vertical.length) {
        r.view.eyes.override.gaze = { point: pointFromHead(r, 1.5, 0, 0.9), mode: 'track' };
        run([r.view], null, 1);
        const up = vertical.map((el) => el.object.position.z);
        r.view.eyes.override.gaze = { point: pointFromHead(r, 1.5, 0, -1.1), mode: 'track' };
        run([r.view], null, 1);
        vertical.forEach((el, i) => expect(up[i] - el.object.position.z, `${id} bar`).toBeGreaterThan(el.travel * 0.5));
      }
      r.view.dispose();
    }
  });

  test('saccades: a jump in the target is covered in a snap, not a drift', () => {
    const r = buildTestRobot('firecracker');
    poseRobot(r);
    r.view.eyes.override.gaze = { point: pointFromHead(r, 2, 0), mode: 'track' };
    run([r.view], null, 1.5);
    const start = r.view.eyes.yaw;
    r.view.eyes.override.gaze = { point: pointFromHead(r, 2, 0.9), mode: 'track' };
    run([r.view], null, 0.1);
    const target = r.view.eyes.targetYaw;
    expect(target - start).toBeGreaterThan(0.3);
    expect((r.view.eyes.yaw - start) / (target - start)).toBeGreaterThan(0.85);
  });

  test('with no physics gaze the eyes track the opponent, snap to his windup, look down when down', () => {
    const a = buildTestRobot('savate', 'livery', 0);
    const b = buildTestRobot('haymaker', 'livery', 1);
    poseRobot(a, a.design.stance, [0, 0], 0);
    poseRobot(b, b.design.stance, [1.6, 0.7], Math.PI);
    const views = [a.view, b.view];
    run(views, [tel(0), tel(1)], 1.5);
    expect(a.view.eyes.mode).toBe('track');
    expect(a.view.eyes.yaw).toBeGreaterThan(0.15); // he stands to the left
    run(views, [tel(0), tel(1, { windup: 0.8, skill: 'cross' })], 0.3);
    expect(a.view.eyes.mode).toBe('threat');
    run(views, [tel(0, { down: true, skill: 'getup_front' }), tel(1)], 1);
    expect(a.view.eyes.mode).toBe('down');
    expect(a.view.eyes.pitch).toBeLessThan(-0.2);
  });

  test('the physics gaze wins and its lock drives a flare that stays under the glare cap', () => {
    const r = buildTestRobot('pylon');
    poseRobot(r);
    const t = tel(0, { gaze: { point: pointFromHead(r, 2, -1), mode: 'aim', lock: 1 } });
    run([r.view], [t], 0.5);
    expect(r.view.eyes.mode).toBe('aim');
    expect(r.view.eyes.yaw).toBeLessThan(-0.3);
    expect(r.view.eyes.flare).toBeGreaterThan(0.9);
    const pupils = r.view.animated.eyes.filter((e) => e.kind === 'pupil');
    for (const p of pupils) expect(p.obj.glow).toBeLessThanOrEqual(GLOW_CAP);
    expect(Math.max(...pupils.map((p) => p.obj.glow))).toBeGreaterThan(1.1);
    expect(pupils[0].obj.flash).toBeGreaterThan(0.3); // whiter core
    run([r.view], [{ ...t, gaze: { ...t.gaze!, lock: 0 } }], 1.5);
    expect(r.view.eyes.flare).toBeLessThan(0.05);
  });

  test('a big committed shot flares without a physics lock; a jab does not', () => {
    const r = buildTestRobot('haymaker');
    poseRobot(r);
    const intent = { tactic: 'overhand' as const, target: 'head' as const, aggression: 0.6, confidence: 0.7, source: 'jev' as const };
    run([r.view], [tel(0, { skill: 'jab', windup: 0.4, intent: { ...intent, tactic: 'jab' } })], 0.4);
    expect(r.view.eyes.flare).toBeLessThan(0.05);
    run([r.view], [tel(0, { skill: 'overhand', skillPhase: 0.2, windup: 0.6, intent })], 0.3);
    expect(r.view.eyes.flare).toBeGreaterThan(0.9);
    // An armed opening reflex firing counts as a gamble.
    const r2 = buildTestRobot('savate');
    poseRobot(r2);
    run([r2.view], [tel(0, { skill: 'head_kick', windup: 0.5, openings: ['low_guard'], intent: { ...intent, tactic: 'guard', onOpening: { low_guard: 'head_kick' } } })], 0.3);
    expect(r2.view.eyes.flare).toBeGreaterThan(0.9);
  });

  test('hits flash the optics white (head fully, body softly) and the flash fades', () => {
    const r = buildTestRobot('firecracker');
    poseRobot(r);
    run([r.view], null, 0.2);
    const head = r.view.parts.get('head')!;
    const c = new THREE.Box3().setFromObject(head.content).getCenter(new THREE.Vector3());
    applyImpact(r.view, 'head', c.clone().add(new THREE.Vector3(0.2, 0, 0)), new THREE.Vector3(1, 0, 0), 120);
    expect(r.view.eyes.flash).toBeGreaterThan(0.95);
    run([r.view], null, 1 / 60);
    expect(r.view.animated.eyes[0].obj.flash).toBeGreaterThan(0.8);
    expect(head.obj.flash).toBeGreaterThan(0.8);
    run([r.view], null, 0.6);
    expect(r.view.eyes.flash).toBeLessThan(0.05);
    const torso = r.view.parts.get('torso')!;
    const t = new THREE.Box3().setFromObject(torso.content).getCenter(new THREE.Vector3());
    applyImpact(r.view, 'torso', t.clone().add(new THREE.Vector3(0.3, 0, 0)), new THREE.Vector3(1, 0, 0), 900);
    expect(r.view.eyes.flash).toBeGreaterThan(0.2);
    expect(r.view.eyes.flash).toBeLessThanOrEqual(0.45);
  });

  test('mood: aggression and confidence brighten, damage flickers and runs red, KO and a flat battery go dark', () => {
    const r = buildTestRobot('haymaker');
    poseRobot(r);
    const pupil = () => r.view.animated.eyes[0].obj.glow;
    run([r.view], [tel(0)], 1.5);
    const idle = pupil();
    run([r.view], [tel(0, { intent: { tactic: 'close_distance', target: 'head', aggression: 1, confidence: 1, source: 'jev' } })], 2);
    expect(pupil()).toBeGreaterThan(idle * 1.15);
    run([r.view], [tel(0, { intent: { tactic: 'guard', target: 'head', aggression: 0, confidence: 0.2, source: 'jev' } })], 2);
    expect(pupil()).toBeLessThan(idle);

    // Badly hurt: hot red and dropping out part of the time.
    const hurt = tel(0, { damageTotal: 0.9, parts: [{ id: 'head', hp: 0.15, smoke: 0, heat: 0, attached: true, leak: 0 }] });
    let dark = 0;
    const frames = 240;
    for (let i = 0; i < frames; i++) {
      updateRobotKit([r.view], [hurt], DT);
      if (pupil() < 0.2) dark++;
    }
    expect(r.view.eyes.tint).toBeGreaterThan(0.8);
    expect(dark / frames).toBeGreaterThan(0.1);
    expect(dark / frames).toBeLessThan(0.7);

    // Knocked out: the optics die within a couple of seconds and droop.
    run([r.view], [tel(0, { skill: 'out', down: true })], 2);
    expect(r.view.eyes.power).toBe(0);
    for (const el of r.view.animated.eyes) expect(el.obj.glow).toBe(0);
    expect(r.view.parts.get('head')!.obj.glow).toBe(0);
    expect(r.view.eyes.pitch).toBeLessThan(-0.25);

    const b = buildTestRobot('pylon');
    poseRobot(b);
    run([b.view], [tel(0, { battery: 0.07 })], 2);
    const low = Math.max(...b.view.animated.eyes.map((e) => e.obj.glow));
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(0.7);
    run([b.view], [tel(0, { battery: 0 })], 2);
    for (const el of b.view.animated.eyes) expect(el.obj.glow).toBe(0);
  });

  test('never blinding: every optic stays under the cap in the hottest combination', () => {
    for (const id of ALL) {
      const r = buildTestRobot(id);
      poseRobot(r);
      const t = tel(0, { skill: 'overhand', windup: 0.9, intent: { tactic: 'overhand', target: 'head', aggression: 1, confidence: 1, source: 'jev', flourish: true } });
      for (let i = 0; i < 60; i++) {
        r.view.eyes.flash = 1;
        updateRobotKit([r.view], [t], DT);
        for (const el of r.view.animated.eyes) expect(el.obj.glow, id).toBeLessThanOrEqual(GLOW_CAP);
        expect(r.view.parts.get('head')!.obj.glow, id).toBeLessThanOrEqual(GLOW_CAP);
      }
      r.view.dispose();
    }
  });
});

describe('hand loadouts', () => {
  test('every design builds every hands option inside its triangle budget', () => {
    for (const id of ALL) {
      const budget = DESIGNS[id].era === 'iron' ? IRON_BUDGET : MODERN_BUDGET;
      for (const hands of ['stock', 'glove', 'knuckle', 'dexterous'] as const) {
        const r = buildTestRobot(withHands(id, hands), DESIGNS[id].defaultSkin);
        expect(r.view.triangles, `${id} ${hands}`).toBeLessThan(budget);
        r.view.dispose();
      }
    }
  });

  test('stock builds the design exactly as before', () => {
    for (const id of ALL) {
      const a = buildTestRobot(id);
      const b = buildTestRobot(withHands(id, 'stock'));
      expect(b.view.triangles, id).toBe(a.view.triangles);
      a.view.dispose();
      b.view.dispose();
    }
  });

  test('gloves on a bare-fisted design, knuckle plates on a gloved one', () => {
    const sav = buildTestRobot(withHands('savate', 'glove'));
    expect(slots(sav.view.parts.get('fist_l')!.content).has('glove')).toBe(true);
    const fire = buildTestRobot(withHands('firecracker', 'knuckle'));
    const fist = slots(fire.view.parts.get('fist_r')!.content);
    expect(fist.has('glove')).toBe(false);
    expect(fist.has('chrome')).toBe(true); // the plate's raised striking ridges
  });

  test('dexterous: every phalanx body gets its own mesh and follows its pose', () => {
    const d = withHands('savate', 'dexterous');
    const r = buildTestRobot(d, 'livery');
    const digits = [...r.view.parts.values()].filter((k) => k.def.tags.includes('finger'));
    expect(digits.length).toBe(20);
    expect(r.view.animated.fingers.length).toBe(0); // the physics fingers draw themselves
    for (const k of digits) expect(k.meshes.length, k.id).toBeGreaterThan(0);
    const palmCentre = () => new THREE.Box3().setFromObject(r.view.parts.get('fist_l')!.content).getCenter(new THREE.Vector3());
    const tip = () => new THREE.Box3().setFromObject(r.view.parts.get('digit_l2_d')!.content).getCenter(new THREE.Vector3());
    poseRobot(r, { ...d.stance, ...handPoseAngles(d, 'l', HAND_POSES.open) });
    const open = tip().distanceTo(palmCentre());
    poseRobot(r, { ...d.stance, ...handPoseAngles(d, 'l', HAND_POSES.fist) });
    const fist = tip().distanceTo(palmCentre());
    expect(fist).toBeLessThan(open * 0.75);
  });

  test('a palm with no phalanx bodies draws its own fingers and curls them from the grip', () => {
    const base = DESIGNS.pylon;
    const d: RobotDesign = { ...base, parts: base.parts.map((p) => (p.tags.includes('fist') ? { ...p, visual: { kit: 'hand.palm' } } : p)) };
    const r = buildTestRobot(d);
    poseRobot(r);
    expect(r.view.animated.fingers.length).toBe(20);
    const prox = r.view.animated.fingers.find((f) => f.pivot.name.endsWith('digit_l1_p'))!;
    const angle = () => 2 * Math.acos(Math.min(1, Math.abs(prox.pivot.quaternion.w)));
    run([r.view], [tel(0, { grip: { l: 1, r: 1 } })], 0.6);
    expect(angle()).toBeCloseTo(prox.pose.fist, 1);
    run([r.view], [tel(0, { grip: { l: 0, r: 0 } })], 0.6);
    expect(angle()).toBeCloseTo(prox.pose.open, 1);
    r.view.hands.override.l = HAND_POSES.brace;
    run([r.view], [tel(0)], 0.6);
    expect(angle()).toBeCloseTo(Math.abs(prox.pose.brace), 1);
  });

  test('without a physics grip the hands follow what the body is doing', () => {
    expect(derivedHands(tel(0, { skill: 'cross', windup: 0.4 }))).toEqual(HAND_POSES.fist);
    expect(derivedHands(tel(0, { skill: 'getup_back', down: true }))).toEqual(HAND_POSES.brace);
    expect(derivedHands(tel(0, { skill: 'clinch' })).grip).toBeLessThan(0.3);
    expect(derivedHands(tel(0, { skill: 'stance' }))).toEqual(HAND_POSES.relaxed);
    expect(derivedHands(tel(0, { skill: 'out' })).grip).toBeLessThan(0.5);
  });
});
