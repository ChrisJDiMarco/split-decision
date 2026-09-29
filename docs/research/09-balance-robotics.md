# Balance research: robotics

**Key techniques:**
- One DCM/capture-point plan every tick for all modes (clip footwork, stance steps, capture steps): backward recursion ξ_eos,i−1 = r_i + e^(−ωT_i)(ξ_eos,i − r_i) over current + 3 steps; never reset the COM reference on mode handoff
- DCM feedback law r_cmp = r_cmp,ref + (1 + k_ξ/ω)(ξ − ξ_ref) + leaky integral; start at a coefficient of ~2.5 (HRP-4: prop 5, integral 10, T_i 10 s) and sweep 1.5–4
- Take only footsteps and contact timing from mocap clips, never the pelvis path as the COM reference; refine clips offline with robot-mass COM, reject frames with COM >0.2 m from the support foot, pad double support (HuB)
- Centroidal angular-momentum feed-forward: precompute L_clip(t) per move offline; read measured L from subtree_angmom (already filled by mj_subtreeVel); pre-shift the COP by L̇/(mg)
- Treat the gyro as a bounded CMP offset reserve: reach Δ = (τ/mg)(1 − e^(−ωH/τ)) ≈ 12–14 cm for ~0.35 s per robot; no steady-state stiffness terms, viscous torso damping only (GyBAR), bleed only in double support with margin
- Stance ankles as pure COP actuators via position-servo target shifting (q_target = q_meas + τ/kp, implicit kv kept); stance hip/knee at ~20–40% effective stiffness; swing leg stiff (Unitree G1 policy gains are hip 100, knee 150, ankle 40 N·m/rad)
- 6-variable step location + timing QP (Khadiv: u_T = (ξ − u0)e^(−ωt)τ + u0 − b, τ = e^(ωT)) with reach, no-crossing and cage constraints
- Griffin swing speed-up: Δt = (1/ω)ln(|ξ_p − r|/|ξ_r − r|), σ = (T_ss − t)/(T_ss − t⁺), with a minimum swing time
- Recovery order with thresholds: ankle → gyro (if within remaining reach) → swing speed-up → step adjust / two quick capture steps → hip and waist bend → protective brace and fall
- Constant pelvis height (±1.5 cm), dynamic lift-off with no full weight shift, shuffle swings 0.15–0.25 s with 1.5–3 cm lift, walks 0.3–0.4 s with heel-to-toe COP roll, step-drag footwork
- Stance width 1.0–1.2× hip offset in stance (now 0.8×), narrowing only in walks; Hof XcoM lateral foot placement
- Waist yaw counter-rotation from leg angular momentum to replace arm swing while the guard is up (humans keep whole-body L near zero; arm swing cuts vertical ground moment 63%)
- Anticipatory postural adjustments ~100 ms before strikes and kicks, gated on remaining gyro reach
- Replace the per-step pelvis dip (up to ~7 cm) or use time-varying ω = √((g+z̈)/z) (VRP formulation)
- Compute plan: centroidal allocation + Jᵀ·F costs ≲40 µs per robot per tick in JS (~4% of a core for two robots at 500 Hz); a full whole-body QP is ~0.3–1 ms and not worth it
- Push-test harness (0.1 s pushes at 0.25–1.0×mg, 8 directions, mid-swing and on arrival) plus cross-entropy gain tuning, with metrics for falls, gyro saturation, CMP lurch at mode switches and foot-edge roll

# Balance that reads as competent: a real-robotics recipe for Split Decision

Lens: classical humanoid balance and locomotion (no learned policies), mapped onto `/Users/chrisdimarco/Projects/split-decision/src/physics/control/`. I read the code and changed nothing. The diagnosis in section 1 comes from reading the code, not from running the sim.

**About Bodycam.** Reissad has published no technical details. The [80.lv piece](https://80.lv/articles/ultra-realistic-fps-bodycam-reveals-advanced-self-balancing-ragdolls) says only "fully procedural". The [v0.8 wiki page](https://bodycamgame.wiki/updates/locked-and-loaded/) points to devlog videos and gives no specifics. So everything below comes from robotics, where the same behaviors are well documented: reactive stepping, protective bracing, and fighting to stay up.

---

## 1. Why the fighters look clunky and fall today

1. **Balance steers the pelvis position, not the pressure point under the feet.**
   - `balance.ts` shifts the pelvis target (kp 1 m/m, kd 0.6 s). Very stiff position servos then move the body there. `humanoid.ts` sets kp so a joint hits stall torque at 0.07 rad of error.
   - Nothing chooses where the pressure point (centre of pressure, COP) lands. It falls out of the IK and pins at the heel or toe edge. The foot then rolls, and the gyro's `soleRoll` term (1.5·m·g·h per rad) fights the roll.
   - Only the damage system reads measured contact forces (`damage/impacts.ts`, `efc_force`). Control reads neither measured COP nor the body's angular momentum about its centre of mass.
2. **Three systems take turns owning the centre of mass (COM), and each handoff resets the plan.**
   - `mocap/footwork.ts` builds its COM reference from the clip pelvis's *velocity*, capped at 1.6 m/s² of acceleration. It re-anchors to the measured COM at every lift-off and touchdown, so position error is thrown away every step.
   - Clip swings lift on the clip's schedule (`liftShift: 0`), with no check that the landing will catch the body.
   - The implied pressure point c − a/ω² can sit ~15 cm from the COM. That is more than a single sole allows.
   - When the footwork hands over to `gait.ts` or `stepping.ts`, the DCM reference is reset to the measured state. Each reset is a visible lurch.
3. **The approach ends in quasi-static rocking.**
   - Inside 0.28 m of the goal, footwork stops and `planStep` takes "fine" strides with `DEFAULT_TIMING`: shift ≤1.2 s, `shiftFraction` 1. Lift-off also waits for COM speed below 0.35 m/s.
   - The robot therefore moves all its weight over one foot before every small step. That is the ASIMO/toddler look Chris describes as clunky. Boxers never do this.
4. **The gyro is spent on steady errors.**
   - Tilt stiffness (0.8·m·g·h) and the sole-roll term produce constant demands.
   - With the specs in `designs/index.ts`, a steady 30% torque demand fills the rotor in ~1.15 s on every robot. The handoff notes falls with the gyro saturated (sat 1.00).
5. **The pelvis dips on every step, which breaks the pendulum model.**
   - `stepDip` lowers the pelvis 0.3 m per metre of step, up to 0.09 of leg length (~7 cm), filtered at 0.12 s. The clip adds up to 3.5 cm of bob.
   - Vertical COM acceleration z̈ of ±3 m/s² changes the effective ω² = (g+z̈)/z by ~30%. It also unloads the stance sole exactly in single support.
6. **No angular-momentum bookkeeping.**
   - Kicks, hooks and heavy swing legs change the body's angular momentum L about its centre of mass. The balance layer sees this only as torso rate after the fact.
   - MuJoCo already computes L: the worker calls `mj_subtreeVel` every step, and that call also fills `subtree_angmom` ([MuJoCo API](https://mujoco.readthedocs.io/en/stable/APIreference/APIfunctions.html)).

---

## 2. One model, one plan, one budget

**Variables.**
- Divergent component of motion (DCM), also called the capture point: ξ = c + ċ/ω, with ω = √(g/z).
- Centroidal moment pivot (CMP): r_cmp.
- Dynamics: ξ̇ = ω(ξ − r_cmp). The COM follows ξ on its own: ċ = ω(ξ − c) ([Pratt 2006](https://www.semanticscholar.org/paper/Capture-Point:-A-Step-toward-Humanoid-Push-Recovery-Pratt-Carff/9d9aabdfd5b47862bdba0b9bb35711065b673418); [Englsberger 2013](https://elib.dlr.de/87255/1/IROS_2013_FinalSubmission_JEnglsberger.pdf)).
- The CMP is where the ground force would act if L stayed constant ([Popovic, Goswami & Herr 2005](https://www.researchgate.net/publication/221710011_Ground_Reference_Points_in_Legged_Locomotion_Definitions_Biological_Trajectories_and_Control_Implications)):

  r_cmp = r_cop + (1/mg)·[τ_y, −τ_x]

  Here τ is any torque about the COM: the gyro's, or the reaction to L̇ from swinging limbs. The gyro is therefore just a second, bounded way to move the CMP. `balance.ts` already treats it that way.

**Plan (every tick, from the measured ξ).** For step i with pressure point r_i and duration T_i, recurse backward from the last planned step ([Englsberger 2013](https://elib.dlr.de/87255/1/IROS_2013_FinalSubmission_JEnglsberger.pdf), eq. 18):

  ξ_eos,i−1 = r_i + e^(−ωT_i)·(ξ_eos,i − r_i)

Englsberger uses only the current step plus 3 ahead. For a stop, set the last r to the centre of the final stance.

For walking, split each step's pressure point from heel to toe (Atlas uses a 50/50 split, α_TH = 0.5; [Griffin 2017](https://arxiv.org/abs/1703.00477)). For fighting footwork, put it on the ball of the foot (+20–30% of the sole half-length).

**Feedback.**

  r_cmp,cmd = r_cmp,ref + (1 + k_ξ/ω)·(ξ − ξ_ref) + (k_i/ω)·∫_leaky(ξ − ξ_ref)

- This form is used by Englsberger (eq. 24) and on Atlas ([Griffin 2017](https://arxiv.org/abs/1703.00477), eq. 8–9).
- Position-controlled HRP-4 ships prop 5, integral 10, integrator time constant 10 s ([config](https://github.com/stephane-caron/lipm_walking_controller)). The stair paper used k_p 5, k_z 2 s⁻¹ ([Caron 2019](https://arxiv.org/abs/1809.07073)).
- With ω ≈ 3.3 that puts the error coefficient near 2.5. Start there and sweep 1.5–4.
- Englsberger reports robustness grows with shorter steps and larger k.
- For z̈ ≠ 0, use ω(t) = √((g+z̈)/z). Better: keep pelvis height within ±2 cm.

**Per-robot numbers.**
- h is derived from the m·g·h comments in `designs/index.ts`.
- Gyro reach is the DCM excursion beyond the sole that the gyro can absorb before saturating: Δ = (τ_max/mg)·(1 − e^(−ω·H/τ_max)). This comes from integrating ξ̇ with a constant CMP offset.

| Robot | COM height h | ω | 1/ω | Gyro reach | Full-torque time | Time to saturate at 30% |
|---|---|---|---|---|---|---|
| FIRECRACKER | 0.67 m | 3.82 | 0.26 s | 13.7 cm | 0.34 s | 1.14 s |
| SAVATE | 0.85 | 3.39 | 0.29 | 11.9 | 0.35 | 1.17 |
| PYLON | 0.95 | 3.21 | 0.31 | 12.7 | 0.34 | 1.13 |
| HAYMAKER | 0.92 | 3.26 | 0.31 | 12.9 | 0.35 | 1.16 |

**What this means.** Each gyro is worth about one extra sole half-length of COP authority for one ~0.35 s event. Then it needs ~1.2 s to bleed back to empty. It is an emergency reserve, never part of the gait.

---

## 3. Data flow at 500 Hz (a proposal for the control owner)

1. **Tactics and footwork, 10–30 Hz.** Output a footstep list (position, yaw, lift and land times) plus upper-body targets. When a clip drives the feet, take **only its footsteps and contact timing** from it, never its pelvis path as the COM reference.
   - [HuB](https://arxiv.org/abs/2505.07294) found retargeted human references infeasible because human and robot COMs differ. It drops frames whose ground-projected robot COM is more than 0.2 m from the support foot, pads double support by repeating the first and last frames, and tracks the lower body loosely.
2. **DCM plan every tick** from the measured ξ, using the recursion above. There is one plan in all modes: clip footwork, stance footwork, capture steps and skills. No resets on handoff.
3. **Step adjuster.** Solve for the next landing u_T, timing τ = e^(ωT) and DCM offset b ([Khadiv](https://arxiv.org/abs/1704.01271)):

   u_T = (ξ − u₀)·e^(−ωt)·τ + u₀ − b

   - Nominal offsets: b_x = L/(e^(ωT) − 1), b_y = ±l_p/(1 + e^(ωT)) − W/(1 − e^(ωT)).
   - The QP has 6 variables and box constraints for reach, no crossing and the cage. The viability constraint is soft with a heavy weight.
   - `walk.ts` already derives these offsets. Make this the only step placer for every mode.
4. **Swing speed-up** ([Griffin 2017](https://arxiv.org/abs/1703.00477)). Project ξ onto the plan to get ξ_p. Advance the reference by Δt = (1/ω)·ln(|ξ_p − r_ref| / |ξ_ref − r_ref|). Rescale the rest of the swing by σ = (T_ss − t)/(T_ss − t⁺), with a floor on swing time.
   - Atlas: step adjustment plus speed-up was always the most robust combination. It survived 1.92× body weight for 0.1 s in simulation. The QP took 80 µs and the whole algorithm 220 µs on an i7.
   - `hurrySwing` in `gait.ts` is a threshold version of this.
5. **CMP command** from the feedback law, plus angular-momentum feed-forward:
   - Measured: L = `subtree_angmom[root]`, L̇ filtered at ~20 ms.
   - Planned: L_clip(t), precomputed offline per clip with robot masses and stored as a table.
   - Pre-shift the COP by L̇_ff/(mg) so the move's reaction is cancelled before it happens.
6. **Allocation, in order:**
   - COP inside the support polygon shrunk by 1.5 cm, split between the feet (`footLoads` works, or a 12-variable wrench QP).
   - The remainder goes to the gyro as τ = mg·[Δ_y, −Δ_x], capped by τ_max and the momentum left in the rotor.
   - Anything still left triggers speed-up or step adjustment (steps 3–4).
7. **Joints.**
   - Stance legs: τ = qfrc_bias − Jᵀ·F, which `feedforward.ts` already computes, shifted into the servo target by τ/kp.
   - Pelvis height, torso attitude, swing foot and arms: IK as today.

**Delivering torque through a position servo.** Command q_target = q_meas + s·(q_des − q_meas) + τ_ff/kp + (kv/kp)·q̇_meas·(1 − d).
- With s = 0 and d = 0 the joint delivers exactly τ_ff and keeps its implicit damping (−kv·q̇). This is a clean torque mode with no explicit JS-side proportional-derivative (PD) torque, the thing that exploded before.
- `stanceYawCompliance` in `controller.ts` already uses this trick. Extend it:
  - stance ankles: s = 0, so they are pure COP actuators;
  - stance hip and knee: s ≈ 0.2–0.4;
  - swing leg: s = 1, stiff for accurate placement.

---

## 4. Recovery order, with explicit thresholds

This follows the ankle / hip / step partition of [Stephens 2007](https://www.researchgate.net/publication/224401381_Humanoid_Push_Recovery) and Englsberger's four mechanisms: project, step, move the COP, use angular momentum. Let d be the distance of the predicted ξ outside the support.

1. **d ≤ 0: ankles only.** Gyro only damps (next section).
2. **0 < d ≤ Δ_gyro · (1 − saturation): gyro takes the CMP remainder.** Mark the robot as not ready to strike.
3. **Mid-swing:** speed up the swing, then move the landing.
4. **Double support, d above ~2 cm:** capture step. [Koolen 2012](https://dl.acm.org/doi/10.1177/0278364912452762) gives the N-step capture regions for a pendulum with a finite foot and a reaction mass (the gyro). Prefer two quick small steps to one big one.
5. **Gyro saturated or damaged:** hip and waist bend (`strategies.ts`).
6. **Not capturable within 2 steps:** protective behaviour. Arms brace, the robot turns toward a hip or shoulder landing, and the get-up is pre-armed. This is the "protect themselves" part of Bodycam's pitch.

**Gyro law.** In [GyBAR](https://www.nature.com/articles/s41598-020-66760-w) tests, a pure viscous torso field (a 30 N·m·s/rad damper option; 16 kg, 53 N·m peak unit) doubled beam-walking distance, and "effective assistance did not require regulation to a reference posture."

For the robots:
- Drop the tilt and sole-roll stiffness terms. At most, keep them behind wide deadbands.
- Keep damping near 0.04–0.08·m·g·h s/rad.
- Bleed momentum only in double support, and only while the capture margin exceeds ~3 cm.

---

## 5. Impedance: soft stance, stiff swing

**Current stiffness versus Unitree's.**
- Unitree's G1 (35 kg) policy gains are hip 100, knee 150, ankle 40 N·m/rad, with damping 2–4 ([unitree_rl_gym](https://github.com/unitreerobotics/unitree_rl_gym/blob/main/legged_gym/envs/g1/g1_config.py)).
- Training pushes the robot every 5 s at up to 1.5 m/s.
- The project's hip kp is 757 N·m/rad on FIRECRACKER (38 kg) and ~4,600 on SAVATE.
- Scaled by m·g·h [est], that is roughly 6–14× stiffer than G1.

**What stiffness costs.** Stiff joints pass touchdown and punch impulses straight into the feet, which tips them onto their edges. Bent knees with moderate stiffness act as the shock absorber. EngineAI's T800 marketing stresses "shock-absorbing systems" alongside 450 N·m joints ([Interesting Engineering](https://interestingengineering.com/ai-robotics/china-t800-combat-humanoid-robot)).

**How the fighting humanoids stay up.** Their balance is learned: [Unitree G1 fighters](https://www.robotics247.com/article/video_unitree_g1_humanoids_compete_in_robot_combat_tournament_in_china) were trained with reinforcement learning, piloted by gamepad, and use mocap captured from professional fighters.

The transferable lessons:
- low impedance plus a fast feedback loop;
- practice under random pushes;
- attention to transitions between skills. [RPG 2026](https://arxiv.org/abs/2604.21355) targets exactly the locomotion-to-fighting-skill transitions.

---

## 6. Looking like a trained fighter (numbers to start from)

- **Constant pelvis height.** Hold the fighting crouch (`LEG_EXTENSION` 0.95 is about 36° of knee flexion) within ±1.5 cm. Cut `stepDip` to ≤2 cm and clip bob to ≤1.5 cm. [Griffin's straight-leg walking](https://arxiv.org/abs/1709.03660) shows height consistency and toe-off are what read as natural for walks.
- **Dynamic lift everywhere.** Let a foot lift as soon as the landing captures the body (`landingCaptures`), never "COM over the stance foot first".
  - Shuffle swing 0.15–0.25 s, double support 0.05–0.1 s, lift 1.5–3 cm.
  - For reference, humans clear the ground by only 1.29 cm when walking ([Winter 1992](https://pubmed.ncbi.nlm.nih.gov/1728048/)).
- **Walks.** Swing 0.3–0.4 s, lift 4–6 cm, heel-to-toe pressure roll, and land with a small downward velocity.
- **Step-drag entries.**
  - Advancing: the lead foot steps first while the rear foot's COP pushes at its toe; then the rear foot follows.
  - Retreating: the rear foot steps first.
  - The COM stays between the feet.
- **Width.** Stance width is now 0.8× hip offset, narrower than the hips. With dynamic stepping it can go to 1.0–1.2× in stance for lateral resistance to hooks, narrowing only in walks. [Hof's XcoM rule](https://www.researchgate.net/publication/5909208_The_'extrapolated_center_of_mass'_concept_suggests_a_simple_control_of_balance_in_walking): place the lateral foot a constant few cm outside the extrapolated COM.
- **Counter-rotation.** In walking, humans keep whole-body angular momentum near zero ([Herr & Popovic 2008](https://journals.biologists.com/jeb/article/211/4/467/18040/Angular-momentum-in-human-walking)). Arm swing cuts the vertical ground moment by 63% ([Collins 2009](https://pubmed.ncbi.nlm.nih.gov/19640879/)).
  - With the guard up, the chest has to do this instead. `YAW_TUNING.waistCounter` is 0 today.
  - Feed-forward: waist yaw rate ≈ −L_z,legs / I_z,upper, taken from `subtree_angmom` of the leg subtrees.
- **Anticipatory postural adjustments.** Humans pre-shift their posture ~100 ms before a limb movement to counter its reaction ([Piscitelli 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5316309/)).
  - Before a strike or kick, move the DCM reference and COP toward the move's reaction using L_clip and the COM trajectory.
  - Gate on remaining gyro reach. `readyToStrike` is already a gate.
- **Settled arrival.** End every approach with a DCM plan whose last pressure point is the stance centroid. Over the last two steps the body decelerates smoothly instead of stop-reset-rock.

---

## 7. Compute budget (per robot, per 2 ms tick, JavaScript) [est]

| Piece | Cost |
|---|---|
| DCM recursion (4 steps) + feedback | <1 µs |
| Step/timing QP (6 variables, active set) | ~5 µs |
| Read `subtree_angmom` (already computed) and table lookup of L_clip | ~0 µs |
| COP split / 12-variable wrench QP | 2–30 µs |
| Jᵀ·F on stance legs (existing `xaxis`/`xanchor` loop) | ~2 µs |
| **Total** | ≲40 µs → 2 robots × 500 Hz ≈ 4% of a core |

Physics today is ~95 µs per 1 ms step, about 9.5% of a core.

A full whole-body inverse-dynamics QP (36 joint accelerations + 24 contact forces) costs ~0.3–1 ms per solve in JS. At 500 Hz for two robots that is 30–100% of a core, so it is not worth it here. Caron's full HRP-4 cycle already takes 1.0±0.4 ms in C++. A centroidal allocation plus Jᵀ gets most of the benefit ([Orin, Goswami & Lee 2013](https://link.springer.com/article/10.1007/s10514-013-9341-4) for the theory). MuJoCo's `mj_angmomMat` (added in 3.1.3) gives the 3×nv angular-momentum matrix if an L task is ever needed.

---

## 8. Failure modes and how to test them

- **Where the pendulum model breaks:** jump kicks, spins and kip-ups. Switch to clip-driven centroidal feed-forward plus the gyro, and accept failure. That is the design intent.
- **Infeasible steps:** cage, opponent's feet, hip-yaw limits. Handle them as QP constraints, then fall back to the gyro or hip strategy, then protective falling.
- **Slip and yaw spin:** constrain |M_z| ≤ μ·F_z·r_eff. The yaw trick already addresses this.
- **Timing mismatch:** landings come early or late. Replan ξ from the measurement every tick, never by resetting the COM.
- **Windup:** a leaky integrator (T_i ~10 s) cannot wind up.
- **Delay versus gain:** softer ankles lower the usable k_ξ (Caron). Sweep the two together.
- **Harness:**
  - Pushes of 0.1 s at mid-swing, from 8 directions, at 0.25–1.0×mg, during shuffles and at the moment of arrival (Griffin's protocol).
  - Walk-into-range trials.
  - Metrics: self-falls per minute, gyro-saturation seconds, lurch (peak change in commanded CMP at mode switches), foot-edge-roll time.
  - Tune k_ξ, impedance shares, swing times and stance width with the existing cross-entropy tuner, the way [automatic gain tuning](https://arxiv.org/pdf/1610.02849) does for momentum controllers.

---

### Sources

- Bodycam: [80.lv](https://80.lv/articles/ultra-realistic-fps-bodycam-reveals-advanced-self-balancing-ragdolls), [wiki](https://bodycamgame.wiki/updates/locked-and-loaded/)
- Pendulum and step placement: [Pratt 2006](https://www.semanticscholar.org/paper/Capture-Point:-A-Step-toward-Humanoid-Push-Recovery-Pratt-Carff/9d9aabdfd5b47862bdba0b9bb35711065b673418), [Englsberger 2013](https://elib.dlr.de/87255/1/IROS_2013_FinalSubmission_JEnglsberger.pdf), [Koolen 2012](https://dl.acm.org/doi/10.1177/0278364912452762), [Kajita 2003 preview control](https://www.researchgate.net/publication/4041375_Biped_walking_pattern_generation_by_using_preview_control_of_zero-moment_point), [Khadiv](https://arxiv.org/abs/1704.01271)
- Atlas and HRP-4 controllers: [Griffin 2017](https://arxiv.org/abs/1703.00477), [Griffin straight-leg](https://arxiv.org/abs/1709.03660), [Caron 2019](https://arxiv.org/abs/1809.07073), [lipm_walking_controller](https://github.com/stephane-caron/lipm_walking_controller)
- Push recovery: [Stephens 2007](https://www.researchgate.net/publication/224401381_Humanoid_Push_Recovery), [SURENA-Mini position-control push recovery](https://arxiv.org/abs/1710.10598)
- Angular momentum and centroidal dynamics: [Popovic 2005](https://www.researchgate.net/publication/221710011_Ground_Reference_Points_in_Legged_Locomotion_Definitions_Biological_Trajectories_and_Control_Implications), [Orin 2013](https://link.springer.com/article/10.1007/s10514-013-9341-4), [MuJoCo API](https://mujoco.readthedocs.io/en/stable/APIreference/APIfunctions.html)
- Gyroscopic balance: [GyBAR](https://www.nature.com/articles/s41598-020-66760-w)
- Learned fighting humanoids: [HuB](https://arxiv.org/abs/2505.07294), [RPG](https://arxiv.org/abs/2604.21355), [unitree_rl_gym G1](https://github.com/unitreerobotics/unitree_rl_gym/blob/main/legged_gym/envs/g1/g1_config.py), [G1 tournament](https://www.robotics247.com/article/video_unitree_g1_humanoids_compete_in_robot_combat_tournament_in_china), [T800](https://interestingengineering.com/ai-robotics/china-t800-combat-humanoid-robot)
- Human gait and posture: [Herr & Popovic 2008](https://journals.biologists.com/jeb/article/211/4/467/18040/Angular-momentum-in-human-walking), [Collins 2009](https://pubmed.ncbi.nlm.nih.gov/19640879/), [Hof XcoM](https://www.researchgate.net/publication/5909208_The_'extrapolated_center_of_mass'_concept_suggests_a_simple_control_of_balance_in_walking), [Winter 1992](https://pubmed.ncbi.nlm.nih.gov/1728048/), [Piscitelli 2016](https://pmc.ncbi.nlm.nih.gov/articles/PMC5316309/)