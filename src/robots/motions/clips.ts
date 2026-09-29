// Source clips (CMU Graphics Lab Motion Capture Database, see assets-src/mocap/CREDITS.md), what
// each one is for, and the segmenter settings per clip. Labels are detected from the motion; this
// table only says which detectors run on a clip, and holds the manual overrides for what the
// detectors can't know (a victory pose is a matter of taste, not kinematics).
import type { LimbSide, MoveLabel } from './types';

export type ClipKind =
  | 'boxing' // shadow boxing: punches, guard, footwork
  | 'punches' // punch drills
  | 'kicks' // kick drills
  | 'martial' // mixed kicks and punches
  | 'blocks' // blocking drills
  | 'footwork' // side steps, walking in all directions
  | 'walk'
  | 'getup'
  | 'victory';

/** Detectors the segmenter can run on a clip. */
export type Detector = 'punch' | 'kick' | 'block' | 'guard' | 'shuffle' | 'walk' | 'getup';

export type GetupPosture = 'face_down' | 'side' | 'back';

/** A hand-placed segment (seconds in the 60 Hz track). */
export interface ManualSegment {
  label: MoveLabel;
  from: number;
  to: number;
  side?: LimbSide | null;
  mirror?: boolean; // mirror the source to make it orthodox
  loop?: boolean;
  note?: string;
}

export interface ClipInfo {
  id: string;
  kind: ClipKind;
  note: string; // CMU index description
  posture?: GetupPosture; // get-ups: how the actor starts (detected when absent)
  /** Kick drills: the kick every detected kick is (auto-classified when absent). */
  kick?: 'front' | 'round' | 'side';
  detect?: readonly Detector[]; // default: by kind (DEFAULT_DETECTORS)
  manual?: readonly ManualSegment[];
  /** Windows (seconds) the detectors ignore: stretching, fooling around, capture glitches. */
  skip?: ReadonlyArray<readonly [number, number]>;
}

export const DEFAULT_DETECTORS: Record<ClipKind, readonly Detector[]> = {
  boxing: ['punch', 'guard', 'shuffle'],
  punches: ['punch'],
  kicks: ['kick'],
  martial: ['punch', 'kick'],
  blocks: ['block'],
  footwork: ['shuffle'],
  walk: ['walk', 'shuffle'],
  getup: ['getup'],
  victory: [],
};

export const CLIPS: readonly ClipInfo[] = [
  { id: '13_17', kind: 'boxing', note: 'boxing' },
  { id: '13_18', kind: 'boxing', note: 'boxing' },
  { id: '14_01', kind: 'boxing', note: 'boxing' },
  { id: '14_02', kind: 'boxing', note: 'boxing' },
  { id: '14_03', kind: 'boxing', note: 'boxing' },
  { id: '15_13', kind: 'boxing', note: 'boxing' },
  { id: '17_10', kind: 'boxing', note: 'boxing' },
  { id: '79_08', kind: 'boxing', note: 'boxing' },
  { id: '80_10', kind: 'boxing', note: 'boxing' },
  { id: '135_04', kind: 'kicks', note: 'front kick', kick: 'front' },
  { id: '135_07', kind: 'kicks', note: 'mawashigeri (roundhouse kick)', kick: 'round' },
  { id: '135_09', kind: 'punches', note: 'oizuki (lunge punch)' },
  { id: '135_11', kind: 'kicks', note: 'yokogeri (side kick)', kick: 'side' },
  { id: '86_01', kind: 'martial', note: 'jumps, kicks and punches', detect: ['punch', 'kick', 'walk'] },
  { id: '86_06', kind: 'martial', note: 'walking, running, kicking, punching, knee kicking, stretching', detect: ['punch', 'kick', 'walk'] },
  { id: '144_05', kind: 'kicks', note: 'front kicking', kick: 'front' },
  { id: '144_09', kind: 'kicks', note: 'left front kicking', kick: 'front' },
  { id: '144_13', kind: 'punches', note: 'left punch sequence 1' },
  { id: '144_14', kind: 'punches', note: 'left punch sequence 2' },
  { id: '144_20', kind: 'punches', note: 'punch sequence' },
  { id: '144_21', kind: 'punches', note: 'punch sequence 1' },
  { id: '144_07', kind: 'blocks', note: 'left blocks' },
  { id: '144_26', kind: 'blocks', note: 'right blocks' },
  { id: '144_11', kind: 'footwork', note: 'left lunges' },
  { id: '76_01', kind: 'boxing', note: 'walk backwards then attack with a punch', detect: ['punch', 'walk', 'shuffle'] },
  { id: '76_02', kind: 'boxing', note: 'walk backwards, feint a few attacks, then attack', detect: ['punch', 'walk', 'shuffle'] },
  { id: '69_42', kind: 'footwork', note: 'walk sideways and turn (repeated)' },
  { id: '69_50', kind: 'footwork', note: 'walk sideways and backwards', detect: ['shuffle', 'walk'] },
  { id: '83_01', kind: 'footwork', note: 'large sidestep to right' },
  { id: '83_14', kind: 'footwork', note: 'short sidestep to left and down' },
  { id: '41_02', kind: 'walk', note: 'walk forward, backward, sideways, on a diagonal' },
  { id: '140_01', kind: 'getup', note: 'get up face down', posture: 'face_down' },
  { id: '140_02', kind: 'getup', note: 'get up face down', posture: 'face_down' },
  { id: '140_03', kind: 'getup', note: 'get up laying on side', posture: 'side' },
  { id: '140_04', kind: 'getup', note: 'get up laying on side', posture: 'side' },
  { id: '140_08', kind: 'getup', note: 'get up from ground laying on back', posture: 'back' },
  { id: '140_09', kind: 'getup', note: 'get up from ground laying on back', posture: 'back' },
  { id: '111_06', kind: 'getup', note: 'get up from floor' },
  { id: '111_07', kind: 'getup', note: 'get up from floor' },
  { id: '111_08', kind: 'getup', note: 'get up from floor' },
  { id: '77_16', kind: 'getup', note: 'laying down, getting up, careful ready pose' },
  { id: '77_17', kind: 'getup', note: 'laying down, getting up, careful ready pose' },
  { id: '77_18', kind: 'getup', note: 'laying down on back, getting up, careful ready pose' },
  {
    id: '79_94', kind: 'victory', note: 'flexing',
    manual: [
      { label: 'victory', from: 1.5, to: 4.9, note: 'arms up, double-biceps flex' },
      { label: 'victory', from: 4.5, to: 7.5, note: 'side flex, back to standing' },
    ],
  },
  {
    id: '56_03', kind: 'victory', note: 'vignettes: fists up, wipe window, yawn, stretch, grab, smash, lift window, throw punches, skip',
    manual: [{ label: 'victory', from: 0.3, to: 2.8, note: 'fists up' }],
  },
];

export function clipInfo(id: string): ClipInfo {
  const c = CLIPS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown mocap clip '${id}'`);
  return c;
}

export const detectorsOf = (c: ClipInfo): readonly Detector[] => c.detect ?? DEFAULT_DETECTORS[c.kind];

/** Where the raw BVH lives, relative to the project root (served by the dev server). */
export const bvhPath = (id: string): string => `assets-src/mocap/cmu/${id}.bvh`;
