// A physics-free robot for the showroom: poses bodies with forward kinematics (stance plus an
// idle guard motion), feeds the kit fake telemetry, and throws knocked-off parts with a tiny
// ballistic sim so the damage path can be exercised without MuJoCo.
import * as THREE from 'three/webgpu';
import type { JointTelemetry, PartTelemetry, RobotTelemetry } from '../../../core/protocol';
import type { PartDef, RobotDesign, SkinId } from '../../../core/types';
import { motor } from '../../../robots/catalog';
import { buildRobotKitView } from '../build';
import { applyImpact, setPartState } from '../damage';
import { applyBodyPoses, forwardKinematics } from '../fk';
import type { RobotKitView } from '../types';

const GRAVITY = 9.81;
const RESTITUTION = 0.32;
const GROUND_FRICTION = 0.72;

interface Toy {
  group: THREE.Group;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  radius: number;
}

function idleAngles(design: RobotDesign, t: number, pump: boolean): Record<string, number> {
  const q: Record<string, number> = { ...design.stance };
  const add = (k: string, v: number) => {
    if (k in q) q[k] += v;
  };
  const breathe = Math.sin(t * 1.3);
  add('waist_yaw', 0.12 * Math.sin(t * 0.45));
  add('waist_pitch', 0.03 * breathe);
  add('neck_yaw', 0.38 * Math.sin(t * 0.33));
  for (const [tag, ph] of [['l', 0], ['r', Math.PI * 0.8]] as const) {
    add(`shoulder_pitch_${tag}`, 0.1 * Math.sin(t * 0.9 + ph));
    add(`shoulder_roll_${tag}`, (tag === 'l' ? 1 : -1) * 0.05 * Math.sin(t * 0.7 + ph));
    add(`elbow_${tag}`, pump ? 0.45 * Math.sin(t * 1.1 + ph) : 0.08 * Math.sin(t * 0.9 + ph));
    add(`knee_${tag}`, 0.05 * breathe);
    add(`hip_pitch_${tag}`, -0.025 * breathe);
    add(`ankle_pitch_${tag}`, -0.025 * breathe);
  }
  return q;
}

export class ShowroomRobot {
  readonly view: RobotKitView;
  readonly root = new THREE.Group(); // z-up container placed in the lineup
  private readonly byPart = new Map<string, THREE.Object3D>();
  private readonly toys = new Map<string, Toy>();
  private groundZ = 0;
  private t = 0;
  readonly jointTemp = new Map<string, number>();
  gyroLoad = 0.25;
  pump = true;

  constructor(readonly design: RobotDesign, skin: SkinId, parent: THREE.Object3D, offset: THREE.Vector3, yaw = 0, phase = 0, corner: 0 | 1 = 0) {
    this.root.position.copy(offset);
    this.root.rotation.z = yaw;
    parent.add(this.root);
    const bodyGroups = new Map<number, THREE.Group>();
    let next = 1;
    const parts = design.parts.map((p) => ({ id: p.id, body: next++, debrisBody: null as number | null }));
    for (const pm of parts) if (design.parts.find((p) => p.id === pm.id)?.detachable) pm.debrisBody = next++;
    this.view = buildRobotKitView(design, skin, corner, parts, this.root, bodyGroups);
    for (const pm of parts) {
      const g = bodyGroups.get(pm.body);
      if (g) this.byPart.set(pm.id, g);
    }
    this.t = phase;
    this.groundZ = this.lowestPoint();
    for (const p of design.parts) for (const j of p.joints ?? []) this.jointTemp.set(j.name, 35);
  }

  /** Lowest collision point in the stance, so the feet stand on the plinth. */
  private lowestPoint(): number {
    const poses = forwardKinematics(this.design, this.design.stance, new THREE.Vector3(0, 0, this.design.rootHeight), new THREE.Quaternion());
    let minZ = Infinity;
    for (const part of this.design.parts) {
      const pose = poses.get(part.id)!;
      for (const g of part.geoms) {
        const s = g.shape;
        const pts: THREE.Vector3[] = [];
        if (s.type === 'box') {
          const c = new THREE.Vector3(...(g.pos ?? [0, 0, 0]));
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(c.clone().add(new THREE.Vector3(sx * s.halfSize[0], sy * s.halfSize[1], sz * s.halfSize[2])));
        } else if (s.type === 'capsule' || s.type === 'cylinder') {
          pts.push(new THREE.Vector3(...s.from).setZ(s.from[2] - s.radius), new THREE.Vector3(...s.to).setZ(s.to[2] - s.radius));
        }
        for (const p of pts) minZ = Math.min(minZ, p.applyQuaternion(pose.quat).add(pose.pos).z);
      }
    }
    return minZ;
  }

  update(dt: number, animate: boolean): void {
    if (animate) this.t += dt;
    const q = idleAngles(this.design, this.t, this.pump);
    const poses = forwardKinematics(this.design, q, new THREE.Vector3(0, 0, this.design.rootHeight - this.groundZ), new THREE.Quaternion());
    applyBodyPoses(poses, this.byPart);
    for (const [id, toy] of this.toys) this.stepToy(id, toy, dt);
  }

  private stepToy(_id: string, toy: Toy, dt: number): void {
    const g = toy.group;
    toy.vel.z -= GRAVITY * dt;
    g.position.addScaledVector(toy.vel, dt);
    const w = toy.spin.length();
    if (w > 1e-4) g.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(toy.spin.clone().divideScalar(w), w * dt));
    if (g.position.z < toy.radius) {
      g.position.z = toy.radius;
      if (toy.vel.z < 0) toy.vel.z = -toy.vel.z * RESTITUTION;
      toy.vel.x *= GROUND_FRICTION;
      toy.vel.y *= GROUND_FRICTION;
      toy.spin.multiplyScalar(0.6);
      if (Math.abs(toy.vel.z) < 0.15) toy.vel.z = 0;
    }
  }

  /** Part heat the way the physics reports it: tempC / maxTempC of the part's hottest joint. */
  private partHeat(def: PartDef): number {
    let heat = 0;
    for (const j of def.joints ?? []) heat = Math.max(heat, (this.jointTemp.get(j.name) ?? 0) / motor(j.motor).maxTempC);
    return Math.min(1, heat);
  }

  telemetry(): RobotTelemetry {
    const parts: PartTelemetry[] = [...this.view.parts.values()].map((k) => ({ id: k.id, hp: k.state.hp, smoke: 0, heat: this.partHeat(k.def), attached: k.state.attached, leak: 0 }));
    const joints: JointTelemetry[] = [...this.jointTemp].map(([name, tempC]) => ({ name, health: 1, state: 'ok', tempC, torqueFrac: 0.2 }));
    return {
      corner: this.view.corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
      battery: 1, gyroHealth: 1, gyroSaturation: this.gyroLoad, hydraulicPressure: {}, skill: 'idle', skillPhase: 0, windup: 0,
      parts, joints, damageTotal: 0, intent: null,
    };
  }

  /** Hit random attached parts at random surface points; heat a couple of joints. */
  damageTest(rand: () => number = Math.random): void {
    const kits = [...this.view.parts.values()].filter((k) => k.state.attached);
    for (let i = 0; i < 7; i++) {
      const kit = kits[Math.floor(rand() * kits.length)];
      const mesh = kit.meshes.find((m) => m.userData.slot === 'paint') ?? kit.meshes[0];
      if (!mesh) continue;
      const pos = mesh.geometry.getAttribute('position');
      const nor = mesh.geometry.getAttribute('normal');
      const v = Math.floor(rand() * pos.count);
      mesh.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3().fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld);
      const wn = new THREE.Vector3().fromBufferAttribute(nor, v).transformDirection(mesh.matrixWorld);
      applyImpact(this.view, kit.id, wp, wn, 120 + rand() * 650);
    }
    const names = [...this.jointTemp.keys()];
    for (let i = 0; i < 3; i++) this.jointTemp.set(names[Math.floor(rand() * names.length)], 105 + rand() * 25);
    const torso = this.view.parts.get('torso');
    if (torso) setPartState(this.view, 'torso', { hp: Math.max(0.2, torso.state.hp - 0.3) });
    const head = this.view.parts.get('head');
    if (head) setPartState(this.view, 'head', { hp: Math.max(0.15, head.state.hp - 0.35) });
  }

  /** Knock a detachable part off and throw its debris twin. */
  knockOff(partId = 'head'): void {
    const kit = this.view.parts.get(partId);
    if (!kit?.debris || !kit.state.attached) return;
    kit.debris.position.copy(kit.attached.position);
    kit.debris.quaternion.copy(kit.attached.quaternion);
    setPartState(this.view, partId, { attached: false });
    const size = new THREE.Box3().setFromObject(kit.debrisContent ?? kit.content).getSize(new THREE.Vector3());
    this.toys.set(partId, {
      group: kit.debris,
      vel: new THREE.Vector3(-1.2 - Math.random(), (Math.random() - 0.5) * 1.6, 2.6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 14, -8 - Math.random() * 6, (Math.random() - 0.5) * 10),
      radius: Math.min(size.x, size.y, size.z) * 0.45,
    });
  }

  dispose(): void {
    this.view.dispose();
    this.root.removeFromParent();
  }
}
