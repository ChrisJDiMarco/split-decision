// The canvas mat inside the fence: painted artwork, a tiling plain-weave detail (normal +
// albedo), soft foam undulation, and contact shadows sampled with a two-scale kernel.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  float, mix, mx_noise_float, normalMap, positionWorld, texture, uniform, uv, vec2, vec3,
} from 'three/tsl';
import { ARENA, CIRCUMRADIUS } from '../../core/arena-spec';
import type { ContactShadows } from './contact-shadows';
import { MAT_EXTENT_M, type MatTextures } from './mat-art';

const WEAVE_PX = 256;
const WEAVE_THREADS = 16; // threads per tile, each direction
const WEAVE_TILES_PER_M = 80; // ~0.8 mm threads
const WEAVE_NORMAL_STRENGTH = 0.9;
const WEAVE_ALBEDO = 0.22; // how much the gaps between threads darken the paint
const FOAM_BUMP = 0.05; // low-frequency undulation of the padding under the canvas
const CONTACT_STRENGTH = 0.82;

/** Plain-weave tile: RGB = tangent-space normal, A = thread height (albedo modulation). */
export function createWeaveTexture(): THREE.DataTexture {
  const n = WEAVE_PX;
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x / n) * WEAVE_THREADS;
      const v = (y / n) * WEAVE_THREADS;
      const j = Math.floor(u);
      const k = Math.floor(v);
      const fu = u - j - 0.5;
      const fv = v - k - 0.5;
      const warp = Math.sqrt(Math.max(0, 1 - (fv / 0.47) ** 2));
      const weft = Math.sqrt(Math.max(0, 1 - (fu / 0.47) ** 2));
      const warpOver = 0.5 + 0.5 * Math.cos(Math.PI * (u - 0.5 - k));
      const weftOver = 0.5 + 0.5 * Math.cos(Math.PI * (v + 0.5 - j));
      const fiber = 0.04 * Math.sin(u * 37.0 + v * 3.1) * Math.sin(v * 41.0 - u * 2.3);
      height[y * n + x] = Math.max(warp * (0.35 + 0.65 * warpOver), weft * (0.35 + 0.65 * weftOver)) + fiber;
    }
  }
  const data = new Uint8Array(n * n * 4);
  const at = (x: number, y: number) => height[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * n + x) * 4;
      data[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[o + 3] = Math.round(Math.max(0, Math.min(1, at(x, y))) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function canvasShape(radius: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    if (i === 0) s.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
    else s.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  s.closePath();
  return s;
}

/** Soft multi-tap read of the contact-shadow map at a physics-frame position. */
function contactDarkness(shadows: ContactShadows) {
  const size = shadows.sizeM;
  // Contact camera image: u along world +x; v runs along world -z (= physics +y) once the
  // render target's flipped rows are accounted for (checked in harness/arena.html).
  const base = vec2(positionWorld.x.div(size).add(0.5), positionWorld.z.div(size).negate().add(0.5));
  const near = 0.012 / size;
  const far = 0.07 / size;
  const taps: Array<[number, number, number]> = [
    [0, 0, 0.2],
    [near, 0, 0.1], [-near, 0, 0.1], [0, near, 0.1], [0, -near, 0.1],
    [far, far, 0.1], [-far, far, 0.1], [far, -far, 0.1], [-far, -far, 0.1],
  ];
  let sum: Node<'float'> = float(0);
  for (const [dx, dy, w] of taps) sum = sum.add(texture(shadows.texture, base.add(vec2(dx, dy))).r.mul(w));
  return sum;
}

export interface MatView {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardNodeMaterial;
}

export function buildMat(art: MatTextures, weave: THREE.Texture, shadows: ContactShadows, anisotropy: number): MatView {
  art.color.anisotropy = anisotropy;
  art.roughness.anisotropy = anisotropy;
  weave.anisotropy = anisotropy;

  const geometry = new THREE.ShapeGeometry(canvasShape(CIRCUMRADIUS));
  const material = new THREE.MeshStandardNodeMaterial();
  // ShapeGeometry UVs are the shape's own coordinates: physics metres.
  const metres = uv();
  const artUv = metres.div(MAT_EXTENT_M * 2).add(0.5);
  const weaveTex = texture(weave, metres.mul(WEAVE_TILES_PER_M));
  const contactStrength = uniform(CONTACT_STRENGTH);

  const paint = texture(art.color, artUv).rgb;
  const threads = mix(float(1 - WEAVE_ALBEDO), float(1), weaveTex.a);
  const contact = float(1).sub(contactDarkness(shadows).mul(contactStrength));
  material.colorNode = paint.mul(threads).mul(contact);
  material.roughnessNode = texture(art.roughness, artUv).r;
  material.metalnessNode = float(0);

  const foam = vec2(
    mx_noise_float(vec3(metres.mul(1.7), 0.0)),
    mx_noise_float(vec3(metres.mul(1.7), 4.3)),
  ).mul(FOAM_BUMP);
  const weaveNormal = weaveTex.rgb.mul(2).sub(1).xy.mul(WEAVE_NORMAL_STRENGTH);
  material.normalNode = normalMap(vec3(weaveNormal.add(foam).mul(0.5).add(0.5), 1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'arena-canvas';
  return { mesh, material };
}
