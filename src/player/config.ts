// Player mode tuning: a human fights one corner through the same Intent channel as Jev.
// Everything here is presentation or input feel; the body stays physically honest (the
// controller still balances, and torque, heat and damage limits apply as for any fighter).

/**
 * The player's reaction delay (s). Jev's corner keeps MatchSetup.reactionDelayS (0.3 s) so network
 * jitter never changes a fight; a human needs the controls to feel immediate. A future 'fair mode'
 * leaves FighterSetup.reactionDelayS unset, so the player feels the same 0.3 s as the brain.
 */
export const PLAYER_REACTION_DELAY_S = 0.05;

/** Strikes pressed within this window of the previous press chain into one combination. */
export const COMBO_WINDOW_S = 0.25;
/** At most this many strikes wait in the buffer (older presses are dropped first). */
export const MAX_BUFFER = 4;
/** A buffered strike older than this when its turn comes is stale and dropped. */
export const BUFFER_TTL_S = 1.2;
/** A sent strike that has not started within this long (out of range, off balance) is abandoned. */
export const START_TIMEOUT_S = 1.2;
/** Slip (sidestep_counter) and feint stay the standing tactic this long after the press. */
export const SLIP_HOLD_S = 0.9;
export const FEINT_HOLD_S = 0.6;
/** Movement vectors are bucketed to this step so a tiny change doesn't resend the intent. */
export const MOVE_STEP = 0.25;

/** How hard the player's body commits (Intent.aggression): faster windups and footwork. */
export const AGGRESSION = { strike: 1, footwork: 0.85, guard: 0.3, clinch: 0.9, slip: 0.9, feint: 0.6 } as const;

/**
 * Where in a skill's overall progress (RobotTelemetry.skillPhase) its windup ends and the blow is
 * committed, at aggression 1: 0.7·windup / (0.7·windup + 0.9·strike + 0.7·recover) from the
 * control skill durations (src/physics/control/skills), plus a small margin. Until then a
 * defensive footwork tactic would cancel the windup, so the next intent waits for this point.
 */
export const COMMIT_PHASE: Record<string, number> = {
  jab: 0.23, cross: 0.26, hook: 0.28, uppercut: 0.3, overhand: 0.34, rocket_punch: 0.4,
  front_kick: 0.35, low_kick: 0.33, head_kick: 0.35,
};
export const DEFAULT_COMMIT_PHASE = 0.36;

/** Chase camera (over the shoulder of the player's robot, locked on to the opponent). */
export const CHASE = {
  BOOM_M: 2.45, // pivot → lens
  SHOULDER_M: 0.55, // pivot offset to the robot's right
  PIVOT_ABOVE_HEAD_M: 0.12,
  PITCH_RAD: 0.2, // default look-down
  PITCH_MIN: -0.08,
  PITCH_MAX: 0.85,
  YAW_LIMIT_RAD: 1.25, // mouse orbit either side of the lock-on line
  MOUSE_RAD_PER_PX: 0.0032,
  RECENTER_AFTER_S: 1.2, // no mouse for this long: ease back behind the robot
  RECENTER_TAU_S: 1.4,
  LOOK_SHARE: 0.62, // aim point along me → opponent
  FOV_DEG: 58,
  POS_TAU_S: 0.09,
  POS_IN_TAU_S: 0.025, // pulling in for an obstacle is quicker than easing back out
  TARGET_TAU_S: 0.07,
  LOCK_TAU_S: 0.12, // smoothing of the lock-on yaw so a spin doesn't whip the lens
  CAGE_INSET_M: 0.28, // lens stays this far inside the fence
  HARDWARE_MARGIN_M: 0.14, // clearance from posts, rails, truss
  MIN_BOOM_SHARE: 0.22,
  DOWN_PITCH_RAD: 0.55, // a knocked-down robot is framed from higher up
} as const;

export const KEYMAP_STORAGE_KEY = 'jkd.player.keymap.v1';
