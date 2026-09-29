// Picks the oil implementation: the GPU particle fluid when the renderer is WebGPU with
// the compute limits the solver needs, otherwise CPU droplets and puddle decals.
import type * as THREE from 'three/webgpu';
import type { Rng } from '../coords';
import { FallbackOil } from './oil-fallback';
import { FluidOil } from './oil-fluid';
import type { OilSystem } from './oil-look';

/**
 * Device limits threejs-particle-fluids needs. The stage must request them when it
 * creates its WebGPURenderer (`new WebGPURenderer({ requiredLimits: VFX_REQUIRED_LIMITS })`),
 * or oil falls back to droplets and decals.
 */
export const VFX_REQUIRED_LIMITS: Record<string, number> = {
  maxComputeInvocationsPerWorkgroup: 1024,
  maxComputeWorkgroupSizeX: 1024,
  maxStorageBuffersPerShaderStage: 10,
};

interface OilStage {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  isWebGPU: boolean;
}

/** True when the renderer's device was created with every limit the fluid solver needs. */
export function supportsFluid(stage: OilStage): boolean {
  if (!stage.isWebGPU) return false;
  const device = (stage.renderer.backend as { device?: { limits?: Record<string, number> } }).device;
  const limits = device?.limits;
  if (!limits) return false;
  return Object.entries(VFX_REQUIRED_LIMITS).every(([k, v]) => (limits[k] ?? 0) >= v);
}

export function createOil(stage: OilStage, rng: Rng): OilSystem {
  if (supportsFluid(stage)) {
    try {
      return new FluidOil(stage.renderer, rng);
    } catch (err) {
      console.warn('[vfx] particle fluid unavailable, using droplet oil', err);
    }
  }
  return new FallbackOil(rng);
}
