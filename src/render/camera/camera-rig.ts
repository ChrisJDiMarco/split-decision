// Drives the stage camera from the director (eased, snapping on cuts) or leaves it to
// OrbitControls in free mode. Shake is layered on top in both modes.
// Stage.render() calls controls.update(), which re-aims the camera at controls.target, so
// the rig always moves the target together with the camera.
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../core/types';
import type { Stage } from '../stage';
import type { DirectorOutput } from './director';
import type { ShotKind } from './shots';

type RigStage = Pick<Stage, 'camera' | 'controls' | 'physicsRoot'>;

/** Ease time constants (seconds) per shot: a hard-cam operator is slower than a steadicam. */
const EASE: Partial<Record<ShotKind, { pos: number; target: number }>> = {
  wide: { pos: 0.8, target: 0.45 },
  overhead: { pos: 0.6, target: 0.4 },
  replay: { pos: 0.12, target: 0.12 },
  debris: { pos: 0.5, target: 0.08 },
};
const DEFAULT_EASE = { pos: 0.3, target: 0.16 };
const FOV_EASE_S = 0.35;

interface ControlLimits {
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
}

export class CameraRig {
  free = false;
  private pos = new THREE.Vector3();
  private target = new THREE.Vector3();
  private fov: number;
  private lastShake = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private rootQuat = new THREE.Quaternion();
  private freeLimits: ControlLimits;
  private initialised = false;

  constructor(private stage: RigStage) {
    const c = stage.controls;
    this.freeLimits = { minDistance: c.minDistance, maxDistance: c.maxDistance, minPolarAngle: c.minPolarAngle, maxPolarAngle: c.maxPolarAngle };
    this.fov = stage.camera.fov;
    this.setFree(false);
  }

  setFree(on: boolean): void {
    this.free = on;
    const c = this.stage.controls;
    c.enabled = on;
    // Director shots go below the target plane (cage-side low) and very close; lift the
    // orbit limits so controls.update() doesn't fight them.
    const limits = on ? this.freeLimits : { minDistance: 0, maxDistance: Infinity, minPolarAngle: 0, maxPolarAngle: Math.PI };
    Object.assign(c, limits);
  }

  /** Physics-frame point → world. */
  toWorld(p: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
    this.stage.physicsRoot.updateMatrixWorld();
    return this.stage.physicsRoot.localToWorld(out.set(p[0], p[1], p[2]));
  }

  apply(shot: DirectorOutput | null, dt: number, shakePhysics: Vec3): void {
    const cam = this.stage.camera;
    const controls = this.stage.controls;
    cam.position.sub(this.lastShake);
    controls.target.sub(this.lastShake);

    if (!this.free && shot) this.follow(shot, dt);

    this.stage.physicsRoot.getWorldQuaternion(this.rootQuat);
    this.lastShake.set(shakePhysics[0], shakePhysics[1], shakePhysics[2]).applyQuaternion(this.rootQuat);
    cam.position.add(this.lastShake);
    controls.target.add(this.lastShake);
  }

  private follow(out: DirectorOutput, dt: number): void {
    const cam = this.stage.camera;
    const desiredPos = this.toWorld(out.pose.pos, this.tmp);
    const snap = out.cut || !this.initialised;
    const ease = EASE[out.shot.kind] ?? DEFAULT_EASE;
    if (snap) this.pos.copy(desiredPos);
    else this.pos.lerp(desiredPos, 1 - Math.exp(-dt / ease.pos));
    const desiredTarget = this.toWorld(out.pose.target, this.tmp);
    if (snap) this.target.copy(desiredTarget);
    else this.target.lerp(desiredTarget, 1 - Math.exp(-dt / ease.target));
    this.fov = snap ? out.pose.fov : this.fov + (out.pose.fov - this.fov) * (1 - Math.exp(-dt / FOV_EASE_S));
    this.initialised = true;

    cam.position.copy(this.pos);
    this.stage.controls.target.copy(this.target);
    cam.lookAt(this.target);
    if (Math.abs(cam.fov - this.fov) > 1e-3) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
