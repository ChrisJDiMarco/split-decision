// Airborne oil drawn as camera-facing motion streaks (like a real 1/40 s exposure of a
// spurting line): a dark, slightly amber core with a soft edge and a sharp specular
// glint from a cylindrical normal lit by the overhead key. Shared by the GPU fluid
// (positions read from the solver's buffers) and the CPU fallback (instanced attributes).
import * as THREE from 'three/webgpu';
import {
  Fn, cameraPosition, cross, float, max, mix, normalize, positionGeometry, reflect, smoothstep, uniform, uv,
  varyingProperty, vec3,
} from 'three/tsl';
import type { Any } from '../tsl-any';
import { OIL_DEEP, OIL_THIN } from './oil-look';

/** Exposure the streak length represents (s). */
export const STREAK_EXPOSURE_S = 1 / 40;
const GLINT_POWER = 60;

export interface StreakSource {
  /** Streak head (world, vec3 node). */
  pos: Any;
  /** Velocity (world, vec3 node). */
  vel: Any;
  /** Droplet diameter (m, float node); 0 hides the instance. */
  width: Any;
}

/** Direction toward the overhead key light, shared with the scene's main light rig. */
export const oilKeyDir = uniform(new THREE.Vector3(0.1, 1, 0.15).normalize());

export function oilStreakMaterial(src: StreakSource): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const side: Any = varyingProperty('vec3', 'vOilSide');
  const toCamV: Any = varyingProperty('vec3', 'vOilToCam');
  m.positionNode = Fn(() => {
    const along: Any = positionGeometry.y.add(0.5); // 0 tail .. 1 head
    const across: Any = positionGeometry.x; // -0.5 .. 0.5
    const streak: Any = src.vel.mul(STREAK_EXPOSURE_S);
    const len: Any = streak.length().max(src.width);
    const dir: Any = normalize(src.vel.add(vec3(0, 1e-5, 0)));
    const toCam: Any = normalize(cameraPosition.sub(src.pos));
    const s: Any = normalize(cross(dir, toCam).add(vec3(1e-4, 0, 0)));
    side.assign(s);
    toCamV.assign(toCam);
    // Round the ends a little by extending half a width past the head.
    const head: Any = src.pos.add(dir.mul(src.width.mul(0.5)));
    return head.sub(dir.mul(len.add(src.width).mul(float(1).sub(along)))).add(s.mul(across.mul(src.width)));
  })();
  const a: Any = uv().x.sub(0.5).mul(2); // -1 .. 1 across
  const t: Any = uv().y; // 0 tail .. 1 head
  const nz: Any = float(1).sub(a.mul(a)).max(0).sqrt();
  const n: Any = normalize(side.mul(a).add(toCamV.mul(nz)));
  const r: Any = reflect(toCamV.negate(), n);
  const glint: Any = max(r.dot(oilKeyDir), 0).pow(GLINT_POWER).mul(3.5);
  const fresnel: Any = float(1).sub(nz).pow(3).mul(0.25);
  const body: Any = mix(vec3(OIL_THIN.r, OIL_THIN.g, OIL_THIN.b), vec3(OIL_DEEP.r, OIL_DEEP.g, OIL_DEEP.b), nz);
  m.colorNode = body.add(vec3(glint.add(fresnel)));
  const edge: Any = smoothstep(1, 0.6, a.abs());
  const tailFade: Any = smoothstep(0, 0.35, t);
  m.opacityNode = edge.mul(tailFade).mul(0.96);
  return m;
}

/** A 1×1 quad (x across, y along) for streak instancing. */
export function streakQuad(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(1, 1);
}
