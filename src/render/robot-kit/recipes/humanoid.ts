// Registers the humanoid part recipes. Other body types (quadruped legs, wheels, tracks,
// weapons) register their own ids the same way; unknown ids use the fallback recipe.
// The generic limb ids (arm.*, leg.*, pelvis.block) dress modern electric designs with their
// style's shells and pucks, and iron-age designs with the plated hydraulic kit.
import { armFore, armUpper } from './arm';
import type { KitRecipe } from './context';
import { fistBlock, fistPiston, fistSpiked } from './fist';
import { fistPlate, handDigit, handPalm } from './hands';
import { headDome, headSlit, headTwin, headVisor } from './head';
import { legFoot, legShin, legThigh } from './leg';
import { modernArmFore, modernArmUpper, modernFoot, modernShin, modernThigh, pelvisModern, registerModernRecipes } from './modern';
import { registerKitRecipe } from './registry';
import { pelvisRecipe, torsoRecipe } from './torso';

let registered = false;

/** Plated recipe for iron-age styles, moulded one for modern styles. */
function byEra(iron: KitRecipe, modern: KitRecipe): KitRecipe {
  return (ctx) => (ctx.style.limbs === 'iron' ? iron(ctx) : modern(ctx));
}

export function registerHumanoidRecipes(): void {
  if (registered) return;
  registered = true;
  registerKitRecipe('pelvis.block', byEra(pelvisRecipe, pelvisModern));
  registerKitRecipe('torso.chest', torsoRecipe);
  registerKitRecipe('head.slit', headSlit);
  registerKitRecipe('head.visor', headVisor);
  registerKitRecipe('head.dome', headDome);
  registerKitRecipe('head.twin', headTwin);
  registerKitRecipe('arm.upper', byEra(armUpper, modernArmUpper));
  registerKitRecipe('arm.fore', byEra(armFore, modernArmFore));
  registerKitRecipe('fist.block', fistBlock);
  registerKitRecipe('fist.spiked', fistSpiked);
  registerKitRecipe('fist.piston', fistPiston);
  registerKitRecipe('fist.plate', fistPlate);
  registerKitRecipe('hand.palm', handPalm);
  registerKitRecipe('hand.digit', handDigit);
  registerKitRecipe('leg.thigh', byEra(legThigh, modernThigh));
  registerKitRecipe('leg.shin', byEra(legShin, modernShin));
  registerKitRecipe('leg.foot', byEra(legFoot, modernFoot));
  registerModernRecipes();
}
