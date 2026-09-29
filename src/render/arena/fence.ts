// Chain-link fence: black vinyl-coated diamond weave drawn analytically in the fragment
// shader. Wire coverage is box-filtered over the pixel footprint, so it is crisp close up
// and fades to the right average density at distance with no moiré or shimmer. Each panel
// bows outward on impact (vertex displacement) and springs back as a damped oscillator.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs, clamp, dot, float, floor, fract, fwidth, max, min, mix, normalMap, normalize,
  positionGeometry, positionLocal, positionViewDirection, normalView, sin, smoothstep, sqrt,
  uniform, vec2, vec3,
} from 'three/tsl';
import { ARENA, panels } from '../../core/arena-spec';
import type { Vec3 } from '../../core/types';
import { sideBasis } from './util';

const DIAMOND_SPACING_M = 0.05; // distance between parallel wires
const WIRE_DIAMETER_M = 0.0045; // vinyl-coated 9 gauge
const PANEL_SEGMENTS_U = 28;
const PANEL_SEGMENTS_V = 18;

// Bow dynamics (per panel): a damped spring driven by impact impulses.
const BOW_FREQ_HZ = 2.6;
const BOW_DAMPING_RATIO = 0.16;
const BOW_SIGMA_M = 0.65; // radius of the bulge
const BOW_VELOCITY_PER_STRENGTH = 2.2; // m/s of bulge velocity for strength 1 (~0.12 m peak)
const BOW_MAX_M = 0.2;
const BOW_MAX_DT = 1 / 30;
const BOW_MAX_REACH_M = 1.0; // impacts farther than this from the fence plane are ignored

interface PanelState {
  mesh: THREE.Mesh;
  normalAngle: number;
  center: [number, number];
  length: number;
  amp: number; // m, outward
  vel: number; // m/s
  impact: THREE.Vector2; // local (along, up) of the last impact
}

type F = Node<'float'>;

/** Box-filtered pulse train: fraction of [x - w/2, x + w/2] covered by lines of width f centred on integers. */
function filteredLines(x: F, w: F, f: F): F {
  const integral = (t: F): F => floor(t).mul(f).add(min(fract(t), f));
  const a = x.add(f.mul(0.5)).add(w.mul(0.5));
  const b = x.add(f.mul(0.5)).sub(w.mul(0.5));
  return clamp(integral(a).sub(integral(b)).div(w), 0, 1);
}

const bowOf = (o: THREE.Object3D | null): PanelState => o?.userData.bow as PanelState;

function createFenceMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.color = new THREE.Color(0x0c0d0f);
  m.roughness = 0.42;
  m.metalness = 0;

  // Per-object bow uniforms: one material shared by every panel.
  const amp = uniform(0).onObjectUpdate(({ object }) => bowOf(object).amp);
  const impact = uniform(new THREE.Vector2()).onObjectUpdate(({ object }) => bowOf(object).impact);
  const halfLen = uniform(1).onObjectUpdate(({ object }) => bowOf(object).length / 2);
  const height = float(ARENA.FENCE_HEIGHT_M);

  const p = positionGeometry.xy; // local metres: x along the side (centred), y up from the canvas
  const d = p.sub(impact);
  const bulge = d.dot(d).div(-2 * BOW_SIGMA_M * BOW_SIGMA_M).exp();
  const edgeU = sin(clamp(p.x.div(halfLen).mul(0.5).add(0.5), 0, 1).mul(Math.PI));
  const edgeV = sin(clamp(p.y.div(height), 0, 1).mul(Math.PI));
  const shape: F = bulge.mul(edgeU).mul(edgeV);
  m.positionNode = positionLocal.add(vec3(0, 0, amp.mul(shape)));
  // Surface slope of the bulge (edge taper ignored) so it catches the light face-on too.
  const slope: Node<'vec2'> = d.mul(amp.mul(shape).div(-BOW_SIGMA_M * BOW_SIGMA_M));

  // Diamond coordinates: wires lie along the two diagonals.
  const s = 1 / (DIAMOND_SPACING_M * Math.SQRT2);
  const a = p.x.add(p.y).mul(s);
  const b = p.x.sub(p.y).mul(s);
  const f = float(WIRE_DIAMETER_M / DIAMOND_SPACING_M);
  const wa = max(fwidth(a), 1e-4);
  const wb = max(fwidth(b), 1e-4);
  const ca = filteredLines(a, wa, f);
  const cb = filteredLines(b, wb, f);
  const flat = float(1).sub(ca).mul(float(1).sub(cb)).oneMinus();
  // Seen at a grazing angle the woven wire overlaps itself, so it reads denser.
  const ndv = abs(dot(normalView, positionViewDirection));
  const grazing = mix(float(3.2), float(1), smoothstep(0.05, 0.6, ndv));
  m.opacityNode = float(1).sub(float(1).sub(flat).pow(grazing));

  // Round-wire normal close up; flattens out once a wire is under a pixel wide.
  const offA = fract(a.add(0.5)).sub(0.5).div(f.mul(0.5));
  const offB = fract(b.add(0.5)).sub(0.5).div(f.mul(0.5));
  const useA = abs(offA).lessThan(abs(offB));
  const off = clamp(useA.select(offA, offB), -1, 1);
  const acrossY: F = useA.select(float(Math.SQRT1_2), float(-Math.SQRT1_2));
  const across = vec2(Math.SQRT1_2, acrossY);
  const detail = smoothstep(0.9, 0.25, useA.select(wa, wb).div(f));
  const tilt: Node<'vec2'> = across.mul(off).mul(detail).sub(slope);
  const lift: F = sqrt(float(1).sub(off.mul(off)).max(0.05));
  const tangentN = normalize(vec3(tilt, lift));
  m.normalNode = normalMap(tangentN.mul(0.5).add(0.5));
  return m;
}

export interface FenceView {
  group: THREE.Group;
  panels: PanelState[];
  /** Bows the panel nearest a physics-frame point. `strength` ~1 is a heavy robot slammed at ~3 m/s. */
  bow(worldPos: Vec3 | THREE.Vector3, strength: number): void;
  update(dt: number): void;
}

function toTuple(p: Vec3 | THREE.Vector3): Vec3 {
  return Array.isArray(p) ? p : [p.x, p.y, p.z];
}

export function buildFence(): FenceView {
  const group = new THREE.Group();
  group.name = 'arena-fence';
  const material = createFenceMaterial();
  const states: PanelState[] = panels().map((pn) => {
    const geo = new THREE.PlaneGeometry(pn.length, ARENA.FENCE_HEIGHT_M, PANEL_SEGMENTS_U, PANEL_SEGMENTS_V);
    geo.translate(0, ARENA.FENCE_HEIGHT_M / 2, 0);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(pn.center[0], pn.center[1], 0);
    mesh.quaternion.copy(sideBasis(pn.normalAngle));
    mesh.renderOrder = 2;
    mesh.frustumCulled = false; // displaced vertices can leave the static bounds
    const state: PanelState = {
      mesh, normalAngle: pn.normalAngle, center: pn.center, length: pn.length,
      amp: 0, vel: 0, impact: new THREE.Vector2(0, ARENA.FENCE_HEIGHT_M / 2),
    };
    mesh.userData.bow = state;
    group.add(mesh);
    return state;
  });

  const omega = 2 * Math.PI * BOW_FREQ_HZ;
  return {
    group,
    panels: states,
    bow(worldPos, strength) {
      if (!(strength > 0)) return;
      const [x, y, z] = toTuple(worldPos);
      // A NaN impact point would poison the panel's shader uniforms until its next hit.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      let best: PanelState | null = null;
      let bestDist = Infinity;
      for (const s of states) {
        const nx = Math.cos(s.normalAngle);
        const ny = Math.sin(s.normalAngle);
        const along = -ny * (x - s.center[0]) + nx * (y - s.center[1]);
        const depth = Math.abs(nx * (x - s.center[0]) + ny * (y - s.center[1]));
        const outside = Math.max(0, Math.abs(along) - s.length / 2);
        const dist = Math.hypot(depth, outside);
        if (dist < bestDist) { bestDist = dist; best = s; }
      }
      if (!best || bestDist > BOW_MAX_REACH_M) return;
      const nx = Math.cos(best.normalAngle);
      const ny = Math.sin(best.normalAngle);
      const along = -ny * (x - best.center[0]) + nx * (y - best.center[1]);
      best.impact.set(
        THREE.MathUtils.clamp(along, -best.length / 2, best.length / 2),
        THREE.MathUtils.clamp(z, 0.2, ARENA.FENCE_HEIGHT_M - 0.2),
      );
      best.vel += Math.min(strength, 3) * BOW_VELOCITY_PER_STRENGTH;
    },
    update(dt) {
      // Math.max(NaN, 0) is NaN, which would stick in every moving panel's state for good.
      if (!(dt > 0)) return;
      const h = Math.min(dt, BOW_MAX_DT);
      for (const s of states) {
        if (s.amp === 0 && s.vel === 0) continue;
        // Semi-implicit Euler on x'' = -w^2 x - 2 zeta w x'.
        s.vel += (-omega * omega * s.amp - 2 * BOW_DAMPING_RATIO * omega * s.vel) * h;
        s.amp += s.vel * h;
        // The fence can only stretch so far: stop dead at the limits.
        if (s.amp > BOW_MAX_M) { s.amp = BOW_MAX_M; s.vel = Math.min(s.vel, 0); }
        if (s.amp < -BOW_MAX_M * 0.5) { s.amp = -BOW_MAX_M * 0.5; s.vel = Math.max(s.vel, 0); }
        if (Math.abs(s.amp) < 1e-5 && Math.abs(s.vel) < 1e-4) { s.amp = 0; s.vel = 0; }
      }
    },
  };
}
