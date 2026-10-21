// How fast a knocked-down fighter gets back up (docs/design/strike-power.md §4.6: "pop right back up").
// One table for the whole get-up so tools can sweep it (the worker never changes it): the settle on the
// canvas (getup.ts), the mocap clip (mocap/getup.ts), the crouch over the feet and the rise into the
// stance (rise.ts). The motors' torque-speed lines, heat and battery decide what is reachable; these only
// stop the controller from waiting longer than the body needs.
//
// Measured with tools/balance-drills.ts --drills getups (each modern design laid face down, on its back and
// on both sides, three drops each; first movement to stable standing, median):
//   as built (align 0.55 s, pace 1.15, rise 1, standHeight 0.35, crouch 1)
//     FIRECRACKER 4.5 s, SAVATE 5.5 s, HAYMAKER 5.7 s, PYLON 5.4 s; standing within 5 s of going down 1, 0, 0, 0 of 12
//   these values
//     FIRECRACKER 3.1 s, SAVATE 3.1 s, HAYMAKER 2.9 s, PYLON 3.0 s; within 5 s 9, 12, 7, 10 of 12
export const GETUP_SPEED = {
  settle: 1, // × the design's brace and settle times on the canvas
  stillS: 0.12, // lying this still this long ends the settle
  alignS: 0.25, // the joints ease from how the body landed into the clip's first frame over this
  pace: 2.5, // the clip at this × the actor where the joints allow it (the rate table caps it: library.ts MAX_RATE)
  rise: 0.3, // × the design's time to stand up out of the crouch
  riseEngine: 0, // 1: the balance engine (not the legacy balance) carries the rise (measured worse: off)
  damp: 1, // servo damping while the get-up clip plays, × as built (strike-power.md §2.1 burst; 0.4 measured no faster)
  standHeight: 0.15, // balance takes a clip's body over once its feet are down and the pelvis is this × stance height up
  crouch: 0, // 1: once a back or side clip's feet are down, the crouch carries the COM over them; 0: the clip plays on (face-down clips always crouch)
  rollFirst: 0, // 1: on the back or a side, roll onto the front first, then the face-down clip (the default roll keys do not roll the modern bodies)
  roll: 1, // × the roll keys' durations
};

export type GetupSpeed = typeof GETUP_SPEED;

/**
 * Per-design overrides (a tool's --tune of GETUP_SPEED does not reach a value a design overrides here).
 */
export const GETUP_DESIGN: Record<string, Partial<GetupSpeed>> = {
  // The heaviest body on the slowest hips: the faster clips fell back and lost the feet more often. Laid down four
  // ways (12 drops): as built 8 up (none within 5 s); the table's values 5 up (5 within 5 s); these 10 up (4 within
  // 5 s, median 4.4 s from the first movement), and the crouch it was searched with.
  haymaker: { pace: 1.15, alignS: 0.55, rise: 0.5, standHeight: 0.35, crouch: 1 },
  // The iron age lumbers up on purpose (strike-power.md §4.6: 236-408 kg on hydraulics, ≤ 4 s, the contrast is
  // part of the show) and gets up by the scripted sequence: its rise stays as built (at 0.3 GOLIATH fell out of it).
  bruiser: { rise: 1 },
  striker: { rise: 1 },
  goliath: { rise: 1 },
};

/** The get-up speeds for a design: the table, then its own overrides. */
export function getupSpeed(designId: string): GetupSpeed {
  return { ...GETUP_SPEED, ...GETUP_DESIGN[designId] };
}

