# Motor control and locomotion for arbitrary builds

**Headline:** Yes, this can be built, but only if "build your own robot" means parametric part families that stay inside what the controllers were trained on, not unlimited freeform bodies. The layered design holds up: a physics-rate joint controller, a 40-50 Hz skill layer, a 10-20 Hz reflex layer, and Jev choosing tactics a few times a second. Every published physically simulated fighting system is layered this way, and the one that ran multi-agent RL directly on the robot's joints fell apart.

**Recommendation:** Build it in three stages. Keep the physics engine the same for training and for the game, and treat unlimited freeform bodies as v2, not v1.

**Engine and runtime**
- Use MuJoCo for both: train in MuJoCo Warp (via mjlab or MuJoCo Playground), export policies to ONNX, and run in the browser with the official MuJoCo WebAssembly build, onnxruntime-web and three.js. The mjswan project already runs this stack and matches Chris's three.js experience.
- Model real motors with MuJoCo's `dcmotor` actuator (current limits, torque-speed curve, gearbox, thermal model). Motor heat then becomes a physically real stamina stat.

**Control layers and rates**

| Layer | Rate | What it does |
|---|---|---|
| Joint control | 500 Hz physics (2 ms steps) | PD or motor torque computed inside each physics step |
| Skill policies | 50 Hz | Interruptible skills, trained with randomized transitions |
| Reflex / arbiter | 20 Hz | Priorities: balance, then get-up, then guard or evade, then Jev's intent |
| Jev | 2-4 Hz, asynchronous | Picks tactic, target and aggression from a menu of about 12-20 options; each decision holds until replaced |

**v0 (about 2-3 weeks)**
- Two wheeled or tracked bots with weapon arms, classical control, no training, no assist.
- Jev drives the tactics.
- Pass/fail test: Jev must beat a random tactic picker and a scripted one.

**v1 (about 2-4 months)**
- Three build families with swappable parts inside set bounds: wheeled/tracked (classical control), quadruped/hexapod (IK gait or RL walking and get-up), and a humanoid "striker" (mocap-tracked strikes, a guard, and a HoST-style get-up).
- Training on rented RTX 4090s: about 300-1,000 GPU-hours, roughly $100-700.
- A qualification test before any robot enters the ring.
- A boxing 10-count so robots that can't get up lose.
- An in-simulation gyro/reaction-wheel part as the only honest balance assist. Any external upright force appears only in a clearly labeled "Assisted" mode.

**v2 (6-12+ months)**
- Freeform builds, driven by one controller trained on thousands of bodies generated from the game's own part catalog.
- When a build fails qualification, a cloud fine-tune of about 30 minutes, roughly $0.10-0.70 per build.

**Scope limits**
- Limit fighting to striking plus knockdowns. Grappling and ground fighting are beyond current research.

# Stream: getting any player-built robot to stand, strike, block, fall and get up

**Tag legend.** [vendor] means a company claim. [paper] means a result reported by the paper's own authors, which is self-reported evidence of the same grade as [vendor]. [indep] means third-party reporting or independent measurement. [est] means my own estimate, with no source.

## Summary

1. **The three-layer split holds, with one addition.** The fighting and sports systems I found all use the same shape: joint servo control, then learned skills, then strategy. That includes RoboStriker, RPG, DeepMind's OP3 soccer robot and Won 2021. The addition is a fast reflex and arbiter layer between Jev and the skills. Jev decides a few times a second, and a strike or block lasts about as long as one of its decision cycles.
2. **The hardest part is "any build".** Universal controllers that work across many bodies are real in 2025-26, but only for **locomotion**. For fight-relevant skills such as getting up, zero-shot performance on bodies the policy never saw is weak. The recipe that works: define build families whose part combinations are covered by training by design, then fine-tune on a specific build when it fails (about 30 minutes on one GPU per H-Zero).
3. **A game has an advantage real robotics lacks.** The body model is exact, and the training simulator can be the game simulator. Use MuJoCo throughout:
   - train in MuJoCo Warp (via mjlab or MuJoCo Playground);
   - export the policy to ONNX;
   - run it in the browser with the official MuJoCo WebAssembly build, onnxruntime-web and three.js. The mjswan project already does exactly this.
   There is no sim-to-real gap to cross, only a sim-to-sim gap to test.

## (a) Does the three-layer split hold?

| System | Joint level | Skill layer | Strategy layer |
|---|---|---|---|
| RoboStriker, Unitree G1 boxing, 2026 ([v2](https://arxiv.org/html/2608.16195), [v1](https://arxiv.org/abs/2601.22517)) | PD control inside 200 Hz physics | Tracker trained on professional-boxer mocap, compressed into a 32-dimensional skill space | Self-play policy that acts in that skill space at 50 Hz. Runs on real G1s via ONNX on the onboard CPU |
| RPG, G1 fighting, 2026 ([arXiv](https://arxiv.org/abs/2604.21355)) | PD | One imitation policy per skill (punch, kick, jump, sword swing) plus a gate that switches between them. Trained with randomized transitions. 50 Hz on the real robot | Operator commands |
| DeepMind OP3 soccer ([arXiv](https://arxiv.org/html/2304.13653)) | Servo position control | Separate get-up and scoring "teacher" policies, distilled into one | Same network, refined by self-play. Acts at 40 Hz in MuJoCo |
| Won, Gopinath & Hodgins 2021, boxing and fencing ([ACM](https://dl.acm.org/doi/10.1145/3450626.3459761)) | PD | Imitation-learned skills | Bout-level strategy learned by RL over a skill space |
| Real G1 fight leagues ([REK/UFB](https://www.humanoidsdaily.com/news/robot-combat-enters-the-ring-rek-and-ufb-launch-competing-us-fighting-leagues), [Rest of World](https://restofworld.org/2026/chinese-robot-boxing-unitree-rek/)) | Onboard balance and get-up | Pre-trained moves | **A human** using VR (REK) or a console or keyboard (UFB) [indep] |

**The strongest evidence** is RoboStriker's baseline. Running RL directly on the G1's 29 joints produced what the authors call "joint-level physical collapse". Its offensive landing rate was 0.285, against 0.685 when strategy acts through the skill space instead [paper].

**What this means for Jev.** The layer below Jev should expose a small menu of actions with parameters. Jev's three output types fit that menu naturally:
- `choice` picks one option, with up to 255 options per question ([API docs](https://docs.typesafe.ai/api)) [vendor];
- `score` gives a continuous value such as intensity;
- `noul` answers yes/no questions such as "retreat?".

**Three changes I'd make to the split:**
1. **Add a reflex/arbiter layer at 10-20 Hz.** Priority order: balance recovery, then get-up, then guard or evade reflexes, then Jev's current intent [est].
2. **Make Jev's decisions persist and run them asynchronously.** Jev issues an intent with a duration, e.g. "pressure with jab-cross for 2 s". The next call is already in flight while the current intent runs. The physics loop never waits on the network.
3. **Make every skill interruptible.** RPG exists because switching between single-skill policies destabilizes the robot. Mismatched start and end states act as disturbances. Randomizing transitions during training fixes this [paper].

**Recommended rates:**
- Physics at 500 Hz (2 ms steps), with PD or motor-model torque computed inside every step. Go to 1 kHz only if weapon impacts need it.
- Skill policy at 50 Hz, reflex layer at 20 Hz, Jev at 2-4 Hz.
- For comparison: RoboStriker uses 200 Hz physics and a 50 Hz policy, OP3 acts at 40 Hz, RPG at 50 Hz.
- Your proposed 500-1000 Hz for joint control matches real robot servo loops. In simulation, that loop is simply the physics step.

**Jev constraints that are verified:**
- Rate limits of 1,200 requests/min and 250k tokens/s; text-only input; 64k-token context ([models page](https://docs.typesafe.ai/models)) [vendor].
- The 70-500 ms latency figure does **not** appear on the docs pages I fetched, so it is unverified.
- Two robots at 3 Hz use 360 requests/min, so about 3 matches can run at once per account [est].
- A 3-minute match at about 2k tokens per call is about 2.2M tokens, roughly $0.09 at $0.042 per million [est].

## (b) Classical control options, and what each needs from the body model

- **Convex MPC (MIT Cheetah 3).** Treats the body as one rigid block. Plans ground reaction forces 0.5 s ahead and solves in under 1 ms, at 20-30 Hz. Demonstrated stand, trot, bound, pronk and gallop ([IROS 2018](https://dl.acm.org/doi/10.1109/IROS.2018.8594448)) [paper]. Needs: lumped mass and inertia, legs light relative to the body, and a hand-designed contact schedule (the gait).
- **MPC plus whole-body impulse control (Mini Cheetah).** MPC outputs reaction forces; the whole-body controller turns them into joint torque, position and velocity commands ([arXiv 1909.06586](https://arxiv.org/abs/1909.06586)) [paper]. Needs the full rigid-body model and the leg Jacobians.
- **ZMP walking and whole-body QP / centroidal control.** These keep the balance point (the ZMP) inside the support polygon and solve prioritized tasks on the full model. ZMP gives flat-footed, slow, robotic-looking walking, which may suit this game's look. (Kajita 2003 preview control; I did not re-fetch it.)
- **MuJoCo MPC (MJPC).** Planners (predictive sampling, iLQG, gradient descent) that run on the exact MuJoCo model. Given only a cost function, they work on *any* body with no training ([arXiv 2212.00541](https://arxiv.org/abs/2212.00541)) [paper]. They need many simulated rollouts per control step. That is fine on a desktop CPU for one robot, but unlikely for two robots in a browser [est].

**Why classical control is more viable here than on real robots.** The model is exact: MuJoCo hands you the mass matrix, Jacobians and centre of mass for whatever the player built. Classical control therefore works well for:
- **Wheeled and tracked bots:** trivial.
- **Statically stable multi-leg builds:** an IK tripod or crawl gait works for any leg count on day one.
- **Quadrupeds:** trotting via convex MPC.

Precedents: [Sumotori Dreams](https://en.wikipedia.org/wiki/Sumotori_Dreams) (2007, procedural physics-based sumo in 96 KB). [Spore](https://www.chrishecker.com/Real-time_Motion_Retargeting_to_Highly_Varied_User-Created_Morphologies) handled arbitrary player creatures, but kinematically, not with physics.

**Where classical control is weak:**
- being hit, and other unplanned contacts;
- falls and get-ups;
- whole-body strikes;
- gait design, which has to be redone for each body layout.

Industry mixes the two. Boston Dynamics kept Spot's model-based controller and added RL only for "the part of the strategy that is harder to program" ([BD blog](https://bostondynamics.com/blog/starting-on-the-right-foot-with-reinforcement-learning/)) [vendor].

## (c) Learned control and 2025-26 training times

**MuJoCo Playground** (outstanding demo paper, RSS 2025) ([paper](https://arxiv.org/html/2502.08844)) [paper]:
- Go1 quadruped joystick, handstand and get-up policies each train in minutes.
- Berkeley Humanoid: under 15 minutes. G1 and T1 humanoids: under 30 minutes on 2× RTX 4090.
- Throughput with PPO on one A100: 417k steps/s for Go1 on flat ground, 106k for G1.
- All of these transferred to the real robots.

**Other training-time data points:**
- **FastSAC / FastTD3:** humanoid locomotion with strong domain randomization in 15 minutes on **one** RTX 4090 ([arXiv 2512.01996](https://arxiv.org/abs/2512.01996)) [paper].
- **Get-up:** HoST learns G1 standing up from diverse postures and runs on the real robot ([RSS 2025](https://arxiv.org/abs/2502.08378)) [paper]. OP3's learned get-up takes 0.93 s against 2.52 s for the scripted one ([arXiv](https://arxiv.org/html/2304.13653)) [paper].
- **Motion-prior skills.** DeepMimic ([2018](https://arxiv.org/abs/1804.02717)) and AMP ([2021](https://arxiv.org/abs/2104.02180)) are foundational; I did not re-fetch them. ASE (2022) needed 10 billion samples, about 10 days on one V100, trained on 187 clips (about 30 minutes of mocap). It developed fall recovery without any get-up clips: 0.31 s mean, 4.1 s worst case ([arXiv](https://arxiv.org/html/2205.01906v2)) [paper]. On 2026 tooling, similar work plausibly takes hours to a day [est].
- **Competitive training.** OP3 soccer took a 14 h get-up teacher, a 158 h soccer teacher, then 68 h of distillation and self-play on a 2023 stack ([Science Robotics](https://www.science.org/doi/10.1126/scirobotics.adi8022); figures from the search summary) [paper]. RoboStriker trained on one RTX 4090 with 4,096 parallel environments, but did not report wall-clock time [paper].

**Tooling:**
- **Training:** [MuJoCo Warp](https://github.com/google-deepmind/mujoco_warp) (DeepMind and NVIDIA, part of the Newton project), used through [mjlab](https://arxiv.org/abs/2601.22074) (Jan 2026, Isaac Lab-style API on MuJoCo Warp).
- **Browser runtime:** [mjswan](https://github.com/ttktjmt/mjswan) (Apache-2.0) runs MuJoCo WebAssembly, onnxruntime and three.js entirely client-side, and supports mjlab tasks directly. The official npm package [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md) has single- and multi-threaded builds and is still labeled work in progress.
- **Unity:** ML-Agents Release 23 (Sep 2025) ([releases](https://github.com/Unity-Technologies/ml-agents/releases)) trains inside Unity's simulation. It is far slower than GPU-parallel MuJoCo, and training in one engine then running in another adds a sim-to-sim gap [est].

**"Real actuators" are now built into MuJoCo:**
- 3.11 added a `pid` actuator; 3.12 redesigned `dcmotor` so it takes position, velocity, feed-forward or voltage inputs ([releases](https://github.com/google-deepmind/mujoco/releases); 3.14.0 shipped 2026-09-22).
- The [DC motor doc](https://mujoco.readthedocs.io/en/latest/_static/dcmotor.pdf) covers current saturation, the torque-speed envelope, gearbox efficiency, cogging, backlash and a thermal model.
- Game use: **motor heat becomes a physically real stamina meter**, and motor tiers become parts the player can swap.

**Answer to (c):** a new body can learn to walk in about 15-30 minutes on 1-2 RTX 4090s. A fighting skill library for one build family takes days of iteration. RTX 4090 rental runs $0.29-0.69/hr ([Vast](https://www.synpixcloud.com/blog/vast-ai-vs-runpod-rtx-4090-pricing), [RunPod](https://www.thundercompute.com/blog/runpod-pricing-vs-thunder-compute)) [indep].

## (d) Can one controller drive every body?

| Work | Scale | Result |
|---|---|---|
| Huang et al. 2020, [SMP](https://proceedings.mlr.press/v119/huang20d.html) | Planar (2D) agents | Generalizes to unseen variants [paper] |
| MetaMorph ([ICLR 2022](https://arxiv.org/abs/2203.11931)) | 100 bodies (UNIMAL) | 1.5 GPU-days vs about 30 for the sequential baseline. "Strong" zero-shot; fine-tuning 2-3× more sample-efficient [paper] |
| ModuMorph ([ICML 2023](https://arxiv.org/abs/2302.11070)), Body Transformer ([2024](https://arxiv.org/abs/2408.06316)) | Architecture work | Hypernetworks and attention masked by body structure beat plain transformers and MLPs [paper] |
| URMA ([CoRL 2024](https://nico-bohlinger.github.io/one_policy_to_run_them_all_website/)) | 16 robots: 9 quadrupeds, 6 bipeds, 1 hexapod; 100M steps each | Transfers to unseen robots; ran on real quadrupeds [paper] |
| URMAv2 ([2509.02815](https://arxiv.org/abs/2509.02815)) | 50 robots, millions of body variations | Zero-shot on unseen real humanoid and quadruped [paper] |
| GENBOT-1K ([2505.05753](https://arxiv.org/html/2505.05753v1)) | 1,012 generated bodies | Expert training took about 5 days on 160 GPUs, plus 1 week of H100 distillation. Zero-shot to real Go2 and H1 [paper] |
| LocoFormer ([CoRL 2025](https://arxiv.org/abs/2509.23745)) | Generated legged **and wheeled** bodies | Adapts to motor failures; learns from its own falls across episodes [paper] |
| H-Zero ([2512.00971](https://arxiv.org/abs/2512.00971)) | Humanoids | Up to 81% of full episode length zero-shot; **30 minutes** of fine-tuning per new body [paper] |
| XHugWBC ([2602.05791](https://arxiv.org/abs/2602.05791)) | 12 simulated + 7 real humanoids | Zero-shot claim [paper] |
| Get-up across morphologies ([2512.12230](https://arxiv.org/html/2512.12230)) | 7 small humanoids | **Only 17-42% success** on held-out bodies, except one at 72%. About 1.5 h per policy on an RTX 3090 [paper] |

**Verdict.** One pretrained controller can make most in-distribution bodies *walk*. It will not reliably make an arbitrary body *fight and get up*. Two things work:
- **Design legal builds to be covered by training.** Use fixed sockets, symmetric limbs, bounded part parameters and a torque-to-weight budget. Then train on thousands of builds generated from the game's own part catalog, GENBOT-style.
- **Fine-tune when a build fails:** 10-60 minutes of GPU time, roughly $0.10-0.70 per build [est].

## (e) Research on physically simulated competitive fighting

- **Bansal et al. 2017** ([arXiv](https://arxiv.org/abs/1710.03748), [code](https://github.com/openai/multiagent-competition)). MuJoCo sumo. Humanoids developed a stable stance and head-butts. Sampling past versions of the opponent stabilized training [paper].
- **RoboSumo** ([code](https://github.com/openai/robosumo)). Ant, Bug and Spider bodies wrestling. Each body type was trained only against the *same* type [paper]. This is a warning that different-body matchups add another layer of difficulty.
- **Karl Sims 1994** ([pdf](https://www.karlsims.com/papers/alife94.pdf)). Bodies and controllers co-evolved through one-on-one contests. This is the original "build your body, then fight".
- **SMPLOlympics** ([2407.00187](https://arxiv.org/abs/2407.00187)). Includes boxing and fencing; motion priors combined with simple rewards produce human-like behavior [paper].
- **Real G1 fights are teleoperated.**
  - Unitree's Hangzhou event (May 2025): humans ran the robots with controllers, and the robots usually stood back up within about 5 s ([Global Times](https://www.globaltimes.cn/page/202505/1334812.shtml)) [indep].
  - REK uses VR piloting; UFB uses a console or keyboard in the browser [indep].
  - Rest of World (Feb 2026) reports robots sometimes needing human help to get up [indep].
  - The only autonomous G1 boxing is RoboStriker, and it relies on an external motion-capture system to perceive the opponent. In a game, perception is free.

## (f) Assist tricks when a controller fails, and staying honest about them

**What existing games do** ([analysis](https://medium.com/@jacasch/balancing-of-active-ragdolls-in-games-367f146b25fb), [Landfall](https://www.gamedeveloper.com/design/how-landfall-games-finds-the-fun-in-physics-engines)):
- Gang Beasts and Human: Fall Flat apply an upward impulse to the pelvis.
- TABS drives the legs with torques from animation curves and adds a standing handler.

These are external "hand of god" forces. They break conservation of momentum.

**Ways to keep the physics honest** [est]:
1. **Make assistance a physical part.** A gyro core or reaction wheel inside the robot can only torque by spinning up, saturates, and adds mass and power draw. The same principle lets the [Cubli](https://idsc.ethz.ch/research-dandrea/research-projects/archive/cubli.html) jump and balance.
2. **Use a boxing 10-count.** A robot that cannot get up loses. Get-up ability becomes a design stat instead of something the game fakes.
3. **Show and label any magic assist.** A HUD meter shows assist impulse as a percentage of body weight × time. Matches and leaderboards are split into "Pure Sim" and "Assisted".
4. **Run a build qualification test before a robot enters the ring:** stand, walk 3 m, turn, get up from 3 postures, and survive pushes.

## Recommended architecture

**v0, about 2-3 weeks [est]: prove the loop.**
- MuJoCo WebAssembly plus three.js, two wheeled or tracked bots with hammer, flipper or lifter arms.
- Control is classical: differential-drive PID plus PD on the weapon joints. No training, pure simulation.
- Jev chooses among about 12 tactics at 3 Hz; a 20 Hz reflex state machine sits underneath.
- Pass/fail test: Jev must beat both a random tactic picker and a scripted one.

**v1, about 2-4 months [est].** Three build families:

| Family | Parts vary within bounds | Controller |
|---|---|---|
| Wheeled / tracked | Chassis, drivetrain, weapons | Classical |
| Quadruped / hexapod | Leg length, mass, motor tier | IK gait or RL policy (walking, get-up, rear-up stomp, charge) trained with domain randomization and body parameters as input |
| Humanoid striker | Limbs ±15%, armor, motor tiers | Mocap-tracked skills with randomized transitions (RPG-style) or a compressed skill space (RoboStriker/ASE-style), plus HoST-style get-up |

- Training in mjlab or Playground on rented RTX 4090s, about 300-1,000 GPU-hours including failed runs, about $100-700 [est].
- Runtime in the browser via ONNX; cost is negligible.

**v2, 6-12+ months, research-grade [est]: freeform builds.**
- One URMA-style controller trained on bodies generated from the game's own part catalog.
- A cloud "training camp" fine-tunes a player's build (about 30 minutes, H-Zero-style) when it fails qualification. The learning curve can be shown to the player as a feature, like [Keiwan's Evolution](https://keiwan.itch.io/evolution).
- Optional: a self-play RL tactician as an exhibition opponent for Jev.

## Biggest risks

1. **Humanoid fighting quality is at the research frontier.** Grappling and ground fighting are effectively unsolved. Scope v1 to striking plus knockdowns.
2. **Unseen-body get-up is weak** (17-42% success on held-out bodies). This forces the family-based design or per-build fine-tunes.
3. **Training and runtime simulators can drift apart.** MuJoCo Warp or MJX training versus MuJoCo C or WebAssembly at runtime must be checked sim-to-sim; I have not verified how large the differences are.
4. **Fast thin weapons may pass through targets ("tunneling").** MuJoCo's rigid contact is soft and computed per time step. The continuous collision detection I found applies only to deformable (flex) bodies under an experimental contact mode ([docs](https://mujoco.readthedocs.io/en/stable/XMLreference.html)). Mitigations: thicker collision shapes, speed caps, smaller time steps.
5. **Jev rate limits and unverified latency.** Also, Jev's outputs are probabilistic, so replays should log its decisions.
6. **Scope.** Humanoid control, freeform builds and Jev tactics are three separate research projects. Do not start all three at once.

## Open questions
- What is Jev's real end-to-end latency and tail latency from Chris's machine? The docs pages I checked state none, and the 70-500 ms figure is a vendor claim I couldn't find there. Measure p50/p95 before settling the tactical-layer rate.
- Will TypeSafe raise the 1,200 requests/min per-account limit? That limit caps concurrent matches at about 3 when two robots each call at 3 Hz. The fallback is a locally hosted open clone such as Jev-Omni.
- How large is the gap between MuJoCo Warp/MJX used for training and MuJoCo C/WebAssembly used at runtime? This needs an empirical sim-to-sim test for contact-heavy fighting before policies are trusted in the browser.
- Does MuJoCo offer continuous collision detection for rigid bodies? What I found applies only to deformable bodies under an experimental contact mode. Fast spinner weapons may pass through targets unless collision shapes are thickened or time steps shortened.
- Which mocap sources can be licensed for commercial use? This needs checking before relying on any public dataset (e.g., LAFAN1) for humanoid strike skills.
- Does Chris have hands-on deep-RL experience? Mini Moto used custom physics, not RL, and the v1 humanoid estimate assumes a learning curve on mjlab or Playground.
- Is Jev actually a better tactician than a scripted or self-play RL tactician at the same decision rate? v0 should test this directly, because the premise depends on it.
- Can the game allow matchups between different body types, e.g. wheeled vs humanoid? RoboSumo trained only same-type matchups, and cross-type balancing is untested.