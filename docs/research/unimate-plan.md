# UniMate: what to take for the fighting robots

**Verdict:** Yes, but you'd be borrowing a little math and one habit from UniMate, not a model. Its network generates 2-second kinematic clips. The clips have no torques, contacts or joint limits, take seconds to minutes each on a laptop, and the weights have no clear commercial license, so the network can't sit in a browser fight loop. What carries over is ordinary graph analysis (BFS order, relation codes, hop distance, a facing frame from a symmetric pair), the habit of starting every new motion chunk from the true current pose, and the idea of summarizing the whole body in one card. That is one or two days of TypeScript. "Our own version" should be a body compiler that turns each player build into a typed move menu, procedural controllers that run those moves under real motor limits in MuJoCo WASM, and Jev as the corner man picking from that menu. Ship v1 with wheeled and tracked bots and no runtime MPC. Legs are a gated v2 bet and bipeds are v3.

## What to steal
- Skeleton-only features computed once per build. UniMate's code keeps everything that depends only on the skeleton apart from the per-step work (graph bias, RoPE angles, pooled vector). Our version is a body compiler that runs in about 1 ms on save and again when a part breaks, so damage mid-bout re-derives roles and moves deterministically.
- BFS order from the root, with parent features. This gives one canonical DoF order for state vectors, replays, hashing and the text of Jev's state, which makes logs and answers comparable across builds.
- Relation codes plus hop distance and the end-effector code, read as plain graph facts. Uses: limb chains (leaf to nearest branching node, Spore's rule), strike chains, the end-effector list, and 'which moves use this joint', so a broken joint disables exactly the moves that depend on it.
- A facing frame from a symmetric pair, with rest-relative targets. Skill targets live in an opponent-relative facing frame. We find the pair with AHU subtree hashing plus mirrored rest offsets, not with an LLM, and canonicalize hinge-axis signs across mirrored limbs.
- A pooled whole-body summary, as a hand-built physical body card: mass, COM height, support polygon, reach per end effector, torque-to-weight per chain, weapon energy, self-righting method. It sets controller defaults and goes into Jev's state as 8-10 lines. The only evidence is one learned ablation (FID 0.757 vs 0.825), so treat this as a design choice, not a proven win.
- Clamp-and-infill, read as receding-horizon control. Every new plan starts from the true simulated state. 'Lock the legs, regenerate the arm' becomes 'resample only the parameters of the limb in play'. Keyframe pinning (paper Sec. 5.5) becomes 'pin the IK impact pose, fill in the rest'.
- The paper's own warning about symmetric eigenspaces (Appendix C.3). Never trust individual Laplacian eigenvectors on symmetric builds. If spectral features are ever used, cut only at eigenvalue gaps and use only sign-invariant quantities.
- 'One model for any skeleton', reframed as one question set compiled per body. The typed move menu enumerates what this build can do, and Jev's choice questions are generated from it. That is where our generalization across bodies lives.
- Minor, only if kinematic clips are ever played (cosmetic walk-outs): the paper's foot-lock recipe (detect contacts, 5-frame median filter, DLS IK over up to 3 parents, 5-frame blend), and the trick of precomputing text embeddings so FLAN-T5 never ships.

## What not to use
- UniMate's network in the fight loop. It outputs kinematic 60-frame clips with no torque, contact or joint-limit awareness, and costs seconds to over a minute per clip on laptop GPUs (estimate; the shipped generate.py defaults to adaptive dopri5, so real speed is unmeasured).
- The released weights for any shipped content until the authors grant a license. The model card has no license field, and the training data carries Truebones, Mixamo and per-object Objaverse terms.
- UniMate's data pipeline (Blender bpy 4.0.0 on Python 3.10, LLM joint naming) for player builds. It is a heavy offline dependency that adds nothing to a physics controller.
- Diameter normalization to 2.0. Physics needs absolute scale, and timing has to come from real torque and inertia.
- The learned pieces (per-layer bias embedding tables, SignNet MLPs, the 4-query attention pool). Without the trained network they compute nothing useful.
- Laplacian eigenvectors in v1. Nothing consumes them: left/right pairing uses hashing, and there is no runtime MPC to shape.
- The hop kernel exp(-d/l) with clamped distances as a sampling covariance. It is not guaranteed positive semidefinite on the DoF graph. If correlated noise is tested in v2, use the heat kernel exp(-tL).
- Golden-test parity with topology_utils.py conventions (sym-normalized Laplacian, hop clamp of 5, ts_token_conn). No downstream model reads them.
- The 3-DoF-per-joint representation with HML reordering. Leaf rotations are never generated and the last child wins, which throws away the fist, claw and hammer orientation that decides hits.
- From the earlier draft, also dropped: continuous or fall-recovery MPC; a 10 ms softened-contact planner judged on peak force; reaction wheels sold as balance; SIMBICON for free-form bipeds; Jev nouls as sub-second reflex forecasts; 2-4 Jev calls per second per robot; and the six-button direct-control remap in v1.

## First experiment
"Can anyone's laptop run the fight, and can Jev keep up?" Timebox: 4 days with Claude Code. Out of scope: UniMate, the builder UI and runtime MPC. These runs load the M3 Max and a borrowed laptop, so start them when Chris is ready.

SETUP
- A Vite page with no special headers.
- The single-threaded @mujoco/mujoco 3.14.0 build. Compile the WebAssembly.Module once and post it to every worker.
- Three hand-written MJCF scenes:
  - S1 is the v1 scene. It has two wheeled brawlers of about 12 bodies each:
    - A: a 4-wheel chassis with a 3-link IK arm and a hammer.
    - B: a 1-DoF vertical spinner disc (target 3000 rpm) and 6 mm armor plates.
    - Both use motor actuators driven by JS PD at every step, with forcerange, armature and frictionloss.
    - Collision uses primitive geoms. A variant swaps in convex-mesh armor.
  - S2 is the v2 worst case: two 25-body legged robots in a clinch, one of them on the ground. Log ncon; aim for 30-50 contacts.
  - S3 is the preview scene: one wheeled brawler plus a mocap ghost.
- The sim worker runs a wall-clock fixed-step accumulator at 500 Hz and posts poses to a plain three.js view. Overload mode is logged slow motion.
- Two preview workers stay busy running S3 rollouts.
- Native reference: build MuJoCo from source with CMake and run its testspeed sample on S1 and S2 on the M3 Max. This gives a measured WASM-to-native ratio.

MEASURES
1. mj_step cost for S1, S2 and S3: mean and p99 per 1000-step batch, plus ncon.
   - Test matrix: Chrome, Safari and Firefox on the M3 Max; Chrome and Edge on a 4-core Windows laptop.
   - Run each as a sustained 3-minute session on battery, with rendering on and both preview workers busy.
2. The sim worker's real-time factor and its share of late 16.7 ms ticks over those 3 minutes.
3. Rollouts per second per worker in S3, at the authoritative 2 ms step with a 0.5 s horizon (250 steps).
4. State copy. In the sim worker, call mj_getState(mjSTATE_INTEGRATION) and serialize the JS controller state. Load both with mj_setState into a fresh instance of the same model in another worker. Step both for 0.5 s with identical ctrl.
   - Require bitwise-identical qpos and qvel.
   - Also check that the same instance replays deterministically.
   - Time mj_setState(number[]) against writing the live TypedArray views directly.
5. Spinner tunneling. Drive the spinner into the 6 mm plate 200 times from randomized approaches.
   - Count missed contacts and penetration spikes at 500 Hz and at 1 kHz.
   - Try an analytic swept-arc hit test in JS that applies impulse through xfrc_applied.
6. Jev probe (half a day). A Cloudflare Worker using the typesafe/jev binding, with a 40-question fight payload (noul questions carry criteria {true, false}).
   - Make 200 calls at 1 call per second from Chris's location, and repeat through an EU VPN.
   - Record p50 and p95 latency and the tokens per call.
   - Check whether repeated question definitions are billed as cached input.
   - Record what happens near the rate limit (any 429s and the message returned).

Suggested schedule:
- Day 1: scenes, sim worker, native testspeed.
- Day 2: the browser matrix and sustained runs.
- Day 3: state copy, spinner tests, rollout rates.
- Day 4 morning: the Jev probe.
- Day 4 afternoon: write-up and decisions.

DECISION BANDS (pre-registered; measured on the 4-core Windows laptop, slowest tested browser)

GO: build v1 as planned. All of these must hold:
- S1 mean step is at most 0.6 ms (30% of a core at 500 Hz).
- Under 1% of ticks are late over 3 minutes.
- State copy is bitwise identical.
- Jev p95 is at most 700 ms from Chris's location.
- The account quota supports at least 5 concurrent bouts at 1 call per second.

ADJUST
- S1 mean between 0.6 and 2.0 ms: drop to 250-333 Hz, soften the contacts and use primitive colliders only. Rerun once; the target is 30% of a core or less.
- Jev p95 between 700 and 1200 ms, or quota for fewer than 5 bouts:
  - Raise the call interval to 2 s.
  - File Cloudflare's Custom Requirements Form.
  - Move BYOK into M1.

RETHINK the browser premise
- Trigger: S1 mean above 2.0 ms, or the sim can't hold real time at 250 Hz on the laptop.
- Options: simpler bodies, lower rates, or a desktop-only (Steam) performance tier.

If Jev is unusable (p95 above 1200 ms, or no workable quota), Jev becomes a between-rounds coach. It sets tactics at round start and after knockdowns, and the local AI fights.

INFORMATIONAL (these don't gate v1)
- S2 cost sets the v2 legged budget. A mean above 1.2 ms on the laptop means legged builds need simplified collision or a desktop tier.
- The S3 rollout rate decides whether Jev previews fit M4.
- The spinner result picks thick proxies or the swept-arc test.
- State copy:
  - If it isn't bitwise, find the missing state component or copy the live arrays instead.
  - Only nondeterminism within a single instance would block replays and PvP.

## How the critiques were resolved
VERIFIED THIS PASS (primary sources, rechecked by me)

These settle the disputed facts:
- **MuJoCo state functions.** mj_getState, mj_setState, mj_copyState, mj_stateSize, mj_inverse and mjd_transitionFD are all declared in the @mujoco/mujoco 3.14.0 typings (checked in mujoco.d.ts). mj_setState takes number[].
- **MuJoCo enums.** The same typings define the mjtState enum including mjSTATE_INTEGRATION, the mjINT_DISCRETE integrator, and the mjDYN_PID and mjDYN_DCMOTOR actuator dynamics.
- **actuator_forcerange** is declared "readonly ... any". Whether its elements can be written in place is still unknown.
- **Integrators.** The computation docs confirm that implicit and implicitfast leave position stiffness explicit, and that only the discrete integrator puts actuator position feedback into its implicit term.
- **Contacts.** refsafe replaces solref[0] with max(solref[0], 2*timestep). I found no rigid-body continuous collision detection in the docs.
- **The 81 µs anchor was a misreading.** Discussion #1522 is thread 0 of a 512-thread run. Issue #986 measures 33.6 µs per step. The design's "irreconcilable" conflict came from that misreading.
- **Workers AI limits.** Text Generation defaults to 300 requests per minute. Paid-plan models get 20 per minute (50 with prepaid credits). The Jev page doesn't mention a Paid-plan requirement.
- **Jev API.** Noul questions need criteria {true, false}. Score answers return an interpolated score plus per-level probabilities. That partly contradicts game-shipper's claim that no scalar is documented, so the scalar stays.
- **Jev latency.** TypeSafe quotes 70-500 ms, measured from US West Coast laptops.
- **UniML3D** is public and ungated: 53.4 GB, 13,769 clips, Truebones motions excluded, annotations under ODC-BY, captions in a motion_captions.json sidecar. The sidecar's size is still unverified.
- **Reaction-wheel arithmetic rechecked:** 27 N·m of toppling torque, 16 kW at 600 rad/s, and about 1 degree of holdable tilt with a few N·m of motor torque.

ACCEPTED WITHOUT RECHECK (critic-reported)
- MJPC's 1-20 ms planning figures come from multi-threaded rollouts on a 72-core Xeon, with an M1 Pro as a secondary machine.
- C-PBP samples 35 parameters, so the "few parameters" lesson is my own inference, not C-PBP's finding.
- The fan-out tutorial is MarkTechPost's, not TypeSafe's.
- Safari lacks COEP credentialless.
- The WASM README calls Windows support experimental.
- The WASM file size.
- performance.now() is coarsened to about 100 µs without cross-origin isolation.

Secondary claims (api.typesafe.ai, 1,200 rpm, signups paused) are labeled as secondary.

CONTROL-PRACTITIONER

FATAL: "M0 can't answer its question." Accepted, and M0 was rebuilt:
- The cart-vs-statue MPC test is gone.
- M0 now tests what v1 needs: sustained physics on the real v1 scene, plus a worst-case legged clinch scene recorded for information.
- The single 1e-6 test is split. Bitwise same-model state copy now uses mj_getState/mj_setState with mjSTATE_INTEGRATION plus serialized controller state.
- Planner-vs-truth fidelity drops out of M0, because previews now run at the authoritative step.
- The decision bands are closed and pre-registered.
- The MJPC humanoid-stand port becomes the v2 legs gate, not M0. v1 has no legged bodies, so testing it first would spend week 1 on a v2 question. This is a partial rejection, with that reason.

FATAL: "Event-triggered MPC can't do fall recovery." Accepted. Recovery is removed from MPC's jobs. MPC now handles only get-up and self-righting from rest, and only in v2.

SERIOUS items, all accepted:
- PASS/PIVOT gaps: the bands now run continuously from 0.6 to 2.0 ms.
- Refsafe mismatch, the infinite-mass ghost, and tunneling:
  - previews and exams run at the 2 ms authoritative step
  - preview outcomes use dense metrics (closest approach, closing speed, impulse)
  - a spinner tunneling test is in M0
- Explicit kp:
  - the stability claim is removed
  - L0 is now JS PD plus feedforward at physics rate, with armature
  - the discrete integrator is tested in v2
- Missing actuator physics: armature, frictionloss and a torque-speed clamp are added. pid and dcmotor are evaluated in M2.
- Reaction wheel:
  - reaction wheels are recast as trim parts
  - the CMG is the balance part
  - bipeds move to v3
  - knockdowns become gameplay
- Spinners: capped RPM with thick proxies, or a swept-arc JS test. M0 decides.
- SIMBICON limits: bipeds are v3, catalog leg templates only, and the builder warns that most free-form bipeds will fail.
- Strike replanning: strikes are aimed analytically, re-aimed only through IK during the swing, and committed after launch. The 10-20 Hz replanning is dropped.
- Hit detection: hits are impulse over a window plus normal speed at onset.
- Scheduling:
  - a fixed-step accumulator with a defined overload mode
  - 1000-step batch timing
  - sustained 3-minute runs on battery
- Skill-exam budget: tens of seconds to minutes, run progressively in the background while building, never re-run mid-bout.
- Jev preview fidelity: previews run at the authoritative step, only when a Jev call is being prepared. The staleness gate now uses time-to-contact.
- Readability: there is no MPC motion in v1, so the risk is lower. It is kept as a check through the M1 week of watching bouts, and as a jitter metric for v2.

FAITHFUL-TO-SOURCES

FATAL: "Measure 5 can end in a false KILL." Accepted. The state-copy test now uses the same model, bitwise comparison and mjSTATE_INTEGRATION. A failure leads to diagnosis and a fallback to copying live arrays, never to KILL. Only nondeterminism within one instance would block replays and PvP.

SERIOUS items:
- UniMate is overstated. Accepted in full: the verdict and section 1 now say plainly that UniMate transfers little.
- Laplacian-basis problems (axis sign, scaling, eigen cut, PSD): accepted. The basis is dropped from v1. If tried in v2, it uses the heat kernel, sign canonicalization, per-DoF scaling and cuts at eigenvalue gaps.
- Position actuators conflict with torque controllers: accepted. L0 is JS torque at physics rate.
- Stability of a 10 ms planner: avoided by previewing at 2 ms. The discrete integrator is tested in v2.
- M0 tested only the easy case: accepted. See the control-practitioner resolution.
- Underpowered statistics: the M0 strike A/B no longer exists. v2 A/Bs are paired, n ≈ 200, with a McNemar test.
- Skill-exam budget: accepted.
- Jev latency is a vendor figure: accepted. The design now assumes 0.4-0.9 s staleness and adds an EU VPN probe to M0.
- Cost and rate limits: accepted. The Jev probe moves to week 1, with caps, Turnstile, a kill-switch and BYOK.
- Nouls as reflex forecasts: accepted and dropped. Reflexes are local.

GAME-SHIPPER

FATAL: "The rate limit fits one bout." Accepted and verified (300 rpm). Calls are now event-driven at about 0.5-1 per second per bout, with both robots in one call. The concurrency formula is published in the plan, the Custom Requirements Form is filed on ADJUST, and M0 probes the quota.

SERIOUS items:
- Staleness gate drops Jev when it matters: accepted. Jev acts between exchanges, and the playbook fights inside striking range.
- Unclear core loop: accepted. v1 is a coach game with a few player calls. The six-button remap moves to a v2 experiment.
- Missing builder and MJCF generator milestones: accepted. They are now explicit (M2, M3), the estimate is now 12-16 weeks for wheeled-only v1, and legs and bipeds are pushed out.
- UniMate port is ceremony: accepted. It shrinks to 150-250 lines with no golden parity against topology_utils.py.
- False PASS from a weak baseline: moot, since the MPC strike test is removed. v1 aiming is analytic.
- Contradictory determinism test: accepted, as above.
- Timestep-dependent hits and fast weapons: accepted, as above.
- Cost underestimate: recomputed at 6-8k tokens per call, about $0.02-0.06 per bout, with caps.
- Burst benchmarks and no Windows testing: accepted. Runs are sustained and on battery, with Windows Chrome and Edge in the matrix.
- Too many handoffs: accepted. There is no runtime MPC in v1, and all skill transitions pass through guard.
- Unfightable builds discovered after saving: accepted. There is a live capability card and hard validation.

PARTIAL REJECTION: "Local utility AI as the default brain." Modified. Chris's constraint makes Jev the controls, so Jev authors the tactics and playbook, and the local layer executes them within a frame. Utility AI covers only the moments when Jev is late, over budget or offline.

WRONG-FACT FIXES
- The noul wire format is fixed in the example.
- The design's "no way to aim" is softened, since keyframe pinning exists.
- "No direct way in" for custom skeletons is softened, since a ~100-line conditioning builder is possible.
- The dopri5 default is noted.
- Wheels-not-in-data is marked unverified.
- "Nobody has published browser MPC" is reworded to "I found none".
- The example's previews no longer use peak force.

ACCEPTED AS RISK
- WASM speed on Safari, Firefox and Windows (M0 measures it).
- Jev's real account limits and cached-input billing (the M0 probe checks them).
- Whether actuator_forcerange can be written in place (L0 doesn't depend on it).
- Readable fight motion for legs and bipeds (v2 and v3 gates).
- The UniMate weights license (only matters for optional cosmetics).

---

# Fighting robots in the browser: what to take from UniMate (revised plan)

Tags: **[verified]** means I read it in a primary source, and I rechecked it this pass where noted. **[critic-reported]** means a critic read it and I did not recheck it. **[secondary]** means a non-primary source. **[inference]** means my own reasoning or arithmetic. Every browser timing is an estimate until M0 runs.

## TL;DR

- **UniMate gives us very little code.** Its network generates kinematic clips, it can't run in a fight loop, and its weights have no clear license. What's worth taking is ordinary graph analysis the paper uses, one sampling habit (start each chunk from the true current pose), and the idea of a whole-body summary card. That's one or two days of TypeScript.
- **"Our own version" has three parts:**
  - a body compiler that turns any player build into a typed move menu
  - procedural controllers that run those moves under real motor limits in MuJoCo WASM
  - Jev picking from the menu as the robot's corner man
- **v1 scope.** A wheeled and tracked auto-battler with 1-DoF weapons and IK arms, and no runtime MPC. Legs are a v2 bet with their own go/no-go. Bipeds are v3 and research-grade.
- **How Jev is called.** Only on events, about 0.5-1 call per second per bout, with both robots in one call. Jev writes a playbook that the local layer runs instantly. Jev never forecasts sub-second events. The game has to stay fun when answers arrive 0.4-0.9 s late.
- **First step.** A 4-day bench:
  - sustained browser physics on a Windows laptop
  - bitwise state copy between workers
  - spinner tunneling
  - a Jev probe for latency, rate limits and cost

## 1. UniMate, checked

Sources: [paper](https://arxiv.org/html/2609.05415), [repo](https://github.com/Friedrich-M/UniMate), [model card](https://huggingface.co/Linzhan/UniMate), [dataset](https://huggingface.co/datasets/Linzhan/UniML3D).

### What the sources say [verified]

**Model and output**
- A 74.1M-parameter flow-matching transformer. The released config has 10 layers; the paper says 8.
- Output is 60-frame, 30 fps clips of (T, J, 12) per-joint features.
- It is kinematic only: no mass, torque, joint limits, joint axes or contacts.
- The paper admits foot sliding, hovering and ground penetration. Skate ratio is 0.107 raw and 0.023 after IK foot-locking.

**Representation quirks**
- Every joint is a 3-DoF rotation.
- Leaf rotations are never generated.
- A branching parent keeps its last child's rotation (HML reordering in `motion_utils.py`).
- Skeletons are rescaled to diameter 2.0, so absolute size is lost.

**Speed and sampler.** The paper reports about 1.2 s per clip on one H100 with 50 fixed Euler steps. The released `generate.py` defaults to adaptive dopri5 (atol 1e-6, rtol 1e-3), so the speed of the shipped code is unmeasured.

**Custom skeletons and aiming**
- `sample.py` only animates skeletons already in the processed dataset.
- Per the code read, a custom rig can get a hand-built conditioning dict of about 100 lines instead.
- The paper supports pinning keyframes (Sec. 5.5), so an IK impact pose can be pinned and in-betweened. It still has no channel for spatial targets.

**Environment and license.** Pinned to `torch==2.5.1+cu124` and `bpy==4.0.0` on Python 3.10. The model card has no license field for the weights.

**Dataset.** UniML3D has been public and ungated since 2026-08-30:
- 53.4 GB, 13,769 clips
- Truebones motions excluded
- annotations under ODC-BY
- captions in a `motion_captions.json` sidecar

The brief's "being prepared" is out of date (rechecked this pass).

**Topology code** (`topology_utils.py`):
- relation codes {self, parent, child, sibling, no_relation, end_effector, ts_token_conn}
- BFS hops clamped at 5
- joint depth
- 8 non-trivial eigenvectors of the symmetric-normalized Laplacian (the paper text says combinatorial)

SignNet fixes sign flips but not repeated eigenvalues (Appendix C.3).

**Ablation FIDs** (held-out Truebones skeletons, one table, no error bars):

| Variant | FID |
|---|---|
| Full model | 0.757 |
| No graph bias | 0.773 |
| No Spec-RoPE | 0.798 |
| No conditioner | 0.825 |

### Browser cost [inference]

In a browser via ONNX/WebGPU, one clip costs roughly 5-40 TFLOP with fixed-step Euler, and more with dopri5. That's seconds on an M3 Max and up to a minute or more on laptop integrated GPUs, plus a 150 MB fp16 download.

### What transfers

| UniMate piece | What it is without the network | Our use | v1? |
|---|---|---|---|
| BFS order from the root, parent features | Standard tree traversal | Canonical DoF order for state vectors, replays, Jev state text | Yes |
| Relation codes, hop distance, end-effector code | Standard graph facts | Limb chains (leaf to nearest branching node), strike chains, "which moves use this joint" when a part breaks | Yes |
| Facing frame from a symmetric pair | Canonical frame | Opponent-relative frame for skill targets. The pair comes from AHU subtree hashing plus mirrored offsets | Yes |
| Global topology conditioner | Learned attention pool | A hand-built body card of physical quantities. No evidence it helps a controller; it's a design choice | Yes |
| Clamp-and-infill | Pin known values, generate the rest | Each plan starts from the true sim state; resample only the limb in play | Yes |
| Laplacian eigenvectors, Spec-RoPE | Spectral positional encoding for a network | No v1 consumer. Possible v2 sampling basis, with fixes (section 8) | No |
| Bias tables, SignNet MLPs, pool weights | Trained parameters | Useless without the network | No |
| Diameter normalization | Scale removal | Not used. Physics needs absolute scale | No |

The non-learned pieces are textbook graph analysis. The learned pieces don't survive being taken out of the network. What UniMate is good for here is a checklist of what a body representation needs, not code to copy.

## 2. Options, revised

| Option | Verdict |
|---|---|
| **A. UniMate clips as a move library** | Not for combat. Later it could make cosmetic walk-outs and taunts for catalog templates. Those would be generated offline on the M3 Max (MPS/CPU after removing the CUDA pins, untested), and only with a license from the authors. Before ruling it out, count the fight captions in the caption sidecar; that is a small download with no motion files. |
| **B. Procedural controllers compiled from the body graph** | The v1 runtime. |
| **C. Sampling MPC for all motion** | No. MJPC's cited planning speeds came from multi-threaded rollouts on a 72-core Xeon, with an M1 Pro as a secondary machine [critic-reported, [MJPC](https://arxiv.org/pdf/2212.00541)]. One or two single-threaded browser workers get far fewer iterations. |
| **D. B plus event-triggered MPC** | v2 only, behind a gate. Limited to legged get-up and self-righting from rest, never fall recovery. |

**Why MPC left v1** [inference]:
- **Fall recovery is too fast for it.** A biped with its COM at 0.8 m has a pendulum time constant of about 0.29 s. It hits the floor 0.3-0.7 s after a shove, and a cold-started plan from a browser worker arrives too late.
- **Strikes are one-shot.** Replanning mid-swing adds wobble.
- **Wheeled bots don't need it.** They are statically stable and self-right with parts, the way real combat robots do.

That leaves no v1 job that needs runtime MPC.

## 3. v1 game shape

**The core loop is a coach game.**
- The player builds a robot and writes corner notes.
- During the bout, the player makes a few big calls: PRESS, HOLD, GO LOW, BACK OFF, FINISH.
- Jev fights.

This matches "Jev is the controls" and tolerates Jev's latency. A direct-control mode, where Jev maps six buttons to body-specific moves, is a v2 experiment. With answers 0.4-0.9 s stale, "I pressed strike and got a low hammer" would feel random.

**Bodies in v1:**
- wheeled and tracked chassis
- 1-DoF weapons: hammer, flipper, lifter, vertical or horizontal spinner
- up to two IK arms with claws or hammers
- wedges

Self-righting comes from parts: an invertible chassis, a self-righting arm or a flipper. Legs, tails and bipeds wait.

## 4. Architecture

### Threads

- **Main thread:** three.js (WebGPU with WebGL2 fallback), input and UI. It interpolates pose snapshots.
- **Sim worker:** authoritative MuJoCo, layers L0-L1, the local playbook and the Jev client. A wall-clock fixed-step accumulator batches steps per tick. When overloaded it drops preview work first, then falls back to logged slow motion (single-player only).
- **1-2 preview workers:** the build-time skill exam and event-driven Jev previews.

### WASM setup

- Compile the `WebAssembly.Module` once and post it to each worker.
- Re-acquire typed-array views after any WASM memory growth [inference, general Emscripten behavior].
- The single-threaded `@mujoco/mujoco` build needs no COOP/COEP headers; the `/mt` build does ([README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)).
- Safari doesn't support `COEP: credentialless` [critic-reported, MDN compat data].

### Layers

| Layer | Rate | What | Set by |
|---|---|---|---|
| L0 motors | Every physics step, 500 Hz | PD plus feedforward in JS, on MuJoCo `motor` actuators. Torque is clamped by a torque-speed line τ_max(ω) = τ_stall(1 − ω/ω_free) and by `forcerange`. Part data gives `armature` = I_rotor·G² and `frictionloss`. Wheels use velocity PD. | L1 targets |
| Reflexes | Every physics step | Guard when an enemy end-effector's closing speed and distance cross a threshold; brace; drop stiffness after impact; brake. Triggered from local sim state. | Build defaults; temperament from Jev |
| L1 skills | 50 Hz | Minimum-jerk IK strikes aimed at the live target (yaw alignment plus reach check, re-aimed during the swing, committed after launch). Guard poses, diff-drive, weapon spin-up. Every transition passes through guard. | Local playbook |
| Local playbook | 20-50 Hz | Runs Jev's latest plan and branch answers. Utility-AI fallback when Jev is late, over budget or offline. | Jev |
| Previews | Only while preparing a Jev call | 2-4 candidate tactics, each rolled out 0.4-0.5 s at the authoritative 2 ms step | Summaries go to Jev |
| Jev | On events, at least every 1-2 s | Tactic, target, commitment, playbook branches, preview choice, how to read the player's calls | Corner notes, calls |
| Build time | While building | Body compiler (~1 ms), progressive skill exam, capability card | Jev labels odd parts |

### Why PD runs in JS, not in MuJoCo position actuators

- **Stability** [verified, [computation docs](https://mujoco.readthedocs.io/en/stable/computation/index.html)]:
  - Under `implicit` and `implicitfast`, only velocity-dependent terms are integrated implicitly. Position stiffness stays explicit.
  - Only the `discrete` integrator treats actuator position feedback implicitly.
  - So position actuators add little stability here.
- **Control:** torque-level control (feedforward, torque-speed limits, virtual forces later) needs per-step JS anyway.
- **What actually keeps stiff servos on light links stable at 2 ms** is realistic armature [inference].

**Actuator types to evaluate in M2.** The 3.14.0 WASM enums include `mjDYN_PID` and `mjDYN_DCMOTOR` [verified, [mujoco.d.ts](https://cdn.jsdelivr.net/npm/@mujoco/mujoco@3.14.0/mujoco.d.ts)]. Their attributes include `input`, `controller` and `thermal` (names verified, semantics not), so they may give thermal and current realism. Joints also have an `actuatorfrcrange` attribute (it exists; I didn't read its full definition).

### Hits

A hit counts when both are true, with both thresholds scaled by mass:
- impulse ≥ X N·s over a 20-40 ms window after contact onset
- relative normal speed ≥ Y m/s at onset

Peak force alone misfires when robots lean on each other, and it depends on timestep and `solref`. `refsafe` replaces `solref[0]` with max(solref[0], 2·timestep) [verified, XML reference], so contact stiffness shifts with timestep. Previews and the skill exam therefore run at the authoritative 2 ms step with the same integrator.

### Spinners [inference, critic's arithmetic rechecked]

At 3000 rpm a spinner turns 36° per 2 ms step, and a tip at 0.2 m radius moves 12.6 cm per step. I found no rigid-body continuous collision detection in the MuJoCo docs. So spinner hits use one of two approaches, and M0 decides which:
- thick capsule proxies with an RPM cap, or
- an analytic swept-arc test in JS each step that applies the impulse through `xfrc_applied`.

### Damage

- A broken joint goes limp: its actuator is disabled.
- Breakable parts are welds switched off through `eq_active`.
- The compiler reruns and disables moves whose chains include the dead joint.
- The skill exam never reruns mid-bout.

## 5. Body compiler

About 150-250 lines of TypeScript, unit-tested against hand-built fixtures. There's no golden parity with UniMate's conventions, because no downstream model reads them. Keep the MIT notice only if code is copied.

1. **Nodes.** MuJoCo bodies in BFS order from the chassis. Each carries mass, joint axis, range, torque, gear and part tags.
2. **Roles.** Part tags come first (wheel, track, hammer, spinner, flipper, claw, armor), following [Spore](https://www.chrishecker.com/images/c/cb/Sporeanim-siggraph08.pdf). Geometry rules cover generic links. Jev labels whatever is left, at build time.
3. **Chains.** Each chain runs from a leaf to the nearest branching node. Leaves are end effectors, and they get orientation targets.
4. **Left/right pairs.** AHU subtree hashes plus mirrored rest offsets. Hinge-axis signs are made consistent across each mirrored pair.
5. **Body card.** 8-10 lines of text:
   - mass and COM height
   - support polygon
   - reach per end effector
   - torque-to-weight per chain
   - weapon energy
   - self-righting method
6. **Typed move menu.** Every move this body can attempt ("L hammer overhead", "spinner ram left", "flip"), each with 4-8 parameters and defaults. Jev's choice questions are generated from this menu. It's our version of "one model for any skeleton": one question set per body.

**Skill exam** [inference, honest budget]:
- CEM over 4-8 parameters per move, from a few start states, at the authoritative step.
- That takes tens of seconds to minutes per build on a laptop.
- So it runs in the background while the player builds, feeding a live capability card ("L hammer: reaches torso height. Claw: can't reach.").
- Hard validation blocks saving a robot with no working weapon or no stable support.

## 6. Jev as the controls

**What Jev is** [verified]:
- It takes a state plus typed questions and returns calibrated answers. Question types:
  - choice: up to 255 options
  - score: up to 10 levels
  - noul: true/false
- **On Cloudflare** ([Jev page](https://developers.cloudflare.com/ai/models/typesafe/jev/)):
  - Noul questions need `criteria {true, false}`.
  - Score answers return an interpolated score, a confidence and per-level probabilities.
  - Input costs $0.042 per million tokens. Output and cached input are $0.
- **Latency.** TypeSafe quotes 70-500 ms end to end, measured from the US West Coast where the service runs ([blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).
- **Question cap.** The 64-questions-per-call limit comes from the brief and I couldn't verify it, so stay at 64 or fewer.

### Jobs

1. **Tactic and target.** Chosen from the typed move menu, with commitment and aggression as score questions.
2. **The playbook.** Conditional answers ("if he closes under 0.8 m", "if he tips", "if my spinner stalls", "if the player calls GO LOW") are cached. The local layer applies each one the instant its condition fires. This is how Jev's decisions reach sub-second exchanges even though Jev itself is slow.
3. **Preview judge.**
   - While a call is being prepared, 2-4 candidate tactics are rolled out 0.4-0.5 s each.
   - Each is summarized as a row: closest approach, closing speed, impulse on contact, tip risk, energy. Jev picks one.
   - These are dense measures because the opponent ghost is mocap: its infinite mass would inflate contact forces.
4. **Build-time labeling.** Jev labels ambiguous parts and names moves.
5. **Style.** Corner notes and a fighter card go into the state. Sampling from the returned probabilities, instead of always taking the top answer, adds controlled variety.

**Dropped from the earlier draft:**
- nouls that forecast "opponent strikes within 0.5 s" (the sim already knows closing speed, and the answer would arrive stale)
- periodic calls at 2-4 per second per robot
- the six-button direct remap in v1

### Latency

- Design for answers 0.4-0.9 s old once the Cloudflare hop and non-US players are counted [inference].
- The staleness gate uses time-to-contact. Inside striking range the playbook and reflexes fight, and a fresh Jev answer applies at the next disengage, reset or knockdown.
- Calls fire on events: range change, knockdown, part failure, a player call, a new opponent pattern. If nothing happens, one fires every 1-2 s anyway.

### Example request (trimmed)

```json
{"state": "t=41.2s. ME Crabhammer: 4-wheel 38kg, L hammer 3.1kg reach 1.1m, claw wrist 40% damaged, battery 61%. OPP Stilt: 2-wheel lifter 29kg, 1.4m, bearing 12deg L, backing 0.3m/s. PREVIEWS: P1 charge+overhead: min 0.02m, closing 4.1m/s, 38Ns, tip 0.05 | P2 circle L+low hammer: 0.00m, 3.2m/s, 24Ns, tip 0.02 | P3 hold+feint: min 0.31m | P4 back off. CORNER: go low, he tips easily.",
 "questions": {
  "plan": {"type": "choice", "instructions": "Preview to run now", "criteria": {"P1": "charge, overhead hammer", "P2": "circle left, low hammer", "P3": "hold, feint", "P4": "back off"}},
  "commit": {"type": "score", "instructions": "Stiffness at impact", "criteria": ["probe", "light", "normal", "heavy", "full swing"]},
  "if_tips": {"type": "choice", "instructions": "If opponent tips over", "criteria": {"pounce": "attack", "hold": "hold position", "reset": "return to center"}},
  "baiting": {"type": "noul", "instructions": "Opponent is baiting a charge", "criteria": {"true": "retreat is meant to draw a charge into its lifter", "false": "retreat is genuine"}}
 }}
```

Check the wire format against TypeSafe's SDK before use, and pin a model version if the API allows it.

### Rate limits and cost

- **Workers AI limits** [verified, [limits](https://developers.cloudflare.com/workers-ai/platform/limits/)]:
  - Text Generation defaults to 300 requests per minute per account.
  - Models that need the Workers Paid plan get 20 per minute, or 50 with prepaid credits.
  - Raising limits requires the Custom Requirements Form.
  - The Jev page doesn't say Jev needs the Paid plan. Whether the 20-per-minute tier applies is an M0 question.
- **Concurrent bouts** = account RPM ÷ 60 ÷ calls per second per bout.
  - At 300 rpm and 0.5-1 call/s per bout, that's 5-10 bouts at once.
  - The earlier draft's 4-8 calls/s per bout would have used up the whole account on a single bout.
- **Direct TypeSafe access** reportedly allows 1,200 rpm in early access, with signups reportedly paused on 2026-09-22 [secondary: [flaviocopes](https://flaviocopes.com/jev/), [firecrawl](https://www.firecrawl.dev/blog/what-is-jev)].
- **Cost** [inference]:
  - One call covering both robots is about 60 questions plus state, roughly 6-8k tokens.
  - At 0.5-1 call/s for 180 s, that's 0.5-1.4M tokens, or about $0.02-0.06 per bout before any cached-input discount.
  - At 10k bouts a day, that's $200-600 a day.
- **Worker proxy:**
  - It owns the question sets. The client sends only state and a set id.
  - Cloudflare Turnstile runs before each bout.
  - Per-session and per-IP daily caps, and a cap on state length.
  - A global daily spend kill-switch falls back to local AI and shows a "coach offline" badge.
  - BYOK for Steam and power users.
  - Each answer is logged with the tick it was applied on, so replays stay reproducible.

## 7. Browser budget [inference until M0]

**Anchors:**
- MuJoCo [issue #986](https://github.com/google-deepmind/mujoco/issues/986) measures `humanoid.xml` at 33.6 µs per step, native, single thread, with 12.6 contacts.
- The 81 µs figure in the earlier draft came from thread 0 of a 512-thread run in [discussion #1522](https://github.com/google-deepmind/mujoco/discussions/1522), so it's dropped.
- Generic WASM runs 1.45-2.5× slower than native ([Jangda 2019](https://arxiv.org/abs/1901.09056)).

| Load | Estimate |
|---|---|
| v1 scene: two wheeled brawlers, 10-15 bodies each, 8-20 contacts | 60-250 µs per step; 3-13% of a core at 500 Hz |
| v2 worst case: two 25-body legged robots in a clinch, 30-50 contacts | 200-800 µs; 10-40% of a core |
| Preview rollout: one robot plus ghost, 0.5 s at 2 ms (250 steps) | 10-40 ms |
| Previews per Jev call (8 rollouts) at ≤1 call/s | 8-32% of one worker |
| JS motors, reflexes, IK, playbook | Under 3% of a core |
| three.js, two robots | 3-8 ms per frame on an integrated GPU |

**How to measure:**
- Without cross-origin isolation, `performance.now()` is coarsened to about 100 µs [critic-reported, MDN]. Time 1000-step batches and report p99 per tick over sustained 3-minute runs on battery.
- Test Windows. The WASM README reportedly says development was mostly on Linux Chrome, macOS passed CI, and Windows support is experimental [critic-reported], and most of the audience is on Windows.

## 8. Milestones

Solo with Claude Code. v1 (wheeled and tracked) takes roughly 12-16 weeks.

- **M0, week 1:** the bench (see First experiment).
- **M1, weeks 2-3: vertical slice.**
  - Two hand-written wheeled bots, one with a hammer arm and one with a spinner.
  - Motors and skills (L0-L1), hit detection, reflexes and local utility AI.
  - A Jev corner man with 5-10 questions, through a Cloudflare Worker.
  - A three.js octagon.
  - Watch it for a week. If it isn't fun, kill it or reshape it.
- **M2, weeks 4-6: parts and MJCF.** A parts catalog v0 (10-12 parts) and a parts-to-MJCF generator that handles:
  - inertias
  - contype/conaffinity and exclude pairs for adjacent bodies
  - joint limits
  - forcerange × gear
  - armature and frictionloss
  - breakable welds

  Also in M2:
  - Fuzz random legal builds: each must load, survive a 10 s drop test, and produce no NaN or explosion.
  - The body compiler, move menu and body card.
  - Evaluate `pid` and `dcmotor` actuators.
- **M3, weeks 7-11: the builder.** 3D snap-together sockets, mirroring, validation, the progressive skill exam and live capability card, save and share. This is the product and the largest workstream, and 5 weeks is a guess.
- **M4, weeks 12-15: full game.**
  - the full question set compiled from the move menu
  - event-driven calls, the playbook, previews and coach calls
  - proxy hardening and spend caps
  - match flow, damage feedback and audio
  - v1 ships.

### v2: legs

Start only if v1 is fun and M0's legged numbers fit.

**Gate first (1 week):**
- Port MJPC's humanoid stand task to WASM workers: same model, same cost, P=3, N=10, T=23, σ=0.125, 15 ms agent step.
- Use native MJPC on the M3 Max as the reference.
- Test 20 knockdown poses in real time with no slow-down, with 1 and 2 workers, on the M3 Max and on the 4-core laptop.
- **Pass:** WASM success rate within 20 points of native, and median time-to-stand within 1.5×.
- **Fail:** legged get-up is scripted only, and leg builds need designed self-righting.

**Then build:**
- Multi-leg gaits: Raibert foot placement, MJPC phase tables, virtual legs.
- Strikes from 3 or more supports, with a static-stability check before lifting a limb.
- Get-up and self-righting MPC, starting from rest.
- Test the `discrete` integrator for stiff servos. `mjINT_DISCRETE` is in the 3.14.0 WASM enums [verified]. Use the same integrator in the planner and the sim.

**A/B tests.** For example, heat-kernel exp(−tL) correlated noise against independent noise, with three preconditions:
- hinge-axis signs made consistent across mirrored limbs
- each DoF scaled by its range or torque
- the basis cut only at eigenvalue gaps

Every A/B uses paired placements, n ≈ 200, and a McNemar test.

### v3: bipeds (research-grade)

- **Legs.** Catalog leg templates only (3-DoF hip, knee, 2-DoF ankle, flat foot), so the assumptions behind SIMBICON and Coros hold.
- **Kicks.** SIMBICON's gaits were hand-authored, and one-foot stance has a small basin of attraction ([SIMBICON](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)). So kicks need gated one-foot phases and designed transitions.
- **Stabilizers get honest limits** [arithmetic rechecked]:
  - Holding a 20 kg robot tilted 10° with its COM at 0.8 m takes about 27 N·m.
  - A reaction wheel at 600 rad/s would need about 16 kW to supply that. Reaction wheels are trim parts.
  - A control moment gyro (CMG: torque = h × gimbal rate), with gimbal-angle saturation, is the part that buys half a second.
- **Falling is part of the game.** Treat knockdowns and timed get-ups as gameplay.
- **Expect failures.** Most free-form bipeds will fail the skill exam, and the builder should say so.

## 9. Buildable now vs research

| Buildable now by one person | Research-grade |
|---|---|
| Wheeled/tracked physics in MuJoCo WASM (pending M0) | Runtime sampling MPC in browser workers (I found no published example) |
| Body compiler, move menu, body card | Laplacian or heat-kernel sampling for get-up |
| JS PD with torque-speed limits, IK strikes, reflexes | Fight motion from MPC that reads well |
| Jev corner man with playbook and previews | Free-form bipeds, CMG balance |
| Parts-to-MJCF generator with fuzzing | Online PvP lockstep across browsers (WASM float determinism untested) |

## 10. Unknowns

- MuJoCo WASM step cost in Safari, Firefox and on Windows laptops.
- **State functions.** `mj_getState`, `mj_setState`, `mj_copyState`, `mj_stateSize`, `mj_inverse` and `mjd_transitionFD` are declared in the 3.14.0 typings [verified]. The README calls the bindings untested in real apps. `mj_setState` takes `number[]`, which may force a copy on every call.
- **Forcerange writes.** `actuator_forcerange` is declared as a readonly property of type `any`. Whether its elements can be written in place is untested.
- **Jev service limits.** Latency outside the US, account rate limits, whether question definitions are billed as cached input, and the real cap on questions per call.
- **Flywheel and CMG energy drift** under `implicitfast`, which drops gyroscopic derivative terms.
- **UniML3D fight clips.** How many there are; the caption sidecar answers this.
- **UniMate license.** Whether the weights and the clips they generate can be used commercially.

## Sources

- **UniMate:**
  - paper: https://arxiv.org/html/2609.05415
  - repo: https://github.com/Friedrich-M/UniMate
  - topology code: https://raw.githubusercontent.com/Friedrich-M/UniMate/main/unimate/utils/topology_utils.py
  - model card: https://huggingface.co/Linzhan/UniMate
  - dataset: https://huggingface.co/datasets/Linzhan/UniML3D
- **MuJoCo:**
  - WASM README: https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md
  - WASM typings: https://cdn.jsdelivr.net/npm/@mujoco/mujoco@3.14.0/mujoco.d.ts
  - computation docs: https://mujoco.readthedocs.io/en/stable/computation/index.html
  - XML reference: https://mujoco.readthedocs.io/en/stable/XMLreference.html
  - speed issue #986: https://github.com/google-deepmind/mujoco/issues/986
  - speed discussion #1522: https://github.com/google-deepmind/mujoco/discussions/1522
- **Control and performance:**
  - MJPC: https://arxiv.org/pdf/2212.00541
  - WASM vs native (Jangda 2019): https://arxiv.org/abs/1901.09056
  - SIMBICON: https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf
  - Spore: https://www.chrishecker.com/images/c/cb/Sporeanim-siggraph08.pdf
- **Jev:**
  - Cloudflare model page: https://developers.cloudflare.com/ai/models/typesafe/jev/
  - Workers AI limits: https://developers.cloudflare.com/workers-ai/platform/limits/
  - TypeSafe launch post: https://typesafe.ai/blog/introducing-system-one-models-and-jev
  - secondary: https://flaviocopes.com/jev/, https://www.firecrawl.dev/blog/what-is-jev
- **Browser timing:** https://developer.mozilla.org/en-US/docs/Web/API/Performance/now