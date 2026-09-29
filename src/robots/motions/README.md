# Motion library (CMU mocap → per-design robot moves)

Moves are retargeted from the CMU Graphics Lab Motion Capture Database (credits in `assets-src/mocap/CREDITS.md`) onto each biped design's own joint tree. The tracking controller reads them as servo targets, feed-forward velocities, a pelvis reference and contact plans. Everything in this folder is plain data and math with no three.js and no DOM, so it runs in the physics worker.

```
assets-src/mocap/cmu/*.bvh ──> human.ts (BVH → 60 Hz landmarks, x fwd / y left / z up, floor z = 0)
   segment.ts  labelled segments with phases (clips.ts says which detectors run on which clip)
   flashy.ts   flashy moves from hand-placed windows (ClipInfo.flashy), pivots, stance switches
   retarget.ts human track → robot joint angles (trunk, limb targets, contact locks, IK, flip repair)
   moves.ts    slice, re-express in the move frame, close loops, measure (target, speed, limits)
tools/mocap/build-library.ts ──> data/<design>.json   (quality gates, best moves per label)
tools/mocap/audit.ts          independent check of a built library against the source actor
tests/mocap/library.test.ts   contract, inventory, mirror, floor, sampler
harness/motions.html          visual preview: robot plus the source skeleton as a ghost
```

## Building

```
npx tsx tools/mocap/build-library.ts              # every biped design in DESIGNS
npx tsx tools/mocap/build-library.ts savate        # one design (about 17 s)
npx tsx tools/mocap/build-library.ts savate --moves   # also prints each kept move's numbers
npx tsx tools/mocap/audit.ts [design] [--all] [--json out.json]
npx tsx tools/mocap/segments.ts [clip…] [--label hook]  # print the segmentation, for tuning
```

Rebuild every library after a change to a design's parts, joint ranges, proportions or motors. The retarget reads the actual `RobotDesign`, so no per-design code is involved. Each library is about 0.9 MB of JSON (about 0.6 MB gzipped); the test holds it under 1.5 MB.

## Runtime API (`import … from 'src/robots/motions'`)

### Loading

| call | returns |
|---|---|
| `loadLibrary(designId): Promise<MotionLibrary>` | Loads and decodes `data/<id>.json` once and caches it. Vite turns this into lazy imports. It rejects when no library exists for the design. |
| `libraryDesigns(): string[]` | Design ids that have a generated library. |
| `parseLibrary(json: LibraryJson): MotionLibrary` | The same decode without Vite, for Node tools, tests and a worker that fetched the JSON itself. |
| `listMoves(lib, filter?)` / `lib.listMoves(filter?)` | Moves filtered by `{ label?: MoveLabel \| MoveLabel[], side?: 'l' \| 'r', height?: 'low' \| 'mid' \| 'high' }`. |
| `lib.move(id)` | One move by id. Throws if the id is unknown. |
| `filterMoves(moves, filter)` | The same filter over any move array. |

A `MotionLibrary` holds:
- `design`
- `fps` (60)
- `joints`: the channel order of every `q` and `qd`. It is the MuJoCo joint names of the design, in the design's joint order.
- `jointSpeedLimit`: motor no-load speed at each joint, in rad/s.
- `mirror`
- `moves`

Within a label, moves are ordered best first: the fastest deliverable strike, or the cleanest footwork. `listMoves({ label })[0]` is the default choice.

### Moves (`Move`)

Moves are stored orthodox, with the left side leading. The move frame is x toward the opponent, y left and z up. The pelvis starts over the origin, so root x and y start at 0, and root z is the absolute pelvis height above the mat.

| field | meaning |
|---|---|
| `id` | `label.clip.startFrame[m][L]`. `m` means the source was mirrored to make it orthodox. `L` means a derived low kick (see Limits). |
| `label` | One of `MOVE_LABELS`: `jab cross hook uppercut overhand front_kick low_kick head_kick side_kick block guard_idle shuffle_forward shuffle_back shuffle_left shuffle_right walk_forward walk_back getup_face_down getup_back getup_side victory`, the flashy strikes `tornado_kick spinning_back_kick jump_kick jumping_knee superman_punch spinning_backfist` (`FLASHY_LABELS`), the angle footwork `feint_left feint_right pivot_left pivot_right switch_stance` (`ANGLE_LABELS`) and `kipup_source`. See Flashy and angle moves. |
| `side`, `striker` | The striking (or blocking) side and the part that should land (`fist_l`, `foot_r`, …; a jumping knee lands `shin_r`, whose origin is the knee joint). A jab is always `l`/`fist_l` and a cross is always `r`/`fist_r`. A feint's side is the side it shows. |
| `height` | `low` \| `mid` \| `high` for strikes, otherwise null. |
| `loop` | `guard_idle` and the walk cycles wrap. The seam is exact: the last frame equals the first. |
| `duration`, `frames`, `fps` | Seconds at 1× (`(frames − 1) / fps`). |
| `phases.strike`, `phases.recover` | Seconds. The windup runs over `[0, strike)`, the strike over `[strike, recover)` and the recovery over `[recover, duration]`. For get-ups, the strike phase is the rise off the mat. |
| `impact` | Seconds. When the striker connects. See the next table for how it is measured. |
| `reach` | Seconds. When the striker is furthest out, at the end of its travel. |
| `target` | Move-frame position (m) of the striker where it lands. This is what to aim at the opponent (see Aiming). |
| `peakSpeed` | Striker speed at `impact` at 1× (m/s). It scales linearly with playback speed. |
| `travel` | Pelvis displacement from start to end (m, move frame). This is how far a lunge, step or walk cycle carries you. |
| `maxSpeed` | Largest time scale at which every joint stays under 0.9 × its motor's no-load speed. |
| `switchesStance` | The move starts with one foot leading and ends with the other. After it the fighter is southpaw, so play its next orthodox move with `mirror: true`. All round and low kicks switch stance (the source kicks land forward), as do some front kicks and a few punches and steps, every `switch_stance`, and most tornado kicks, jump kicks, jumping knees and superman punches. |
| `flight` | `{ takeoff, land, height }` or `null`. The longest run of frames where nothing touches the mat (no foot, hand, knee, hips or chest contact): `takeoff` is its first frame and `land` the first frame something is down again (seconds at 1×), `height` the pelvis rise over its take-off height (m). Every tornado kick, jump kick, jumping knee and superman punch has one. Boxers' bounces give some footwork a flight of a few frames. |
| `spin` | Pelvis heading change from the first to the last frame about the vertical (rad, unwrapped; + is counter-clockwise seen from above, turning left). Read off the pelvis's lateral axis, so it stays defined when the body goes horizontal. Tornado kicks turn about −490°, spinning back kicks −362°, spinning backfists −370 to −490°, pivots ±70–80°. |
| `quality` | Mean fist and ankle IK error against the scaled actor, and the fraction of joint-frames on a range limit. |
| `source` | Clip, frame range, mirroring, leg scale and the alignment back to the source track (the harness uses it to draw the ghost). |
| `q`, `root`, `contacts` | Raw channels (see the next section). Normally read through `sample`. |

How `impact` and `target` are measured:

| label | `impact` | `target` taken at |
|---|---|---|
| jab, cross, front kick, side kick | the striker's peak speed | `reach` (full extension) |
| uppercut | the striker's peak speed | `reach` (the top of the rise) |
| hook, overhand, head kick | the first frame after peak speed where the striker comes within 10 cm of the move frame's y = 0 line. These arcs peak in speed while still out wide and follow through past the target. | `impact` |
| low kick | the striker's peak speed | `impact` (the lead thigh, not the centre line) |
| jump kick, superman punch | the striker's peak speed | `reach` |
| spinning back kick, spinning backfist | the frame the heel (fist) passes back through the line the fighter faced at the start, weighted by its speed there | `reach` (back kick) / `impact` (backfist, on the centre line) |
| tornado kick | the striker's peak speed | `impact` (on the centre line, like a head kick) |
| jumping knee | the top of the knee's drive (its highest point) | `impact` |

### Raw channels

| channel | layout |
|---|---|
| `q` | `Float32Array`, frames × joints, radians |
| `root` | frames × 7: x, y, z, then the pelvis quaternion w, x, y, z |
| `contacts` | one byte per frame of `CONTACT` flags (see Contacts) |

### Sampling

```ts
const s = newSample(lib.joints.length);          // allocate once per fighter
sample(move, t, { speed, mirror, loop }, s);      // no allocation per call
```

- **`t`**: wall seconds since the move started. The clip time is `t × speed`.
- **`speed`**: time scale; 1 is the recorded pace. Keep it at `speedFor(move, desired)` or below, which clamps it to `min(desired, move.maxSpeed)` and never below 0.05.
- **`mirror`**: plays the move southpaw. Joints are mirrored through `lib.mirror`, `q'[i] = sign[i] · q[perm[i]]` (pitch joints keep their sign, roll and yaw joints flip). The root y and the quaternion's x and z components are negated, and left and right contacts swap. A mirrored sample is exactly the reflected pose; the tests hold it to 4 mm.
- **`loop`**: defaults to `move.loop`. When a loop wraps, the stride accumulates: root x and y advance by `travel` every cycle.

A `MotionSample` holds:

| field | meaning |
|---|---|
| `q` | Joint targets (rad) in `lib.joints` order. Between the 60 Hz frames they follow a cubic Hermite curve with Catmull-Rom tangents: C1, passing exactly through the stored frames. |
| `qd` | The exact time derivative of `q` at the chosen speed (rad/s). Use it as servo velocity feed-forward. It is 0 once a one-shot move is `done`. For torque feed-forward, differentiate `qd` or run inverse dynamics on `q`, `qd` and the next sample. |
| `rootPos`, `rootQuat`, `rootVel` | The pelvis reference in the move frame, linearly interpolated with a slerp for the attitude. Use it as the balance layer's target: where the pelvis should be and how it should lean. |
| `contacts` | Which feet, hands, knees, hips or chest should be bearing weight now. |
| `phase`, `phaseU` | `'windup' \| 'strike' \| 'recover'` and the progress through that phase, 0 to 1. |
| `time` | Clip time in seconds at 1×. |
| `done` | True past the end of a one-shot move, which then holds its last frame. |

### Placing, blending, mirroring

- **`placeSample(s, x, y, yaw, out = s)`**: moves the root channels from the move frame to the arena, for a move started with the pelvis over (x, y) facing `yaw` (toward the opponent). Joints do not depend on the frame. To chain moves, place each one at the pelvis position and heading it started from.
- **`blendSamples(a, b, w, out?)`**: `q`, `qd` and the root position and velocity are lerped, and the attitude is slerped. Contacts and phase come from whichever sample has the larger weight. Both samples must be in the same frame, so place them first. Cross-fade about 0.1–0.2 s from the current move's recovery into the next move's windup, or into `guard_idle`.
- **`mirrorContacts(c)`**: swaps left and right bits.
- **`mirrorMap(model)`**: builds the joint mirror map for a model. The library already stores it as `lib.mirror`.

### Contacts

`CONTACT` holds the bit flags and `CONTACT_NAMES` their names:

| flag | value |
|---|---|
| `FOOT_L` | 1 |
| `FOOT_R` | 2 |
| `HAND_L` | 4 |
| `HAND_R` | 8 |
| `KNEE_L` | 16 |
| `KNEE_R` | 32 |
| `HIPS` | 64 |
| `CHEST` | 128 |

The flags come from the source actor, who touched the floor. The retarget then pins the robot to them: planted feet lock to one spot on the ball of the foot, and hands and knees set down press at one spot. Treat them as the support plan. Where the robot's joint ranges can't reach the actor's pose, a flagged foot can drift (see Limits).

### Aiming a strike

1. Pick the move: `listMoves({ label: 'hook', side })`.
2. Choose where to start it so `target` lands on the opponent's head (or on the lead thigh for a low kick). `target` is in the move frame, so the start is roughly the opponent's position minus `target` rotated by the facing yaw. The pelvis also moves by `travel`, and it is already included in `target`.
3. Pick the speed: `speedFor(move, desired)`.
4. Contact happens at wall time `impact / speed`, with the striker moving at `peakSpeed × speed`.

## Flashy and angle moves

The fighter-intelligence spec (`docs/design/fighter-intelligence.md`) wants fighters to attempt tornado kicks, kip-ups and other flashy moves, and not always stand squared up. These moves come from the 20 approved clips plus the kata and drill clips, placed by hand in `clips.ts` (`ClipInfo.flashy`: label, window, striker, impact search window) and measured automatically in `flashy.ts`. Physics decides whether the robot lands them: the library only says what the move is.

### Conventions

- **Spinning moves turn clockwise seen from above** (`spin < 0`), the way an orthodox fighter shows his back. Play `mirror: true` for the other direction (it also swaps sides).
- **Straight flashy strikes throw the right side** (jump kick, jumping knee, superman punch).
- **The move frame's +x is the strike line where it lands**: from the pelvis to the striker at impact. So the opponent is in front of the body when it lands, whatever the spin and the jump did on the way. A flashy move may start bladed, up to 60° off square (a set-up turn).
- **Jumps start and end on the mat**, wind up for at least 0.15 s before the take-off, and never carry the fighter more than 0.3 m away from the target.

### Labels and sources

| label | source (all retargeted per design) | what it is |
|---|---|---|
| `tornado_kick` | `135_07` head-high roundhouses, derived: a full clockwise turn added on the support foot in the chamber (`spinTrack`) and a hop off it into the kick (`leapTrack`, 0.35 s arc around the impact) | spin + jump + roundhouse, ~−490° of turn, 0.3 s airborne, lands chest to shoulder high (0.87 m on FIRECRACKER, 1.2–1.5 m on the others) |
| `spinning_back_kick` | `135_11` lead-leg side kicks with a full turn added on the support foot in the chamber | a 360° spinning side (back) kick, −362° |
| `jump_kick` | `135_04` front kicks with a 0.35 s hop around the impact | jumping front kick, 0.33 s airborne, pelvis +15–23 cm |
| `jumping_knee` | the same front kicks with the leg folded so the knee leads (`StrikeAdjust.fold`) and the hop; on FIRECRACKER also `75_16` (a real jumping kick, folded) | striker `shin_r`: the knee |
| `superman_punch` | `135_09` lunge punches lifted into a ballistic leap over the stepping foot's swing (at most 0.4 s) | leap off the back foot behind a straight right, 0.3–0.4 s airborne |
| `spinning_backfist` | `75_08` 360° jumps, where the arm whips out on the way round | a jumping spinning backfist, −370 to −490°; lands at chest height (see Limits) |
| `feint_left`, `feint_right` | `78_20` (feint left, move right) and `78_21` (feint right, move left), each also stored mirrored as the other label | a juke: show one side, burst ~1.2 m diagonally the other way |
| `pivot_left`, `pivot_right` | detected in the boxing and footwork clips: one foot's ball stays on its spot while the other foot swings round it and the hips turn 30–120°; each also stored mirrored | a 70–80° pivot on one foot, ends facing the new angle |
| `switch_stance` | detected in the boxing clips: the lead foot changes by ≥ 12 cm each way within 0.7 s, square to the opponent, little travel | a hop switch, orthodox → southpaw (`switchesStance` is true) |
| `kipup_source` | `90_09` front handspring, `88_08` back handspring, and the drop-and-spring-up moments of the `85_03`/`85_11` breakdance sequences | keyframes for the control build's kip-up optimisation: the strike phase is the rise (from the first frame on the hands, hips or chest, or folded low, until upright on the feet); `flight` marks the airborne part of a handspring |

Derived moves record their edit in `source.turn` (the added turn: frames, angle, support foot) and `source.leap` (the lifted frames). The audit and the preview ghost replay it, so they compare the robot with the edited actor it was retargeted from.

### Using them

- Read the take-off readiness off `flight.takeoff`: the support foot must be planted and the gyro, battery and joints healthy at that moment. The landing is `flight.land`; the balance layer owns the robot from there.
- `spin` says how far the body turns: a spinning move's gyro momentum budget is roughly the pelvis yaw rate × the body's yaw inertia over the turn.
- `maxSpeed` still caps the time scale. The light electric designs play flashy moves at about 0.9–1.2× the actor's pace; GOLIATH at about 0.3× (its motors are slow for its mass), so heavy fighters' flashy moves are honestly slow and risky.

## Inventory (built 2026-09-29, 65 CMU clips)

| label | FIRECRACKER | SAVATE | HAYMAKER | PYLON | BRUISER | STRIKER | GOLIATH |
|---|---|---|---|---|---|---|---|
| jab | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| cross | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| hook | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| uppercut | 6 | 6 | 6 | 6 | 6 | 6 | 6 |
| overhand | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| front_kick | 6 | 6 | 6 | 6 | 6 | 6 | 6 |
| low_kick | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| head_kick | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| side_kick | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| block | 6 | 6 | 6 | 6 | 6 | 6 | 6 |
| guard_idle | 2 | 2 | 2 | 1 | 1 | 1 | 1 |
| shuffle fwd/back/left/right | 5/5/4/4 | 5/5/4/4 | 5/5/4/4 | 5/5/4/4 | 5/5/4/4 | 5/5/4/4 | 5/5/4/4 |
| walk_forward / walk_back | 2/1 | 2/1 | 2/1 | 2/1 | 2/1 | 2/1 | 2/1 |
| getup face_down/back/side | 4/2/3 | 4/2/3 | 3/2/3 | 3/2/3 | 3/2/3 | 4/2/3 | 3/2/2 |
| victory | 2 | 1 | 3 | 1 | 3 | 2 | 3 |
| tornado_kick | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| spinning_back_kick | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| jump_kick | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| jumping_knee | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| superman_punch | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| spinning_backfist | 2 | 2 | 2 | 2 | 2 | 2 | 2 |
| feint_left / feint_right | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 1/1 | 1/1 |
| pivot_left / pivot_right | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| switch_stance | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| kipup_source | 6 | 6 | 6 | 6 | 5 | 5 | 6 |
| total | 127 | 126 | 127 | 124 | 125 | 123 | 123 |
| JSON size | 930 KB | 907 KB | 931 KB | 895 KB | 919 KB | 900 KB | 898 KB |

## Quality gates (build-library.ts)

A candidate is rejected when any of these holds:
- **Striker error:**
  - At full reach, a fist is off its target by more than 6 cm, or a foot by more than 25 cm.
  - Anywhere along the strike, a fist is off by more than 12 cm or a foot by more than 20 cm. This catches strikes eased across an IK branch flip.
- **Limbs off target:**
  - In a get-up, feet off by more than 12 cm or hands by more than 15 cm.
  - In any other move, feet off by more than 6 cm.
- **Joint limits:** more than 18% of joint-frames sit on a range limit.
- **Joint speed:** a joint moves faster than 35 rad/s at 1× (an IK flip).
- **Sinking:** any collision geom goes more than 6 cm below the mat.
- **Facing:** a fighting move, footwork or walk starts or ends with the head more than 40° off the opponent. Kicks may end up to 80° off.
- **Level:** footwork, walks or guard end more than 10 cm higher or lower than they started.
- **Guard foot slide:** a guard loop drags a planted foot more than 6 cm.

Flashy strikes, angle footwork and kip-up sources are allowed what they need and no more:
- **Flight** is allowed; a flashy strike must still start on the mat, end on the mat, wind up ≥ 0.15 s before the take-off, and not travel more than 0.3 m away from its target.
- **Striker:** a foot within 30 cm of its target at reach (55 cm along the path for spinning kicks, whose foot swings wide where the hip yaw saturates at the chamber; 30 cm for the others), a fist within 8 cm (15 cm along the path), a knee within 20 cm (25 cm). The strike must land at least 20 cm in front.
- **Facing:** start within 60° of the strike line; the head within 100° of it where the strike lands (a back kick spots over the shoulder). Feints and switches may end 70° / 45° off, pivots 140° (they turn on purpose).
- **Feet** within 12 cm of the actor's (8 cm for angle footwork, 12 cm feet / 15 cm hands for kip-up sources); **joint limits** on up to 25% of joint-frames; **joint speed** up to 45 rad/s at 1×; angle footwork may end 16 cm lower (the crouch it burst from).
- **Sinking** is never relaxed: 6 cm, like every move.

`tools/mocap/audit.ts` re-checks the built library independently. It poses the robot with its own forward kinematics and compares it with the actor mapped into the move frame: limb segment directions, pelvis and chest heading, planted-foot twist and slide, floor penetration, stance, head heading at the strike, and footwork travel direction.

## Limits (as of this build)

- **Kinematic ranges:** the iron-age designs keep hip roll +45°, hip yaw ±40° and ankle ±30°/−60…45°; the electric designs have wider ranges (`humanoid.ts` MODERN_RANGES), and the limits below apply mostly to the iron age.
  - In get-ups, the actor's frog-legged knee-outs and wide splits can't be reached, so a leg lies above the mat rather than where the actor's leg is (thigh and shin 60–80° off in side get-ups), and a flagged planted foot can drag 15–28 cm (worst 44 cm in FIRECRACKER `getup_back.111_07`).
  - High roundhouses read as chambered front/round hybrids, because the hip yaw sits on its limit at the chamber.
  - A wider hip roll and yaw range on the designs would fix both.
- **Round and low kicks:** they all come from one kata clip (`135_07`) and land forward, so they switch stance.
  - Low kicks are derived. They are the same roundhouse with the ankle path lowered to 0.6 × hip height, in proportion to its height, so they keep their shape.
- **Walks:** all come from `41_02`. The other walking clips curve (86_06 walks in a circle), and curved cycles are rejected. The loop seam leaves 5–8 cm of planted-foot drift per cycle.
- **Guard idles:** the CMU shadow boxers bounce and reposition their feet, so only 1–2 clean idle loops survive per design. Combine them with the shuffles.
- **Flashy moves:**
  - None of the approved spin and jump kick clips survives as a tornado kick: in `90_05`–`90_07` the actor flies past the target line and kicks back toward where he came from (or starts turned away), and in `87_01`/`88_06` (butterfly style) the head faces 130–170° away from the kick when it lands. The tornado kicks are therefore the kata roundhouses with a spin and a hop added. `88_04` (capoeira) has aerials and a pirouette that runs into a flip: nothing is taken from it. `75_16` (jumping front kick) flips IK branches at the snap and is rejected as a kick on every design; its folded knee survives on FIRECRACKER.
  - Only one spinning back kick per design survives (the others leave the mat before they wind up).
  - Spinning backfists land at chest height (0.8–0.95 m on the electric designs), not at the head: the `75_08` actor's arm is out at shoulder level on the way round.
  - Feints travel 1.1–1.8 m (they are football jukes, not shoulder feints), and their feet slide 4–6 cm in the audit.
  - Kip-up sources are standing handsprings and breakdance drops, not kip-ups from lying on the back: the control build has to optimise them into one. The handspring arms and legs are 50–85° off the actor's in the audit (the robot's shoulders and hips can't reach a full bridge).
- **Minor audit flags:** a few jabs and overhands start from a square stance (lead foot within 3 cm), and one uppercut per design has the chest about 36° off the actor's.
