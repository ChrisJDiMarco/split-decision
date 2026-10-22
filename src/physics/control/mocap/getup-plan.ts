// Mocap get-up plan per design: for each way the body can lie, the clip variants to try first,
// best first. Produced offline by tests/control/getup-search.ts (every variant × mirror × playback
// option, dropped two ways): success over the trials and seconds from the clip starting to balance
// taking over. Variants not listed are still tried after these (mocap/getup.ts).
// Re-searched 2026-10-20 (balance P4) for the modern four after the strike pass's motor swaps and with the
// faster get-up (getup-speed.ts: align 0.25 s, pace 2.5, rise 0.3, back and side clips playing on instead
// of the crouch); the 2026-09-29 plan lost the feet in the crouch off the back and sides.
// Face down re-searched 2026-10-21 on the hardware-realism bodies (heavier trunks, light feet): the old firsts
// failed there (SAVATE's 77_16 rolled over or fell back, PYLON's 140_02 rolled over in 7 of 8 fight falls). Off the
// back and sides HAYMAKER and PYLON stand from no variant any more (0 of 2 everywhere): they roll onto the front
// first (getup-speed.ts rollFirst), so their back and side lists are only a fallback (an arm too damaged for the
// face-down clips). SAVATE's back: the mirrored pop-up first (1 of 2; the unmirrored one 0 of 2, and in fights it
// stalled 9 times where the mirror stood).
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
      // (Ranked on 13 recorded fall endings, first try: 77_16 13/13 handed over, 11 standing within 5 s; 140_02 13/13,
      // 12 within 5 s; the mirrored 77_16 the clean drops ranked first 13/13 but only 6 within 5 s.)
      { id: 'getup_face_down.77_16.0090', mirror: false, opts: 'plain', ok: 2, s: 1.1 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'plain', ok: 2, s: 1.4 },
      { id: 'getup_face_down.77_16.0090', mirror: false, opts: 'hands', ok: 2, s: 1.2 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'plain', ok: 2, s: 1.4 },
      { id: 'getup_face_down.77_16.0090', mirror: true, opts: 'plain', ok: 2, s: 1.1 },
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
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'plain', ok: 2, s: 1.6 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'plain', ok: 2, s: 1.6 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 2.0 },
      { id: 'getup_face_down.140_01.0105', mirror: false, opts: 'plain', ok: 2, s: 2.1 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 1, s: 2.1 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 0, s: 2.2 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 0, s: 3.3 },
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
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 2.4 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 2, s: 2.4 },
      { id: 'getup_face_down.77_17.0095', mirror: false, opts: 'plain', ok: 1, s: 4.5 },
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
      // (Ranked after its roll on recorded fall endings, first try: 140_02 with the hands put on the canvas handed over 48/50
      // unmirrored and 46/50 mirrored, and each catches the rolls of its own side best (getup-speed.ts rollMirror); the clean
      // drops' first, 140_01 with the hands, 16/32.)
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 1, s: 1.8 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 1, s: 1.5 },
      { id: 'getup_face_down.140_01.0105', mirror: true, opts: 'plain', ok: 2, s: 2.0 },
      { id: 'getup_face_down.140_01.0105', mirror: false, opts: 'plain', ok: 1, s: 1.7 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'plain', ok: 1, s: 1.5 },
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
