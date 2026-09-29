// Procedural smoke-puff atlas: 2×2 tiles of billowy fBm clouds with soft edges. The red
// channel is density; green and blue carry the density gradient (for fake self-lighting
// in the puff shader); alpha repeats density for convenience.
import * as THREE from 'three/webgpu';
import { makeRng } from './coords';

const TILE = 128;
const TILES = 2;
const OCTAVES = 5;

/** Value noise on a small lattice, tileable in neither direction (puffs are round). */
function makeNoise(seed: number): (x: number, y: number) => number {
  const rng = makeRng(seed);
  const N = 64;
  const grid = new Float32Array(N * N);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const at = (x: number, y: number) => grid[((y & (N - 1)) * N) + (x & (N - 1))];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < OCTAVES; o++) {
    sum += noise(x * f, y * f) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

function densityTile(seed: number): Float32Array {
  const noise = makeNoise(seed);
  const out = new Float32Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const u = (x + 0.5) / TILE * 2 - 1;
      const v = (y + 0.5) / TILE * 2 - 1;
      const n = fbm(noise, x / 18 + seed, y / 18);
      // Billow: warp the radius with noise so the silhouette is lumpy, not a disc.
      const rr = Math.sqrt(u * u + v * v) * (0.78 + 0.55 * (1 - n));
      const falloff = Math.max(0, 1 - rr);
      const d = Math.pow(falloff, 1.4) * (0.35 + 0.95 * n);
      out[y * TILE + x] = Math.min(1, d * 1.35);
    }
  }
  return out;
}

function toByte(x: number): number {
  return Math.round(Math.min(1, Math.max(0, x)) * 255);
}

export function createPuffAtlas(): THREE.DataTexture {
  const size = TILE * TILES;
  const data = new Uint8Array(size * size * 4);
  for (let t = 0; t < TILES * TILES; t++) {
    const d = densityTile(17 + t * 31);
    const ox = (t % TILES) * TILE;
    const oy = Math.floor(t / TILES) * TILE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const c = d[y * TILE + x];
        const gx = d[y * TILE + Math.min(TILE - 1, x + 1)] - d[y * TILE + Math.max(0, x - 1)];
        const gy = d[Math.min(TILE - 1, y + 1) * TILE + x] - d[Math.max(0, y - 1) * TILE + x];
        const i = ((oy + y) * size + ox + x) * 4;
        data[i] = toByte(c);
        data[i + 1] = toByte(0.5 + gx * 4);
        data[i + 2] = toByte(0.5 + gy * 4);
        data[i + 3] = toByte(c);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export const PUFF_TILES = TILES;
