## Split Decision electric roster: four original fighters

All four fighters are all-electric, with no hydraulic circuits. The numbers below come from running the project's own `buildHumanoid()` and `compileRobot()` on these specs from a scratch script. The new motors were added to the catalog object in memory only; no repo file was modified.

### As built after the hardware pass (2026-10-20, night)

Two approved changes (Chris, 2026-10-20): FIRECRACKER's hip pitch and hip roll move from the CubeMars AK10-9 (53 N·m) to the RobStride 04 (`qdd.rs04`, 120 N·m, 20.9 rad/s, 1.42 kg), and the four items of docs/design/robot-realism-pass.md. Where this section and the strike-pass table below differ, this section and the code win.

1. **Armature from the real drive train.** Every modern joint's armature is its drive's reflected rotor inertia, rotor × ratio² (or the published reflected figure), the same value the damage model's joint loads use (`reflectedInertia` in `src/robots/catalog.ts`, `modernArmature` in `src/robots/humanoid.ts`), with a 0.004 kg·m² floor that only lifts the neck drives. Before, every joint had the placeholder 0.02 + 0.01 × motor mass. `src/physics/damage/joint-loads.ts` already subtracts `dof_armature` from the mass matrix and uses the catalog's J, so the damage numbers needed no change.

   | Drive | Before | Now (kg·m²) |
   |---|---|---|
   | RobStride 00 / 02 (necks) | 0.023 / 0.024 | 0.004 (floor; real 0.0015 / 0.0021) |
   | RobStride 06 / 2 × RS06 | 0.026 / 0.033 | 0.0049 / 0.0097 |
   | CubeMars AK10-9 / RobStride 03 | 0.030 / 0.029 | 0.0081 / 0.0081 |
   | AKE90-8 / RobStride 04 | 0.034 / 0.034 | 0.0216 / 0.0243 |
   | 2 × AKE90 / 3 × AKE90 | 0.049 / 0.064 | 0.0432 / 0.0648 |
   | MyActuator X12 (20:1 planetary; HAYMAKER hip roll, waist pitch) | 0.044 | 0.516 |

2. **Drive mass on the body that carries it** (`JointDef.mount`, modern era only, so the iron-age MJCF stays byte-identical). The stator sits on the parent, or the drive is mounted high on a linkage: shoulder pitch in the chest, elbow in the upper arm, hip yaw in the pelvis, knee in the thigh (linkage), both ankle drives in the shin (parallel linkage, as Unitree G1 / H1-2). The other drives stay in the part they move; the neck drive stays in the head (its mass sets the head's, which the head-pop calibration uses).
3. **The ankles are their own group** (`motors.ankle`, optional `ankleRoll`), sized about 1.5-2 N·m per kg of body: FIRECRACKER the AK10 (1.4 N·m/kg, as before), SAVATE and PYLON one AKE90-8 (170 N·m, 2.0 N·m/kg; the twin stack's 323 N·m was about twice what these feet can use), HAYMAKER one AKE90-8 (1.5 N·m/kg; it was the 2.37 kg X12 planetary).
4. **Catalog.** `servo.neck` is now run as the RobStride 02 it names: the sheet's 410 rpm (42.9 rad/s) and the `qdd.rs02` thermal numbers, not the made-up 12 rad/s; its mass stays 0.41 kg (the sheet's 405 g rounded, as before), which keeps the iron-age bodies byte-identical. `drive.wheel` is the RobStride 04 as sold, a 9:1 geared hub drive (120 N·m at the output, 20.9 rad/s, 1.42 kg); a truly direct hub on that motor would make about 13 N·m. No design uses it yet.

| Joint group | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Hip yaw | `qdd.ak10` | `qdd.ake90x2` | `qdd.ake90x3` | `qdd.ake90x2` |
| Hip pitch | **`qdd.rs04`** (was `qdd.ak10`) | `qdd.ake90x2` | `qdd.ake90x3` | `qdd.ake90x2` |
| Hip roll | **`qdd.rs04`** (was `qdd.ak10`) | `qdd.ake90x2` | `plan.x12` | `qdd.ake90x2` |
| Ankles (pitch, roll) | `qdd.ak10` | **`qdd.ake90`** (was `qdd.ake90x2`) | **`qdd.ake90`** (was `plan.x12`) | **`qdd.ake90`** (was `qdd.ake90x2`) |
| Knees, arms, waist, neck | as the strike pass | as the strike pass | as the strike pass | as the strike pass |

**Mass budget.** The totals stay on the roster spec (within 0.03%): 39.08 / 85.26 / 113.98 / 83.46 kg. The torso fill (pack, compute, wiring) took up the difference: FIRECRACKER's gave the RS04 hips 1.84 kg (245 → 166 kg/m³, 5.67 → 3.84 kg), and the mass the lighter ankles freed went back into the others' packs (SAVATE 140 → 272 kg/m³, +6.0 kg; HAYMAKER 75 → 118, +3.9 kg; PYLON 120 → 268, +6.0 kg; 10.7-12.4 kg of torso internals is a T800-class 1.4 kWh pack plus compute). `SHELL_BUILDS` in `src/physics/damage/durability.ts` mirrors these fills and must take the new torso values (tests/damage/durability.test.ts checks they match).

What moved (compiled part masses, kg, before → after) and what it does to the legs (MuJoCo's joint-space inertia at the stance pose, armature included, kg·m²; standing COM above the soles):

| | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Foot | 2.14 → 0.22 | 6.30 → 0.50 | 5.44 → 0.70 | 6.41 → 0.61 |
| Shin | 1.94 → 2.44 | 3.97 → 3.87 | 6.88 → 5.28 | 4.15 → 4.05 |
| Thigh | 3.97 → 5.35 | 11.22 → 11.22 | 14.97 → 14.97 | 11.17 → 11.17 |
| Forearm | 1.01 → 0.39 | 2.09 → 0.75 | 3.32 → 1.92 | 2.22 → 0.88 |
| Pelvis / torso | 1.30 / 12.06 → 3.22 / 12.15 | 2.92 / 19.51 → 8.72 / 28.30 | 4.68 / 29.30 → 13.48 / 36.01 | 2.79 / 18.86 → 8.59 / 27.63 |
| Hip pitch inertia | 1.26 → 0.70 | 6.29 → 2.33 | 7.02 → 3.23 | 8.03 → 3.07 |
| Knee inertia | 0.31 → 0.11 | 1.49 → 0.32 | 1.49 → 0.44 | 1.89 → 0.43 |
| Elbow inertia | 0.077 → 0.046 | 0.243 → 0.182 | 0.378 → 0.320 | 0.313 → 0.241 |
| Standing COM | 0.679 → 0.705 m | 0.836 → 0.982 m | 0.909 → 1.014 m | 0.909 → 1.075 m |

The feet had been carrying 2-6 kg of drives each, ballast that held the centre of mass 8-17 cm lower than a real build's and tripled the legs' swing inertia. The COM now sits at 54-57% of height, where a person's does.

**Gantry A/B** (`npx tsx tools/motor-variants.ts --gantry`, new in this pass: each design hung on its gantry, controller off, targets stepped at full power; peak speed of the striking surface's centre, glove or knuckle block, foot box, mid-shin; servo damping as built / at the punch burst's 0.15. Same throws before and after, m/s):

| Design | Throw | Before | After |
|---|---|---|---|
| FIRECRACKER | straight arm + waist | 3.64 / 4.68 | 3.95 / 4.85 |
| | hook arm + waist | 3.49 / 5.36 | 3.68 / 5.95 |
| | elbow snap | 4.69 / 6.04 | 5.27 / 6.68 |
| | front snap (hip + knee) | 3.92 / 3.92 | 6.79 / 7.89 |
| | knee snap (thigh level, 90° → straight) | 3.06 / 2.96 | 6.00 / 6.63 |
| | hip roll lift | 3.57 / 3.91 | 5.95 / 7.06 |
| SAVATE | straight arm + waist | 5.75 / 7.49 | 6.07 / 8.22 |
| | elbow snap | 5.67 / 7.34 | 6.19 / 8.03 |
| | front snap | 6.19 / 6.32 | 10.04 / 11.24 |
| | knee snap | 4.72 / 4.83 | 8.51 / 9.92 |
| | hip roll lift | 5.40 / 6.03 | 7.82 / 9.35 |
| HAYMAKER | straight arm + waist | 5.12 / 5.93 | 5.43 / 6.64 |
| | elbow snap | 5.79 / 7.03 | 6.03 / 7.21 |
| | front snap | 7.67 / 8.20 | 10.40 / 11.71 |
| | knee snap | 6.05 / 6.51 | 8.81 / 10.29 |
| | hip roll lift | 4.77 / 5.12 | 6.11 / 6.73 |
| PYLON | straight arm + waist | 5.48 / 6.82 | 5.84 / 7.43 |
| | hook arm + waist | 6.03 / 6.95 | 7.01 / 7.88 |
| | elbow snap | 5.89 / 7.55 | 6.41 / 8.24 |
| | front snap | 6.10 / 6.10 | 10.82 / 11.78 |
| | knee snap | 4.58 / 4.56 | 8.97 / 10.44 |
| | hip roll lift | 5.46 / 6.01 | 8.00 / 9.39 |

Knee snaps reach 90% of the extension in 88-98 ms at the burst damping (was 107-140 ms), the knees now turning at 17.5-20.2 rad/s of their 20.9-22 rad/s no-load (was 14.2-17.4). FIRECRACKER's RS04 hips alone (everything else as before) took its front snap from 3.92 to 5.84 / 6.20 m/s, the knee snap from 3.06 / 2.96 to 4.90 / 5.77 and the hip roll lift from 3.57 / 3.91 to 4.83 / 5.54; with the AK10 hips a knee snap's reaction shoved the thigh down at 5 rad/s, which is exactly the "cannot hold the trunk and carry the swing" failure. Arms gained 4-21% from the lighter forearms and real (lower) armature.

**Balance drills** (`tools/balance-drills.ts`, dcm path, the same seeds before and after; the centroid tables rebuilt for the new masses, see below):

- *Approach and hold* (40 fighter-drills per design): no falls before or after, and steadier on every design. Worst tilt beyond the stance lean 5.8 / 4.3 / 3.3 / 10.3° → 3.0 / 2.2 / 2.2 / 1.9° (FIRECRACKER / SAVATE / HAYMAKER / PYLON); DCM error 1.5 / 2.3 / 2.5 / 3.0 → 1.8 / 1.7 / 2.0 / 1.9 cm; worst planned-COP jump 2.0 / 11.3 / 6.5 / 18.5 → 2.7 / 2.0 / 5.6 / 2.0 cm; gyro peak in footwork 0.19 / 0.22 / 0.38 / 0.92 → 0.12 / 0.13 / 0.24 / 0.14; torso rate above 3 Hz 0.11 / 0.06 / 0.06 / 0.07 → 0.06 / 0.04 / 0.05 / 0.04 rad/s. Closing speed 0.42 / 0.54 / 0.53 / 0.53 → 0.46 / 0.54 / 0.50 / 0.50 m/s.
- *Pushes* of 1.1 m/s from 8 directions, standing / mid-swing walking: FIRECRACKER 8/8, 5/8 → 8/8, 7/8; SAVATE 8/8, 5/8 → 6/8, 8/8; HAYMAKER 8/8, 7/8 → 8/8, 7/8; PYLON 8/8, 2/8 → 5/8, 7/8. Standing ladders (largest ΔV survived, mean of the 8 directions): 1.23 / 1.24 / 1.44 / 1.23 → 1.30 / 1.29 / 1.46 / 1.20 m/s. Pushes from the front are taken far harder (SAVATE 1.5 → 1.9, HAYMAKER 1.6 → 2.1 m/s), but SAVATE at 90° and 225° and PYLON at 45°, 90° and 225° now hold 1.0 m/s (were 1.1-1.3). Putting the twin-AKE90 ankles back does not restore those directions (A/B: 1.23 / 1.16 mean), nor does leaving the freed mass out of the torso (1.29 / 1.23): it is the higher centre of mass meeting a stance controller tuned on the old one.
- *Strikes* (16 of each at a standing mirror opponent in its guard, seeds 1-16; peak = striker speed before contact, contact = the damage model's closing speed, p50): every punch got faster. FIRECRACKER peak 3.9-4.4 → 4.4-5.1 m/s, contact jab 2.0 → 2.3, cross 1.7 → 2.2, hook 3.6 → 4.6; SAVATE cross 1.9 → 3.3; HAYMAKER cross 2.4 → 3.1, uppercut 3.3 → 3.8; PYLON jab 2.2 → 3.9, cross 2.0 → 4.0 m/s. Kicks: PYLON's front kick lands 12/16, all clean, at a 9.2 m/s peak (was 4/16 at 3.5, with 2 falls); FIRECRACKER's low kick 16/16 at 5.6 m/s contact (14/16 at 4.2); SAVATE's front kick falls 3 → 0. Losses: FIRECRACKER's uppercut now flies past the guard (contact 11 → 3 of 16, its fist 0.8 m/s faster); HAYMAKER's procedural low kick never starts on 10 of 16 (the weight-shift gate times out; was 4), though the ones that go land at 8.4 m/s off a 9.1 m/s foot; SAVATE's hook falls 0 → 2 of 16 and the head kicks of SAVATE and PYLON fall 2 → 3 and 0 → 3 of 16. Falls per 10 kicks: 0 / 1.04 / 0 / 0.42 → 0 / 0.62 / 0 / 0.62; per 50 punches 0 everywhere except SAVATE 2.08 (the two hooks).
- *Get-ups* (laid face down, on the back and on each side, 3 drops each; standing within 5 s / at all): FIRECRACKER 10, 12 → 8, 12 of 12 (24-trial check: 20/24 → 16/24 within 5 s, back get-ups 7.6 → 3.0 s median); SAVATE 10, 11 → 2, 10; HAYMAKER 4, 10 → 2, 3; PYLON 9, 12 → 3, 4. **This is the pass's big regression.** The clip get-ups stall in the last rise of `getup_back.140_08` (pelvis 0.3 m below the clip, the centre of mass 12-40 cm behind the feet, then it sits back down): the heavy feet and shins they were tuned on had been rocking the body forward over its feet. A/B to find the part: with no drive mounts (everything else of the pass kept) the get-ups come back to 11-12 of 12 at all (5 / 5 / 6 of 12 within 5 s); without only the knee mount 10 / 7 / 9 of 12; without only the ankle mount 10 / 3 / 6; the armature alone changes nothing; the twin-AKE90 ankles back give 10 / 8 / 10. So the knee drive riding in the thigh costs most of it, and the get-up plans (tests/control/getup-search.ts, GETUP_SPEED, the clip timing) need re-tuning on the new bodies; deferring the mounts is one line (`PARENT_MOUNTED` in `src/robots/humanoid.ts`).
- *Sparring* (`tools/fight-metrics.ts`, 24 fights: savate:haymaker, firecracker:pylon, haymaker:pylon, savate:firecracker × seeds 1-6, 90 s, the sparring brain, dcm): self-inflicted knockdowns 0.88 → 0.52 per fighter per 2 min (19 → 9; FIRECRACKER 1.82 → 0, PYLON 1.05 → 0.25, HAYMAKER 0.58 → 0.54, SAVATE 0.83 → 0.85), self-falls while stepping or standing 12 → 7, approach 0.22 → 0.34 m/s, foot contact speed p50/p90 2.0 / 2.1 → 2.5 / 4.0 m/s, fist 2.7 / 4.6 → 2.9 / 5.0 m/s. But get-up success fell 96% → 50% (PYLON 0 of 3, HAYMAKER 1 of 4), six fights ended on a fighter who could not rise (none before), and landed strikes fell 37.8 → 32.6 per minute (thrown 54.2 → 45.4). FIRECRACKER still loses its head within seconds in both (the head-pop bug, another stage's).

The centroid tables (`tools/mocap/centroid-tables.ts`) were rebuilt for the four, because they carry each design's masses and motors (COM height 0.70 / 0.86 / 0.94 / 0.94 → 0.73 / 1.01 / 1.04 / 1.11 m); run on the old tables the strike drills came out within noise of the new, so the results above are the hardware's. The motion libraries' speed limits were not rebuilt: the runtime takes them from each robot's own motors (`src/physics/control/mocap/library.ts`), and nothing reads the libraries' snapshot of them.

### As built after the strike pass (2026-10-20)

Chris approved every actuator swap in docs/design/strike-power.md §2.8 (2026-10-06), each to be A/B-tested on the gantry first. The per-design actuator tables further down are the original concept; where they differ, the code (`src/robots/designs/index.ts`, catalog ids in `src/robots/catalog.ts`) and this table win. Every module is a real, published one, or a parallel stack of catalogued modules under the catalog's stack rule (n × peak × 0.95 load share, the module's speed, +0.1 kg coupling per added module).

| Joint group | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Hip yaw, hip pitch | `qdd.ak10` | `qdd.ake90x2` | **`qdd.ake90x3`** (was `plan.x12`) | `qdd.ake90x2` |
| Hip roll, ankles | `qdd.ak10` | `qdd.ake90x2` | `plan.x12` | `qdd.ake90x2` |
| Knees | `qdd.rs04` | `qdd.ake90x2` | `qdd.ake90x3` | `qdd.ake90x2` |
| Shoulder pitch | **`qdd.ak10`** (was `qdd.rs06`) | **`qdd.ake90`** (was `qdd.rs04`) | **`qdd.ake90`** (was `qdd.rs04`) | **`qdd.ake90`** (was `qdd.rs03`) |
| Shoulder roll, yaw | `qdd.rs06` | `qdd.rs04` | `qdd.rs04` | `qdd.rs03` |
| Elbows | **`qdd.rs06`** (was `qdd.rs02`) | **`qdd.rs06x2`** (was `qdd.rs03`) | **`qdd.ake90`** (was `qdd.rs04`) | **`qdd.rs06x2`** (was `qdd.rs06`) |
| Waist yaw | `qdd.rs03` | **`qdd.ake90x2`** (was `qdd.rs04`) | **`qdd.ake90x2`** (was `plan.x12`) | **`qdd.ake90x2`** (was `qdd.rs04`) |
| Waist pitch | `qdd.rs03` | `qdd.rs04` | `plan.x12` | `qdd.rs04` |
| Compiled mass | 39.07 kg (was 37.96) | 85.26 kg (was 82.94) | 113.95 kg (was 105.38) | 83.48 kg (was 79.56) |

New catalog entry: `qdd.rs06x2`, two RobStride 06 (robstride.com/products/robStride06: 11/36 N·m, 480 rpm, 621 g) on one output: 68.4 N·m, 50.3 rad/s, 1.34 kg. The builder takes the swaps as optional per-joint entries (`HumanoidSpec.motors.shoulderPitch / waistYaw / hipPitch / hipYaw`); without them a design compiles exactly as before, so the iron-age three are unchanged.

**Gantry A/B** (robot hung on its gantry, controller off, joint targets stepped at full power, the servo damping at the strike drive's 0.15; peak fist or foot speed, m/s; scratch probe `gantry-ab.mts`, same method as `tools/strike-bench.ts --mode gantry`):

| Design | Throw | Before | One swap at a time | All swaps |
|---|---|---|---|---|
| FIRECRACKER | straight arm only | 3.48 | shoulder AK10 4.71 | |
| | straight arm + waist | 5.77 | shoulder AK10 6.31 | |
| | elbow snap | 4.35 | elbow RS06 6.08 | 6.12 |
| SAVATE | straight arm only | 3.85 | shoulder AKE90 4.95 | 4.35 |
| | straight arm + waist | 5.58 | waist AKE90×2 7.33; shoulder 6.22 | **7.49** (RS06×2 elbow) / 7.11 (AKE90 elbow) |
| | hook arm + waist | 5.72 | waist 7.33 | 7.12 / 7.16 |
| | elbow snap | 5.50 | RS06×2 7.37; AKE90 6.75 | 7.48 / 6.75 |
| HAYMAKER | straight arm + waist | 5.98 | shoulder 6.43; waist 6.03 | 6.74 (RS06×2) / 5.93 (AKE90) |
| | elbow snap | 6.45 | RS06×2 7.01; AKE90 7.05 | 7.11 / 7.05 |
| | front snap (hip + knee) | 5.69 | hips AKE90×3 **7.55** | 7.55 |
| | hip yaw turn (shin) | 5.23 | hips AKE90×3 **6.94** | 6.94 |
| PYLON | straight arm only | 3.56 | shoulder AKE90 4.98 | 4.60 |
| | straight arm + waist | 5.30 | shoulder 6.45; waist 6.73 | 6.82 (RS06×2) / 5.96 (AKE90) |
| | hook arm + waist | 5.73 | waist **7.73** | 6.95 |
| | elbow snap | 6.20 | RS06×2 6.29 | 7.69 / 7.33 |

Elbow choice (decision D2): the twin RS06 is the faster elbow on SAVATE and PYLON (their old RS03 / RS06 had 60 / 36 N·m, so the 68 N·m stack is no weaker). On HAYMAKER the two snap alike (7.01 vs 7.05 m/s), its old RS04 elbow had 120 N·m, and its get-ups need the arms to push 114 kg off the canvas: shoved over 8 ways, it stood back up 7 of 8 times on the AKE90 elbow against 5 of 6 on the twin RS06 (and 5 of 8 on the old motors), so HAYMAKER takes the AKE90. FIRECRACKER's waist (RS03) was left: an RS04 there gained 5-19 % on waist throws for +0.52 kg, and it is not in the approved list.

What it costs: 1.1-8.6 kg per design (HAYMAKER's 8.1 kg is its four hip drives, decision D3: faster kicks and get-ups, the planetary hips' gear-damage weakness gone). The spec masses in `08-modern-roster.json` follow the compiled ones. Balance drills after the swaps (dcm path): approach-and-hold unchanged (0 falls in 160 fighter-drills, closing speed 0.42-0.53 m/s as before); stance pushes of 1.1 m/s survived 6/8, 7/8, 7/8 on FIRECRACKER, SAVATE and HAYMAKER (5, 5 and 7 of 8 before), PYLON 4/8 (7/8 before: its upper body is 3.9 kg heavier; reverting any one of its three swaps alone did not restore it). On the full ΔV ladder PYLON's stance recovery drops about 5 % (mean of the eight directions 1.04 m/s against 1.09), in line with the 4.9 % mass it gained on the same gyro core and feet.

**Speed and impact after the strike pass** (balance engine; `tools/balance-drills.ts --drills strikes`, 8 of each strike at a standing mirror opponent in its guard, thrown from the tactics' own distances; p50 values. Peak: the striking fist's or foot's top speed before contact. Contact: the damage model's closing speed and impulse at the first contact, which is mostly his guard. Punches are driven, `src/physics/control/strike-path.ts`; kicks marked proc are the procedural ones the engine keeps on that design.)

| Design (human straight punch, size-scaled) | Strike | Peak m/s | Contact m/s | Impulse N·s | Throw to contact s | Landed |
|---|---|---|---|---|---|---|
| FIRECRACKER (6.6) | jab / cross | 3.7 / 4.4 | 2.1 / 1.8 | 5.7 / 6.6 | 0.24 / 0.33 | 6/8, 4/8 |
| | hook / uppercut | 4.3 / 4.3 | 3.6 / 3.8 | 6.1 / 6.6 | 0.27 / 0.28 | 8/8, 6/8 |
| | low kick (proc) | 4.0 | 4.2 | 13.2 | 0.58 | 8/8 |
| SAVATE (8.7) | jab / cross / hook | 4.5 / 5.5 / 4.0 | 2.4 / 2.9 / 3.6 | 11.3 / 10.3 / 14.9 | 0.28 / 0.35 / 0.26 | 8/8, 7/8, 8/8 |
| | front / head / low kick | 5.0 / 4.2 / 3.1 | 0.8 / 1.3 / 1.1 | 10.9 / 11.3 / 15.4 | | 4/8, 4/8, 3/8 |
| HAYMAKER (9.2) | jab / cross / hook | 3.8 / 4.7 / 3.4 | 2.4 / 2.7 / 2.7 | 12.5 / 9.6 / 13.9 | 0.24 / 0.23 / 0.25 | 8/8 each |
| | uppercut / overhand | 5.1 / 4.9 | 3.2 / 4.0 | 18.6 / 11.0 | 0.25 / 0.23 | 8/8 each |
| | low kick (proc) | 6.9 | 8.5 | 78.6 | 0.63 | 6/8 |
| PYLON (9.6) | jab / cross | 4.3 / 5.5 | 2.7 / 2.3 | 6.7 / 11.9 | 0.22 / 0.33 | 6/8, 7/8 |
| | front kick (proc) / low / head | 6.8 / 3.5 / 4.2 | 1.3 / 1.7 / 1.3 | 9.3 / 18.2 / 15.9 | | 6/8, 5/8, 5/8 |

Against people: an Olympic boxer's straight punch arrives at 9.1 ± 2.1 m/s (Walilko et al. 2005; scaled by reach to these frames, 6.6-9.6 m/s), a roundhouse kick's shin at 5.6-7.2 m/s (Gavagan & Sayers 2017), and a punch's effective mass of about 2.9 kg puts its impulse near 26 N·s. The robots' fists now peak at 40-65 % of their human-scaled speed and meet the guard at 20-45 % of it; the gantry shows the motors can throw 6-7.7 m/s, but in the drill the drive mostly reaches him at the end of its path, still accelerating, and his guard is usually what it meets (guard dropped, SAVATE's cross lands at 5.3 m/s p50). The blows come fast: 0.22-0.35 s from the throw to the contact, against 0.14-1.0 s before the pass (the hooks took 0.6-1.0 s), which is where a person's punch is. HAYMAKER's procedural low kick is the one strike past the human figures (8.5 m/s and 79 N·s into the thigh). Punches fell 0 times in 112 (before: once, a SAVATE hook). Kicks landed 43 of 72 (before 37, procedural only 24) and fell 7 times (before 2): SAVATE's front kick falls 3 in 8 in every variant tried (no r_bal, no gyro gate, slower playback, the old motors 2 in 8), PYLON's three kicks 1 each.

| | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Class it draws on | Kid-size (G1 / T1 class) | Adult-size (T800 class) | Heavy adult-size, electric | Rangy adult-size (H1 / H2 class) |
| Height | 1.30 m | 1.73 m | 1.82 m | 1.89 m |
| Mass (compiled) | 37.9 kg | 82.9 kg | 103.1 kg | 79.3 kg |
| Real-world weight class (WHRG 2026: 40 / 58 / 80 kg) | 40 kg | 80 kg + 2.9 | above 80 kg (open) | 80 kg |
| Builder `scale` / `bulk` | 0.667 / 0.95 | 0.887 / 0.92 | 0.933 / 1.12 | 0.97 / 0.78 |
| Armor / frame | polycarb / al6061 | polycarb / al7075 | uhmw / al7075 | carbon / al7075 |
| Degrees of freedom | 23 | 23 | 23 | 23 |
| Actuator mass | 19.1 kg | 44.3 kg | 47.2 kg | 38.2 kg |
| Peak knee torque per kg | 3.2 N·m/kg | 5.4 | 4.4 | 4.0 |
| Stance COM height | 0.66 m | 0.85 m | 0.94 m | 0.93 m |
| Gyro core (torque / momentum / mass) | 50 N·m / 17 N·m·s / 2.3 kg | 140 / 49 / 6.5 | 195 / 68 / 9.1 | 150 / 51 / 6.8 |
| Hands | 8-oz-class gloves + headgear | bare fists | ~21-oz-class gloves | bare fists |
| Style | swarmer | kickboxer | pressure brawler | distance kicker |

For comparison, the current roster compiles to 236 kg (BRUISER), 146 kg (STRIKER) and 408 kg (GOLIATH). The heaviest robot that has actually fought is the T800 at 75–85 kg. All four new designs have more knee torque per kg than today's STRIKER (450 N·m / 146 kg = 3.1 N·m/kg), and every big leg joint turns faster than the catalog's `qdd.t800` (9 rad/s): 13.1 rad/s for the X12, 11.3 for the X15, 33.5 for the AK10-9. Lighter robots also fall softer. Fall energy (m·g·h of the COM) is 245 J for FIRECRACKER, 690 J for SAVATE, 955 J for HAYMAKER and 725 J for PYLON, against about 2,600 J for BRUISER. That is the biggest lever for faster, more human-looking fights.

### Gyro core sizing (one rule for all four)

Your balance controller scales its gyro demand with m·g and m·g·h (`gyroDemand` in `src/physics/control/balance.ts`). The existing gyros sit at 0.14–0.20 × m·g·h of torque and 0.056–0.074 s × m·g·h of momentum; STRIKER's is 0.20 and 0.074. These four use one rule:

- momentum H = 0.071 s × m·g·h_COM
- torque τ = 0.205 × m·g·h_COM. That makes τ/H ≈ 2.9 s⁻¹, a gimbal slew of about 2.9 rad/s, which matches the real Airbus CMG 15-45 S (45 N·m from 15 N·m·s, a ratio of 3.0).
- device mass = H / 7.5 N·m·s per kg

**Real hardware anchors**

| Device | Momentum | Torque | Mass | Momentum per kg | Torque per kg |
|---|---|---|---|---|---|
| Airbus CMG 15-45 S (space-rated) | 15 N·m·s | 45 N·m | 18.4 kg | 0.8 | 2.4 |
| Seakeeper 1 (boat stabilizer, 9,750 rpm) | 1,000 N·m·s | 2,620 N·m | 166 kg | 6.0 | 15.8 |
| GyBAR (wearable balance aid) | not stated | 53 N·m | 16 kg | — | 3.3 |
| GyroPack (two CMGs) | not stated | not stated | 6 kg | — | — |

- **Our density.** 7.5 N·m·s/kg is about 25% denser than Seakeeper, and torque density is about 22 N·m/kg. That is plausible for a sealed thin-rim rotor at about 220 m/s rim speed that runs in bursts of seconds. For example, a 2.2 kg steel rim at r = 0.10 m and 21,000 rpm gives about 48 N·m·s, which is SAVATE's core.
- **Current roster is denser than any hardware I found.** The existing gyros run 11–12 N·m·s/kg.
- **FIRECRACKER doesn't need a big one.** Its m·g·h is 244 N·m against HAYMAKER's 955, so 2.3 kg (6% of its mass) gives it the same relative authority as STRIKER. The real G1 has no gyro at all.
- **PYLON will saturate most often.** Its hip span is the narrowest (0.18 m) and its COM the highest. That is its designed weakness: body shots and low kicks that knock it off its base drain the gyro.

### Gloves: what they change, grounded in data

- **Evidence.** Nakano, Iino and Kojima (ISBS 2009) had nine collegiate boxers throw full-power rear straights into a free 4.36 kg head-mass target.
  - 10-oz gloves: 2,090 N peak, 18.6 N·s impulse.
  - 16-oz gloves: 1,900 N peak, 19.1 N·s impulse.
  - Contact lasted 18.5–28.8 ms. Cushioning, not glove mass, set the peak force.
- **In the engine:** a glove should keep impulse about the same, lower peak force and stretch the contact.
  - Model it with a larger, softer striker. Use a MuJoCo solref time constant of about 0.015–0.02 s instead of 0.004, so contacts last the measured 18–29 ms.
  - Your head-break threshold (`headBreakImpulseNs`) is impulse-based, so gloves will **not** save heads.
  - Gloves do cut dents and sparks on the target, and they protect the wearer's own fist part.
  - Real kid-size fighters glove up partly to protect fragile hands. URKL's T800s fight bare-fisted.
- **Per-design choice:**
  - FIRECRACKER: gloves and padded headgear, the real kid-size fight dress.
  - SAVATE: bare, as in URKL.
  - HAYMAKER: oversized gloves, so it can throw full hooks all night without breaking its hands.
  - PYLON: bare.

---

### 1. FIRECRACKER (id `firecracker`), the lightweight

*Thirty-eight kilos of fast hands, back up before the count starts.*

**Inspired by.** The kid-size class that did nearly all the 2025 fighting and still boxes in 2026:
- **Unitree G1** (1.32 m, 35 kg, 90/120 N·m knees): CMG Hangzhou, WAIC, WHRG 2025, REK1, UFB at CES 2026, and WRC 2026.
- **Booster T1** (1.18 m, 30 kg): Silicon Colosseum.

**What it keeps:** size, 23 DoF, torque class, gloves and headgear.

**What it changes:**
- A rounded pebble chest instead of a boxy flat-front torso.
- Tangerine and graphite instead of satin silver.
- Three round lenses in a downward-pointing triangle instead of a black dome with a glowing halo ring.
- Unbranded open-face headgear.
- No twin thigh stripes and no orange ankle rods.

**Build and proportions**
- 1.30 m, 37.9 kg, stance COM at 0.66 m.
- Thigh and shin 0.293 m each, about 8% shorter than a 1.30 m human (0.32 by Winter's segment ratios).
- Arm reach from shoulder, including the fist, is 0.48 m. That is 15% short of a human; the builder's arm ratio is fixed.
- Shoulder-joint span 0.39 m, 17% wider than a human's shoulders. Hip-joint span 0.15 m.
- Torso 0.22 m deep × 0.32 wide × 0.32 tall; head 0.15 × 0.13 × 0.16 m.
- Built like a squat, wide-shouldered bantam.

**Actuators**

| Joint group (builder slot) | Module | Peak / rated | No-load speed | Mass | Ratio / voltage |
|---|---|---|---|---|---|
| Hips + ankles (`leg`) | CubeMars AK10-9 V3 QDD | 53 / 18 N·m | 320 rpm = 33.5 rad/s | 0.96 kg | 9:1, 48 V |
| Knees (`knee`) | RobStride 04 QDD | 120 / 40 N·m, same as a G1 EDU knee | 200 rpm = 20.9 rad/s | 1.42 kg | 9:1 |
| Shoulders (`arm`) | RobStride 06 | 36 / 11 N·m | 480 rpm = 50.3 rad/s | 0.621 kg | 9:1 |
| Elbows (`elbow`) | RobStride 02 | 17 / 7 N·m | 410 rpm = 42.9 rad/s | 0.405 kg | 7.75:1 |
| Waist (`waist`) | RobStride 03 | 60 / 21 N·m | 195 rpm = 20.4 rad/s | 0.90 kg | 9:1 |
| Neck (`neck`) | RobStride 00 | 14 N·m | 315 rpm | 0.31 kg | 10:1 |

- **Gyro:** 50 N·m, 17 N·m·s, 2.3 kg.
- **Head break:** 32 N·s. Headgear raises it by roughly 30%; that is a tuning choice, so calibrate with `tools/fight-sim.ts`.

**Materials**
- Polycarbonate armor shells over a 6061 frame.
- Target fists are 8-oz-class foam gloves (about 0.23 kg each). The builder's `'block'` AR500 fist stands in until a glove kit exists.
- Open-face EVA-foam headgear.

**Look**
- **Chest:** a smooth pebble- or egg-shaped gloss shell, widest at the top with no flat front. Below it, a small hexagonal graphite belly plate. One warm-white chevron on the sternum.
- **Head:** a squat rounded trapezoid, wider at the jaw. Three round warm-white lenses (#FFF1DC) in a downward triangle, two at brow level and one centred at mouth level, each in a graphite bezel. A short louvered chin vent.
- **Fight gear:** open-face padded headgear with cheek pads and a brow roll, and gloves with white cuffs. Both are in the corner colour, with no lettering.
- **Limbs and joints:** rounded tangerine thigh and shin shells. Dark graphite actuator pucks exposed at shoulders, hips and knees. Slim ribbed graphite forearms.
- **Feet:** rounded graphite shoe shells with tangerine toe caps.
- **Colours:** gloss tangerine #F26B1D, graphite #2A2826.
- **Decals:** race number 07 on the left chest and right thigh.

**Fight style**
- A swarmer. It sprints inside the kicking range of longer robots and throws volume: jab-cross into hooks and uppercuts to the body and chin.
- It chops the lead knee with low kicks and uses front kicks to shove bigger robots off their base.
- Its weapon is recovery. It has the lowest COM and the smallest fall energy (about 245 J), so it should hit URKL's 3-second get-up standard more often than anyone.
- **Weaknesses:** 0.48 m reach, 120 N·m knees, and it cannot reach a tall robot's head with a kick, so `head_kick` is left out.

**Abilities:** jab, cross, hook, uppercut, front_kick, low_kick, sprint.

---

### 2. SAVATE (id `savate`), the middleweight

*A 450 N·m kickboxer. The shins are the weapon.*

**Inspired by.** EngineAI's T800 (173 cm, 75–85 kg, 450 N·m) as fought in URKL Shenzhen (16 July 2026), URKL Shanghai (19 September), REK2 and CyberHero Riyadh. Those fights featured committed roundhouse and tornado kicks, jumping knees and kip-ups, and a head knocked clean off.

**What it keeps:** the height, the 450 N·m knee class, bare fists, and kick-first fighting.

**What it changes:**
- A narrow wedge head with one **vertical** light bar, instead of a dome helmet with a horizontal LED visor.
- A faceted diamond chest plate instead of a round chest emblem.
- Aubergine and bone instead of the white/grey, gold-chrome or gunmetal-and-red liveries.
- Purchasable MyActuator modules instead of the maker's own joints.

**Build and proportions**
- 1.73 m, 82.9 kg, stance COM at 0.85 m.
- Thigh and shin 0.39 m each, about 8% short of a human. Leg length to the sole is about 0.85 m; the T800's is 0.91 m.
- Arm reach 0.64 m (16% short of a human; the T800 arm is 0.60 m).
- Shoulder-joint span 0.51 m, 13% wider than a human's. Hip span 0.20 m.
- Torso 0.28 × 0.41 × 0.43 m; head 0.20 × 0.18 × 0.21 m.
- Athletic, with a slightly tapered waist.

**Actuators**

| Joint group | Module | Peak / rated | No-load speed | Mass | Ratio / voltage |
|---|---|---|---|---|---|
| Hips + ankles | MyActuator RMD-X12-P20-320-E | 320 / 85 N·m | 125 rpm = 13.1 rad/s | 2.37 kg | 20:1, 48 V |
| Knees | MyActuator RMD-X15-P20-450-E | 450 / 145 N·m | 108 rpm = 11.3 rad/s | 3.5 kg | 20.25:1, 72 V |
| Shoulders + waist | RobStride 04 | 120 N·m | 20.9 rad/s | 1.42 kg | 9:1 |
| Elbows | RobStride 03 | 60 N·m | 20.4 rad/s | 0.90 kg | 9:1 |
| Neck | RobStride 02 (existing `servo.neck`) | 17 N·m | — | — | — |

- **Gyro:** 140 N·m, 49 N·m·s, 6.5 kg.
- **Head break:** 45 N·s. There is no headgear, so a clean head kick in a mirror match can decapitate, as happened in the URKL opener.
- **To make the real 80 kg class:** swap hips and ankles to an M107-class module (360 N·m, about 1.9 kg). That compiles to 79.7 kg, but Unitree publishes no speed for it.

**Materials**
- Polycarbonate shells over a 7075 frame; the T800 itself uses aviation aluminium plus titanium.
- Bare AR500 knuckle plates, which is the builder's `'block'` fist.
- EVA-foam shin guards over the polycarbonate shin shells. This is visual only; a softer shin contact would need builder work.

**Look**
- **Head:** a narrow forward-raked wedge, longer front-to-back than wide, in satin aubergine. One thin pale-mint (#9DFFD6) vertical light bar runs from brow to chin on the centreline. Two small round cheek sensors sit in brushed-aluminium bezels. There is no horizontal visor.
- **Chest:** a faceted diamond (kite) plate pointing down to the waist, with a raised centre ridge and separate side plates.
- **Hips:** a split two-panel hip skirt.
- **Legs:** long aubergine thigh plates over brushed-aluminium structure. Bone-white (#E9E2D0) ribbed foam shin guards cover the shins and insteps.
- **Joints:** exposed ring-shaped bearing housings in brushed aluminium (#B9BCC0) with dark graphite motor cans.
- **Fists:** compact bare fists with raised knuckle plates.
- **Feet:** black soles with aubergine heel counters.
- **Colour:** satin aubergine #3D1F4F.
- **Decals:** number 21 on the left facet of the chest diamond and on both shin guards.

**Fight style**
- An orthodox kickboxer. It measures with the jab, chops the lead leg with low kicks until the opponent's stance or gyro gives, then goes upstairs with the head kick.
- The front kick stops pressure fighters. Sprint cuts angles.
- Hands finish combinations: jab-cross-hook into a kick.
- **Weaknesses:** bare fists, no headgear, polycarbonate that dents, and 20:1 knees and hips. Those joints backdrive less than 9:1 QDD, so under your gear-damage rule they are more fragile to impacts (see Wensing et al., cited in `docs/research/02-actuators.md`).

**Abilities:** jab, cross, hook, front_kick, low_kick, head_kick, sprint.

---

### 3. HAYMAKER (id `haymaker`), the heavyweight brawler

*The heaviest thing electric joints can carry. Every punch is thrown to end it.*

**Inspired by.** It does not copy any robot that has fought. It extrapolates the adult-size electric class upward:
- **Unitree H2:** 1.82 m, 70 kg, 360 N·m legs, 120 N·m arms.
- **T800:** 450 N·m.

It stops at the heaviest mass a 450 N·m electric knee should carry:

| Robot | Knee torque per kg |
|---|---|
| HAYMAKER | 4.4 N·m/kg |
| T800 | 5.6 N·m/kg |
| H1 | 7.7 N·m/kg |

That puts it above WHRG 2026's 80 kg top Free Combat class. Above about 110 kg you are back to hydraulics, where BRUISER and GOLIATH live.

**What it changes:** UHMW slab armour from combat-robot practice instead of foam kits or plastic covers, a hammerhead head, olive drab paint, and oversized gloves.

**Build and proportions**
- 1.82 m, 103.1 kg, stance COM at 0.94 m.
- Thigh and shin 0.41 m each (8% short of a human). Arm reach 0.69 m (14% short).
- Shoulder-joint span 0.65 m, **38% wider than a human's**. Hip span 0.25 m.
- Torso 0.36 × 0.52 × 0.45 m; head 0.21 × 0.19 × 0.22 m.
- Top-heavy and barrel-chested, with almost no neck.

**Actuators**

| Joint group | Module | Peak / rated | No-load speed | Mass | Note |
|---|---|---|---|---|---|
| Hips + ankles | MyActuator X12-320 | 320 N·m | 13.1 rad/s | 2.37 kg | |
| Knees | MyActuator X15-450 | 450 N·m | 11.3 rad/s | 3.5 kg | |
| Waist yaw/pitch | MyActuator X12-320 | 320 N·m | 13.1 rad/s | 2.37 kg | Hooks and overhands come from the waist, and the upper body is about 60 kg |
| Shoulders + elbows | RobStride 04 | 120 N·m | 20.9 rad/s | 1.42 kg | Elbows sized for heavy gloves |
| Neck | RobStride 02 | 17 N·m | — | — | |

- **Gyro:** 195 N·m, 68 N·m·s, 9.1 kg.
- **Head break:** 65 N·s.

**Materials**
- UHMW-PE slab armour over a black-anodized 7075 frame. UHMW is the sacrificial "soak" armour combat builders use, at 940 kg/m³ with no-break impact toughness.
- Oversized gloves, about 21-oz class (about 0.6 kg each).

**Look**
- **Head:** a low, wide, flat-topped hammerhead block, wider than it is deep. It sits sunk between rounded shoulder cowls that rise almost to its brow. Two small round red-orange (#FF4D1A) lenses sit at its outer corners under a thick overhanging brow ledge, with a heavy chin bar below. The face is solid, with no grille or mesh.
- **Torso:** a barrel chest of thick matte olive-drab (#56613A) UHMW panels, gouged and scuffed. Exposed button-head bolts fix them to the black frame (#141516).
- **Joints:** large black actuator drums exposed at the waist, hips and knees.
- **Limbs:** thick forearm and shin panels. Gloves in the corner colour.
- **Feet:** wide square feet with thick rubber soles.
- **Decals:** stencil number 44 on the chest and back.
- **Skin:** your existing `military` skin fits almost exactly.

**Fight style**
- A pressure brawler. It walks forward behind a high guard and smothers kickers in the clinch.
- It digs uppercuts and hooks, then loads the overhand. Low kicks chop the legs of anyone trying to circle.
- **Weaknesses:** the slowest legs in the roster, the biggest fall (about 955 J), no sprint, and its gyro saturates when it chases a mover.

**Abilities:** jab, cross, hook, uppercut, overhand, low_kick, clinch.

---

### 4. PYLON (id `pylon`), the wildcard

*Six foot two of legs. It hits you from where you can't hit back.*

**Inspired by.** The rangy adult-size lineage:
- **Unitree H1:** 1.8 m, 47 kg, 360 N·m knee.
- **Unitree H2:** 1.82 m, 70 kg.

It weighs 79.3 kg, inside WHRG 2026's 80 kg class.

**What it changes:**
- It is taller than both.
- Hi-vis lime and reflective silver instead of all-black or white and silver.
- An **asymmetric** three-lens lozenge head instead of an elongated faceless helmet or a sculpted human face.
- No ball hands and no knit sweater.

**Build and proportions**
- 1.89 m, 79.3 kg, stance COM at 0.93 m.
- The longest legs in the roster: thigh and shin 0.43 m each, about 0.85 m of leg.
- Arm reach 0.69 m. That equals HAYMAKER's reach, because the builder's arm ratio is fixed and 17% short of a human's. If an `armScale` parameter is added, 1.12 would give PYLON a human-length 0.77 m jab.
- Shoulder-joint span 0.47 m (human-like). Hip span only 0.18 m.
- Torso 0.26 × 0.38 × 0.47 m; head 0.21 × 0.19 × 0.23 m.

**Actuators**

| Joint group | Module | Peak / rated | No-load speed | Mass | Note |
|---|---|---|---|---|---|
| Hips + ankles + knees | MyActuator X12-320 | 320 N·m | 125 rpm = 13.1 rad/s | 2.37 kg | Knee uses the X12, not the X15, because it is 16% faster |
| Shoulders | RobStride 03 | 60 N·m | 20.4 rad/s | 0.90 kg | |
| Elbows | RobStride 06 | 36 N·m | 50.3 rad/s | 0.621 kg | A snapping jab |
| Waist | RobStride 04 | 120 N·m | — | — | |
| Neck | RobStride 00 | 14 N·m | — | — | |

- **Gyro:** 150 N·m, 51 N·m·s, 6.8 kg.
- **Head break:** 40 N·s.

**Materials**
- Carbon-fibre shells, painted hi-vis, on the chest, forearms, shins and head.
- Dark-anodized 7075 frame for the upper arms, thighs and pelvis.
- Bare fists with rubber knuckle bumpers (visual).

**Look**
- **Head:** a slim upright lozenge, taller than wide and canted slightly forward. One large round violet (#B58CFF) lens is offset to the left, with two small lenses stacked vertically on the right. A short antenna stub sits at the right rear.
- **Shells:** fluorescent lime (#C6F000) on a narrow chest, the pelvis, forearms and shins.
- **Structure:** exposed dark-anodized (#1C1D1F) upper-arm and thigh tubes.
- **Joints:** slim retroreflective silver bands (#C9CCD1) around every joint.
- **Feet:** long, narrow and black.
- **Decals:** number 11 down the right forearm and on the back.

**Fight style**
- A distance kicker and out-fighter. It keeps range with long front kicks and pokes the jab.
- It kicks the lead leg of anyone who steps in, and throws the head kick from a range nobody else can reach. Sprint resets distance.
- **Weaknesses:** the narrowest base and a high COM, so it spends the most gyro. It dislikes the clinch and body shots. It gets no clinch ability.

**Abilities:** jab, cross, front_kick, low_kick, head_kick, sprint.

---

### Ready-to-paste specs (existing builder, fallback kits)

`head` and `fist` use existing kits as fallbacks until the new kits in the next section exist. New motor ids are listed below.

```ts
export const FIRECRACKER = buildHumanoid({
  id: 'firecracker', name: 'FIRECRACKER',
  tagline: 'Thirty-eight kilos of fast hands, back up before the count starts.',
  scale: 0.667, bulk: 0.95, armor: 'polycarb', frame: 'al6061',
  motors: { leg: 'qdd.ak10', knee: 'qdd.rs04', arm: 'qdd.rs06', elbow: 'qdd.rs02', waist: 'qdd.rs03', neck: 'qdd.rs00' },
  fist: 'block', // → 'glove' (8-oz class)
  head: 'twin',  // → 'triplet' + headgear
  gyro: { maxTorqueNm: 50, momentumNms: 17, massKg: 2.3 },
  hydraulicArms: false, headBreakImpulseNs: 32, eyeColor: '#fff1dc',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'front_kick', 'low_kick', 'sprint'],
  defaultSkin: 'racing', // → new 'tangerine'
});
export const SAVATE = buildHumanoid({
  id: 'savate', name: 'SAVATE', tagline: 'A 450 N·m kickboxer. The shins are the weapon.',
  scale: 0.887, bulk: 0.92, armor: 'polycarb', frame: 'al7075',
  motors: { leg: 'plan.x12', knee: 'plan.x15', arm: 'qdd.rs04', elbow: 'qdd.rs03', waist: 'qdd.rs04', neck: 'servo.neck' },
  fist: 'block', head: 'twin', // → 'blade'
  gyro: { maxTorqueNm: 140, momentumNms: 49, massKg: 6.5 },
  hydraulicArms: false, headBreakImpulseNs: 45, eyeColor: '#9dffd6',
  abilities: ['jab', 'cross', 'hook', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'neon', // → new 'aubergine'
});
export const HAYMAKER = buildHumanoid({
  id: 'haymaker', name: 'HAYMAKER', tagline: 'The heaviest thing electric joints can carry. Every punch is thrown to end it.',
  scale: 0.933, bulk: 1.12, armor: 'uhmw', frame: 'al7075',
  motors: { leg: 'plan.x12', knee: 'plan.x15', arm: 'qdd.rs04', elbow: 'qdd.rs04', waist: 'plan.x12', neck: 'servo.neck' },
  fist: 'block', // → 'glove' (21-oz class)
  head: 'slit',  // → 'hammer'
  gyro: { maxTorqueNm: 195, momentumNms: 68, massKg: 9.1 },
  hydraulicArms: false, headBreakImpulseNs: 65, eyeColor: '#ff4d1a',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'overhand', 'low_kick', 'clinch'],
  defaultSkin: 'military',
});
export const PYLON = buildHumanoid({
  id: 'pylon', name: 'PYLON', tagline: "Six foot two of legs. It hits you from where you can't hit back.",
  scale: 0.97, bulk: 0.78, armor: 'carbon', frame: 'al7075',
  motors: { leg: 'plan.x12', knee: 'plan.x12', arm: 'qdd.rs03', elbow: 'qdd.rs06', waist: 'qdd.rs04', neck: 'qdd.rs00' },
  fist: 'block', head: 'dome', // → 'lozenge'
  gyro: { maxTorqueNm: 150, momentumNms: 51, massKg: 6.8 },
  hydraulicArms: false, headBreakImpulseNs: 40, eyeColor: '#b58cff',
  abilities: ['jab', 'cross', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'factory', // → new 'hivis'
});
```

Head-break values are starting points. Calibrate them with `npx tsx tools/fight-sim.ts <red> <blue>` so that p90 jabs and crosses stay under each threshold, while clean head kicks and overhands can clear it.

**Catalog entries to add** (`MOTORS` in `src/robots/catalog.ts`)

Torque, speed and mass are published. The thermal fields are my estimates, scaled from the existing RS04 and T800 entries (about 340 J/(kg·K)).

| id | name | stall N·m | no-load rad/s | kg | heat J/K | K/W | copper W | source |
|---|---|---|---|---|---|---|---|---|
| `qdd.rs00` | RobStride 00 | 14 | 33.0 | 0.31 | 120 | 2.2 | 120 | github.com/RobStride/Product_Information |
| `qdd.rs02` | RobStride 02 | 17 | 42.9 | 0.405 | 180 | 1.8 | 160 | same, and roboticscenter.ai (405 g) |
| `qdd.rs03` | RobStride 03 | 60 | 20.4 | 0.90 | 330 | 1.1 | 700 | same |
| `qdd.rs06` | RobStride 06 | 36 | 50.3 | 0.621 | 240 | 1.4 | 420 | robstride.com/products/robStride06 |
| `qdd.ak10` | CubeMars AK10-9 V3 | 53 | 33.5 | 0.96 | 360 | 1.2 | 600 | cubemars.com AK10-9 V3.0 KV60 |
| `plan.x12` | MyActuator RMD-X12-320 (20:1) | 320 | 13.1 | 2.37 | 800 | 0.6 | 2000 | openelab.io RMD-X12-P20 |
| `plan.x15` | MyActuator RMD-X15-450 (20.25:1) | 450 | 11.3 | 3.5 | 1100 | 0.5 | 2600 | openelab.io RMD-X15-P20 |

The `servo.neck` entry used to be the RobStride 02 at a made-up 12 rad/s; since the hardware pass (2026-10-20) it runs at the sheet's 410 rpm (42.9 rad/s) with the `qdd.rs02` thermal numbers. It stays a separate entry so its 0.41 kg (the 405 g rounded) keeps the iron-age bodies byte-identical.

### Builder gaps (optional; the specs above run without them)

1. **Glove kit.** Add `fist: 'glove'`: a larger striker (about 1.3× `fistHalf`), a foam/leather material, and a softer contact (solref about 0.015–0.02 s). Today the builder hard-codes the fist as AR500.
2. **New head kits.** `head.triplet` (with a headgear toggle), `head.blade`, `head.hammer` and `head.lozenge`. The existing four heads belong to the current roster.
3. **Three new skins.** `tangerine`, `aubergine` and `hivis`. Also a per-design race-number override: skins currently carry one fixed number.
4. **An `ankle` motor slot.** Built in the hardware pass (2026-10-20): `motors.ankle` (and an optional `ankleRoll`), sized about 1.5-2 N·m per kg of body; see the hardware-pass section at the top. Real ankles are about 45–60 N·m (H1: 45 N·m).
5. **An `armScale` parameter.** Builder arms are about 15% shorter than human arms at every scale.
6. **Per-design battery.** `gyro.ts` assumes one 1.2 kWh pack. A G1-class pack is about 0.45 kWh; the T800's is 71.4 V × 20 Ah ≈ 1.4 kWh.

### IP-safety rationale

- **Names.** FIRECRACKER, SAVATE (a French kickboxing art), HAYMAKER (a wild punch) and PYLON are common words.
  - A search turned up no combat robot or humanoid product with these names. "The Haymaker" appears only as the nickname for a weapon on the BattleBots robot Ziggy; it's a generic boxing term.
  - Avoided: every real robot, event and fighter name in the dossier (T800, White Eagle, Matador, Golden Flash, Rekbot and the rest), fiction marks (Terminator, Iron Man, Gundam, Real Steel's robots) and your existing roster names.
- **Heads.** None uses a real signature head:
  - no black dome with a halo ring
  - no elongated faceless helmet with a crescent
  - no sculpted human face
  - no single horizontal LED visor
  - no Iron-Man-style faceplate, no V-fin crest
  - no face mesh or cage (Real Steel's sparring robot Atom has one)
  - no round ring-light head (the electric Atlas)
- **Liveries.** Real fighters wore satin silver, all-black, gloss white/grey, gold chrome with silver, gunmetal with red, and black with gold. Ours are tangerine/graphite, aubergine/bone, olive/black and hi-vis lime/anodized/reflective silver.
- **Shells.** Pebble chest, faceted diamond chest, UHMW slabs and a lozenge head. None uses a box torso with orange ankle rods, or a round chest emblem.
- **Markings.** No logos and no wordmarks. Race numbers only (07, 21, 44, 11); no real event used number decals.
- **Generic elements, used on purpose.** Exposed actuator housings, corner-colour boxing gloves and padded headgear, foam shin guards and soled feet. These are generic to the category.
- **Real products stay out of the game.** They appear only as spec sources, in catalog `source` strings and docs; never in names, UI or art prompts. The art prompts contain no brand names and ask for no text. The existing catalog display name "T800-class 450 N·m joint" never reaches the UI today (the tale screen shows joint names). If motor names ever surface, rename it "450 N·m-class joint".
- **Not legal advice.** This is good-faith design distance on overall impression, not a legal opinion.

### Sources

- **Actuators**
  - [RobStride Product_Information](https://github.com/RobStride/Product_Information)
  - [RobStride 06](https://www.robstride.com/products/robStride06)
  - [RobStride 02 at roboticscenter.ai](https://www.roboticscenter.ai/store/product/robstride-02)
  - [RobStride 04 at OpenELAB](https://openelab.io/products/robstride04-qdd-120n-m-integrated-joint-motor-module)
  - [CubeMars AK10-9 V3](https://www.cubemars.com/product/ak10-9-v3-0-kv60-robotic-actuator.html)
  - [MyActuator X12-320](https://openelab.io/products/myactuator-rmd-x12-p20-actuator)
  - [MyActuator X15-450](https://openelab.io/products/myactuator-rmd-x15-p20-actuator)
- **Reference robots**
  - [Unitree H1 and M107 (360 N·m, 189 N·m/kg)](https://www.unitree.com/h1/)
  - [Unitree G1](https://www.unitree.com/g1/)
  - [Unitree H2](https://www.unitree.com/H2/)
  - [EngineAI T800](https://en.engineai.com.cn/product-t800)
- **Gyroscopes**
  - [Airbus CMG 15-45 S datasheet](https://www.airbus.com/sites/g/files/jlcbta136/files/2022-02/AVIONICS-CMG15-45-v5-2022.pdf)
  - [Seakeeper 1 (Panbo)](https://panbo.com/seakeeper-1-installed-on-the-water-and-stable/) and [Seakeeper 1 product page](https://www.seakeeper.com/seakeeper-products/seakeeper-1/)
  - [GyBAR (Sci Rep 2020)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7320159/)
  - [GyroPack (npj Robotics)](https://www.nature.com/articles/s44182-025-00041-4)
- **Gloves**
  - [Nakano, Iino, Kojima, ISBS 2009](https://ojs.ub.uni-konstanz.de/cpa/article/view/3427/3226)
- **Names**
  - [BattleBots Ziggy](https://battlebots.fandom.com/wiki/Ziggy)
- **Events and liveries:** see the research dossier's links (URKL, REK, CMG, WHRG, UFB, CyberHero).