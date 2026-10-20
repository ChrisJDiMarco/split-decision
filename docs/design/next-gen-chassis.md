# Next-gen chassis: a new generation of fighters

Status: **APPROVED in part by Chris (2026-09-29). Nothing is built yet.**

**Chris's decisions (2026-09-29):**
- **Phase 0:** approved, to run **overnight** after the balance engine's Phase 1 lands, so it tests on the new balance.
- **Hip:** **Option 1, the full T800-style hip, regardless** of whether it wins only side kicks ("T800-style hip regardless"). Phase 0 therefore stops being the Option 1 vs 2 gate. It becomes the baseline and tuning run for ranges, mass placement and drives, and a regression reference.
- **Era name:** **NEXT GEN**.
- **Roll-out:** **all three designs** (PINWHEEL, JACKKNIFE, CAPSTAN) after Phase 0, not PINWHEEL alone.
- **Defaults until Chris says otherwise:**
  - Names and looks as in section 2.
  - Ankles stay inside real robots, widened only as a labelled departure if they saturate.
  - NEXT GEN is hidden until it passes tuning.
  - CAPSTAN at ~90 kg is fine (HAYMAKER is the precedent).
  - Get-up bar: URKL's 3 s, with EngineAI's ~1.6 s as the reference.
  - Workshop upgrades of existing fighters come later.

Original status: PROPOSAL. The research behind it is in `docs/research/10-engineai-fighters.md`, cited below as "10 §n".

Chris asked for "even better robots with more advanced joints and parts", modelled on EngineAI's URKL fighters. The rest of this doc follows his direction:
- **Scope:** "we can have a variety of robots! but these new hips and things robots can be like the newer versions in the game you can use". The iron three and the modern four (FIRECRACKER, SAVATE, HAYMAKER, PYLON) stay exactly as they are.
- **Originality:** "we can design our own versions so we don't copyright on their design but be pretty similar". We copy engineering, never looks or names.

## 0. The decision in one paragraph

Add a **third era** of fighters next to the iron three and the modern four. Nothing existing changes. The new era gets four upgrades, and the research says they do different jobs:

| Upgrade | What it buys | Evidence |
|---|---|---|
| **Hip order** pitch (tilted 15°) → roll → yaw about the thigh bone | Real side kicks and high side kicks. At equal ranges the new order fits a side kick to 5° where ours misses by 41°, and a high side kick to 17° against 71° | 10 §5 |
| **Wide hip-yaw range** (−80…+180°) | Pivots, stance switches, spinning-kick bases. This comes from range, not order: our current order pivots at least as well given the same range | 10 §5 |
| **Motor mass moved toward the pelvis**, ankle drives on the shin | Roughly half the leg swing inertia, which may be what actually makes legs and get-ups snappy | codebase sweep, `scratchpad/sd/mass.ts` |
| **Graded drives** (big pitch and knee, mid roll, smaller yaw) | Real-robot torque ladders instead of one motor for every hip joint | 10 §3.4 |

The hip order is the expensive part: a second IK branch, layout-keyed joint maps, new kick maths. It is also the part that buys the least outside side kicks. So **Phase 0 is a small experiment that measures each upgrade separately** before any plumbing. If the order doesn't earn its cost in physics, there is a much cheaper version of NEXT GEN (Option 2 below). One design first, three in the end. The workshop comes later.

**Two options, decided after Phase 0:**
- **Option 1: full new layout.** All four upgrades. What Chris saw in the renders. Costs a second joint-layout family (section 4).
- **Option 2: current joint order, new everything else.** Wide ranges, relocated mass and graded drives on today's yaw → roll → pitch hip. It gets pivots and lighter legs for a fraction of the cost (no IK branch, no joint-map rework), but side kicks stay faked with torso lean, and the hips won't move like the T800's.

## 1. What to adopt, and what not to

| Idea | Adopt? | Why |
|---|---|---|
| Hip order pitch → roll → thigh-yaw | **Yes if Phase 0 shows the kick win in physics** (Option 1) | Its clear, measured win is side kicks (above). It does not help pivots: in a crouch, turning the pelvis 180° over a planted foot fits to 8–13° with this order and 0° with ours at the same ranges (10 §5). It is the 2025–26 industry norm (G1, H2, GR-3, T1, PM01, T800; 10 §10), so it copies no one's signature. |
| 15° tilt on the pitch axis | **Yes, with the order** | The knee swings out 14.5° at 90° of flexion, clearing the belly in tucks and chambers (10 §5). Costs nothing in our analytic IK (section 4.2). |
| Separate drum housings, mass toward the pelvis | **Yes, in either option**, possibly the bigger win | Today every hip motor sits at mid-thigh and both ankle motors sit in the foot. Moving them cuts leg swing inertia about the hip by an estimated 48–55% across the modern four (point-mass estimate; ignores linkage mass). |
| True T800 axis offsets (roll 10.75 cm below pitch, yaw 8 cm below roll) | **Not in v1** | Kills our closed-form leg IK and needs a numerical solver inside a 40 µs control budget. The drums can sit apart while their axes still meet at one point (section 4.1). |
| Wider hip and waist ranges | **Yes**, clamped for the shell | Section 3. This is where pivots come from. EngineAI's URDF limits ignore self-collision (10 §3.1), so ours stop short of them. |
| Graded hip drives (pitch > roll > yaw) | **Yes** | Needs per-joint motor slots. Today one `leg` slot drives all three hips and both ankles. |
| Extra leg DOF: toes, shin twist, 3-DOF ankle | **No, not in v1** | No fighting robot has them (10 §10). Toes belong with the balance engine's heel-to-toe CMP roll (`balance-engine.md` §3.2), a later workshop kit. |
| Continuous-rotation joints | **No** | The T800 is not continuous (288° of hip-yaw travel, under one turn, so a cable wrap is enough; 10 §5). Continuity needs angle unwrapping in the compiler, posture, get-up, blends and retargeting. Atlas publishes no joint specs to copy. |
| Parallel-linkage ankle | **Mass placement only in v1** | Keep serial ankle hinges and move their drive mass onto the shin. Later, add a coupled (diamond) torque limit for the pitch/roll pair in the motor model. A true closed chain adds constraint rows and non-per-joint IK for no gameplay gain. |
| Waist | Keep our yaw + pitch, widen yaw to ±160° | The T800 Basic has yaw only (−251…71°); the Pro has ±161° (10 §3.2). Our waist pitch helps get-ups, so we keep it, as a declared departure (section 3). |

## 2. The new generation: three designs of our own

Working era name `next` in code, **NEXT GEN** in the UI (open question 1). All three share:
- the chosen layout (Option 1 or 2);
- no hydraulics;
- a family trait that is ours and that the T800 lacks: an **exposed segmented spine column** at the back, from pelvis to neck, because our fighters have a waist pitch joint. The hips are **faired or caged, never flat grey disc caps with an index line, never vented drum sides**.

| | **PINWHEEL** | **JACKKNIFE** | **CAPSTAN** |
|---|---|---|---|
| Class it draws on | Adult-size (T800 class) | Kid-size (PM01 class) | Heavy adult-size (H2 / Atlas mass) |
| Target height / mass | 1.80 m / ~76 kg: taller and leaner than a T800 (173 cm, 75–85 kg) | 1.40 m / ~43 kg | 1.82 m / ~90 kg |
| Weight class | middle | bantam | heavy |
| Style | Kick artist: side kicks, turned-over roundhouses, spinning back kick, switch stance | Acrobat: fastest get-ups (kip-up target), flying knee, sweeps. Fragile | Pivot grinder: turns its whole body on a planted leg, low kicks, clinch turns. Slow to snap, hard to move |
| Hip pitch / knee | `qdd.ake90x3` ×2 (485 N·m, 22 rad/s, 4.4 kg) | `qdd.ake90` (170 N·m, 22 rad/s, 1.4 kg) / knee `qdd.ake90x2` (323, 22, 2.9) | `qdd.ake90x3` / `qdd.ake90x3` |
| Hip roll | `qdd.ake90x2` (323) | `qdd.ake90` (170) | `qdd.ake90x2` (323) |
| Hip yaw | `qdd.ake90` (170) | `qdd.ak10` (53 N·m, 33.5 rad/s, 0.96 kg) | `qdd.ake90x2` (323): its signature |
| Ankle pitch / roll | `qdd.rs04` ×2 (120 N·m, 20.9 rad/s, 1.42 kg), mass on the shin | `qdd.ak10` ×2, mass on the shin | `qdd.rs04` ×2, mass on the shin |
| Leg motor mass per leg | 15.9 kg (SAVATE today: 17.4) | 8.6 kg (FIRECRACKER: 6.2) | 17.4 kg (HAYMAKER: 16.3) |
| Real reference ladder | T800: 415 / 370 / 222 / 160 N·m | PM01: 164 (pitch, roll, knee) / 61 (yaw, ankle) | none fought at this mass; Atlas is 90 kg |

**Where the drive numbers come from, honestly.**
- **Single modules are real products** with cited catalog sources (`src/robots/catalog.ts`): CubeMars AKE90-8 and AK10-9, RobStride 04 and 03.
- **`ake90x2` and `ake90x3` are not products.** They are our own stacks of two or three AKE90-8 on one output, with a 0.95 load-share factor (`catalog.ts:135-146`). Their stall torque is built from the AKE90's **170 N·m peak**; its rated (continuous) torque is 55 N·m. The motor model's thermal limits keep that honest over time, but a reader should know the 485 N·m figure is a peak from a stack we designed.
- **Fit is unchecked.** Nobody has verified that a three-module stack fits a pelvis-side pitch housing inside a ~16 cm hip span; AKE90 dimensions are not on file. Phase 2 checks it. If it doesn't fit, PINWHEEL's pitch drops to `ake90x2` (323 N·m) or its hips get wider.
- Motor mass per leg is hand arithmetic from catalog masses. `compileRobot` measures the real totals in Phase 2.
- The ranking mirrors real ladders (pitch ≥ knee > roll > yaw > ankle).
- The X12/X15 planetaries are left out on purpose: at 13.1 and 11.3 rad/s they are too slow to snap. The GR-3 lesson is 366 N·m at 6.49 rad/s (10 §10).

**Arms, neck and waist.**
- Arms and neck copy the matching modern design's drives: PINWHEEL like SAVATE, JACKKNIFE like FIRECRACKER, CAPSTAN like HAYMAKER.
- Waist yaw uses `qdd.ake90` on PINWHEEL and CAPSTAN (the T800 waist is 222 N·m), and `qdd.rs03` (60 N·m) on JACKKNIFE.

### Borrowed (mechanics) vs ours (look)

PINWHEEL is the one closest to a T800 in size and role, so it gets the most divergent silhouette.

| | Borrowed from real engineering | Visibly ours |
|---|---|---|
| **PINWHEEL** | Adult-size proportions within real norms, the hip layout, 15° tilt, torque ladder, shin-mounted ankle drives | **Silhouette:** tall and narrow-waisted with broad, squared shoulders and a deliberately small head (a different head-to-shoulder ratio from the T800's helmet-heavy look). **Hips:** pitch and roll drums hidden under one smooth sculpted hip cowl, so no drum reads from outside. **Head:** a narrow keel-shaped skull with one *vertical* eye slot set off-centre. **Chest:** ribbed, no emblem. **Livery:** deep teal and copper, matte. **Race number** on the thigh. **Feet:** boxy soled feet with a toe bumper. |
| **JACKKNIFE** | PM01-class proportions and torque tiers, the same layout scaled down | **Hips:** an open tubular cage with the drums visible inside; drum ends are domed and knurled, never flat discs. **Head:** forward-swept beak head with twin round side lenses. **Torso:** short. **Arms:** long forearms for the push-off. **Livery:** cobalt and bone, gloss. |
| **CAPSTAN** | Heavy-class hip drives, the same layout | **Hips:** oversized *yaw* drums at the top of each thigh with radial motorcycle-style cooling fins, left exposed because turning is its identity (the T800 hides its yaw joint inside the thigh). **Head:** squat octagonal turret with a recessed twin-lens slot. **Livery:** oxblood and raw titanium grey, matte. |

**Banned everywhere, beyond the `08-modern-roster.md` list:**
- gloss white shells with grey disc caps carrying an index line;
- vented drum sides, and exposed stacked pitch-plus-roll hip drums on the outside of the hip;
- a single horizontal LED visor;
- a glowing round chest emblem;
- white sneaker feet;
- SZNS, triangle or orange-tick marks;
- Chinese text;
- the names T800, T-800, EngineAI, 众擎, URKL, White Eagle, Terminator.

Real products appear only in catalog `source` strings and docs. Art prompts carry no brand names and ask for no text.

**Name checks.** The three names are common words but have not yet had the search `08-modern-roster.md` did for the modern four. That runs before any art prompt or UI string.

**Rename the old catalog entry.** Rename the catalog display name `"T800-class 450 N·m joint"` to `"450 N·m-class joint"` before any motor names reach the UI.

## 3. Ranges (left leg; right mirrored)

| Joint | Ours today (modern) | T800 base / Pro | **NEXT GEN proposal** | Note |
|---|---|---|---|---|
| Hip pitch (− = flexion) | −145…35 | −190…130 / −165…125 | **−150…+60** | Inside T800. The get-up tuck reaches −142 (10 §6.1). Back kicks want ~45. Past that is collision territory. |
| Hip roll (+ = out) | −35…70 | −62…118 / −15…100 | **−30…+110** | Inside T800. Crosses the roll-75° gimbal lock in Option 1 (section 5.2). |
| Hip yaw (+ = toes out) | −45…70 | −81…206 / −81…223 | **−80…+180** | Inside T800. Enough for a 180° pivot; stops short of the unverified extremes. |
| Knee | 0…150 | 0…135 | **0…140** | Inside G1 (−5…165). |
| Ankle pitch | ±60 | ±39 | **±39** | T800 value. |
| Ankle roll | ±40 | −20…+10 | **−20…+17** | H2's value, the widest published of the robots we checked (T800 −20…+10, G1 ±15). |
| Waist yaw | ±90 | −251…71 / ±161 | **±160** | Inside Pro. |
| Waist pitch | −35…80 | none | **−35…80** | **Declared departure:** kept from our modern design. No T800 file has waist pitch. |

**Ankles: a real choice.** The previous draft proposed ±45 / ±25 and claimed it was inside a published envelope. It isn't: ±25 roll beats the T800 (−20…+10), G1 (±15) and H2 (−20…+17), and +45 pitch beats the T800 (+39), G1 (+30) and H2 (+35) on the positive side ([G1 URDF](https://github.com/unitreerobotics/unitree_ros/blob/master/robots/g1_description/g1_29dof.urdf), [H2 URDF](https://raw.githubusercontent.com/unitreerobotics/unitree_ros/master/robots/h2_description/H2.urdf)). The table now stays inside real robots. The cost is that the balance engine leans on ankle roll, and these ankles are much narrower than the modern four's ±60 / ±40 (which are themselves wider than any robot we checked). Phase 0 logs how often NEXT GEN ankles sit on their stops. If they saturate, open question 7 decides: stay honest and lean on the hips as real robots do, or widen them as a labelled departure.

The final clamps come from a self-collision sweep of each design's shells in Phase 2, not from the URDF.

## 4. How it maps into our code

This is a **second joint-layout family living next to the first**, not a migration. The existing joint names keep their current meaning on all seven existing designs. Sections 4.1–4.2 apply to Option 1 only; section 4.3 marks what Option 2 skips.

### 4.1 The kinematic trick: drums apart, axes meeting (Option 1)

A drum only has to sit somewhere along its own axis line. That lets v1 place the housings like the T800 while keeping one hip centre. INFERRED geometry; it matches the standing render, where the roll discs face forward (10 §3.3):
- **Pitch drum:** out to the side, in the pelvis.
- **Roll drum:** in front of the hip centre, on the roll axis.
- **Yaw drum:** down the thigh, on the thigh axis.

The body chain:

```
pelvis ─(pitch drum geom on pelvis side)
  └ hip_pitch_link_l   pos = hip centre   joint hip_pitch  axis (0, cos15°, −sin15°)   geom: roll-drum housing, in front
      └ hip_roll_link_l  pos = [0,0,0]   joint hip_roll   axis x                       geom: yaw-drum housing, ~8 cm down the thigh
          └ thigh_l        pos = [0,0,0]   joint hip_yaw    axis z (thigh bone)          geoms: thigh shell, knee drum at the bottom
              └ shin_l …   knee; ankle-drive housings high on the shin
                  └ foot_l  ankle_pitch, ankle_roll (serial hinges, no motor mass in the foot)
```

**What this gives:**
- **Honest mass placement.** Each drum geom carries its motor's catalog mass: the pitch motor stays on the pelvis, the roll motor moves only with pitch, and the yaw motor rides at the top of the thigh.
- **A tilted axis costs no compiler change.** `JointDef.axis` is already a free `Vec3`, and `compile-mjcf.ts` emits it verbatim.
- **Mirroring still works.** The link frames carry no rotation, so the mirror map stays correct.

**Option 2 version.** Keep today's three hinges on the thigh body, and add the drum housings as mass-carrying geoms on the pelvis and upper thigh instead. That needs a builder option to put a joint's motor mass on another body, and no link bodies.

### 4.2 IK stays closed-form (Option 1)

The pitch axis is Rx(−15°)·ŷ, so rotating about it is Rx(−15°)·Ry(p)·Rx(15°). The whole hip is then:

  R = Rx(−15°) · Ry(p) · Rx(r + 15°) · Rz(y)

To solve a desired thigh rotation R_t:
1. Pre-multiply: Rx(+15°)·R_t.
2. Decompose with the `eulerYXZ` routine `ik.ts` already uses for the arms.
3. Subtract 15° from roll.

The gimbal lock lands at r = +75°, which matches the fact-check. Mirror the sign for the right leg. INFERRED derivation; Phase 1 checks it with an FK/IK round-trip test.

### 4.3 Files and knock-ons (from the codebase sweep, re-checked)

**Small**

| Change | Where | Option 2? |
|---|---|---|
| Add a third `Era` value. Fix the three places an unknown era silently gets iron or modern behaviour: `humanoid.ts:180` (`era === 'modern' ? MODERN : IRON`), `loadout.ts:85-101` `isModern`, `showroom.ts:264-268` `modernIds`. Add a render-look registration check in `look.ts` | `src/core/types.ts`, `src/robots/humanoid.ts`, `src/robots/loadout.ts`, `src/harness/showroom.ts`, `src/render/robot-kit/look.ts` | yes |
| Optional per-joint motor slots `hipPitch`, `hipRoll`, `hipYaw`, `ankle`, each defaulting to `leg` so the current seven compile byte-identically | `types.ts`, the new builder | yes |
| New builder in its **own file**, e.g. `src/robots/humanoid-next.ts`. The existing `buildHumanoid` stays untouched | new file | yes |
| `NEXT_RANGES` table | new builder | yes |
| Leg IK branch: tilted pitch → roll → yaw (section 4.2) | `src/physics/control/ik.ts` | no |
| Compose the hip position through the links. `geometry.ts` `leg()` reads `hip: thigh.pos`, and `robot-model.ts` `dims.hipCenter` sets the retarget root from it. Both would silently read `[0,0,0]` | `src/physics/control/geometry.ts`, `src/robots/motions/robot-model.ts` | no |

**Medium**

| Change | Where | Option 2? |
|---|---|---|
| Link parts need a `PartTag`, hp, render recipes (the drums) and damage handling. The finger precedent folds damage **up** to the ancestor (here the pelvis, the wrong way); links should fold into the thigh. Telemetry and the HUD skip only `finger` | `compile-mjcf.ts`, `physics/damage/state.ts`, `physics/systems/telemetry.ts` | no |
| Joint maps keyed by layout. `posture.jointMap` throws on missing names but not on changed meaning. These all assume yaw-first: `loads.ts:64-65` (`hip_yaw = footYaw − pelvisYaw`, true only for yaw-first), `roll-keys.ts` and `getup.ts` defaults, `kicks.ts` (its header designs every kick around a yaw-roll-pitch hip) | `src/physics/control/*` | no |
| Fail-loud guards so a NEXT GEN design with no entry can't silently fall back to `DEFAULT_ROLL` / `DEFAULT_TUNING` / the default get-up plan | `roll-keys.ts`, `getup.ts`, `mocap/getup-plan.ts` | yes |
| New skills: side kick, turned-over roundhouse, pivot and switch stance, spinning back kick | `skills/kicks.ts` | pivots only |
| **Jev work for those skills:** each needs an ability name, an intent, when-to-use rules, openings detection for the new kicks, and brain tests. Not costed in the earlier draft | brain abilities, `src/physics/openings/*`, `tests/brain/*`, `tests/openings/*` | pivots only |
| Drum meshes inside the triangle budgets (modern <120k and >50k; every hands option inside budget) | `render/robot-kit/*`, `tests/robot-kit/*` | yes |
| Tests: roster lists, `tests/control` `HUMANOIDS` (still only the iron three), mocap and intelligence design lists, the IK round-trip and gimbal-lock tests | `tests/roster/*`, `tests/control/*`, `tests/robot-kit/*` | mostly |

**Guarding the existing seven.** Chris's "stay exactly as they are" needs two locks, both added in Phase 0 before any edit:
1. **MJCF byte fixture for the modern four** (sha256), like the one the iron three already have (`tests/roster/fixtures/iron-age-baseline.json`). Today the modern four are not byte-locked.
2. **A behaviour golden.** The byte fixture only covers MJCF. Phase 1 edits shared control code (`ik.ts`, `loads.ts`, `geometry.ts` `leg()`, `robot-model.ts` `hipCenter`, get-up and roll-key defaults), which could change how the existing seven move while their MJCF stays identical. Record a fixed-seed trace per existing design (a short sparring bout plus a get-up from each side) and hash it. First check the sim is deterministic run-to-run on one machine; if it isn't, use a statistical golden with a tolerance.

**Physics-step cost** (codebase sweep, two SAVATEs on the gantry, no contacts; INFERRED):
- Stock: 43.0 µs per step.
- Split hip links (+8 bodies, 0 DoF): 44.7 µs, +4%.
- Toe hinges added too (not proposed): up to 48 µs, +12%.
- With the robot standing, contacts dominate and timing was noisy (57–93 µs).
- New drum geoms add contact candidates against the floor and the opponent under the existing per-robot contact bits (`compile-mjcf.ts:171`). Phase 0 measures this.
- All of it is small against the 1 ms step. The tighter limit is control: 40 µs per robot per step (`tests/control/perf.test.ts`).

**Offline compute per new design**
- Motion-library build: ~20–32 s and ~0.9 MB of JSON.
- `getup-search`.
- Roll-key and tuning cross-entropy searches.

**Large, deferred:** toes, 3-DOF ankles, coupled parallel-linkage limits, continuous rotation.

About 24 files in `src/` and `tests/` reference `hip_yaw`, `hip_roll` or `hip_pitch`.

### 4.4 Effort (rough, INFERRED)

In focused build sessions, not calendar time:

| Phase | Option 1 | Option 2 |
|---|---|---|
| 0: experiment, byte fixture, behaviour golden | 1–2 sessions + a few CPU hours | same |
| 1: plumbing | 3–5 | 1–2 |
| 2: PINWHEEL, including its skills and Jev abilities | 3–5 + offline searches | 2–3 |
| 3: JACKKNIFE and CAPSTAN | 2–4 | 2–3 |
| 4: workshop leg parts | 2–3 | 2–3 |

These are guesses from the file list, not measurements. The biggest unknown is how much tuning the new kick skills need.

### 4.5 Motion library and retargeting

- **Retargeting mostly just works.** The retargeter already solves chains starting from the trunk, including intermediate bodies (`retarget.ts:255-265`). Only `dims.hipCenter` needs composing.
- **Order alone buys no mocap quality.** The codebase sweep rebuilt SAVATE's full CMU library with the hip reordered. Both variants kept 126 moves with 56 rejected, and joint-limit hits stayed at ≤1.6% versus ≤1.5%.
- **The payoff is in moves the CMU clips don't contain:** side kicks, turned-over kicks, pivots and fast get-ups. For those we copy EngineAI's published pattern: a short keyframed or searched reference plus a tracker (10 §6.1). Jev picks the skill; it never outputs torques.
- **Reference config.** EngineAI's GMR repo (MIT) has SMPL-X and LAFAN1-to-T800 IK configs we can read for task weights. We import no files or meshes from it; the meshes in it are EngineAI's.

### 4.6 Balance-engine coordination

The balance engine is mid-build (Phase 1, "walk in like a fighter"), and it leans on the same yaw-first assumptions: `loads.ts` pivot maths, joint maps, stepping and footwork.

- **Order:** NEXT GEN Phase 1 lands **after** balance Phase 1 and **before** balance Phase 2 (impedance for knees and hips).
- **Joint maps:** the layout-keyed maps get written once, and balance Phase 2 is built on them. Option 2 needs none of this.
- **Ankles:** the narrower NEXT GEN ankles (section 3) are a balance-engine question too. Phase 0 reports ankle saturation to both.
- **Toes:** they stay in the balance engine's column. They're only worth adding when its heel-to-toe centre-of-pressure roll exists.

## 5. Honest physics

### 5.1 What a 40–100 kg body needs

Arithmetic from the fact-checked T800 masses (10 §5, §6), INFERRED. The torque-speed rows use our own motor model: available torque = stall × (1 − ω/ω₀) × thermal derate × (0.6 + 0.4 × battery).

| Demand | 43 kg (JACKKNIFE) | 76 kg (PINWHEEL) | 90 kg (CAPSTAN) |
|---|---|---|---|
| Rise from a deep squat, per knee, static (lever 0.25–0.35 m) | 53–74 N·m | 93–130 | 110–155 |
| Same, explosive (+0.8 g) | 95–133 | 168–235 | 199–278 |
| Knee torque available at 10 rad/s (the peak in EngineAI's get-up), full battery, cool | 323 × (1 − 10/22) = **176** | 485 × 0.545 = **265** | **265** |
| Same at an empty battery (×0.6) | 106 | 159 | 159 |
| T800 for comparison (415 N·m, 25.96 rad/s, assuming a linear curve, which EngineAI doesn't publish) | | 255 | |

**What the table says:**
- **Fresh:** all three can make an explosive rise at the reference speed.
- **On a flat battery:** the heavier two can't. They get up slower late in a fight. That's real and stays in.
- **Holding a leg up:** hip pitch needs ~86 N·m and roll ~66 N·m for a T800-mass leg, far under every proposed drive.
- **Hip yaw is the weak joint** on PINWHEEL (170 N·m), as on the T800 (222). CAPSTAN deliberately isn't weak there.
- These stall figures are stack peaks built from the AKE90's 170 N·m peak (section 2); the thermal model decides how long they last.

### 5.2 Limits we keep, not tune away

**Heat is not the get-up limit; stalls are.**
- The catalog `ake90x3` has 3,180 W of copper loss at stall and a heat capacity of 1,428 J/K. That is about 2.2 K/s at full stall before any cooling.
- A 1.6 s rise at ~50% of stall adds under 1 K.
- Long clinch pushes and repeated stalls do cook drives, which the motor model already derates.

**Gimbal lock (Option 1).** At hip roll +75°, the tilted pitch axis and the thigh-yaw axis line up at any pitch. The side kicks, the very poses the order is for, sit near it. The IK is damped there and the kick skill leans the torso to reduce the abduction it needs. We don't hide the limit. Our current hip locks at roll 90°.

**Armature may be too low.** Our formula (0.02 + 0.01 × motor mass) gives `ake90x3` 0.064 kg·m². EngineAI's comparable class uses 0.243 (10 §3.4). We don't have AKE90 rotor inertia on file.
- The experiment brackets both values.
- If snap speed depends on it, we look up CubeMars' published rotor inertia before tuning anything. If none is published, we say so.

**Drives stay inside real modules.** Single drives are published products; stacks are built only from published modules with a stated load-share factor (section 2). No assist forces. The gyro core stays as in the modern roster and is logged separately in every measurement.

**Falls hurt as much as the mass says.** Lighter bodies fall softer, same as the modern roster.

## 6. First: the smallest experiment that can kill this

**Questions, in order of importance:**
1. Does the new hip order actually make side kicks work in physics, which is the one thing it wins on paper?
2. How much do wide ranges, relocated mass and graded drives each add, separately?
3. Do any of them make get-ups faster? (The research predicts the order won't: EngineAI's get-up barely uses hip yaw, 10 §6.1.)

**Step 0: kinematics (seconds, mostly done).** Equal-range static pose fits are in 10 §5: the order wins side kicks (5° vs 41°) and high side kicks (17° vs 71°), and loses crouched 180° pivots (8–13° vs 0°). Still to run: the hip Jacobian's smallest singular value along the side-kick and pivot paths for both orders, so we know how close each move runs to a gimbal lock.

**Variants.** Six **in-memory** SAVATE variants, nothing registered, SAVATE itself untouched. Each adds exactly one change to the one before, so every difference is attributable:

| Variant | Adds | Isolates |
|---|---|---|
| **A** | stock SAVATE | baseline |
| **R** | A + NEXT GEN ranges (section 3) | ranges |
| **M** | R + relocated drive mass (pelvis, links, thigh top, knee; ankle mass on the shin), stock order | mass placement |
| **O** | M + tilted pitch → roll → thigh-yaw order | hip order, at equal ranges and mass |
| **P** | O + PINWHEEL drives | drives |
| **P′** | P + armature 0.243 kg·m² on hip pitch and knee | armature |

**Step 1, primary: kick and pivot tests.** One scratch tool, no project edits.
- **Gantry reach:** pelvis fixed, PD-drive the leg to a side-kick pose and a high side-kick pose. Log the final pose error, time to 90% of the move, and peak |τ|/stall.
- **Free hold:** a cross-entropy-searched open-loop key sequence (same budget per variant) reaches and holds each kick pose on one leg for 1 s, 5 seeds. Log falls, torso lean and drive saturation.
- **Crouched pivot:** turn the pelvis 180° over a planted foot from a fighting crouch.

**Step 2, secondary: get-ups.** On the `tests/control/getup-search.ts` pattern:
- Drop the robot face-down and on its back, 5 seeds each.
- Controller off during the attempt; motor model on (torque-speed, heat, battery).
- A 4–5-key open-loop pose sequence, found by cross-entropy search with the same budget for every variant.
- Score: time to the existing `ClipGetUp` stand gate. Log success rate, peak |τ|/stall, peak speed/no-load, peak temperature, gyro use and ankle-stop time.

**Pass lines.** Set at or below real hardware, never above it:
- **Kicks (decides Option 1 vs 2):** O reaches the side-kick pose within 10° on the gantry and holds it free on at least 4 of 5 seeds, while M misses by more than 30° or falls.
- **Get-ups:** P gets up in **≤ 3 s** (URKL full marks) on at least 4 of 5 seeds from both sides. EngineAI's ~1.6 s is the real-hardware reference. Any result under ~1.6 s gets an honesty audit (torque, speed, gyro) before anyone believes it. SAVATE's current mocap get-ups take 2.3–2.4 s.

**Decisions, reported to Chris with the full table:**
- **O clearly beats M on kicks** → Option 1 is worth its cost.
- **O ≈ M on kicks** → the order doesn't pay in our physics. Go Option 2.
- **M clearly beats R** → mass placement is a real win; it goes in either option.
- **O ≈ M on get-ups** → expected; not a reason to kill.
- **Nothing beats A** on kicks or get-ups → the generation rests on looks and pivots (range) alone. Chris decides whether that's still worth a new era.
- **Any passing run needs torque above stall, or temperature into the derate band** → it isn't honest. Reject it.
- **P passes but P′ fails, or the reverse** → armature decides the result. Find real rotor inertia before building anything else.
- **Ankles sit on their stops a lot** → open question 7.

**Cost.** One new scratch tool plus CPU time, the modern-four byte fixture and the behaviour golden. No builder, controller or roster changes.

## 7. Phases (each gated; Chris signs off at each gate)

**Phase 0: prove it.**
- Run the experiment in section 6.
- Add the modern-four MJCF sha256 fixture and the behaviour golden for all seven existing designs.
- Gate: Chris sees the A/R/M/O/P/P′ table and picks one: Option 1, Option 2, or kill.

**Phase 1: plumbing, no new fighter visible.**
- Both options: the era value and the three era-switch fixes; fail-loud guards; optional per-joint motor slots; the `humanoid-next.ts` builder with drum geoms; `NEXT_RANGES`.
- Option 1 only: link bodies; the tilted-YXZ leg IK; hip-centre composition in `geometry.ts` and `robot-model.ts`; layout-keyed joint maps and the `loads.ts` pivot maths; link damage folding into the thigh.

Gate:
- The existing seven compile byte-identically (iron and modern fixtures) **and** match their behaviour golden.
- IK round-trip error < 1e-6 away from gimbal lock (Option 1).
- Control stays ≤ 40 µs per robot per step.
- All existing tests pass.

**Phase 2: PINWHEEL.**
- Design, shell and look; check the triple pitch stack fits the hip.
- A self-collision sweep to set the final ranges.
- Motion library, `getup-search`, roll keys and tuning.
- The new kick and pivot skills and their Jev abilities.
- Showroom and roster tests.

Gate:
- In-fight get-ups are within 20% of the Phase 0 time.
- Falls per 10 kicks are no worse than SAVATE's.
- Side kicks land with no torso-lean fake (Option 1).
- 60 s sparring against each modern design (3 seeds) shows no self-falls while stepping.

**Phase 3: JACKKNIFE and CAPSTAN.**
- Same pipeline.
- JACKKNIFE carries the kip-up attempt: candlestick, whip, squat (10 §6.2, unverified footage). It ships only if it passes the honesty rules in section 5.

**Phase 4, later: the workshop.**
- Under today's contract a slot never changes a servo joint (`loadouts-and-workshop.md`), so NEXT GEN robots are picked as **chassis**.
- Within the new layout, leg slots can then swap parts: twin or triple knee drives, a parallel-ankle kit with a coupled torque limit, and eventually a toe kit tied to the balance engine.
- An "upgrade my modern fighter to next-gen hips" path breaks byte-identity and needs its own library and tuning, so it's open question 4, not a default.

## 8. Open questions for Chris

1. **Era name.** Code `next` and UI "NEXT GEN"? Or something with more flavour: "GEN 3", "NEW BREED"?
2. **Names and looks.** Do PINWHEEL, JACKKNIFE and CAPSTAN and the looks in section 2 feel right? Swap any before concept art. The name searches run after you pick.
3. **Three designs, or start with one.** Build PINWHEEL alone after Phase 0 and decide on the other two once you've fought it?
4. **Workshop.** NEXT GEN as separate chassis only (today's contract)? Or a "chassis generation" upgrade that turns, say, SAVATE into a next-gen body? That second option recompiles the fighter and needs its own motion library and tuning.
5. **Selectable before tuned?** Should a NEXT GEN fighter be pickable before its motion library, get-up plan and tuning searches have run, perhaps as a "prototype" tag? Or stay hidden until they pass?
6. **Heavier than real.** CAPSTAN at ~90 kg is above anything that has actually fought (the T800 tops out at 85 kg). Is that OK, given that HAYMAKER at 103 kg already set the precedent?
7. **Ankles.** Stay inside real robots (±39° pitch, −20…+17° roll, much narrower than the modern four), or keep them wider as a labelled departure if Phase 0 shows they saturate?
8. **Option 2 acceptable?** If Phase 0 shows the new hip order doesn't pay off in physics, are you happy with NEXT GEN on today's joint order (wide ranges, lighter legs, graded drives, new looks), or is the T800-style hip the whole point for you?
9. **Get-up bar.** The pass line is now URKL's 3 s, with EngineAI's ~1.6 s as the real reference we don't try to beat. OK?

## 9. Phase 0 results (2026-10-20)

Ran on 2026-10-20 (Chris: no need to wait for overnight), during the balance engine's P3 build, so it does **not** test on the new balance: every variant gets the same simple scripted controller instead (below). Hip decision unchanged (Option 1, decided). This section is the baseline, the tuning advice and the regression lock.

### 9.1 What was built

- **Regression lock** (`tests/nextgen/`), written from a clean export of HEAD `92a0259`:
  - `fixtures/modern-mjcf.json`: sha256 of the compiled MJCF for the modern four, both corners, at the iron-age fixture's placement, plus a hash of the runtime fields outside the MJCF (stance, root height, gyro, abilities). The iron three keep `tests/roster/fixtures/iron-age-baseline.json`.
  - `fixtures/behaviour-golden.json`: all seven, a fixed-seed 10.1 s trace on the real systems (gantry drop, stand, a side shove, a jab at a standing BRUISER, recovery), robot 0's qpos hashed every 50 ms. Deterministic run to run and across `tsx` / `vitest`.
  - Check: `npx vitest run tests/nextgen/lock.test.ts` (~10 s). Regenerate, only for a deliberate change to the existing seven: `npx tsx tests/nextgen/regenerate.ts --check | --mjcf | --behaviour` (the header shows how to lock HEAD while other builds have edits in `src/`).
  - **State today:** the working tree fails 14 of 15 checks, by design. The balance build's uncommitted strike-pass actuator swaps (elbows `rs06x2`, shoulder pitch `ake90`, waist yaw `ake90x2`, HAYMAKER hips `ake90x3`) and its control edits change the modern four's MJCF and all behaviour traces but GOLIATH's. These are Chris-approved changes, not NEXT GEN damage. Regenerate the fixtures when that build commits, before NEXT GEN Phase 1 starts.
- **Variant builder** (`tools/nextgen/variants.ts`): in memory only, no file in `src/` changed. It starts from SAVATE frozen at `92a0259` (`savate-base.ts`; the strike-pass swaps touch only the arms and waist yaw, not the legs). Variants: **A** stock, **R** + §3 ranges, **M** + drive mass moved (hip drums at the pelvis and hip centre, knee drive at the knee, ankle drives 0.45-0.63 of the shin above the ankle, by T800 placement), **O** + T800 hip (pitch about (0, cos 15°, ∓sin 15°) → roll → thigh yaw on two link bodies, drums apart, axes meeting at one hip centre, §4.1), **P** + PINWHEEL drives (§2), **P′** + Q300HL armature 0.2427 kg·m² on hip pitch and knee. **P+ak** is a probe added after the first holds: P with AKE90-8 ankles (170 N·m, 1.40 kg) in place of RS04 (120 N·m, 1.42 kg).
  - Relocated mass: massless clones of the catalog motors (same torque, speed and heat model) plus a small dense sphere carrying each motor's catalog mass at its drum. M and O carry equal mass at equal sites.
  - `tools/nextgen/check.ts` proves several things. Variant A compiles to the locked SAVATE MJCF. The hip FK in the tools matches MuJoCo to 1e-5° for both layouts. The tilted right leg mirrors the left exactly.
  - **§4.2 closed-form IK confirmed:** pre-multiply by Rx(±15°), decompose YXZ, subtract ±15° from roll. It round-trips at 3e-8 rad on random poses, both sides (`hipik.ts ikHip`). That is the Phase 1 gate check, done early.
- **Measurements** (`tools/nextgen/`):
  - `static.ts`: mass, swing inertia, IK fits, reach, pivot fits, gimbal margin.
  - `run.ts gantry | knee | hold | pivot | getup`.
  - `report.ts`: these tables.
  - `ranges-sweep.ts`: range sensitivity.
  - `probe-ankle.ts`, `probe-yaw.ts`.
  - `getup-replay.ts`: replays the recorded get-up winners on the same seeds and logs ankle-stop time (added in verification).
  - Raw results are in `tools/nextgen/out/`.
- **The controller every variant shares (honest limits):**
  - No gyro and no production controller.
  - Motor model on: torque-speed line, heat, battery sag, thermal derate.
  - Holds and pivots use a kinematic whole-body planner plus one COM law. The law corrects ankle pitch/roll first, then hip pitch/roll, through the COM Jacobian; `balance.ts`.
  - Get-ups play SAVATE's best mocap get-up clip through each variant's own hip and ranges, with 8 playback numbers cross-entropy searched on the same budget.
  - Differences of ±1 seed in 5 are within this controller's noise. The balance engine will move every absolute number.

### 9.2 The tables

**Body.** Mass and leg swing inertia about each joint axis (leg straight; MuJoCo body inertias plus parallel axis), with each drive's armature.

| Variant | Total kg | Leg kg (drives) | Foot kg | I hip pitch | I hip roll | I knee | Armature pitch / knee |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 82.9 | 21.5 (17.4) | 6.30 | 6.74 | 6.70 | 1.52 | 0.049 / 0.049 |
| R | 82.9 | 21.5 (17.4) | 6.30 | 6.74 | 6.70 | 1.52 | 0.049 / 0.049 |
| M | 82.9 | 18.6 (17.4) | 0.50 | 3.41 | 3.40 | 0.36 | 0.049 / 0.049 |
| O | 82.9 | 18.6 (17.4) | 0.50 | 3.18 | 3.40 | 0.36 | 0.049 / 0.049 |
| P | 80.0 | 15.6 (15.9) | 0.50 | 2.44 | 2.61 | 0.26 | 0.064 / 0.064 |
| P′ | 80.0 | 15.6 (15.9) | 0.50 | 2.44 | 2.61 | 0.26 | 0.243 / 0.243 |
| P+ak | 79.9 | 15.6 (15.9) | 0.50 | 2.43 | 2.59 | 0.26 | 0.064 / 0.064 |

**Kick poses by IK** (thigh-direction error + knee-axis error at the variant's own ranges, pelvis upright), the hip's smallest Jacobian singular value along a straight joint path from the stance (1 = clean, 0 = gimbal lock), and the highest thigh elevation that still fits within 10° (ankle height with a straight leg).

| Variant | Front | Side | High side | Roundhouse | σmin side path | Front reach | Side reach | Roundhouse reach |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 0.0° | 93.8° | 123.0° | 20.0° | 0.25 | 65° · 1.62 m | none | none |
| R | 0.0° | 41.3° | 70.7° | 0.0° | 0.98 | 70° · 1.65 m | none | 22.5° · 1.20 m |
| M | 0.0° | 41.3° | 70.7° | 0.0° | 0.98 | 70° · 1.65 m | none | 22.5° · 1.20 m |
| O | 0.0° | 4.9° | 16.8° | 19.3° | 0.02 | 70° · 1.65 m | 20° · 1.17 m | none |
| P | 0.0° | 4.9° | 16.8° | 19.3° | 0.02 | 70° · 1.65 m | 20° · 1.17 m | none |
| P′ | 0.0° | 4.9° | 16.8° | 19.3° | 0.02 | 70° · 1.65 m | 20° · 1.17 m | none |
| P+ak | 0.0° | 4.9° | 16.8° | 19.3° | 0.02 | 70° · 1.65 m | 20° · 1.17 m | none |

**Gantry reach** (pelvis on the gantry, the left leg stepped from stance to the IK fit; servo and motor model as in the game). t90 = time to cover 90% of the thigh's swing; error = final pose vs the target (includes the IK miss).

| Variant | Front t90 / err | Side t90 / err | High side t90 / err | Roundhouse t90 / err | Peak ω/ω₀ |
| --- | --- | --- | --- | --- | --- |
| A | 277 ms / 1.2° | 235 ms / 94.1° | 238 ms / 123.1° | 165 ms / 20.6° | 0.72 |
| R | 277 ms / 1.2° | 261 ms / 42.3° | 265 ms / 71.7° | 279 ms / 0.6° | 0.96 |
| M | 201 ms / 0.8° | 205 ms / 41.9° | 207 ms / 71.3° | 237 ms / 0.6° | 0.98 |
| O | 200 ms / 0.8° | 213 ms / 5.0° | 239 ms / 17.4° | 227 ms / 19.3° | 0.94 |
| P | 160 ms / 0.5° | 193 ms / 5.0° | 216 ms / 17.2° | 220 ms / 19.3° | 0.90 |
| P′ | 163 ms / 0.5° | 193 ms / 5.0° | 216 ms / 17.3° | 220 ms / 19.3° | 0.90 |
| P+ak | 160 ms / 0.5° | 193 ms / 5.0° | 215 ms / 17.2° | 219 ms / 19.3° | 0.90 |

**Knee snap** (gantry, thigh level forward, knee stepped from 90° to straight): where reflected armature shows, because the shin alone is light.

| Variant | t90 | Peak knee speed | No-load |
| --- | --- | --- | --- |
| A | 165 ms | 14.5 rad/s | 22.0 rad/s |
| R | 165 ms | 14.5 rad/s | 22.0 rad/s |
| M | 129 ms | 17.6 rad/s | 22.0 rad/s |
| O | 129 ms | 17.6 rad/s | 22.0 rad/s |
| P | 121 ms | 19.8 rad/s | 22.0 rad/s |
| P′ | 126 ms | 19.1 rad/s | 22.0 rad/s |
| P+ak | 121 ms | 19.8 rad/s | 22.0 rad/s |

**One-leg hold, 1 s, 5 seeds** (free on the canvas; same planner and COM balance law for every variant; the planner may lean the torso, at a price). Held = no fall, no touch-down, no support-foot roll, no thermal derate. Lean and world error are medians over the seeds that held (the planned value when none held). Support τ = peak |τ|/stall on the support leg.

| Variant | Front: held · lean · err | Side: held · lean · err | High side: held · lean · err · ankle z | Peak support τ/stall |
| --- | --- | --- | --- | --- |
| A | 5/5 · 5° · 3.3° | 0/5 · 43° (plan) · 2.1° | 0/5 · 62° (plan) · 3.8° | 1.00 |
| R | 5/5 · 11° · 3.6° | 2/5 · 29° · 5.5° | 2/5 · 52° · 18.0° · 1.21 m | 1.00 |
| M | 5/5 · 16° · 2.7° | 5/5 · 25° · 7.4° | 4/5 · 51° · 16.8° · 1.16 m | 1.00 |
| O | 5/5 · 10° · 1.9° | 5/5 · 11° · 2.6° | 5/5 · 18° · 2.4° · 1.27 m | 0.69 |
| P | 3/5 · 12° · 2.5° | 5/5 · 9° · 2.6° | 5/5 · 18° · 2.3° · 1.25 m | 1.00 |
| P′ | 3/5 · 12° · 2.6° | 5/5 · 9° · 2.6° | 5/5 · 18° · 2.3° · 1.25 m | 1.00 |
| P+ak | 0/5 · 7° (plan) · 0.0° | 5/5 · 8° · 2.5° | 0/5 · 16° (plan) · 0.0° | 1.00 |

**Crouched 180° pivot** over the left foot, welded where it sits at qpos0, 1.5 s, whole-body plan. Hip IK = the hip alone with the pelvis level; final = measured pelvis orientation error after the turn.

**Read this table as kinematics, not as a physical pivot.** The weld holds the foot 8 mm *above* the canvas, so it carries the robot's whole weight and every tipping moment. The verifier added a centre-of-pressure probe (`tests-pivot.ts` `CopProbe`: the total ground wrench the robot needs, from MuJoCo's `cfrc_ext` / `cfrc_int`, validated on a free stand where the CoP stays inside the feet). "CoP off sole" is how long (of the 2.0 s logged) and how far the CoP the turn needs lies outside the sole box. There, a real, unwelded foot would roll. "pull" means the weld had to pull the foot down. **Every variant needs an off-sole CoP for 0.3-0.5 s**, so no variant's pivot is physically achievable as scripted. The plan-level numbers (hip IK error, final error, hip travel) stand. The torque and saturation columns are weld-assisted and say nothing about drive ratings.

| Variant | 30° crouch: hip IK · final · turn | 50° crouch: hip IK · final · turn | Hip travel (P / R / Y) at 50° | Peak τ/stall (worst), weld-assisted | CoP off sole 30° / 50° |
| --- | --- | --- | --- | --- | --- |
| A | 99.1° · 79.5° · 133° | 110.0° · 87.5° · 104° | 59° / 28° / 70° | 1.00 (ankle_roll_l) | 1.26 s · pull / 1.32 s · pull |
| R | 0.0° · 1.4° · 180° | 0.0° · 1.5° · 180° | 45° / 27° / 180° | 0.81 (hip_roll_l) | 0.42 s · 48 cm / 0.40 s · 26 cm |
| M | 0.0° · 1.4° · 180° | 0.0° · 1.4° · 180° | 41° / 25° / 180° | 0.74 (knee_l) | 0.37 s · 12 cm / 0.38 s · 13 cm |
| O | 7.4° · 3.5° · 178° | 11.4° · 3.5° · 178° | 86° / 30° / 182° | 0.87 (knee_l) | 0.41 s · 14 cm / 0.54 s · 58 cm |
| P | 7.4° · 3.6° · 177° | 11.4° · 3.9° · 178° | 89° / 31° / 181° | 1.00 (ankle_roll_l) | 0.30 s · 7 cm / 0.47 s · 60 cm |
| P′ | 7.4° · 3.6° · 177° | 11.4° · 3.9° · 178° | 89° / 31° / 181° | 1.00 (ankle_roll_l) | 0.30 s · 7 cm / 0.47 s · 59 cm |
| P+ak | 7.4° · 3.8° · 177° | 11.4° · 3.9° · 177° | 88° / 30° / 181° | 0.78 (ankle_roll_l) | 0.33 s · 5 cm / 0.52 s · 32 cm |

**Get-ups, 5 seeds** (SAVATE's best mocap get-up clip through each variant's hip and ranges, eight playback numbers searched with the same budget, then the winner dropped 5 times). Time is from the first movement to the stand gate. Ankle on a stop = median seconds the most-pinned ankle joint spends within 1° of a range stop. The verifier logged it with `getup-replay.ts`, which replays the recorded winners and reproduces every time in this table exactly.

| Variant | Back: up · median · best | Face down: up · median · best | Ankle on a stop, back / face down | Peak τ/stall | Peak ω/ω₀ | Peak temp | Derate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 5/5 · 3.14 s · 3.06 s | 5/5 · 2.50 s · 2.42 s | 0.72 s / 0.02 s | 1.00 | 0.61 | 34.5 °C | none |
| R | 4/5 · 3.52 s · 3.41 s | 3/5 · 3.35 s · 3.27 s | 2.15 s / 0.40 s | 1.00 | 1.02 | 39.8 °C | none |
| M | 5/5 · 4.64 s · 4.50 s | 5/5 · 2.85 s · 2.73 s | 3.01 s / 0.50 s | 1.00 | 0.54 | 35.1 °C | none |
| O | 5/5 · 4.53 s · 4.40 s | 4/5 · 2.56 s · 2.51 s | 2.92 s / 0.31 s | 1.00 | 0.69 | 37.2 °C | none |
| P | 5/5 · 4.30 s · 4.17 s | 5/5 · 2.57 s · 2.50 s | 2.48 s / 0.46 s | 1.00 | 0.53 | 35.9 °C | none |
| P′ | 5/5 · 3.85 s · 3.74 s | 4/5 · 2.74 s · 2.67 s | 2.20 s / 0.38 s | 1.00 | 0.59 | 38.7 °C | none |
| P+ak | 5/5 · 4.36 s · 4.06 s | 5/5 · 2.74 s · 2.65 s | 2.49 s / 0.37 s | 1.00 | 0.53 | 35.9 °C | none |

**Range sensitivity of the tilted hip** (static IK fit, `ranges-sweep.ts`):

| Ranges | Side | High side | Roundhouse turnover |
|---|---|---|---|
| §3 proposal (roll −30…110, yaw −80…180) | 4.9° | 16.8° | 19.3° |
| yaw −90…180 | 0.0° | 10.0° | 19.3° |
| roll −30…118, yaw −90…180 | 0.0° | **2.0°** | 19.0° |
| roll −30…125, yaw −100…180 | 0.0° | 0.0° | 10.8° |
| pitch extension +90 | 4.9° | 16.8° | 13.0° |

### 9.3 What each upgrade buys

- **Ranges (A → R): pivots, and nothing else on their own.**
  - The crouched 180° pivot goes from impossible (80-88° error; A's COM drifts up to 33 cm off the foot and the weld has to pull the foot down) to 1.4°. That is the kinematic result. Physically, the scripted 1.5 s turn needs an off-sole CoP on every variant (pivot table).
  - The side kick improves on paper (94° → 41°), but R still can't hold it: 2/5, with 29° of lean.
  - The front kick and gantry speed don't change.
  - **The §3 ankles cost the get-up from the back.** The stock clip asks for more ankle than ±39° / −20…+17° allow, so the ankles sit on a stop 2.2 s per get-up (A: 0.7 s), and the back get-up slows from 3.14 to 3.52 s (4/5).
- **Mass placement (R → M): the speed win.** It belongs in all three designs.
  - Leg swing inertia drops 49% about hip pitch (6.74 → 3.41 kg·m²) and 76% about the knee (1.52 → 0.36). The foot goes from 6.3 kg to 0.5 kg.
  - The gantry front kick reaches 90% in 201 ms instead of 277 (−27%), the side swing in 205 ms instead of 261. The knee snap takes 129 ms instead of 165, with peak knee speed 17.6 rad/s instead of 14.5.
  - It also lets the stock hip *fake* side kicks: 5/5 side holds at 25° of lean and 7° world error. It still misses the high side kick by 17° at 51° of lean.
  - Cost: from the back, the mocap get-up got slower (3.5 → 4.6 s), and its ankles sit on a stop for 3.0 s instead of 2.2 s. INFERRED, not isolated: the heavy feet were a counterweight that clip relies on, and the narrow ankles pin harder without it. Expect get-ups to need re-tuning, not to come free.
- **Hip order (M → O): real side kicks, at a price elsewhere.** It confirms Chris's call in physics.
  - Side kick: holds 5/5 at 11° lean and 2.6° world error (M: 25° and 7.4°). Hip-relative fit 4.9° (M 41°), gantry 5.0° (M 41.9°).
  - High side kick: 5/5 at 18° lean, 2.4° error, ankle at 1.27 m (M: 4/5, 51°, 17°).
  - The support leg works less: peak 0.69 of stall, against 1.00 on M.
  - §6's pass line literally reads "M misses by more than 30° or falls". M misses by 42° on the gantry but doesn't fall in the hold; it fakes the kick with lean. The meaningful metric is lean and world error, and on those O wins clearly.
  - **Roundhouse turnover is worse:** a 19° fit against 0° (the stock solution sits exactly on its gimbal lock).
  - **The crouched pivot costs hip travel:** the hip alone is 7-11° short. The whole-body plan makes it up, ending 3.5° off with hip pitch travelling 86° (M 41°). This is a kinematic result: the welded run needs an off-sole CoP on M and O alike.
  - **Gimbal lock is real:** a straight joint-space path from the stance to the side kick crosses roll 75° (σmin 0.02).
  - Gantry speed is unchanged.
  - Get-ups with the stock-retargeted clip: about the same from the back (4.5 s, M 4.6 s), better face down (2.56 s, M 2.85 s).
- **PINWHEEL drives (O → P): faster, 2.9 kg lighter, ankles marginal.**
  - Gantry front kick 160 ms (O 200), side 193 ms (O 213), knee snap 121 ms at 19.8 of 22 rad/s.
  - Side and high-side holds 5/5, as O. The front-kick hold drops to 3/5.
  - The RS04 ankle roll hits stall in the welded pivot, but only in the 50° crouch, where the turn needs a CoP up to 60 cm off the sole. A real foot would roll first, so this says nothing about the ankle drive.
  - The probes say the front-kick misses are this controller's margin, not a drive rating: AKE90 ankles (with either gain) and a twin-AKE90 hip yaw don't fix them. The AKE90-ankle probe (P+ak) was **worse** in the holds: front 0/5 and high side 0/5, against P's 3/5 and 5/5 (both fail as "support foot rolled over").
  - Get-ups: back 4.3 s, face down 2.57 s, all 5/5.
  - The saturating joints in get-ups are mostly the arms and the waist pitch (SAVATE's RS03 elbows and RS04 waist: up to 1.0 s at the clamp per get-up). P's new leg drives touch the clamp for at most 0.06 s from the back; face down, the left ankle pitch does for 0.33 s. (The verifier's per-joint count; the recorder's single "worst joint" breaks ties by joint order, so it under-reports legs.)
- **Armature (P → P′): small.**
  - Knee snap 126 ms against 121 (peak 19.1 against 19.8 rad/s). Gantry kicks +2%. Holds identical.
  - The get-up from the back came out faster (3.85 s), within the search's noise.
  - CubeMars' published AKE90 rotor inertia is in the catalog (3377 g·cm² × 8² = 0.0216 kg·m² per module, 0.065 for the triple stack). Our 0.02 + 0.01 × mass formula gives 0.064, so **P already carries real-hardware reflected armature for its stacks**. P′ is EngineAI's Q300HL class, about 4× more, and it doesn't change any decision.
- **Honesty audit.**
  - No result above stall torque: the motor model clamps every actuator to stall × speed × heat × battery every step. "1.00" means saturated at that clamp. Every gantry step saturates by design; holds and pivots name the joints that touch it.
  - No run reached a thermal derate band. The hottest winding was 39.8 °C against derate at 100 °C.
  - Peak speed stayed at or under no-load, except one R face-down drop at 1.02. Above no-load the motor model gives no driving torque, so the joint was being back-driven by the body, not driven.
  - The NEXT GEN ankles (±39° / −20…+17°) never sat on their stops in a hold (0.00 s within 1° of a stop). **They do in get-ups:** 2.2-3.0 s of every back get-up and 0.3-0.5 s face down, against 0.7 s / 0.02 s on stock A's ±60° / ±40°. Open question 7 is therefore **not** answered. Holds don't need wider ankles, but the stock clip's get-up does. Decide after a layout-specific get-up exists (Phase 2), not before.
  - **The pivot is weld-assisted.** Its foot hangs 8 mm above the canvas on the weld, and every variant needs an off-sole CoP for 0.3-0.5 s. Its torque peaks are not drive evidence; its kinematic numbers stand.
  - No get-up beat 2.4 s, so none needed the EngineAI-reference audit.
  - The 3 s URKL bar (≥ 4/5 seeds): **from the back, no variant passes.** Stock A is closest at a 3.14 s median, and the NEXT GEN variants take 3.5-4.6 s with a stock-retargeted clip. Face down, every variant passes (2.5-2.9 s) except R (3/5, 3.35 s). A get-up designed for the layout (Phase 2's `getup-search`) is still to come.

### 9.4 Recommendations for PINWHEEL, JACKKNIFE and CAPSTAN

- **Ranges.** Take §3 with two changes, both inside real robots:
  - **Hip yaw −90…+180** (internal limit −80 → −90; PM01 is −90, G1 and H2 about ±160). The side kick then fits exactly.
  - **Hip roll −30…+118** (the T800 base value). The high side kick fit goes from 16.8° to 2.0°.
  - Keep the §3 knee and waist. Keep the §3 ankles for now, as the honest default. They are fine for holds but pinned for 2-3 s in every back get-up with the stock clip, so open question 7 is decided after Phase 2's layout-specific get-up, not by Phase 0.
  - The Phase 2 shell sweep still sets the final clamps. Roll 118° sits past the 75° lock, so the kick skill must route around it (below).
- **Mass placement.** Adopt it on all three, exactly as built here: pitch drum in the pelvis, roll drum in front of the hip centre, yaw drum ~7 cm down the thigh, knee drive at the knee, ankle drives high on the shin. It is the largest single gain in leg speed, and it is free in torque.
- **Drives.** Use the PINWHEEL ladder as proposed for the hip and knee; nothing in Phase 0 asks for more.
  - Ankles: **keep the RS04 pair for now; Phase 0 does not support a swap.** AKE90-8 is the same mass (1.40 vs 1.42 kg), with 170 vs 120 N·m and 22 vs 20.9 rad/s, so it remains a candidate. But the only evidence for it was the RS04 roll saturating in the pivot, and that pivot is weld-assisted: the CoP leaves the sole by up to 60 cm. In the free holds, P+ak was worse than P (front 0/5 vs 3/5, high side 0/5 vs 5/5). Re-test the swap on the balance engine in Phase 1 with an unwelded pivot.
  - JACKKNIFE's AK10 ankles (53 N·m) were not tested and need the same pivot check in Phase 3.
  - CAPSTAN's twin-AKE90 yaw stays as its signature; the probe found no hold or pivot that needs it on PINWHEEL.
  - Waist pitch: P's RS04 waist pitch and SAVATE-class arms are what saturate in get-ups. Give NEXT GEN an AKE90 waist pitch, matching the waist yaw.
- **Armature.** Keep the formula: it already matches CubeMars' published rotor inertia for the AKE90 stacks. Don't import EngineAI's 0.243.
- **JACKKNIFE and CAPSTAN** were not built here. Everything above is measured on a SAVATE-sized body (83 kg, 1.73 m). The order and mass results are geometric and will carry over. The drive and get-up numbers must be re-measured on each design in Phase 3.

### 9.5 What should change in the plan

1. **§6's side-kick pass line** should judge torso lean and world-frame pose error, not falls. With mass moved, the stock hip holds a 25°-lean fake.
2. **The kick skill must avoid the roll-75° lock.** A straight joint path from the stance to the side kick passes σmin 0.02. Phase 1 needs either damped IK or a planned path (raise in flexion first, then roll out). Add a "σmin along each kick path > 0.2" test next to the IK round-trip test.
3. **Turned-over roundhouses are PINWHEEL's style, but the tilted hip fits the turnover 19° worse** than the old order. Plan for waist yaw and a pivot of the support foot to carry the turnover. Hip yaw −100 halves the fit error, if the shell allows it.
4. **Get-ups need layout-specific references.** Stock-retargeted clips through the tilted hip are slower from the back (3.9-4.6 s). Phase 2 should run `getup-search` on a T800-style tuck reference (10 §6.1) before judging the 3 s bar.
5. **Regenerate the regression lock** when the balance build commits its strike pass, and make `tests/nextgen/lock.test.ts` part of the Phase 1 gate.
6. **Re-run this Phase 0 on the balance engine** once `CONTROL.balance` is 'dcm'. The tools only need the controller swapped in for `balance.ts`. That gives the absolute hold and get-up numbers; the relative ones above should stand.
7. **Rebuild the pivot test before using it for drives.** Put the foot on the canvas, hold yaw only (or slow the turn until the CoP stays inside the sole), and treat any run whose `CopProbe` reports an off-sole CoP the way §6 treats torque above stall: reject it.
8. **Log ankle-stop time in get-ups** (now done: `tests-getup.ts` `ankleStopS`, `getup-replay.ts`). That is where the §3 ankles bind, not in holds.

### 9.6 Independent verification (2026-10-20)

An adversarial re-check of this section, with the same tools and no reuse of the build's outputs:
- **Production untouched.** `git diff` on `src/robots` and `src/physics` shows only the balance build's strike-pass work (catalog, designs, humanoid per-joint motor slots, control) and the move polish's untracked files; nothing references NEXT GEN.
- **Lock.** Run in a clean `git archive` of HEAD `03a2148` (which touched only `src/brain`), `tests/nextgen/lock.test.ts` passes 15/15. On the working tree it fails 14/15 as stated: the modern four's MJCF, and BRUISER at 6.85 s and STRIKER at 7.55 s of the trace. GOLIATH matches.
- **One change per step.** A field-by-field diff of consecutive variant designs: A→R changes only ranges; R→M only motor ids (massless clones) and drum geoms; M→O only the hip link bodies, axes, drum hosts and the re-solved stance hips; O→P only drives, gains, armature and the drum masses that follow the motors; P→P′ only hip-pitch and knee armature.
- **Hip.** The axes, order and ranges match §3, §4.1 and 10 §3.1: pitch axis (0, 0.966, −0.259) on the left, mirrored (0, 0.966, +0.259) on the right; roll x, then yaw along the thigh. The URDF's axis offsets are deliberately collapsed to one hip centre, per §4.1. FK matches MuJoCo, and the closed-form IK round-trip is now a check in `check.ts`.
- **Reproduced bit for bit:** static fits, mass and inertia, gantry, knee snap, holds (M, O, P, all three kicks, 5 seeds), the pivot, and the recorded get-up winners (all 14 rows).
- **Corrected here:** the pivot's weld (it hangs the foot 8 mm up and needs an off-sole CoP on every variant); the ankle-stop claim (true for holds, false for get-ups); the 3 s bar (A's 3.14 s does not pass, and R's face-down misses); the AKE90-ankle recommendation (withdrawn pending Phase 1).
