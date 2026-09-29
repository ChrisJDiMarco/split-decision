# Motion library (CMU mocap → per-design robot moves)

Moves are retargeted from the CMU Graphics Lab Motion Capture Database (credits in `assets-src/mocap/CREDITS.md`) onto each biped design's own joint tree. The tracking controller reads them as servo targets, feed-forward velocities, a pelvis reference and contact plans. Everything in this folder is plain data and math with no three.js and no DOM, so it runs in the physics worker.

```
assets-src/mocap/cmu/*.bvh ──> human.ts (BVH → 60 Hz landmarks, x fwd / y left / z up, floor z = 0)
   segment.ts  labelled segments with phases (clips.ts says which detectors run on which clip)
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

Rebuild every library after a change to a design's parts, joint ranges, proportions or motors. The retarget reads the actual `RobotDesign`, so no per-design code is involved. Each library is about 0.7 MB of JSON (about 0.47 MB gzipped).

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
| `label` | One of `MOVE_LABELS`: `jab cross hook uppercut overhand front_kick low_kick head_kick side_kick block guard_idle shuffle_forward shuffle_back shuffle_left shuffle_right walk_forward walk_back getup_face_down getup_back getup_side victory`. |
| `side`, `striker` | The striking (or blocking) side and the part that should land (`fist_l`, `foot_r`, …). A jab is always `l`/`fist_l` and a cross is always `r`/`fist_r`. |
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
| `switchesStance` | The move starts with one foot leading and ends with the other. After it the fighter is southpaw, so play its next orthodox move with `mirror: true`. All round and low kicks switch stance (the source kicks land forward), as do some front kicks and a few punches and steps. |
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

## Inventory (built 2026-09-29, 45 CMU clips)

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
| getup face_down/back/side | 4/3/3 | 4/2/3 | 3/2/2 | 3/2/3 | 3/2/3 | 4/2/3 | 3/2/2 |
| victory | 2 | 1 | 3 | 1 | 3 | 2 | 3 |
| total | 95 | 93 | 93 | 91 | 93 | 93 | 92 |

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

`tools/mocap/audit.ts` re-checks the built library independently. It poses the robot with its own forward kinematics and compares it with the actor mapped into the move frame: limb segment directions, pelvis and chest heading, planted-foot twist and slide, floor penetration, stance, head heading at the strike, and footwork travel direction.

## Limits (as of this build)

- **Kinematic ranges:** all seven designs share hip roll +45°, hip yaw ±40° and ankle ±30°/−60…45°.
  - In get-ups, the actor's frog-legged knee-outs and wide splits can't be reached, so a leg lies above the mat rather than where the actor's leg is (thigh and shin 60–80° off in side get-ups), and a flagged planted foot can drag 15–28 cm (worst 44 cm in FIRECRACKER `getup_back.111_07`).
  - High roundhouses read as chambered front/round hybrids, because the hip yaw sits on its limit at the chamber.
  - A wider hip roll and yaw range on the designs would fix both.
- **Round and low kicks:** they all come from one kata clip (`135_07`) and land forward, so they switch stance.
  - Low kicks are derived. They are the same roundhouse with the ankle path lowered to 0.6 × hip height, in proportion to its height, so they keep their shape.
  - The 20 flashier clips in `assets-src/mocap/cmu/` (spin and jump kicks, handsprings, feints) are not in `clips.ts` yet.
- **Walks:** all come from `41_02`. The other walking clips curve (86_06 walks in a circle), and curved cycles are rejected. The loop seam leaves 5–8 cm of planted-foot drift per cycle.
- **Guard idles:** the CMU shadow boxers bounce and reposition their feet, so only 1–2 clean idle loops survive per design. Combine them with the shuffles.
- **Minor audit flags:** a few jabs and overhands start from a square stance (lead foot within 3 cm), and one uppercut per design has the chest about 36° off the actor's.
