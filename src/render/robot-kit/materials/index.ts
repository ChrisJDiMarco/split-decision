// Builds one robot's material set: skin-driven paint / frame / mech, the eye colour, and the
// shared fixed materials.
import type { SkinId } from '../../../core/types';
import type { KitMaterials } from '../types';
import { createDecalAtlas, type DecalAtlas } from './decal-atlas';
import { createKitMaterial } from './kit-material';
import { chromeMaterial, coreMaterial, glowMaterial, lensMaterial, rubberMaterial, wireMaterial } from './simple';
import { skinParams } from './skins';

export interface RobotMaterials {
  mats: KitMaterials;
  atlas: DecalAtlas;
  dispose(): void;
}

export function createRobotMaterials(skin: SkinId, eyeColor: string, designName: string, seed: number): RobotMaterials {
  const params = skinParams(skin);
  const atlas = createDecalAtlas(params, designName, seed);
  const own = {
    paint: createKitMaterial({ skin: params, flavor: 'paint', atlas: atlas.texture }),
    frame: createKitMaterial({ skin: params, flavor: 'frame', atlas: null }),
    mech: createKitMaterial({ skin: params, flavor: 'mech', atlas: null }),
    glow: glowMaterial(eyeColor),
    core: coreMaterial(),
  };
  const mats: KitMaterials = {
    ...own,
    chrome: chromeMaterial(),
    rubber: rubberMaterial(),
    lens: lensMaterial(),
    wire: wireMaterial(),
  };
  return {
    mats,
    atlas,
    dispose() {
      for (const m of Object.values(own)) m.dispose();
      atlas.dispose();
    },
  };
}

export { SKIN_IDS, SKINS, skinParams } from './skins';
