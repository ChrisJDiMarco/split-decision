## How EngineAI's fighting humanoids are built

Research for the next generation of Split Decision fighters (proposal: `docs/design/next-gen-chassis.md`). This adds depth to `07-china-robot-fights.md` (events, rosters, league history) and `08-modern-roster.md` (our current four). It does not repeat them.

Evidence tags on every claim:
- **CONFIRMED**: a primary source (EngineAI's own site or files) or two independent sources.
- **REPORTED**: one secondary source.
- **INFERRED**: our reading of footage, renders or model files, or our own arithmetic. The text says what was looked at.

A fact-check pass re-derived every T800 joint number, axis, offset, range, torque, speed, armature and mass from EngineAI's own files. Claims it weakened are corrected below. Claims it could not check are marked **unverified**.

### The short version

1. **The best source is EngineAI's own GitHub, not its marketing.** EngineAI publishes machine-readable models of the T800: URDFs, a MuJoCo XML, the actuator classes its RL training uses, and the SDK configs for the parallel ankle and a trained get-up. CONFIRMED: [description README](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/README_EN.md), [T800 URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800/urdf/serial_t800.urdf), [rl_lab t800.py](https://github.com/engineai-robotics/engineai_rl_lab/blob/main/source/engineai_rl_lab/engineai_rl_lab/tasks/tracking/robots/t800.py), [SDK MJCF](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/resource/robot/t800/xml/serial_links.xml).
2. **The T800 hip is three separate drums in the order pelvis → pitch → roll → yaw.** Yaw comes last and turns the leg about its own thigh bone. Ours is the reverse: yaw → roll → pitch, all at one point, with yaw about the pelvis vertical.
3. **There are no extra leg joints.** Every T800 edition has 6 per leg, like ours. The "multiple joints along the leg" Chris saw are the three hip drums spread over about 19 cm, plus ranges far beyond human.
4. **EngineAI's published get-up is a tuck-and-squat, not a spin.** It takes about 1.6 s from first movement to standing. Hip yaw stays under 42°. The kip-up seen in Shanghai is not in the public SDK. The one clip that looks most like Chris's "twist and immediately upright" (a pelvis turn over planted feet) is handheld footage nobody has re-timed: **unverified** (section 6.2).
5. **The layout is not unique to EngineAI.** Unitree G1 and H2, Fourier GR-3, Booster T1 and EngineAI's own PM01 use the same pitch → roll → thigh-yaw order. Copying the mechanics copies an industry norm, not a signature design.
6. **Order and range do different jobs.** Compared at equal ranges, the pitch → roll → thigh-yaw order clearly wins only side kicks and high side kicks. Pivots and stance switches come from a wide yaw *range*, and in a crouch our yaw-first order pivots slightly better (section 5).

### 1. Sources and licences

| Repo | What it holds | Licence |
|---|---|---|
| [engineai_robotics_description](https://github.com/engineai-robotics/engineai_robotics_description) | URDFs: T800 v1.1 (25 DOF), T800 Pro 25-DOF (v1.1) and 43-DOF (v1.2), PM01 | **None listed** |
| [engineai_robotics_native_sdk](https://github.com/engineai-robotics/engineai_robotics_native_sdk) | T800 URDF and MJCF, parallel-ankle geometry, joint-to-motor transform, RL get-up and lie-down policies with their reference motions | BSD-3 |
| [engineai_rl_lab](https://github.com/engineai-robotics/engineai_rl_lab) | Isaac Lab actuator classes (torque, speed, armature) | BSD-3 |
| [GMR](https://github.com/engineai-robotics/GMR) | Motion retargeting: SMPL-X and LAFAN1 BVH to T800 configs, plus T800 meshes | MIT (the meshes are EngineAI's) |

Licences are CONFIRMED via the [GitHub API](https://api.github.com/repos/engineai-robotics/engineai_robotics_description).

- **Numbers only.** The description repo has no licence. GMR's MIT licence should not be read as covering EngineAI's meshes. The game uses only numbers as cited facts, never files or meshes.
- **Numbers agree across repos.** The README says the description files are "not yet synchronized" with rl_lab and the SDK. Even so, the leg joints match across the description URDF, the SDK URDF, the SDK MJCF and rl_lab. Hip yaw is −81.5° in both URDFs. CONFIRMED (fact-check).

### 2. Models and specs

| | T800 Basic / Open Source | T800 Pro | T800 Max | PM01 |
|---|---|---|---|---|
| Height | 173 cm | 173 cm | 173 cm | 140 cm (the home page says 138) |
| Mass | 75–85 kg by edition; the URDF totals 84.99 kg | URDF total 85.23 kg | not published | ~44 kg on the page; the URDF totals 40.9 kg |
| DOF | 25: neck 2, waist 1, arms 5 each, legs 6 each | 29 + 14 hand = 43 (the table's "neck 3" is likely a typo; the URDF has 2) | 32 + 14 = 46: neck 3, waist 3, arms 7, legs 6 | 24: legs 6 each, arms 5 each, waist 1, neck 1 |
| Leg length | 91 cm (thigh + shin) | same | same | — |
| Peak torque | 450 N·m headline; the model files cap joints at 415 | same | — | 164 N·m (the page also says "130 N·m peak"); 145 N·m/kg |
| Price | from 180,000 yuan (Chinese launch release) | — | — | — |

Sources: [T800 page](https://en.engineai.com.cn/product-t800.html), [Chinese T800 page](https://www.engineai.com.cn/product-t800) (29 DOF excluding hands, 6 per leg, 450 N·m, inner-rotor PMSM, crossed-roller bearings; no range table and no hip-arrangement detail), [Chinese launch release](https://www.engineai.com.cn/about-news-media/41.html), [Pro 43-DOF URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800pro/t800pro_43dof/urdf/serial_t800pro.urdf), [PM01 page](https://en.engineai.com.cn/product-pm01.html), [PM01 URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/pm01_edu/urdf/serial_pm01_edu.urdf). CONFIRMED. EngineAI contradicts itself in places, and those spots are noted in the table.

Other T800 facts:
- **Top speed** ≥2 m/s, hardware supported. CONFIRMED ([T800 page](https://en.engineai.com.cn/product-t800.html)).
- **Compute:** Orin NX 16G on Basic, or AGX Orin 64G, upgradable to Thor. CONFIRMED ([T800 page](https://en.engineai.com.cn/product-t800.html)).
- **Battery:** the spec table says 3–5 h lithium. The same page's body text and the launch release describe a solid-state pack: "up to 4 hours" on the page, 4–5 h in the release. CONFIRMED that EngineAI's sources are inconsistent.
- **Frame:** aviation aluminium plus titanium on the page. The launch release says magnesium-aluminium alloy with one-piece die casting. CONFIRMED ([page](https://en.engineai.com.cn/product-t800.html), [release](https://www.engineai.com.cn/about-news-media/41.html)). A trade e-paper repeats the Mg-Al frame and active cooling on all leg joints and adds nothing new. REPORTED ([CENA](https://epaper.cena.com.cn/pc/content/202602/06/content_16453.html)).

Other EngineAI robots:
- **Product list:** PM01, T800, SE01, JS01 (a quadruped) and S2 (a service robot); SA01 appears only under trending searches. CONFIRMED ([home](https://en.engineai.com.cn/)).
- **SE01:** 170 cm. Its page says EngineAI builds planetary, harmonic and linear joints in-house. CONFIRMED ([SE01](https://en.engineai.com.cn/product-se01.html)). Secondary mass and torque figures are unverified.
- **JS01:** 3 m/s with an 80 kg load. CONFIRMED ([JS01](https://en.engineai.com.cn/product-js01.html)).
- **Not found:** no combat edition, no newer 2026 humanoid, and no FA01 armour listing on EngineAI's own sites. FA01 appears only on urkl.org. REPORTED ([urkl.org/t800](https://urkl.org/t800)).

### 3. The leg: joint order, axes, placement, ranges

#### 3.1 Chain and geometry (left leg; the right mirrors it)

| # | Joint | Sits at (offset from previous joint, m) | Axis | Range | Torque / speed |
|---|---|---|---|---|---|
| J00 | Hip pitch | on the pelvis at y = +0.0792 | (0, 0.966, −0.259): sideways, tilted 15° outer-end-down | −190…+130° | 415 N·m / 25.96 rad/s |
| J01 | Hip roll | +0.0047 fwd, +0.0403 out, −0.1075 down | x (front-back) | −62…+118° | 370 / 25.31 |
| J02 | Hip yaw | +0.0095 fwd, −0.0805 down | z of the thigh = along the thigh bone | −81.5…+206.4° | 222 / 23.19 |
| J03 | Knee | −0.0377 back, −0.2879 down | y | 0…135° (MJCF −15…135) | 415 / 25.96 |
| J04 | Ankle pitch | −0.4387 down | y | ±39° | 160 / 33.51 |
| J05 | Ankle roll | −0.0379 down; sole 0.0645 below | x | −20…+10° | 160 / 33.51 |

CONFIRMED: [T800 URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800/urdf/serial_t800.urdf), [SDK model config](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/model/default.yaml) (same order), [rl_lab](https://github.com/engineai-robotics/engineai_rl_lab/blob/main/source/engineai_rl_lab/engineai_rl_lab/tasks/tracking/robots/t800.py). The fact-check re-derived every value.

- **The hip axes do not meet.** They are spread over 0.19 m vertically and 0.040 m sideways.
- **Leg lengths:** hip pitch to knee is 0.476 m and knee to ankle is 0.439 m, matching the published 91 cm leg.
- **Hip spacing:** the pitch joints are 15.8 cm apart; the yaw centres are 0.239 m apart.
- **Foot contact patch:** ±0.126 × ±0.054 m (about 25 × 11 cm), friction 0.8 ([SDK model config](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/model/default.yaml)).
- **Standing height in sim:** the pelvis sits at 1.06 m ([rl_lab](https://github.com/engineai-robotics/engineai_rl_lab/blob/main/source/engineai_rl_lab/engineai_rl_lab/tasks/tracking/robots/t800.py)).

All CONFIRMED.

**What the signs mean.** INFERRED, using right-hand-rule rotations on the URDF axes, checked by the fact-check:
- Negative hip pitch swings the thigh forward (flexion).
- Positive roll swings the leg outward (abduction).
- Positive yaw turns the toes out (external rotation).

So on paper the hip reaches 190° of flexion, 130° of extension, 118° of abduction and 206° of external rotation. These are software limits. EngineAI's RL training turns self-collision off (`enabled_self_collisions=False` in [rl_lab](https://github.com/engineai-robotics/engineai_rl_lab/blob/main/source/engineai_rl_lab/engineai_rl_lab/tasks/tracking/robots/t800.py)), so the shells will stop the leg before the extremes.

**T800 Pro differs** (Pro 25-DOF v1.1 and 43-DOF v1.2 URDFs):
- Hip pitch −165…125°, roll −15…100°, yaw −81…223°.
- Knee −15…135°, torso yaw ±161°.

The geometry is the same to within 1 mm. CONFIRMED ([Pro 25-DOF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800pro/t800pro_25dof/urdf/serial_t800pro.urdf), [Pro 43-DOF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800pro/t800pro_43dof/urdf/serial_t800pro.urdf)).

**Brochure ranges.** Two spec aggregators quote a brochure range table with the same hip and waist numbers: hip R −118~62, P −190~130, Y −81~206; waist Y −251~71. They differ from the URDF in two places: knee −15…135 and ankle roll ±15. CONFIRMED ([pconline](https://product.pconline.com.cn/robot/engineai/2773159_detail.html), [robotlar](https://www.robotlar.org/en/humanoid-robots/engineai-t800)). Neither EngineAI's English nor its Chinese product page has a range table ([EN](https://en.engineai.com.cn/product-t800.html), [CN](https://www.engineai.com.cn/product-t800)).

**Which edition fights.** Unknown which edition's ranges URKL robots actually run.

#### 3.2 The rest of the body (T800 v1.1)

- **Torso yaw:** −251…+71°, 322° in total, at 222 N·m. The Basic edition has no waist pitch.
- **Head:** pitch ±30°, yaw ±70°.
- **Shoulder:** pitch −170…+160°, roll −22…+140°, yaw ±150°.
- **Elbow:** pitch −131…+15°, plus elbow yaw (forearm twist) ±150°.
- **Pro only:** wrist pitch ±25° and wrist roll −60…35°, both 5 N·m.

CONFIRMED ([T800 URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800/urdf/serial_t800.urdf), [Pro 43-DOF URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800pro/t800pro_43dof/urdf/serial_t800pro.urdf)).

**Max edition** (3-DOF waist and neck): no model file is published, so its extra axes are unknown.

#### 3.3 What Chris saw in the renders

We cropped the hip regions of the two official renders (3.png, high side kick; 4.png, standing). INFERRED; the fact-check agrees.

- **Where the leg meets the pelvis:** a vented, finned drum running sideways into the pelvis. This is **hip pitch**.
- **Just below it, on the upper-outer thigh:** a grey disc cap with a single line mark. In the standing render both discs read as full circles from the front, so their axes run front to back. This is **hip roll**. It is the "second drum turned another way" Chris noticed.
- **Hip yaw** is hidden inside the thigh shell about 8 cm lower. In 3.png a ring seam under the disc marks where the thigh turns.
- **Knee:** a large side-facing disc.

Chris's reading is right. An earlier reading in one sweep had pitch and roll swapped; the forward-facing discs settle it.

**The high side kick in 3.png.** The kicking leg is rolled far out, the torso leans back and the support leg is slightly bent. A grid search, capped at 120° of hip flexion to respect the shell, puts this pose at about roll 118° and yaw −81°: both at their limits, with the thigh turned in so the heel leads. INFERRED (fact-check re-run of `scratchpad/cnangle/poses.py`). Torso rotation could also explain part of what the render shows.

#### 3.4 Actuators

EngineAI's training config names five in-house joint-module classes. CONFIRMED: [rl_lab t800.py](https://github.com/engineai-robotics/engineai_rl_lab/blob/main/source/engineai_rl_lab/engineai_rl_lab/tasks/tracking/robots/t800.py), matched by `actuatorfrcrange` and `armature` in the [SDK MJCF](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/resource/robot/t800/xml/serial_links.xml).

| Class | Joints | Count | Torque | Speed | Reflected armature |
|---|---|---|---|---|---|
| Q300HL | hip pitch, knee | 4 | 415 N·m | 25.96 rad/s | 0.2427 kg·m² |
| Q300H | hip roll | 2 | 370 | 25.31 | 0.1411 |
| Q200H | hip yaw, waist yaw | 3 | 222 | 23.19 | 0.0449 |
| Q50H | ankle pitch/roll, shoulder ×3, elbow pitch | 12 | 160 | 33.51 | 0.0355 |
| Q25H | elbow yaw, head ×2 | 4 | 52 | 35.2 | 0.0067 |

The 25 motors match the 25 DOF.

**Torque caps**
- The simulator runs hip pitch and knee at 0.95 × 415 N·m.
- The get-up config caps total lower-body torque at 1,700 N·m across the 12 leg joints ([supine_to_stance config](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/rl_supine_to_stance/default.yaml)).

All CONFIRMED.

**What is not published**
- Gear ratios, module masses, gearbox stage counts, and any Q-series datasheet.
- Why the headline says 450 N·m when every model file stops at 415.

**What the page and press say**
- The product page names an inner-rotor PMSM with crossed-roller output bearings, "super air-cooled" cooling, and active cooling on all leg joints. The launch release claims 14,000 W of instantaneous joint power. CONFIRMED ([page](https://en.engineai.com.cn/product-t800.html), [release](https://www.engineai.com.cn/about-news-media/41.html)).
- The press says the hip and waist use planetary modules. REPORTED ([ifanr](https://www.ifanr.com/1647002)).
- **Linear-actuator claim, contradicted.** ifanr also says the knee and ankle use linear actuators. EngineAI's own files contradict this: the knee is the same rotary Q300HL as hip pitch, with no linkage group. The ankle is two rotary motors driving cranks and rods (section 3.5). REPORTED claim; the files are CONFIRMED.
- **Linear capability is real but unconnected.** EngineAI (深圳市众擎机器人科技有限公司) holds two ball-screw linear-joint patents. Neither names a robot model:
  - [CN222472556U](https://patents.google.com/patent/CN222472556U/zh): a "power module" with the nut built into the inner rotor, plus a strain gauge. Filed 2024-03-02, published 2025-02-14; inventors include founder 赵同阳. CONFIRMED (primary).
  - [CN119927891A](https://patents.google.com/patent/CN119927891A/zh), "a linear joint and humanoid robot": the screw sits inside the rotor back-iron cavity, a recirculating ball nut drives it, and a ball spline guides the push rod. It is aimed at limbs that need explosive power, wrists and ankles included. Published 2025-05-06. CONFIRMED (primary). This may be where ifanr's "linear knee and ankle" claim comes from. The T800 files still show a rotary knee and a rotary crank-and-rod ankle.
- **Other patent.** [CN120038784A](https://patents.google.com/patent/CN120038784A/zh) is a *finger* joint: a frameless micro motor with multi-stage planetary reduction and a magnetic encoder. Filed 2025-04-23, published 2025-05-27, no torque value, no robot named. CONFIRMED (primary). A secondary patent write-up ([aibangbots](https://www.aibangbots.com/a/6047)) calls it the 450 N·m three-stage planetary joint in the T800 and SE01. The patent says nothing of the kind, so don't cite that write-up.
- **Not found:** any EngineAI patent on hip layout, leg structure, fall protection or get-up hardware. The Google Patents assignee listing did not render, so this search is not exhaustive.

#### 3.5 The parallel ankle (the only linkage in the leg)

The T800 SDK turns on its parallel converter and declares the ankles as the only parallel groups. CONFIRMED ([transform runner](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/joint_motor_transform_runner/default.yaml), [model config](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/model/default.yaml)). The geometry comes from the [parallel_ankle config](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/parallel_ankle/default.yaml) (CONFIRMED):
- Two motors sit on the shin, 0.196 m and 0.278 m above the ankle.
- Each turns a 32.5 mm crank.
- The cranks push rods of 0.204 m and 0.288 m.
- The rods attach to the foot at ±25.5 mm.
- A small neural net maps joint angles to motor angles.

So the "serial" URDF is a joint-space stand-in: the ankle motors really ride high on the shin. The knee and hip are serial rotary joints in every model. Their gearbox type is not published.

#### 3.6 Where the mass sits

Link masses from the [URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/t800/urdf/serial_t800.urdf) (CONFIRMED):

| Link | Mass |
|---|---|
| Pelvis | 10.15 kg |
| Hip-pitch link | 3.54 kg |
| Hip-roll link | 0.85 kg |
| Thigh | 7.19 kg, centre of mass 0.176 m below the yaw joint |
| Shin | 6.00 kg |
| Ankle cross | 0.14 kg |
| Foot | 1.49 kg |
| Torso | 19.41 kg |
| Each arm | ~7.3 kg |
| Head | 2.4 kg |

Each leg is 19.2 kg; the two legs are 38.4 kg, 45% of 85 kg.

Reading mass against the mesh bounding boxes in [GMR's meshes](https://github.com/engineai-robotics/GMR/tree/main/assets/engineai_t800/meshes) (INFERRED):
- **Hip-pitch motor:** in the pelvis side.
- **Hip-roll motor:** on the 3.54 kg pitch link, whose mesh encloses the roll joint. This keeps swing inertia low.
- **Hip-yaw motor:** at the top of the 7.19 kg thigh. The 0.85 kg roll link is only a bracket, too light to hold a motor.
- **Ankle motors:** in the 6.0 kg shin, which keeps the foot at 1.5 kg.
- **Knee stator:** could be in either the thigh or the shin. The two meshes overlap about 7 cm around the knee axis, so the files don't settle it.

**Heavy thigh.** A 7.2 kg thigh is normal for a full-size robot: Unitree H2's is 7.09 kg ([H2 URDF](https://raw.githubusercontent.com/unitreerobotics/unitree_ros/master/robots/h2_description/H2.urdf)). The G1's 1.70 kg thigh belongs to a 35 kg robot ([G1 URDF](https://github.com/unitreerobotics/unitree_ros/blob/master/robots/g1_description/g1_29dof.urdf)). CONFIRMED.

### 4. Our hip versus theirs

Both are CONFIRMED from `src/robots/humanoid.ts` (lines ~121–125 and ~276–282) and the `src/physics/control/ik.ts` header.

| | Split Decision (iron and modern) | T800 |
|---|---|---|
| Order, pelvis outward | yaw (z) → roll (x) → pitch (y) | pitch (tilted 15°) → roll (x) → yaw (along thigh) |
| Placement | all three hinges on the thigh body at one point | three bodies, spread 0.19 m down and 0.04 m out |
| What "yaw" does with the thigh raised | swings the thigh sideways about the pelvis vertical | twists the leg about its own long axis |
| Motors | `spec.motors.leg` drives all three hips and both ankles | graded: 415 / 370 / 222 N·m, ankles 160 |
| Motor mass | added to the body declaring the joint: all hip motors at mid-thigh, both ankle motors in the foot | pitch in pelvis, roll on the pitch link, yaw at the top of the thigh, ankle motors high on the shin |
| Modern ranges (left) | yaw −45…70, roll −35…70, pitch −145…35, knee 0…150, ankle ±60 / ±40 | yaw −81…206, roll −62…118, pitch −190…130, knee 0…135, ankle ±39 / −20…10 |
| Iron ranges (left) | yaw ±40, roll −20…45, pitch −135…35 | — |
| Waist | yaw ±90 plus pitch −35…80 | yaw only, −251…71 |
| Gimbal lock | roll ±90° (outside our 70° cap) | roll +75° at any pitch, inside the 118° range |
| Armature | 0.02 + 0.01 × motor mass (≈0.05 kg·m² for a 2.9 kg drive) | per class, 0.007–0.243 kg·m² |

**Armature gap.** EngineAI's hip-pitch and knee armature is about 5× what our formula gives a comparable drive. Our fighters may be snappier at those joints than real hardware would be. INFERRED (arithmetic on the two sources above).

### 5. What the layout buys, and what it costs

#### Buys (all INFERRED from the URDF geometry)

**Method.** A 2° grid search finds the hip angles that best match a target thigh direction plus knee-axis direction, with the pelvis upright. The error is thigh-direction error plus knee-axis error. These are static poses only: no path, torque or collision. Scripts are in the session scratchpad: `cnangle/poses.py` (first pass), `critic/poses_eqrange150.py` (equal ranges), `writer/cp2.py` (crouched pivots). We re-ran all three for this doc.

**Order and range have to be separated.** The first pass compared the T800 at its huge ranges with ours at our small ones, which mixes two effects. The fair test gives both orders the same ranges: the NEXT GEN proposal in `next-gen-chassis.md` §3 (pitch −150…60, roll −30…110, yaw −80…180).

| Target pose | T800 (flexion capped at 120°) | Tilted pitch→roll→yaw, equal ranges | Our yaw→roll→pitch, equal ranges | Ours today (modern ranges) |
|---|---|---|---|---|
| Side kick (thigh straight out, knee axis front-back) | 4.5° | **5.1°** | 41.3° | 94° |
| High side kick (thigh 30° above horizontal) | 10.1° | **16.8°** | 70.8° | 123° |
| Roundhouse turnover (thigh 45° out-forward, shin horizontal) | 5.0° (odd pose: P +74, R 118, Y 69) | 19.4° | **1.0°** (odd pose: P −150, R 90, Y 106) | 22° |
| Back kick (thigh 45° behind) | 1.0° | 1.3° | 1.0° | 11.4° |
| Front-kick chamber | 2.0° | 2.4° | 0.0° | 2.8° |
| Deep tuck (150° flexion) | 29.9° (capped) | 1.3° | 0.0° | 6.4° |
| Straight-leg pivot, 90° and 180° | 1° | 0° | 0° | 22° / 112° |

A first pass reported 1° fits for the T800 side kicks. Those used hip pitch −180°, swinging the thigh over the top, which the shell can't do.

**What that means:**
- **Side kicks are the real win for the order.** A raised thigh turned out sideways with the knee axis front-to-back needs roll near 90–110° plus inward thigh yaw (heel leads). Our pelvis-vertical yaw can't turn a raised thigh about its own length, so ours misses by 41–71° even with wide ranges and has to fake the kick with torso lean.
- **Roundhouse turnover is not a clean win either way.** Both best fits are awkward poses near a gimbal lock. The static test can't tell which order gives the better *path* from chamber to turnover; only a physics test can.
- **Pivots come from yaw range, not order.** With a straight leg both orders pivot perfectly once yaw reaches 180°. In a fighting crouch, turning the pelvis over a planted foot (thigh flexed, foot fixed, external direction):

  | Crouch pivot | Tilted pitch→roll→yaw, equal ranges | Our yaw→roll→pitch, equal ranges | Ours today |
  |---|---|---|---|
  | 30° flexion, 90° turn | 0.0° (moves P, R and Y) | 0.0° (yaw only) | 24.6° |
  | 30° flexion, 180° turn | 8.3° | 0.0° | 109° |
  | 50° flexion, 90° turn | 0.0° (R 50°) | 0.0° (yaw only) | 31.0° |
  | 50° flexion, 180° turn | 12.6° | 0.0° | 105° |

  Pelvis-vertical yaw is the natural pivot joint: it does the whole turn alone. The thigh-yaw order has to swing all three hip joints and still misses at 180°. The T800's advantage over our current fighters here comes entirely from its 288° yaw travel against our 115°.
- **Chamber, back kick and tuck are a wash** at equal ranges.

The 322° waist adds spinning attacks on top of whatever the hips do.
- **The 15° pitch tilt.** Pure hip flexion carries the knee outward: 14.5° at 90° of flexion and 26.6° at 142°. The knee clears the belly and the other leg in a tuck or chamber. The tilt also packs two big pitch drums into a 15.8 cm hip span.
- **Holding the leg up is cheap relative to the caps.**
  - Hip pitch holding the straight 19.2 kg leg horizontal needs about 86 N·m (centre of mass ~0.46 m out).
  - Hip roll holding the leg out sideways needs about 66 N·m (15.7 kg distal to roll).
  - Both sit far below the 415 and 370 N·m caps. A sweep's earlier "85 N·m for roll" was the pitch figure.

#### Costs (INFERRED)

- **Singularity inside the fighting range.** The tilted pitch axis and the thigh-yaw axis line up at roll = +75°, at any pitch. The base T800's roll range (to 118°) passes through it, and the high side kick sits near it. Even standing neutral, the hip Jacobian's smallest singular value is 0.86, not 1.0. The controller needs damped IK there. Our hip locks at roll 90°, which our 70° cap never reaches.
- **Yaw is the weakest big joint** at 222 N·m, and it carries the twisting load in pivots.
- **Offsets mean no closed-form IK.** The hip centre moves as pitch changes, so there is no simple closed-form IK. Retargeting needs numerical IK per layout.
- **Small ankle.** ±39° pitch and −20…+10° roll, against our modern ±60 / ±40. Balance leans on the hips.
- **Big armature on the big joints** (0.243 kg·m² on hip pitch and knee). Kicks land hard but reverse slowly, and impacts back-drive poorly.
- **Wiring.** 288° of yaw travel is less than one turn, so a cable wrap through a hollow shaft is enough. A slip ring is only needed for continuous rotation, which the T800 does not have.
- **Collisions.** The URDF limits exceed what the shell allows, so any copy needs collision-aware clamps.

### 6. Get-ups, joint by joint

#### 6.1 What EngineAI ships: supine-to-stand

The T800 SDK ships two RL "mimic" skills: `rl_supine_to_stance`, and `rl_stance_to_supine`, a controlled lie-down for fall protection. CONFIRMED ([supine_to_stance](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/rl_supine_to_stance/default.yaml), [stance_to_supine](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/rl_stance_to_supine/default.yaml), [task_motion](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/task_motion/default.yaml)).

- **What the policy is:** a residual policy that tracks a 30 fps reference motion.
- **Rates:** it runs every 0.01 s (100 Hz). The underlying PD loop rate is not confirmed; 0.002 s is the period of other tasks.
- **Inputs:** 25 joint positions, 25 velocities and 25 previous actions, plus body angular velocity, gravity and yaw.
- **PD gains:** kp 280 at hip pitch and knee, 95 at hip roll, 34 at hip yaw.
- **Trigger:** a gamepad combo (START + CROSS_X_UP). When it finishes, it hands over to walking automatically.

**Reading the reference file.** The file is [T800_supine_to_stance.npy](https://github.com/engineai-robotics/engineai_robotics_native_sdk/blob/main/assets/config/t800/rl_supine_to_stance/trajectory/T800_supine_to_stance.npy): 197 frames × 34 channels, holding root position, quaternion, 25 joints and 2 contact flags. It was loaded in memory only. **Frames 0–90 are a lie-down.** The config's `traj_frame: [90, 180]` selects the get-up, so anyone reusing the file must slice it. Timeline of frames 90–180 (INFERRED from the data; the fact-check reproduced every number):

| Time in window | What moves |
|---|---|
| 0–0.7 s | Lies still on its back |
| Tuck | Hip pitch to −142° (left) / −141° (right); both knees to the 135° stop. Feet come under the hips |
| Roll to one side | Uneven hips: right roll +39°, right yaw +41°, left roll −26°. The body tips onto one side |
| Push | Right arm plants and pushes: shoulder pitch +89°, elbow −108° |
| Rise | Pelvis on the floor until 1.5 s; 0.51 m at 2.0 s; 1.05 m (standing) at 2.33 s |

- **Timing:** about 1.6 s from first movement to standing, and 0.83 s from pelvis lift to full height.
- **Peak speeds:** legs 3–10 rad/s (knee ~10, hip pitch ~6.9); right shoulder 12.8 rad/s. All are well under the 23–35 rad/s limits.
- **Other extremes stay small:** hip yaw peaks at 42°, waist yaw at 12°, hip extension at 5°.

**So the published fast rise is a deep tuck and a squat-up powered by the 415 N·m hips and knees, with a one-sided roll/yaw and an arm push.** It is not a big-yaw twist. The huge yaw and waist ranges make other get-ups possible, but this one doesn't need them. INFERRED. (One sweep put the tuck at 145–155° of hip flexion; those numbers came from the lie-down frames.)

#### 6.2 What footage shows (not in the public SDK)

One sweep timed these from continuous footage in its own browser tab. The fact-check did not re-time them. All are INFERRED and **unverified**.

| Clip | Move | Time | Joint reading |
|---|---|---|---|
| [Guangdong TV, Shanghai](https://news.qq.com/rain/a/20260919V0ACXO00) | Forward fall, "sprawl-tuck" | ~0.7 s, hands on the mat to guard. The on-screen clock suggests real speed | Catches on its hands, whips both thighs from trailing to under its chest (hips from ~0° to >110° in ~0.2 s), deep squat, stand |
| [Shanghai repost](https://www.bilibili.com/video/BV1qHeq6pEro/) | Kip-up | ~1.2–1.4 s, leg swing to standing | Rolls onto its shoulders with its legs straight up ("candlestick"), whips the legs down, lands in a deep squat. Arms are thrown forward for momentum |
| [REK repost](https://www.bilibili.com/video/BV1rWh16GEJp/) | Kip-up, straddle landing | ~1.6 s | Legs come down spread wide into a sumo squat. The thighs are swung out ~40–50° each and turned outward, knees pointing sideways: big roll plus external yaw |
| [June internal test, headless](https://www.youtube.com/watch?v=Q3aeNltYTa0) | Get-up with a pelvis turn | ~2–2.6 s | Legs land one ahead of the other. The pelvis appears to turn ≥90° over the planted feet as it rises. This is the closest match to Chris's "twist and immediately upright", but the camera is handheld |
| [Fan video, Shanghai](https://www.youtube.com/watch?v=GTSXcCs-SJE) | Kip-up, partly hidden | ~0.7 s, leg lift to upright | Blocked by the other robot |

- **The kip-up is new.** It debuted in Shanghai on 19 September 2026, described as a back bridge with hands and feet pushing ("腰背过桥、手脚借力"). CONFIRMED ([chinanews](https://www.chinanews.com.cn/cj/2026/09-20/10700244.shtml)). The kip-up policy is not published.
- **Edited reels can't be timed.** EngineAI's official Shenzhen highlight reel cuts straight from lying to standing ([YouTube](https://www.youtube.com/watch?v=XtggY9LRISw), unverified). Only continuous footage can be used for timing.
- **Nothing beyond human in these clips.** No reversed knees and no thigh or shin spinning beyond human range. What stands out is extreme hip flexion, wide roll with outward yaw, full knee bend, and speed. INFERRED.

**Answer to Chris's question.** The "twist and immediately upright" does not come from a special joint. It comes from:
- a full tuck (hip pitch around 140°, knees at 135°), driven by 415 N·m hip-pitch and knee drives;
- a one-sided hip roll and yaw that tips the body onto a side;
- an arm push;
- in the flashier versions, a leg whip or a pelvis turn over the planted feet (unverified footage).

We found no evidence that the hip *order* is what makes these fast. The published get-up keeps hip yaw under 42°, and the crouch-pivot fits above show a yaw-first hip re-orients a planted leg at least as well. What the T800 does have is strong, fast hip-pitch and knee drives and wide yaw range. INFERRED.

**Better footage exists but was not examined.** EngineAI released multi-angle footage of a T800 kicking CEO Zhao Tongyang in December 2025 to rebut CGI claims. REPORTED ([Interesting Engineering](https://interestingengineering.com/ai-robotics/engineai-t800-humanoid-robot-kicks-ceo)). EngineAI's own Bilibili and Douyin uploads of the Shanghai kip-up were not examined either. Stepping one continuous official clip frame by frame, at a known frame rate, is the way to settle the pelvis-turn get-up.

**No founder interview found.** We found no interview in which EngineAI explains its joint-design choices. Chinese long-form outlets (36kr, LatePost, Zhihu) were not searched; Zhihu returned 403 in an earlier sweep.

#### 6.3 How fast other robots get up

| Robot | Method | Time | Source |
|---|---|---|---|
| Booster T1 (1.18 m) | HiFAR learned policy | 2.71 ± 0.32 s supine, 2.88 ± 0.47 s prone, 20/20 real trials each | [arXiv 2502.20061](https://arxiv.org/html/2502.20061v2), CONFIRMED |
| Unitree G1 (35 kg) | HumanUP | ~6 s vs ~11 s for Unitree's own controller; 78.3% supine success vs 41.7%. From face-down it rolls to its back first | [arXiv 2502.12152](https://arxiv.org/html/2502.12152v2), CONFIRMED |
| G1, H1, H1-2 | HoST | 100% real-world success on 4 terrains. Style rewards penalise big waist yaw and hip roll/yaw | [arXiv 2502.08378](https://arxiv.org/html/2502.08378v2), REPORTED (bounds not re-checked) |
| T800 | EngineAI reference | ~1.6 s supine | section 6.1 |

### 7. Flashy moves, joint by joint (INFERRED unless tagged)

- **High side kick (render 3.png).** Lean the torso back; hip roll near its limit; yaw turned in so the heel leads; support knee soft. It sits near the roll-75° singularity, so the controller must lean the torso to reduce the abduction it needs.
- **Roundhouse.** Chamber with pitch plus knee. Roll opens the gate. Thigh yaw turns the knee over. The support foot pivots on hip yaw.
- **Spinning kicks and stance switches.** Hip yaw over a planted foot (up to ~180°) plus 322° of waist yaw. There are no toe joints, so the support foot has to slide or skip. What makes this possible is yaw *range*; a yaw-first hip with the same range pivots at least as well (section 5).
- **Flying knee.** Chinanews says the flying knee ran from a motion library, and that robots entered the cage by themselves, read the opponent's pose and chose actions. REPORTED ([chinanews](https://www.chinanews.com.cn/cj/2026/09-20/10700244.shtml)). The same split exists in our game: Jev picks the move and a lower layer runs it. Shenzhen coverage says the line between teleoperation and autonomy was unclear (REPORTED, [leikeji](https://www.leikeji.com/article/78025)).
- **Fight texture.** Mostly kicks, many misses, balance lost after kicks, double knockdowns followed by a kip-up. REPORTED ([QQ](https://news.qq.com/rain/a/20260716A0CI8U00); fan footage unverified).

### 8. What breaks in fights

- **Heads and necks fail most.** In Shanghai a T800 fought on with severe head and neck damage until the head came off. CONFIRMED ([chinanews](https://www.chinanews.com.cn/cj/2026/09-20/10700244.shtml)).
- **Other head losses.** Matador's decapitation in Shenzhen, a robot knocking its own head off, and a headless test robot still getting up. REPORTED or unverified ([TechEBlog](https://www.techeblog.com/urkl-mma-robot-fight/), [fan video](https://www.youtube.com/watch?v=GTSXcCs-SJE), [June test](https://www.youtube.com/watch?v=Q3aeNltYTa0)).
- **Joint-feedback faults** (关节反馈异常), with the drives running on until the final fall. CONFIRMED ([chinanews](https://www.chinanews.com.cn/cj/2026/09-20/10700244.shtml)).
- **Self-inflicted falls** after missed kicks and flying kicks. REPORTED ([QQ](https://news.qq.com/rain/a/20260716A0CI8U00)).
- **A robot carried out on a stretcher** in Shenzhen after losing motor function. REPORTED ([leikeji](https://www.leikeji.com/article/78025)).
- **Repairs and swaps between rounds; robots that "drop dead randomly".** Unverified; from one fan video ([YouTube](https://www.youtube.com/watch?v=GTSXcCs-SJE)).
- **No reports of hands, ankles or feet breaking off.**
- **What they wear.** URKL robots fight in stock shells in team colours, bare-fisted, with no visible foam armour. REK's T800 wears Terminator-style skull covers. INFERRED from footage, unverified.

**Design lesson for us:** the neck is the weak link on real fighters. Our head-break impulse model already treats it that way (`08-modern-roster.md`).

### 9. URKL rules that shape the design

| Rule | Status | Source |
|---|---|---|
| Autonomous recovery from both prone and supine: 15 / 10 / 5 / 0 points for 0–3 / 3–10 / 10–20 / >20 s, inside an 8 m circle, with a forced joint reset and no human help | CONFIRMED | [rulebook](https://en.engineai.com.cn/tournament-rule-detailed.html) |
| Qualifier strikes: straight punch, hook and front kick up to 6 points, sweeping kick up to 12; these are rank-placement points (1st and 2nd get the maximum), over 6 s rounds from a 3 m start | CONFIRMED | [rulebook](https://en.engineai.com.cn/tournament-rule-detailed.html) |
| One platform: stock T800 for every team. "Dangerous modifications and malicious attacks are strictly prohibited." A secondary-development proposal is required; teams of 3–10 with a Lead Operator | CONFIRMED | [rules](https://en.engineai.com.cn/tournament-rules.html) |
| Core power and sensor hardware may not be changed | REPORTED (one syndicated release) | [21jingji](https://www.21jingji.com/article/20260716/herald/9520d67f01e46d0a14da51abca0f2e6d.html) |
| Teams are encouraged to build their own armour; FA01 foam armour is optional | REPORTED | [urkl.org/t800](https://urkl.org/t800) |
| A fallen robot must stand within 10 s or lose by KO | REPORTED. The two outlets carry the same press release, and it conflicts with the rulebook's 20 s scoring window (a skills test, not a match rule) | [21jingji](https://www.21jingji.com/article/20260716/herald/9520d67f01e46d0a14da51abca0f2e6d.html), [stnn](https://m.stnn.cc/detail/6a58e0854ee52f714405f4b7.html) |
| Judging on effective attack, dynamic stability, defence and evasion, and whole-robot durability | REPORTED (same release) | [21jingji](https://www.21jingji.com/article/20260716/herald/9520d67f01e46d0a14da51abca0f2e6d.html) |
| 3 tactical timeouts per team, ≤2 min each, at most one per round | REPORTED (second source not opened) | [leikeji](https://www.leikeji.com/article/78025) |
| Format: the Shenzhen gala ran 5 × 5-min rounds. Bracket matches are best-of-3 with double round-robin groups and double-elimination finals | CONFIRMED (sources disagree by event) | [leikeji](https://www.leikeji.com/article/78025), [21jingji](https://www.21jingji.com/article/20260716/herald/9520d67f01e46d0a14da51abca0f2e6d.html), [rulebook](https://en.engineai.com.cn/tournament-rule-detailed.html) |
| Two manual resets per match | Unverified | [YouTube](https://www.youtube.com/watch?v=Q3aeNltYTa0) |

What these rules push the hardware toward (INFERRED):
- a sub-3 s self-righting skill from both sides;
- kicks worth more than punches;
- durability as a scored dimension;
- no weight classes, because everyone fights on the one stock body.

### 10. Comparables using the same tricks

All figures come from each maker's URDF and are CONFIRMED by the fact-check unless tagged.

| Robot | Hip order | Tilt | Yaw below roll | Key ranges | Torque (N·m) |
|---|---|---|---|---|---|
| EngineAI T800 | pitch → roll → yaw | pitch axis 15° | 81 mm | P −190…130, R −62…118, Y −81…206 | 415 / 370 / 222 |
| EngineAI PM01 | pitch → roll → yaw | pitch axis 15° | — | P −180…140, R −25…120, Y −90…230; waist −230…90 | 164 (P, R, knee), 61 (Y, ankle, waist) |
| Unitree G1 | pitch → roll → yaw | roll and knee frames 10° about y | 124 mm | P −145…165, R −30…170, Y ±158, knee −5…165 | 88 (hips), 139 (knee) |
| Unitree H2 | pitch → roll → yaw | pitch frame 30° | 74 mm | P −141…159, R −27…124, Y ±162, knee −5…145 | 360 at 20 rad/s |
| Fourier GR-3 | pitch → roll → yaw | pitch axis 5° | 93 mm | P ±150, R −10…90, Y −40…90, knee 0…135 | 366 (P) at only 6.49 rad/s; 140 (R, Y) |
| Booster T1 | pitch → roll → yaw | — | 82 mm | P −103…90, R −11…90, Y ±57 | — |
| Unitree H1 (older) | yaw → roll → pitch (like ours) | — | — | yaw ±25, pitch −180…145 | — |
| Unitree H1-2 (older) | yaw → pitch → roll | — | — | roll −25…180 | — |

Sources: [PM01 URDF](https://github.com/engineai-robotics/engineai_robotics_description/blob/master/pm01_edu/urdf/serial_pm01_edu.urdf), [G1](https://github.com/unitreerobotics/unitree_ros/blob/master/robots/g1_description/g1_29dof.urdf), [H2](https://raw.githubusercontent.com/unitreerobotics/unitree_ros/master/robots/h2_description/H2.urdf), [GR-3](https://raw.githubusercontent.com/FFTAI/Wiki-GRx-Models/master/GRX/GR3/gr3v2_1_1/basic_urdf/gr3v2_1_1.urdf), [T1](https://raw.githubusercontent.com/BoosterRobotics/booster_gym/main/resources/T1/T1_serial.urdf), [H1](https://raw.githubusercontent.com/unitreerobotics/unitree_ros/master/robots/h1_description/urdf/h1.urdf), [H1-2](https://raw.githubusercontent.com/unitreerobotics/unitree_ros/master/robots/h1_2_description/h1_2.urdf).

- **Pitch → roll → thigh-yaw is the 2025–26 norm.** Our yaw-first hip matches the older H1 generation.
- **The GR-3 is the cautionary case.** It has high hip-pitch torque (366 N·m) but only 6.49 rad/s, too slow to snap up. INFERRED.
- **Boston Dynamics electric Atlas:** 1.9 m, 90 kg, 56 DOF, range of motion "Continuous". CONFIRMED ([product page](https://bostondynamics.com/products/atlas/)).
  - Its get-up folds the legs up along the torso, pivots up through the waist, then re-faces by spinning the head, hips and waist instead of stepping. REPORTED ([IEEE Spectrum](https://spectrum.ieee.org/boston-dynamics-new-atlas), [Interesting Engineering](https://interestingengineering.com/ai-robotics/atlas-robot-standing-up-motion-explained)).
  - Per-joint ranges, torques and get-up time are not published.
  - An Atlas-style legs-over get-up is possible within the T800's ranges but untested. EngineAI's own get-up doesn't use it. INFERRED.
- **Extra leg joints elsewhere:**
  - Tesla Optimus Gen 2 added articulated toes ([Not a Tesla App](https://www.notateslaapp.com/news/1821/tesla-unveils-optimus-robot-gen-2-tesla-designed-fingertip-sensors-actuators-and-ten-other-improvements-video)).
  - XPeng IRON has passive toe DOF ([CnEVPost](https://cnevpost.com/2025/11/05/xpeng-unveils-next-gen-iron-humanoid-robot/)).
  - A slip-turning study found toe joints cut friction torque and increase the turn angle ([PMC10507470](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10507470/)).
  - These are REPORTED and not re-checked. No surveyed fighting robot has toes, and no surveyed production humanoid has a shin-twist joint or a 3-DOF ankle.

### 11. Borrow the mechanics, keep the look ours

**Safe to borrow.** Functional engineering, most of it an industry norm:
- the pitch → roll → thigh-yaw order;
- a pitch axis tilted about 15° outward-down;
- range envelopes;
- graded hip torques (pitch > roll > yaw);
- a rotary knee in the hip-pitch class;
- motors placed toward the pelvis and ankle motors on the shin driving a two-rod ankle;
- cooled leg drums;
- adult proportions: ~0.48 m thigh and shin, ~16 cm hip-pitch span.

**Keep out of the game.** This is the T800's look:
- gloss white shells with grey disc caps carrying a single index line;
- vented drum sides;
- a helmet with one horizontal LED visor;
- a glowing round chest emblem;
- white sneaker feet;
- SZNS, triangle and orange-tick markings, and Chinese text on the chest;
- the names T800, EngineAI, 众擎, URKL, White Eagle and Terminator.

Real products appear only as cited spec sources in docs and catalog `source` strings, following the "Real products stay out of the game" rule in `08-modern-roster.md`. The existing catalog display name "T800-class 450 N·m joint" (`src/robots/catalog.ts`, used by the iron STRIKER and GOLIATH) should become "450 N·m-class joint" before the workshop shows motor names.

### 12. Open questions

- Why does the headline say 450 N·m when every model file caps the hip pitch and knee at 415?
- What are the Q-series gear ratios, module masses and gearbox types? None is published.
- Are the URDF extremes mechanically reachable (hip pitch −190°, torso yaw −251°), or just generous software limits?
- Which T800 edition, and which range set, do URKL teams actually fight on?
- How do the kip-up and prone get-ups work joint by joint? They are not in the SDK and would need official footage at a known frame rate.
- Is the 10 s KO rule real? The detailed rulebook we reached scores recovery up to 20 s.
- What are the Max edition's waist and neck axes? No model file is published.
- Does the pelvis-turn get-up hold up in official footage? Step EngineAI's own continuous uploads at a known frame rate.
- Why did EngineAI choose this hip layout? No founder or engineer interview was found; Chinese long-form outlets are unsearched.
