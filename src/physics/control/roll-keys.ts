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
//
// The modern bodies roll onto the front before they get up (getup-speed.ts rollFirst), then play a
// face-down clip: since the hardware realism pass (real armature, drives mounted up the limbs, own
// ankle drives) their trunks are heavy on light feet, and the pop-up off the back that sits up and rocks
// over the feet no longer gets them up (HAYMAKER and PYLON 0 of 2 on every back and side variant,
// tests/control/getup-search.ts; the trunk tips back as the hips fold, the light legs rise instead of
// anchoring it, and PYLON's and SAVATE's RS04 waist cannot curl the torso up from flat). Their keys were
// searched the same way (tests/control/roll-search.ts: cross-entropy, laid on the back and on both sides,
// scored on standing up through the face-down clip), and a key may wait for the roll itself: `until`.

export interface RollKey {
  dur: number;
  hold: number;
  pose: Readonly<Record<string, number>>;
  /** Degrees rolled (0 face up, 90 on the side it rolls over, 180 face down) this key must reach by the end of its
   *  hold, else the roll has failed (lie still, try the other way); then the next key. Without it the key just plays. */
  until?: number;
  /** A body already rolled past this many degrees when the roll starts skips this key (a fall that ended on a side). */
  skip?: number;
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

// HAYMAKER (2026-10-21): searched on two laid-down starts and seven recorded fall endings, the flat-on-the-back ones where
// the first search's keys did not roll it (tests/balance/capture-falls.ts): standing or handed over from all nine.
const HAYMAKER_ROLL: readonly RollKey[] = [
  { dur: 0.54, hold: 0.15, pose: { hip_yaw_l: -40, hip_yaw_r: -32, hip_roll_l: -15, hip_roll_r: -14, hip_pitch_l: -94, hip_pitch_r: -41, knee_l: 67, knee_r: 58, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -114, shoulder_pitch_r: -161, shoulder_roll_l: -28, shoulder_roll_r: -45, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -30, elbow_r: -20, waist_pitch: 59, waist_yaw: -50 } },
  { dur: 0.47, hold: 0.26, pose: { hip_yaw_l: 12, hip_yaw_r: -22, hip_roll_l: 14, hip_roll_r: 31, hip_pitch_l: -48, hip_pitch_r: 17, knee_l: 58, knee_r: 25, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -118, shoulder_pitch_r: -151, shoulder_roll_l: -19, shoulder_roll_r: 31, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -23, elbow_r: -30, waist_pitch: 23, waist_yaw: -6 } },
  { dur: 0.40, hold: 0.39, pose: { hip_yaw_l: -26, hip_yaw_r: 29, hip_roll_l: 6, hip_roll_r: 4, hip_pitch_l: -86, hip_pitch_r: 20, knee_l: 62, knee_r: 19, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -15, shoulder_pitch_r: -147, shoulder_roll_l: -21, shoulder_roll_r: -4, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -3, elbow_r: -6, waist_pitch: 4, waist_yaw: -61 } },
];

// PYLON (2026-10-21, waiting on the roll angle): laid on the back and both sides, standing after the face-down clip 4/4
// (6.0-6.7 s). (Played through without the `until` gates, 111 recorded fall endings replayed in the drill world handed
// over more, 91 → 104 legacy and 78 → 96 dcm, but sparring fights lost more: a gate gives up in half a second and the
// next attempt goes over the other side, where a played-through roll that is stuck burns two.)
const PYLON_ROLL: readonly RollKey[] = [
  { dur: 0.45, hold: 0.11, until: 48, skip: 38, pose: { hip_yaw_l: -37, hip_yaw_r: 6, hip_roll_l: -4, hip_roll_r: -17, hip_pitch_l: -61, hip_pitch_r: -78, knee_l: 58, knee_r: 44, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -129, shoulder_pitch_r: -165, shoulder_roll_l: -29, shoulder_roll_r: -59, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -15, elbow_r: -25, waist_pitch: 44, waist_yaw: -54 } },
  { dur: 0.60, hold: 0.29, until: 119, skip: 109, pose: { hip_yaw_l: 28, hip_yaw_r: 5, hip_roll_l: 33, hip_roll_r: 11, hip_pitch_l: -79, hip_pitch_r: -4, knee_l: 27, knee_r: 29, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -117, shoulder_pitch_r: -139, shoulder_roll_l: -23, shoulder_roll_r: 29, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -41, elbow_r: -25, waist_pitch: -11, waist_yaw: -28 } },
  { dur: 0.45, hold: 0.36, pose: { hip_yaw_l: -29, hip_yaw_r: 20, hip_roll_l: -25, hip_roll_r: -6, hip_pitch_l: -71, hip_pitch_r: 16, knee_l: 96, knee_r: 15, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -37, shoulder_pitch_r: -153, shoulder_roll_l: -15, shoulder_roll_r: 0, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -2, elbow_r: -25, waist_pitch: -4, waist_yaw: -35 } },
];

// FIRECRACKER (2026-10-21): only a fallback (its pop-up off the back still stands it; getup-speed.ts rollAfter): laid on
// the back and both sides, standing after the face-down clip 4/4 (3.0-5.3 s).
const FIRECRACKER_ROLL: readonly RollKey[] = [
  { dur: 0.43, hold: 0.11, until: 49, skip: 39, pose: { hip_yaw_l: -37, hip_yaw_r: -5, hip_roll_l: -4, hip_roll_r: -12, hip_pitch_l: -87, hip_pitch_r: -57, knee_l: 35, knee_r: 50, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -137, shoulder_pitch_r: -142, shoulder_roll_l: -33, shoulder_roll_r: -49, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -24, elbow_r: -59, waist_pitch: 51, waist_yaw: -51 } },
  { dur: 0.53, hold: 0.35, until: 118, skip: 108, pose: { hip_yaw_l: 35, hip_yaw_r: 17, hip_roll_l: 43, hip_roll_r: 29, hip_pitch_l: -37, hip_pitch_r: -28, knee_l: 19, knee_r: 6, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -113, shoulder_pitch_r: -136, shoulder_roll_l: -29, shoulder_roll_r: 29, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -50, elbow_r: -17, waist_pitch: -18, waist_yaw: -48 } },
  { dur: 0.47, hold: 0.36, pose: { hip_yaw_l: -37, hip_yaw_r: 6, hip_roll_l: -8, hip_roll_r: 4, hip_pitch_l: -66, hip_pitch_r: 10, knee_l: 77, knee_r: 2, ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_pitch_l: -20, shoulder_pitch_r: -138, shoulder_roll_l: -26, shoulder_roll_r: -27, shoulder_yaw_l: 0, shoulder_yaw_r: 0, elbow_l: -16, elbow_r: -34, waist_pitch: 6, waist_yaw: -53 } },
];

const ROLLS: Readonly<Record<string, readonly RollKey[]>> = { bruiser: BRUISER_ROLL, goliath: GOLIATH_ROLL, haymaker: HAYMAKER_ROLL, pylon: PYLON_ROLL, firecracker: FIRECRACKER_ROLL };

/** Tools (tests/control/roll-search.ts): play these keys instead of the design's. The worker never sets it. */
export const ROLL_OVERRIDE: { keys: readonly RollKey[] | null } = { keys: null };

/** The roll for a design (the default one for designs without their own). */
export function rollKeysFor(designId: string): readonly RollKey[] {
  return ROLL_OVERRIDE.keys ?? ROLLS[designId] ?? DEFAULT_ROLL;
}
