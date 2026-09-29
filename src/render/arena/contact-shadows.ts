// Contact shadows: an orthographic camera under the canvas looks straight up and renders
// everything within CONTACT_HEIGHT_M of the mat as a darkness value (1 touching, 0 at the
// top of the slab). The mat samples it with a soft multi-tap kernel, so feet, knees and
// fallen robots sit heavy on the canvas even where the key light's shadow map is soft.
import * as THREE from 'three/webgpu';
import { clamp, float, positionWorld, vec3 } from 'three/tsl';

export const CONTACT_HEIGHT_M = 0.55;
const CONTACT_RES = 512;

export interface ContactShadows {
  texture: THREE.Texture;
  /** Width of the square area covered, metres, centred on the cage. */
  sizeM: number;
  /** Renders the pass; objects in `hide` are skipped (the arena itself). */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, hide: THREE.Object3D[]): void;
  dispose(): void;
}

export function createContactShadows(sizeM: number): ContactShadows {
  const target = new THREE.RenderTarget(CONTACT_RES, CONTACT_RES, { depthBuffer: true });
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;

  const half = sizeM / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0, CONTACT_HEIGHT_M + 0.01);
  camera.position.set(0, -0.01, 0);
  camera.rotation.set(Math.PI / 2, 0, 0); // looks along world +y; image up is world +z
  camera.updateMatrixWorld();

  const material = new THREE.MeshBasicNodeMaterial();
  const height = clamp(positionWorld.y.div(CONTACT_HEIGHT_M), 0, 1);
  material.colorNode = vec3(float(1).sub(height).pow(2));
  material.side = THREE.DoubleSide;
  material.fog = false;

  const black = new THREE.Color(0x000000);
  return {
    texture: target.texture,
    sizeM,
    update(renderer, scene, hide) {
      const prevTarget = renderer.getRenderTarget();
      const prevBackground = scene.background;
      const prevOverride = scene.overrideMaterial;
      const prevVisible = hide.map((o) => o.visible);

      for (const o of hide) o.visible = false;
      scene.background = black; // clears the target to "no contact"
      scene.overrideMaterial = material;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);

      renderer.setRenderTarget(prevTarget);
      scene.background = prevBackground;
      scene.overrideMaterial = prevOverride;
      hide.forEach((o, i) => { o.visible = prevVisible[i]; });
    },
    dispose() {
      target.dispose();
      material.dispose();
    },
  };
}
