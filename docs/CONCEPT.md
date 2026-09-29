# Split Decision

A browser robot fight league. Every robot is built from real parts and simulated in MuJoCo, and Jev makes every fight decision. Nothing is built yet. Tags: [vendor] is a company's or paper authors' own claim, [indep] is third-party evidence, [calc] is my arithmetic on cited numbers, [est] is my unmeasured estimate.

## 1. Verdict

It is possible in anyone's browser, with no trained policies, as long as v1 robots never have to balance. v1 fighters are wheeled or tracked bases carrying real jointed arms, hammers, lifters and clamps. MuJoCo 3.14 ships an official WebAssembly build whose single-threaded version "does not require special security headers" ([README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)) [vendor], and its dcmotor actuator turns datasheet numbers into real torque-speed limits and motor heat ([changelog](https://mujoco.readthedocs.io/en/latest/changelog.html)) [vendor]. Jev never touches a joint. It sets everything a fighter decides (tactic, target, strike, angle, aggression, when to brace, what to do if the opponent lunges) in one parallel call, and code turns the answers into motion.

What is genuinely hard:

- Performance. Nobody has published numbers for two contact-heavy articulated robots plus sampling planners in a WASM worker on an ordinary laptop. Every performance figure here is an estimate until a one-week spike.
- Legs without training. Walkers that stand on their own work with procedural gaits. Bipeds that fight and get up are research; even learned cross-body get-up fails on outlier bodies ([arXiv 2512.12230](https://arxiv.org/html/2512.12230)) [vendor].
- Jev may lose to a tuned behavior tree. In jev_fsd the rules brain holds the clean safety record ([repo](https://github.com/BrendanH18/jev_fsd)) [indep], and TypeSafe says a non-AI Doom bot could play better ([launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)) [vendor]. The idea can lose on win rate and survive, but not if Jev fights are also less watchable.
- Jev is a weeks-old hosted API with no SLA, whose 1,200 requests/minute limit "can change without notice" ([models](https://docs.typesafe.ai/models), [MCA](https://typesafe.ai/legal/mca)) [vendor]. Quota, not money, is the constraint.
- MuJoCo has no rigid-body continuous collision detection, so fast weapons need analytic hit models.

Recommended path: the smallest-true-thing concept (Cage Zero) for two weeks, with a kill gate on day 14; then the league concept's product, fights computed in the browser and watched as deterministic replays; then the physical-truth concept's physics-verified planner, once rollout cost is measured.

## 2. The stack

| Layer | Pick | Runner-up | Switch when |
|---|---|---|---|
| Physics | `@mujoco/mujoco` 3.14.0, single-threaded WASM, one instance per Web Worker, pinned per season. 2 ms step, `discrete` or `implicitfast` integrator, Newton solver, elliptic cones | `@dimforge/rapier3d-deterministic`, scripted moves only | Phase 0 shows two robots can't hold real time at 2 ms on a 2020-era laptop, or contact forces leak |
| Rendering | three.js `WebGPURenderer` pinned at r186 with automatic WebGL 2 fallback | Plain `WebGLRenderer` | The WebGPU path misbehaves on Firefox or Linux; WebGPU is not Baseline ([webstatus](https://api.webstatus.dev/v1/features/webgpu)) [indep] |
| App | Static TypeScript site (the Mini Moto stack) plus one Cloudflare Worker | | |
| Steam | Electron wrapping the same pinned `.wasm` | Native MuJoCo | Only after the league has an audience |

MuJoCo is the only engine that runs in a browser with reduced-coordinate joints and a native motor model: back-EMF torque-speed, current saturation, inductance, temperature-dependent winding resistance, cogging and LuGre friction ([dcmotor.pdf](https://mujoco.readthedocs.io/en/latest/_static/dcmotor.pdf)) [vendor]. It also gives a training-free controller the functions it needs. I checked the binding generator on 2026-09-29: `mj_getState`, `mj_setState`, `mj_copyData`, `mj_jacSite`, `mj_fullM` and `mjd_transitionFD` are bound, and `mj_recompile` is still a TODO ([constants.py](https://github.com/google-deepmind/mujoco/blob/main/wasm/codegen/generators/constants.py)) [indep]. So rollouts, keyframes, IK and build-time LQR work in the browser, but parts can't be added or removed mid-fight; detachables are pre-modeled as free bodies held on by welds.

Rapier has the best TypeScript experience, a deterministic package and easy breakable joints, but from JS its multibody motor methods are commented out ([source](https://github.com/dimforge/rapier/blob/master/bindings/typescript/src.ts/dynamics/multibody_joint.ts)) [indep], leaving impulse joints with PD motors and no motor model. Unity's articulation joints can't break, cap depth at 64 and forbid loops ([manual](https://docs.unity3d.com/6000.4/Documentation/Manual/physics-articulations.html)) [vendor].

MuJoCo promises identical results only within one version on one architecture ([docs](https://mujoco.readthedocs.io/en/stable/computation/index.html#reproducibility)) [vendor]. One pinned WASM binary everywhere should behave as one architecture, but that is inference. Test replay hashes on Chrome, Firefox and Safari, x64 and ARM, in week one. If they differ, fight files carry a control log plus a `mj_getState` keyframe every second, which keeps replays visually correct.

The engine, actuator, builder and controls dossiers all leaned on skills trained on NVIDIA GPUs with MuJoCo Warp, mjlab or Playground (the controls dossier put v1 at 300-1,000 GPU-hours). That route is out, replaced by classical control, procedural skills and planners that use MuJoCo itself as the model. Someone else's pretrained ONNX policy (wbc-demo runs G1 policies in-browser ([repo](https://github.com/wbc-mjlab/wbc-demo)) [indep]) stays optional, for a fixed-body exhibition only.

## 3. The robot nervous system, with zero training

| Layer | Rate | Where | Job | Owner |
|---|---|---|---|---|
| L0 motors | 500 Hz (2 ms) | Physics worker | dcmotor's built-in controller (kp, ki, kd, slew, Imax, Vmax); battery-bus sag written into Vmax every step; custom thermal derating and burnout | MuJoCo plus ~100 lines |
| L1 skills | 50-100 Hz | Physics worker | Two-link IK strikes with minimum-jerk timing, guard poses, pure-pursuit driving (standoff, orbit, charge, pin), lifter and hammer programs, self-righting; later, procedural gaits | Code |
| L2 reflex and arbiter | 50 Hz | Physics worker | Priority: self-right, brace, pre-armed counter, guard, then Jev's intent. Smart zones, legality masks, commit windows, confidence gates | Code, thresholds from Jev |
| L3 planner (phase 3) | 5-10 Hz | 1-3 planner workers | Predictive sampling over 4-8 maneuver parameters, never raw torques, on a reduced model; short rollouts for Jev to judge | Code; Jev sets weights and prior |
| L4 Jev | 1.5-4 Hz plus interrupts | Main thread via proxy | One call per fighter per decision tick | Jev |
| L5 corner | Between rounds | Server | Plan lint, scouting from telemetry | Claude, optional |

Servo gains come from the build (kp = J_eff·ωn², kd = 2ζ·J_eff·ωn, J_eff from `mj_fullM` plus reflected rotor inertia) [est]. The planner is the training-free answer for odd bodies. MuJoCo MPC's predictive sampling works on any body given only a cost function; its authors report 1-20 ms per update on a 72-core Xeon and an M1 Pro, with 23-35 step horizons and cost weights exposed as sliders ([arXiv 2212.00541](https://arxiv.org/html/2212.00541)) [vendor]. Those sliders are what Jev turns. Browser evidence is thin: one "hacky" MPPI cart-pole on MuJoCo WASM ([HN](https://news.ycombinator.com/item?id=41992851)) [indep]. My budget: 24 samples × 60 steps × ~0.1 ms per step on a reduced model is ~144 ms single-threaded, ~50 ms across three workers, enough for 5-10 Hz replanning [est]. If that fails, the planner runs only in computed fights.

Lockstep makes latency irrelevant, and the reaction delay pays for the network. At decision tick t the sim freezes state and sends the request; the answer takes effect at t + D, a fixed simulated reaction time of 150-200 ms for both fighters. Until then the robot runs its previous intent, so physics keeps stepping while the request is in flight and waits only if the answer is later than t + D. With D near Jev's typical round trip and a 1-2 s display buffer, a fight streams at about real time, with the same outcome whatever the latency.

Browser budget [est, gated in Phase 0]:

| Thread | Work | Budget |
|---|---|---|
| Main | three.js from interpolated snapshots, UI, Jev fetches | Under 8 ms per frame |
| Physics worker | MuJoCo plus L0-L2 | 500 steps/s at ~0.1-0.4 ms: 5-20% of a core |
| Planner workers (0-3, by `hardwareConcurrency`) | Rollouts on their own MuJoCo instance | 50-150 ms per plan |

The single-threaded build needs no COOP/COEP headers, so the site runs on any static host. Skip the `/mt` build: it needs cross-origin isolation, and one user saw memory go from ~60 MB to 480 MB on a 32-thread CPU ([#3144](https://github.com/google-deepmind/mujoco/issues/3144)) [indep]. Snapshots move by postMessage: mjswan measured a 0.30 ms worker round trip and 0.03 ms for a 30-body snapshot, and a worker that never yields delayed incoming messages by a median 1,008 ms ([mjswan #117](https://github.com/ttktjmt/mjswan/issues/117)) [indep]. Planners must work in chunks. Phones watch replays; weak devices play a recorded pose stream instead of stepping physics.

Bodies that fight well in v1: wheeled or tracked bases with up to two arms of three joints or fewer plus one weapon (hammer, lifter, clamp, wedge). They never balance, so all of the above works on day one. Statically stable hexapods and quadrupeds come next on gait graphs and IK, as in Coros et al., whose quadrupeds used gait graphs, Jacobian-transpose virtual forces and parameter optimization, no learning ([UBC](https://www.cs.ubc.ca/~van/papers/2011-TOG-quadruped/index.html)) [vendor]. Two-wheel balancers get LQR gains at build time from `mjd_transitionFD`. Bipeds are a later exhibition on SIMBICON ([PDF](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf)) and generalized biped walking control, which "requires no character-specific or motion-specific tuning" ([UBC](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/index.html)) [vendor].

Stabilizers are parts, never invisible forces: a reaction wheel has mass, a motor that saturates and a draw on the bus, as on the Cubli ([ETH](https://idsc.ethz.ch/research-dandrea/research-projects/archive/cubli.html)) [indep]. A wheel big enough to self-right a 12 lb bot stores ~950 J, spinner energy (the physical-truth concept's [calc]), so rules classify parts by stored joules.

## 4. Jev as the fight mind

The rule from the working Jev games (jevbox, jev_fsd): code owns math, geometry, timing and reflexes, and Jev owns judgment. Jev "cannot reliably judge whether two values are near each other", counts poorly, is distracted by irrelevant state and doesn't treat data as hostile ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)) [vendor]. Code turns geometry into words (distance bands, clock bearings, the opponent's phase), and only a fighter's own corner writes into its state.

Clever uses, ranked by value per unit of work:

| Rank | Use | How | From |
|---|---|---|---|
| 1 | Pre-armed contingencies | Ask "if he lunges now, what do I do?" in the same call; the arbiter fires the answer the instant a geometric trigger trips, with no round trip. Extra questions are nearly free (Tokyo latency was flat from 1 to 40 questions ([qualiteg](https://github.com/qualiteg/jev-typesafe-demo)) [indep]) | Jev dossier |
| 2 | The parameter packet | One call sets tactic, target, strike and several continuous parameters. A score answer is a probability-weighted mean over 2-10 levels, so it maps onto approach angle, commit window or speed cap | All three |
| 3 | noul reflex triggers | P(opponent commits within 0.5 s) arms the counter above a threshold; the threshold is personality (counter-puncher 0.4, brawler 0.7) | League, Cage Zero |
| 4 | Confidence-gated commitment | Above 0.6 commit, 0.35-0.6 probe, below that guard and circle; switch only when a new favorite leads by 0.15; temperament samples p^(1/T) from a seeded PRNG | Cage Zero, [jevbox](https://github.com/duc-minh-droid/jevbox) |
| 5 | Judging look-ahead | Code rolls 4-6 candidate maneuvers 0.4-0.8 s ahead in a scratch `MjData`, describes outcomes in words ("low sweep: ~40 J on front-left wheel") and Jev picks. The broadcast draws them as ghosts with opacity set by probability | [jev-robotics-demo](https://github.com/FazalAAli/jev-robotics-demo) pattern; League, Cage Zero |
| 6 | Jev proposes, physics disposes | The tactic distribution is the planner's sampling prior (samples split by p^(1/T)); six score answers set cost weights (reach, stability, heat, battery, cage, guard) as w = w0·2^(E[level]−2); low confidence widens sampling noise; physics verifies every candidate | Physical truth |
| 7 | Probability-priced bracing | P(hit within 0.5 s) sets pre-impact stiffness. Bracing costs I²R heat, and stiff high-ratio joints strip gears (impact mitigation 90% for 5.8:1 vs 52% for 160:1 ([Wensing](http://www.mit.edu/~pwensing/Papers/Wensing_et_al-2017-TRO.pdf)) [vendor]) | Physical truth |
| 8 | Build-time limb roles | One call per build labels each channel (weapon, shield, drive, leg, grapple, stabilizer) for the player to confirm | All three |
| 9 | Senses and brain as parts | A breakable sensor mast degrades the state serializer; a brain part trades questions per call, reaction delay D and imagined futures against mass | League, Cage Zero |
| 10 | Judges | Code computes facts per 10 s window; three differently weighted Jev rubrics score aggression and control, so judges can split | Jev dossier |
| 11 | Toribash night | Physics pauses; Jev sets 20 joints to hold, relax, extend or contract, plus 2 grips ([ToriLLE](https://github.com/Miffyli/ToriLLE/blob/master/torille/constants.py)) [indep]. Probably clumsy, cheap to try, the most literal "Jev is the controls" | Builder dossier |

Camera direction stays in code, because in a replay the director already knows when the hit lands.

One tick, illustrated (I did not call the API): RIVET, a wheeled boxer, against GNASH, a wedge with a lifter and overhead hammer.

```json
{"model":"jev-1.13.0",
 "state":{
  "me":"RIVET, wheeled boxer. Left arm 100%. Right fist cracked. Shoulders warm. Battery 58%. Upright.",
  "opponent":"GNASH, wedge. Hammer raised, about 70% through wind-up. Lifter down. Left armor panel gone.",
  "space":"GNASH at 1 o'clock, one body length, closing slowly. Fence 1 m behind me.",
  "senses":"Mast intact.",
  "clock":"Round 2 of 3, 0:41 left. Lost round 1 on 2 of 3 cards.",
  "plan":"Stay off his hammer line. When the hammer drops, sidestep and hit the side with no armor."},
 "questions":{
  "tactic":{"type":"choice","instructions":"Tactic for RIVET for the next second?",
    "criteria":{"close_in":null,"circle_left":null,"circle_right":null,"hold_range":null,"feint":null,
      "commit_strike":null,"guard":null,"retreat_reset":null,"bait":"show an opening, stay ready to move"}},
  "target":{"type":"choice","instructions":"Best target on GNASH?",
    "criteria":{"unarmored_left_side":null,"hammer_arm":null,"lifter_lip":null,"sensor_mast":null}},
  "approach":{"type":"score","instructions":"Approach angle relative to GNASH's hammer line",
    "criteria":["head-on","slightly off","45 degrees","wide","from behind"]},
  "aggression":{"type":"score","instructions":"How hard should RIVET press for two seconds?",
    "criteria":["fully defensive","cautious","balanced","pressing","all-out"]},
  "opp_commit":{"type":"noul","instructions":"Will GNASH drop the hammer within half a second?"},
  "counter":{"type":"choice","instructions":"If the hammer drops now, what should RIVET do?",
    "criteria":{"sidestep_left":null,"sidestep_right":null,"brace_guard":null,"strike_first":null}},
  "brace":{"type":"noul","instructions":"Will a hard hit land on RIVET within half a second?"},
  "winning":{"type":"score","instructions":"Who is winning this round?",
    "criteria":["GNASH clearly","GNASH slightly","even","RIVET slightly","RIVET clearly"]}}}
```

Made-up answers: `tactic` bait 0.44, circle_right 0.27, hold_range 0.14; `target` unarmored_left_side 0.62; `approach` 2.6; `aggression` 1.8; `opp_commit` 0.71; `counter` sidestep_right 0.66; `brace` 0.38. Bait leads at only 0.44, so RIVET runs the probing version: it circles right about 60 degrees off the hammer line with a 45% speed cap and a short commit window. `opp_commit` clears the 0.6 threshold, so sidestep_right is armed; when the hammer's angular velocity crosses its trigger, the arbiter sidesteps with no network call. `brace` at 0.38 sets moderate stiffness. The mind panel shows these exact bars. Jev's calibration is measured on benchmark labels, and "best tactic" has no ground truth, so the game logs each tactic's probability against whether it landed and shows both.

Cadence is 4 Hz when either robot is near a weapon zone, 1.5 Hz apart, and no call when the answer is obvious. Interrupt ticks fire on a hard hit, a flip, the opponent entering a weapon zone, fence contact, sensor loss and the last 10 s. TypeSafe says most calls take around 100 ms ([launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)) [vendor]; jev_fsd measured 130 ms median and 199 ms p90 on one drive [indep]; Tokyo medians were 149-211 ms [indep]. Philadelphia is unmeasured, so D starts at 200 ms.

Cost uses the [vendor] price of $0.042 per million input tokens, output free ([models](https://docs.typesafe.ai/models)), with state billed once per request, not per question ([cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)) [vendor]. All figures [calc]:

| Item | Calls | Input tokens | Cost |
|---|---|---|---|
| One 3×60 s fight, 2 fighters, ~3 Hz average | ~1,080 | ~1.4M | ~$0.06 (judges add under $0.01) |
| Phase 1b matrix (100 fights with one Jev fighter) | ~54k | ~70M | ~$3 |
| Public sandbox, 1,000 fights a day | ~1.1M | ~1.4B | ~$60 a day |

Quota is the ceiling. A real-time lockstep fight uses ~360 requests a minute, so one key runs about three live fights against 1,200 RPM, and 1,000 sandbox fights a day would average 750 RPM. Computed fights queue instead of failing. The docs don't say whether the limit is per account or per key. Packing both fighters into one request halves RPM but exposes each plan to the other fighter's questions, so ranked fights keep them separate.

Jev is the right tool for turning a plain-English plan into behavior, for any build (parts are described in words), for free contingencies, and for a calibrated distribution that is both a sampling policy and a spectacle. It is the wrong tool under 100 ms, for motor control, geometry, arithmetic, offline play, high concurrency and exact repeatability. Its answers shift with small input changes ([cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md)) [vendor], so replays re-simulate from logged decisions and never re-query.

TypeSafe documents Bearer auth and says nothing about CORS or client-side keys ([API](https://docs.typesafe.ai/api)) [vendor], so the browser never holds the house key.

- The proxy is a game endpoint, not a pass-through. A Cloudflare Worker accepts `(fightId, tick, fighter, typed state)`, builds the request from fixed templates, pins `jev-1.13.0`, caps state at 4 KB and rate-limits per user. Cloudflare's rate-limit binding is "intentionally designed to not be used as an accurate accounting system" ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)) [vendor], so a Durable Object keeps the exact daily spend. Fixed templates also stay clear of the MCA §2.3(a) bar on offering the Services as a standalone service. For ranked fights it signs each answer (HMAC over fight, tick, fighter, state hash and answers), so any browser can compute a bout and any viewer can verify it.
- Bring your own key through OpenRouter's PKCE OAuth, a user-owned key with no backend ([docs](https://openrouter.ai/docs/guides/overview/auth/oauth)) [vendor]; OpenRouter lists `typesafe/jev-1.13` ([OpenRouter](https://openrouter.ai/typesafe)). Browser CORS on its systemone route is unverified; if blocked, the key passes through the proxy in memory, never stored. BYOK fights are unranked.
- Offline, a House Mind answers the same schema with softmaxed utility scores, so the HUD and replays work unchanged under a "JEV OFFLINE" badge. Open Jev-style models don't help in the browser (Jev-Omni needs a 13.3 GB download and ~6.7 s per question, per the fact-check). decider-4b speaks the same wire format and could run server-side at lower accuracy, 0.649 vs 0.730 on JevBench hard ([repo](https://github.com/Mapika/decider)) [vendor].
- Nothing trains on Jev output; MCA §2.3(b) forbids distillation.

## 5. Robots and parts

| Class | When | Control | Notes |
|---|---|---|---|
| Middleweight brawler, wheeled or tracked, ~40 kg, ~0.9 m tall | v1 | L0-L2, planner later | Up to 2 arms of ≤3 DOF, one weapon; caps of 24 channels, 30 bodies, 8 breakable seams |
| Spinners | v1.5 | Analytic bite | Tip speed capped; hits resolved from stored energy and bite = (v·60)/(rpm·teeth) ([Ask Aaron](https://runamok.tech/AskAaron/spinner_FAQ.html)) |
| Hexapod and quadruped walkers | v2 | Gait graphs plus IK | +100% weight bonus, as NHRL gives True Walkers ([NHRL 2026](https://wiki.nhrl.io/wiki/index.php?title=NHRL_Open_Rules_-_2026)) [indep] |
| Two-wheel balancer | v2 | Build-time LQR | Auto-LQR unproven |
| Gyro biped | Exhibition | SIMBICON-style balance plus reaction wheel | Ships only if it stands, survives pushes and beats a 10-count untrained |

I side with Cage Zero's 40 kg scale over the physical-truth concept's 12 lb class. A 5 kg bot in a 16 ft box reads as insect combat; a 40 kg machine with fists in a cage reads as a fight, and the actuator catalog fits it. 12 lb can return as a bench class if engineers ask for bill-of-materials export.

Starter catalog, real parts with published specs [vendor]:

| Part | Specs | Price |
|---|---|---|
| CubeMars AK80-9 V3 | 9 / 22 N·m, Kt 0.095 N·m/A, 160 mΩ, 116 µH, 9:1, 490 g | $479.90 ([CubeMars](https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html)) |
| RobStride 04 | 40 / 120 N·m, 27 / 90 A, 9:1, 1,420 g, ±10% tolerances | €254.95 ([OpenELAB](https://openelab.io/products/robstride04-qdd-120n-m-integrated-joint-motor-module)) |
| Dynamixel XM430-W350 | 4.1 N·m stall, 82 g | $310.39 ([ROBOTIS](https://www.robotis.us/dynamixel-xm430-w350-t/)) |
| AmpFlow E30-150 / A28-400 drive | 5.0 / 25.1 N·m stall | $89 / $569 ([AmpFlow](https://www.ampflow.com/motors/highPerformance/threeInch/)) |
| ODrive Pro driver | 12-56 V, 70 A continuous | $229 ([ODrive](https://shop.odriverobotics.com/products/odrive-pro)) |
| Plates | AR500, 6061-T6, 7075-T6 (cracks rather than dents), Ti-6Al-4V, UHMW, polycarbonate | Parametric |

Each part card holds Kt, R, L, current limits, rotor inertia, gear ratio, efficiency, backlash, ± tolerance and a provenance tag. A virtual dyno in CI must reproduce each actuator's datasheet stall torque and no-load speed, and confirm Kt = Ke, or the part doesn't ship. Thermal constants are mostly unpublished and start as tagged estimates.

Copper heat at peak versus rated current is ~5.4x for the AK80-9 and ~11x for the RobStride 04 [calc], so a high-torque guard cooks motors while fast strikes drain the battery. One sagging pack slows every limb, because V_bus feeds every motor's voltage limit.

Damage is a calibrated game model on real contact forces. Impulses drive dents, penetration or cracks by material. Fastener shear ratings decide when a weld's `eq_active` flips off and a part falls away (welds are soft, so attached parts flex slightly). Every fight closes an energy ledger and publishes the share of energy that came from non-physical game models. Dents are drawn, not simulated.

## 6. The builder

The builder is a compiler. The player edits a typed part graph: parts, sockets (kind, gender, size, force rating), connections (fastener, breakable flag), mirror links and channels. TypeScript compiles it to an MJCF string for `from_xml_string` plus a control manifest. It merges bolted groups into one body (no KSP-style wobble), splits each actuator into stator and rotor, closes loops with equalities, turns breakables into welded free bodies (at most 8), sets `inertia="convex"` or `"shell"` because the default is legacy, and emits channel names, smart zones and a stats card.

Sockets glow only when compatible, mirror mode is on by default, and one key drops the robot into a spar against a dummy. X-ray views show joint axes, center of mass over the support polygon, and torque use from `mj_inverse`. Archetype kits come with auto-fix hints ("left arm 140% over torque: swap to RS04 or shorten 10 cm"). A 3-5 s headless shakedown yields a shareable stats card. Then move forging: iCEM trajectory optimization ("2.7-22x less samples" than CEM ([arXiv 2008.06389](https://arxiv.org/abs/2008.06389)) [vendor]) finds each weapon chain's strikes against its real motor limits in about a minute [est], so a new gear ratio means a new moveset. The casual path must be fast; deep combat builders stayed small (Robot Arena III: 28% positive of 326 Steam reviews ([Steam](https://store.steampowered.com/appreviews/363530?json=1&language=all&purchase_type=all&num_per_page=0)) [indep]).

## 7. The cage and the show

The Kiln has ten sides. Zuffa holds a 3D registration of the octagon cage design (Reg. 4706148, [ntmblog](https://ntmblog.wordpress.com/2015/04/27/zuffa-registers-3d-octagon-shaped-cage-design-in-connection-with-ultimate-fighting-championship-arena/)) and got a game company to acknowledge its octagon trade dress in 2002 ([FCF](http://fcfighter.com/zuffa-affirms-octagon-trademark-rightsin-settlement-with-san-jose-video-game-company/)) [indep]. Spec: ~4.5 m across the flats for 0.9 m robots, matching the UFC cage's ~5x fighter height ([ufc.com](https://www.ufc.com/octagon)) [calc]; a 1.1 m fence of vinyl-coated chain link; padded posts; painted canvas over steel; two gates that burst open above an impulse threshold. Each panel is an invisible spring-damper collider, and a vertex shader bows the visible mesh on impact. Hazards live in a separate Havoc ruleset.

The look is brushed steel (`MeshPhysicalMaterial` anisotropy), heat tint driven by dcmotor temperature, GPU sparks at contacts, and alpha-to-coverage chain link that doesn't shimmer. Sound is sampled metal hits plus a modal resonator bank per part, with servo whine pitched to joint speed.

The broadcast layer is the product. Each robot gets a mind panel: tactic bars, a READ meter from `opp_commit`, a COUNTER ARMED flash, a BLIND tag when the mast breaks, a momentum line from `winning`. Ghost futures appear at decision moments. In replays the director knows the future and cuts before the hit; slow motion re-simulates at the same timestep. Optional Claude commentary reads the event log and can foreshadow.

The 15-second clip: open mid-exchange on the wide shot. RIVET's bar flips from "hold_range 58%" to "bait 61%" and COUNTER ARMED flashes. The hammer drops, RIVET sidesteps, a fist tears off GNASH's sensor mast. Replay the hit slow from a second angle. GNASH's bars flatten and go grey under BLIND. End on the win-probability line crossing. The reply links the replay, which viewers orbit in their own browser, proof that it is simulation and not AI video.

## 8. The best creative ideas

From the smallest-true-thing angle (Cage Zero): perception as a part from day one, the serializer degrading from 6 distance bands to "last seen at 5 o'clock, 0.8 s ago"; thinking costs mass (brain tiers of 6 to 16 questions, 200 to 100 ms reaction time, 0 to 6 imagined futures, 0.3 to 1.5 kg); spending the broadcast delay on physics, so computed fights run planners slower than real time and store the controls; a blind test where the behavior tree also shows utility bars.

From the league angle (TELL): fights computed, not played, then premiered as watch parties; forking any fight at a keyframe, with a Fate meter for the share of forks that flipped the result; one trusted component, the signing proxy; a scar ledger that pushes worn parts toward the bad end of their tolerance band and writes telemetry-derived scar lines into the fighter's state; Mind vs Script and closed-Jev-vs-open-clone divisions; a season Brier score on each fighter's `winning` answers.

From the physical-truth angle (Ground Truth): Jev proposes, physics disposes; move forging; probability-priced bracing; the energy ledger with its fudge percentage; Arrhenius wear odometers from winding temperature; the CI dyno; stabilizers classed by stored joules; once a season, one design built for real and fought at NHRL against a pre-registered prediction.

Mine: the simulated reaction delay doubles as the network budget, so the brain part's reaction tier has a real cost (a 100 ms brain stalls live playback on a 200 ms network); tiered playback, physics on laptops and recorded poses on phones; Toribash night.

Where the concepts disagree, I side with Cage Zero on scale (40 kg) and step (2 ms; 1 ms only with 4x headroom), because anyone's browser comes first; with the league on the proxy and computed ranked fights; and against BOM export in v1, which carries liability and answers a question nobody has asked yet.

## 9. Phased plan

| Phase | Goal | Effort (solo, Claude Code) | Exit criteria |
|---|---|---|---|
| 0. Spikes | Prove the stack | 3-5 days | Two ~12-body robots in contact run at 2x real time at 2 ms in a worker on a 2020-era laptop. Two planner workers run without COOP/COEP; rollout step cost measured. Replay hashes compared across browsers and chips, or keyframe fallback chosen. Contact forces readable, no memory growth over 10 min. Dyno matches AK80-9 and RS04 datasheets. Jev p50/p95 from Philadelphia through the proxy. TypeSafe emailed about public use, on-screen probabilities, quota and CORS |
| 1. Cage Zero | Two fixed robots, Jev the only decider | 7-10 days | Fights run end to end in lockstep for Jev, House Mind and random brains: dcmotor heat, breakable fist, panel and mast, IK/PD programs, arbiter, contingencies, sensor degradation. A fight file replays identically in a second browser. Mind panel, director, sparks and audio, five exported clips. Proxy live with limits and a daily cap |
| 1b. Gate | Answer the question | Days 12-14 | 150-fight mirror matrix (Jev, behavior tree, random), blind test with 10+ viewers, 5 clips posted |
| 2. Garage | Players build | 3-5 weeks | ~30 spec-card parts passing dyno CI, shakedown and stats card, role labels, ghost futures, forks, brain tiers, bus sag, judges, BYOK. 20 outsiders build and share a fight; nothing that passes shakedown blows up the sim |
| 3. Physics-verified mind | Planner, more bodies | 4-6 weeks | Predictive sampling with Jev's prior and weights at 5 Hz on a 4-core laptop, or computed-only. Move forging under 2 min. Spinners, walkers, LQR balancer, reaction wheel, energy ledger. Each family passes a training-free qualification: move 3 m, turn, self-right from 3 poses, survive pushes |
| 4. League | A weekly show | 2-3 weeks, then ~1 day a week | Computed weekly cards with watch parties, signing proxy, scar ledger, Elo, Mind vs Script. Repeat viewers hold 6 weeks before any Steam work |

Kill the idea, or shrink Jev to judge, HUD and role labeler, if any of these holds:

1. Phase 0: two ~12-body wheeled robots can't hold real time at 2 ms in a worker on a 2020-era laptop.
2. Day 14: Jev beats the random tactic picker in under 60% of mirror fights, so its choices don't matter physically.
3. Day 14: half or fewer of the blind viewers prefer Jev fights, and they describe its intent no better than the behavior tree's. Losing on win rate while winning on watchability passes.
4. Fewer than 1 in 10 substantive clip replies mention the robot's decisions or the mind panel.
5. Chris stops opening fights for fun in week two.
6. TypeSafe refuses public use or on-screen probabilities, and open clones behind the same wire format can't beat the House Mind.

Two outcomes are scope cuts, not kills: planners that miss 5 Hz run only in computed fights, and fewer than 20 outside builders means keep the show and drop the league.

## 10. Risks and unknowns

| Risk | Mitigation |
|---|---|
| MuJoCo WASM too slow for contact-heavy robots plus planners; bindings are WIP, Windows is experimental, heap objects need manual `.delete()` | Phase 0 gates; primitive and convex collision shapes, contype filtering, planners off on weak devices; Rapier as last resort |
| Fights read as RC toys, or soft contacts look mushy | Articulated strikes, knockdowns and 10-counts, tuned solref and solimp, render-only hit-stop; the blind test asks "what was red trying to do?" |
| Jev loses on win rate and watchability | Day-14 gate; Mind vs Script as a public storyline; Jev keeps judging and labeling |
| Jev as a dependency: dynamic limits, no SLA, moving aliases, a young company | Pin `jev-1.13.0`, keep the systemone wire format as the seam, House Mind, a replay-first product that needs no network to watch |
| Prompt injection through names, plans or scar text | Opponent text never enters a fighter's state; plans capped at 150 words and linted; only code writes scar lines; the proxy rejects off-schema requests |
| Gambling adjacency | No real-value currency or betting; California AB 831 banned dual-currency sweepstakes from 2026 ([ZwillGen](https://www.zwillgen.com/gaming/californias-ab-831-bans-sweepstakes-casinos-expands-liability-vendors/)) [indep] |
| Niche audience. REK's free human-piloted sim is playable in alpha ([Reflex Arc](https://reflexarc.co.uk/projects/rek-robots)) [indep]; Gladiabots sells "program the AI, watch it fight" without physics ([Steam](https://store.steampowered.com/app/871930/GLADIABOTS__AI_Combat_Arena/)) | Lead with clips and replay links; a physical robot with a mind you shape is the gap |

Open unknowns: Philadelphia latency, Firefox WebGPU, CORS on OpenRouter's systemone route, several WASM instances in parallel workers, real thermal constants.

## 11. What the fact-check corrected

- "64 questions per call" is a guard in Chris's Cabinet client. TypeSafe documents 64k tokens per request (32k for state plus the longest question) and 255 options per choice.
- The rate limit's scope isn't stated and changes without notice. The 70-500 ms figure isn't in the docs; "AWS us-west-2" is a third-party inference.
- Jev's flipped answers across repeats came from varying input: sensitivity, not proven randomness on identical requests.
- jev_fsd is not head-to-head: rules had 12 clean drives, Jev one drive with one borderline red light.
- Jev-Omni doesn't use the systemone format and isn't viable in a browser; the 495 ms Apple M5 sample is Kev-4B.
- `mj_recompile` isn't bound in WASM and mjSpec is untested there, so part loss uses welds with `eq_active`. Default mesh inertia is legacy.
- WebGPU is not Baseline (Firefox), and three.js calls WebGPURenderer experimental.
- Only `@dimforge/rapier3d-deterministic` is cross-platform deterministic.
- MuJoCo Warp lacks the discrete integrator, pid actuator and implicitfast, trains in float32 against the browser's float64, and needs NVIDIA GPUs. Moot now.
- The OCTAGON word mark "Reg. 4372981", repeated by two concepts, is unverified; the 3D cage registration and the Bam! settlement are verified.
- RoboStriker's 200 Hz is its physics rate, not a separate PD tracker.
- Half Sword recovered to ~72% positive; NHRL's billion views are self-reported; Besiege estimates run 1-4 million.

## 12. Sources

Physics and platform: [MuJoCo WASM README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md), [binding generator](https://github.com/google-deepmind/mujoco/blob/main/wasm/codegen/generators/constants.py), [changelog](https://mujoco.readthedocs.io/en/latest/changelog.html), [dcmotor model](https://mujoco.readthedocs.io/en/latest/_static/dcmotor.pdf), [reproducibility](https://mujoco.readthedocs.io/en/stable/computation/index.html#reproducibility), [mjswan #117](https://github.com/ttktjmt/mjswan/issues/117), [MuJoCo #3144](https://github.com/google-deepmind/mujoco/issues/3144), [Rapier TS joints](https://github.com/dimforge/rapier/blob/master/bindings/typescript/src.ts/dynamics/multibody_joint.ts), [Unity articulations](https://docs.unity3d.com/6000.4/Documentation/Manual/physics-articulations.html), [WebGPU status](https://api.webstatus.dev/v1/features/webgpu), [wbc-demo](https://github.com/wbc-mjlab/wbc-demo).

Control without training: [MuJoCo MPC](https://arxiv.org/html/2212.00541), [iCEM](https://arxiv.org/abs/2008.06389), [MPPI on MuJoCo WASM](https://news.ycombinator.com/item?id=41992851), [Coros quadrupeds](https://www.cs.ubc.ca/~van/papers/2011-TOG-quadruped/index.html), [SIMBICON](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf), [biped walking control](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/index.html), [Cubli](https://idsc.ethz.ch/research-dandrea/research-projects/archive/cubli.html), [Wensing 2017](http://www.mit.edu/~pwensing/Papers/Wensing_et_al-2017-TRO.pdf), [cross-body get-up](https://arxiv.org/html/2512.12230).

Jev: [API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models), [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md), [parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md), [consistency](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md), [MCA](https://typesafe.ai/legal/mca), [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [jevbox](https://github.com/duc-minh-droid/jevbox), [jev_fsd](https://github.com/BrendanH18/jev_fsd), [jev-robotics-demo](https://github.com/FazalAAli/jev-robotics-demo), [qualiteg](https://github.com/qualiteg/jev-typesafe-demo), [decider](https://github.com/Mapika/decider), [OpenRouter TypeSafe](https://openrouter.ai/typesafe), [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth), [Cloudflare rate limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Parts and rules: [AK80-9](https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html), [RobStride 04](https://openelab.io/products/robstride04-qdd-120n-m-integrated-joint-motor-module), [XM430](https://www.robotis.us/dynamixel-xm430-w350-t/), [AmpFlow](https://www.ampflow.com/motors/highPerformance/threeInch/), [ODrive Pro](https://shop.odriverobotics.com/products/odrive-pro), [NHRL 2026](https://wiki.nhrl.io/wiki/index.php?title=NHRL_Open_Rules_-_2026), [Ask Aaron](https://runamok.tech/AskAaron/spinner_FAQ.html), [ToriLLE](https://github.com/Miffyli/ToriLLE/blob/master/torille/constants.py).

Show, market, legal: [UFC Octagon](https://www.ufc.com/octagon), [Zuffa 3D mark](https://ntmblog.wordpress.com/2015/04/27/zuffa-registers-3d-octagon-shaped-cage-design-in-connection-with-ultimate-fighting-championship-arena/), [Bam! settlement](http://fcfighter.com/zuffa-affirms-octagon-trademark-rightsin-settlement-with-san-jose-video-game-company/), [REK](https://reflexarc.co.uk/projects/rek-robots), [Gladiabots](https://store.steampowered.com/app/871930/GLADIABOTS__AI_Combat_Arena/), [AB 831](https://www.zwillgen.com/gaming/californias-ab-831-bans-sweepstakes-casinos-expands-liability-vendors/), [Half Sword](https://en.wikipedia.org/wiki/Half_Sword).