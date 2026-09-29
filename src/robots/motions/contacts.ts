// Ground contacts read off the source actor: which feet are planted, and which hands, knees, hips
// or chest bear weight (get-ups). The actor physically touched the floor, so this is the ground
// truth of intent; the retargeter then pins the robot's feet to it.
import { fr, type HumanTrack, type PointId } from './human';

/** Contact bit flags, one byte per frame. */
export const CONTACT = {
  FOOT_L: 1, FOOT_R: 2, HAND_L: 4, HAND_R: 8, KNEE_L: 16, KNEE_R: 32, HIPS: 64, CHEST: 128,
} as const;

export const CONTACT_NAMES: Record<number, string> = {
  1: 'foot_l', 2: 'foot_r', 4: 'hand_l', 8: 'hand_r', 16: 'knee_l', 32: 'knee_r', 64: 'hips', 128: 'chest',
};

const FOOT_HEIGHT_M = 0.035; // lowest foot point within this of the floor
const FOOT_SPEED_MS = 0.35; // and sliding slower than this
const FOOT_LEVEL_Z = 0.55; // and the sole facing the floor (sole normal · up): a toe or heel resting
// on the mat while lying down is a touch, not a planted foot
const HAND_HEIGHT_M = 0.09; // wrist-side fist point: the palm is ~5 cm below it
const KNEE_HEIGHT_M = 0.12;
const HIPS_HEIGHT_M = 0.22;
const CHEST_HEIGHT_M = 0.24;
const LIMB_SPEED_MS = 0.6;
const MIN_RUN = 3; // frames: shorter flickers are absorbed by their neighbours

function heightOf(tr: HumanTrack, id: PointId, i: number): number {
  return tr.p[id][i * 3 + 2];
}

function horizSpeed(tr: HumanTrack, id: PointId, i: number): number {
  const a = Math.max(0, i - 1), b = Math.min(tr.n - 1, i + 1);
  if (a === b) return 0;
  const p = tr.p[id];
  return (Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1]) * tr.fps) / (b - a);
}

function speed3(tr: HumanTrack, id: PointId, i: number): number {
  const a = Math.max(0, i - 1), b = Math.min(tr.n - 1, i + 1);
  if (a === b) return 0;
  const p = tr.p[id];
  return (Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]) * tr.fps) / (b - a);
}

/** Remove runs shorter than MIN_RUN (both on and off) so contacts don't flicker. */
export function debounce(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(flags);
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j < out.length && out[j] === out[i]) j++;
    const interior = i > 0 && j < out.length;
    if (interior && j - i < MIN_RUN) out.fill(out[i - 1], i, j);
    i = j;
  }
  return out;
}

/** Per-frame 0/1 planted flag for one foot. */
export function footPlanted(tr: HumanTrack, side: 'L' | 'R'): Uint8Array {
  const out = new Uint8Array(tr.n);
  const heelRest = tr.dims.ankleHeight;
  for (let i = 0; i < tr.n; i++) {
    const ball = heightOf(tr, `ball${side}`, i), toe = heightOf(tr, `toe${side}`, i);
    const heel = heightOf(tr, `ankle${side}`, i) - heelRest;
    const low = Math.min(ball, toe, heel);
    // Speed of whichever end is down: a foot pivoting on its ball is still planted.
    const v = Math.min(horizSpeed(tr, `ball${side}`, i), horizSpeed(tr, `ankle${side}`, i));
    const level = fr(tr, `foot${side}`, i)[8] > FOOT_LEVEL_Z;
    out[i] = low < FOOT_HEIGHT_M && v < FOOT_SPEED_MS && level ? 1 : 0;
  }
  return debounce(out);
}

function limbDown(tr: HumanTrack, id: PointId, height: number): Uint8Array {
  const out = new Uint8Array(tr.n);
  for (let i = 0; i < tr.n; i++) out[i] = heightOf(tr, id, i) < height && speed3(tr, id, i) < LIMB_SPEED_MS ? 1 : 0;
  return debounce(out);
}

/** Contact bitmask per frame (CONTACT flags). */
export function humanContacts(tr: HumanTrack): Uint8Array {
  const out = new Uint8Array(tr.n);
  const parts: Array<[Uint8Array, number]> = [
    [footPlanted(tr, 'L'), CONTACT.FOOT_L],
    [footPlanted(tr, 'R'), CONTACT.FOOT_R],
    [limbDown(tr, 'fistL', HAND_HEIGHT_M), CONTACT.HAND_L],
    [limbDown(tr, 'fistR', HAND_HEIGHT_M), CONTACT.HAND_R],
    [limbDown(tr, 'kneeL', KNEE_HEIGHT_M), CONTACT.KNEE_L],
    [limbDown(tr, 'kneeR', KNEE_HEIGHT_M), CONTACT.KNEE_R],
    [limbDown(tr, 'hipC', HIPS_HEIGHT_M), CONTACT.HIPS],
    [limbDown(tr, 'chest', CHEST_HEIGHT_M), CONTACT.CHEST],
  ];
  for (const [flags, bit] of parts) for (let i = 0; i < tr.n; i++) if (flags[i]) out[i] |= bit;
  return out;
}

/** Runs of consecutive frames where `flags` is set, as [start, end) pairs. */
export function runs(flags: ArrayLike<number>, bit = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && (flags[i] & bit) !== 0;
    if (on && s < 0) s = i;
    if (!on && s >= 0) {
      out.push([s, i]);
      s = -1;
    }
  }
  return out;
}
