// Arena view: the cage, platform, lighting rig, crowd and venue atmosphere, all built from
// src/core/arena-spec.ts. Cage parts live under stage.physicsRoot (physics frame, z-up) so
// they line up with the colliders; the venue lives in the three.js world (y-up).
//
//   const arena = buildArenaView(stage);
//   const post = installPostProcessing(stage, arena);
//   loop: arena.update(dt); post.render();
//   on a 'cage' SimEvent: arena.bowFence(event.pos, event.speed / 3);
import type * as THREE from 'three/webgpu';
import { CIRCUMRADIUS } from '../../core/arena-spec';
import type { Vec3 } from '../../core/types';
import type { Stage } from '../stage';
import { buildCage } from './cage';
import { createContactShadows } from './contact-shadows';
import { buildCrowd } from './crowd';
import { installEnvironment } from './environment';
import { buildFence } from './fence';
import { buildLighting, type ShadowQuality } from './lighting';
import { buildMat, createWeaveTexture } from './mat';
import { createMatTextures } from './mat-art';
import { buildPlatform } from './platform';
import { whenFontReady } from './util';

export { installPostProcessing, type PostProcessing, type Quality } from './post';

export interface ArenaView {
  /** Keep an object (e.g. the VFX root: smoke, sparks) out of the contact-shadow pass. */
  excludeFromContactShadows(obj: THREE.Object3D): void;
  /** Advance fence springs and re-render contact shadows. Call once per frame before rendering. */
  update(dt: number): void;
  /**
   * Bow the fence panel nearest `worldPos`, given in the physics (MuJoCo, z-up) world frame,
   * as SimEvent positions are. `strength` ~1 is a heavy robot slammed in at ~3 m/s; it is
   * clamped to 3. Impacts more than 1 m from the fence plane are ignored.
   */
  bowFence(worldPos: Vec3 | THREE.Vector3, strength: number): void;
  /** Shadow-map resolution; installPostProcessing calls this when quality changes. */
  setShadowQuality(q: ShadowQuality): void;
  /** The canvas mat mesh (physics frame), e.g. for decals. */
  readonly canvas: THREE.Mesh;
  /** The overhead key light, for camera or VFX code that wants to read it. */
  readonly keyLight: THREE.SpotLight;
}

const CONTACT_AREA_M = (CIRCUMRADIUS + 0.2) * 2;
const MAT_ENV_INTENSITY = 0.2;

export function buildArenaView(stage: Stage): ArenaView {
  const { renderer, scene, physicsRoot } = stage;
  const env = installEnvironment(renderer, scene);

  const art = createMatTextures();
  void whenFontReady().then(art.redraw);
  const shadows = createContactShadows(CONTACT_AREA_M);
  const anisotropy = renderer.getMaxAnisotropy?.() ?? 8;
  const mat = buildMat(art, createWeaveTexture(), shadows, Math.min(16, anisotropy));
  // The matte canvas takes less image-based light than the metal, so its paint stays saturated.
  mat.material.envMap = scene.environment;
  mat.material.envMapIntensity = MAT_ENV_INTENSITY;
  const cage = buildCage();
  const fence = buildFence();
  const platform = buildPlatform();
  physicsRoot.add(mat.mesh, cage.group, fence.group, platform.group);

  const lighting = buildLighting('high');
  const crowd = buildCrowd();
  scene.add(lighting.group, crowd.group);

  // Everything the arena owns is skipped by the contact-shadow pass: only robots, debris
  // and props darken the canvas.
  const hide: THREE.Object3D[] = [mat.mesh, cage.group, fence.group, platform.group, lighting.group, crowd.group, env.dome];

  return {
    update(dt) {
      fence.update(dt);
      shadows.update(renderer, scene, hide);
    },
    bowFence: fence.bow,
    excludeFromContactShadows(obj) {
      if (!hide.includes(obj)) hide.push(obj);
    },
    setShadowQuality: lighting.setShadowQuality,
    canvas: mat.mesh,
    keyLight: lighting.key,
  };
}
