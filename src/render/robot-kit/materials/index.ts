// Builds one robot's material set: skin-driven paint / trim / frame / mech, the glove leather,
// the eye colour, and the shared fixed materials. The 'livery' skin is built per design from its
// palette; the other skins are shared parameter sets.
import type { RobotDesign, SkinId } from '../../../core/types';
import { designLook } from '../look';
import type { KitMaterials } from '../types';
import { createDecalAtlas, type DecalAtlas } from './decal-atlas';
import { createKitMaterial } from './kit-material';
import { chromeMaterial, coreMaterial, glowMaterial, lensMaterial, rubberMaterial, wireMaterial } from './simple';
import { liverySkin, skinParams, type SkinParams } from './skins';

export interface RobotMaterials {
  mats: KitMaterials;
  atlas: DecalAtlas;
  dispose(): void;
}

/** Skin parameters for one design: the livery reads the design's palette, the rest are shared. */
export function skinFor(skin: SkinId, design: RobotDesign): SkinParams {
  if (skin !== 'livery') return skinParams(skin);
  const look = designLook(design);
  if (!look.palette) return skinParams('livery');
  return liverySkin(look.palette, { mech: look.mech, number: look.number || '00', font: look.font, decal: look.decal, label: design.name });
}

export function createRobotMaterials(skin: SkinId, design: RobotDesign, seed: number): RobotMaterials {
  const params = skinFor(skin, design);
  const look = designLook(design);
  const atlas = createDecalAtlas(params, design.name, seed);
  const own = {
    paint: createKitMaterial({ skin: params, flavor: 'paint', atlas: atlas.texture }),
    trim: createKitMaterial({ skin: params, flavor: 'trim', atlas: atlas.texture }),
    glove: createKitMaterial({ skin: params, flavor: 'glove', atlas: null, gloveColor: look.glove ?? undefined }),
    frame: createKitMaterial({ skin: params, flavor: 'frame', atlas: null }),
    mech: createKitMaterial({ skin: params, flavor: 'mech', atlas: null }),
    glow: glowMaterial(design.eyeColor, look.eyeGain),
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
