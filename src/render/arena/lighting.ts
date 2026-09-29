// Broadcast lighting rig (three.js world, y-up, canvas at y = 0): a box-truss ring with a
// centre cross, fixture cans with glowing lenses, one hard shadow-casting overhead key
// that pools on the canvas, warm/cool rim spots, a low hemisphere fill, and additive
// haze cones that fake volumetric beams through the fog.
import * as THREE from 'three/webgpu';
import {
  abs, dot, float, mx_noise_float, normalView, positionGeometry, positionViewDirection,
  positionView, positionWorld, pow, smoothstep, time, vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA, CIRCUMRADIUS } from '../../core/arena-spec';
import { seededRandom } from './util';

export const TRUSS_Y = 7.4;
const TRUSS_RADIUS = CIRCUMRADIUS + 1.0;
const TRUSS_SECTION = 0.3;
const TRUSS_CHORD_R = 0.024;
const TRUSS_LACE_R = 0.011;

const KEY_INTENSITY = 210;
const KEY_ANGLE = 0.62;
const KEY_PENUMBRA = 0.55;
const RIM_INTENSITY = 110;
const HEMI_INTENSITY = 0.3;
const WARM = new THREE.Color(1.0, 0.64, 0.34);
const COOL = new THREE.Color(0.82, 0.9, 1.0);
const LENS_GLOW = 26;
const CONE_HAZE = 0.1;
const AIM_POINT = new THREE.Vector3(0, 0.9, 0);
const KEY_Y = TRUSS_Y - 0.5;
const KEY_HAZE = 0.3;
const KEY_HAZE_SPREAD = 0.8; // column half-angle as a fraction of the key's cone
const HAZE_NEAR_M = 3;
const HAZE_FAR_M = 9;

export type ShadowQuality = 'high' | 'medium' | 'low';
const SHADOW_MAP: Record<ShadowQuality, number> = { high: 4096, medium: 2048, low: 1024 };

/** One metre of box truss along +x: four chords plus zig-zag lacing on each face. */
function trussSegmentGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const h = TRUSS_SECTION / 2;
  const up = new THREE.Vector3(0, 1, 0);
  const rod = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), 6, 1, true);
    const q = new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize());
    g.applyQuaternion(q);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    g.translate(mid.x, mid.y, mid.z);
    parts.push(g);
  };
  const corners: Array<[number, number]> = [[h, h], [h, -h], [-h, -h], [-h, h]];
  for (const [y, z] of corners) rod(new THREE.Vector3(-0.5, y, z), new THREE.Vector3(0.5, y, z), TRUSS_CHORD_R);
  for (let f = 0; f < 4; f++) {
    const [y0, z0] = corners[f];
    const [y1, z1] = corners[(f + 1) % 4];
    for (let k = 0; k < 2; k++) {
      const x0 = -0.5 + k * 0.5;
      rod(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x0 + 0.5, y1, z1), TRUSS_LACE_R);
    }
  }
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('arena: truss geometry merge failed');
  return merged;
}

function trussEdges(): Array<[THREE.Vector3, THREE.Vector3]> {
  const edges: Array<[THREE.Vector3, THREE.Vector3]> = [];
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * TRUSS_RADIUS, TRUSS_Y, Math.sin(a) * TRUSS_RADIUS));
  }
  pts.forEach((p, i) => edges.push([p, pts[(i + 1) % pts.length]]));
  const r = TRUSS_RADIUS * Math.cos(Math.PI / ARENA.SIDES);
  edges.push([new THREE.Vector3(-r, TRUSS_Y, 0), new THREE.Vector3(r, TRUSS_Y, 0)]);
  edges.push([new THREE.Vector3(0, TRUSS_Y, -r), new THREE.Vector3(0, TRUSS_Y, r)]);
  return edges;
}

function buildTruss(): THREE.InstancedMesh {
  const edges = trussEdges();
  const matrices: THREE.Matrix4[] = [];
  const xAxis = new THREE.Vector3(1, 0, 0);
  for (const [a, b] of edges) {
    const len = a.distanceTo(b);
    const n = Math.max(1, Math.round(len));
    const dir = b.clone().sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(xAxis, dir);
    for (let k = 0; k < n; k++) {
      const pos = a.clone().addScaledVector(dir, ((k + 0.5) / n) * len);
      matrices.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(len / n, 1, 1)));
    }
  }
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.34 });
  const mesh = new THREE.InstancedMesh(trussSegmentGeometry(), mat, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.frustumCulled = false;
  return mesh;
}

interface Fixture {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  color: THREE.Color;
  beam: boolean;
  spread: number; // cone half-angle
  haze: number; // beam brightness multiplier
}

function fixtureLayout(): Fixture[] {
  const rnd = seededRandom(0x7195);
  const out: Fixture[] = [];
  const hang = TRUSS_Y - TRUSS_SECTION / 2 - 0.25;
  const count = ARENA.SIDES * 2;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.2;
    const r = TRUSS_RADIUS * 0.97;
    const pos = new THREE.Vector3(Math.cos(a) * r, hang, Math.sin(a) * r);
    const aim = new THREE.Vector3((rnd() - 0.5) * 2.4, AIM_POINT.y * rnd(), (rnd() - 0.5) * 2.4);
    out.push({ pos, dir: aim.sub(pos).normalize(), color: rnd() < 0.45 ? WARM : COOL, beam: i % 2 === 0, spread: 0.1 + rnd() * 0.06, haze: 1 });
  }
  const r = TRUSS_RADIUS * 0.55;
  for (const [x, z] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
    const pos = new THREE.Vector3(x, hang, z);
    out.push({ pos, dir: new THREE.Vector3(-x * 0.15, -hang, -z * 0.15).normalize(), color: COOL, beam: true, spread: 0.16, haze: 1 });
  }
  return out;
}

function buildFixtures(fixtures: Fixture[]): THREE.Group {
  const g = new THREE.Group();
  const housingGeo = new THREE.CylinderGeometry(0.13, 0.1, 0.38, 14);
  const lensGeo = new THREE.CircleGeometry(0.105, 18);
  lensGeo.rotateX(Math.PI / 2); // faces -y, the fixture's aim axis
  lensGeo.translate(0, -0.195, 0);
  const housingMat = new THREE.MeshStandardNodeMaterial({ color: 0x111214, metalness: 0.7, roughness: 0.5 });
  const lensMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  lensMat.fog = false;
  const housing = new THREE.InstancedMesh(housingGeo, housingMat, fixtures.length);
  const lens = new THREE.InstancedMesh(lensGeo, lensMat, fixtures.length);
  const down = new THREE.Vector3(0, -1, 0);
  const m = new THREE.Matrix4();
  fixtures.forEach((f, i) => {
    m.compose(f.pos, new THREE.Quaternion().setFromUnitVectors(down, f.dir), new THREE.Vector3(1, 1, 1));
    housing.setMatrixAt(i, m);
    lens.setMatrixAt(i, m);
    lens.setColorAt(i, f.color.clone().multiplyScalar(LENS_GLOW));
  });
  housing.frustumCulled = lens.frustumCulled = false;
  g.add(housing, lens);
  return g;
}

function hazeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  // Outer walls only: from outside a beam this is its near half (CONE_HAZE is doubled to
  // match), and from inside one nothing draws, so a camera in the light never whites out.
  m.side = THREE.FrontSide;
  m.fog = false;
  const t = positionGeometry.y.negate(); // 0 at the lens, 1 at the canvas
  const edge = pow(abs(dot(normalView, positionViewDirection)), 1.6);
  const axial = smoothstep(0, 0.06, t).mul(pow(float(1).sub(t).max(0), 1.3));
  const drift = vec3(time.mul(0.07), time.mul(-0.05), time.mul(0.04));
  const swirl = mx_noise_float(positionWorld.mul(0.55).add(drift)).mul(0.45).add(0.8);
  // Fade the beam wall as the camera approaches it, instead of a white-out.
  const nearCam = smoothstep(HAZE_NEAR_M, HAZE_FAR_M, positionView.length());
  m.colorNode = vec3(CONE_HAZE).mul(edge).mul(axial).mul(swirl).mul(nearCam);
  return m;
}

function buildCones(beams: Fixture[]): THREE.InstancedMesh {
  const geo = new THREE.ConeGeometry(1, 1, 28, 1, true);
  geo.translate(0, -0.5, 0); // apex at the origin, base at y = -1
  const mesh = new THREE.InstancedMesh(geo, hazeMaterial(), beams.length);
  const down = new THREE.Vector3(0, -1, 0);
  const m = new THREE.Matrix4();
  beams.forEach((f, i) => {
    const length = f.pos.y / Math.max(0.2, -f.dir.y); // reach the canvas plane
    const radius = Math.tan(f.spread) * length;
    m.compose(f.pos, new THREE.Quaternion().setFromUnitVectors(down, f.dir), new THREE.Vector3(radius, length, radius));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, f.color.clone().multiplyScalar(f.haze));
  });
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

function buildLights(group: THREE.Group, shadow: ShadowQuality): THREE.SpotLight {
  const key = new THREE.SpotLight(0xf4f6ff, KEY_INTENSITY, 0, KEY_ANGLE, KEY_PENUMBRA, 2);
  key.position.set(0, KEY_Y, 0);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(SHADOW_MAP[shadow]);
  key.shadow.camera.near = 3;
  key.shadow.camera.far = TRUSS_Y + 1;
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.02;
  group.add(key, key.target);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rim = new THREE.SpotLight(i % 2 ? COOL : WARM, RIM_INTENSITY, 0, 0.36, 0.85, 2);
    rim.position.set(Math.cos(a) * TRUSS_RADIUS, TRUSS_Y - 0.6, Math.sin(a) * TRUSS_RADIUS);
    rim.target.position.set(-Math.cos(a) * 1.2, 1.2, -Math.sin(a) * 1.2);
    group.add(rim, rim.target);
  }
  group.add(new THREE.HemisphereLight(0x5b6679, 0x141110, HEMI_INTENSITY));
  return key;
}

export interface LightingView {
  group: THREE.Group;
  key: THREE.SpotLight;
  setShadowQuality(q: ShadowQuality): void;
}

export function buildLighting(shadow: ShadowQuality = 'high'): LightingView {
  const group = new THREE.Group();
  group.name = 'arena-lighting';
  const fixtures = fixtureLayout();
  // The key light's own column of lit haze over the whole canvas.
  const keyColumn: Fixture = {
    pos: new THREE.Vector3(0, KEY_Y, 0), dir: new THREE.Vector3(0, -1, 0), color: COOL,
    beam: true, spread: KEY_ANGLE * KEY_HAZE_SPREAD, haze: KEY_HAZE,
  };
  group.add(
    buildTruss(),
    buildFixtures([...fixtures, keyColumn]),
    buildCones([...fixtures.filter((f) => f.beam), keyColumn]),
  );
  const key = buildLights(group, shadow);
  return {
    group,
    key,
    setShadowQuality(q) {
      // The WebGPU shadow node resizes its render target from mapSize on its next update.
      key.shadow.mapSize.setScalar(SHADOW_MAP[q]);
    },
  };
}
