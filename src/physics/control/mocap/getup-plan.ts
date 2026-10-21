// Mocap get-up plan per design: for each way the body can lie, the clip variants to try first,
// best first. Produced offline by tests/control/getup-search.ts (every variant × mirror × playback
// option, dropped two ways): success over the trials and seconds from the clip starting to balance
// taking over. Variants not listed are still tried after these (mocap/getup.ts).
// Re-searched 2026-10-20 (balance P4) for the modern four after the strike pass's motor swaps and with the
// faster get-up (getup-speed.ts: align 0.25 s, pace 2.5, rise 0.3, back and side clips playing on instead
// of the crouch); the 2026-09-29 plan lost the feet in the crouch off the back and sides.
import type { LyingOrientation } from './getup';

export interface PlanEntry {
  id: string;
  mirror: boolean;
  /** 'hands': fists the clip has on the canvas are put on it, and the hands only leave the canvas
   *  once the COM is over the feet; 'plain': the clip as retargeted. */
  opts: 'plain' | 'hands';
  ok: number; // of 2 trials
  s: number;
}

export const GETUP_PLAN: Record<string, Partial<Record<LyingOrientation, PlanEntry[]>>> = {
  firecracker: {
    face_down: [
      { id: 'getup_face_down.77_16.0090', mirror: true, opts: 'hands', ok: 2, s: 1.0 },
      { id: 'getup_face_down.77_16.0090', mirror: false, opts: 'hands', ok: 2, s: 1.1 },
      { id: 'getup_face_down.77_16.0090', mirror: false, opts: 'plain', ok: 2, s: 1.2 },
      { id: 'getup_face_down.77_16.0090', mirror: true, opts: 'plain', ok: 2, s: 1.4 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 2, s: 1.5 },
    ],
    // (Back and left side: the unmirrored clip first. The search ranked the mirror first on clean drops; after
    // real falls the mirror fell back late in the clip and the unmirrored retry stood: standing within 5 s of a
    // fall 14 → 22 of 33 in the hit and fall drills.)
    back: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 1, s: 1.4 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 1.7 },
      { id: 'getup_side.140_04.0082', mirror: false, opts: 'plain', ok: 1, s: 2.7 },
      { id: 'getup_side.140_03.0060', mirror: true, opts: 'hands', ok: 1, s: 3.3 },
    ],
    side_l: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 1, s: 2.0 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.0 },
    ],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 1.8 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 1.9 },
      { id: 'getup_side.140_03.0060', mirror: false, opts: 'hands', ok: 1, s: 3.3 },
      { id: 'getup_side.140_04.0082', mirror: true, opts: 'hands', ok: 1, s: 3.5 },
    ],
  },
  savate: {
    face_down: [
      { id: 'getup_face_down.77_16.0090', mirror: false, opts: 'hands', ok: 2, s: 1.5 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 1.6 },
      { id: 'getup_face_down.77_16.0090', mirror: true, opts: 'hands', ok: 2, s: 1.9 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 1, s: 1.6 },
      { id: 'getup_face_down.140_01.0105', mirror: false, opts: 'hands', ok: 1, s: 2.2 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.2 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.2 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 2, s: 3.3 },
      { id: 'getup_side.140_03.0060', mirror: false, opts: 'plain', ok: 1, s: 3.0 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 1, s: 3.3 },
    ],
    side_l: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 1, s: 2.2 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.7 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 1, s: 3.3 },
    ],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.0 },
      { id: 'getup_side.140_03.0060', mirror: false, opts: 'plain', ok: 2, s: 3.1 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.2 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 1, s: 3.3 },
    ],
  },
  haymaker: {
    // Kept from the 2026-09-29 search: re-searched at the faster get-up, every variant landed at best 1 of 2
    // (HAYMAKER is the heaviest body, on the slowest hips: getup-speed.ts gives it a gentler pace).
    face_down: [
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 2, s: 2.5 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 2.5 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'plain', ok: 1, s: 2.3 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.6 },
      { id: 'getup_back.140_09.0027', mirror: false, opts: 'plain', ok: 2, s: 3.1 },
      { id: 'getup_back.140_09.0027', mirror: true, opts: 'plain', ok: 2, s: 3.1 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 3.1 },
    ],
    side_l: [],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.6 },
      { id: 'getup_back.140_09.0027', mirror: true, opts: 'plain', ok: 1, s: 3.2 },
      { id: 'getup_back.140_09.0027', mirror: false, opts: 'plain', ok: 1, s: 3.2 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 1, s: 3.6 },
      { id: 'getup_side.77_18.0044', mirror: true, opts: 'hands', ok: 1, s: 4.5 },
    ],
  },
  pylon: {
    face_down: [
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'plain', ok: 2, s: 1.7 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 2, s: 1.7 },
      { id: 'getup_face_down.140_01.0105', mirror: true, opts: 'plain', ok: 2, s: 1.9 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'plain', ok: 1, s: 1.5 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 1, s: 1.8 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.0 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.0 },
      { id: 'getup_side.140_03.0060', mirror: false, opts: 'plain', ok: 2, s: 2.9 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 2, s: 3.1 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 2, s: 3.1 },
    ],
    side_l: [
      { id: 'getup_side.140_03.0060', mirror: true, opts: 'plain', ok: 2, s: 3.2 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 1, s: 1.9 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.2 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 1, s: 3.1 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 1, s: 3.1 },
    ],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 1.9 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 2, s: 3.1 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.1 },
      { id: 'getup_side.140_03.0060', mirror: true, opts: 'plain', ok: 1, s: 3.0 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 1, s: 3.1 },
    ],
  },
};
