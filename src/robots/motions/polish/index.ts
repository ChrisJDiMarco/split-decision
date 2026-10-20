// Polished moves (docs/design/move-polish.md): mocap moves made physically feasible offline for one
// design, stored compactly and replayed with a small fixed feedback law. Runtime side only; the
// optimiser lives in tools/polish and rolls out the same PolishedPlayer.
export { PolishedPlayer, plainPlan, playerJoints, newBodySense, CONTROL_DT } from './player';
export type { BodySense, PlayerJoint, PolishPlan, Placement, FeedbackRole } from './player';
export { loadPolish, polishedMoveIds, polishProblem, readPolishFromDisk } from './load';
export { compatHash, PHYSICS_OPTION, CANVAS_CONTACT } from './hash';
export {
  decodePolish, DEFAULT_FEEDBACK, ZERO_FEEDBACK, PLAYER_VERSION, POLISH_FORMAT, NOMINAL_CHANNELS, NOMINAL_HZ, NOMINAL_STRIDE,
} from './format';
export type { PolishJson, PolishedMove, FeedbackGains, DeadBands, PolishStatus, PolishEvent } from './format';
