// Small helpers shared by the arena builders.
import * as THREE from 'three/webgpu';

/** Deterministic PRNG (mulberry32) so the mat, crowd and truss look the same every load. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MuJoCo world (z-up) to three.js world (y-up): (x, y, z) → (x, z, -y). */
export function physicsToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

/** Basis that maps local +x along a cage side, +y up (physics +z) and +z along the outward normal. */
export function sideBasis(normalAngle: number): THREE.Quaternion {
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(-Math.sin(normalAngle), Math.cos(normalAngle), 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(Math.cos(normalAngle), Math.sin(normalAngle), 0),
  );
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** A 2D canvas, or null where the DOM is unavailable (tests in Node). */
export function makeCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export const DISPLAY_FONT = '"Barlow Condensed", "Arial Narrow", Impact, sans-serif';

/** Loads the display font if the page declares it; resolves either way. */
export async function whenFontReady(weight = 800): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await document.fonts.load(`${weight} 64px "Barlow Condensed"`);
  } catch {
    // Fallback fonts in DISPLAY_FONT still render; nothing else to do.
  }
}
