# GROUND TRUTH: the engineer's fight league

Ground Truth is a browser robot-fighting league where the physics is the product. Every part is a real catalog part with a real spec sheet. Every joint is a datasheet-driven DC motor inside MuJoCo WebAssembly. There are no animations, no invisible balance forces and no trained policies. Motion comes from classical control plus a sampling planner that uses the physics engine itself as its model. Moves are "forged" at build time by optimizing trajectories against each robot's actual motor limits. Jev is each fighter's mind, and it is used in one specific way: Jev proposes, physics disposes. Its calibrated tactic distribution decides where the planner spends its rollouts. Its score answers set the planner's cost weights: reach vs balance vs heat vs battery. Its yes/no probabilities pre-tension joints, and that bracing costs real copper heat. Fights are deterministic files. Each fight publishes an energy ledger showing how much of the outcome came from non-physical game models. A winning design at 12 lb or under exports a buildable bill of materials with plate DXFs, labeled "sim-validated within spec tolerance, not a win guarantee." Once a season, one design is built for real and fought at NHRL against a pre-registered prediction.

# Ground Truth: the engineer's fight league

**Angle:** physical truth. Real actuator models, real materials, real spec sheets, and nothing that moves the robot except its own motors. Tags: [vendor] company claim, [paper] authors' own result, [indep] third party, [calc] my arithmetic, [est] my estimate, **[beyond digest]** research I added.

## 1. Core loop

1. **Build.** Snap real catalog parts together: actuators, drivers, batteries, parametric plates, fasteners.
2. **Certify.** This takes about 1–2 minutes and runs in Web Workers:
   - a virtual dyno for each actuator;
   - a shakedown (drop, sweep, push, stall-heat), as in the digest;
   - a rules linter against NHRL 2026 and SPARC v1.5;
   - **move forging**: the robot's strikes are discovered by optimization on its own motors (section 5).
3. **Brief the mind.** Write a doctrine of 150 words or less. Jev labels any ambiguous limb chains.
4. **Fight.** Ranked fights run in chess-clock mode. The sandbox runs live.
5. **Watch.** A replay file shows telemetry overlays, "ghost futures" (the plans the fighter considered) and the energy ledger.
6. **Tear down.** A forensic post-mortem, for example: "M5 grade 5 bolt at arm_L root sheared at 4.1 kN against a 3.6 kN rating; the panel detached at t=41.2 s." Wear odometers carry into the next fight.
7. **Iterate.** Swap a part, re-forge, re-fight.
8. **Export the BOM** (12 lb class and below only).

## 2. Where the research recommended GPU-trained RL, and what replaces it

| Dossier recommendation | Replacement (training-free) |
|---|---|
| MJWarp/mjlab self-play skills exported to ONNX | Build-time **move forging** (iCEM trajectory optimization in the browser), plus runtime sampling MPC |
| Pretrained "certified leg modules" and a cloud "train my walker" job | Procedural IK gaits built from the kinematic graph, in the style of Coros et al. 2011, whose quadruped skills used gait graphs and Jacobian-transpose virtual forces with no learning ([UBC](https://www.cs.ubc.ca/~van/papers/2011-TOG-quadruped/index.html)) [paper] **[beyond digest]** |
| HoST-style learned get-up; RL humanoid striker in v1 | Real self-righting hardware (arms, lifters, momentum wheels) plus a 10-count. The humanoid becomes a v2 exhibition class on SIMBICON ([PDF](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)) [paper] **[beyond digest]** |
| Authoritative sim server in AWS us-west-2 | Sim in the player's browser, a thin schema-locked Jev proxy, and anyone can verify a replay by re-simulating it |
| "Assisted mode" upright forces | None. Stabilizers exist only as parts with mass, power draw and saturation |

## 3. Engine and platform

- **Physics:** MuJoCo 3.14, official `@mujoco/mujoco` single-threaded WASM build, pinned per season.
  - 1 ms fixed step (2 ms fallback), `implicitfast` or `discrete` integrator, Newton solver, elliptic cones (digest).
  - The single-threaded build needs no COOP/COEP headers, so it runs on any static host ([README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)) [vendor].
- **Worker layout** [beyond digest]:
  - one physics worker;
  - 2–3 **planner workers**, each holding its own MuJoCo instance of a reduced "planner model": own robot in full, opponent as capsule proxies, cage walls;
  - the main thread renders with three.js WebGPURenderer, falling back to WebGL2, from interpolated snapshots.
  - The README does not say whether independent instances can run in separate workers. I infer they can, and that is a Phase 0 gate.
  - mjswan measured a 0.30 ms worker round trip and 0.03 ms to send a 30-body, ~1.7 KB snapshot. It also found that a worker that never yields delays its messages by a median 1,008 ms, so planners must work in chunks ([mjswan #117](https://github.com/ttktjmt/mjswan/issues/117)) [indep].
- **Fallback:** Rapier's deterministic JS package with scripted moves only (digest).
- **Steam:** Electron wrapping the same pinned `.wasm`.

## 4. Robot body scope for v1

- **v1: 12 lb class (5.44 kg), NHRL-sized, articulated brawlers.**
  - Base: wheeled or tracked.
  - Up to 2 arms of 3 DOF or less, plus one weapon. Weapon options: hammer, electric lifter/flipper, clamp, high-ratio crusher, or a vertical spinner with capped energy (resolved analytically, as in the digest).
  - A limit of about 24 control channels (digest).
  - Why 12 lb: bots must fit a 36-inch cube and fight in NHRL's real 16×16 ft boxes ([NHRL](https://wiki.nhrl.io/wiki/index.php/Cage_Design)) [indep]. That is where the digest says BOM export is safe and honest, and no balance policy is needed.
  - The actuator catalog fits the weight: RobStride 02 is 405 g and AK80-9 is 490 g ([CubeMars](https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html)) [vendor].
- **v1.5: True Walker class.** Statically stable hexapods and quadrupeds with generated IK gaits. They get NHRL's +100% weight bonus, so 24 lb ([rules](https://wiki.nhrl.io/wiki/index.php?title=NHRL_Open_Rules_-_2026)) [indep].
- **v2: Open class, humanoids at G1 scale.** Sim-only with no BOM. SIMBICON balance plus a real reaction-wheel part. Clumsy but honest: falls are real, and the 10-count decides.

## 5. Control stack, layer by layer (zero training)

| Layer | Rate | Mechanism |
|---|---|---|
| L0 Motors | 1 kHz | MuJoCo `dcmotor`, whose built-in controller (kp/ki/kd, slew, Imax, Vmax) **is the motor-driver part**. A battery-bus sag model writes V_bus into Vmax each step (digest). |
| L1 Servo auto-tune | build time | kp = J_eff·ωn², kd = 2ζ·J_eff·ωn, with J_eff from `mj_fullM` plus rotor inertia × N². ωn is capped by the driver's current loop. A textbook critical-damping recipe [est]. |
| L2 Primitives | 100–200 Hz | Differential-drive PI; damped-least-squares IK from `mj_jacSite`; **forged moves** replayed through PD tracking; generated gaits; momentum-wheel balance and self-righting. |
| L3 Reflex/arbiter | 100 Hz | Priority order: self-right, then brace, then guard, then plan. Also legality masks, commit windows, and contingencies armed by Jev. |
| L4 Sampling MPC | 5–10 Hz | Predictive sampling over **primitive parameters** (tactic, target point, bearing, timing, commit), 4–8 dimensions. It never samples raw torques. Rollouts run on the planner model; cost weights come from Jev. |
| L5 Jev | 2–5 Hz | One call per fighter (section 6). |

**Is L4 feasible in a browser?** MJPC's predictive sampling used N=10 rollouts over 23–35-step horizons and took 1–20 ms per update on multicore CPUs. Its cost is a weighted sum of residual terms, and the weights are exposed as sliders ([arXiv 2212.00541](https://arxiv.org/html/2212.00541)) [paper]. Those sliders are exactly the knobs Jev will turn.

My budget [est, must benchmark]: 24 samples × 60 steps (300 ms at a 5 ms planner dt) × ~0.1 ms per step on the reduced model ≈ 144 ms single-threaded, or about 50 ms across 3 workers. That supports 5–10 Hz replanning. Ranked chess-clock fights have no real-time constraint at all.

**Move forging** [beyond digest]. At certify time, iCEM optimizes each weapon chain's spline-knot trajectory against goals the code generates from the part graph: "maximize hammer tip speed at a target 20–30 cm ahead while keeping base COM margin above 0," "lift a 5 kg test block," and so on. iCEM reports 2.7–22× fewer samples than plain CEM ([arXiv 2008.06389](https://arxiv.org/abs/2008.06389)) [paper].

- **Budget** [est]: about 800 rollouts × about 30 ms each (single robot, 2 ms step) comes to about 25 s per primitive per worker, so about 1 minute for a 5-move set.
- **Output:** each move ships with a measured datasheet: peak tip speed, joules on target, winding temperature rise per strike, and recovery time.
- **Hardware drives moves:** change a gear ratio and the moveset re-forges.

**Stabilizers are energy storage, and the rules can see that** [calc, beyond digest]. Cubli jumps up by braking spun-up momentum wheels ([ETH](https://idsc.ethz.ch/research-dandrea/research-projects/archive/cubli.html)) [indep]. Take a 12 lb bot with pivot inertia of about 0.18 kg·m² whose center of mass must rise 8 cm to flip over. That needs about 4.2 J, which requires h = √(2·I·ΔE) ≈ 1.2 N·m·s of stored momentum. A 0.62 kg, 100 mm steel disc would have to spin at about 15,000 rpm, storing **about 950 J**. That is spinner-weapon energy. So the linter classifies parts by stored joules, whatever the player calls them. That is a real design tension, and the game gets it from the physics for free.

## 6. Exactly how Jev is used

**One call per fighter per decision.** It carries about 20 questions over roughly 700 tokens of worded state. Code converts all geometry into bands first, because Jev "cannot reliably judge whether two values are near each other" ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)) [vendor].

| Question type | Count | What it asks |
|---|---|---|
| choice: `tactic` | 1 | ~10 options |
| choice: `target` | 1 | Opponent's exposed parts, from their part graph |
| choice: `bearing` | 1 | 8 clock sectors |
| score (5 levels): cost weights | 6 | Reach/hit priority, stability margin, heat budget, battery budget, cage avoidance, guard over own weak part |
| score: `commit` | 1 | How committed the next move should be |
| noul | 3 | Opponent commits within 0.5 s? My weak part exposed? Their spinner below 60%? |
| choice: contingencies | 3 | If lunge / if flipped / if pinned |
| noul: `shift_low` | 1 | For a two-speed shifter part, modeled on AndyMark's pneumatic shift-on-the-fly EVO ([AndyMark](https://andymark.com/products/evo-shifter)) [vendor] |
| score: `winning` | 1 | Who is winning |

**How the probabilities are used** (items 1, 2 and 4 are beyond the digest):

1. **The proposal prior.** The planner splits its N samples across tactics in proportion to p_k^(1/T), with one sample for any tactic above 5%. Physics verifies each candidate and the lowest-cost plan wins. Jev never does arithmetic, and the controller never needs training.
2. **Weights and noise.**
   - Weight: w_i = w0·2^(E[level]−2).
   - Planner sampling noise: σ ∝ (1 − confidence). An unsure mind explores more.
3. **Stability of choices.** Hysteresis of 0.15. Contingencies are armed only at confidence ≥ 0.5 (jevbox pattern, [repo](https://github.com/duc-minh-droid/jevbox)).
4. **Look-ahead feedback, one tick late.** The top 3 rollouts are summarized in words and added to the next call, e.g. "overhead: predicted 0 J, out of reach; low sweep: ~40 J on front-left wheel." This is the jev-robotics-demo pattern ([repo](https://github.com/FazalAAli/jev-robotics-demo)) with no added latency.
5. **Bracing.** The noul probabilities set bracing stiffness (novel idea 3).

**Other Jev roles:**
- **Build time:** a role `choice` per ambiguous chain (weapon, shield, drive, leg, grapple, ballast).
- **Judge:** per 10 s window. The Damage criterion reads the **energy ledger**, so it is objective. Jev scores aggression and control.
- **Director:** code only, and prescient in replays.

**Cadence:**
- **Live:** adaptive 2–5 Hz. The MPC keeps executing the last weights while the next call is in flight.
- **Ranked:** chess-clock, 4 Hz ticks, frozen state, fixed 150 ms simulated reaction delay. Planning runs synchronously with a seeded PRNG, so fights are fully deterministic. The log stores both Jev answers and the plan the MPC selected.

**Key handling.** Jev's API docs say nothing about CORS or client-side keys ([API](https://docs.typesafe.ai/api)). Assume browsers cannot call it directly.

- **House key:** a Next.js route or Cloudflare Worker proxy that is **schema-locked**. It forwards only the game's fixed question IDs, a pinned `jev-1.13.0`, and state under 4 KB. It runs per-session and per-IP token buckets and a 2,000-call fight budget. A leaked session cannot use it as a general Jev endpoint.
- **BYOK:** "Sign in with OpenRouter." OAuth PKCE gives the player a user-owned key with no backend ([OpenRouter](https://openrouter.ai/docs/guides/overview/auth/oauth)) [vendor]. Jev is served there at `/api/v1/systemone` (digest). Browser CORS on that endpoint is **unverified**.
- **Offline:** the MPC autopilot runs on doctrine default weights under a "JEV OFFLINE" badge. The robot still fights well, because physics and the planner do the fighting.

**Cost** [calc on [vendor] prices]:
- A live fight: 2 fighters × 3 Hz × 180 s = 1,080 calls × ~1,500 tokens ≈ 1.6M tokens ≈ **$0.07 per 3-minute fight**. State is billed once per request ([cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)).
- A ranked 4 Hz fight uses about 1,440 calls over about 6–7 wall-minutes, roughly 220 RPM. So about 5 league fights can compute at once on one 1,200-RPM key ([models](https://docs.typesafe.ai/models)).
- No design here trains on Jev output, as MCA §2.3(b) requires ([MCA](https://typesafe.ai/legal/mca)).

## 7. Build-system scope for v1

- **About 40 parts, each with a spec card:** Kt, R, L, i_max, J_r, N, efficiency, backlash, ± tolerance, and provenance ([vendor], [consistency-checked] or [bench-measured]).
  - Actuators: AK80-9, RobStride 02/03, Dynamixel XM430/XH540.
  - Drive gearmotors, drivers, and LiPo packs with internal resistance.
  - Plates in 6061, 7075, AR500, Ti-6Al-4V, UHMW and polycarbonate, parametric and exported as DXF.
  - Grade 5 and grade 8 fasteners with shear ratings.
  - Wheels, a momentum wheel, a shifter.
- **Virtual dyno conformance.** Every actuator card must reproduce its datasheet's stall torque, no-load speed and the Kt = Ke check inside tolerance, or it does not ship. This is a CI test, and it guards against the kind of gear-ratio mistake that doubled a calf's speed in Isaac Lab (digest).
- **Budgets:** weight, bus power, and channels; the digest's compiler (merge rigid parts, weld-based breakables capped at about 8).
- **Export contents:**
  - BOM with vendor, SKU, quantity and price;
  - DXFs and a fastener schedule;
  - wiring voltages and current limits;
  - the MJCF;
  - a 50-run tolerance Monte Carlo, autopilot vs autopilot with no Jev calls;
  - the SPARC/NHRL linter report.
- **Export limits:** 12 lb class and below only. No pneumatics. Stored-energy parts capped (SPARC and NHRL safety rules, digest).

## 8. The cage and presentation

**The Decagon.** An own-brand silhouette avoids Zuffa's registered 3D octagon mark (digest). It is built to real combat-robot spec:
- 16 ft across, matching NHRL's 30 lb box;
- walls of ½-inch outer and ⅜-inch inner polycarbonate on 1-inch steel-tube frames, over a plywood floor with a painted canvas finish ([NHRL](https://wiki.nhrl.io/wiki/index.php/Cage_Design)) [indep];
- the UFC visual grammar on top: padded posts, a black top rail, two gates.
- Walls are compliant colliders. Scuffs accumulate across a fight card as persistent decals.

**Presentation:**
- a macro "tabletop broadcast" camera with real focal length and depth of field;
- a datasheet-style HUD where every number is a measured quantity (amps, bus volts, winding °C, joules);
- heat tint (digest);
- ghost futures (novel idea 1);
- an end-of-fight energy Sankey diagram with the fudge % badge.

## 9. Honest limits

- Impacts, fracture, and spinner bite remain calibrated game models. The ledger quantifies them rather than hiding them.
- Thermal constants are mostly unpublished.
- The WASM performance figures, multi-instance workers, and cross-browser determinism are all unmeasured. Phase 0 gates each of them.

## Novel ideas
- Jev proposes, physics disposes. Jev's calibrated tactic distribution becomes the sampling prior of a browser MPC: rollouts are split across tactics in proportion to p^(1/T). Its score answers become the planner's cost weights, and its confidence sets the sampling noise. The real physics engine verifies every candidate and executes the lowest-cost one. Jev never does arithmetic and the controller never needs training. The top 3 rollout outcomes are fed back to Jev in words on the next call.
- Move forging at build time. iCEM trajectory optimization runs in Web Workers on the player's exact MJCF and discovers each weapon chain's strike library from its real motor torque-speed and thermal limits, in about 1 minute (estimate). Each forged move ships with a measured mini-datasheet: tip speed, joules on target, winding temperature rise per strike, recovery time. Changing a gear ratio or motor re-forges the moveset, so moves are properties of the hardware, not animations.
- Probability-priced bracing. Jev's noul P(incoming hit within 0.5 s) sets the joint stiffness held before impact. Bracing costs real I^2R heat in the dcmotor thermal state and, per Wensing's impact-mitigation result, sends more impact torque into high-ratio gear teeth. An overconfident mind cooks its motors, and an underconfident one gets its gears stripped. Calibration becomes a visible physical resource.
- The energy ledger and a fudge % badge. Every fight closes an energy balance: battery energy out = change in kinetic and potential energy + copper heat + joint friction and damping + contact dissipation + damage work. It publishes one number: the share of energy injected or removed by non-physical game models such as analytic spinner bite and damage heuristics. The judges' Damage criterion reads the ledger, so it is objective.
- Arrhenius season wear. Each motor carries an insulation-life odometer integrated from its winding temperature trace with the 10 degree C rule (life halves per 10 degree C over class rating; IEC 60085 classes). Cooked motors come into the next fight with raised resistance and a failure risk. A salvage and refurbish economy is priced from real BOM costs, so heat management becomes a campaign-level engineering skill.
- The reality loop. Owners of real actuators upload ODrive or CAN telemetry logs, and an in-browser least-squares system ID fits R, Kt, friction and the thermal R_T/C. Part cards then earn [bench-measured] provenance and tighter tolerances. Each season, one top 12 lb sim design is built and fought at an NHRL event against a pre-registered prediction: win probability and most likely failing part. The game publishes its Brier score against reality.

## Phases
- **Phase 0: Truth spikes** (1 week solo with Claude Code): Prove that the physics-truth stack runs in a normal browser, and measure Jev from Philadelphia.. Exit: All of the following hold. Two hand-authored 12 lb bots (about 15-20 bodies and about 10 dcmotor actuators each) in a scripted clinch hold at least 1 kHz, or at least 500 Hz as the fallback, in a worker on a 2021-era laptop. Three planner workers, each with its own single-threaded MuJoCo instance, run concurrently without COOP/COEP headers, and the reduced planner model costs 0.15 ms per step or less. Replay state hashes match on Chrome, Firefox and Safari on x64 and ARM. Contact and efc forces read without leaks. The virtual dyno reproduces the AK80-9 and RS04 datasheet stall torque and no-load speed within tolerance. Jev p50/p95 is measured through a proxy with a 20-question call.
- **Phase 1: Two-bot proof fight** (2-3 weeks): Run a first watchable fight with physics truth and Jev as the mind, and test whether Jev earns its place.. Exit: Two fixed 12 lb brawlers fight in the Decagon with L0-L3 control, a simple MPC and a Jev call card in chess-clock mode. Fights are deterministic decision-log replays, and energy-ledger v0 runs. A 50-fight bake-off pits Jev-weighted MPC against fixed-weight MPC autopilot and against a random tactic picker. Blind watchability votes from at least 10 people are collected. Continue only if Jev wins on win rate or on watchability.
- **Phase 2: Builder, dyno, forge, BOM** (4 weeks): Players build their own robots from real parts, and those robots get real movesets and a real export.. Exit: A part-graph-to-MJCF compiler with about 40 spec-card parts is live. Virtual dyno CI passes for every actuator. Shakedown, rules linter and stats card work. Move forging produces a usable 3-5 move set in under 2 minutes on a laptop. Jev labels roles for ambiguous chains. BOM, DXF and MJCF export works for the 12 lb class, with the tolerance Monte Carlo and a disclaimer. Chris personally builds and uses 5 or more designs over two weeks (poc-first).
- **Phase 3: The physics-verified mind and the show** (3-4 weeks): Complete the novel control and presentation layer.. Exit: Jev-proposes/physics-disposes sampling allocation, probability-priced bracing, and the weld-based breakables and panel damage model are live. The energy ledger publishes a fudge % per fight. Ghost-futures replays and shareable fight links re-verify by hash in the viewer's browser. The schema-locked proxy, OpenRouter PKCE BYOK and offline autopilot all work. Five X clips have been posted.
- **Phase 4: Walkers, wear, league** (4-6 weeks): Add depth and a recurring reason to return.. Exit: The True Walker class (+100% weight) works with generated IK gaits. Momentum-wheel self-righter and shifter parts ship. Arrhenius wear odometers and the refurbish economy work. A weekly league card runs with seat-your-own-mind (house Jev, BYOK Jev, offline autopilot). Community bench-log upload and the system-ID fitter are live, with at least one [bench-measured] part.
- **Phase 5: Reality check and Steam** (6-8 weeks elapsed; about $1-2k in hardware; the software itself is small): Close the sim-to-real loop once, and package for desktop.. Exit: One top 12 lb design is built from its exported BOM and fought at an NHRL event against a pre-registered prediction, with the Brier score published. The Electron build passes the replay-hash test against the web build. The humanoid Open class (SIMBICON plus reaction wheel) is decided go or no-go.

## Risks
- MuJoCo WASM is too slow for articulated contact at 1 kHz plus 2-3 planner instances on consumer laptops. All performance numbers here are estimates. → Phase 0 gate. Fall back to 2 ms steps; collision geometry limited to primitives and convex hulls; contype/conaffinity filtering; a coarser planner dt (10 ms) with fewer samples. Ranked fights use chess-clock mode, which has no real-time requirement. Last resort is Rapier with scripted moves only.
- Cross-browser or cross-architecture nondeterminism breaks replays and hash verification. → Test hashes on Chrome, Firefox and Safari, on x64 and ARM, in week 1. Pin the wasm build per season. If exact determinism fails, store keyframes plus recorded trajectories (larger files) and verify on a small CPU-only Node verifier. That verifier is not GPU training and does not violate the constraints.
- Classical control plus sampling MPC produces stiff, robotic, shove-heavy fights that nobody wants to watch. → Forged moves give each build distinctive strikes. Jev temperature and doctrine add style. Real 12 lb combat is already shove-heavy and still draws about 1B views a year (NHRL, digest). Blind watchability tests gate Phase 1.
- Jev adds nothing over a fixed-weight MPC autopilot. Rule-based controllers beat Jev in jev_fsd, and the vendor conceded the point for Doom. → The Phase 1 bake-off decides this. If Jev loses on both win rate and watchability, demote it to judge, role labeler and doctrine interpreter, and let the autopilot fight. The physics-truth product still stands on its own.
- The physics-truth audience is niche. Deep robot-combat builders on Steam have stayed small (Robot Rumble 2 has 297 reviews). → Lead with shareable artifacts: fight clips, stats cards and the 'I exported a real BOM' moment. Offer archetype kits and auto-fix for casual players. Use the real NHRL reality check as a marketing event.
- BOM-export liability: a player builds something dangerous from a sim design. → Export only the 12 lb class and below. No pneumatics. Cap stored-energy parts, including momentum wheels. Run the SPARC/NHRL linter. Label every export 'sim-validated within spec tolerance, not a win guarantee.' Get a one-hour legal review before public export.
- Jev access: the 1,200 RPM quota, no SLA, unverified CORS, and no clear permission to show probabilities publicly. → Schema-locked proxy with per-session budgets. OpenRouter PKCE BYOK. The offline autopilot keeps every feature working. Ask TypeSafe in writing about display rights and a higher league quota.
- Damage, impact and thermal constants are guesses, so the claim of 'physical truth' overreaches. → The fudge % ledger publishes how much comes from game models. Provenance tags sit on every constant. Community system ID and the pre-registered reality check calibrate and publicly score the sim.

## Kill criteria
Drop the idea, or its physical-truth angle, on any of the following:
(1) Phase 0 fails. Two 12 lb articulated bots cannot hold 500 Hz in a browser worker on a 2021 laptop even with reduced geometry, or planner rollouts cost more than 0.3 ms per step. Real actuators plus in-browser planning is then not viable on consumer hardware.
(2) The virtual dyno cannot reproduce published datasheet curves within tolerance for at least 3 of 4 catalog actuators. "Real parts" would then be a lie.
(3) The Phase 1 bake-off shows Jev-weighted MPC losing to fixed-weight autopilot on win rate AND on blind watchability over 50 fights. Jev as "the mind" is then decoration, so kill that premise or pivot to an autopilot-only engineering sandbox.
(4) Blind viewers rate the fights as not fun (under 40% prefer them to a scripted-animation baseline). The product fails no matter how true the physics is.
(5) Poc-first: during two weeks of use Chris does not open the builder more than twice a week, or no tester tries a BOM export.
(6) The reality check produces a Brier score no better than a coin flip AND the part that actually failed differs from the predicted one. The honesty claim must then be retracted, and the project continues only as a game, not as the engineer's league.
