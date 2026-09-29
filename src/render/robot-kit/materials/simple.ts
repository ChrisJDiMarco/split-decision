// Small fixed materials: polished rods, rubber and hoses, emissive optics, lens glass, the gyro
// core glow and torn wiring. Shared ones are cached; eye and core colours are per robot.
import * as THREE from 'three/webgpu';
import {
  attribute, color, float, length, mix, mx_noise_float, positionLocal, sin, smoothstep, time, vec3,
} from './tsl';
import { heatColor, objectValue, srgb } from './tsl-util';

const EYE_INTENSITY = 4.2;
const CORE_BASE = 0.45;
const CORE_GAIN = 3.4;

let chromeMat: THREE.MeshPhysicalNodeMaterial | null = null;
let rubberMat: THREE.MeshStandardNodeMaterial | null = null;
let lensMat: THREE.MeshPhysicalNodeMaterial | null = null;
let wireMat: THREE.MeshStandardNodeMaterial | null = null;

/** Hard-chromed hydraulic rods and pins with a faint oil film. */
export function chromeMaterial(): THREE.MeshPhysicalNodeMaterial {
  if (chromeMat) return chromeMat;
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = 'kit-chrome';
  const oHeat = objectValue('heat', 0);
  const film = mx_noise_float(positionLocal.mul(vec3(40, 40, 6))).mul(0.5).add(0.5);
  m.colorNode = color(0xe6eaee);
  m.metalnessNode = float(1);
  m.roughnessNode = mix(float(0.05), float(0.16), film);
  m.emissiveNode = heatColor(oHeat).mul(smoothstep(0.35, 1.0, oHeat)).mul(2.2);
  chromeMat = m;
  return m;
}

/** Rubber, hose jackets and cable sleeving; tint comes from vertex colour. */
export function rubberMaterial(): THREE.MeshStandardNodeMaterial {
  if (rubberMat) return rubberMat;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'kit-rubber';
  const tint = attribute('color', 'vec3');
  const n = mx_noise_float(positionLocal.mul(35)).mul(0.5).add(0.5);
  m.colorNode = tint.mul(mix(float(0.8), float(1.05), n));
  m.roughnessNode = mix(float(0.6), float(0.85), n);
  m.metalnessNode = float(0);
  rubberMat = m;
  return m;
}

/** Black optical glass for camera lenses and visors. */
export function lensMaterial(): THREE.MeshPhysicalNodeMaterial {
  if (lensMat) return lensMat;
  const m = new THREE.MeshPhysicalNodeMaterial({ color: 0x030405, metalness: 0.1, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 });
  m.name = 'kit-lens';
  lensMat = m;
  return m;
}

/** Insulated wire with copper where aSurf.w = 1 (torn ends). */
export function wireMaterial(): THREE.MeshStandardNodeMaterial {
  if (wireMat) return wireMat;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'kit-wire';
  const tint = attribute('color', 'vec3');
  const surf = attribute('aSurf', 'vec4');
  const copper = smoothstep(0.5, 0.9, surf.w);
  m.colorNode = mix(tint, vec3(0.85, 0.42, 0.2), copper);
  m.roughnessNode = mix(float(0.42), float(0.28), copper);
  m.metalnessNode = copper;
  m.emissiveNode = vec3(1.0, 0.35, 0.06).mul(copper).mul(objectValue('glow', 0)).mul(2.5);
  wireMat = m;
  return m;
}

/** Emissive optics in the design's eye colour; `glow` per object drives flicker and power-down. */
export function glowMaterial(hex: string, gain = 1): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `kit-glow-${hex}`;
  const eye = srgb(hex);
  const oGlow = objectValue('glow', 1);
  const shimmer = mx_noise_float(positionLocal.mul(120).add(vec3(0, 0, time.mul(3)))).mul(0.08).add(1);
  m.colorNode = color(eye).mul(0.15);
  m.roughnessNode = float(0.25);
  m.metalnessNode = float(0);
  m.emissiveNode = color(eye).mul(oGlow).mul(shimmer).mul(EYE_INTENSITY * gain);
  return m;
}

/** Gyro core: a hot plasma-blue disc that brightens with saturation and turns amber near the limit. */
export function coreMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'kit-core';
  const oCore = objectValue('core', 0.3);
  const r = length(positionLocal.xy);
  const rings = sin(r.mul(260).sub(time.mul(14))).mul(0.5).add(0.5);
  const swirl = mx_noise_float(positionLocal.mul(40).add(vec3(0, 0, time.mul(2.0)))).mul(0.5).add(0.5);
  const cool = vec3(0.25, 0.62, 1.0);
  const hot = vec3(1.0, 0.55, 0.15);
  const tint = mix(cool, hot, smoothstep(0.8, 1.0, oCore));
  const gain = float(CORE_BASE).add(oCore.mul(CORE_GAIN)).mul(mix(float(0.7), float(1.2), rings.mul(swirl)));
  m.colorNode = vec3(0.02, 0.03, 0.05);
  m.roughnessNode = float(0.3);
  m.metalnessNode = float(0);
  m.emissiveNode = tint.mul(gain);
  return m;
}
