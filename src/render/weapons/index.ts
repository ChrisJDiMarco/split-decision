// Hidden weapons: every robot carries two guns in compartments on its shoulders. When a fighter
// wants to use one (in range, facing him, both standing, no referee break), the hatch flips open,
// the gun rises and unfolds, tracks him, fires a burst and folds away again.
//   cannon   – heavy slugs, big recoil, explosive hits
//   gatling  – spin-up, tracer stream, brass everywhere
//   flamer   – a roaring cone of fire that sets him alight
//   missiles – a salvo of six homing rockets
// Rounds are rendered here; a hit pushes the struck part for real through the physics worker
// ('weapon_force'), dents the shell and throws the normal impact sparks.
import * as THREE from 'three/webgpu';
import type { MainToWorker, RobotTelemetry, SimEvent } from '../../core/protocol';
import type { Corner } from '../../core/types';
import { applyImpact, type RobotKitView } from '../robot-kit';
import type { KitPart } from '../robot-kit/types';
import { C, rand3, WeaponFx, type V3 } from './fx';
import { BUILD, missileMesh, shellMesh, type WeaponKind, type WeaponModel } from './models';
import { sfx } from './sounds';

/** Which guns each design hides: [right shoulder, left shoulder]. */
const LOADOUT: Record<string, [WeaponKind, WeaponKind]> = {
  savate: ['cannon', 'flamer'],
  haymaker: ['gatling', 'missiles'],
  firecracker: ['flamer', 'missiles'],
  pylon: ['cannon', 'gatling'],
  bruiser: ['gatling', 'flamer'],
  striker: ['missiles', 'cannon'],
  goliath: ['cannon', 'missiles'],
};

interface Spec { min: number; max: number; cool: [number, number] }
const SPEC: Record<WeaponKind, Spec> = {
  cannon: { min: 1.2, max: 8, cool: [6, 11] },
  gatling: { min: 0.8, max: 8, cool: [5, 9] },
  flamer: { min: 0.4, max: 2.6, cool: [5, 9] },
  missiles: { min: 2, max: 10, cool: [8, 13] },
};

const DEPLOY_S = 0.7;
const YAW_RATE = 7;
const FOLD_PITCH = 1.35; // folded nose-down in the compartment

type Phase = 'hidden' | 'deploying' | 'aiming' | 'firing' | 'holding' | 'retracting';

interface Mount {
  m: WeaponModel;
  side: 1 | -1;
  phase: Phase;
  deploy: number; // 0 hidden .. 1 out
  timer: number;
  shots: number;
  nextShot: number;
  spin: number; // gatling rad/s
  heat: number;
  recoil: number;
  aimPitch: number;
  ready: number; // cooldown left for this gun
  flameSound: number;
}

interface Arsenal {
  view: RobotKitView;
  corner: Corner;
  torso: KitPart;
  scale: number;
  mounts: Mount[];
  cooldown: number; // between any two uses
  burnUntil: number; // set alight by a flamer
}

interface Flight {
  kind: 'shell' | 'missile' | 'bullet';
  owner: Corner;
  obj: THREE.Object3D | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number; // bullets: time to reach the aim point
  hit: boolean; // bullets/shells: decided at the trigger
  aimOff: THREE.Vector3; // where on him it was aimed (bullets, shells)
  speed: number;
  trail: number;
}

export interface WeaponsHost {
  physicsRoot: THREE.Group;
  camera: THREE.Camera;
  send(m: MainToWorker): void;
  sparks(events: SimEvent[]): void;
  pulse(amount: number): void;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export class Weapons {
  private readonly fx: WeaponFx;
  private arsenals: Arsenal[] = [];
  private flights: Flight[] = [];
  private readonly shells: THREE.Mesh[] = [];
  private readonly missiles: THREE.Group[] = [];
  private time = 0;

  constructor(private readonly host: WeaponsHost) {
    this.fx = new WeaponFx(host.camera);
    host.physicsRoot.add(this.fx.root);
    for (let i = 0; i < 6; i++) {
      const s = shellMesh();
      s.visible = false;
      this.fx.root.add(s);
      this.shells.push(s);
    }
    for (let i = 0; i < 16; i++) {
      const g = missileMesh();
      g.visible = false;
      this.fx.root.add(g);
      this.missiles.push(g);
    }
  }

  /** New fight: build each robot's hidden guns into its torso. */
  setViews(views: RobotKitView[]): void {
    for (const a of this.arsenals) for (const mt of a.mounts) mt.m.slot.removeFromParent();
    this.arsenals = [];
    this.clear();
    for (const view of views) {
      const torso = view.parts.get('torso');
      if (!torso) continue;
      const box = localBox(torso);
      const size = box.getSize(new THREE.Vector3());
      const scale = THREE.MathUtils.clamp(size.z / 0.42, 0.65, 1.45);
      const kinds = LOADOUT[view.design.id] ?? ['cannon', 'gatling'];
      const mounts: Mount[] = [];
      kinds.forEach((kind, i) => {
        const side = (i === 0 ? -1 : 1) as 1 | -1; // right shoulder first (y is left)
        const m = BUILD[kind]();
        m.slot.position.set(box.min.x + size.x * 0.42, side * Math.max(0.09, size.y * 0.3), box.max.z - 0.004);
        m.slot.scale.setScalar(scale);
        torso.attached.add(m.slot);
        mounts.push({ m, side, phase: 'hidden', deploy: 0, timer: 0, shots: 0, nextShot: 0, spin: 0, heat: 0, recoil: 0, aimPitch: 0, ready: 0, flameSound: 0 });
        pose(mounts[mounts.length - 1]);
      });
      this.arsenals.push({ view, corner: view.corner, torso, scale, mounts, cooldown: 4 + Math.random() * 4, burnUntil: 0 });
    }
  }

  clear(): void {
    this.fx.clear();
    for (const f of this.flights) if (f.obj) f.obj.visible = false;
    this.flights = [];
    for (const a of this.arsenals) {
      a.cooldown = 4 + Math.random() * 4;
      a.burnUntil = 0;
      for (const mt of a.mounts) {
        mt.phase = 'hidden';
        mt.deploy = 0;
        mt.heat = 0;
        mt.spin = 0;
        for (const r of mt.m.rounds) r.visible = true;
        pose(mt);
      }
    }
  }

  /** `live`: the fight is running forward on screen. `dt` is the effects clock (slow-mo aware). */
  update(dt: number, tel: readonly RobotTelemetry[] | null, live: boolean): void {
    this.time += dt;
    this.host.physicsRoot.updateMatrixWorld(true);
    for (const a of this.arsenals) this.updateArsenal(a, dt, tel, live);
    this.updateFlights(dt, tel);
    this.fx.update(dt);
  }

  // ---------------------------------------------------------------- per robot

  private opponent(a: Arsenal): Arsenal | null {
    return this.arsenals.find((o) => o.corner !== a.corner) ?? null;
  }

  private target(a: Arsenal): THREE.Vector3 | null {
    const o = this.opponent(a);
    return o ? o.torso.attached.position.clone().add(new THREE.Vector3(0, 0, 0.05)) : null;
  }

  private updateArsenal(a: Arsenal, dt: number, tel: readonly RobotTelemetry[] | null, live: boolean) {
    const me = tel?.[a.corner];
    const him = tel?.[a.corner === 0 ? 1 : 0];
    const target = this.target(a);
    const allowed = live && !!me && !!him && !me.down && !him.down && !me.referee?.break && me.upright > 0.6;
    a.cooldown -= dt;

    // Pick a gun to use: in range, roughly facing him, nothing else out.
    const busy = a.mounts.some((m) => m.phase !== 'hidden');
    if (allowed && !busy && a.cooldown <= 0 && target && Math.random() < dt * 0.9) {
      const d = Math.hypot(target.x - a.torso.attached.position.x, target.y - a.torso.attached.position.y);
      const fwd = AXIS_X.clone().applyQuaternion(a.torso.attached.quaternion);
      const toHim = tmp.copy(target).sub(a.torso.attached.position).setZ(0).normalize();
      const facing = fwd.setZ(0).normalize().dot(toHim) > -0.1;
      const options = a.mounts.filter((m) => m.ready <= 0 && d >= SPEC[m.m.kind].min && d <= SPEC[m.m.kind].max);
      if (facing && options.length) {
        const mt = options[Math.floor(Math.random() * options.length)];
        mt.phase = 'deploying';
        sfx.deploy();
      }
    }

    for (const mt of a.mounts) {
      mt.ready -= dt;
      mt.heat = Math.max(0, mt.heat - dt * 0.35);
      mt.recoil = Math.max(0, mt.recoil - dt * 1.4);
      if (!allowed && mt.phase !== 'hidden' && mt.phase !== 'retracting') mt.phase = 'retracting';

      switch (mt.phase) {
        case 'deploying':
          mt.deploy = Math.min(1, mt.deploy + dt / DEPLOY_S);
          if (mt.deploy >= 1) { mt.phase = 'aiming'; mt.timer = 0.25; }
          break;
        case 'aiming':
          mt.timer -= dt;
          if (mt.timer <= 0) this.startBurst(mt);
          break;
        case 'firing':
          if (target) this.fire(a, mt, dt, target, tel);
          break;
        case 'holding':
          mt.timer -= dt;
          if (mt.timer <= 0) mt.phase = 'retracting';
          break;
        case 'retracting':
          mt.deploy = Math.max(0, mt.deploy - dt / DEPLOY_S);
          if (mt.deploy <= 0) {
            mt.phase = 'hidden';
            for (const r of mt.m.rounds) r.visible = true;
            const sp = SPEC[mt.m.kind];
            mt.ready = sp.cool[0] + Math.random() * (sp.cool[1] - sp.cool[0]);
            a.cooldown = 2 + Math.random() * 3;
          }
          break;
        default:
          break;
      }
      if (mt.m.kind === 'gatling') {
        const want = mt.phase === 'firing' ? 46 : 0;
        mt.spin += (want - mt.spin) * Math.min(1, dt * (want > mt.spin ? 3.2 : 1.2));
        if (mt.m.spinner) mt.m.spinner.rotation.x += mt.spin * dt;
      }
      if (target && mt.deploy > 0) this.aim(mt, target, dt);
      pose(mt);
      for (const hm of mt.m.heatMats) hm.emissiveIntensity = mt.heat * mt.heat * 4;
      const blink = mt.deploy > 0 && Math.sin(this.time * 14) > 0 ? 6 : 0.3;
      for (const l of mt.m.lamps) l.color.setScalar(0).setRGB(blink, blink * 0.2, blink * 0.1);
      // The flamer's pilot light burns blue while it's out.
      if (mt.m.pilot && mt.deploy > 0.6) {
        const p = physPos(mt.m.pilot, this.host.physicsRoot);
        this.fx.glow.spawn({ pos: p, vel: new THREE.Vector3(0, 0, 0.6), life: 0.08, size: [0.045 * a.scale, 0.02 * a.scale], colors: [C.pilot], alpha: [0.9, 0] });
      }
    }

    // Burning: flames lick off a robot the flamer caught.
    if (this.time < a.burnUntil) {
      for (let i = 0; i < 3; i++) {
        const p = a.torso.attached.position.clone().add(rand3(0.16 * a.scale));
        this.fx.fire.spawn({ pos: p, vel: new THREE.Vector3(0, 0, 1.2 + Math.random()).add(rand3(0.3)), life: 0.35 + Math.random() * 0.3, size: [0.06, 0.22], colors: [C.fireHot, C.fire, C.fireDeep], alpha: [0.9, 0], drag: 2, gravity: -2 });
      }
      if (Math.random() < dt * 8) this.fx.smoke.spawn({ pos: a.torso.attached.position.clone().add(rand3(0.12)), vel: new THREE.Vector3(0, 0, 1), life: 1.6, size: [0.12, 0.6], colors: [C.smokeDark], alpha: [0.45, 0], drag: 1, gravity: -0.8 });
    }
  }

  private aim(mt: Mount, target: V3, dt: number) {
    const w = this.host.physicsRoot.localToWorld(tmp.copy(target));
    mt.m.lift.worldToLocal(w);
    const yaw = THREE.MathUtils.clamp(Math.atan2(w.y, w.x), -2.3, 2.3);
    const d = yaw - mt.m.yaw.rotation.z;
    mt.m.yaw.rotation.z += THREE.MathUtils.clamp(d, -YAW_RATE * dt, YAW_RATE * dt);
    const pitch = Math.atan2(w.z - mt.m.pitch.position.z, Math.hypot(w.x, w.y));
    mt.aimPitch += (THREE.MathUtils.clamp(pitch, -0.7, 0.9) - mt.aimPitch) * Math.min(1, dt * 10);
  }

  private startBurst(mt: Mount) {
    mt.phase = 'firing';
    mt.nextShot = 0;
    switch (mt.m.kind) {
      case 'cannon': mt.shots = 2 + Math.floor(Math.random() * 2); break;
      case 'gatling': mt.shots = Math.round((1.3 + Math.random() * 0.9) * 22); mt.nextShot = 0.35; break;
      case 'flamer': mt.timer = 1.6 + Math.random() * 0.8; mt.flameSound = 0; break;
      case 'missiles': mt.shots = mt.m.rounds.length; break;
    }
  }

  private endBurst(mt: Mount) {
    mt.phase = 'holding';
    mt.timer = 0.55;
  }

  // ---------------------------------------------------------------- firing

  private muzzle(mt: Mount, i = 0): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    const o = mt.m.muzzles[i % mt.m.muzzles.length];
    const pos = physPos(o, this.host.physicsRoot);
    o.getWorldQuaternion(tmpQ);
    const inv = this.host.physicsRoot.getWorldQuaternion(new THREE.Quaternion()).invert();
    const dir = AXIS_X.clone().applyQuaternion(tmpQ).applyQuaternion(inv).normalize();
    return { pos, dir };
  }

  private fire(a: Arsenal, mt: Mount, dt: number, target: V3, tel: readonly RobotTelemetry[] | null) {
    mt.nextShot -= dt;
    const s = a.scale;
    switch (mt.m.kind) {
      case 'gatling': {
        while (mt.nextShot <= 0 && mt.shots > 0) {
          mt.nextShot += 1 / 22;
          mt.shots--;
          mt.heat = Math.min(1, mt.heat + 0.012);
          const { pos, dir } = this.muzzle(mt);
          const off = rand3(0.3);
          const hit = off.length() < 0.22;
          const aimAt = target.clone().add(off);
          const v = aimAt.clone().sub(pos).normalize().lerp(dir, 0.15).normalize();
          const speed = 150;
          const dist = aimAt.distanceTo(pos);
          this.fx.muzzleFlash(pos, v, 0.4 * s);
          this.fx.tracers.spawn(pos.clone().addScaledVector(v, 0.6), v.clone().multiplyScalar(speed), hit ? dist / speed : 0.12, 1.1);
          // Brass out of the right side and up.
          const right = new THREE.Vector3(-v.y, v.x, 0).normalize().multiplyScalar(-1);
          this.fx.casings.eject(pos.clone().addScaledVector(v, -0.3 * s), right.multiplyScalar(1.6).add(new THREE.Vector3(0, 0, 1.6)).add(rand3(0.5)));
          this.flights.push({ kind: 'bullet', owner: a.corner, obj: null, pos: pos.clone(), vel: v.multiplyScalar(speed), age: 0, life: dist / speed, hit, aimOff: off, speed, trail: 0 });
          sfx.gatling();
        }
        if (mt.shots <= 0) this.endBurst(mt);
        break;
      }
      case 'cannon': {
        if (mt.nextShot <= 0 && mt.shots > 0) {
          mt.nextShot = 0.6;
          mt.shots--;
          mt.recoil = 1;
          mt.heat = Math.min(1, mt.heat + 0.35);
          const { pos } = this.muzzle(mt);
          const off = rand3(0.28);
          const hit = off.length() < 0.26;
          const aimAt = target.clone().add(off);
          const v = aimAt.clone().sub(pos).normalize();
          this.fx.muzzleFlash(pos, v, 1.4 * s);
          for (let i = 0; i < 10; i++) {
            // A ring of muzzle-brake smoke blowing out sideways.
            const side = rand3(1).projectOnPlane(v).normalize().multiplyScalar(2 + Math.random() * 2);
            this.fx.smoke.spawn({ pos: pos.clone(), vel: side.addScaledVector(v, 1.5), life: 1.2 + Math.random(), size: [0.1 * s, 0.6 * s], colors: [C.smokeLight, C.smokeDark], alpha: [0.5, 0], drag: 3, gravity: -0.3 });
          }
          const shell = this.shells.find((m) => !m.visible) ?? this.shells[0];
          shell.visible = true;
          this.flights.push({ kind: 'shell', owner: a.corner, obj: shell, pos: pos.clone(), vel: v.clone().multiplyScalar(48), age: 0, life: 2, hit, aimOff: off, speed: 48, trail: 0 });
          sfx.cannon();
          this.host.pulse(0.18);
        }
        if (mt.shots <= 0 && mt.nextShot <= 0.2) this.endBurst(mt);
        break;
      }
      case 'missiles': {
        if (mt.nextShot <= 0 && mt.shots > 0) {
          mt.nextShot = 0.14;
          const i = mt.m.rounds.length - mt.shots;
          mt.shots--;
          mt.m.rounds[i].visible = false;
          const { pos, dir } = this.muzzle(mt, i);
          this.fx.muzzleFlash(pos, dir, 0.6 * s);
          for (let k = 0; k < 6; k++) this.fx.smoke.spawn({ pos: pos.clone(), vel: dir.clone().multiplyScalar(-2).add(rand3(1.2)), life: 1.5, size: [0.1, 0.5], colors: [C.smokeLight], alpha: [0.5, 0], drag: 2.5, gravity: -0.4 });
          const g = this.missiles.find((m) => !m.visible) ?? this.missiles[0];
          g.visible = true;
          g.scale.setScalar(s);
          const v = dir.clone().multiplyScalar(9).add(new THREE.Vector3(0, 0, 3.5)).add(rand3(2));
          this.flights.push({ kind: 'missile', owner: a.corner, obj: g, pos: pos.clone(), vel: v, age: 0, life: 3.5, hit: true, aimOff: rand3(0.08), speed: 9, trail: 0 });
          sfx.missile();
        }
        if (mt.shots <= 0) this.endBurst(mt);
        break;
      }
      case 'flamer': {
        mt.timer -= dt;
        mt.heat = Math.min(1, mt.heat + dt * 0.4);
        mt.flameSound -= dt;
        if (mt.flameSound <= 0) { sfx.flame(0.5); mt.flameSound = 0.42; }
        const { pos, dir } = this.muzzle(mt);
        const aimDir = target.clone().sub(pos).normalize().lerp(dir, 0.5).normalize();
        const n = Math.ceil(dt * 160);
        const tag = `flame${a.corner}`;
        for (let i = 0; i < n; i++) {
          const v = aimDir.clone().multiplyScalar(8 + Math.random() * 4).add(rand3(1.1));
          this.fx.fire.spawn({
            pos: pos.clone().addScaledVector(aimDir, Math.random() * 0.1), vel: v, life: 0.4 + Math.random() * 0.3,
            size: [0.04 * s, (0.4 + Math.random() * 0.35) * s], colors: [C.pilot, C.fireHot, C.fire, C.fireDeep, C.ember],
            alpha: [1, 0], drag: 2.4, gravity: -2.5, spin: (Math.random() - 0.5) * 4, tag,
          });
        }
        if (Math.random() < dt * 30) {
          this.fx.smoke.spawn({ pos: pos.clone().addScaledVector(aimDir, 1.6 + Math.random()), vel: aimDir.clone().multiplyScalar(2).add(new THREE.Vector3(0, 0, 1)), life: 2, size: [0.25, 1.1], colors: [C.smokeDark], alpha: [0.4, 0], drag: 1.4, gravity: -0.8 });
        }
        this.fx.light(pos.clone().addScaledVector(aimDir, 0.8), 10 * s, 0xff7a20, 30);
        // Damage probe: how much of the jet is washing over him.
        mt.nextShot -= 0; // keep the cadence on the timer below
        const o = this.opponent(a);
        if (o && Math.random() < dt * 10) {
          const n2 = this.fx.fire.countNear(o.torso.attached.position, 0.5 * o.scale, (p) => p.tag === tag);
          if (n2 >= 4) {
            o.burnUntil = this.time + 2.2;
            this.push(o.corner, 'torso', aimDir.clone().multiplyScalar(9), o.torso.attached.position.clone(), 0.1);
            if (Math.random() < 0.3) this.dent(o, 'torso', o.torso.attached.position.clone().addScaledVector(aimDir, -0.15), aimDir, 40);
          }
        }
        if (mt.timer <= 0) this.endBurst(mt);
        void tel;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- rounds in flight

  private updateFlights(dt: number, tel: readonly RobotTelemetry[] | null) {
    const keep: Flight[] = [];
    for (const f of this.flights) {
      f.age += dt;
      const victim = this.arsenals.find((x) => x.corner !== f.owner);
      if (f.kind === 'missile') {
        const t = victim ? victim.torso.attached.position.clone().add(f.aimOff) : null;
        f.speed = Math.min(34, f.speed + dt * 40);
        if (t && f.age > 0.18) {
          const want = t.clone().sub(f.pos).normalize().multiplyScalar(f.speed);
          f.vel.lerp(want, 1 - Math.exp(-dt * 4.5));
        } else f.vel.z -= 4 * dt;
        f.pos.addScaledVector(f.vel, dt);
        if (f.obj) {
          f.obj.position.copy(f.pos);
          f.obj.quaternion.setFromUnitVectors(AXIS_X, tmp2.copy(f.vel).normalize());
        }
        const back = f.pos.clone().addScaledVector(f.vel, -0.12 / Math.max(1, f.vel.length()) * 8);
        this.fx.fire.spawn({ pos: back, vel: f.vel.clone().multiplyScalar(-0.15).add(rand3(0.4)), life: 0.12, size: [0.07, 0.03], colors: [C.white, C.fireHot, C.fire], alpha: [1, 0] });
        f.trail += dt;
        while (f.trail > 0.025) {
          f.trail -= 0.025;
          this.fx.smoke.spawn({ pos: back.clone(), vel: rand3(0.2), life: 1.1 + Math.random() * 0.6, size: [0.04, 0.24], colors: [C.smokeLight, C.smokeDark], alpha: [0.4, 0], drag: 1.5, gravity: -0.25 });
        }
        const near = t && f.pos.distanceTo(t) < 0.32 * (victim?.scale ?? 1);
        if (near || f.pos.z < 0.04 || f.age > f.life) {
          if (f.obj) f.obj.visible = false;
          this.blast(f, victim ?? null, !!near, 60, 0.6, tel);
          continue;
        }
        keep.push(f);
      } else if (f.kind === 'shell') {
        f.pos.addScaledVector(f.vel, dt);
        if (f.obj) {
          f.obj.position.copy(f.pos);
          f.obj.quaternion.setFromUnitVectors(AXIS_X, tmp2.copy(f.vel).normalize());
        }
        f.trail += dt;
        while (f.trail > 0.01) {
          f.trail -= 0.01;
          this.fx.smoke.spawn({ pos: f.pos.clone(), vel: rand3(0.15), life: 0.7, size: [0.03, 0.2], colors: [C.smokeLight], alpha: [0.35, 0], drag: 2, gravity: -0.3 });
        }
        const t = victim ? victim.torso.attached.position.clone().add(f.aimOff) : null;
        const arrived = t && f.pos.distanceTo(t) < 0.3;
        const passed = t && tmp.copy(t).sub(f.pos).dot(f.vel) < 0;
        if ((arrived || passed) && f.hit) {
          if (f.obj) f.obj.visible = false;
          this.blast(f, victim ?? null, true, 95, 0.95, tel);
          continue;
        }
        if (f.pos.z < 0.04 || f.age > f.life || Math.hypot(f.pos.x, f.pos.y) > 9) {
          if (f.obj) f.obj.visible = false;
          this.blast(f, victim ?? null, false, 0, 0.8, tel);
          continue;
        }
        keep.push(f);
      } else {
        // Bullets: the tracer flies on its own; this resolves the hit when it gets there.
        if (f.age < f.life) { keep.push(f); continue; }
        const dir = f.vel.clone().normalize();
        if (f.hit && victim) {
          const head = f.aimOff.z > 0.16 && victim.view.parts.get('head');
          const part = head ? 'head' : 'torso';
          const p = victim.torso.attached.position.clone().add(f.aimOff).addScaledVector(dir, -0.12);
          this.push(victim.corner, part, dir.clone().multiplyScalar(5), p, 0.01);
          if (Math.random() < 0.3) this.host.sparks([impact(p, dir, f.owner, victim.corner, part, 12, 5)]);
          for (let i = 0; i < 2; i++) this.fx.glow.spawn({ pos: p, vel: rand3(3).addScaledVector(dir, -2), life: 0.2, size: [0.025, 0.01], colors: [C.fireHot], drag: 2, gravity: 9.81 });
          if (Math.random() < 0.25) this.dent(victim, part, p, dir, 70);
          if (Math.random() < 0.15) sfx.ricochet();
        } else if (dir.z < -0.02) {
          // Missed: chew up the canvas where it lands.
          const tHit = -f.pos.z / dir.z;
          const p = f.pos.clone().addScaledVector(dir, tHit);
          if (Math.hypot(p.x, p.y) < 9) {
            p.z = 0.02;
            for (let i = 0; i < 3; i++) this.fx.glow.spawn({ pos: p, vel: rand3(2).setZ(2 + Math.random() * 2), life: 0.25, size: [0.03, 0.01], colors: [C.fireHot], drag: 1, gravity: 9.81 });
            this.fx.smoke.spawn({ pos: p, vel: new THREE.Vector3(0, 0, 0.6), life: 0.9, size: [0.05, 0.3], colors: [C.smokeLight], alpha: [0.4, 0], drag: 2 });
          }
        }
      }
    }
    this.flights = keep;
  }

  /** A shell or missile goes off: fireball, shock ring, light, and the push if it caught him. */
  private blast(f: Flight, victim: Arsenal | null, direct: boolean, impulseNs: number, scale: number, tel: readonly RobotTelemetry[] | null) {
    const dir = f.vel.clone().normalize();
    const p = direct && victim ? victim.torso.attached.position.clone().add(f.aimOff).addScaledVector(dir, -0.18) : f.pos.clone();
    this.fx.explosion(p, scale);
    sfx.explosion(scale);
    this.host.pulse(direct ? 0.3 : 0.15);
    if (!victim) return;
    const dist = victim.torso.attached.position.distanceTo(p);
    const falloff = direct ? 1 : Math.max(0, 1 - dist / 1.4);
    if (falloff <= 0) return;
    const push = dir.clone().setZ(Math.max(0.15, dir.z + 0.25)).normalize().multiplyScalar(impulseNs > 0 ? impulseNs * falloff : 30 * falloff);
    this.push(victim.corner, 'torso', push, p, 0.02);
    this.host.sparks([impact(p, dir, f.owner, victim.corner, 'torso', 260 * falloff, 9)]);
    if (direct) this.dent(victim, 'torso', p, dir, 650);
    void tel;
  }

  private push(victim: Corner, part: string, impulse: THREE.Vector3, point: THREE.Vector3, durationS: number) {
    this.host.send({ type: 'weapon_force', victim, part, impulse: [impulse.x, impulse.y, impulse.z], point: [point.x, point.y, point.z], durationS });
  }

  private dent(victim: Arsenal, part: string, pPhys: THREE.Vector3, dir: THREE.Vector3, energyJ: number) {
    const root = this.host.physicsRoot;
    const wp = root.localToWorld(pPhys.clone());
    const n = dir.clone().negate().transformDirection(root.matrixWorld);
    applyImpact(victim.view, part, wp, n, energyJ);
  }
}

// ---------------------------------------------------------------- helpers

function pose(mt: Mount) {
  const m = mt.m;
  const d = mt.deploy;
  const doors = THREE.MathUtils.smoothstep(d, 0, 0.35);
  for (const door of m.doors) {
    if (door.axis === 'x') door.pivot.rotation.x = door.openAngle * doors;
    else door.pivot.rotation.y = door.openAngle * doors;
  }
  const rise = easeOutBack(THREE.MathUtils.clamp((d - 0.25) / 0.75, 0, 1));
  m.lift.position.z = -m.travel * (1 - rise);
  m.lift.visible = d > 0.2;
  m.lift.scale.setScalar(0.5 + 0.5 * Math.min(1, rise));
  const unfold = THREE.MathUtils.smoothstep(d, 0.65, 1);
  m.pitch.rotation.y = THREE.MathUtils.lerp(FOLD_PITCH, -mt.aimPitch, unfold);
  if (d <= 0) m.yaw.rotation.z = 0;
  if (m.recoil) m.recoil.position.x = -0.13 * Math.pow(mt.recoil, 2);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Physics-frame position of an object under the physics root. */
function physPos(o: THREE.Object3D, root: THREE.Object3D): THREE.Vector3 {
  return root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
}

/** The torso's visual bounds in its own frame. */
function localBox(part: KitPart): THREE.Box3 {
  part.attached.updateMatrixWorld(true);
  const inv = part.attached.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const bb = new THREE.Box3();
  part.content.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    bb.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
    box.union(bb);
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.12, -0.18, -0.2), new THREE.Vector3(0.12, 0.18, 0.2));
  return box;
}

function impact(pos: THREE.Vector3, dir: THREE.Vector3, striker: Corner, victim: Corner, part: string, energyJ: number, speed: number): SimEvent {
  return {
    kind: 'impact',
    pos: [pos.x, pos.y, pos.z],
    normal: [-dir.x, -dir.y, -dir.z],
    impulseNs: energyJ / 5,
    speed,
    energyJ,
    striker,
    victim,
    part,
    metal: true,
    clean: true,
  };
}
