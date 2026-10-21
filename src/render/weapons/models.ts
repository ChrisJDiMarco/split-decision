// Procedural weapon models and their hidden compartments. Each mount is built in the torso's own
// frame (x forward, y left, z up, metres) and scaled to the robot. A mount is:
//   slot (fixed on the torso) → hatch doors (flip open) + lift (rises out) → yaw → pitch → the gun.
// The barrel points along +x of the pitch node; `muzzles` are the points rounds leave from.
import * as THREE from 'three/webgpu';

export type WeaponKind = 'cannon' | 'gatling' | 'flamer' | 'missiles';

export interface WeaponModel {
  kind: WeaponKind;
  slot: THREE.Group;
  lift: THREE.Group;
  yaw: THREE.Group;
  pitch: THREE.Group;
  doors: { pivot: THREE.Group; openAngle: number; axis: 'x' | 'y' }[];
  muzzles: THREE.Object3D[];
  /** Spinning barrel cluster (gatling). */
  spinner?: THREE.Group;
  /** Recoiling part (cannon barrel). */
  recoil?: THREE.Group;
  /** Materials that glow with barrel heat. */
  heatMats: THREE.MeshStandardNodeMaterial[];
  /** Missiles still in the tubes (hidden as they launch, restocked on retract). */
  rounds: THREE.Object3D[];
  /** The flamer's pilot light position. */
  pilot?: THREE.Object3D;
  /** Height the lift travels out of the compartment (m). */
  travel: number;
  /** Indicator lights that blink while deployed. */
  lamps: THREE.MeshBasicNodeMaterial[];
}

// ---------------------------------------------------------------- materials

const mats = {
  gun: () => new THREE.MeshStandardNodeMaterial({ color: 0x24272c, metalness: 0.92, roughness: 0.32 }),
  dark: () => new THREE.MeshStandardNodeMaterial({ color: 0x121315, metalness: 0.8, roughness: 0.5 }),
  steel: () => new THREE.MeshStandardNodeMaterial({ color: 0x8b9097, metalness: 1, roughness: 0.22 }),
  barrel: () => new THREE.MeshStandardNodeMaterial({ color: 0x2c2e31, metalness: 0.95, roughness: 0.28, emissive: 0xff3a00, emissiveIntensity: 0 }),
  brass: () => new THREE.MeshStandardNodeMaterial({ color: 0xc8962e, metalness: 1, roughness: 0.3 }),
  hazard: () => new THREE.MeshStandardNodeMaterial({ map: hazardTex(), metalness: 0.5, roughness: 0.45 }),
  tank: () => new THREE.MeshStandardNodeMaterial({ color: 0xb8320e, metalness: 0.6, roughness: 0.35 }),
  warhead: () => new THREE.MeshStandardNodeMaterial({ color: 0xd8d8d0, metalness: 0.3, roughness: 0.4 }),
  tip: () => new THREE.MeshStandardNodeMaterial({ color: 0xc81a10, metalness: 0.3, roughness: 0.4 }),
};

let hazard: THREE.CanvasTexture | null = null;
function hazardTex(): THREE.CanvasTexture {
  if (hazard) return hazard;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e8b400';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#141414';
  for (let i = -64; i < 128; i += 22) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 11, 0);
    g.lineTo(i + 11 - 64, 64);
    g.lineTo(i - 64, 64);
    g.fill();
  }
  hazard = new THREE.CanvasTexture(c);
  hazard.colorSpace = THREE.SRGBColorSpace;
  hazard.wrapS = hazard.wrapT = THREE.RepeatWrapping;
  return hazard;
}

function lamp(color: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.color.setHex(color);
  return m;
}

// ---------------------------------------------------------------- helpers

const X = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** A cylinder lying along +x (three cylinders stand along +y). */
function tube(r0: number, r1: number, len: number, seg = 20): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, X));
  g.translate(len / 2, 0, 0);
  return g;
}

function box(x: number, y: number, z: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(x, y, z);
}

/** Two hatch doors over the slot, hinged on their outer edges along y (or x). */
function hatch(slot: THREE.Group, w: number, d: number, axis: 'x' | 'y'): WeaponModel['doors'] {
  const doors: WeaponModel['doors'] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    if (axis === 'x') pivot.position.set(0, s * w / 2, 0);
    else pivot.position.set(s * d / 2, 0, 0);
    slot.add(pivot);
    const plate = axis === 'x' ? box(d, w / 2, 0.012) : box(d / 2, w, 0.012);
    const m = mesh(plate, mats.hazard(), pivot);
    if (axis === 'x') m.position.set(0, -s * w / 4, 0.006);
    else m.position.set(-s * d / 4, 0, 0.006);
    doors.push({ pivot, openAngle: (axis === 'x' ? -s : s) * 1.9, axis });
  }
  // The dark compartment floor visible when the doors are open.
  mesh(box(d * 0.95, w * 0.95, 0.01), mats.dark(), slot, 0, 0, -0.004);
  return doors;
}

function base(kind: WeaponKind, travel: number): WeaponModel {
  const slot = new THREE.Group();
  const lift = new THREE.Group();
  const yaw = new THREE.Group();
  const pitch = new THREE.Group();
  slot.add(lift);
  lift.add(yaw);
  yaw.add(pitch);
  slot.name = `weapon.${kind}`;
  return { kind, slot, lift, yaw, pitch, doors: [], muzzles: [], heatMats: [], rounds: [], travel, lamps: [] };
}

/** The telescoping post and turret ring every weapon rides on. */
function turret(w: WeaponModel, r: number, h: number) {
  const steel = mats.steel(), gun = mats.gun();
  mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.4, h, 16).rotateX(Math.PI / 2), steel, w.lift, 0, 0, -h / 2);
  mesh(new THREE.CylinderGeometry(r, r * 1.1, r * 0.35, 24).rotateX(Math.PI / 2), gun, w.yaw, 0, 0, r * 0.17);
  const l = lamp(0xff2a10);
  w.lamps.push(l);
  mesh(new THREE.SphereGeometry(r * 0.12, 10, 8), l, w.yaw, -r * 0.7, 0, r * 0.3);
}

// ---------------------------------------------------------------- the guns

function cannon(): WeaponModel {
  const w = base('cannon', 0.2);
  w.doors = hatch(w.slot, 0.18, 0.22, 'x');
  turret(w, 0.075, 0.2);
  w.pitch.position.z = 0.08;
  const gun = mats.gun(), dark = mats.dark(), steel = mats.steel(), barrel = mats.barrel();
  w.heatMats.push(barrel);
  // Cradle and breech.
  mesh(box(0.2, 0.13, 0.11), gun, w.pitch, -0.02, 0, 0);
  mesh(box(0.08, 0.15, 0.04), dark, w.pitch, -0.09, 0, 0.065);
  mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 12).rotateX(Math.PI / 2).rotateZ(0), steel, w.pitch, 0.02, 0, -0.07);
  const recoil = new THREE.Group();
  w.pitch.add(recoil);
  w.recoil = recoil;
  mesh(tube(0.042, 0.036, 0.42), barrel, recoil, 0.06, 0, 0.005);
  mesh(tube(0.05, 0.05, 0.05), steel, recoil, 0.06, 0, 0.005); // collar
  // Muzzle brake: a block with side vents.
  mesh(box(0.08, 0.1, 0.07), dark, recoil, 0.52, 0, 0.005);
  for (const s of [-1, 1]) mesh(box(0.05, 0.012, 0.045), steel, recoil, 0.52, s * 0.055, 0.005);
  // Recoil cylinders.
  for (const s of [-1, 1]) mesh(tube(0.012, 0.012, 0.22), steel, w.pitch, 0.02, s * 0.05, -0.04);
  // Ammo drum.
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 18), mats.brass(), w.pitch, -0.08, -0.1, 0);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.58, 0, 0.005);
  recoil.add(muzzle);
  w.muzzles.push(muzzle);
  return w;
}

function gatling(): WeaponModel {
  const w = base('gatling', 0.18);
  w.doors = hatch(w.slot, 0.18, 0.2, 'x');
  turret(w, 0.07, 0.18);
  w.pitch.position.z = 0.075;
  const gun = mats.gun(), dark = mats.dark(), steel = mats.steel();
  // Motor housing and ammo box with a brass belt.
  mesh(tube(0.055, 0.055, 0.14), gun, w.pitch, -0.08, 0, 0);
  mesh(box(0.12, 0.08, 0.1), dark, w.pitch, -0.04, -0.1, -0.01);
  for (let i = 0; i < 6; i++) mesh(box(0.012, 0.012, 0.03), mats.brass(), w.pitch, -0.08 + i * 0.018, -0.055, 0.02);
  const spinner = new THREE.Group();
  spinner.position.x = 0.06;
  w.pitch.add(spinner);
  w.spinner = spinner;
  const hot = mats.barrel();
  w.heatMats.push(hot);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    mesh(tube(0.011, 0.011, 0.34, 10), hot, spinner, 0, Math.cos(a) * 0.028, Math.sin(a) * 0.028);
  }
  mesh(tube(0.045, 0.045, 0.02), steel, spinner, 0.08, 0, 0);
  mesh(tube(0.045, 0.045, 0.02), steel, spinner, 0.3, 0, 0);
  mesh(tube(0.016, 0.016, 0.36), dark, spinner, 0, 0, 0); // centre spindle
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.41, 0, 0);
  w.pitch.add(muzzle);
  w.muzzles.push(muzzle);
  return w;
}

function flamer(): WeaponModel {
  const w = base('flamer', 0.17);
  w.doors = hatch(w.slot, 0.17, 0.2, 'x');
  turret(w, 0.065, 0.17);
  w.pitch.position.z = 0.07;
  const gun = mats.gun(), steel = mats.steel(), tank = mats.tank(), dark = mats.dark();
  // Twin fuel tanks with steel bands, a feed line and a long nozzle with a cooling shroud.
  for (const s of [-1, 1]) {
    mesh(tube(0.035, 0.035, 0.17, 16), tank, w.pitch, -0.12, s * 0.045, 0.01);
    mesh(tube(0.038, 0.038, 0.012, 16), steel, w.pitch, -0.09, s * 0.045, 0.01);
    mesh(tube(0.038, 0.038, 0.012, 16), steel, w.pitch, 0.0, s * 0.045, 0.01);
  }
  mesh(box(0.1, 0.06, 0.06), gun, w.pitch, 0.06, 0, -0.01);
  const shroud = mats.barrel();
  w.heatMats.push(shroud);
  mesh(tube(0.03, 0.022, 0.26, 16), shroud, w.pitch, 0.1, 0, -0.01);
  for (let i = 0; i < 5; i++) mesh(tube(0.034, 0.034, 0.008, 16), dark, w.pitch, 0.14 + i * 0.04, 0, -0.01);
  mesh(tube(0.016, 0.02, 0.05, 12), steel, w.pitch, 0.36, 0, -0.01);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.42, 0, -0.01);
  w.pitch.add(muzzle);
  w.muzzles.push(muzzle);
  const pilot = new THREE.Object3D();
  pilot.position.set(0.41, 0, -0.035);
  w.pitch.add(pilot);
  w.pilot = pilot;
  return w;
}

function missiles(): WeaponModel {
  const w = base('missiles', 0.22);
  w.doors = hatch(w.slot, 0.22, 0.22, 'x');
  turret(w, 0.07, 0.22);
  w.pitch.position.z = 0.1;
  const gun = mats.gun(), dark = mats.dark(), wh = mats.warhead(), tip = mats.tip();
  // A 2×3 pod with an armoured cowl.
  mesh(box(0.24, 0.2, 0.14), gun, w.pitch, 0.02, 0, 0);
  mesh(box(0.05, 0.22, 0.16), dark, w.pitch, -0.12, 0, 0);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const y = (col - 1) * 0.06, z = (row - 0.5) * 0.065;
      mesh(tube(0.026, 0.026, 0.02), dark, w.pitch, 0.135, y, z);
      const m = new THREE.Group();
      m.position.set(0.1, y, z);
      w.pitch.add(m);
      mesh(tube(0.017, 0.017, 0.06, 10), wh, m, 0, 0, 0);
      mesh(new THREE.ConeGeometry(0.017, 0.035, 10).rotateZ(-Math.PI / 2), tip, m, 0.077, 0, 0);
      w.rounds.push(m);
      const mz = new THREE.Object3D();
      mz.position.set(0.15, y, z);
      w.pitch.add(mz);
      w.muzzles.push(mz);
    }
  }
  const l = lamp(0x30ff60);
  w.lamps.push(l);
  mesh(new THREE.SphereGeometry(0.01, 8, 6), l, w.pitch, 0.13, 0.1, 0.075);
  return w;
}

export const BUILD: Record<WeaponKind, () => WeaponModel> = { cannon, gatling, flamer, missiles };

/** A small missile body for flight (the round that leaves the tube). */
export function missileMesh(): THREE.Group {
  const g = new THREE.Group();
  mesh(tube(0.02, 0.02, 0.16, 10), mats.warhead(), g, -0.08, 0, 0);
  mesh(new THREE.ConeGeometry(0.02, 0.05, 10).rotateZ(-Math.PI / 2), mats.tip(), g, 0.105, 0, 0);
  for (let i = 0; i < 4; i++) {
    const f = mesh(box(0.04, 0.003, 0.03), mats.dark(), g, -0.07, 0, 0);
    f.rotation.x = (i * Math.PI) / 2;
    f.position.set(-0.07, Math.cos((i * Math.PI) / 2) * 0.025, Math.sin((i * Math.PI) / 2) * 0.025);
  }
  return g;
}

/** A glowing cannon slug. */
export function shellMesh(): THREE.Mesh {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  m.color.setRGB(8, 4.5, 1.4);
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), m);
  s.scale.set(3, 1, 1);
  s.frustumCulled = false;
  return s;
}
