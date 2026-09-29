// Registers the modern electric fighters' recipes (see docs/research/08-modern-roster.json for the
// four designs and docs/concept-art/modern/ for the art they follow).
import { registerKitRecipe } from '../registry';
import { fistGlove, fistKnuckle } from './fists';
import { headHammer, headLozenge, headTrio, headWedge } from './heads';
import { footRound, shinGuard } from './legs';
import { torsoCowl, torsoDiamond, torsoPebble, torsoSlim } from './torsos';

export { modernArmFore, modernArmUpper } from './arms';
export { modernFoot, modernShin, modernThigh } from './legs';
export { pelvisModern } from './torsos';

export function registerModernRecipes(): void {
  registerKitRecipe('head.trio', headTrio);
  registerKitRecipe('head.wedge', headWedge);
  registerKitRecipe('head.hammer', headHammer);
  registerKitRecipe('head.lozenge', headLozenge);
  registerKitRecipe('torso.pebble', torsoPebble);
  registerKitRecipe('torso.diamond', torsoDiamond);
  registerKitRecipe('torso.cowl', torsoCowl);
  registerKitRecipe('torso.slim', torsoSlim);
  registerKitRecipe('fist.glove', fistGlove);
  registerKitRecipe('fist.knuckle', fistKnuckle);
  registerKitRecipe('leg.foot.round', footRound);
  registerKitRecipe('leg.shin.guard', shinGuard);
}
