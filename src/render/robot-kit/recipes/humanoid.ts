// Registers the humanoid part recipes. Other body types (quadruped legs, wheels, tracks,
// weapons) register their own ids the same way; unknown ids use the fallback recipe.
import { armFore, armUpper } from './arm';
import { fistBlock, fistPiston, fistSpiked } from './fist';
import { headDome, headSlit, headTwin, headVisor } from './head';
import { legFoot, legShin, legThigh } from './leg';
import { registerKitRecipe } from './registry';
import { pelvisRecipe, torsoRecipe } from './torso';

let registered = false;

export function registerHumanoidRecipes(): void {
  if (registered) return;
  registered = true;
  registerKitRecipe('pelvis.block', pelvisRecipe);
  registerKitRecipe('torso.chest', torsoRecipe);
  registerKitRecipe('head.slit', headSlit);
  registerKitRecipe('head.visor', headVisor);
  registerKitRecipe('head.dome', headDome);
  registerKitRecipe('head.twin', headTwin);
  registerKitRecipe('arm.upper', armUpper);
  registerKitRecipe('arm.fore', armFore);
  registerKitRecipe('fist.block', fistBlock);
  registerKitRecipe('fist.spiked', fistSpiked);
  registerKitRecipe('fist.piston', fistPiston);
  registerKitRecipe('leg.thigh', legThigh);
  registerKitRecipe('leg.shin', legShin);
  registerKitRecipe('leg.foot', legFoot);
}
