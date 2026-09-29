# Fighter intelligence: mocap tracking, flashy moves, openings

Status: spec for the next build (written 2026-09-29). Builds on the electric roster (`docs/research/08-modern-roster.*`) and the mocap library (`src/robots/motions/`).

## What Chris asked for

- Movement that is "competent and fast and violently cool", human-like walking, real hard punches and kicks.
- Get-ups that use all limbs, unless legs or joints are wrecked.
- Superhuman balance and capability, but physically grounded.
- Flashy moves: robots should **attempt** tornado kicks, kip-ups "and other stuff". It doesn't have to be perfect. Fighters shouldn't always be squared up. They should be "opportunistic, creative and intelligent."

## Principles

1. **Superhuman from real advantages, never from hidden forces.** The advantages are 500 Hz reflexes, full proprioception, QDD torque-to-weight of 2 to 4× a human's, the gyro core (a control moment gyroscope that saturates, draws power and can be damaged), and better catch-steps. Moves play faster than the human source wherever each joint's torque-speed curve allows.
2. **Mocap supplies the style; physics decides the outcome.** Servos track the retargeted human motion. The balance layer and the gyro keep it upright when they can. A damaged joint, a drained battery or a saturated gyro makes the move fail visibly.
3. **Risk is honest and visible.** Every flashy move has a fall-risk estimate computed from the fighter's current body state. Jev sees it and decides whether to gamble. Failed attempts are part of the show.
4. **Jev is the mind, never the motors.** Code detects openings and computes risk. Jev picks among moves and combos. The body executes.

## Protocol additions (src/core/protocol.ts, additive)

```ts
// New tactics (Tactic union)
| 'spinning_back_kick' | 'tornado_kick' | 'jump_kick' | 'jumping_knee' | 'superman_punch'
| 'spinning_backfist' | 'switch_stance' | 'pivot_left' | 'pivot_right' | 'feint_left' | 'feint_right'
| 'combo'                       // run Intent.combo in order

// Intent gains
combo?: Tactic[];                 // 2-4 strikes/feints, e.g. ['jab','cross','low_kick']
getupStyle?: 'safe' | 'kip_up';   // how to rise when down
flourish?: boolean;               // allowed to attempt a flashy variant if the opening is still there

// RobotTelemetry gains
openings: Opening[];              // what this fighter sees on its opponent right now
moveRisk: Record<string, number>; // 0..1 fall/failure risk per available flashy move, from body state
stance: 'orthodox' | 'southpaw';
facingOffDeg: number;             // signed angle off square to the opponent (not always 0)

type Opening =
  | 'off_balance' | 'turned_away' | 'missed_recovering' | 'stunned' | 'rising'
  | 'on_cage' | 'gyro_saturated' | 'weak_left_leg' | 'weak_right_leg' | 'low_guard' | 'overcommitted';
```

## Control (src/physics/control/, one owner at a time)

- **MotionPlayer**: plays a library `Move` at control rate (500 Hz), with:
  - time scaled by `speedFor` (the fastest the robot's joints can do the move) × aggression;
  - aim warping, where the striking end effector's path bends toward the live target zone over the last 40% before the impact frame;
  - root trajectory mapped to footwork targets;
  - the contact schedule driving which foot is support.
- **Balance layer under mocap.** Upper-body joints follow the clip. Stance-leg ankle and hip get COM and capture-point corrections at 500 Hz, and the gyro holds the torso. Swing-leg and root motion blend clip and balance by a per-move weight. Gravity feed-forward shifts servo targets by τ/kp.
- **Moves from the library**: jabs, crosses, hooks, uppercuts, overhand, front, low and head kicks, guard bounce, shuffles in four directions, walk, feints and evasive steps (78_18 to 78_21), victory.
- **Flashy moves**:
  - spinning back kick and tornado kick: 87_01, 88_04, 88_06;
  - jump kick: 90_05 to 90_07, 75_16;
  - jumping knee and superman punch: jump kick clips edited;
  - spinning backfist: 88_04, 78_13.
  - Each has a take-off readiness check (support foot planted, gyro momentum budget, battery, joint health). It may still fall. That is the point.
- **Get-ups**:
  - mocap `getup_face_down`, `getup_back`, `getup_side`, chosen from orientation, with a retry that picks another variant;
  - **kip-up**, from the handspring and back-roll family (90_09, 90_11, 88_08, 85_03, 85_11) plus a per-design CPU cross-entropy search over a few keyframe timings and gains. The search runs offline; results are stored per design. Light bodies should succeed often and heavy ones rarely;
  - limp limbs rule a variant out, and a robot with a wrecked leg stays down.
- **Openings and moveRisk** are computed in physics from both robots' states and published in telemetry.
- **Stance and angles**: stance switching (mirror moves), pivots, attacking off-square. `facingOffDeg` is allowed to be non-zero on purpose.

## Brain (src/brain/)

- State adds the current openings in words ("he's turned away", "his left knee is failing", "he just missed a hook"), risk bands for flashy moves, and a running record ("your tornado kicks: 1 of 3 landed, fell once").
- New questions per decision:
  - `opening_move`: a choice over the flashy and opportunistic moves available right now, each with a risk and payoff description, plus `none`.
  - `combo`: a choice over 4 to 8 generated combos that fit the design's abilities and style.
  - `getup_style`: a noul, asked only when down.
- Temperament and aggression scale the gamble. Each design's fight style from the roster doc weights its menu: FIRECRACKER volume, SAVATE kicks, PYLON range and spins, HAYMAKER pressure.
- The House Mind fallback gets simple versions of the same rules.

## Metrics (tools/fight-metrics.ts)

Existing metrics, plus:

- flashy attempts, landed and fell per fighter;
- kip-up attempts and successes;
- how many decisions exploited an opening (and whether they landed);
- off-square time share;
- combo completion.

Target: fights where flashy attempts happen a few times a round, land sometimes, and occasionally backfire.
