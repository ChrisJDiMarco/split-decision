// The raised platform: apron walkway, LED-banner skirt, steps up to each gate, the arena
// floor, a barricade and the cageside tables. Built in the physics frame (z-up), with the
// canvas at z = 0 and the arena floor at z = -PLATFORM_HEIGHT_M.
import * as THREE from 'three/webgpu';
import { texture, time, uv, vec2, vec3 } from 'three/tsl';
import { ARENA, CIRCUMRADIUS, panels } from '../../core/arena-spec';
import { gatePanels } from './cage';
import { DISPLAY_FONT, makeCanvas } from './util';

const H = ARENA.PLATFORM_HEIGHT_M;
/** Outer corner radius of the platform (posts + apron). */
export const PLATFORM_RADIUS_M = CIRCUMRADIUS + ARENA.APRON_M;
/** Flat-to-centre distance of the platform edge. */
export const PLATFORM_APOTHEM_M = PLATFORM_RADIUS_M * Math.cos(Math.PI / ARENA.SIDES);

const BANNER_TOP_Z = -0.2;
const BANNER_BOTTOM_Z = -0.95;
const BANNER_TEX_ASPECT = 16; // 2048 x 128
const BANNER_SCROLL_PER_S = 0.018;
const BANNER_GLOW = 1.6;
const STRIP_GLOW = 3.2;
const STEP_COUNT = 6;
const STEP_RUN_M = 0.32;
const STEP_WIDTH_M = 1.3;
const FLOOR_RADIUS_M = 60;
export const BARRICADE_RADIUS_M = PLATFORM_APOTHEM_M + 4.2;

function polygon(radius: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    out.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return out;
}

function bannerTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(2048, 128);
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return null;
  ctx.fillStyle = '#050506';
  ctx.fillRect(0, 0, 2048, 128);
  const items: Array<[string, string]> = [
    ['JEV KUNE DO', '#f3efe6'], ['POWERED BY JEV', '#ff5a36'], ['TYPESAFE AI', '#f3efe6'],
    ['KILN FORGE', '#ffb347'], ['HYDRAULIX', '#3fd0c4'], ['CAGE 01', '#6d9bff'],
  ];
  ctx.font = `italic 800 84px ${DISPLAY_FONT}`;
  ctx.textBaseline = 'middle';
  let x = 30;
  const slot = 2048 / items.length;
  items.forEach(([label, color], i) => {
    ctx.fillStyle = color;
    const w = Math.min(ctx.measureText(label).width, slot - 60);
    ctx.fillText(label, x, 68, w);
    ctx.fillStyle = i % 2 ? '#1d4bb3' : '#b3231b';
    ctx.fillRect(x + w + 18, 40, 10, 56);
    x += slot;
  });
  // LED pixel grid.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let gx = 0; gx < 2048; gx += 4) ctx.fillRect(gx, 0, 1, 128);
  for (let gy = 0; gy < 128; gy += 4) ctx.fillRect(0, gy, 2048, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function buildApron(mat: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(polygon(PLATFORM_RADIUS_M));
  shape.holes.push(new THREE.Path(polygon(CIRCUMRADIUS - 0.02)));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
  mesh.position.z = -0.004;
  mesh.receiveShadow = true;
  return mesh;
}

function buildSkirt(): THREE.Group {
  const g = new THREE.Group();
  const pts = polygon(PLATFORM_RADIUS_M);
  const sideLen = pts[0].distanceTo(pts[1]);
  const bannerH = BANNER_TOP_Z - BANNER_BOTTOM_Z;
  const repeatsPerSide = sideLen / bannerH / BANNER_TEX_ASPECT;
  const tex = bannerTexture();
  const black = new THREE.MeshStandardNodeMaterial({ color: 0x0a0a0b, roughness: 0.6 });
  const trim = new THREE.MeshStandardNodeMaterial({ color: 0x2a2c30, roughness: 0.3, metalness: 1 });
  const strip = new THREE.MeshBasicNodeMaterial();
  strip.colorNode = vec3(0.75, 0.85, 1).mul(STRIP_GLOW);

  const banner = new THREE.MeshBasicNodeMaterial();
  if (tex) {
    banner.colorNode = texture(tex, uv().add(vec2(time.mul(BANNER_SCROLL_PER_S), 0))).rgb.mul(BANNER_GLOW);
  } else {
    banner.colorNode = vec3(0.02);
  }

  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % ARENA.SIDES];
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const yaw = Math.atan2(b.y - a.y, b.x - a.x);
    const face = new THREE.Group();
    face.position.set(mid.x, mid.y, 0);
    face.rotation.set(Math.PI / 2, 0, 0);
    face.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), yaw);
    // After the rotations: local x runs along the side, local y is up, local +z points outward.
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(sideLen, H), black);
    wall.position.y = -H / 2;
    const screenGeo = new THREE.PlaneGeometry(sideLen, bannerH);
    const uvs = screenGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < uvs.count; k++) uvs.setX(k, (i + uvs.getX(k)) * repeatsPerSide);
    const screen = new THREE.Mesh(screenGeo, banner);
    screen.position.set(0, (BANNER_TOP_Z + BANNER_BOTTOM_Z) / 2, 0.004);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(sideLen, 0.07, 0.05), trim);
    lip.position.set(0, -0.035, 0.0);
    const led = new THREE.Mesh(new THREE.BoxGeometry(sideLen, 0.012, 0.01), strip);
    led.position.set(0, -0.085, 0.02);
    face.add(wall, screen, lip, led);
    g.add(face);
  }
  return g;
}

function buildSteps(normalAngle: number, plate: THREE.Material, rail: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.rotation.z = normalAngle; // local +x points away from the cage
  const rise = H / STEP_COUNT;
  for (let k = 1; k < STEP_COUNT; k++) {
    const top = -k * rise;
    const height = H + top;
    const step = new THREE.Mesh(new THREE.BoxGeometry(STEP_RUN_M, STEP_WIDTH_M, height), plate);
    step.position.set(PLATFORM_APOTHEM_M + STEP_RUN_M * (k - 0.5), 0, -H + height / 2);
    step.castShadow = step.receiveShadow = true;
    g.add(step);
  }
  const run = STEP_RUN_M * (STEP_COUNT - 1);
  for (const side of [-1, 1]) {
    const y = side * (STEP_WIDTH_M / 2 - 0.04);
    const a = new THREE.Vector3(PLATFORM_APOTHEM_M, y, 0.9);
    const b = new THREE.Vector3(PLATFORM_APOTHEM_M + run, y, -H + 0.9);
    const handrail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, a.distanceTo(b), 10), rail);
    handrail.position.copy(a).add(b).multiplyScalar(0.5);
    handrail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(handrail);
    for (const [px, pz] of [[a.x, a.z], [b.x, b.z]]) {
      const postH = 0.9;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, postH, 10), rail);
      post.rotation.x = Math.PI / 2;
      post.position.set(px, y, pz - postH / 2);
      g.add(post);
    }
  }
  return g;
}

function buildTable(angle: number, cloth: THREE.Material, screen: THREE.Material, dark: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const r = PLATFORM_APOTHEM_M + 2.3;
  g.position.set(Math.cos(angle) * r, Math.sin(angle) * r, -H);
  g.rotation.z = angle + Math.PI / 2; // local -y faces the cage
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.76), cloth);
  top.position.z = 0.38;
  g.add(top);
  for (const x of [-0.7, 0, 0.7]) {
    const mon = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.32), dark);
    mon.position.set(x, 0.05, 0.76 + 0.2);
    mon.rotation.x = -0.25;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.28), screen);
    glow.position.set(x, 0.026, 0.76 + 0.2);
    glow.rotation.x = Math.PI / 2 - 0.25;
    g.add(mon, glow);
  }
  return g;
}

export interface PlatformView {
  group: THREE.Group;
}

export function buildPlatform(): PlatformView {
  const group = new THREE.Group();
  group.name = 'arena-platform';
  const apronMat = new THREE.MeshStandardNodeMaterial({ color: 0x17181a, roughness: 0.68 });
  const plate = new THREE.MeshStandardNodeMaterial({ color: 0x3a3d42, roughness: 0.42, metalness: 0.9 });
  const rail = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a6, roughness: 0.3, metalness: 1 });
  const floor = new THREE.MeshStandardNodeMaterial({ color: 0x0d0e10, roughness: 0.5, metalness: 0.1 });
  const cloth = new THREE.MeshStandardNodeMaterial({ color: 0x0c0c0e, roughness: 0.9 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x050506, roughness: 0.4 });
  const screen = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0.55, 0.75, 1.3) });

  group.add(buildApron(apronMat), buildSkirt());
  const floorMesh = new THREE.Mesh(new THREE.CircleGeometry(FLOOR_RADIUS_M, 64), floor);
  floorMesh.position.z = -H;
  floorMesh.receiveShadow = true;
  group.add(floorMesh);

  const ps = panels();
  const gates = gatePanels();
  for (const gi of gates) group.add(buildSteps(ps[gi].normalAngle, plate, rail));
  for (const gi of gates) {
    for (const off of [-0.62, 0.62]) group.add(buildTable(ps[gi].normalAngle + off, cloth, screen, dark));
  }

  const barricadeMat = new THREE.MeshStandardNodeMaterial({ color: 0x08080a, roughness: 0.55, side: THREE.DoubleSide });
  const barricade = new THREE.Mesh(new THREE.CylinderGeometry(BARRICADE_RADIUS_M, BARRICADE_RADIUS_M, 1.05, 96, 1, true), barricadeMat);
  barricade.rotation.x = Math.PI / 2;
  barricade.position.z = -H + 0.525;
  group.add(barricade);
  return { group };
}
