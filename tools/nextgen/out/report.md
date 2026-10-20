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

**Crouched 180° pivot** over the left foot, welded where it sits at qpos0 (8 mm above the canvas, so the weld carries the weight and every tipping moment; the same COM law keeps the COM near it), 1.5 s, whole-body plan. Hip IK = the hip alone with the pelvis level; final = measured pelvis orientation error after the turn. CoP off sole = time (of 2.0 s) and worst distance the centre of pressure the turn needs lies outside the sole box, i.e. where a real, unwelded foot would roll; "pull" = the weld had to pull the foot down. Torques in this table are weld-assisted.

| Variant | 30° crouch: hip IK · final · turn | 50° crouch: hip IK · final · turn | Hip travel (P / R / Y) at 50° | Peak τ/stall (worst) | CoP off sole 30° / 50° |
| --- | --- | --- | --- | --- | --- |
| A | 99.1° · 79.5° · 133° | 110.0° · 87.5° · 104° | 59° / 28° / 70° | 1.00 (ankle_roll_l) | 1.26 s · pull / 1.32 s · pull |
| R | 0.0° · 1.4° · 180° | 0.0° · 1.5° · 180° | 45° / 27° / 180° | 0.81 (hip_roll_l) | 0.42 s · 48 cm / 0.40 s · 26 cm |
| M | 0.0° · 1.4° · 180° | 0.0° · 1.4° · 180° | 41° / 25° / 180° | 0.74 (knee_l) | 0.37 s · 12 cm / 0.38 s · 13 cm |
| O | 7.4° · 3.5° · 178° | 11.4° · 3.5° · 178° | 86° / 30° / 182° | 0.87 (knee_l) | 0.41 s · 14 cm / 0.54 s · 58 cm |
| P | 7.4° · 3.6° · 177° | 11.4° · 3.9° · 178° | 89° / 31° / 181° | 1.00 (ankle_roll_l) | 0.30 s · 7 cm / 0.47 s · 60 cm |
| P′ | 7.4° · 3.6° · 177° | 11.4° · 3.9° · 178° | 89° / 31° / 181° | 1.00 (ankle_roll_l) | 0.30 s · 7 cm / 0.47 s · 59 cm |
| P+ak | 7.4° · 3.8° · 177° | 11.4° · 3.9° · 177° | 88° / 30° / 181° | 0.78 (ankle_roll_l) | 0.33 s · 5 cm / 0.52 s · 32 cm |

**Get-ups, 5 seeds** (SAVATE's best mocap get-up clip through each variant's hip and ranges, eight playback numbers searched with the same budget, then the winner dropped 5 times). Time is from the first movement to the stand gate.

| Variant | Back: up · median · best | Face down: up · median · best | Peak τ/stall | Peak ω/ω₀ | Peak temp | Derate |
| --- | --- | --- | --- | --- | --- | --- |
| A | 5/5 · 3.14 s · 3.06 s | 5/5 · 2.50 s · 2.42 s | 1.00 | 0.61 | 34.5 °C | none |
| R | 4/5 · 3.52 s · 3.41 s | 3/5 · 3.35 s · 3.27 s | 1.00 | 1.02 | 39.8 °C | none |
| M | 5/5 · 4.64 s · 4.50 s | 5/5 · 2.85 s · 2.73 s | 1.00 | 0.54 | 35.1 °C | none |
| O | 5/5 · 4.53 s · 4.40 s | 4/5 · 2.56 s · 2.51 s | 1.00 | 0.69 | 37.2 °C | none |
| P | 5/5 · 4.30 s · 4.17 s | 5/5 · 2.57 s · 2.50 s | 1.00 | 0.53 | 35.9 °C | none |
| P′ | 5/5 · 3.85 s · 3.74 s | 4/5 · 2.74 s · 2.67 s | 1.00 | 0.59 | 38.7 °C | none |
| P+ak | 5/5 · 4.36 s · 4.06 s | 5/5 · 2.74 s · 2.65 s | 1.00 | 0.53 | 35.9 °C | none |
