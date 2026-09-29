// VFX module entry: sparks, impact flashes, smoke and dust, hydraulic oil (GPU particle
// fluid with a WebGL fallback) and loose debris, all driven by physics events and
// per-part telemetry. Everything is added straight to the scene in world space (y-up).
//
//   const vfx = createVfx(stage);
//   worker 'ready'  → vfx.setWorld(meta)
//   worker 'frame'  → vfx.onEvents(msg.events); vfx.onTelemetry(msg.telemetry, msg.poses)
//   every rAF       → vfx.update(dt)   (before rendering)
import * as THREE from 'three/webgpu';
import type { RobotTelemetry, SimEvent, WorldMeta } from '../../core/protocol';
import { makeRng } from './coords';
import { DebrisSystem } from './debris';
import { TelemetryEmitters } from './emitters';
import { routeEvent, type EffectSystems } from './event-router';
import { FlashSystem } from './flash';
import { createOil } from './oil';
import type { OilSystem } from './oil/oil-look';
import { oilKeyDir } from './oil/oil-streaks';
import { SmokeSystem } from './smoke';
import { SparkSystem } from './sparks';

export { VFX_REQUIRED_LIMITS } from './oil';

/** The part of the Stage the VFX module needs. */
export interface VfxStage {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  isWebGPU: boolean;
}

export interface VfxStats {
  sparks: number;
  smokePuffs: number;
  debris: number;
  debrisMoving: number;
  oilParticles: number;
  oilMode: 'fluid' | 'fallback';
  cpuMs: number;
}

export interface Vfx {
  onEvents(events: SimEvent[]): void;
  onTelemetry(tel: [RobotTelemetry, RobotTelemetry], poses: Float32Array): void;
  update(dt: number): void;
  /** Optional: part → body mapping so smoke and oil follow parts before the damage module publishes vents. */
  setWorld(meta: WorldMeta): void;
  /**
   * Match the effects' own shading (smoke self-lighting, oil glints) to the arena rig:
   * `toLight` points from the scene toward the dominant key light (world, y-up).
   */
  setKeyLight(toLight: THREE.Vector3, color?: THREE.Color, ambient?: THREE.Color): void;
  /** Remove every particle, puddle and piece of debris (between rounds). */
  /** Dim impact flashes while a slow-motion replay plays. */
  setReplay(replaying: boolean): void;
  clear(): void;
  dispose(): void;
  readonly stats: VfxStats;
  readonly root: THREE.Group;
}

/** Longest frame step the effects integrate in one go (a hitch must not explode them). */
const MAX_DT = 1 / 20;

export function createVfx(stage: VfxStage, seed = 1337): Vfx {
  const rng = makeRng(seed);
  const root = new THREE.Group();
  root.name = 'vfx';
  const sparks = new SparkSystem(rng);
  const flash = new FlashSystem(stage.camera);
  const debris = new DebrisSystem(rng);
  const smoke = new SmokeSystem(rng);
  const oil: OilSystem = createOil(stage, rng);
  root.add(debris.object, oil.object, smoke.object, sparks.object, flash.object);
  stage.scene.add(root);

  const emitters = new TelemetryEmitters(rng, { smoke, oil, embers: sparks });
  const fx: EffectSystems = { sparks, flash, debris, smoke, com: (c, out) => emitters.com(c, out) };
  const stats: VfxStats = { sparks: 0, smokePuffs: 0, debris: 0, debrisMoving: 0, oilParticles: 0, oilMode: oil.kind, cpuMs: 0 };

  return {
    root,
    stats,
    onEvents(events) {
      for (const e of events) routeEvent(e, fx, rng);
    },
    onTelemetry(tel, poses) {
      emitters.setTelemetry(tel, poses);
    },
    setWorld(meta) {
      emitters.setWorld(meta);
    },
    update(rawDt) {
      const t0 = performance.now();
      const dt = Math.min(Math.max(rawDt, 0), MAX_DT);
      emitters.update(dt);
      sparks.update(dt);
      flash.update(dt);
      debris.update(dt);
      smoke.update(dt, stage.camera);
      oil.update(dt);
      stats.sparks = sparks.alive;
      stats.smokePuffs = smoke.alive;
      stats.debris = debris.total;
      stats.debrisMoving = debris.moving;
      stats.oilParticles = oil.activeParticles;
      stats.cpuMs = performance.now() - t0;
    },
    setKeyLight(toLight, color, ambient) {
      smoke.keyDir.value.copy(toLight).normalize();
      oilKeyDir.value.copy(toLight).normalize();
      if (color) smoke.keyColor.value.copy(color);
      if (ambient) smoke.ambient.value.copy(ambient);
    },
    setReplay(replaying) {
      flash.setReplay(replaying);
    },
    clear() {
      sparks.clear();
      smoke.clear();
      debris.clear();
      oil.clear();
      emitters.clear();
    },
    dispose() {
      root.removeFromParent();
      sparks.dispose();
      flash.dispose();
      debris.dispose();
      smoke.dispose();
      oil.dispose();
    },
  };
}
