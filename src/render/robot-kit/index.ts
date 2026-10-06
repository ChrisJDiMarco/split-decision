// Robot kit public API.
//
//   const { views, bodyGroups } = buildRobotKitViews(meta, stage.physicsRoot, [skin0, skin1]);
//   each frame:  applyPoses(poses, bodyGroups); updateRobotKit(views, telemetry, dt);
//   on impact:   applyImpact(views[victim], part, worldPos, normal, energyJ);  (scuff + eyes; physical
//                dents arrive in telemetry and updateRobotKit draws them: syncDents)
//   on detach:   setPartState(views[corner], part, { attached: false })  (or let telemetry do it)
//   on reset:    for (const v of views) v.dispose();
//
// Heads and hands animate inside updateRobotKit: optics follow RobotTelemetry.gaze (or a gaze
// derived from the bodies) with saccades and take the fighter's mood (gaze.lock / big shots flare,
// applyImpact flashes, damage flickers and runs red, KO and a flat battery go dark); kit-drawn
// fingers take RobotTelemetry.grip. Harnesses can force either through view.eyes.override and
// view.hands.override. Views build the loaded design (WorldMeta.robots[i].loadout).
//
// Scene positions passed to applyImpact are three.js world space. Physics-space points (z-up)
// convert with stage.physicsRoot.localToWorld(new Vector3(...p)).
export { buildRobotKitView, buildRobotKitViews, type PartMeta } from './build';
export { updateRobotKit } from './animate';
export { noteHit, telemetryGaze } from './eyes';
export { HAND_POSES, derivedHands, handPoseAngles, telemetryHands } from './hands';
export { DENT_VISUAL_BOOST, anchorPointsWorld, applyDent, applyImpact, partPointWorld, setPartState, sparkPoints, syncDents, type KitAnchor } from './damage';
export { forwardKinematics, applyBodyPoses, type BodyPose } from './fk';
export { SKIN_IDS, SKINS, skinParams } from './materials';
export { registerKitRecipe, registeredRecipes, hasKitRecipe } from './recipes/registry';
export type { KitRecipe, RecipeContext, KitStyle } from './recipes/context';
export type { EyeState, GazeInput, GazeMode, HandPose, KitPart, PartVisualState, RobotKitView } from './types';
