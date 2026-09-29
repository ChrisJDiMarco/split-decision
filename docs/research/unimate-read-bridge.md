# UniMate reader: bridge

**Headline:** For arbitrary user-built robots running in anyone's browser without NVIDIA hardware, the practical way to turn motion into torques is model-based control on MuJoCo WASM, not learned motion trackers. That means PD control with inverse-dynamics feedforward, sampling-based MPC for balance and strikes, and a short per-robot tuning pass in the browser, with Jev choosing typed tactics. The published trackers (PHC, MaskedMimic, SONIC, BeyondMimic) and morphology-general policies (URMA, GET-Zero, GCNT) take days to weeks of GPU training, work mostly on humanoids, and do poorly on body types outside their training set.

## Key facts
- Universal motion trackers are all trained on GPUs for one kind of body. PHC took about a week on one A100 (about 10B samples, SMPL humanoid only). MaskedMimic took about 2 weeks on 4 A100s. SONIC reports 9k GPU-hours on 128 GPUs. None supports arbitrary user-built kinematic trees.
- DeepMimic is the only CPU-only data point: about 60M samples and about 2 days on an 8-core machine per skill per character, with no GPU. It covered a humanoid, Atlas, a T-Rex and a dragon, but each was trained separately and PD gains had to be tuned per morphology.
- Cross-morphology policies generalize mainly within their training distribution. URMA: 16 robots, about 2.5 days on 1 GPU plus 20 CPU cores, near-zero humanoid zero-shot. Embodiment Scaling Laws: zero-shot improves as the number of training embodiments grows (about 1,000 bodies). So sample the whole design space from your own parts catalog so that player builds are in-distribution.
- UniMate's tricks already exist in control policies. GET-Zero adds a learned shortest-path-distance attention bias plus parent/child kinematic-chain biases. GCNT uses spectral GCN plus per-head shortest-path embeddings. They help zero-shot transfer, but the published results cover locomotion and in-hand manipulation only, not striking.
- Fighting systems all separate strategy from motor control through a compact skill interface: Won 2021 (skills, then bout strategy), RoboStriker (tracker, then a 32-D latent skill space, then self-play at 50 Hz, with hits counted above 10 N contact force), RPG (skill gating, where transitions are the main failure mode: 25% success rising to 70-95%). Jev fits the strategy seat but is slower than 50 Hz, so a local reflex layer is needed.
- Diffusion-in-the-loop needs closed-loop replanning plus GPU inference and data from expert trackers. CLoSD: 10 denoising steps, open-loop version fails. PDP: 100% success at action horizon 1 versus 6.5% at horizon 12. Diffuse-CLoC: 20 steps, 60-77 Hz on an RTX 4060 with TensorRT. BeyondMimic: stumbles at the start and end of motions.
- Model-based control needs no training and works for any body. MJPC simulates a 27-DoF humanoid about 4000x faster than real time on one CPU thread, with 1-20 ms planning updates, and the humanoid stands up and resists disturbances. MuJoCo iLQR MPC runs real-time on real humanoids and quadrupeds, needing only the model plus a cost function.
- Browser runtime is viable. Official @mujoco/mujoco WASM bindings exist (single-threaded and Web Worker builds; the multi-threaded build needs cross-origin isolation; labeled work in progress). Community demos run ONNX RL policies in-browser on MuJoCo WASM. JAX-Metal cannot run MuJoCo Playground, whose reported training times are all on NVIDIA GPUs.
- UniMate by its own account has no contact model (foot sliding and ground penetration), is less reliable on rare topologies, and was trained on 8 H100s for a day. It should be at most a soft style reference inside an MPC cost, not the physics bridge.
- Recommended stack: PD with inverse-dynamics feedforward clamped to torque limits, plus IK-based morphology-generic skills, plus Web Worker sampling MPC for balance, get-up and strikes, plus a per-robot in-browser tuning pass and skill exam at build time, plus Jev picking typed tactics. Optionally add later a graph-aware ONNX policy trained on the M3 Max CPU over the parts catalog, used as the MPC sampling prior.

## Scope and framing

UniMate only produces **kinematic** motion. Your robots are torque-limited bodies in a physics sim, so something has to turn "desired motion" into joint torques. That piece is the physics bridge. Your latest message sets the constraints I weighted most: **no NVIDIA-GPU route**, it **runs in anyone's browser**, and **Jev supplies the controls** as a tactical chooser. Most of the literature below breaks at least one of those constraints. The report is therefore partly a map of what exists and partly a filter for what survives them. Throughout, I mark what a source actually says versus my own inference.

---

## (a) Physics-based motion tracking: reference motion to torques

**What the papers say**

- **DeepMimic (Peng et al., 2018)** is the ancestor: one PPO policy per clip per character. The policy outputs PD targets at 30 Hz. The paper states that humanoid skills "typically require about 60 million samples to train, requiring about 2 days on an 8-core machine," and that all simulation and network updates ran on the CPU with no GPU. It covered a humanoid, Atlas, a T-Rex and a dragon, each trained separately. It also notes that PD gains "still require some insight to set properly for each individual character morphology." ([arXiv 1804.02717](https://arxiv.org/abs/1804.02717))
- **PHC (Luo et al., ICCV 2023)** trains one imitator for about 11k AMASS clips, with fall recovery and a composer over progressive primitives. Reported cost: "a single NVIDIA A100 GPU; it takes around a week," with 1,536 parallel humanoids collecting about 10 billion samples in Isaac Gym. The policy runs at 30 Hz and the sim at 60 Hz. It uses the SMPL humanoid only. ([paper](https://arxiv.org/abs/2305.06456))
- **PHC+ / PULSE (ICLR 2024).** PHC+ uses about 10^10 samples and PULSE about 10^9, in Isaac Gym. SMPL humanoid only: 24 joints, 23 actuated, 69 actuators. The paper does not discuss other morphologies. ([arXiv 2310.04582](https://arxiv.org/html/2310.04582v2))
- **MaskedMimic (SIGGRAPH Asia 2024)** trains a full tracker with RL, then distills it into a masked, partially-constrained controller. Cost: "16,384 parallel environments, split across 4 A100 GPUs… approximately 2 weeks," about 30B and 10B steps for the two stages. Controllers run at 30 Hz and the sim at 120 Hz. Humanoid only. ([arXiv 2409.14393](https://arxiv.org/html/2409.14393v1))
- **Humanoid-robot trackers** are all Isaac-trained, GPU-scale and specific to one robot or a handful of humanoids:
  - [OmniH2O](https://arxiv.org/abs/2406.08858) uses teacher-student training with kinematic pose as the control interface.
  - [HumanPlus](https://arxiv.org/html/2406.10454) trains a shadowing transformer on 40 hours of AMASS and runs at 50 Hz.
  - [ExBody2](https://arxiv.org/abs/2412.13196) filters out infeasible motions with a teacher policy.
  - [KungfuBot/PBHC](https://arxiv.org/abs/2506.12851) filters out motions beyond physical limits and adapts the tracking tolerance.
  - [GMT](https://arxiv.org/abs/2506.14770) uses a motion mixture-of-experts.
  - [BeyondMimic](https://arxiv.org/abs/2508.08241) does agile tracking plus a guided diffusion controller.
  - [SONIC](https://arxiv.org/html/2511.07820v1): the v1 paper reports about 100M frames, up to 42M parameters, and "9k GPU hours… 128 GPUs over 3 days." A press summary says about 21k GPU-hours; I could not reconcile the two figures.
- **[GMR / "Retargeting Matters"](https://arxiv.org/abs/2510.02252)** found that retargeting artifacts ("foot sliding, self-penetration") "significantly reduce policy robustness." Cleaner references matter more than RL tricks. GMR itself is an IK retargeter (mink + MuJoCo) that runs in real time on CPU.
- **Cross-embodiment tracking in 2026 is still humanoid-to-humanoid:**
  - [VENOM](https://arxiv.org/html/2606.16696) trains on 5 humanoids with embodiment-specific input and output heads, shows no zero-shot transfer to unseen bodies, and is "restricted to humanoid platforms."
  - [Any2Any](https://arxiv.org/abs/2605.23733) moves SONIC from the G1 to other humanoids by fine-tuning with about 1% of the compute.
  - [XHugWBC](https://arxiv.org/abs/2602.05791) reports zero-shot transfer across 12 simulated and 7 real humanoids, but only humanoids.
  - **[X-Morph](https://arxiv.org/html/2606.30290v1)** (June 2026) is the closest to your problem. It retargets human motion onto a quadruped, a hexapod and a quadruped with an arm, runs a physics corrector, then trains an RL tracker per robot. Compute is modest (about 7 GPU-hours per robot on an RTX 3090/4090). However, it "requires manually specified semantic correspondences" and "does not guarantee dynamic feasibility."

**Inference.** No published tracker generalizes to arbitrary, user-assembled kinematic trees. Every universal tracker is a humanoid tracker, and training cost ranges from GPU-days (PHC) to GPU-weeks and thousands of GPU-hours (MaskedMimic, SONIC). The only CPU-feasible data point is DeepMimic, at about 2 days per skill per character. That is fine for a studio but not for a player who just bolted a tail onto their robot.

---

## (b) Morphology-agnostic policies built on graph and transformer structure

**What the papers say**

- **[SMP (Huang et al., 2020)](https://arxiv.org/abs/2007.04976)** uses shared per-actuator modules with message passing. It worked on planar hoppers, bipeds and quadrupeds and generalized zero-shot to variants of them.
- **[Amorpheus (ICLR 2021)](https://arxiv.org/abs/2010.01856)** is the counterpoint: encoding morphology as the GNN message graph "does not improve performance," and a structure-free transformer beat it.
- **[MetaMorph (ICLR 2022)](https://arxiv.org/abs/2203.11931)** tokenizes the kinematic tree in depth-first order, adds learned position embeddings, and shows zero-shot transfer to unseen UNIMAL morphologies.
- **[ModuMorph (ICML 2023)](https://arxiv.org/abs/2302.11070)** adds hypernetwork-generated per-limb parameters plus "fixed attention… solely depend[ing] on the morphology."
- **SWAT (ICLR 2022)** uses "traversal-based positional embedding and graph-based relational embedding" ([repo](https://github.com/sunghoonhong/SWAT)). I could not read the paper to confirm whether the relational term is shortest-path-based.
- **[Body Transformer (CoRL 2024)](https://arxiv.org/abs/2408.06316)** masks attention to the body adjacency graph. It is framed as a better single-embodiment policy, not as a cross-morphology method.
- **[GET-Zero (2024)](https://arxiv.org/html/2407.15002)** is the most UniMate-like. Its attention adds a learned **shortest-path-distance bias** (Graphormer-style) plus new **parent/child directed biases** along the kinematic chain. It distills per-embodiment RL experts, 44 hand variants with 7 hours of demos each, and gains about 20% zero-shot on unseen graphs and link lengths.
- **[GCNT (2025)](https://arxiv.org/html/2505.15211)** combines spectral GCN, a Weisfeiler-Lehman module, and **learnable shortest-path-distance embeddings per attention head**. It reports large zero-shot gains on SMP and UNIMAL benchmarks, for example Humanoid h7 at 3509 versus Amorpheus at 883. Laplacian positional encodings also appear in related morphology-RL work ([Neurocomputing 2025](https://www.sciencedirect.com/science/article/abs/pii/S0925231225003169)).
- **[URMA (CoRL 2024)](https://arxiv.org/html/2409.06366)** is **set-based**: per-joint descriptors (position, axis, torque/velocity limits, damping and so on) pooled by attention, with no graph encoding. It trained 16 robots in about 2.5 days on 1 GPU plus 20 CPU cores, with CPU MuJoCo envs and JAX. It transferred zero-shot to unseen quadrupeds, but humanoid zero-shot was "near zero," and "transfer to embodiments completely out of the training distribution is still problematic."
- **[Embodiment Scaling Laws (CoRL 2025)](https://arxiv.org/abs/2505.05753)** trained on about 1,000 procedurally generated humanoids, quadrupeds and hexapods. Generalization rises with the number of training embodiments, with zero-shot transfer to a real Go2 and H1. **[URMAv2 (2025)](https://arxiv.org/abs/2509.02815)** trained on 50 robots plus "millions of morphological variations" with zero-shot transfer to real robots. **[UniLegs](https://arxiv.org/abs/2507.22653)** reaches 72.6% of teacher performance on unseen leg designs.

**Inference.** UniMate's tricks (graph attention bias, spectral or Laplacian positional encodings, a global pooled conditioner) already exist in control policies (GET-Zero, GCNT). They help, but none of them turns "any tree" into "in-distribution." The result that transfers is embodiment scaling: sample the whole design space during training. That works in your favor, because **you own the parts catalog**. You can procedurally sample every legal build, so a player's robot is in-distribution by construction. All of these results are locomotion only; none covers striking.

---

## (c) Physically simulated two-player combat

**What the papers say**

- **[Bansal et al. 2017](https://arxiv.org/abs/1710.03748)** trained ant and humanoid bodies in MuJoCo sumo and kick-and-defend with PPO self-play, dense-reward annealing and opponent sampling. Blocking, ducking and feints emerged.
- **[Won, Gopinath & Hodgins 2021](https://dl.acm.org/doi/10.1145/3450626.3459761)** uses two steps: learn basic skills, then learn bout-level strategy with multi-agent RL. The policy is an encoder-decoder with an autoregressive latent and a mixture-of-experts decoder, applied to boxing and fencing. I could not access compute figures. A follow-up, **[Zhang et al. 2023](https://arxiv.org/abs/2305.20041)**, retargets two-character interactions to characters of "different sizes, kinematics or morphologies" using an interaction-graph reward.
- **[MAAIP (SCA 2023)](https://arxiv.org/abs/2311.02502)** does multi-agent adversarial imitation for boxing and QwanKiDo.
- **RoboStriker ([2601.22517](https://arxiv.org/abs/2601.22517), [2608.16195](https://arxiv.org/html/2608.16195))** is the current reference design and has three layers: a boxing-mocap tracker, a **32-D latent skill manifold**, and **latent-space neural fictitious self-play**. The high level runs at 50 Hz and physics at 200 Hz, with Isaac Lab on one RTX 4090. Hits count when contact force exceeds 10 N. It was deployed on a real G1 via ONNX Runtime on CPU.
- **[RPG (2026)](https://arxiv.org/html/2604.21355)** gates per-skill expert policies (punch, kick, jump, sword). It found **transitions are the main failure mode**: 25% success without gating and 70–95% with it, and lower-body transitions are the hardest. On the commercial side, CMG ran remotely operated G1 bouts in May 2025 ([Live Science](https://www.livescience.com/technology/robotics/china-pits-rival-humanoids-against-each-other-in-worlds-first-robot-boxing-tournament)).
- **[Karl Sims 1994](https://www.karlsims.com/papers/alife94.pdf)** is the only one with truly arbitrary morphologies competing: evolved bodies and controllers contest a resource in a physics simulation.

**Inference.** Every working fighter separates strategy from motor control through a compact skill interface. That is exactly your three-layer design, with Jev in the strategy seat. Two caveats. First, the learned strategists decide at about 50 Hz, while Jev decides in 70–500 ms, so blocks and dodges need a local reflex rule in the skill layer. Second, skill-to-skill transitions deserve explicit engineering: a guard or neutral state and blended handoffs.

---

## (d) Diffusion inside physics control loops

**What the papers say**

- **[CLoSD (ICLR 2025)](https://arxiv.org/html/2410.03441)** ("diffuse, then track") pairs a diffusion planner (DiP) with an RL tracker. The planner uses 10 denoising steps and generates 40-frame plans at "3,500 fps" on an RTX 3090. It replans every 40 frames from the simulated prefix. The open-loop version fails at interaction tasks, so feeding the actual simulated state back is essential.
- **[PDP (SIGGRAPH Asia 2024)](https://arxiv.org/html/2406.00960)** is a diffusion policy distilled from noisy RL-expert rollouts. Inference is K times slower than an MLP. Robustness collapses with longer action chunks: 100% success at horizon 1 versus 6.5% at horizon 12.
- **[Diffuse-CLoC (SIGGRAPH 2025)](https://arxiv.org/html/2503.11801v1)** co-diffuses states and actions and replans every step. It uses 20 denoising steps and reaches about 60–77 Hz on an RTX 4060 with TensorRT. Its data comes from PHC+ rollouts, and guidance weights need tuning.
- **[BeyondMimic](https://arxiv.org/html/2508.08241)** runs state-latent diffusion with a 0.64 s receding horizon. It notes that "errors in proprioception directly propagate" and that the robot "tends to stumble at the start and end of motions."
- **[ADAPT (Sept 2026)](https://arxiv.org/abs/2609.00677)** adds residual RL on top of a frozen diffusion prior.

**Inference.** Diffusion-in-the-loop requires an expert tracker for that body first (the data source), a GPU or TensorRT for the denoising steps, and closed-loop replanning. All three conflict with your constraints. The training-free relatives are the interesting part. **[Model-Based Diffusion](https://arxiv.org/abs/2407.01573)** and **[DIAL-MPC](https://arxiv.org/abs/2409.15610)** use diffusion-style annealing over a *known* dynamics model with no data. They generalize to new dynamics without retraining, but published implementations use GPU/JAX sampling.

---

## The option that fits your constraints: model-based control on the MuJoCo model

**What the papers say**

- **MJPC ([Howell et al. 2022](https://arxiv.org/abs/2212.00541))** reports that a 27-DoF humanoid simulates "4000 times faster than realtime on a single CPU thread." Planning updates take "between 1 and 20 milliseconds," and predictive sampling makes the humanoid stand up from the floor and resist large disturbances. Its stated limit is myopia (it cannot see past the planning horizon), and it suggests adding learned proposal policies or value functions.
- **[Zhang et al. 2025](https://arxiv.org/abs/2503.04613)** ran iLQR on MuJoCo dynamics as real-time whole-body MPC on real quadrupeds and a humanoid. Each new robot needs only the model and a cost function.
- **[RGB (2026)](https://arxiv.org/abs/2606.25123)** uses an RL policy as the MPPI sampling prior and reports about 280 Hz on a simulated G1.
- **[Coros et al. 2010](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/index.html)** walking control (PD tracking, inverted-pendulum foot placement, Jacobian-transpose gravity compensation) is real-time and "requires no character-specific or motion-specific tuning."
- **[SAMCON](https://www.cs.ubc.ca/~van/papers/2010-TOG-sampControl/index.html)** reconstructs open-loop control for a mocap clip by sampling and forward simulation, with no learning.
- **Browser feasibility:**
  - Official **[@mujoco/mujoco WASM bindings](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)** ship single-threaded and Web-Worker/SharedArrayBuffer builds. The multi-threaded build needs cross-origin isolation, and the project is labeled "still a WIP."
  - Community demos run RL policies through ONNX Runtime Web on top of MuJoCo WASM ([mujoco-js](https://github.com/danrosselli/mujoco-js), [G1 demo](https://github.com/LeoMaglanoc/LeoMaglanoc.github.io)).
  - JAX-Metal cannot run MuJoCo Playground ([issue](https://github.com/hello-robot/stretch_mujoco/issues/40)). Playground's reported locomotion training times are all on 2× RTX 4090 ([report](https://arxiv.org/html/2502.08844v1)).

---

## Most promising pipelines for arbitrary user-built robots

**Pipeline 1 (build first; no training, runs entirely in the browser): model-based bridge**

1. **Joint layer.** PD toward targets plus inverse-dynamics and gravity feedforward from the MuJoCo model, clamped to each actuator's torque limit. This works for any kinematic tree by construction.
2. **Skill layer.** Parameterized, morphology-generic intents computed from the tree: strike an end-effector at a point via IK, guard pose, lean or shove, and gait from generic foot placement or wheel drive. MJPC-style predictive sampling runs in Web Workers with fight costs (balance/CoM over support, strike contact above a force threshold as in RoboStriker, self-protection) for balance, recovery, get-up and strike refinement.
3. **Build-time tuning pass.** When a player saves a robot, spend seconds to minutes in-browser tuning PD gains and skill parameters (CMA-ES or sampling, SAMCON-style). Then run a "skill exam" that disables skills the body cannot perform, such as a kick it cannot land without falling.
4. **Jev** picks typed tactics (skill, target, aggression) a few times per second. A local reflex rule handles sub-100 ms blocks and dodges.

My estimate, unmeasured: WASM runs slower than native, so two robots each replanning at 20–50 Hz with modest rollout counts should be feasible on a laptop and marginal on phones.

**Pipeline 2 (later; trained offline on the M3 Max CPU, no CUDA)**

Train a small graph-aware policy on MuJoCo CPU environments over procedurally sampled robots from your own parts catalog. Use a shortest-path-distance attention bias plus parent/child biases (GET-Zero) or Laplacian positional encodings (GCNT), which are the same tricks UniMate uses, or URMA's joint descriptors. Export it to ONNX for the browser. Use it as the **MPC proposal distribution** (MJPC, RGB), not as the sole controller. That way a novel body degrades gracefully instead of falling over.

**Pipeline 3 (optional, for style): UniMate or procedural clips as a soft reference**

Add the kinematic reference as a tracking-cost term inside the MPC, never as a hard target. Three reasons:
- UniMate itself says it "can produce foot sliding… or ground penetration."
- It says it is "less reliable on rare skeletal topologies."
- It was trained on 8 H100s. Running it, even offline, pulls toward the NVIDIA route you want to avoid.

**Not recommended for your constraints**
- PHC, MaskedMimic or SONIC-class universal trackers: humanoid-only and GPU-weeks to train.
- Per-robot DeepMimic RL: about 2 CPU-days per skill.
- Diffusion policies in the control loop: they need expert data for each body plus GPU inference.

## Unknowns
- Actual MuJoCo WASM speed versus native (steps per second per worker) and whether two robots with 20-50 Hz sampling MPC stay real-time on mid-range laptops and phones. No benchmark found; my budget is an estimate.
- Whether sampling MPC with fight-specific costs produces motion that looks good and readable enough for a game (MPC motion can be jittery or odd). No published MPC-based fighting system was found.
- Compute and training time for Won/Gopinath/Hodgins 2021 and for BeyondMimic per-motion tracking. Could not access these figures.
- SONIC total compute: the v1 paper says 9k GPU-hours on 128 GPUs over 3 days, while a secondary summary says over 21k GPU-hours. Not reconciled.
- Whether SWAT's graph-based relational embedding uses shortest-path distance. Could not read the full paper.
- Training cost of Embodiment Scaling Laws (about 1,000 embodiments) and URMAv2. Abstracts give no compute figures.
- Whether a URMA- or GET-style policy can be trained in reasonable time on an M3 Max using CPU MuJoCo plus PyTorch MPS. There is no published Apple Silicon data point. The community MJX-MLX port is unvetted.
- How Jev's 70-500 ms decision latency affects fight quality compared with the 50 Hz learned strategists in RoboStriker. The reflex-layer requirement is my inference.
- UniMate inference hardware (the paper says 50 FPS without naming the GPU) and whether it could be ported to WebGPU/ONNX. Not investigated in this track.
- Whether wheels, tails, and mixed wheel-and-leg bodies work with the cited cross-morphology methods. Most published results are legged-only, and UniMate's dataset does not mention wheels.