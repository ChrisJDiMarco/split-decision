// Robot kit public API.
//
//   const { views, bodyGroups } = buildRobotKitViews(meta, stage.physicsRoot, [skin0, skin1]);
//   each frame:  applyPoses(poses, bodyGroups); updateRobotKit(views, telemetry, dt);
//   on impact:   applyImpact(views[victim], part, worldPos, normal, energyJ);
//   on detach:   setPartState(views[corner], part, { attached: false })  (or let telemetry do it)
//   on reset:    for (const v of views) v.dispose();
//
// Scene positions passed to applyImpact are three.js world space. Physics-space points (z-up)
// convert with stage.physicsRoot.localToWorld(new Vector3(...p)).
export { buildRobotKitView, buildRobotKitViews, type PartMeta } from './build';
export { updateRobotKit } from './animate';
export { anchorPointsWorld, applyImpact, partPointWorld, setPartState, sparkPoints, type KitAnchor } from './damage';
export { forwardKinematics, applyBodyPoses, type BodyPose } from './fk';
export { SKIN_IDS, SKINS, skinParams } from './materials';
export { registerKitRecipe, registeredRecipes, hasKitRecipe } from './recipes/registry';
export type { KitRecipe, RecipeContext, KitStyle } from './recipes/context';
export type { KitPart, PartVisualState, RobotKitView } from './types';
