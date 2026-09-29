// Cage hardware: padded posts (red and blue on the fighters' corners), top-rail padding,
// the bottom kick rail and the two gate frames. Built in the physics frame (z-up).
import * as THREE from 'three/webgpu';
import { APOTHEM, ARENA, panels, postPositions } from '../../core/arena-spec';
import { DISPLAY_FONT, makeCanvas, sideBasis } from './util';

const POST_HEIGHT_M = ARENA.FENCE_HEIGHT_M + 0.12;
const STRAP_HEIGHTS_M = [0.32, 0.98, 1.64];
const GATE_WIDTH_M = 0.92;
const GATE_HEIGHT_M = 1.52;
const GATE_TUBE_R = 0.022;
const KICK_RAIL_H = 0.06;

export const RED_CORNER_POST = ARENA.SIDES / 2;
export const BLUE_CORNER_POST = 0;

/** Panel indices of the two gates: the sides whose normals point closest to ±y (away from the corners). */
export function gatePanels(): [number, number] {
  const ps = panels();
  let best = 0;
  let bestScore = -Infinity;
  ps.forEach((p, i) => {
    const score = Math.sin(p.normalAngle);
    if (score > bestScore + 1e-9) { bestScore = score; best = i; }
  });
  return [best, (best + ARENA.SIDES / 2) % ARENA.SIDES];
}

const PAD_TEX_W = 256;
const PAD_TEX_H = 1024;
const PAD_LABEL_CENTER_M = (STRAP_HEIGHTS_M[1] + STRAP_HEIGHTS_M[2]) / 2; // between the upper straps

function padTexture(base: string, ink: string, label: string): THREE.CanvasTexture | null {
  const c = makeCanvas(PAD_TEX_W, PAD_TEX_H);
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return null;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, PAD_TEX_W, PAD_TEX_H);
  // Stitched vertical seam at the back of the pad and horizontal seams between foam blocks.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, 3, PAD_TEX_H);
  for (const h of STRAP_HEIGHTS_M) ctx.fillRect(0, PAD_TEX_H * (1 - h / POST_HEIGHT_M) - 14, PAD_TEX_W, 3);
  // Label runs up the inward face (u = 0.5), squashed across so it is not stretched
  // around the (wider per pixel) circumference.
  const pxPerMetreV = PAD_TEX_H / POST_HEIGHT_M;
  const pxPerMetreU = PAD_TEX_W / (2 * Math.PI * ARENA.POST_PAD_RADIUS_M);
  ctx.save();
  ctx.translate(PAD_TEX_W / 2, PAD_TEX_H * (1 - PAD_LABEL_CENTER_M / POST_HEIGHT_M));
  ctx.rotate(-Math.PI / 2);
  ctx.scale(1, pxPerMetreU / pxPerMetreV);
  ctx.font = `italic 800 64px ${DISPLAY_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  ctx.fillText(label, 0, 0, pxPerMetreV * 0.56);
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function vinyl(color: number, map: THREE.Texture | null): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ color, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.38 });
  if (map) m.map = map;
  return m;
}

function buildPost(x: number, y: number, pad: THREE.Material, strap: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, 0);
  g.rotation.z = Math.atan2(-y, -x) - Math.PI / 2; // label (u = 0.5) faces the centre
  const body = new THREE.Mesh(new THREE.CylinderGeometry(ARENA.POST_PAD_RADIUS_M, ARENA.POST_PAD_RADIUS_M, POST_HEIGHT_M, 40, 1, true), pad);
  body.rotation.x = Math.PI / 2;
  body.position.z = POST_HEIGHT_M / 2;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(ARENA.POST_PAD_RADIUS_M, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2), pad);
  cap.rotation.x = Math.PI / 2;
  cap.scale.set(1, 0.35, 1);
  cap.position.z = POST_HEIGHT_M;
  g.add(body, cap);
  for (const h of STRAP_HEIGHTS_M) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(ARENA.POST_PAD_RADIUS_M + 0.005, ARENA.POST_PAD_RADIUS_M + 0.005, 0.05, 40, 1, true), strap);
    s.rotation.x = Math.PI / 2;
    s.position.z = h;
    g.add(s);
  }
  for (const m of g.children) m.castShadow = m.receiveShadow = true;
  return g;
}

function railAlong(normalAngle: number, radius: number, length: number, z: number, outward: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 6, 20), mat);
  const q = sideBasis(normalAngle);
  mesh.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
  const r = APOTHEM + outward;
  mesh.position.set(Math.cos(normalAngle) * r, Math.sin(normalAngle) * r, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildGate(normalAngle: number, steel: THREE.Material, latch: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const r = APOTHEM + 0.03;
  g.position.set(Math.cos(normalAngle) * r, Math.sin(normalAngle) * r, 0);
  g.quaternion.copy(sideBasis(normalAngle)); // x along the side, y up, z outward
  const tube = (from: THREE.Vector3, to: THREE.Vector3, radius = GATE_TUBE_R) => {
    const len = from.distanceTo(to);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 12), steel);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    m.castShadow = true;
    g.add(m);
  };
  const hw = GATE_WIDTH_M / 2;
  const h = GATE_HEIGHT_M;
  const bl = new THREE.Vector3(-hw, 0.02, 0);
  const br = new THREE.Vector3(hw, 0.02, 0);
  const tl = new THREE.Vector3(-hw, h, 0);
  const tr = new THREE.Vector3(hw, h, 0);
  tube(bl, tl);
  tube(br, tr);
  tube(tl, tr);
  tube(new THREE.Vector3(-hw, h * 0.5, 0), new THREE.Vector3(hw, h * 0.5, 0), GATE_TUBE_R * 0.7);
  // Uprights either side of the gate carry it to the top rail.
  tube(new THREE.Vector3(-hw - 0.06, 0, 0), new THREE.Vector3(-hw - 0.06, ARENA.FENCE_HEIGHT_M, 0), GATE_TUBE_R * 1.3);
  tube(new THREE.Vector3(hw + 0.06, 0, 0), new THREE.Vector3(hw + 0.06, ARENA.FENCE_HEIGHT_M, 0), GATE_TUBE_R * 1.3);
  for (const hy of [0.25, h - 0.25]) {
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 12), steel);
    hinge.position.set(-hw - 0.03, hy, 0.02);
    g.add(hinge);
  }
  const latchBox = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.06), latch);
  latchBox.position.set(hw - 0.02, h * 0.62, 0.04);
  latchBox.castShadow = true;
  g.add(latchBox);
  return g;
}

export interface CageView {
  group: THREE.Group;
}

export function buildCage(): CageView {
  const group = new THREE.Group();
  group.name = 'arena-cage';
  const black = vinyl(0xffffff, padTexture('#161618', 'rgba(232,228,218,0.85)', 'JEV KUNE DO'));
  const red = vinyl(0xffffff, padTexture('#a3201a', 'rgba(250,244,236,0.92)', 'RED CORNER'));
  const blue = vinyl(0xffffff, padTexture('#1b44a6', 'rgba(250,244,236,0.92)', 'BLUE CORNER'));
  const plain = vinyl(0x141416, null);
  const strap = new THREE.MeshStandardNodeMaterial({ color: 0x0b0b0c, roughness: 0.85 });
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0x1d1f22, roughness: 0.38, metalness: 0.85 });
  const latch = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a6, roughness: 0.25, metalness: 1 });

  postPositions().forEach(([x, y], i) => {
    const pad = i === RED_CORNER_POST ? red : i === BLUE_CORNER_POST ? blue : black;
    group.add(buildPost(x, y, pad, strap));
  });
  for (const p of panels()) {
    group.add(railAlong(p.normalAngle, ARENA.TOP_PAD_RADIUS_M, p.length, ARENA.FENCE_HEIGHT_M + ARENA.TOP_PAD_RADIUS_M * 0.3, 0, plain));
    group.add(railAlong(p.normalAngle, KICK_RAIL_H / 2, p.length, KICK_RAIL_H / 2, 0.01, strap));
  }
  const ps = panels();
  for (const gi of gatePanels()) group.add(buildGate(ps[gi].normalAngle, steel, latch));
  return { group };
}
