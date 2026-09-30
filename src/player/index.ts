// Player mode: a human takes one corner in third person (docs/design/player-mode-integration.md).
export { PlayerMode, type PlayerCamera, type PlayerModeOptions, type PlayerStats } from './player-mode';
export { PlayerDriver, footworkTactic, moveFrom, CIRCLE_TO, type DriverView, type SelfState } from './driver';
export { ChaseCamera, solveChase, type ChasePose, type ChaseSubjects } from './chase-camera';
export { DEFAULT_KEYMAP, loadKeymap, saveKeymap, rebind, type Keymap, type ActionId } from './keymap';
export { PLAYER_REACTION_DELAY_S } from './config';
export { playerHostState, breakRoleOf, inputAllowed, type BreakRole, type HostPhase, type PlayerHostState } from './host';
