// Crowd (three.js world, y-up): stepped seating risers and a few thousand instanced
// low-poly people with idle sway, some standing, some with arms up, and phone lights that
// glow and occasionally flash. People are unlit (a baked spill term toward the cage) so
// the crowd costs one cheap draw per variant and reads as silhouettes against the haze.
import * as THREE from 'three/webgpu';
import {
  abs, clamp, dot, float, fract, hash, instanceIndex, max, normalView, normalWorld, normalize,
  positionGeometry, positionLocal, positionViewDirection, positionWorld, pow, sin, smoothstep, step,
  time, vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA } from '../../core/arena-spec';
import { BARRICADE_RADIUS_M } from './platform';
import { seededRandom } from './util';

const FLOOR_Y = -ARENA.PLATFORM_HEIGHT_M;
const FLOOR_ROWS = 3;
const RISER_ROWS = 17;
const ROW_DEPTH_M = 0.92;
const RISER_RISE_M = 0.46;
const RISER_GAP_M = 2.6; // walkway between floor seats and the first riser
const SEAT_PITCH_M = 0.6;
const FILL_RATE = 0.9;
const AISLES = 12;
const AISLE_HALF_WIDTH_M = 0.6;
const STAND_RATE = 0.12;
const ARMS_UP_RATE = 0.045;
const PHONE_RATE = 0.022;
const PHONE_GLOW = 7;
const FAN_COLOR_RATE = 0.16;

type Variant = 'seated' | 'standing' | 'cheering';

interface Seat {
  pos: THREE.Vector3;
  yaw: number;
  scale: THREE.Vector3;
  variant: Variant;
  color: THREE.Color;
}

const FIRST_ROW_RADIUS = BARRICADE_RADIUS_M + 2.2;
const FIRST_RISER_RADIUS = FIRST_ROW_RADIUS + FLOOR_ROWS * ROW_DEPTH_M + RISER_GAP_M;

function rowRadiusAndHeight(row: number): [number, number] {
  if (row < FLOOR_ROWS) return [FIRST_ROW_RADIUS + row * ROW_DEPTH_M, FLOOR_Y];
  const k = row - FLOOR_ROWS;
  return [FIRST_RISER_RADIUS + k * ROW_DEPTH_M + ROW_DEPTH_M * 0.5, FLOOR_Y + (k + 1) * RISER_RISE_M];
}

function personColor(rnd: () => number): THREE.Color {
  if (rnd() < FAN_COLOR_RATE) {
    return rnd() < 0.5 ? new THREE.Color().setHSL(0.0, 0.45, 0.17) : new THREE.Color().setHSL(0.62, 0.45, 0.18);
  }
  return new THREE.Color().setHSL(rnd(), 0.04 + rnd() * 0.16, 0.05 + rnd() * 0.12);
}

function layoutSeats(): Seat[] {
  const rnd = seededRandom(0xc40d);
  const seats: Seat[] = [];
  for (let row = 0; row < FLOOR_ROWS + RISER_ROWS; row++) {
    const [r, y] = rowRadiusAndHeight(row);
    const n = Math.floor((Math.PI * 2 * r) / SEAT_PITCH_M);
    for (let i = 0; i < n; i++) {
      const a = ((i + (row % 2) * 0.5) / n) * Math.PI * 2;
      const aislePhase = (a / (Math.PI * 2)) * AISLES;
      const fromAisle = Math.abs(aislePhase - Math.round(aislePhase)) * ((Math.PI * 2 * r) / AISLES);
      if (fromAisle < AISLE_HALF_WIDTH_M || rnd() > FILL_RATE) continue;
      const roll = rnd();
      const variant: Variant = roll < ARMS_UP_RATE ? 'cheering' : roll < STAND_RATE ? 'standing' : 'seated';
      const jitter = (rnd() - 0.5) * 0.12;
      seats.push({
        pos: new THREE.Vector3(Math.cos(a) * (r + jitter), y, Math.sin(a) * (r + jitter)),
        yaw: Math.PI / 2 - a + (rnd() - 0.5) * 0.5,
        variant,
        scale: new THREE.Vector3(0.88 + rnd() * 0.3, 0.9 + rnd() * 0.18, 0.9 + rnd() * 0.2),
        color: personColor(rnd),
      });
    }
  }
  return seats;
}

function capsule(radius: number, length: number, x: number, y: number, z: number, tiltZ = 0): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(radius, length, 2, 7);
  if (tiltZ) g.rotateZ(tiltZ);
  g.translate(x, y, z);
  return g;
}

function sphere(radius: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, 7, 5);
  g.translate(x, y, z);
  return g;
}

/** Person geometry facing -z (toward the cage after instancing), feet at y = 0. */
function personGeometry(variant: Variant): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (variant === 'seated') {
    parts.push(capsule(0.19, 0.28, 0, 0.8, 0), sphere(0.105, 0, 1.17, -0.02), capsule(0.1, 0.3, 0, 0.5, -0.2, Math.PI / 2));
  } else {
    parts.push(capsule(0.19, 0.34, 0, 1.2, 0), sphere(0.105, 0, 1.6, -0.02), capsule(0.1, 0.62, 0.1, 0.45, 0), capsule(0.1, 0.62, -0.1, 0.45, 0));
    if (variant === 'cheering') {
      parts.push(capsule(0.055, 0.55, 0.28, 1.72, 0, -0.35), capsule(0.055, 0.55, -0.28, 1.72, 0, 0.35));
    }
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  if (!merged) throw new Error('arena: crowd geometry merge failed');
  return merged;
}

function crowdMaterial(wave: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const phase = hash(instanceIndex).mul(6.283);
  const speed = hash(instanceIndex.add(7)).mul(0.9).add(0.6);
  const weight = clamp(positionGeometry.y.div(1.7), 0, 1);
  const sway = sin(time.mul(speed).add(phase)).mul(0.035).mul(weight);
  const bob = sin(time.mul(speed.mul(2.1)).add(phase)).mul(0.012);
  const raise = smoothstep(1.45, 2.0, positionGeometry.y).mul(sin(time.mul(speed.mul(3)).add(phase)).mul(wave));
  m.positionNode = positionLocal.add(vec3(sway.add(raise), bob, 0));

  // Baked light: spill from the cage on the side facing it, dimming with distance, plus sky fill.
  const toCage = normalize(vec3(positionWorld.x.negate(), float(4).sub(positionWorld.y), positionWorld.z.negate()));
  const facing = max(dot(normalWorld, toCage), 0);
  const dist = positionWorld.xz.length();
  const spill = smoothstep(32, 11, dist).mul(0.2).add(0.02);
  // Backlight from the house rig: a thin rim on the silhouette edges.
  const rim = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3).mul(0.14);
  const light = facing.mul(spill).add(normalWorld.y.max(0).mul(0.03)).add(rim).add(0.01);
  m.colorNode = vec3(light);
  return m;
}

function phoneMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const phase = hash(instanceIndex.add(101));
  const steady = step(0.35, phase); // most phones hold a steady light
  const flicker = sin(time.mul(phase.mul(3).add(1)).add(phase.mul(40))).mul(0.3).add(0.7);
  const flash = step(fract(time.mul(0.23).add(phase.mul(17))), 0.012).mul(6);
  m.colorNode = vec3(0.92, 0.95, 1).mul(PHONE_GLOW).mul(steady.mul(flicker).add(flash));
  return m;
}

export interface CrowdView {
  group: THREE.Group;
  count: number;
}

export function buildCrowd(): CrowdView {
  const group = new THREE.Group();
  group.name = 'arena-crowd';
  const seats = layoutSeats();
  group.add(buildRisers());

  const variants: Variant[] = ['seated', 'standing', 'cheering'];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const upAxis = new THREE.Vector3(0, 1, 0);
  for (const v of variants) {
    const list = seats.filter((s) => s.variant === v);
    if (list.length === 0) continue;
    const mesh = new THREE.InstancedMesh(personGeometry(v), crowdMaterial(v === 'cheering' ? 0.12 : 0), list.length);
    list.forEach((s, i) => {
      q.setFromAxisAngle(upAxis, s.yaw);
      mesh.setMatrixAt(i, m.compose(s.pos, q, s.scale));
      mesh.setColorAt(i, s.color);
    });
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  const rnd = seededRandom(0x9f0e);
  const phones = seats.filter(() => rnd() < PHONE_RATE);
  const phoneGeo = new THREE.PlaneGeometry(0.045, 0.08);
  const phoneMesh = new THREE.InstancedMesh(phoneGeo, phoneMaterial(), phones.length);
  phones.forEach((s, i) => {
    const head = s.variant === 'seated' ? 1.35 : 1.8;
    const toward = new THREE.Vector3(-s.pos.x, 0, -s.pos.z).normalize().multiplyScalar(0.28);
    q.setFromAxisAngle(upAxis, s.yaw);
    phoneMesh.setMatrixAt(i, m.compose(s.pos.clone().add(toward).setY(s.pos.y + head), q, one));
  });
  phoneMesh.frustumCulled = false;
  group.add(phoneMesh);
  return { group, count: seats.length };
}

function buildRisers(): THREE.Mesh {
  const profile: THREE.Vector2[] = [new THREE.Vector2(FIRST_RISER_RADIUS - 0.4, FLOOR_Y)];
  for (let k = 0; k < RISER_ROWS; k++) {
    const r0 = FIRST_RISER_RADIUS + k * ROW_DEPTH_M;
    const y = FLOOR_Y + (k + 1) * RISER_RISE_M;
    profile.push(new THREE.Vector2(r0, y), new THREE.Vector2(r0 + ROW_DEPTH_M, y));
  }
  const last = profile[profile.length - 1];
  profile.push(new THREE.Vector2(last.x + 0.5, last.y + 3), new THREE.Vector2(last.x + 0.6, last.y + 12));
  const geo = new THREE.LatheGeometry(profile, 96);
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x0b0c0e, roughness: 0.9, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, mat);
}
