# UniMate reader: training-free

**Headline:** Training-free, browser-first robot fighting is feasible: borrow UniMate's topology math (not its network), drive every build with procedural controllers plus event-triggered sampling MPC in MuJoCo WASM workers, and let Jev set objectives, stiffness and tactics. Two robots fit on a 4-core laptop at 500-1000 Hz if MPC runs only when needed.

## Key facts
- MJPC Predictive Sampling (Howell et al. 2022) gets a 27-DoF humanoid up off the floor with N=10 rollouts, 3 spline knots, T=23 steps (0.35 s horizon at 0.015 s), sigma=0.125. Planning took 1-20 ms per update on CPU. The quadruped task uses a hand-written gait phase table inside the cost, so MPC with a procedural CPG needs no training.
- CPU sampling MPC is proven on hardware: MPPI with 30 rollouts x 40 steps (0.4 s) replanning at 100 Hz on an i9 drove a real Go1 with no offline training. Judo's CEM/MPPI/Predictive Sampling ran in 4-50 ms per plan on a 10-thread ThinkPad laptop.
- The official @mujoco/mujoco WASM package has a single-threaded build that needs no headers and an /mt build that needs COOP same-origin plus COEP require-corp. Its bindings are WIP; only core APIs such as mj_step are well tested. I found no public browser demo of MPC on MuJoCo WASM.
- For rollouts, run K Web Workers, each with its own single-threaded MuJoCo instance, and post state arrays to them. This avoids cross-origin isolation. General WASM runs 45-55% slower than native on average (peak 2.08-2.5x), and a native humanoid step is about 81 us single-thread in one testspeed report.
- UniMate's reusable part is math, not the network. Its topology_utils.py computes relation codes (self/parent/child/sibling/no_relation/end_effector), BFS hop distance clamped at 5, joint depth, and 8 sym-normalized Laplacian eigenvectors. SignNet exists because eigenvector signs are arbitrary. The model outputs kinematic motion, admits foot sliding and penetration, was trained on creatures, and pins CUDA 12.4 / Python 3.10.
- Training-free controllers that generalize across bodies: SIMBICON (4-state FSM, world-frame torso and swing hip, feedback theta_d = theta_d0 + c_d*d + c_v*v); Coros 2010 (J-transpose virtual forces plus inverted-pendulum foot placement, no per-character tuning); Raibert's foot placement x_f = xdot*Ts/2 + k(xdot - xdot_d) with virtual legs for any leg count; Spore's leg groups, rational length-ratio gait harmonization and particle IK at about 0.2 ms per 25-body creature.
- Physics-derived balance needs no training: MuJoCo's official LQR notebook balances the humanoid on one leg from inverse dynamics plus finite-difference derivatives. C-PBP shows that sampling joint target velocities plus force limits for 5 bone groups (N=32, 1.2 s horizon) gives 20-30 fps humanoid control on a 6-core CPU.
- Real stabilizers are buildable parts: the Cubli balances a 15 cm cube on a corner with three reaction wheels (50 W Maxon EC-45 flat each) under LQR and jumps up by braking the wheels. MuJoCo 3.7 added a dcmotor actuator and 3.12 added a pid actuator, so current and power draw can come from the physics. By my arithmetic, a reaction wheel buys about 0.5 s of stepping time rather than replacing stepping.
- Browser budget for two robots (estimate): the authoritative sim costs 9-40% of one core at 1000 Hz (5-20% at 500 Hz). Continuous 20 Hz MPC costs 0.3-2.2 cores per robot, so MPC should be event-triggered (get-up, recovery, clinch). Jev look-ahead rollouts cost 5-40% of a core. That fits a 4-core laptop.

# Training-free motion for user-built fighting robots in the browser

**Scope.** Chris's constraints apply throughout: no GPU training or fine-tuning, it must run in any browser, and Jev is the mind but never outputs torques. **[paper/code]** marks what a primary source actually says. **(inference)** marks my own reasoning or arithmetic. I did not run anything. Every browser number is an estimate until someone benchmarks it (see the budget section).

## 0. The answer on UniMate

**What it is [paper/code].** UniMate outputs *kinematic* motion. It uses flow matching: a fixed-step Euler solver integrates a learned velocity field, and it has 8 transformer blocks at hidden size 512. Attention is factorized: one branch runs across joints within each frame, the other across frames for each joint. Topology only enters the joint branch, in two ways:
- a per-head bias built from embeddings of pairwise relation codes and graph (hop) distance;
- "Spec-RoPE": rotary angles computed by an MLP from graph Laplacian eigenvectors, made sign-invariant with SignNet ([arXiv 2609.05415](https://arxiv.org/html/2609.05415)).

**What the code actually computes [code]** ([topology_utils.py](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/utils/topology_utils.py)):
- relation codes {self, parent, child, sibling, no_relation, end_effector};
- BFS hop distance, clamped at `max_path_len=5`;
- joint depth;
- the first 8 non-trivial eigenvectors of the *symmetric-normalized* Laplacian, zero-padded.

The paper's text describes the combinatorial Laplacian `diag(A1) − A`. That is a small paper-versus-code mismatch.

**Per-frame features [paper].** Each joint gets 12 values: position (root global, other joints root-relative in a "facing-canonical" frame), a 6D rotation, and a velocity.

**Limitations its authors admit [paper].** Foot sliding, hovering and ground penetration, because there is no contact model. Results degrade on rare topologies. The training data (Truebones, Mixamo, Objaverse-XL) is organic creatures plus "articulated rigid objects".

**Running it on Chris's Mac [code].** The [requirements file](https://raw.githubusercontent.com/Friedrich-M/UniMate/main/requirements.txt) pins Python 3.10, `torch==2.5.1+cu124` and `bpy==4.0.0`. Nothing mentions MPS or CPU. Parameter count and Euler step count are not published.

**Verdict (inference).**
- **The math is the real value.** All of these descriptors are cheap to compute in TypeScript when a build is saved: relation codes, hop distances, the Laplacian spectrum, and the facing-canonical frame. They drive symmetry pairing, limb roles and gait phasing (section 3).
- **The weights are an optional flavor layer.** They are kinematic, trained on creatures, and pinned to CUDA. Porting would mean patching the CUDA pins for macOS and forcing a CPU or MPS device, which is untested. Two uses fit the constraints:
  - Precompute taunt/idle clips offline on the M3 Max for a fixed set of template chassis, then retarget them Spore-style.
  - Later, try exporting the denoiser to ONNX/WebGPU, with text embeddings precomputed for a fixed move vocabulary so FLAN-T5 never ships.
- **Never put it in the combat control loop.**

## 1. (a) Sampling MPC with the simulator as the model

### MJPC (Howell et al. 2022) [paper]
[arXiv 2212.00541](https://arxiv.org/abs/2212.00541).

- **Algorithm.** Predictive Sampling is plain random search over spline knots (zero, linear or cubic interpolation). Each iteration evaluates the nominal plan plus N−1 Gaussian perturbations and keeps the best one. The planner runs asynchronously from the agent.
- **Settings (Appendix Table 1).**

  | Task | Knots P | Rollouts N | Steps T | Noise σ |
  |---|---|---|---|---|
  | Humanoid | 3 | 10 | 23 | 0.125 |
  | Quadruped | 3 | 10 | 35 | 0.25 |
  | Hand | 6 | 10 | 25 | 0.1 |

- **Speed.** Every example planned in 1–20 ms per update on a single CPU. The machines were a 72-core Xeon, plus experiments on a 16 GB M1 Pro MacBook.
- **Behaviors.** The 27-DoF, 21-actuator humanoid stands up from the floor and gets back up after knockdowns. The Unitree A1 climbs slopes and rolls off its back to stand.
- **Planner menu.** The repo now ships Sampling, Gradient, iLQG, iLQS, Robust Sampling, Cross Entropy and Sample Gradient ([include.cc](https://raw.githubusercontent.com/google-deepmind/mujoco_mpc/main/mjpc/planners/include.cc)).
- **Humanoid-stand task.** Horizon 0.35 s at a 0.015 s agent timestep ([task.xml](https://raw.githubusercontent.com/google-deepmind/mujoco_mpc/main/mjpc/tasks/humanoid/stand/task.xml)).
- **Quadruped task.** It uses iLQG with a 0.35 s horizon at 0.01 s. The key detail is a hand-written gait clock *inside the cost* ([quadruped.h](https://raw.githubusercontent.com/google-deepmind/mujoco_mpc/main/mjpc/tasks/quadruped/quadruped.h)):
  - phase offsets per foot (FL/HL/FR/HR): walk {0, .75, .5, .25}, trot {0, .5, .5, 0};
  - per-gait duty ratio, cadence and step amplitude.

  This is a procedural CPG fused with MPC, and it needs no training.
- **Relevance to Jev.** Section 5.3 of the paper proposes a high-level agent on top of the predictive controller. In that setup, "the actions of the high-level agent have the semantics of setting the cost function". That is the Jev layer.

### Other CPU results [paper]
- **Whole-body MPPI on a real Unitree Go1** ([Alvarez-Padilla et al. 2024](https://arxiv.org/abs/2409.10469)): 30 rollouts × 40 steps (0.4 s at 0.01 s), replanning at 100 Hz on an i9-12900KS. Controls are cubic splines, and gains plateau at about 40 samples. It is the first hardware deployment of whole-body sampling MPC, with no offline training.
- **iLQR with MuJoCo finite-difference derivatives** ([Zhang et al. 2025](https://arxiv.org/html/2503.04613v3)) on Go1/Go2 and the H1 humanoid: horizon 0.35–0.5 s, about 50 Hz policy updates (10–20 ms per iteration), and TV-LQR feedback at about 300 Hz, on 12th/13th-gen Intel CPUs.
- **Judo** ([arXiv 2506.17184](https://arxiv.org/abs/2506.17184)), on a ThinkPad X1 Carbon laptop with 10 threads. CEM, MPPI and Predictive Sampling take about 4 ms (cartpole), 5–7 ms (cylinder push) and about 50 ms (LEAP hand plus cube).
- **C-PBP** ([Hämäläinen et al. 2015](https://mediatech.aalto.fi/publications/graphics/C-PBP/preprint.pdf)): a humanoid with no motion data, N=32 samples and a 1.2 s horizon, running at 20–30 fps on a 6-core desktop (ODE). There are 35 parameters per step: target joint *velocities* plus motor force limits for 5 bone groups (arms, legs, torso). Balancing reduces to ω=0, and sampling the force limits lets joints relax. It also forbids head contact with a large cost term.

### Browser translation
- **The official build [code].** [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md) ships two builds:
  - single-threaded, which needs no special headers;
  - `/mt`, which uses Web Workers plus SharedArrayBuffer and needs COOP `same-origin` + COEP `require-corp` (MDN also allows `credentialless`, see [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)).

  The README says the bindings are WIP and only core APIs like `mj_step` are well tested. MuJoCo added `mju_threadpool` on an `mjData` in 3.10.0. The current release is 3.14.0 (2026-09-22, per the [changelog](https://mujoco.readthedocs.io/en/stable/changelog.html)).
- **Rollout parallelism (inference).** The simplest way to parallelize rollouts is *not* the MT build. Run K workers, each with its own single-threaded MuJoCo instance and model copy. Each planning tick, post them the state (qpos, qvel, act, warm-start, time; a few KB). That works without cross-origin isolation, so it runs on any host, including itch.io-style iframes. Use SharedArrayBuffer only to shave copy latency when isolation is available.
- **State reset.** MuJoCo documents a deterministic pipeline and `mj_getState`/`mj_setState` ([computation docs](https://mujoco.readthedocs.io/en/stable/computation/index.html)). I could not confirm those two functions are bound in WASM. If they are not, copy the arrays directly.
- **Speed.**
  - No MuJoCo-WASM benchmark exists that I could find.
  - General WASM runs 45–55% slower than native on average, with peak slowdowns of 2.08–2.5× ([Jangda et al. 2019](https://arxiv.org/abs/1901.09056)).
  - One native `testspeed` report puts the humanoid at about 12.3k steps/s single-thread, 81 µs/step at dt 0.005 ([discussion #1522](https://github.com/google-deepmind/mujoco/discussions/1522)).
  - MJPC's claim that the humanoid simulates "4000× real-time on one thread" cannot be reconciled with that figure. Treat 30–100 µs native per humanoid step as the planning range.
  - Contact count dominates cost: a 242-DoF, 390-contact scene took 3.96 ms/step ([issue #1471](https://github.com/google-deepmind/mujoco/issues/1471)).
- **Browser demos.** I found browser MuJoCo WASM demos ([zalo/mujoco_wasm](https://github.com/zalo/mujoco_wasm)) and neural-policy playback ([mjswan](https://github.com/multiplylabs/mjswan), which uses onnxruntime). **I found no published browser demo of MPC on MuJoCo WASM.** This would be novel.

## 2. (b) Classical controllers for arbitrary bodies

- **SIMBICON (Yin, Loken, van de Panne 2007)** [paper] ([PDF](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)):
  - A 4-state FSM per gait, with transitions on elapsed time or foot contact.
  - PD tracking of target poses. The torso and swing hip are servoed in *world* frame, and the stance hip takes the leftover torque: τ_A = −τ_torso − τ_B.
  - Balance comes from swing-hip feedback θ_d = θ_d0 + c_d·d + c_v·v, where d and v are the COM offset from the stance ankle and the COM velocity, in both sagittal and coronal planes.
  - The 3D model had 34 DoF, dt 0.005 s in ODE, kp ≤ 1000 and kd = 0.1·kp. It ran 1.2× real-time on a 2007 Pentium 4.
  - 12 gaits were hand-authored with sliders. Feedback-error learning, an online low-pass feed-forward per phase bin, lowers the gains. It is optional and runs in microseconds.
- **Coros 2010, generalized biped walking** [paper] ([page](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/index.html)): PD tracking, inverted-pendulum foot placement, and Jacobian-transpose virtual forces for gravity and velocity correction. It needs no character-specific tuning, and edits to the body take effect instantly.
- **Coros 2011, quadrupeds** [paper] ([page](https://www.cs.ubc.ca/~van/papers/2011-TOG-quadruped/index.html)): gait graphs, a dual leg-frame model, a flexible spine, and internal virtual forces through J^T. It covers walk through gallop, leaps, and getting up. Note that it *optimized* parameters offline. Our version must derive defaults from geometry instead.
- **Raibert, Chepponis & Brown 1986** [paper] ([PDF](https://publications.ri.cmu.edu/storage/publications/pub_files/pub3/raibert_m_h_1986_1/raibert_m_h_1986_1.pdf)):
  - Control splits into three parts: hop height, forward speed and body attitude.
  - Foot placement: x_f = ẋT_s/2 + k(ẋ − ẋ_d).
  - "Virtual legs": legs that move in unison act as one leg, so trot, pace and bound reduce to the one-leg controller. This is how a single rule set covers arbitrary leg counts.
- **Virtual Model Control** ([Pratt et al. 2001](https://journals.sagepub.com/doi/10.1177/02783640122067309)): imaginary springs and dampers between body parts and the world, turned into joint torques. It is intuitive for designers, and Jev could tune it.
- **CPGs** ([Ijspeert 2008 review](https://www.sciencedirect.com/science/article/abs/pii/S0893608008000804)): coupled oscillators produce multi-limb rhythm from low-dimensional inputs such as frequency and phase offsets.
- **Spore (Hecker et al. 2008)** [paper] ([PDF](https://www.chrishecker.com/images/c/cb/Sporeanim-siggraph08.pdf)):
  - Body parts carry capability tags (grasper, foot, mouth, spine), and queries such as "front-most grasper" are resolved at bind time.
  - A leg is the path from a foot leaf to a spine segment.
  - Legs are clustered into groups, and group gait frequencies are "harmonized" by approximating leg-length ratios with small rationals.
  - Per-foot duty factor plus step-trigger offset. Parameters are hand-authored for 1–6 feet and procedural for 7 or more.
  - The Particle IK solver treats joints as 3-DOF particles with length constraints (Jakobsen-style, 5 outer iterations) and solves spine first, then limbs.
  - It ran about 0.2 ms/frame for a 25-body creature on a 1.7 GHz Pentium-M and passed about 90% of stochastic tests.
- **Euphoria.** It is proprietary. Public descriptions only say it synthesizes motion from a real-time biomechanical and motor-control simulation ([summary](https://en.wikipedia.org/wiki/Euphoria_(software))). The open reconstructions are PD-to-pose with torque budgets, center-of-mass-over-support control, and a step when balance is lost. Treat that as a pattern, not a spec.
- **LQR from the sim itself.** MuJoCo's official LQR notebook balances the humanoid on one leg using inverse dynamics plus finite-difference derivatives ([2.3.0 release](https://github.com/google-deepmind/mujoco/releases/tag/2.3.0)). (inference) This works per build, with no training. Finite-differencing by hand costs about (2nv+nu) extra steps, and a JS Riccati iteration on roughly 70×70 matrices takes milliseconds.
- **IK in JS.**
  - three.js ships a `CCDIKSolver` ([docs](https://threejs.org/docs/pages/CCDIKSolver.html)).
  - FABRIK (Aristidou & Lasenby 2011, [paper](https://www.sciencedirect.com/science/article/abs/pii/S1524070311000178)) finds joint positions along lines, with no matrices, and reports the lowest per-iteration cost among the methods it compares.
  - Damped least squares handles joint axes and limits properly.
  - (inference) Use FABRIK or Spore-style particles for fast target poses, and DLS when hinge axes matter. Either costs microseconds per limb at 50–100 Hz.

## 3. (c) Graph analysis without learning

Run this at build time, in TypeScript, over at most about 64 joints. All of it is (inference) that combines the sources above.

1. **UniMate's descriptors [code].** Relation codes, hop distance clamped at 5, depth, and 8 sym-normalized Laplacian eigenvectors. A dense Jacobi eigensolver takes under 1 ms.
2. **Symmetry and left/right pairing.**
   - Primary method: hash every rooted subtree with AHU canonical coloring, which is linear time ([revisit](https://arxiv.org/abs/2309.14441)). Siblings with equal hashes and mirror-matching rest-pose offsets become pairs.
   - Tie-break with the spectrum. Intrinsic symmetries appear as ± sign flips of non-degenerate eigenvectors ([Ovsjanikov et al. 2008](https://diglib.eg.org/items/865c1c6e-f098-4a7f-a0e6-ca18d2a44943)).
   - UniMate's SignNet exists because eigenvector signs are arbitrary. Only use sign-invariant quantities such as |u| or u_i·u_j. Perfectly symmetric builds produce repeated eigenvalues, so do not trust individual eigenvectors there.
3. **Chains and end effectors.** Leaves are end effectors. A limb is the path from a leaf back to the nearest branching node, Spore's rule. The root or torso is the node with the most incident limbs.
4. **Limb roles.**
   - Parts come from Chris's catalog, so most roles are *free from tags*: wheel, foot pad, blade, hammer, flywheel. This is Spore's capability approach.
   - For generic segments, apply geometric rules:
     - **Leg:** the leaf can reach the ground plane from the rest pose, or its reach exceeds hip height.
     - **Arm:** attached above the COM with forward reach.
     - **Tail:** attached at the rear, points backward, and carries meaningful mass-radius (an inertial appendage).
   - Jev resolves ambiguous cases as a typed question.
5. **Gait phasing.**
   - Sort legs front-to-back along the spine axis, pair them left/right, and group them Spore-style.
   - Apply MJPC's phase tables, generalized: a wave gait uses phase i/n, and a trot runs diagonal pairs in antiphase.
   - Treat each pair as a Raibert virtual leg.
6. **Facing-canonical frame (from UniMate).** Express every skill target root-relative and heading-aligned. This matches Spore's target-relative "secondary relative" mode.

## 4. (d) Physically real balance aids

- **Cubli** [paper] ([ECC 2013](https://ethz.ch/content/dam/ethz/special-interest/mavt/dynamic-systems-n-control/idsc-dam/Research_DAndrea/Cubli/Cubli_ECC2013.pdf)): a 15 cm cube with three reaction wheels, each driven by a 50 W Maxon EC-45 flat motor. It balances on an edge or corner under LQR. It jumps up by spinning the wheels fast and braking them suddenly. The Wheelbot unicycle self-erects from any pose ([arXiv 2207.06988](https://arxiv.org/abs/2207.06988)). Recent papers mount CMGs on bipeds for disturbance rejection ([IET 2023](https://digital-library.theiet.org/doi/full/10.1049/csy2.12070); I was blocked from reading its numbers).
- **Actuator models in MuJoCo [docs].**
  - MuJoCo 3.7.0 added a `dcmotor` actuator with motor constant, resistance, saturation, inductance, cogging and thermal effects. MuJoCo 3.12.0 added a `pid` actuator ([changelog](https://mujoco.readthedocs.io/en/stable/changelog.html)). (inference) So current draw and power (V·I) come from the physics itself, and a battery part is possible.
  - Avoid MuJoCo's `gravcomp`-style invisible assists.
  - `implicitfast` excludes gyroscopic derivative terms, except for standalone free bodies ([docs](https://mujoco.readthedocs.io/en/stable/computation/index.html)). (inference) Fast flywheels on jointed bodies therefore need an energy-drift test, and possibly the full `implicit` integrator.
- **Sizing as gameplay (my arithmetic; the numbers are illustrative only).** Take a 2 kg, 0.15 m-radius steel disc: I = 0.0225 kg·m². At 600 rad/s it stores h ≈ 13.5 N·m·s.
  - A 20 kg robot with its COM at 0.8 m, tilted 10°, feels about 27 N·m of toppling torque, so the wheel saturates in about 0.5 s.
  - Reaction wheels therefore *buy time to step*. They do not replace stepping.
  - The same rotor on a gimbal slewing at 5 rad/s yields about 67 N·m (τ = h × gimbal rate). That is torque amplification, at the cost of gimbal-angle limits and precession side-effects.
  - Momentum saturation and desaturation make natural stat trade-offs: mass, max momentum, motor torque and power draw.

## 5. (e) Fighting-specific control

- **Strikes (inference built on sources).**
  - Target point is in the opponent-relative facing frame.
  - Path is minimum-jerk ([Flash & Hogan 1985](https://www.semanticscholar.org/paper/The-coordination-of-arm-movements:-an-confirmed-Flash-Hogan/7d8ac1ed3dc3fc96538372206da015e7dd4b251e)).
  - IK converts the path to joint targets.
  - MuJoCo position/pid actuators handle tracking, with stiffness scheduled by phase: compliant wind-up, stiff at impact, soft after contact.
  - Motion-capture-driven physics characters that hit and react already exist (e.g., punching), combining a reactive physical simulation with re-entry into playback after impacts ([Zordan & Hodgins 2002](https://www.semanticscholar.org/paper/Motion-capture-driven-simulations-that-hit-and-Zordan-Hodgins/8639de4f0a209a740ef1c5949bf4d854275cd743)). Here procedural keyposes or UniMate clips replace mocap.
- **Guard.** A posture target plus LQR stance. Reflexes run in the sim worker at physics rate, and Jev only arms them and sets their thresholds.
- **Getting up.**
  - First choice: a scripted, graph-derived sequence (roll to prone, bring support limbs under the COM, push).
  - Fallback: Predictive Sampling with MJPC's humanoid settings as a starting point (N=10, 3 knots, 0.35 s), with the head-contact ban from C-PBP.
  - The build option: invertible chassis or self-righting arms.
- **Look-ahead for Jev (inference).** Roll out 2–4 candidate tactics for 0.5–1 s *with the closed-loop controllers running inside the rollout*. Summarize the outcomes (hits landed, fall risk, energy) as typed state. The rollouts must start from the state predicted 100–500 ms ahead, to cover Jev's latency.
- **Key design choice (inference).** Sample in *skill-parameter* space, for example jab target, duration, stiffness and hip twist: about 6–8 numbers instead of about 60 raw spline knots. C-PBP's velocity-plus-force-limit trick shows that low-dimensional, well-chosen parameterizations are what make small N work.

## 6. Best pipeline per body type (inference)

- **Wheeled brawler.** No balance controller while at least 3 ground contacts hold. Wheel velocity actuators with diff-drive PD heading. Arms use DLS/FABRIK plus impedance. Spinner weapons are flywheels, and their gyroscopic effects are real. A two-wheel balancer uses LQR from the sim's own linearization. MPC is only for self-righting.
- **Quadruped / multi-leg.** Graph analysis, then leg groups and virtual legs. MJPC-style phase table. Raibert foot placement. J^T virtual forces for body height and attitude. Min-jerk swing feet through IK. Check static stability before lifting a limb to strike. Use MPC (iLQG or sampling, with the gait in the cost) for recovery and roll-over.
- **Biped.** SIMBICON FSM plus Coros-2010 gravity compensation and foot placement. A reaction wheel or CMG torso part buys stepping time. LQR guard stance. Scripted get-up, with MPC as fallback.
- **Hybrid/tails.** Split into ground-contact subsystems (locomotion) and free limbs (weapons, manipulators, inertial tail). Use the wheeled rules when statically stable. MPC plus Jev role labels handle anything the rules cannot classify.

## 7. Browser CPU budget: two robots (inference, needs benchmarking)

**Assumptions.**
- Each robot has about 25 DoF.
- A 2-robot scene costs 60–160 µs per step natively, which becomes about 90–400 µs in WASM.
- The planning model is one robot, with the opponent as a mocap proxy: 45–200 µs per step in WASM.
- Planning uses 10 ms steps, a 0.35 s horizon (35 steps), and N=10–16.

| Load | 500 Hz | 1000 Hz |
|---|---|---|
| Authoritative sim (1 worker) | 5–20% of a core | 9–40% of a core |
| FSM, IK, reflexes, LQR (JS) | <2% | <2% |
| MPC for one robot at 20 Hz (350–560 steps per plan) | 0.3–2.2 cores | same (planning is decoupled) |
| Jev look-ahead, 4 tactics × 60 steps, 3 per second | 5–40% | same |
| three.js render (main thread) | about 0.3–0.6 core | same |

**What that means.**
- A 4-core laptop fits both robots at 1000 Hz if MPC is **event-triggered**: get-up, recovery, clinch. Averaged, that is about 0.3–1 core.
- **Continuous** MPC on both robots needs about 1–4.5 cores, which is realistic only on 6–8+ core machines.
- Safari clamps `navigator.hardwareConcurrency` to 8 (2 on iOS), and WebKit randomizes it between 4 and 8 for scripts it classifies as fingerprinters ([WebKit PR](https://github.com/WebKit/WebKit/pull/74374)). Size the worker pool empirically.
- Default to 500 Hz and implicitfast. Reserve 1 kHz for stiff metal contacts.

**Day-1 test.** Time 10k `mj_step` calls of a 2-robot MJCF in Chrome, Safari and Firefox on a low-end laptop.

## 8. Where Jev plugs in (inference)

One 64-question call can set:
- the MPC cost weights and targets (MJPC's high-level-agent idea);
- gait choice, cadence and duty ratio;
- per-limb-group stiffness and force budgets (like C-PBP's 5 groups);
- strike parameters;
- reflex arming and thresholds;
- role labels for odd limbs;
- its pick among simulated tactic rollouts.

The browser does everything under 50 ms. Jev never touches torques.

## Unknowns
- The actual MuJoCo WASM mj_step cost in Chrome, Safari and Firefox for a 2-robot fighting MJCF. No benchmark exists; every browser budget number above is extrapolated from native timings and generic WASM slowdown figures.
- Whether @mujoco/mujoco binds mj_getState/mj_setState, mj_inverse and mjd_transitionFD (the bindings are codegen'd and mostly untested), and what the /mt build actually parallelizes inside a single mj_step.
- MJPC's claim of a single-thread humanoid at 4000x real-time conflicts with the independent ~62x real-time (81 us/step) testspeed report. The true per-step cost on current MuJoCo 3.14 is unverified.
- UniMate details are unpublished or unverified: parameter count, number of Euler sampling steps, clip frame rate (60 frames; fps unstated), whether the code runs on PyTorch MPS/CPU after removing the cu124 pins, whether bpy 4.0.0 installs on macOS arm64, and dataset release timing.
- Whether UniMate generalizes at all to mechanical robot builds with wheels, spinners and weapons. The training data is Truebones, Mixamo and Objaverse-XL, plus 'articulated rigid objects'.
- The MuJoCo dcmotor/pid attribute details were read through a summarizer, not verbatim. Confirm them in the XML reference before designing the motor/battery stats.
- The Euphoria/NaturalMotion internals are proprietary, and any offline tuning in them is undocumented.
- Energy drift of fast flywheels (reaction wheels, CMGs, spinner weapons) under implicitfast versus the implicit integrator at 500-1000 Hz, and how solref/solimp contact settings behave for metal-on-metal impacts.
- How far Jev's 70-500 ms latency degrades tactic choice in fast exchanges, and how much predicting rollout start states ahead compensates.
- Consumer-laptop thermal throttling under sustained multi-worker MPC load, and real available cores given Safari's hardwareConcurrency clamp.
- I could not read the CMG-on-biped paper (IET, HTTP 403) or the FABRIK PDF (TLS error), so no concrete CMG or FABRIK benchmark numbers are cited.