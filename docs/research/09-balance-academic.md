# Balance research: academic

**Key techniques:**
- SIMBICON balance feedback θd = θd0 + cd·d + cv·v (cd=0.5, cv=0.2) with world-frame torso and stance-hip torque τA = −τtorso − τB
- Reference-relative swing-hip and stance-ankle feedback plus contact-synchronized clip warping (Lee, Kim, Lee 2010)
- Inverted-pendulum foot placement d = v·√(h/g + v²/4g²), α=0.05, plus Jacobian-transpose velocity tuning (kV=100 N·s/m at 70 kg) and gravity compensation (Coros 2010)
- Centroidal momentum control of COM and COP: L̇des, Ḣdes = (pdes − c) × (L̇des − mg), least-squares on joint accelerations then inverse dynamics (Macchietto 2009)
- Balance-aware clip time warp from the implied COP: r_bal = √(margin/|Δp₁|)
- Inverse-dynamics feed-forward (mj_rne, 2.3 µs) delivered as servo target shift τ/kp, then lower stance-leg kp
- Gyro feed-forward from reference angular momentum (−Ḣ_ref) instead of dead-band-only reaction
- Feature-based prioritized control: balance features outrank style tracking (de Lasa 2010)
- SAMCON offline repair of PD-target offsets per 0.1 s window, optional per-fragment linear feedback a = M·s + â (Liu 2010/2016)
- Stable PD analysis: redundant under MuJoCo implicitfast; clamped actuators lose implicit damping (actuatorDerivSkip)
- Push-matrix robustness protocol (SIMBICON 10 pushes/0.1 s; Liu +10 N ladder) with a stance-leg saturation metric
- Momentum-mapped inverted pendulum for dynamic mocap (Kwon & Hodgins 2017) and goal-directed momentum stepping (Wu & Zordan 2010)

## Summary

The classic no-learning literature on simulated characters agrees on a small set of methods. The fighters are missing four of them:

1. **Continuous, reference-relative foot-placement feedback on every step.** The placement is recomputed every tick while the foot swings. Sources: SIMBICON, Coros 2010, Lee 2010.
2. **Clip timing synchronized to real foot contacts.** Source: Lee 2010.
3. **Feed-forward torques, so the feedback servos stay unsaturated and low-gain.** Sources: SIMBICON feedback-error learning, Macchietto 2009.
4. **A centroidal angular-momentum reference for kicks and spins.** Source: Macchietto 2009.

For truly flashy moves (spin and jump kicks, kip-ups), the only published way to make them robust without learning is to repair the PD targets offline by sampling. That is SAMCON (Liu 2010 and 2016), and it fits position servos exactly.

Measured today: a planted leg has a servo pinned at its torque limit for **18–28 % of all standing time**, and for **70–83 % of kick phases**. More than 90 % of those samples are at full stall torque, not at a speed- or heat-reduced limit. So the joints are often in a bang-bang regime, where they push at maximum torque with no proportional control. That is a plausible mechanical explanation for "clunky and off balance".

## 1. What the code does now, and what I measured

**Current control chain (read from the working tree):**
- `balance.ts`: an ankle strategy that shifts the pelvis target by `ka·a_plan − kp·e − kd·ė` (`kp=1`, `kd=0.6 s`), a gravity feed-forward that places the centre of pressure at `p = c − a/ω₀²`, and a gyro demand driven by the capture point.
- `stepping.ts`: capture steps. It also re-aims a swing (`adjustSwing`), but **only once the capture point has left the stance sole**.
- `feedforward.ts`: static gravity compensation `τ = qfrc_bias − JᵀF`, plus velocity feed-forward, both delivered as target shifts `τ/kp`.
- `mocap/footwork.ts`: steps and the centre-of-mass (COM) reference come from the clip, and the reference is re-anchored at every touchdown.
- **Not used anywhere:** angular momentum. `data.subtree_angmom` is computed every step by the existing `mj_subtreeVel` call and never read.
- **Gyro dead-bands:** 0.16 rad of tilt and 0.15 rad/s of rate. The gyro only reacts, never anticipates.

**Servo gains** (`humanoid.ts`): `kp = τ_stall / 0.07 rad` (0.1 rad for ankles) and `kd = 0.045·kp`. So every servo reaches stall torque at **4°** of error (5.7° for ankles).

| Robot | Hip / knee kp (N·m/rad) | Stall torque |
|---|---|---|
| FIRECRACKER | 757 / 1,714 | hip 53 N·m |
| SAVATE, PYLON | 4,614 | 323 N·m |
| HAYMAKER | knee 6,921 | knee 485 N·m |

For comparison, the published characters use far lower gains:
- SIMBICON: kp ≤ 300 (1,000 at the waist), kd = 0.1·kp, for a human-sized model.
- Liu 2016: kp 500, rising to 1,000 on the legs and 2,000 on the waist for stunts, on a 62 kg model.
- Coros 2010: kp simply scaled with body mass.

**Probe.** I ran a read-only probe: two 30 s headless fights on the uncommitted working tree with the sparring stand-in brain. Script: `/private/tmp/claude-501/-Users-chrisdimarco-jarvis/35a12cda-55d8-4dbe-b6de-87829408a2a0/scratchpad/bench/probe.mts`.

| Robot (fight, seed) | Planted-leg servo at limit (% of standing time) | Single support | Kick ("skill") phase | Falls in 30 s |
|---|---|---|---|---|
| SAVATE (vs HAYMAKER, seed 1) | 23.4 % | 17.9 % | 70 % | 1 |
| HAYMAKER | 18.3 % | 8.8 % | 69 % | 0 |
| FIRECRACKER (vs PYLON, seed 2) | 27.9 % | 27.6 % | 83 % | 2 |
| PYLON | 27.0 % | 22.9 % | 71 % | 2 |

- The joints hitting the limit most are hip pitch, hip roll and knee.
- Falls are not split into self-inflicted versus hit.
- In both fights `ClipFootwork` never became active: all ground was covered by `planStep` and capture steps. Another agent is editing this code right now, so treat this as a snapshot.

**MuJoCo detail that matters here.** In MuJoCo 3.x, `actuatorDerivSkip` leaves an actuator out of the implicit damping step when its force is at `forcerange` ([engine_derivative.c](https://github.com/google-deepmind/mujoco/blob/main/src/engine/engine_derivative.c)). So a pinned servo is a constant-torque source with no damping. Stiff servos that keep switching between clamped and linear are a likely source of chatter. `humanoid.ts` already notes this for the ankles.

## 2. Technique by technique

| Technique | What it needs | Robustness reported | Cost in JS, 2 robots at 500 Hz | Fit with position servos |
|---|---|---|---|---|
| SIMBICON (Yin 2007) | Phase state machine, target poses, 2 gains per plane | Walk survives 600 N fwd / 500 N back for 0.1 s at every phase | Negligible (a few dot products) | Native: it only moves PD targets |
| Coros 2010 | Pendulum foot placement, swing IK, Jᵀ virtual forces | 600 N omnidirectional for 0.1 s at 0.6 m/s, 70.4 kg, no per-character tuning | One COM Jacobian per robot per tick, about 2–3 µs | Native; the forces become τ/kp target shifts, as `feedforward.ts` already does |
| Data-driven biped (Lee 2010) | Mocap stream, 7 gains, contact-segmented clips | 160/130/80/105 N for 0.4 s; less than SIMBICON | Negligible | Native: it rewrites the reference |
| Momentum control (Macchietto 2009) | Centroidal momentum matrix, least-squares solve on accelerations, inverse dynamics | Standing balance under large pushes, side kick while holding a cup; no stepping | Estimated 60–100 µs per solve per robot; at 100 Hz about 2 % of a core | Works through inverse-dynamics torques as target shifts, **only while servos are unsaturated** |
| Feature-based (de Lasa 2010) | A stack of prioritized QPs | Balancing, standing jump, walking; arm swing and heel-off emerge on their own | Estimated 0.2–1 ms per solve per robot | Same as above, and harder to build |
| SAMCON (Liu 2010) plus linear feedback (Liu 2016) | Offline sampling of PD-target offsets per 0.1 s window | Kick 260 N, dance-spin 230 N, run 470 N (0.1 s pushes) | **Offline**: 21–314 min per skill on 20 cores. **Runtime**: an 11×18 matrix times a vector every 0.1 s | Exact fit: its output *is* PD targets |
| Stable PD (Tan 2011) | Implicit PD formulation | Tracks mocap stably at 33 ms steps | Zero here | Already given by MuJoCo's `implicitfast` integrator |

### SIMBICON ([PDF](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf))

- **Swing-hip balance law:** `θd = θd0 + cd·d + cv·v`, where d is the COM distance from the stance ankle and v is COM velocity. It is applied in both the sagittal and coronal planes.
- **Torso and stance hip:** the torso and swing hip are servoed in the world frame, and the stance hip takes the rest: `τA = −τtorso − τB`.
- **Gains:** the 3D walk uses `cd = 0.5`, `cv = 0.2`. The stable sagittal ranges are wide: cd from −0.71 to 1.4, cv from 0.03 to 0.59.
- **Feedback-error learning:** a table of feed-forward torques per phase bin, capped at `0.2 rad × kp`. It cut 2D torso wobble from 5° to 0.5°. After it, feedback supplied only 2.5–14 % of the torque energy (0.5–25 ms bins).
- **Limitation the authors state:** motions with flight phases depend on reaching specific linear and angular momentum at take-off, and this feedback does not provide it. That covers tornado and jump kicks.

### Coros 2010 ([paper](http://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/paper.pdf))

- **Foot placement:** `d = v·√(h/g + v²/4g²)`, then `d′ = d − α·Vd` with `α = 0.05`. The step is capped at 0.6 × leg length, and the placement is updated every time step.
- **Velocity tuning:** `F_V = k_V(Vd − V)` with `k_V = 100 N·s/m`, applied as `τ = J_Vᵀ F_V` through the joints from the stance foot to the head. The ankle term is zeroed if the foot starts to roll.
- **Gravity compensation:** `Σ J_iᵀ(−m_i g)`.
- **Gains:** kp scaled by mass ratio; kd ≈ 2√kp (the PDF text is garbled at this point).
- **For our robots:** `h/g` gives 1/ω₀ of about 0.27–0.33 s, so for small v the formula is essentially the capture point.

### Lee, Kim, Lee 2010 ([PDF](https://mrl.snu.ac.kr/research/ProjectDataDrivenBiped/DataDrivenBipedControl_2010.pdf))

This is the closest match to "mocap moves that stay balanced".

- **Swing hip:** `θswing = θref + [c1(vd − v) + c2(dd − d)]·s(t)`, where vd and dd are the **reference's** COM velocity and position.
- **Stance ankle:** `θankle = θref + [c3(vd − v) + c4(dd − d)]·s(t)`.
- **Stance hip:** `c0 = 1` toward the reference pelvis orientation.
- **Swing-foot height:** its own feedback, `c5 = 0.5`, `c6 = 0.02`.
- **Gains used:** c1 of 0.05–0.2, c4 = 0.1.
- **Rates:** tracking at 900 Hz, modulation at 30 Hz.
- **Synchronization:**
  - Early touchdown: drop the rest of the clip segment and warp the next one by the pose error. The blend runs over a half cycle, except the stance ankle, which blends over 1/5 of it.
  - Late touchdown: extend the swing at constant velocity with the stance leg frozen.
- **Ablations:**
  - Without synchronization the character falls in 3–6 steps.
  - Without stance-hip feedback it falls in 2–4 steps.
  - Without swing-hip feedback it falls in 6–10 steps.
- **Spins and U-turns:** these needed careful tuning, and d and v had to be measured along the direction of travel rather than in sagittal/coronal planes.

### Macchietto, Zordan, Shelton 2009 ([PDF](https://www.cs.ucr.edu/~cshelton/papers/docs/balance09.pdf))

- **Linear momentum target:** `L̇des = kl·m(cr − c) − dl·L`.
- **Centre of pressure (COP) target:** `p̈des = kh(pr − p) + dh(ṗr − ṗ)`.
- **Angular momentum target:** `Ḣdes = (pdes − c) × (L̇des − mg)`.
- **Solve:** a weighted least-squares problem on joint accelerations for tracking, linear and angular goals, with the feet held still as the only constraints. Then inverse dynamics.
- **Rates:** optimization at 60 Hz, torque loop at 1–10 kHz.
- **Result that matters for us:** a side kick **failed without the angular-momentum objective**.
- **Limits:** motions that are too energetic get slowed and lose style, and there is no stepping.

### de Lasa 2010 ([ACM](https://dl.acm.org/doi/10.1145/1778765.1781157))

It controls features (COM, angular momentum, end-effectors) under strict priorities. What transfers to us is the priority idea: balance features outrank style tracking.

### SAMCON and control graphs ([2010](https://www.cs.ubc.ca/~van/papers/2010-TOG-sampControl/2010-TOG-samcon.pdf), [2016](https://www.cs.ubc.ca/~van/papers/2016-TOG-controlGraphs/index.html))

- **SAMCON 2010:**
  - 0.1 s windows, 1,400 samples per window on 80 cores, cost weights 8/5/20/20 (pose, root, end-effector, balance).
  - Failure-rate example: one get-up failed two-thirds of the time; raising samples from 1,400 to 4,000 cut that to a quarter.
- **Control graphs 2016:**
  - Linear feedback `a = M·s + â` per 0.1 s fragment.
  - State s (18 numbers): root orientation (2), root height, COM position and velocity, COM-to-feet vectors, angular momentum.
  - Action a (11 numbers): target offsets for waist, hips and knees.
  - Offline learning time: kick 94 min, dance-spin 102 min on 20 cores.
  - The kick survived 400 N × 0.2 s pushes during flight.

### Stable PD ([PDF](https://faculty.cc.gatech.edu/~turk/my_papers/stable_pd.pdf))

- Formula: `τ = −kp(q + Δt·q̇ − q̄) − kd(q̇ + Δt·q̈ − q̄̇)`, stable when `kd ≥ kp·Δt`.
- MuJoCo's position actuator under `implicitfast` already makes the `kd·Δt·q̈` term implicit. The only SPD term missing is `kp·Δt ≈ 0.022·kd`, which is negligible.
- **Not worth building** unless the timestep goes to 2–5 ms.

### Also relevant, not covered in depth

- **Zordan & Hodgins 2002** ([link](https://www.semanticscholar.org/paper/Motion-capture-driven-simulations-that-hit-and-Zordan-Hodgins/8639de4f0a209a740ef1c5949bf4d854275cd743)): mocap boxing with a separate lower-body balance controller; hit reactions by lowering gains. SIMBICON criticizes that low-gain moment as implausible. For "competent" fighters, don't go limp on impact.
- **Kwon & Hodgins 2017** ([link](https://www.semanticscholar.org/paper/Momentum-Mapped-Inverted-Pendulum-Models-for-Human-Kwon-Hodgins/5537658fda471b0f2c8cf54315808c13c8193e78)): a momentum-mapped inverted pendulum extracted from mocap, replanned every frame, for walking, running and gymnastics.
- **Wu & Zordan 2010** ([link](https://graphics.cs.ucr.edu/projects/step10/step.html)): momentum-based stepping, with a supervisor that decides when and where to step.
- **Muico 2009** ([PDF](https://grail.cs.washington.edu/projects/nqr/resources/Home/Contact-aware-Nonlinear-Control-of-Dynamic-Characters/muico-2009-cnc.pdf)): NQR (nonlinear quadratic regulator) control that plans through contact changes. Needs model derivatives, which makes it heavy.
- **Hämäläinen 2015** ([C-PBP](https://mediatech.aalto.fi/publications/graphics/C-PBP/)): online sampling MPC for recovery. The existing MPC notes (`docs/research/unimate-read-training-free.md`) already cover this family.

## 3. Recommended balance stack

All six steps run at 500 Hz, per robot, in order. Nothing here is learned. Everything stays in native MuJoCo servos as target shifts.

### Step 1: Reference state

Offline in Node, per design and per clip, run `mj_kinematics`, `mj_comPos` and `mj_subtreeVel` on the retargeted poses. Store per frame:
- COM position and velocity: `c_ref`, `ċ_ref`;
- centroidal angular momentum and its rate: `H_ref`, `Ḣ_ref`;
- the COP the clip implies at playback rate 1:
  - `Δp₁,x = −(z_c/g)·c̈x − Ḣy/(mg)`
  - `Δp₁,y = −(z_c/g)·c̈y + Ḣx/(mg)`

Online, the measured angular momentum H is `data.subtree_angmom[root]` and costs nothing extra.

### Step 2: Balance-aware time warp

Implied accelerations and `Ḣ` both scale with rate², so the implied COP offset scales as `r²·Δp₁`. That gives a closed-form cap:

`r_bal = √(margin_to_support_edge / |Δp₁|)`

Then play at `r = min(r_motor, r_bal, r_intent)`. This does cheaply what Macchietto's optimizer does implicitly: slowing a move that would tip the robot, instead of letting it fall. Apply the same kind of cap to torque headroom on the stance legs (see step 6).

### Step 3: Contact-synchronized phase

Adopt Lee 2010's timing rules exactly:
- Advance the clip phase on touchdown events.
- Early landing: warp the next fragment with a smooth blend over the half cycle; the stance ankle blends over 1/5 of it.
- Late landing: extrapolate the swing leg and freeze the stance leg.

### Step 4: Continuous balance modulation, relative to the reference

- **(a) Swing landing, in Cartesian terms, every tick until about 70 % of the swing:**
  - `Δx_land = k_v(v − v_ref) + k_d(d − d_ref)`
  - Start with `k_v = 1/ω₀` (about 0.27 s for FIRECRACKER, 0.31–0.33 s for the others) and `k_d = 0.5–1.0`.
  - SIMBICON's equivalent gains are about half of capture-point strength. That spreads recovery over two steps and looks smoother.
  - Add Coros's `−α·V_d` offset, `α = 0.05`.
  - This **replaces** the current threshold-triggered re-aim, which lets small errors grow for an e-folding time of about 0.3 s before it reacts.
- **(b) Stance ankle and pelvis shift:** keep the existing law but use reference-relative errors (Lee `c3 = c4 = 0.1`).
- **(c) Velocity-tuning virtual force (Coros):** `F_V = k_V(v_ref − v)`.
  - Scale k_V as `100 × m/70.4`: FIRECRACKER 54, PYLON 113, SAVATE 118, HAYMAKER 150 N·s/m.
  - Limit it to what the COP can hold: `|F_V| ≤ mg·(edge distance)/z_c`.
  - Deliver it as `τ = Jᵀ F_V` using `mj_jacSubtreeCom`, then shift targets by `τ/kp`.
- **(d) Angular momentum:**
  - Waist and arm offsets `∝ (H_ref − H)`. Macchietto got useful arm windmilling by lowering the arm tracking weights.
  - Add `−Ḣ_ref` as gyro feed-forward, so the gyro anticipates spins instead of waiting past its 9° dead-band.
  - The gyro is also the only honest way to adjust attitude during the flight phase of a jump kick.

### Step 5: Inverse-dynamics feed-forward

- Set the reference acceleration q̈_ref on a scratch MjData and run `mj_rne` (`flg_acc=1`).
- Subtract the planned contact wrench, split between the feet by the existing `footLoads` COP split: `τ_ff = ID(q, q̇, q̈_ref) − Σ J_footᵀ F_foot`.
- Clamp to the available torque minus headroom. Target: `q̄ + τ_ff/kp + (kd/kp)·q̇_ref`.
- Only then run an A/B test lowering stance-leg kp by 2.5–4×, so stall comes at 10–15° of error instead of 4°, with kd kept near critical damping.
- The literature consistently pairs feed-forward with low feedback gains (SIMBICON, Macchietto, Lee).

### Step 6: Saturation guard

If `|τ_ff| + kp·|e|` on a planted joint would exceed its available torque, lower r (slow the clip). Don't let the joint pin at stall.

### Budget and rollout

- Steps 1–6 cost an estimated under 30 µs per robot per tick. Macchietto's full solve is an optional later layer at 100 Hz.
- For the flashy set (tornado and jump kicks, kip-ups, spinning back fist), run SAMCON offline in Node with the real motor model, and ship per-design target-offset tables.
- Open-loop SAMCON is trajectory optimization, not a policy. The Liu 2016 regression feedback is a gray area under the "no trained policies" rule, so Chris decides on that part.
- Rough SAMCON cost: one robot costs about 40 µs per 1 ms step (inference from 73 µs for two). One 1.6 s clip pass is 16 windows × 1,400 samples × 100 steps ≈ 90 s on one core. Full guided refinement is roughly 30–60 min per clip on 8 cores.

### Acceptance test

Build a push matrix using SIMBICON's protocol (10 pushes, 0.1 s each, spread across all phases) and Liu's (raise force by 10 N until failure over 20 cycles). Run it in 8 directions against guard idle, shuffle, walk, jab and kick.
- **Target:** survive 60 N·s (SIMBICON's 600 N × 0.1 s) on the 80–105 kg robots when not kicking, and at least 25 N·s mid-kick. Measured strike impulses are p90 30–50 N·s, max about 73 N·s.
- **Also track:** stance-leg saturation below 5 % outside strikes (today 18–28 %).

## 4. Failure modes to watch

- **Frame choice in spins:** Lee measured d and v along the direction of travel for turns and spins. Fixed sagittal/coronal planes destabilized them.
- **Unexpected contact:** a scuffed swing foot causes an early resync and instability. Keep swing-height feedback (`c5 = 0.5`, `c6 = 0.02`).
- **Toe roll from virtual forces:** Jᵀ forces can tip a foot onto its toe. Zero the ankle component when the sole isn't flat (Coros). The existing `soleRoll` is the detector.
- **Inverse dynamics under clamping:** ID torques are only realized while unsaturated. Damage changes mass (already refreshed every 0.25 s), but ID won't model lost parts inside the 0.25 s refresh interval.
- **Momentum control can't step:** it slows energetic moves and needs stepping to catch big disturbances.
- **SAMCON is brittle to model changes** (damage, a new kit). Re-run it after design edits. Its sampling is random and can fail. Rollouts must include the torque-speed, heat and battery model, or the result won't transfer.
- **Flight phases:** no amount of stance feedback fixes a jump that left with the wrong momentum. Plan take-off momentum from `H_ref`.

## 5. Compute, measured

Node 26 on this Mac, MuJoCo 3.14 WASM, 2-robot scene (70 generalized velocities, 46 actuators):

| Call | Cost | Notes |
|---|---|---|
| `mj_step` | 72–77 µs | about 7.5 % of a core at 1 kHz |
| `mj_rne` with acceleration | 2.3 µs | |
| `mj_inverse` | 29–31 µs | |
| `mj_jacSubtreeCom` | 1.8–2.8 µs | |
| `mj_kinematics` + `mj_comPos` | 2.8–3.0 µs | |
| `mj_forward` | 72.5 µs | |
| `setState` + step (rollout) | 46.5 µs | |

- **Stack in section 3:** under 1 % of a core for both robots (estimate).
- **Macchietto solve at 100 Hz:** about 2 % (estimate).
- **de Lasa QP stack at 100 Hz:** 4–20 % (estimate).
- **Online sampling:** only viable event-triggered.

## 6. Bodycam

Nothing technical has been published. The 80.lv article only says the system is "fully procedural" and that operators "fight to recover balance" ([80.lv](https://80.lv/articles/ultra-realistic-fps-bodycam-reveals-advanced-self-balancing-ragdolls)). Reissad's own v0.8 notes (2 Sep 2026) say they "Added stumbling logic to ragdoll reactions" and call stumbling "still an early system" ([Steam news](https://store.steampowered.com/news/app/2406770)). The academic line above (PD-to-pose, COM over the feet, stepping, momentum) is the public foundation for this kind of behaviour.