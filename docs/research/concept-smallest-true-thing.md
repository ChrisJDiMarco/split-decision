# CAGE ZERO: two wheeled brawlers, one visible mind each

CAGE ZERO is a two-week test of one question: will people watch a physically simulated robot fight because they can see each robot's mind decide? Two fixed robots fight in a ten-sided cage of Chris's own design. Both are wheeled, metal-bodied and about 40 kg, with real jointed arms. They run on MuJoCo 3.14 compiled to WebAssembly, so they work in any browser, and their dcmotor actuators use datasheet numbers and heat up like real motors. All motion comes from code that needs no training: IK/PD motor programs, a reflex arbiter and weapon smart zones. Jev makes every decision. In lockstep, each robot asks about 10 typed questions per decision tick. The full probabilities, not just the top answer, set the tactic, target, strike parameters, commit thresholds and a pre-armed counter. Each fight is a small deterministic file that anyone can replay, scrub, slow down and orbit. A mind panel shows each robot's live probability bars. Breaking a robot's sensor mast visibly blinds its mind. The builder, legs, spinners, league and Steam all wait until a kill-or-continue gate on day 14.

# CAGE ZERO: the smallest true robot fight

## 1. What the PoC tests
The full idea stacks three hard problems: free-form robot building, fighting control for any body without training, and Jev as the mind. The PoC tests only the part nobody has shipped yet: **does a physically simulated fight become worth watching when you can see each robot's mind decide?**

- I found no physics-based robot fight driven by Jev. The awesome-jev game list has no project that combines Jev with physics-based robot fighting ([list](https://github.com/yibie/awesome-jev/blob/main/categories/game-simulation.md)) [indep, checked 2026-09-29].
- The closest project, jevbox, animates its boxers with procedural IK, not physics ([repo](https://github.com/duc-minh-droid/jevbox)) [indep].
- CAGE ZERO's difference: the body can fail. It can tip, overheat, lose a fist, or go blind.

Success means three things are true:
1. Jev-driven fights look intentional and varied next to a tuned behavior tree (BT).
2. People talk about the mind panel, not only the render.
3. MuJoCo metal reads as weight and consequence, not RC toys.

## 2. Core loop (v0)
1. Pick a matchup.
2. Edit your robot's fight plan (150 words max) and set its temperament.
3. Compute the fight. It runs in lockstep and streams in at about real time.
4. Watch it with the mind panel.
5. Scrub, slow down and orbit the camera.
6. Share the fight-file link.
7. Change the plan and rematch.

Robot building is left out until Phase 2. In v0 the plan is the only thing a player shapes, which is also the cleanest test of Jev.

## 3. Engine and platform
- **Physics.** The official `@mujoco/mujoco` 3.14.0 single-threaded build, running in a Web Worker. It "does not require special security headers" and runs in modern browsers ([README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)) [vendor]. Settings come from the digest: 2 ms step, `implicitfast` integrator, Newton solver, elliptic cones. Move to a 1 ms step only if Phase 0 shows at least 4x speed headroom.
- **Rendering.** three.js WebGPURenderer, which falls back to WebGL2 automatically (digest). It draws between the last two physics snapshots.
- **App.** A static TypeScript site (the Mini Moto stack) plus one serverless function. Batch tournaments run the same worker headless: in Node if the package loads there, otherwise in headless Chrome. Node support is unverified.
- **Binding gaps to check on day 1.** The README calls `mj_step` and `mj_loadXML` "well tested". It does not list `mj_getState`, `mj_copyData` or `mjd_transitionFD`. If they are missing, keyframes and rollouts can instead copy the live typed-array views (qpos, qvel, act, ctrl, time, qacc_warmstart) into a second `MjData` [beyond digest, est].
- **Steam, later.** Electron wraps the same pinned .wasm file (digest).

## 4. Robot scope for v0
Two fixed robots. Both are wheeled and stand up on their own, have real jointed upper bodies, and weigh about 40 kg at about 0.9 m tall.

- **RIVET, the wheeled boxer.** Skid-steer base, two 3-DOF arms (shoulder pitch, shoulder yaw, elbow), steel fists and a sensor mast. 8 control channels, about 13 bodies.
- **GNASH, the hammer-lifter.** Wedge base, a 1-DOF electric lifter, a 2-DOF overhead hammer and a sensor mast. 5 channels, about 10 bodies.

**Motors.** Arm and weapon joints use MuJoCo's `dcmotor` actuator with its thermal model, filled in from real datasheets (digest) [vendor]:
- RobStride 04 class at the shoulders and lifter: 40 / 120 N·m, 9:1.
- AK80-9 class at the elbows: 9 / 22 N·m.

Motor heat becomes stamina, so there is no invented stamina stat.

**Breakable parts.** Each robot can lose its fist or hammer head, one armor panel and its sensor mast. Each is a free body held on by a weld, and the weld is switched off with `eq_active` when the force on it passes the fastener rating (digest).

**Knockdown.** A flipped robot gets a 10-count to right itself (arms push off, or the lifter levers it over) or it loses.

**Why these bodies.**
- They never have to balance, so all motion works without training.
- Weapon tips stay under about 15 m/s, which is 3 cm of travel per 2 ms step. With armor collision shapes at least 4 cm thick, a weapon cannot skip through armor between steps. That matters because MuJoCo has no rigid-body continuous collision detection (digest).
- About 23 bodies in total is well under the digest's benchmark of two 30-body robots.

A mirror match (RIVET vs RIVET) is used for fair A/B tests. RIVET vs GNASH is the card for clips.

**Cut from v0, and why**
| Cut | Why | Returns in |
|---|---|---|
| Spinners | No rigid-body CCD; the analytic "bite" model is its own project | Phase 3 |
| Legs and bipeds | Balance and getting up are the hardest problems to solve without training | Phase 3-4 |
| Player builder | Not needed to test watchability; Spore shipped its creator separately (digest) | Phase 2 |
| Human piloting | Jev is the controls | Never |
| Netcode and accounts | A fight is a file | Never / Phase 4 |
| Battery sag, fatigue, dents | Fidelity nobody will notice in a 60 s test | Phase 2 |
| BOM export | Liability, and off-question | Maybe never |
| Hazards, gate bursts | Spectacle before signal | Phase 3 |
| Steam | REK Sim is already free there (digest) | Phase 4 |

## 5. Control stack (no training anywhere)
| Layer | Rate | What it does |
|---|---|---|
| L0 physics | 500 Hz | `dcmotor`'s built-in controller: position targets on arm and weapon joints, velocity targets on wheels |
| L1 motor programs | 50 Hz, TypeScript in the worker | Drive: pure pursuit to a standoff point, orbit, charge, retreat, pin to the fence. Arms: analytic 2-link IK strikes (jab, hook, overhead) with minimum-jerk timing, guard pose, lifter and hammer fire, self-right. Every parameter comes from Jev. |
| L2 reflex / arbiter | 50 Hz | Weapon smart zones generated from geometry (the Robot Arena 2 idea, digest), legality masks, commit windows, pre-armed counters, flip detection, fence escape, fallback when the sensor is lost |
| L3 Jev | Lockstep, 1.5-4 Hz, plus interrupts | Every decision |

This matches every working Jev game: code owns the math and reflexes, and Jev owns the judgment (jevbox, jev_fsd; digest).

**The GPU route is dropped.** The digest's engine and controls streams recommend skill policies trained on MuJoCo Warp/mjlab, estimated at 300-1,000 GPU-hours for v1. CAGE ZERO does not use them. Section 10 gives the training-free replacement for each later body type.

## 6. Exactly how Jev is used
**Lockstep.** The sim pauses at each decision tick, and both robots send their requests from the same frozen state. Each answer takes effect after an identical 150 ms of simulated reaction time (the digest's chess-clock mode). Network jitter therefore cannot change an outcome. A fight computes at about real time: roughly 200 ms of Jev round trip for every 250 ms of simulated fight [est].

**Cadence.**
- 4 Hz when engaged, meaning within one body length of a weapon zone.
- 1.5 Hz when the robots are apart.
- No call at all when the answer is obvious.
- Immediate interrupt ticks on: a hit above a threshold, a flip, the opponent entering a weapon zone, fence contact, or sensor loss.

**State.** At most about 700 tokens, and all of it categorical. Code turns geometry into words: distance bands, clock bearings, closing-speed bands, the opponent's phase, heat and damage. This is necessary because Jev does no arithmetic, gets distracted by irrelevant fields, and does not treat data as hostile (digest). Only your own corner's text goes into the state. The opponent appears as an ID, never as a name or bio.

**Ten questions per robot per call.** The state is billed once per request, not once per question (digest).
| ID | Type | What it drives |
|---|---|---|
| tactic | choice, 10 options | Motor-program family: close_in, circle_L/R, hold_range, feint, commit_strike, pin_fence, retreat_reset, guard, bait |
| target | choice, 4-5 | Aim point: arm, weapon, wheel side, sensor mast, underside |
| strike | choice, the build's strikes + none | Which IK strike or weapon |
| height | score, 3 levels | Strike height |
| approach | score, 5 levels | Approach angle, from head-on to rear |
| aggression | score, 5 levels | Speed cap and commit-window length |
| commit | noul | The reflex layer may fire on smart-zone entry only if p > 0.5 |
| opp_commit | noul | Above 0.6, arm the counter |
| counter | choice, 4 | The pre-armed counter: sidestep left, sidestep right, brace, strike first |
| winning | score, 5 levels | HUD momentum line and director input |

**How the probabilities are used.**
- **Hysteresis.** The robot switches tactic only when a new favorite beats the current one by 0.15.
- **Confidence gate.** At 0.6 or above it commits fully. Between 0.35 and 0.6 it runs a probing version. Below 0.35 it falls back to guard-and-circle (digest pattern).
- **Temperament.** A slider samples from p^(1/T). The random generator is seeded on (fight, robot, tick), so replays stay exact.
- **Scores.** Score answers are probability-weighted means, so they map directly onto continuous parameters.

**Cost and quota.**
- A 3-minute fight takes about 1,100 calls at about 1,000 input tokens each: roughly 1.1M tokens, or about $0.05 at $0.042 per million. Output is free (digest) [vendor].
- The real limit is 1,200 requests/minute per account. That allows about three fights computing at once per key [est].

**The API key, the proxy and the offline fallback.** TypeSafe's API page documents Bearer auth and backoff on 429/529 errors. It says nothing about CORS, scoped keys or spend caps ([docs](https://docs.typesafe.ai/api)) [vendor, checked 2026-09-29]. So the key never goes to the browser:
- **Proxy.** A Cloudflare Worker that:
  - accepts only the fixed question schema;
  - pins the model to `jev-1.13.0`;
  - caps the state at 4 KB;
  - rate-limits each IP with the Workers Rate Limiting binding. Its windows are 10 or 60 s, and it is approximate and per-location, explicitly not "an accurate accounting system" ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)) [vendor];
  - keeps an exact daily spend counter in a Durable Object, since the binding cannot.
- **Bring your own key.** Users' keys pass through the same proxy and are held only in page memory.
- **Offline.** A behavior-tree brain sits behind the same interface, and the HUD shows "JEV OFFLINE". Open clones don't help in the browser: jev-omni.js needs about 7 s per question on an M4 Max (digest).
- **Replays first.** Chris computes fights in batches. The public watches fight files, which need no network. Live runs use bring-your-own-key or a small daily allowance; 1,000 public fights a day would cost about $50 [est].

## 7. Build-system scope
There is no builder for players in v0. The two robots are JSON part graphs, compiled to MJCF by a small TypeScript compiler, because Phase 2 needs that compiler anyway. The compiler merges rigid parts into one body, splits each actuator into a stator and a rotor, and makes breakable parts free bodies held by welds (digest).

Chris's Swift Jev client from Cabinet cannot run in the browser, but its question-schema guards carry over directly.

## 8. The cage and the show
- **The cage.** Ten-sided and of Chris's own design, about 4.5 m across the flats, with a 1.1 m fence (about 5x robot height, inside the digest's scaling range) and padded posts. Each fence panel is an invisible, springy collision plane, and a shader bows the visible mesh on impact. It is not an octagon replica: Zuffa owns the OCTAGON word mark and a 3D registration of the cage design (digest).
- **Mind panel, per robot.** Top-5 tactic bars with confidence, a READ meter (the opponent's chance of committing), a "COUNTER ARMED" flash, a BLIND tag and a momentum line.
- **Director.** A rule-based camera that, in replay, already knows when the hit will land. Slow motion re-simulates at the same timestep (digest).
- **Look and sound.** Brushed-steel `MeshPhysicalMaterial`, heat tint driven by dcmotor temperature, and GPU sparks from contact impulses. Sampled metal hits, plus servo whine pitched to joint speed.
- **Clips.** Deterministic frame-by-frame capture to WebM, then ffmpeg cuts at 16:9 and 9:16.
- **The fight file.** Engine version, seed, build hashes, plans, and a decision log with the top-5 probabilities (about 50-100 KB), plus 1 s keyframes for seeking.

## 9. Novel ideas (beyond the digest)
1. **The distribution is the objective.** Feed Jev's whole tactic distribution to a small sampling planner as weights on its cost terms.
   - At 80% close_in the robot charges.
   - At 45/40 close_in/guard it approaches with its armor angled and its weapon cocked: a physical hedge, not a flicker between modes.
   - The HUD bars are then literally the controller's weights.
   - Untested. Incompatible pairs are masked, and a top choice above 0.6 runs on its own.
2. **Perception is a part (in v0).** The sensor mast can be knocked off, and the state serializer is the robot's senses.
   - Intact: 6 distance bands, 12 clock bearings, and the opponent's phase with a percentage.
   - Cracked: 3 bands, 4 quadrants, and the opponent's phase only inside a 120° front cone.
   - Broken: only contact or no contact, plus "last seen at 5 o'clock, 0.8 s ago".
   - A blinding hit shows up as a flattening distribution and a gated switch to guard, so viewers see cause and effect inside the mind. It also makes attacking the flank worth something.
3. **Thinking costs mass.** A brain-board part comes in tiers:
   - 6, 10 or 16 questions per call;
   - 200, 100 or 150 ms of reaction delay (fastest on the top tier);
   - 0, 3 or 6 imagined futures per decision;
   - 0.3, 0.8 or 1.5 kg, counted against the weight class.

   How fast and broad the mind is becomes a build trade against armor, not network luck.
4. **Fork the fight.** Click any decision tick in a replay and pick, say, the 38% option.
   - The viewer restores the nearest keyframe, replays the log up to that tick, swaps in the new choice, and continues with Jev or the offline brain.
   - Each branch is saved with a pointer to its parent, so fights become trees.
   - It works as content ("the fight that didn't happen") and as a debugger for fight plans.
5. **Imagined futures on screen.** The candidate strikes Jev judges come from short rollouts: a scratch copy of the physics runs each option 0.4 s ahead, and the outcomes become the option descriptions (digest pattern). The replay draws those rollouts as translucent ghosts, with opacity set to Jev's probability. Viewers see what the robot considered and rejected.
6. **Spend the broadcast delay on physics.** Fights are computed before anyone watches, so controllers may run slower than real time.
   - Predictive sampling or iLQR can run at 0.1-0.3x real time while a fight computes.
   - The file then stores the controls at 50 Hz, about 0.4 MB, so viewers' devices only step the physics.
   - For comparison, Zhang et al. ran MuJoCo iLQR model-predictive control without training on Go1, Go2 and H1 at about 50 Hz, on a 20-core i9 ([arXiv 2503.04613](https://arxiv.org/html/2503.04613v3)) [indep, academic]. One WASM thread will be far slower, hence running slower than real time.
   - This sidesteps the digest's verdict that browser MPC for two robots is "unlikely" rather than disputing it.

## 10. The path after the gate
- **Phase 2, the Garage.** A parametric builder over a catalog of real-spec parts, with a shakedown test and a stats card. Jev labels each channel's role once per build. Adds ideas 3-5, battery sag, a Jev judge, a Jev referee stoppage call (noul), and Claude as corner coach between rounds.
- **Phase 3, more bodies, still no training.** This replaces the digest's GPU reinforcement learning:
  - Spinners, with an analytic bite model and a tip-speed cap.
  - A two-wheel balancer using LQR gains computed at compile time from a finite-difference linearization (digest: plausible but unproven).
  - Hexapods and quadrupeds with tripod or crawl gaits derived from the kinematic graph, plus IK.
  - Reaction-wheel stabilizer parts.
  - The planner from idea 1.
- **Phase 4.** A weekly league, the X content pipeline, and bipeds. Bipeds use SIMBICON-style balance feedback ([Yin, Loken, van de Panne 2007](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)) [indep, academic], a reaction wheel, and idea 6. Pretrained third-party ONNX policies are an optional add-on only. An Electron build goes to Steam last.

## 11. What kills it
The day-14 gate kills the project, or shrinks Jev to HUD, judge and camera director, if any of these hold:
- Jev loses to a random tactic picker too often.
- Blind viewers don't prefer Jev-driven fights.
- Clip replies mention only the render.
- The browser cannot hold real time at a 2 ms step on a 2020-era laptop.
- Chris stops opening fights for fun.

Numbers are in kill_criteria.

## Novel ideas
- The distribution is the objective. Jev's full tactic distribution becomes the weights on a sampling planner's cost terms, instead of taking the top choice and executing it. When Jev splits 45/40 between close_in and guard, the robot approaches with its armor angled and its weapon cocked: a physical hedge rather than a flicker between modes. The HUD probability bars are then literally the controller's weights. Incompatible pairs are masked, and a top choice above 0.6 runs on its own. This is untested and lands in Phase 3.
- Perception is a part, in v0. The sensor mast is a breakable body, and the state serializer is the robot's senses. Intact, it reports 6 distance bands, 12 clock bearings and the opponent's phase with a percentage. Cracked, it reports 3 bands, 4 quadrants, and the opponent's phase only inside a 120-degree front cone. Broken, it reports only contact or no contact, plus 'last seen at 5 o'clock, 0.8 s ago'. A blinding hit shows on the mind panel as a flattening distribution and a confidence-gated switch to guard. Viewers see physical cause and mental effect, and attacking the flank becomes worth something.
- Thinking costs mass. A brain-board part comes in tiers. Its question budget is 6, 10 or 16 questions per call. Its simulated reaction delay is 200, 150 or 100 ms. It can imagine 0, 3 or 6 physics futures per decision. It weighs 0.3, 0.8 or 1.5 kg, counted against the weight class. How fast and broad the mind is becomes a legible build trade against armor, not an accident of network latency.
- Fork the fight. Every logged decision tick in a replay is a branch point. The viewer picks Jev's runner-up option, say the 38% one. The client restores the nearest keyframe, replays the log up to the fork, swaps in the new choice, and continues with Jev (through the proxy or the player's own key) or the offline brain. Each child fight file stores a pointer to its parent, so fights become trees. That makes a content format ('the fight that didn't happen') and a debugger for fight plans.
- Imagined futures on screen. The candidate strikes Jev judges come from short 0.4 s rollouts in a scratch copy of the physics. Their poses are recorded, and the replay draws them as translucent ghost robots whose opacity equals Jev's probability for that option. Viewers literally see what the robot considered and rejected just before the hit.
- Spend the broadcast delay on physics. Fights are computed first and watched afterwards, so training-free controllers such as predictive sampling or iLQR may run at 0.1-0.3x real time while the fight computes. The fight file stores their control outputs at 50 Hz, about 0.4 MB, so viewers' devices only step physics. This makes walkers plausible in anyone's browser without training, and it sidesteps the digest's verdict that real-time browser MPC for two robots is unlikely.

## Phases
- **Phase 0: Spike and gates** (2-3 days, solo with Claude Code): Prove that MuJoCo WASM plus Jev can run a fight in a consumer browser before writing any game code. Load hand-written MJCF of RIVET, GNASH and the cage in a Web Worker. Benchmark stepping on Chris's Mac, a 2020-era Intel laptop and a phone. Hash the state after 60 s of scripted motion in Chrome, Firefox and Safari on x64 and ARM. Read contact impulses from efc_force. Test keyframe copy through typed-array views. Stand up the Cloudflare Worker proxy and measure Jev p50/p95 from Philadelphia with a 700-token categorical state and 10 questions.. Exit: All of: (1) at least 2x real time at a 2 ms step with both robots in contact, in the worker on the 2020-era laptop; (2) state hashes identical across browsers and architectures, or a documented fallback (control log plus keyframe resync) chosen; (3) contact and constraint forces readable with no memory growth over 10 minutes; (4) Jev p95 under 500 ms through the proxy, with lockstep mode confirmed to work at any latency.
- **Phase 1: Cage Zero fight loop** (7-9 days, solo with Claude Code): Build fights in which Jev is the only decider. Includes the JSON part-graph to MJCF compiler for the two fixed builds; dcmotor actuators with thermal state; breakable welds (fist or hammer head, armor panel, sensor mast); knockdown and 10-count; IK/PD motor programs; the reflex arbiter with smart zones and pre-armed counters; the Jev adapter (10 questions, lockstep, adaptive cadence, interrupts, hysteresis, confidence gate, seeded temperament); sensor-degraded perception; BT and random brains behind the same interface; the fight file and replay; slow-mo and orbit; the mind panel; a rule-based prescient director; metal materials, sparks and audio; deterministic clip export.. Exit: 60 s and 3x60 s fights run end to end in lockstep for Jev, BT and random brains. A saved fight file replays identically in a second browser. Five 15-second clips exported in 16:9 and 9:16. Proxy live with a per-IP limit and a daily spend cap.
- **Phase 1b: Watch test and decision (day 12-14)** (2-3 days): Answer the PoC question with evidence. Run a 150-fight mirror matrix (RIVET vs RIVET: Jev vs BT vs random, 50 fights per pairing, about $5-8 of Jev). Run a blind test with 10+ viewers on 6 pairs of 60 s clips: Jev-vs-Jev against BT-vs-BT on the same builds, both with a panel, where BT shows normalized utility scores so the panel is not the giveaway. Ask for preference and for 'describe what red was trying to do'. Post 5 clips to X, each linking an orbitable replay.. Exit: Continue only if all hold: Jev beats random in at least 60% of fights; at least 60% of blind viewers prefer the Jev fights; at least 1 in 4 substantive clip replies mention the robot's decisions or the mind panel; and Chris is still opening fights for fun.
- **Phase 2: Garage and clever Jev** (3-4 weeks): Players build their own robots. A parametric builder over about 30 real-spec catalog parts: 3 bases, 4 arm types, hammer, lifter, clamp, armor plates and motor tiers. Includes socket snapping, mirror mode, a live center-of-mass and torque check, a 3-5 s shakedown and a stats card. One Jev call per build labels each channel's role. Adds the rollout infrastructure and ghost futures, fork-the-fight, brain-board tiers, battery bus sag, a Jev judge plus a noul referee stoppage call, Claude as corner coach between rounds, a public site with bring-your-own-key, and shareable fight links.. Exit: 20 outside people build a robot and share a fight. At least 30% of shared fights are forked or rematched. No build that passes the shakedown blows up the sim.
- **Phase 3: More bodies, still zero training** (4-6 weeks): Replace the digest's GPU-trained skills with training-free control per family. Spinners use an analytic bite and stored-energy impulse, with a tip-speed cap. A two-wheel balancer uses LQR gains computed at compile time from finite-difference linearization. Hexapods and quadrupeds get tripod or crawl gaits derived from the kinematic graph, plus IK. Reaction-wheel and gyro stabilizer parts have real mass and power draw. A predictive-sampling drive planner uses Jev's distribution as its cost weights. Adds a Havoc ruleset with hazards.. Exit: Each family passes a qualification test with no training: drive or walk 3 m, turn, self-right from 3 poses, and survive lateral pushes. Cross-family fights stay balanced with an NHRL-style walker weight bonus.
- **Phase 4: League, content engine, desktop** (Ongoing, 2-6 months, gated by audience pull): Weekly autonomous cards where visitors seat their own build and plan (reusing the Out of Distribution mechanic). An X clip pipeline from fight files. Bipeds via SIMBICON-style balance feedback, a reaction wheel and non-real-time predictive sampling or iLQR in compute-then-broadcast mode. Third-party pretrained ONNX policies only as an optional, license-checked add-on. An Electron wrapper for Steam.. Exit: Weekly cards retain repeat viewers for 6 consecutive weeks before any Steam spend. Bipeds ship only if they pass the same qualification test without training.

## Risks
- Jev loses to a tuned behavior tree on both win rate and watchability. Prior art points this way: the rules brain beat Jev in jev_fsd, and TypeSafe itself conceded a non-AI Doom bot plays better. → The A/B matrix and blind test are built first, in Phase 1b. Losing on win rate while winning on watchability is fine. Losing both demotes Jev to HUD, judge and director, or kills the concept.
- Wheeled boxers read as RC toys bumping, not as a fight in a cage. → Articulated IK arm strikes, knockdowns with a 10-count, heat tint, impact audio and broadcast camera language. Measure 'what was red trying to do' accuracy in the blind test. If the fights read as toys, pull the procedural-gait hexapod forward; it still needs no training.
- The MuJoCo WASM bindings are still WIP. Speed is unmeasured, cross-browser determinism is unverified, and keyframe functions may not be bound. → Phase 0 gates. Copy typed-array views for state. Replay from a control log with keyframe resync if hashes differ. Fall back to fewer bodies at 500 Hz. Rapier with scripted motion is the last resort.
- MuJoCo's soft contacts make metal hits look mushy or floaty. → Tune solref/solimp on metal geoms and use thick collision proxies. Add render-only hit-stop, camera shake, sparks and modal audio, none of which touch the simulation.
- The Jev API is fragile as a dependency. The 1,200 RPM per-account quota and limits 'can change without notice'. There is no SLA, aliases move, and the terms ban distillation. → Lockstep mode. Pin jev-1.13.0. A BT fallback behind the same interface. A replay-first public product, with no plan to distill Jev. Ask TypeSafe in writing about showing probabilities publicly and about raised limits for event nights.
- Prompt injection through league text, such as robot names or plans, because Jev does not treat data as hostile. → Only the robot's own corner text goes into its state. Opponents appear as IDs. Claude lints plans offline, and the proxy rejects any request that doesn't match the fixed schema.
- Scope creep, since the idea contains three research projects. → The explicit cut list. Nothing from Phase 2 starts before the day-14 gate, and each later body family needs a training-free qualification pass before shipping.
- IP exposure: Zuffa's octagon trade dress, plus the UFC, BattleBots and Real Steel names. → A ten-sided cage and a name Chris owns, generic robot likenesses, and a one-hour trademark review before public launch.
- Viewers dismiss clips as AI-generated video. → Every clip links to an orbitable, forkable in-browser replay of the exact fight file.

## Kill criteria
At the day-14 gate, kill the concept, or shrink Jev to HUD, judge and director only, if any of these hold:

1. In the 150-fight RIVET-vs-RIVET mirror matrix, Jev beats the random tactic picker in fewer than 60% of fights. That would mean its decisions don't matter physically.
2. In the blind test, 50% or fewer of at least 10 viewers prefer Jev-driven fights over BT-driven ones, and viewers describe the Jev robot's intent no more accurately than the BT robot's.
3. Across 5 posted clips, fewer than 1 in 10 substantive replies mention the robot's decisions or the mind panel. Everything is about the render.
4. MuJoCo WASM cannot hold real time at a 2 ms step for two wheeled robots of about 12 bodies each, in a Web Worker on a 2020-era laptop. That breaks "anyone's browser" before anything harder has been tried.
5. Chris stops opening fights for his own enjoyment during week 2 (the poc-first two-week behavior test).

Separately, the concept pivots to an open clone running server-side, or dies, if either of these happens:
- TypeSafe's terms forbid publicly showing Jev's probabilities in a game or league.
- The API becomes unavailable or its limits drop below about 1 lockstep fight per key at a time.
