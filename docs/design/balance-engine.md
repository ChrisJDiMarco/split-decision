# Balance engine for Split Decision fighters

The mocap tracking controller decides how a move should look. The balance engine decides what the body can do without falling, using only its motors and the gyro core. The design in one line: every footstep, strike and recovery shares one divergent-component-of-motion (DCM) plan; the stance legs are made compliant and fed forward so the centre of pressure (COP) goes where the plan puts it; the gyro is kept for emergencies; a Euphoria-style behaviour layer runs the arms, neck and falls.

## 0. Where we start

Measured 2026-09-29 with read-only headless probes on the uncommitted tree (the simulation is deterministic).

| | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Mass (kg) | 38.0 | 82.9 | 105.4 | 79.6 |
| COM height in stance z_c (m) | 0.670 | 0.821 | 0.923 | 0.882 |
| ω0 = √(g/z_c) (1/s); 1/ω0 (s) | 3.83; 0.261 | 3.46; 0.289 | 3.26; 0.307 | 3.34; 0.300 |
| Leg length L (m) | 0.587 | 0.807 | 0.813 | 0.904 |
| Sole half-length × half-width (m) | 0.100 × 0.049 | 0.132 × 0.063 | 0.143 × 0.076 | 0.145 × 0.064 |
| One leg / one arm, share of mass | 21% / 10% | 26% / 10% | 22% / 11% | 27% / 9% |
| Gyro τ_max (N·m), H (N·m·s) | 70, 24 | 140, 49 | 195, 68 | 150, 51 |
| COP shift worth τ_max, τ_max/(mg) | 0.19 m | 0.17 m | 0.19 m | 0.19 m |
| COP shift per 1° of ankle error, one loaded foot | 2.5 cm | 6.9 cm | 5.4 cm | 7.2 cm |

The limbs are heavy. A human leg is 16.1% of body mass and an arm 5.0% ([Winter, Table 4.1](https://courses.grainger.illinois.edu/me481/sp2021/Anthro-Winter.pdf)), so every swing moves these robots' centre of mass (COM) and angular momentum 1.3-2 times more than it moved the actor's. Mocap poses copied onto them lean too little.

Approach drill: two robots 4 m apart, both on `close_distance`, 12 s, no strikes.

| | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Closing speed (m/s); time to 1.3 m apart (s) | 0.12; 11.2 | 0.13; 10.2 | 0.19; 7.6 | 0.11-0.14; 10.9 |
| Time in single support; steps after arriving | 74%; 3 | 70%; 4 | 68%; 9-10 | 65%; 2-3 |
| Torso tilt RMS / peak (standing lean 3.4°) | 6.0° / 11.1° | 5.3° / 10.6° | 5.9° / 12.6° | 6.5° / 23.6° |
| Torso rate RMS below / above 3 Hz (rad/s) | 0.65 / 0.57 | 0.54 / 0.47 | 0.61 / 0.46 | 0.60 / 0.54 |
| Pelvis height std (cm) | 2.1 | 3.0 | 3.2 | 3.2 |
| Largest planned-COP jump in one 2 ms tick (cm) | 25 | 30 | 40 | 34 |
| A planted-leg servo at its torque limit | 21% | 8% | 13% | 12% |
| Gyro saturation mean / peak | 0.19 / 0.41 | 0.17 / 0.53 | 0.12 / 0.37 | 0.20 / 0.47 |

Two 60 s sparring fights in `tools/fight-metrics.ts` (SAVATE v HAYMAKER, FIRECRACKER v PYLON) had 5 self-inflicted knockdowns, 2.5 per fighter per 2 minutes against the tool's target of 0.5. Every one was logged with the gyro at saturation 1.00, while stepping, standing, throwing a jab or cross, or rising. Standing still, the robots are better: a 0.1 s torso shove of 1.1 m/s is survived in 12 of 16 design-and-direction cases, but those recoveries take 3-10 steps and 64-100% of the gyro.

Why it looks clunky:

1. The approach is slow by construction. The stance planner aims each step at a stance frame at most 0.22 L ahead (`STEP_TUNING.maxStride`) and spends about 0.45 s per step, so each step gains only 5-9 cm. The fast walker is off after dropping the light robots, clip footwork is off (`FOOTWORK.enabled = 0`), and mocap kicks are off after 9 falls in 21 drill kicks.
2. The body hops from foot to foot. Each lift follows only a 0.11-0.16 s partial weight shift, and the planned COP jumps as much as 25-40 cm between two ticks.
3. The joints fight at their limits. Every servo stalls at 4° of error (ankles at 5.7°), so small tracking errors throw the COP to a sole edge, and a force-clamped MuJoCo actuator loses its implicit damping (`actuatorDerivSkip` in [engine_derivative.c](https://github.com/google-deepmind/mujoco/blob/main/src/engine/engine_derivative.c)). That likely explains much of the buzz above 3 Hz [inference].
4. Plans reset at handoffs. The gait re-anchors when the COM strays 12 cm; the clip footwork (off today) re-anchors at every touchdown and replaces the plan through `gait.external`.
5. The gyro is spent on posture. Tilt stiffness (0.8·mgh past 0.16 rad) and sole-roll stiffness (1.5·mgh) are steady demands, and with a 1.2 s bleed any steady demand above H/1.2 s (20-57 N·m) fills the rotor.
6. Nothing anticipates. `subtree_angmom` is filled every step and never read; the gyro only reacts past its deadbands.

## 1. What Bodycam and Euphoria can teach

Bodycam has published no technical detail. Reissad calls the v0.8 system "fully procedural", with operators who "fight to recover balance and protect themselves" ([80.lv](https://80.lv/articles/ultra-realistic-fps-bodycam-reveals-advanced-self-balancing-ragdolls)). The release notes only say stumbling was added and is still early ([Steam](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1842846814441066)). With kinematic players on UE5, it is very likely a physical hit-reaction layer in the Euphoria mould [inference].

Euphoria's patent mixes behaviour outputs by weight and scales every parameter by length, mass and time ([US20130222433A1](https://patents.google.com/patent/US20130222433)). GTA V exposes the defaults ([ConfigureBalance](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_configure_balance_helper.html), [BodyBalance](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_body_balance_helper.html)): steps predicted 0.2 s ahead, balance abandoned at a lean of 0.6, "stable" below 0.3 m/s and 0.3 rad/s, arms out above 1.2 rad/s of pitch or roll rate, braces held at least 0.3 s "so the character doesn't look twitchy". Its `StayUpright` also adds upright forces above 0.5 m/s of COM speed ([StayUpright](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_stay_upright_helper.html)). We take the structure and the thresholds, never the forces. The gyro core is our honest `StayUpright`: capped, saturating, spent only on fast, large errors.

We found no shipped game that walks an unassisted, fully simulated humanoid into a fight; Exanima's developers say their walking uses "invisible forces" ([Steam](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1819386365123229)). The walking here comes from robotics (capture-point stepping on Atlas and HRP-4) and physics-based animation (SIMBICON, Coros 2010, Lee 2010).

## 2. Architecture and rates

```
Jev (2-5 Hz) → Tactics (goal stance frame, move requests)
Mocap tracker (500 Hz) → MotionReference: q, q̇, q̈, limb weights, clip footsteps,
                         contacts, trunk style, centroid table
------------------------------ balance engine, 500 Hz ------------------------------
sense     c, ċ, ξ, L, L̇, ω0, contacts
plan      footsteps (per event) → DCM reference ξ_ref(t), r_ref(t) (per tick)
feedback  r_cmp = r_ref + k_ξ (ξ − ξ_ref)
allocate  soles (COP) → gyro → body momentum → step placement and timing
modulate  pelvis, stance leg, swing landing, waist, arms, neck
joints    IK → targets; ID and Jᵀ·F feed-forward as τ/kp; kp and kv scales
-------------------------------------------------------------------------------------
Motors (1 kHz): torque-speed, heat, battery, gain scales → MuJoCo servos (implicit kv)
Gyro core: couple in xfrc_applied, |τ| ≤ τ_max·health, |h| ≤ H, 1.2 s bleed
```

Every physics step runs the motor limits, gain scales, servos and gyro couple. Every 2 ms control tick runs the whole engine. Footstep events (2-5 Hz) re-plan the footsteps, pick the gait, sync the clip phase and log the gyro reserve. Offline builds produce mass-aware centroid tables per move and a cross-entropy gain search per design.

Mocap is intent and style; balance is feasibility. For legs and pelvis the priority is strict and balance edits the reference, because averaging a clip stride with a capture step lands the foot in neither place. Arms and neck blend by weight, as in Euphoria.

| Joints | Footwork and strikes | Recovering | Falling |
|---|---|---|---|
| Stance leg | Balance (IK from the balanced pelvis); clip tilt, drop ≤ 3 cm and turn as bounded offsets | Balance | Soft, knees fold |
| Swing leg | Clip foot-height profile and knee direction; landing and timing from balance | Step adjuster | Overridden |
| Kicking leg | Tracker (joint space, aim warp) | Reclaimed for a catch step | Reclaimed |
| Pelvis position | Balance; clip weight shift becomes a COM offset inside the support | Balance | Lowered |
| Waist, arms, neck | Clip + counter-rotation, by weight; head locked on target | Hip bend, arms out | Catch, tuck |

The modulation is Lee, Kim and Lee's (2010) ([PDF](https://mrl.snu.ac.kr/research/ProjectDataDrivenBiped/DataDrivenBipedControl_2010.pdf)): corrections are measured against the reference's own COM state, so they remove error and keep style. We adopt their timing rules too. The clip clock follows real contacts; an early touchdown drops the rest of the fragment and warps the next from the actual pose (over half a cycle, the stance ankle over a fifth of that); a late one holds the clip. Without that synchronisation their character fell within 3-6 steps.

## 3. The balance core

A DCM stepping controller moves the centroidal moment pivot (CMP) four ways, in order: the soles, the gyro, the body's own angular momentum, then foot placement and timing. A whole-body QP would cost 0.3-1 ms per robot per tick in JavaScript and suits torque control better than position servos. A momentum solve like Macchietto et al.'s (2009) can come later at 100 Hz; we take only its angular-momentum feed-forward.

### 3.1 State

All from the `mj_subtreeVel` call that `views()` already makes: c = `subtree_com[root]`, ċ = `subtree_linvel[root]`, ω0 = √(g/c_z), ξ = c + ċ/ω0; L = `subtree_angmom[root]` with L̇ low-passed at 20 ms; each leg's share, `subtree_angmom[thigh]` + m_leg(c_leg − c) × (v_leg − ċ), for the waist counter-rotation; the torso rate from `cvel[torso]`. No Jacobian calls are needed at 500 Hz: Jᵀ·F on a leg hinge is axis · ((p − anchor) × F), which the existing `xanchor`/`xaxis` loop already computes. `mj_jacSubtreeCom` (1.8-2.8 µs) is only for a COM-level force through the waist or arms, `mj_jacBody` for swing-foot velocity if finite differences prove noisy, and `mj_fullM` for offline damping tuning.

### 3.2 One plan for every mode

The walk and shuffle planners, a clip's swings, a kick's plant and capture steps all write into one footstep list. Each footstep has a sole pose, lift and land times, and a CMP path on its sole: heel to toe when walking, the ball when shuffling. The DCM reference depends only on that list and the clock ([Englsberger 2013](https://elib.dlr.de/87255/1/IROS_2013_FinalSubmission_JEnglsberger.pdf)), over the current step and up to three more:

  ξ_eos,i−1 = r_i + e^(−ω0·T_i)·(ξ_eos,i − r_i),  the last ξ_eos at the final stance centroid
  ξ_ref(t) = r_i + e^(ω0·(t − T_i))·(ξ_eos,i − r_i)  during step i

Double support is a cubic Hermite blend with a heel-to-toe CMP roll ([Englsberger et al. 2014](https://www.researchgate.net/publication/284755360_Trajectory_generation_for_continuous_leg_forces_during_double_support_and_heel-to-toe_shift_based_on_divergent_component_of_motion)), which keeps leg forces continuous and ends the COP jumps.

The reference is also the discounted future of the CMP plan, ξ_ref(t) = ω0 ∫ e^(−ω0(s−t)) r_ref(s) ds. Write a strike's COP needs into r_ref and the body starts shifting about 1/ω0 (0.26-0.31 s) early, at no extra cost.

Handoffs never reset the plan. A new owner may replace future footsteps, never the one in progress; a change two steps out reaches ξ_ref scaled by e^(−2ω0T) ≈ 0.06. When a capture changes the current step, the reference blends over 0.1 s.

### 3.3 Feedback

  r_cmp = r_ref + (1 + k_p/ω0)·(ξ − ξ_ref) + (k_i/ω0)·⟨ξ − ξ_ref⟩

The DCM error then decays at rate k_p. ⟨·⟩ is a leaky average (10 s), active only in double support, so it cannot wind up. Start at k_p = 1.5·ω0 (4.9-5.7 s⁻¹; the bracket is 2.5 on every robot) and sweep 1.8-3.5. Atlas ([Griffin 2017](https://arxiv.org/abs/1703.00477)) and position-controlled HRP-4 ([Caron 2019](https://arxiv.org/abs/1809.07073)) run this law; the starting gain and range here are ours to tune. Keep k_i = 0 unless a standing offset appears.

### 3.4 Allocation

The CMP is where the ground force would act if the body's angular momentum stayed constant ([Popovic, Goswami, Herr 2005](https://www.researchgate.net/publication/221710011_Ground_Reference_Points_in_Legged_Locomotion_Definitions_Biological_Trajectories_and_Control_Implications)). With the gyro couple τ_g on the torso:

  r_cmp = r_cop + (1/mg)·(L̇_y − τ_g,y, −(L̇_x − τ_g,x))

(Today's rule, gyro torque mg·(Δy, −Δx) for a COP shift Δ, is the same relation.) Each tick:

1. COP = r_cmp − Δ_ff projected into the support shrunk by 1.5 cm, where Δ_ff = (L̇_ref,y, −L̇_ref,x)/(mg) is the move's planned momentum change; `footLoads` splits it between the feet.
2. The part the soles cannot reach, Δ_g, becomes gyro torque mg·(Δ_g,y, −Δ_g,x) under the policy in 3.7.
3. With the gyro reserve under 30%, the hip and waist bend takes the remainder, and the arms go out above 1.2 rad/s of torso rate.
4. What is left goes to the feet.

### 3.5 Step placement and timing, every tick

While a foot swings, predict ξ at touchdown with the CMP held on the stance sole, ξ_T = r + (ξ − r)·e^(ω0·t_rem), and aim the landing at u* = ξ_T − b, where b = ξ_eos − u_nom is the plan's offset. Clamp u* to the reach set: within 0.62 L of the stance sole, never across it (lateral gap ≥ 0.08 L), inside the hip-yaw limits and 0.9 m inside the fence. If the clamp bites, land sooner: search t' in [T_min, t_rem] for a touchdown whose prediction the reach set catches, with T_min from the swing hip's torque-speed line and never under 0.5/ω0. That speed-up plus step adjustment recovered Atlas from pushes of 1.92 times its weight in simulation, the whole algorithm taking 220 µs ([Griffin 2017](https://arxiv.org/abs/1703.00477)). Freeze the landing at 85% of the swing, and re-plan the swing as a quintic from its commanded position, velocity and acceleration so the foot never jumps. If one step cannot capture, plan a second ([Koolen 2012](https://dl.acm.org/doi/10.1177/0278364912452762)); if two cannot, brace.

In double support, start a capture step as soon as ξ is 2 cm outside the support and the soles and gyro cannot bring it back within 1/ω0. Khadiv et al.'s joint five-variable QP ([arXiv 1704.01271](https://arxiv.org/abs/1704.01271)) is the upgrade if placement and timing start fighting.

### 3.6 Getting the COP from position servos

With servos that stall at 4-6°, tracking error decides the ankle torque and so the COP. Let feed-forward carry the load and the servo spring only correct.

Feed-forward: extend `applyGravityFeedforward` to the full planned ground force F = m·(ω0²(c − r_cmp), g) at each foot's planned COP, τ = rne(q, q̇, q̈_ref) − Σ Jᵀ·F. `mj_rne` with accelerations costs 2.3 µs for the whole scene (measured). It goes in as a target shift τ/kp_eff, as now, clamped to ±0.35 rad and 90% of available torque so the servo keeps headroom and implicit damping.

Impedance: `motors.ts` already rewrites `gainprm` and `biasprm` every step; add per-joint gain and damping scales written each tick. Real modules do this: CubeMars's "MIT mode" carries position, velocity, Kp, Kd and feed-forward torque in every CAN frame ([CubeMars](https://www.cubemars.com/setup-cubemars-ak60-6-kv80-for-mit-mode.html)).

| Joint role | kp scale | kv scale |
|---|---|---|
| Stance ankle | 0.3 | 0.55 |
| Stance knee, hip pitch and roll; stance hip yaw (0.35 in a pivot) | 0.5 | 0.7 |
| Swing leg, guard arms, neck | 1.0 | 1.0 |
| Waist | 0.7 | 0.85 |
| Bracing arms / legs | 1.0 / 0.4 | 1.0 / 0.65 |

kv scales with √(kp scale), keeping each joint's damping ratio. At 0.3, a 1° ankle error moves SAVATE's COP 2.1 cm instead of 6.9 cm.

The pelvis target is the COM carried forward (c + ċΔt + ½c̈Δt²) plus a predicted pelvis-to-COM offset. Predicted, because heavy legs shift the COM 5-10 cm against the pelvis within one 0.3 s walking swing [estimate], faster than today's 0.3 s filter: use the measured offset plus m_leg/m × 0.6 × the planned swing-foot travel.

### 3.7 Gyro policy

No stiffness terms. The demand is:

- damping, τ = −b_g·ω_torso in pitch and roll, b_g = 0.06·m·g·z_c (15, 40, 57, 41 N·m·s/rad). A 30 N·m·s/rad torso damper sufficed in the GyBAR human trials, where "effective assistance did not require regulation to a reference posture" ([GyBAR](https://www.nature.com/articles/s41598-020-66760-w));
- emergency, the allocation remainder Δ_g;
- feed-forward, −L̇_ref for planned kicks and spins.

Damping and feed-forward run only while stored momentum is under 0.5 H (tapering 0.4-0.6 H); emergencies may use all of it. Bleed only in double support with ξ at least 3 cm inside the support, never faster than the soles can absorb. A full emergency buys Δ·(1 − e^(−ω0H/τ_max)) of DCM reach: 13.7, 12.1, 12.8 and 13.0 cm, about one sole half-length for one 0.35 s event. The gyro has no yaw axis, so yaw goes to foot friction and the waist.

### 3.8 Compute

New work per robot per tick: recursion and feedback 1-2 µs, allocation 2-4, step adjustment 2-5, swing, momentum, behaviours and impedance 2-4, a share of `mj_rne` about 1.5, 3D Jᵀ·F about 1. That adds 10-17 µs to today's 17-23 µs per tick, landing near 14-20 µs per robot per physics step: inside the 40 µs gate in `tests/control/perf.test.ts`, far under 100 µs a tick, and small beside physics at 72-95 µs per step for both robots. Preallocate everything; a garbage-collection pause in the worker costs more than all of this.

## 4. Footwork that looks trained

Competent fighters never hop between feet at range, hold one height, keep the head and guard still, and arrive already in stance. Walk while the opponent is beyond 2.4 m; below 2.0 m, step-drag, side-step and pivot; in stance, run the clip's guard idle with at most 1.5 cm of COM sway. Hold any gait at least 0.3 s.

### 4.1 Walk

Timing is in units of 1/ω0, following the time scaling in Euphoria's patent. A step lasts T = 1.4/ω0 (1.15/ω0 on one foot, 0.25/ω0 on two). Speed is v = v̂·√(g·z_c), with v̂ = 0.3 at aggression 0.5, ranging 0.22-0.38 (0.56-1.14 m/s). A touchdown is 0-step capturable when the DCM offset b = ℓ/(e^(ω0T) − 1) fits inside the sole; that caps the default speed, and above it the plan accepts 1-step-capturable steps and stops in two.

| | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Single / double support per step (s) | 0.30 / 0.07 | 0.33 / 0.07 | 0.35 / 0.08 | 0.35 / 0.08 |
| Walk at v̂ = 0.3 (m/s); step length | 0.77; 0.28 m | 0.85; 0.35 m | 0.90; 0.39 m | 0.88; 0.37 m |
| DCM offset at touchdown / usable half-sole (m) | 0.092 / 0.085 | 0.113 / 0.117 | 0.127 / 0.128 | 0.121 / 0.130 |
| Fastest 0-step-capturable walk (m/s) | 0.71 | 0.88 | 0.91 | 0.95 |
| Shuffle swing / double support (s) | 0.20 / 0.09 | 0.22 / 0.10 | 0.23 / 0.11 | 0.23 / 0.11 |
| Shuffle stride 0.3 L; speed | 0.18 m; 0.31 m/s | 0.24 m; 0.38 m/s | 0.24 m; 0.36 m/s | 0.27 m; 0.41 m/s |

FIRECRACKER's feet are small for its height, so it defaults to v̂ = 0.28 (0.71 m/s). HAYMAKER's 13.1 rad/s planetary hips may limit its cadence before its pendulum does (about 0.38 s on one foot at full step length [estimate]); the planner reads T_min from the motor model and shortens steps rather than rushing them. The CMP rolls from 25% of the sole behind its centre to 30% ahead. Width is 1.05 × the hip spacing, placed at a constant margin outside the extrapolated COM ([Hof 2008](https://www.researchgate.net/publication/5909208_The_'extrapolated_center_of_mass'_concept_suggests_a_simple_control_of_balance_in_walking)), which puts the lateral DCM offset (3.2-5.3 cm) inside each sole. Lift is 5% of L, and the hips square to the direction of travel.

### 4.2 Step-drag, side-step, pivot

Inside range the feet never pass and the COM never parks over one foot. To advance, the rear ball pushes (the CMP sits there) while the lead foot swings for 0.75/ω0 with a 3% L lift and lands to catch the moving DCM; the weight rolls onto the lead heel through 0.35/ω0 of double support, and the rear foot drags up the same distance. A normal stride is 0.3 L; an attacking entry is up to 0.45 L with double support cut to 0.2/ω0. Retreat mirrors it, rear foot first. A side-step moves the foot on the side of travel first. Circling pivots on the lead ball while the rear foot swings 0.25-0.4 rad of arc. A foot lifts when its planned landing would catch the body (the gait's `landingCaptures`) at the time the plan sets, so the quasi-static weight shift leaves locomotion entirely.

### 4.3 Arrival and posture

The approach planner counts footsteps back from the goal. The last walking step puts the lead foot in its slot and the rear foot drags into its own, turned out 0.5 rad; if the count is uneven, one step is added or dropped across the last three. The final ξ_eos is the stance centroid, so the recursion shapes the slowdown over the last two steps with no stop, reset and rock, and the pelvis turns back to the stance blade (−0.28 rad) over the same two steps. Today the robots take 2-10 correction steps here.

- Height: pelvis at stance height ±1.5 cm. Remove `stepDip` (up to 9% of L) and cap the clip bob at 1.5 cm; ±3 m/s² of vertical acceleration would move ω0² by about 30%.
- Knees: keep the stance crouch (hip-to-ankle span 0.95 L, about 36° of knee flexion) while walking; reach at that height limits step length.
- Pelvis: level in the world through the stance hip, as in SIMBICON ([PDF](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)), leaning into acceleration by 0.5·atan(c̈/g), at most 0.06 rad.
- Guard: fists fixed in the torso frame at full stiffness with gravity feed-forward. Loose arms read as drunk.
- Counter-rotation: with the guard up the arms cannot swing, so the waist turns by −0.5 × the legs' vertical angular momentum over the upper body's yaw inertia, capped at 0.35 rad, off during strikes. Humans walk with whole-body angular momentum near zero ([Herr and Popovic 2008](https://journals.biologists.com/jeb/article/211/4/467/18040/Angular-momentum-in-human-walking)); `YAW_TUNING.waistCounter` is 0 today.
- Head: neck yaw locked on the opponent's head in the world frame, rate-limited. A still head that tracks its target is the cheapest cue of competence.
- Stance: 1.0-1.05 × the hip spacing wide (0.8 today) and 0.16-0.18 L per side long (0.14 today). SAVATE's ankle-only sideways capacity rises from 0.44 to 0.52 m/s. Tune both, then re-register strike ranges.

## 5. Strikes with weight transfer

### 5.1 Mass-aware references

Once per design and move (offline, or when the library loads at about 4 µs a frame), run the retargeted frames through MuJoCo with the robot's own masses (`mj_kinematics`, `mj_comPos`, `mj_subtreeVel`, feet planted as the clip plants them). Keep the COM path, L̇, and the COP the move implies at 1× speed:

  Δp₁ = (−c̈_x/ω0² − L̇_y/(mg),  −c̈_y/ω0² + L̇_x/(mg))

It is the correction the actors' poses lack: they balanced 16% legs, not 21-27%. The implied COP scales with the square of playback rate, so the tracker plays at r = min(r_motor, r_bal, r_intent) with r_bal = √(margin/|Δp₁|). A strike thrown off balance comes slower instead of tipping the thrower. The tables also give Jev's `moveRisk` a physical basis.

### 5.2 Punches

Feet stay down, and the standing plan's CMP reference is the clip's implied COP, so the weight transfer starts about 1/ω0 before the big accelerations (people shift posture about 100 ms before a limb moves ([Piscitelli 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5316309/))). The clip's weight shift becomes the COM reference, clamped 1.5 cm inside the support: the full shift for a cross, hook or overhand (up to 7 cm forward and 5 cm sideways today), 30-50% of it for a jab. The clip's pelvis turn (up to 0.45 rad) needs the rear heel to pivot, so stance hip yaw drops to 0.35 in the strike phase and the yaw reaction goes into friction. The robot is ready to throw again when stable (0.3 m/s, 0.3 rad/s) with at least 60% of the gyro in reserve. Stepping jabs, with a shuffle step timed to plant on the impact frame, come later.

### 5.3 Kicks

A kicking leg is about a quarter of the body. Chambering it moves the whole-body COM 6-11 cm toward the kick [estimate] over a stance sole only 5-8 cm wide either side, and its pitch and roll momentum is about 20-40 N·m·s at the chamber on the 80-105 kg robots [estimate], against H = 49-68 N·m·s.

1. Pre-position: weight onto the stance foot over 1.0/ω0 (0.26-0.31 s) of double support, ξ on the ball of that foot, pelvis 1-2 cm lower. Today's `requestSkillLeg` waits up to 1.3 s for a quasi-static shift.
2. Gate: lift only when ξ is within 2 cm of the planned CMP, the robot is stable, the stance sole is flat (up-axis z > 0.97), its joints are healthy, and the reserve covers the table's kick momentum. Otherwise wait up to 0.3 s, then cancel: Jev sees a cancelled kick, not a fall.
3. During: the table sets the counter-lean, the gyro feeds forward −L̇_ref within its reserve, and yaw goes into a real pivot on the stance ball (hip-yaw stiffness 0.35) and the waist.
4. Landing: the step adjuster decides where the leg comes down, then a shuffle re-squares. If ξ leaves the stance sole by 5 cm before the strike phase, reclaim the leg for a catch step, as `skillCaptureStep` does now.

For jump and spin kicks, take-off decides the outcome: the plan drives COM velocity and angular momentum to the table's take-off values, only the gyro trims pitch and roll in flight, and the landing is a capture step or a brace. SIMBICON's authors make the same point about flight phases.

## 6. Reactions after hits

Bodycam's pitch with real actuators: fight to stay up, protect the head, commit once the fall is lost.

Detection is proprioceptive. Each tick the engine predicts ξ from the CMP it applied; an error over 1.5 cm in one tick, confirmed by a jump in torso rate, is a hit (20 N·s moves SAVATE's ξ by 7 cm). The damage module's impact event adds the part and direction.

| State | Entered when | The body |
|---|---|---|
| Absorb (≤ 0.15 s) | A hit | The hit limb's chain drops to 0.6 stiffness and regains at 2/s; stance legs and guard keep theirs; the step adjuster runs |
| Recover | ξ leaves the support, or a hit moves it over 3 cm | 1-3 capture steps at T_min; arms out 0.5 rad per rad/s of torso rate above 1.2, fall side first; hip bend when the reserve is under 30%; pelvis 3 cm lower; re-square after 0.3 s stable |
| Brace | Lean over 0.6 rad; ξ outside the 2-step capture region with the reserve spent; COM under 0.28 × height above the lowest foot; or 3 steps without settling | Within a tick: stop stepping; hands to the predicted contact about 0.8·z_c along the fall, elbows bent 30°, arms at 1.0 and legs at 0.4 stiffness (Euphoria's CatchFall uses 15 and 6 ([docs](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_catch_fall_helper.html))); waist tucks in a backward fall or turns 0.3-0.5 rad onto hip and shoulder; knees fold; the gyro spends its whole reserve slowing the rotation; held ≥ 0.3 s |
| Down, Rise | Fall detected | Mocap get-up, then `Rise` (as now) |

A pre-brace fires when the opponent's windup passes the reflex threshold (0.55) within 1.35 m: centre ξ_ref, drop 2 cm, stiffen guard and waist.

Euphoria's StaggerFall softens the legs with each step so characters fall convincingly. A competent fighter does the opposite: one or two decisive steps, or an early brace and a get-up. Every force still comes from a motor inside its torque-speed, heat and battery limits, the gyro inside τ_max and H, or the ground. The behaviours only choose targets, the way a person decides to put their hands out: no upright forces, world-space drives, gravity multipliers or pin forces.

## 7. Integration with the mocap tracking controller

The engine lives in `src/physics/control/balance/`, behind a switch (`CONTROL.balance = 'legacy' | 'dcm'`) so both paths run during the changeover, and meets the tracker through three types:

```ts
interface Footstep {
  side: Side; place: FootPlace; lift: number; land: number;
  cmp: [P2, P2]; clearance: number;   // CMP path on the sole; swing apex
  source: 'walk' | 'shuffle' | 'pivot' | 'arrive' | 'clip' | 'kick' | 'capture';
}
interface MotionReference {           // tracker → balance, every tick
  q: Float64Array; qd: Float64Array; qdd?: Float64Array;
  weight: Record<'armL' | 'armR' | 'waist' | 'neck' | 'legL' | 'legR', number>;
  trunk: { yaw: number; pitch: number; roll: number; drop: number; shift: P2 };
  footsteps?: Footstep[];             // a clip's swings, from its contact bits
  centroid?: { com: P2; comVel: P2; comAcc: P2; Ldot: Vec3 };
  contacts: number; phase: SkillPhase; tau: number;
}
interface BalanceState {              // balance → tactics, tracker, openings
  xi: P2; xiRef: P2; margin: number; gyroReserve: number;
  mode: 'steady' | 'absorb' | 'recover' | 'brace' | 'down' | 'rise';
  clipRate: number; clipSync: { hold: boolean; jumpTo?: number };
  canStrike: boolean; canKick: boolean;
}
```

New files, one job each: `index.ts` (the tick), `dcm.ts`, `footsteps.ts` (planners and gait hysteresis), `step-adjust.ts`, `allocate.ts`, `gyro-policy.ts`, `impedance.ts`, `momentum.ts`, `swing.ts` (quintic swings), `behaviours.ts` (arm, neck and waist arbiter), `reactions.ts`; plus `tools/mocap/centroid-tables.ts` and `tools/balance-drills.ts`.

Changes:

- `controller.ts`: `stand()` calls the engine; `driveGyro`, `gyroAssistM`, `swingTwist` and the yaw lead move in; `readyToStrike` and `balanceMargin` read `BalanceState`.
- `gait.ts`: keep the foot state machine, planting, slip tracking and `constrainTarget`; drop `DcmReference`, `external`, `stepDip` and the quasi-static lift rules for walking; publish lift and touchdown events.
- `stepping.ts`: keep the reach helpers; `planStep`, `captureStep` and `adjustSwing` are replaced.
- `balance.ts`: `gyroDemand` goes; `pelvisTarget` follows the planned COM acceleration.
- `feedforward.ts`: 3D ground force, `mj_rne`, gain-aware `effectiveKp`, headroom clamp. `sense.ts`: L and ξ.
- `strategies.ts`: engage on a low gyro reserve, not only on damage.
- `systems/motors.ts`: multiply per-joint gain and damping scales into `gainprm` and `biasprm`.
- `mocap/footwork.ts`: stop writing `gait.external`; emit the clip's swings (`swingsOf` already finds them) as footsteps and drive clip time from contacts. `mocap/strikes.ts`: `trunk()` becomes `MotionReference.trunk`, kicks get the new shift, gate and landing. `mocap/skills.ts`: `MOCAP_KICKS` on once the kick drill passes.

Reuse unchanged: `geometry.ts`, `support.ts`, `ik.ts`, `posture.ts`, `loads.ts`, `gyro.ts`, `rise.ts`, both get-ups, `tactics.ts`, `MotionPlayer` and the rate tables. Delete after the switch passes its gates: `walk.ts` and `FAST_WALK_ENABLED` (keep its offset formulas), `DcmReference`, `gait.external` and the footwork COM reference, `gyroTilt`, `gyroRoll` and `gyroCp`, the dip constants, the `HURRY_*` and `CAPTURE_MARGIN` triggers, and `YAW_TUNING.stumbleM`.

## 8. Tests and measurement

`tools/balance-drills.ts` runs headless drills in the minimal world of `tests/control/helpers.ts` with the real systems, in parallel jobs, writing JSON:

- approach and hold from 3, 4 and 6 m at 0°, ±15° and ±30°;
- shuffle square (±0.5 m each way) and circling;
- a push matrix: 8 directions × {stance, walk mid-swing, shuffle mid-swing, just arrived, cross strike phase, kick chamber}, 0.1 s pushes with ΔV rising by 0.1 m/s to failure;
- 20 of each strike and kick at a standing opponent;
- torso and head hits of 20, 40 and 73 N·s, spanning the impacts logged so far (p90 30-50, maximum 73);
- pushes past capture, to time the brace and see what touches first.

| Metric | Today | Target |
|---|---|---|
| Self-falls in fights, per fighter per 2 min | 2.5 | ≤ 0.5; none while stepping or standing |
| Closing speed beyond 1.3 m; 4 m to 1.3 m | 0.11-0.20 m/s; 7.6-11.2 s | ≥ 0.6 m/s (FIRECRACKER ≥ 0.55); ≤ 3.5 s |
| Steps after arriving; single support inside 2 m | 2-10; 65-74% | ≤ 2; ≤ 50% |
| Torso rate RMS below / above 3 Hz | 0.54-0.65 / 0.46-0.57 rad/s | ≤ 0.25 / ≤ 0.10 rad/s |
| Tilt peak beyond stance lean; pelvis height std | 7-20°; 1.8-3.2 cm | ≤ 6°; ≤ 1.5 cm |
| Planned-COP jump per tick; DCM error RMS | 25-40 cm; unmeasured | ≤ 2 cm; ≤ 2 cm |
| Planted-leg servo at its limit, outside strikes | 8-21% | ≤ 3% |
| Gyro saturation in footwork; reserve at touchdown | 0.12-0.21; unmeasured | ≤ 0.10; ≥ 0.6 |
| Push survived: stance / mid-swing / kick chamber | ≥ 1.1 m/s in 12 of 16; unmeasured | ≥ 1.1 every way; ≥ 0.5; ≥ 0.3 m/s |
| Steps per recovery (median); time to stable | 3-10; unmeasured | ≤ 2; ≤ 0.8 s |
| Falls per 50 punches / per 10 kicks | mocap kicks: 9 in 21 | ≤ 1 / ≤ 1 |
| Brace before first non-foot contact; head first | none | ≥ 90%; ≤ 10% of falls |
| Control cost per robot per physics step | 8.3-11.3 µs | ≤ 40 µs |

Add these to `tools/fight-metrics.ts`, with self-falls split by activity, and extend `tests/control` to the modern roster (its `HUMANOIDS` list still holds only the iron-age three). Tune per design by cross-entropy search, as `tests/control/getup-search.ts` does for get-ups, over k_p, the impedance scales, v̂, the timing multipliers, b_g, the reserve and the stance width. Score on drills and sparring-brain fights, then check against Jev fights, which throw more flashy moves.

## 9. Build plan

- Phase 0, harness: `balance-drills.ts` and the metrics, with section 0 as the baseline.
- Phase 1, footwork on one plan: the first milestone below.
- Phase 2, impedance for knees and hips, inverse-dynamics feed-forward, reserve metrics. Gate: saturation ≤ 3%, torso rate above 3 Hz ≤ 0.10 rad/s, stance pushes of 1.1 m/s survived every way in ≤ 2 steps.
- Phase 3, strikes: centroid tables, CMP preview, r_bal, the kick pre-position, gate and landing, then mocap kicks on. Gate: ≤ 1 fall per 50 punches and per 10 kicks, kicks landing at least as often as the procedural ones.
- Phase 4, reactions: absorb, recover, brace and catch, the arm arbiter, the pre-brace. Gate: median ≤ 2 recovery steps, brace before contact in ≥ 90% of falls, head first in ≤ 10%.
- Phase 5, mocap footwork on the plan: contact sync, a small motion-matching pick of the next clip segment at each lift-off, take-off planning for flashy moves. Offline SAMCON-style repair of flashy moves is optional, and Chris decides whether it counts as training.

### First milestone: walk in like a fighter

Build `dcm.ts`, `footsteps.ts` and `step-adjust.ts` (walk beyond 2.4 m, step-drag inside 2.0 m, arrival with the final ξ at the stance centroid); constant pelvis height, a 3-5% L lift and quintic swings; gyro policy v1 (no stiffness terms, damping 0.06·mgh, 50% reserve, bleed only in double support); stance ankles at 0.3 stiffness with full ground-force feed-forward, kept only if the drills improve; a world-locked head; a stance 1.0-1.05 × the hip spacing wide.

It passes when every modern design survives 40 approach-and-hold drills (3-6 m, ±30°) with no falls, meets the approach, tilt, pelvis-height, COP-continuity and gyro targets in section 8, keeps single support at or under 50% inside 2 m, and holds torso rate to 0.30 rad/s below 3 Hz and 0.25 above (the tighter buzz target waits for Phase 2). It must also show no self-falls while stepping or standing in 60 s sparring fights (four pairings, 3 seeds), no loss of stance push recovery, and control under 40 µs per robot per step.

What Chris should see: the fighters walk in briskly, guard up, eyes on the opponent, shorten their last two steps, land in stance and stop without rocking. Nobody falls on the way in.
