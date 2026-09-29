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
  | 'victory'
  | 'flashy' // jump, spin and acrobatic clips: hand-placed windows (ClipInfo.flashy)
  | 'evasion'; // cuts, jukes, spins on the move

/** Detectors the segmenter can run on a clip. */
export type Detector = 'punch' | 'kick' | 'block' | 'guard' | 'shuffle' | 'walk' | 'getup' | 'pivot' | 'switch';

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

/**
 * A flashy move placed by hand (seconds in the 60 Hz track, source sides). The segmenter measures
 * the rest from the motion: the impact (the striker's peak speed inside `strike`), full reach,
 * the strike onset, the airborne run, the spin, and whether to mirror so the move is stored the
 * orthodox way (spins clockwise seen from above; straight flashy strikes with the right side).
 */
export interface FlashySpec {
  label: MoveLabel;
  from: number;
  to: number;
  /** Part that lands, source side ('foot_l', 'fist_r', 'shin_r' = the knee). Default: none. */
  striker?: string;
  /** Seconds window the impact is searched in (default [from, to]). */
  strike?: readonly [number, number];
  /**
   * Derived moves: 'knee' folds the striking leg so the knee leads (a jump kick → a jumping knee);
   * 'leap' lifts the whole actor on a ballistic arc over the stepping foot's swing (a lunge punch
   * → a superman punch); 'spin' adds a full turn on the support foot before the strike (a side
   * kick → a spinning side kick).
   */
  derive?: ReadonlyArray<'knee' | 'leap' | 'spin'>;
  /** 'spin': the extra full turn on the support foot runs from this long before the strike onset
   * to this long before the impact (seconds). */
  spinWindow?: readonly [number, number];
  /** A leap centred on the impact instead of the stepping foot's swing: seconds before and after. */
  leapAround?: readonly [number, number];
  /** Also store the mirror image under this label (a feint left mirrored is a feint right). */
  mirrorAs?: MoveLabel;
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
  flashy?: readonly FlashySpec[];
}

export const DEFAULT_DETECTORS: Record<ClipKind, readonly Detector[]> = {
  boxing: ['punch', 'guard', 'shuffle', 'switch', 'pivot'],
  punches: ['punch'],
  kicks: ['kick'],
  martial: ['punch', 'kick'],
  blocks: ['block'],
  footwork: ['shuffle', 'pivot'],
  walk: ['walk', 'shuffle'],
  getup: ['getup'],
  victory: [],
  flashy: [],
  evasion: ['pivot'],
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
  {
    id: '135_04', kind: 'kicks', note: 'front kick', kick: 'front',
    // Jumping front kicks and knees: the drill's front kicks lifted into a hop off the support
    // foot, a ballistic 0.35 s arc around the impact (about 15 cm up).
    flashy: [
      { label: 'jump_kick', from: 2.47, to: 3.82, striker: 'foot_r', strike: [2.9, 3.2], derive: ['leap'], leapAround: [0.25, 0.1] },
      { label: 'jump_kick', from: 4.18, to: 5.65, striker: 'foot_l', strike: [4.6, 4.95], derive: ['leap'], leapAround: [0.25, 0.1] },
      { label: 'jump_kick', from: 6.08, to: 7.5, striker: 'foot_r', strike: [6.5, 6.85], derive: ['leap'], leapAround: [0.25, 0.1] },
      { label: 'jumping_knee', from: 2.47, to: 3.82, striker: 'shin_r', strike: [2.72, 3.12], derive: ['knee', 'leap'], leapAround: [0.25, 0.1] },
      { label: 'jumping_knee', from: 6.08, to: 7.5, striker: 'shin_r', strike: [6.33, 6.75], derive: ['knee', 'leap'], leapAround: [0.25, 0.1] },
    ],
  },
  {
    id: '135_07', kind: 'kicks', note: 'mawashigeri (roundhouse kick)', kick: 'round',
    // Tornado kicks: the kata's head-high roundhouses with a full turn added on the support foot
    // in the chamber and a hop off it into the kick (spin + jump + roundhouse).
    flashy: ([[0.27, 'foot_r', 0.92], [2.98, 'foot_l', 3.62], [5.73, 'foot_r', 6.37], [8.72, 'foot_l', 9.28]] as const).map(([t, striker, imp]) => ({
      label: 'tornado_kick' as const, from: t, to: t + 1.55, striker, strike: [imp - 0.15, imp + 0.08] as const,
      derive: ['spin', 'leap'] as const, spinWindow: [0.2, 0.06] as const, leapAround: [0.25, 0.1] as const,
      note: 'roundhouse with a full turn and a hop added',
    })),
  },
  {
    id: '135_11', kind: 'kicks', note: 'yokogeri (side kick)', kick: 'side',
    // Spinning back (side) kicks: the lead-leg side kicks with a full clockwise turn on the support
    // foot added during the chamber, so the fighter shows his back and thrusts through the turn.
    flashy: [10.37, 12.6, 14.87, 17.18].map((t) => ({
      label: 'spinning_back_kick' as const, from: t, to: t + 1.5, striker: 'foot_l', strike: [t + 0.3, t + 0.55] as const,
      derive: ['spin'] as const, spinWindow: [0.2, 0.06] as const, note: 'side kick with a full turn added on the support foot',
    })),
  },
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
  // Flashy moves (approved 2026-09-29): spin and jump kicks, the handspring family, evasion.
  {
    id: '90_05', kind: 'flashy', note: 'jump kick (a 360° jumping spin kick: hop, spin, left roundhouse at the apex)',
    flashy: [{ label: 'tornado_kick', from: 0.9, to: 3.3, striker: 'foot_l', strike: [2.0, 2.6] }],
  },
  {
    id: '90_06', kind: 'flashy', note: 'jump kick (360° jumping spin kick)',
    flashy: [{ label: 'tornado_kick', from: 2.2, to: 4.7, striker: 'foot_l', strike: [3.35, 3.9] }],
  },
  {
    id: '90_07', kind: 'flashy', note: 'jump kick (360° jumping spin kick)',
    flashy: [{ label: 'tornado_kick', from: 4.3, to: 7.0, striker: 'foot_l', strike: [5.55, 6.1] }],
  },
  {
    id: '87_01', kind: 'flashy', note: 'jump with kick and spin (butterfly-style 540: body flat, legs scissor)',
    flashy: [
      { label: 'tornado_kick', from: 0.7, to: 3.2, striker: 'foot_l', strike: [1.95, 2.35] },
      { label: 'spinning_back_kick', from: 0.2, to: 3.2, striker: 'foot_r', strike: [1.6, 2.5], note: 'rear heel whips round after ~200° of turn' },
    ],
  },
  // Capoeira (ginga, aerials with hands down, a fast pirouette that runs straight into a flip):
  // nothing a biped robot can land cleanly on its feet, so no moves are taken from it.
  { id: '88_04', kind: 'flashy', note: 'spin kicks, spins (capoeira: ginga, aerials, a pirouette into a flip)' },
  {
    id: '88_06', kind: 'flashy', note: 'jump and spin kick (butterfly-style)',
    flashy: [
      { label: 'tornado_kick', from: 0.0, to: 1.3, striker: 'foot_l', strike: [0.5, 0.75] },
      { label: 'spinning_back_kick', from: 0.0, to: 1.3, striker: 'foot_r', strike: [0.3, 0.9] },
    ],
  },
  {
    id: '75_16', kind: 'flashy', note: 'jump kick (jumping front kick off the back foot)',
    flashy: [
      { label: 'jump_kick', from: 1.2, to: 2.7, striker: 'foot_r', strike: [1.8, 2.1] },
      { label: 'jumping_knee', from: 1.2, to: 2.7, striker: 'shin_r', strike: [1.75, 2.05], derive: ['knee'] },
    ],
  },
  {
    id: '75_08', kind: 'flashy', note: '360 jumps (the arm whips out on the way round: a jumping spinning backfist)',
    flashy: [
      { label: 'spinning_backfist', from: 1.3, to: 3.0, striker: 'fist_r', strike: [2.1, 2.9] },
      { label: 'spinning_backfist', from: 3.1, to: 4.8, striker: 'fist_r', strike: [3.9, 4.7] },
      { label: 'spinning_backfist', from: 6.1, to: 7.8, striker: 'fist_r', strike: [7.0, 7.7] },
    ],
  },
  {
    id: '135_09', kind: 'punches', note: 'oizuki (lunge punch)', detect: ['punch'],
    flashy: [
      { label: 'superman_punch', from: 3.88, to: 5.27, striker: 'fist_l', strike: [4.15, 4.53], derive: ['leap'], note: 'lunge punch lifted into a leap' },
      { label: 'superman_punch', from: 5.82, to: 6.72, striker: 'fist_r', strike: [6.08, 6.6], derive: ['leap'] },
      { label: 'superman_punch', from: 7.77, to: 9.03, striker: 'fist_l', strike: [8.0, 8.4], derive: ['leap'] },
    ],
  },
  {
    id: '90_09', kind: 'flashy', note: 'flip forward onto hands and back (front handspring)',
    flashy: [{ label: 'kipup_source', from: 0.75, to: 2.35 }],
  },
  { id: '90_11', kind: 'flashy', note: 'hand spring', flashy: [{ label: 'kipup_source', from: 0.0, to: 1.5 }] },
  {
    id: '88_08', kind: 'flashy', note: 'crouch and flip backward on hands (back handspring)',
    flashy: [{ label: 'kipup_source', from: 0.55, to: 2.35 }],
  },
  {
    id: '85_03', kind: 'flashy', note: 'breakdance upright sequence (drops to the floor and springs back up)',
    flashy: [
      { label: 'kipup_source', from: 13.4, to: 14.7 },
      { label: 'kipup_source', from: 15.7, to: 16.9 },
      { label: 'kipup_source', from: 20.1, to: 21.4 },
      { label: 'kipup_source', from: 22.1, to: 23.3 },
    ],
  },
  {
    id: '85_11', kind: 'flashy', note: 'breakdance upright sequence',
    flashy: [
      { label: 'kipup_source', from: 5.4, to: 6.6 },
      { label: 'kipup_source', from: 12.4, to: 13.9 },
    ],
  },
  { id: '85_05', kind: 'flashy', note: 'handstand kicks' },
  { id: '85_01', kind: 'flashy', note: 'jump twist (aerial)' },
  { id: '83_61', kind: 'evasion', note: 'hop turn 360' },
  { id: '78_13', kind: 'evasion', note: 'spin move', flashy: [
    { label: 'spinning_backfist', from: 0.0, to: 1.0, striker: 'fist_r', strike: [0.2, 0.8], note: 'a running spin move, the arm swung round' },
  ] },
  { id: '78_18', kind: 'evasion', note: 'walk evasive' },
  {
    id: '78_20', kind: 'evasion', note: 'feint left move right',
    flashy: [{ label: 'feint_left', from: 0.1, to: 1.15, mirrorAs: 'feint_right' }],
  },
  {
    id: '78_21', kind: 'evasion', note: 'feint right move left',
    flashy: [{ label: 'feint_right', from: 0.1, to: 1.15, mirrorAs: 'feint_left' }],
  },
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
