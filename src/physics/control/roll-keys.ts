// Roll keys: face up or on a side, roll onto the front, over the lower side. Joint targets in
// degrees for rolling right (the left roll mirrors them); each key blends from the last over `dur`
// seconds (× the design's rollSpeed), then holds. A key names only the joints it moves.
//
// A boxy torso does not roll on its own: the legs swing over first, then the waist twists the
// chest round toward the canvas (curled forward, so the back rounds) while the far arm reaches
// over, and the far leg follows. The default keys do that. The heavy designs' wide upper bodies
// prop themselves on the lower shoulder instead, so theirs were searched for: cross-entropy over
// the roll starts of 21 recorded falls each, scored on rolling over and then getting through the
// push-up and pike without rolling back. On 20 held-out falls: bruiser 20/20 (default keys
// 1/20), goliath 19/20 (12/20). (A searched striker roll also reached 19/20 but left the body in
// a pose its feet could not tuck in from, so the striker keeps the default.)

export interface RollKey {
  dur: number;
  hold: number;
  pose: Readonly<Record<string, number>>;
}

const DEFAULT_ROLL: readonly RollKey[] = [
  { dur: 0.4, hold: 0.1, pose: { hip_roll_r: -45, hip_roll_l: -20, knee_l: 60, knee_r: 60, hip_pitch_l: -40, hip_pitch_r: -40, shoulder_pitch_r: -170, shoulder_roll_r: -20, shoulder_pitch_l: -90, shoulder_roll_l: -15, elbow_l: -20, elbow_r: -20, waist_yaw: 0, waist_pitch: 30 } },
  { dur: 0.45, hold: 0.3, pose: { waist_yaw: -70 } },
  { dur: 0.45, hold: 0.3, pose: { hip_pitch_l: -70, knee_l: 60, hip_roll_l: -20, hip_yaw_l: -30, waist_yaw: 0, hip_roll_r: 0, hip_pitch_r: 0, knee_r: 10 } },
  { dur: 0.45, hold: 0.5, pose: { waist_yaw: -70, shoulder_pitch_l: -60, shoulder_roll_l: -15, hip_pitch_l: -80, knee_l: 70 } },
];

const BRUISER_ROLL: readonly RollKey[] = [
  { dur: 0.3, hold: 0.23, pose: { hip_yaw_l: -6, hip_yaw_r: -20, hip_roll_l: -12, hip_roll_r: -23, hip_pitch_l: -59, hip_pitch_r: -27, knee_l: 103, knee_r: 48, ankle_pitch_l: -14, ankle_pitch_r: -2, shoulder_pitch_l: -26, shoulder_pitch_r: -135, shoulder_roll_l: -6, shoulder_roll_r: -94, elbow_l: -14, elbow_r: -20, waist_pitch: 50, waist_yaw: -2 } },
  { dur: 0.55, hold: 0.26, pose: { hip_yaw_l: -24, hip_yaw_r: 3, hip_roll_l: 14, hip_roll_r: -21, hip_pitch_l: -44, hip_pitch_r: -74, knee_l: 62, knee_r: 64, ankle_pitch_l: 31, ankle_pitch_r: 34, shoulder_pitch_l: -52, shoulder_pitch_r: -149, shoulder_roll_l: -6, shoulder_roll_r: -28, elbow_l: -27, elbow_r: -9, waist_pitch: 47, waist_yaw: -63 } },
  { dur: 0.22, hold: 0.11, pose: { hip_yaw_l: -3, hip_yaw_r: -2, hip_roll_l: -16, hip_roll_r: 9, hip_pitch_l: -61, hip_pitch_r: -14, knee_l: 88, knee_r: 20, ankle_pitch_l: 32, ankle_pitch_r: 17, shoulder_pitch_l: -62, shoulder_pitch_r: -140, shoulder_roll_l: 16, shoulder_roll_r: -44, elbow_l: -19, elbow_r: -67, waist_pitch: 38, waist_yaw: 17 } },
  { dur: 0.34, hold: 0.43, pose: { hip_yaw_l: -1, hip_yaw_r: 11, hip_roll_l: 12, hip_roll_r: 2, hip_pitch_l: -126, hip_pitch_r: -90, knee_l: 56, knee_r: 63, ankle_pitch_l: -19, ankle_pitch_r: -1, shoulder_pitch_l: -9, shoulder_pitch_r: -158, shoulder_roll_l: 13, shoulder_roll_r: -8, elbow_l: -22, elbow_r: -82, waist_pitch: 45, waist_yaw: -53 } },
];

const GOLIATH_ROLL: readonly RollKey[] = [
  { dur: 0.55, hold: 0.17, pose: { hip_yaw_l: -2, hip_yaw_r: 10, hip_roll_l: -9, hip_roll_r: -31, hip_pitch_l: -73, hip_pitch_r: -30, knee_l: 114, knee_r: 16, ankle_pitch_l: -3, ankle_pitch_r: 11, shoulder_pitch_l: -64, shoulder_pitch_r: -155, shoulder_roll_l: -3, shoulder_roll_r: -100, elbow_l: -5, elbow_r: -14, waist_pitch: 39, waist_yaw: -3 } },
  { dur: 0.48, hold: 0.23, pose: { hip_yaw_l: -32, hip_yaw_r: -6, hip_roll_l: 23, hip_roll_r: -32, hip_pitch_l: -30, hip_pitch_r: -89, knee_l: 36, knee_r: 43, ankle_pitch_l: 8, ankle_pitch_r: 23, shoulder_pitch_l: -62, shoulder_pitch_r: -145, shoulder_roll_l: -15, shoulder_roll_r: -46, elbow_l: -67, elbow_r: -31, waist_pitch: 50, waist_yaw: -68 } },
  { dur: 0.23, hold: 0.22, pose: { hip_yaw_l: -20, hip_yaw_r: 22, hip_roll_l: -9, hip_roll_r: 8, hip_pitch_l: -38, hip_pitch_r: -41, knee_l: 77, knee_r: 18, ankle_pitch_l: 40, ankle_pitch_r: -2, shoulder_pitch_l: -75, shoulder_pitch_r: -140, shoulder_roll_l: -2, shoulder_roll_r: -8, elbow_l: -12, elbow_r: -61, waist_pitch: 40, waist_yaw: 3 } },
  { dur: 0.36, hold: 0.48, pose: { hip_yaw_l: -10, hip_yaw_r: -2, hip_roll_l: 1, hip_roll_r: 12, hip_pitch_l: -127, hip_pitch_r: -51, knee_l: 48, knee_r: 36, ankle_pitch_l: -56, ankle_pitch_r: 22, shoulder_pitch_l: 20, shoulder_pitch_r: -155, shoulder_roll_l: 28, shoulder_roll_r: 0, elbow_l: -68, elbow_r: -24, waist_pitch: 38, waist_yaw: -53 } },
];

const ROLLS: Readonly<Record<string, readonly RollKey[]>> = { bruiser: BRUISER_ROLL, goliath: GOLIATH_ROLL };

/** The roll for a design (the default one for designs without their own). */
export function rollKeysFor(designId: string): readonly RollKey[] {
  return ROLLS[designId] ?? DEFAULT_ROLL;
}
