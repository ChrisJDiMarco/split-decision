// Mocap get-up plan per design: for each way the body can lie, the clip variants to try first,
// best first. Produced offline by tests/control/getup-search.ts (every variant × mirror × playback
// option, dropped two ways) on 2026-09-29: success over the trials and seconds from the clip starting
// to balance taking over. Variants not listed are still tried after these (mocap/getup.ts).
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
      { id: 'getup_face_down.77_16.0090', mirror: true, opts: 'plain', ok: 2, s: 1.5 },
      { id: 'getup_face_down.77_16.0090', mirror: false, opts: 'plain', ok: 2, s: 1.5 },
      { id: 'getup_face_down.77_16.0090', mirror: true, opts: 'hands', ok: 2, s: 1.5 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 2.3 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.3 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.3 },
    ],
    side_l: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.3 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.4 },
    ],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.3 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.3 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 1, s: 4.1 },
    ],
  },
  savate: {
    face_down: [
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 2, s: 2.3 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 2.3 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'plain', ok: 1, s: 2.4 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_09.0027', mirror: false, opts: 'hands', ok: 2, s: 4.1 },
      { id: 'getup_back.140_09.0027', mirror: true, opts: 'hands', ok: 2, s: 4.1 },
    ],
    side_l: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_09.0027', mirror: false, opts: 'hands', ok: 2, s: 4.1 },
      { id: 'getup_back.140_09.0027', mirror: true, opts: 'hands', ok: 2, s: 4.1 },
    ],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_09.0027', mirror: false, opts: 'hands', ok: 2, s: 4.1 },
      { id: 'getup_back.140_09.0027', mirror: true, opts: 'hands', ok: 2, s: 4.1 },
    ],
  },
  haymaker: {
    // Re-searched after the playback rate table moved to the sampler's spline speed (slower
    // through the fast segments): the plain face-down variants now lose the feet in the crouch.
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
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'hands', ok: 2, s: 2.3 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'hands', ok: 2, s: 3.3 },
      { id: 'getup_face_down.140_02.0128', mirror: true, opts: 'plain', ok: 1, s: 2.2 },
      { id: 'getup_face_down.140_02.0128', mirror: false, opts: 'plain', ok: 1, s: 2.2 },
    ],
    back: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_side.140_03.0060', mirror: true, opts: 'plain', ok: 2, s: 3.4 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 2, s: 4.0 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 2, s: 4.0 },
    ],
    side_l: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 2, s: 4.0 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 2, s: 4.0 },
      { id: 'getup_back.140_09.0027', mirror: false, opts: 'hands', ok: 2, s: 4.1 },
    ],
    side_r: [
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'plain', ok: 2, s: 2.4 },
      { id: 'getup_back.140_08.0076', mirror: false, opts: 'hands', ok: 2, s: 4.0 },
      { id: 'getup_back.140_08.0076', mirror: true, opts: 'hands', ok: 2, s: 4.0 },
      { id: 'getup_back.140_09.0027', mirror: true, opts: 'hands', ok: 1, s: 4.1 },
    ],
  },
};
