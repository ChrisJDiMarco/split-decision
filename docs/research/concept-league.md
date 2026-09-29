# TELL: the robot fight league where you watch the machine think

TELL is a weekly robot fight league that runs in the browser. Players build robots from real-spec parts, write a short fight plan, and hand the robot to Jev. Ranked fights are computed in a browser tab, not played live. They are then premiered as deterministic replays with the fighter's mind on screen: the probability bar that flips just before the hammer drops, and faint ghosts of the futures it considered and rejected. The design rests on one choice: the league never needs to run in real time. Physics pauses at every Jev decision, so API latency, network jitter and laptop speed stop affecting who wins. That also makes room for expensive control methods that need no training, such as physics-based sampling MPC and Jev judging short look-ahead rollouts. People arrive through 15-second X clips. They stay to fork a fight ("what if Rivet had braced?"). Then they end up in the builder, entering a qualifier with their own fighter, whose record, scars and repair bills carry across a season.

# TELL: the robot fight league where you watch the machine think

## 1. The idea in one breath
TELL is a browser-native fight league: a weekly Fight Night, 8-week seasons, belts, and fighters with persistent characters. Every robot is built by a player and piloted by Jev. **Ranked fights are computed, not played.** The sim uses the digest's "chess-clock" mode: physics pauses at each decision tick, both fighters' Jev requests fire on the same frozen state, and each answer takes effect after a fixed simulated reaction delay. Fairness therefore does not depend on network speed. The rate limit becomes a queue rather than a ceiling. And the controllers can spend 5-10x real time on physics look-ahead without ever needing a GPU.

## 2. Core loop
**WATCH** a Fight Night replay or X clip → **FORK** it at any keyframe (§9) → **BUILD** from the catalog and get a shakedown stats card → **QUALIFY** against a house-mind gauntlet → **FIGHT** (the card is computed asynchronously) → **WATCH** your own fighter's broadcast → **REPAIR** by spending garage hours, while scars carry forward → iterate. Players come for the show and stay to build.

## 3. Engine and platform
- **Physics:** the official `@mujoco/mujoco` 3.14 WASM single-thread build, running in a Web Worker. It uses a fixed 1 ms step (2 ms if the week-1 gate fails), the implicitfast or discrete integrator, `dcmotor` actuators with a battery-sag bus, weld-break detachables and analytic spinner bite, all as the digest specifies. One pinned `.wasm` per season.
- **Rendering and shell:** three.js WebGPURenderer with automatic WebGL2 fallback, inside a Next.js shell (the Mini Moto stack). An Electron wrap for Steam comes last.

**Three modes:**

| Mode | Real time? | Mind | Low-level control | Used for |
|---|---|---|---|---|
| Card (ranked) | No, about 0.1-0.3x real time [est] | Jev via signing proxy | Analytic control + predictive-sampling MPC + look-ahead judging | Fight Nights, qualifiers, forks |
| Spar | Yes | House mind (free); optional Live Jev, capped by quota | Analytic only | Builder testing |
| Replay | Faster than real time | The log | ctrl stream + keyframes | Watching, slow-mo, clips |

**The fight file** holds:
- a header: engine version, builds, plans, seeds;
- a signed decision log;
- a 20 Hz ctrl stream for channels driven by MPC;
- a `mj_getState` keyframe every 1 s.

It should be about 0.5-1 MB compressed [est]. Because each keyframe resyncs the replay, playback stays visually correct even if MuJoCo WASM turns out not to be bit-identical across browsers, which is still unverified. Verification (§6) needs re-simulation on the same engine.

**Where Card compute runs.** In v1 it runs in a "farm" tab: the same web app at `/farm`, in Chrome on Chris's Mac. Later it can run in the challenger's own browser, with the farm auditing results. No GPU is involved anywhere.

**Compute estimate [beyond digest, unmeasured].** In MJPC, Predictive Sampling used about 10 samples over 23-35-step horizons and planned in 1-20 ms per update on a 72-core Xeon ([arXiv 2212.00541](https://arxiv.org/html/2212.00541)) [paper]. My guesses for one WASM thread, with the two-robot scene at a coarser 4 ms planning step:
- about 50-150 ms per plan;
- at 20 Hz for both robots, about 2-6 s of compute per fight-second;
- so about 6-18 minutes per 3-minute bout, or about 2-5 minutes with 4 workers splitting the samples.

## 4. Robot bodies in v1
- **Brawler class (ranked in Season 1).**
  - Wheeled or tracked chassis. Tracks are hidden wheels under animated treads, per the digest.
  - One or two weapon systems: hammer/axe, lifter, pneumatic flipper, 2-3-DoF clamp arm, capped vertical or horizontal spinner, wedge.
  - Weight classes: Middleweight 55 kg and Heavyweight 110 kg (BattleBots' 250 lb).
  - Caps: at most 30 bodies, 24 control channels and 8 breakable seams, plus a spinner tip-speed cap.
- **Crawler (exhibition in Season 1, a class in Season 2).** Statically stable walkers with 4-6 legs, built from certified leg modules. They get the NHRL +100% walker weight bonus.
- **Gyro Duel (Season 3 stretch, labeled experimental).** Bipeds kept upright by a physical reaction-wheel torso part plus balance control (§5).
- No free-form humanoids in ranked play.

## 5. Control stack: nothing trained
| Layer | Rate | Method |
|---|---|---|
| L0 physics | 1 kHz | `dcmotor` (thermal, sag on a shared V_bus), `pid` servos, compliant cage panels |
| L1 motor primitives | 100 Hz | PD/IK; differential-drive pure pursuit; weapon state machines with commit windows. Crawler gaits are generated from the kinematic graph: leg modules drive tripod/wave phase oscillators, which set IK foot targets, with body height/tilt PD over the support polygon. The reaction wheel is a real flywheel body: its motor saturates, it has mass, and it draws battery. |
| L2 maneuvers | 20 Hz | Parameterized maneuvers. In Spar they run on analytic controllers. In Card they run on **predictive-sampling MPC that uses MuJoCo itself as the model**, with cost terms weighted by Jev (distance band, bearing, weapon-line alignment, cage avoidance, stability margin, heat). |
| L3 reflex/arbiter | 50 Hz | Legality masks, commit windows, reflexes armed by noul answers, a contingency table |
| L4 Jev | adaptive 1-5 Hz | The decision packet (§6) |
| L5 corner | between rounds | The human player; optional plan lint by Claude |

- **Self-righting** comes from physical srimech parts (a real combat-robot practice) running scripted righting sequences. In Card mode, predictive sampling can also search for a righting motion; MJPC used it for quadruped back-to-standing and humanoid recovery ([paper](https://arxiv.org/html/2212.00541)).
- **Gyro bipeds** use Generalized Biped Walking Control. It combines PD tracking, inverted-pendulum foot placement and Jacobian-transpose gravity compensation, and "requires no character-specific or motion-specific tuning" ([Coros et al. 2010](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/index.html)) [paper], on top of [SIMBICON](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf).
- **KO rule:** a 10-count KO makes the ability to get up a design stat.

**GPU-trained recommendations in the dossiers, and what replaces them:**

| Dossier recommendation | Replacement |
|---|---|
| Engine: mjlab/Playground skill policies in ONNX | Primitives plus sampling MPC |
| Builder: pretrained leg modules and cloud "train my walker" | Procedural gaits from the kinematic graph |
| Locomotion: RL walking, get-up and mocap strikes ($100-700 of 4090 time), plus URMA-style v2 | Srimech parts, MPC righting, the Gyro exhibition |
| Actuators: learned-balance humanoid templates | Reaction-wheel parts plus Coros/SIMBICON |

## 6. Exactly how Jev is used
**The decision packet.** One call per fighter per tick, about 15 questions and about 1,600-1,900 input tokens, with no raw floats in the state:
1. `tactic`: choice over 12-16 options, masked for legality.
2. `target`: choice over the opponent's parts, generated by the compiler.
3. `footwork`: choice over 8 clock-face bearings.
4. Four to six **conditional parameters** for the previous packet's top two tactics, for example "if hammer_overhead: commit timing" (score, 5 levels) and "commit depth" (score, 5 levels). Many move parameters are set in one parallel pass.
5. `aggression` and `spend`: scores for aggression and for weapon RPM/battery spend.
6. `opp_commit`: noul that arms the counter.
7. `brace`: noul, "big hit lands on you within 0.5 s?"
8. `brace_style`: choice of stiffen / ride it (relax) / turn armor. This is a real physical call: stiff high-ratio joints strip gears under impact, per the digest's IMF discussion.
9. Two contingencies: `counter_if_lunge` and `escape_if_pinned`.
10. `candidate_future` (Card mode only): code builds 4-6 candidate maneuvers from the top tactics and parameters. Each is rolled out 0.8 s in a scratch `mjData`, with the opponent continuing its current plan. The outcomes are described in words (damage dealt and taken, end distance, cage proximity, stability), and Jev picks one. This is the jev-robotics-demo pattern from the digest.
11. `winning`: score, used for the HUD and the calibration stat.

**Cadence.**
- 1 Hz when the fighters are apart, 4-5 Hz in range.
- Interrupts fire on: impulse over a threshold, a knockdown, a detected wind-up, cage contact, or under 10 s left on the clock.
- Reaction delay, maximum cadence and question budget come from the fighter's **brain part** (§9).

**How the probabilities drive motion.**
- **Mixture of objectives (§9):** tactics in the same family blend their MPC cost weights by probability.
- **Commitment:** confidence gating with hysteresis. Seeded temperature expresses personality.
- **Reflex arming:** noul thresholds are personality too. A counter-puncher arms at p > 0.4, a brawler at p > 0.7.
- The pre-computed counter fires the moment the geometry trigger trips, with zero round trips.

**Other Jev jobs.**
- **Build time:** one call per build. It labels each channel's limb role (drive / weapon / guard / lifter / leg / stabilizer) from the compiler's feature descriptions, for the player to confirm, and labels an archetype for booking and commentary.
- **Judges:** three differently weighted rubrics score each 10 s window, while code computes the objective facts (digest).
- **Booker:** score questions over pairs of stats cards ("style clash", "competitive?"), while code enforces Elo proximity.
- **Director:** in replays the camera director is code, because it already knows the future.

**Cost and quota [est on vendor pricing of $0.042/M input tokens].**
- A Card bout is 3 × 60 s at about 3 Hz average per fighter: about 1,080 packets × 1,900 tokens ≈ 2.1M tokens ≈ **$0.09**.
- Judges and the booker add under $0.01. Claude commentary adds about $0.05-0.10.
- A 64-bout season costs about $10-15.
- One key sustains about 1 bout per minute against the 1,200 RPM limit, about 1,500 per day, and it queues rather than failing.
- Live Jev at 2 Hz uses 240 RPM, so a key supports only about 5 concurrent live fights. That is why live play defaults to the house mind.

**The proxy (a Cloudflare Worker).**
- **It is a game endpoint, not a pass-through.** It accepts `(fightId, tick, fighter, typed state struct)` and builds the Jev request from fixed server-side templates. This matters because TypeSafe's MCA §2.3(a) bars offering the Services "as a standalone service" ([MCA](https://typesafe.ai/legal/mca)) [vendor contract]. §4.2 assigns Output to the customer, which suggests showing probabilities on screen is fine. Confirm both points in writing.
- **Limits:** a per-user limit via the Workers Rate Limiting binding (GA; 10 s or 60 s periods, [docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), plus a token budget per fight.
- **Signing:** it signs each response as HMAC(fightId, tick, fighter, sha256(stateText), answers). It keeps its own copy of the log, so the farm can finish an abandoned bout.
- **Bring your own key (BYOK):** OpenRouter's OAuth PKCE gives the browser a key the user controls, with no backend ([docs](https://openrouter.ai/docs/guides/overview/auth/oauth)), and OpenRouter lists `typesafe/jev-1.13`. BYOK fights are unsigned, so they are unranked (spar and forks only). **Unverified:** whether OpenRouter's systemone route accepts CORS calls from a browser.
- **Offline fallback:** the **House Mind**, a utility AI that answers the same packet schema with softmaxed utility scores. The HUD, blending and replays work unchanged, and the screen is labeled HOUSE MIND. In-browser open deciders are not viable yet: the Jev-Omni WebGPU port takes about 7 s per question (digest).

## 7. The league layer
- **Fighter** = build + plan (≤150 words) + personality + corner (the player) + record + scar ledger + part passports.
- **Fight Night:**
  - 6-8 bouts of 3 × 60 s rounds, a 10-count KO, 10-point-must cards.
  - Computed on the farm on Saturday and premiered Sunday evening as a synchronized watch party: every browser plays the same file from the same timestamp.
  - Round-break corner edits are pre-registered as conditional round plans, because the fights are computed ahead of time.
- **Divisions:**
  - **Mind** (Jev) and **Script** (House Mind). A weekly cross-division "Mind vs Script" bout is both the scientific control and a storyline.
  - An **Open Mind** card pits Jev against open clones such as Kev-4B through the same wire format.
- **Repair economy:**
  - 40 garage hours per week (motor swap 3 h, rewind 5 h, re-plate 2 h per panel). Anything left unrepaired carries into the next fight.
  - Scrap credits from wins buy parts inside the class cost cap.
  - No real money, and no betting in Season 1 (see the digest's AB 831 / UKGC notes).
- **Season stats:** Elo, belts, and a **Self-Awareness** stat: the Brier score of each fighter's in-fight `winning` answers against actual results.

## 8. The cage and the broadcast
- **"The Kiln."**
  - A 10-sided steel cage, not an octagon, because Zuffa holds trademark registrations 4372981 and 4706148 (digest).
  - About 8 m across the flats for Heavyweights [est scale], a 1.2 m fence with a steel kick-rail, and a steel deck.
  - Vinyl-coated chain-link panels are spring-damper colliders that bulge in the vertex shader. Posts are padded, and two gates can burst open.
  - Hazards belong to a separate "Havoc Night" ruleset.
- **Broadcast:**
  - A mind panel with bars, a READ meter driven by noul answers, and ghost futures (§9).
  - Heat tint as telemetry, a win-probability line from `winning`, and judges' cards revealed each round.
  - A tale of the tape built from shakedown stats.
  - Claude commentary plus TTS, reading the event log. It knows the ending, so it can foreshadow.
- **X engine:**
  - After each card, a script ranks moments by mind flip × impulse × part detach.
  - It renders 9:16 and 16:9 cuts with Remotion's `ThreeWebGPUCanvas`, which drives the scene frame by frame so renders are deterministic ([docs](https://www.remotion.dev/docs/three-webgpu-canvas)).
  - Clips go into Chris's existing approve-and-post marketing engine. The reply under each post is the fork link.

## 9. What is new here
1. **The brain and senses are parts.**
   - **Brain modules:**
     - *Pocket Brain*: 2 Hz, 300 ms, 8 questions, 0.4 kg.
     - *Tactician*: 3 Hz, 200 ms, 16 questions.
     - *Reflex Core*: 5 Hz, 120 ms, 16 questions, 2.5 kg, 60 W on the bus.
   - **Sensor parts** decide which facts reach the state. Without a lidar mast, the state reads "opponent last seen 4 o'clock, 1.2 s ago". Without current sensors, the robot does not know its motors are hot. Tearing off a sensor mast half-blinds the mind, and the HUD shows "what Red sees."
   - API quota and cost become a build trade-off.
2. **Ghost futures.** The Card-mode rollouts Jev judged appear as translucent ghost robots at the moment of decision, each labeled with Jev's probability.
3. **Fork the fight.**
   - Any viewer can branch a bout at a keyframe, changing one corner instruction or brace style, and re-simulate. Only post-fork Jev calls are billed, about $0.03-0.06, with 3 free forks per day and unlimited forks with BYOK.
   - Across all forks, a **Fate meter** shows what share of them flipped the result, which measures how decisive the real fight was.
4. **A league with one trusted component.** Only the signing proxy is trusted. Any browser can compute a bout, and any viewer can verify it by re-simulating and matching the signed state hashes.
5. **The scar ledger.**
   - Wear (a Miner's-rule damage accumulator, D) shifts each part's tolerance draw toward the bad end of its band.
   - Code writes up to three telemetry-derived "scar lines" into the fighter's own state, for example "KO'd by a vertical spinner, Week 3". A rehab spar removes one.
   - Fighters develop visible flinches and confidence over a season.
6. **Mixture of objectives.** A fighter split 55/45 between two related tactics moves half-committed. Doubt becomes body language.

## Novel ideas
- The brain and senses are physical parts. Brain modules trade decision rate, reaction delay (in sim time) and questions per call against mass, bus power and cost-cap budget. Sensor parts (lidar mast, front camera, IMU, current sensors) decide which facts the code may write into Jev's state. Tearing off a sensor mast half-blinds the mind: its state switches to 'last seen 4 o'clock, 1.2 s ago'. API quota and cost become a design trade-off inside the game, and the HUD shows 'what Red sees'.
- Ghost futures on the broadcast. In Card mode, code rolls 4-6 candidate maneuvers 0.8 s ahead in a scratch mjData and Jev picks one. The broadcast renders those rollouts as translucent ghost robots at the decision moment, each labeled with Jev's probability, so viewers see the futures the machine considered and rejected.
- Fork the fight, with a Fate meter. Any viewer can branch a deterministic bout at any 1 s keyframe, change one corner instruction or brace style, and re-simulate. Only the post-fork Jev calls are billed, about $0.03-0.06. Forks get posted as X replies. The share of all forks that flip the result becomes a 'Fate meter', a public measure of how decisive the real fight was.
- A league with one trusted component. The rate-limited Cloudflare proxy builds Jev requests from fixed game templates, which also keeps it clear of the MCA §2.3(a) 'standalone service' clause. It signs each answer as HMAC(fightId, tick, sha256(stateText), answers). Any browser can then compute a ranked bout, and any viewer can verify it by re-simulating and matching state hashes against the signatures. Only the ~150-line proxy needs trusting.
- The scar ledger. Persistent wear from a Miner's-rule accumulator shifts each part's tolerance draw toward the bad end of its published ± band. Code writes up to three telemetry-derived scar or confidence lines into the fighter's own Jev state (for example 'KO'd by a vertical spinner, Week 3'), and a rehab spar can remove one. Fighters develop flinches, streaks and arcs over a season with no retraining, all paid for from a fixed garage-hours repair economy.
- Mixture of objectives. Jev's tactic distribution is not collapsed to one sample. Within a tactic family, the probabilities blend the cost weights of the sampling MPC, so a 55/45 split produces visibly hedged, half-committed movement. Doubt becomes body language, while hysteresis and confidence gating still govern switches between families.

## Phases
- **P0: Gates** (1 week): Measure the four numbers the concept depends on before building anything else.. Exit: (1) Two ~25-body MJCF brawlers in a scripted clinch step at 1 kHz (or 2 ms) in a worker on a 2021-era laptop, with MPC plan time measured. (2) Replay-hash comparison across Chrome, Firefox and Safari is known (bit-identical or not). (3) Contact and efc forces are readable in the official bindings without leaks. (4) Jev p50/p95 from Philadelphia with a 15-question, ~1,800-token packet is measured. (5) An email is sent to TypeSafe about league use, the signing proxy and showing probabilities on screen.
- **P1: Two fighters, one cage** (2-3 weeks): Prove that a Jev fighter is either better or more watchable than a scripted one.. Exit: Two hand-built brawlers (no builder) with analytic controllers, the Jev packet through the proxy in Card mode, the House Mind, fight files, and replay with the mind panel. Fifty Jev-vs-House bouts are run. Continue if Jev wins at least 45% or is picked as more watchable at least 60% of the time in a blind test with 20+ viewers.
- **P2: Broadcast and X engine** (2-3 weeks): Make the show: director, ghost futures, commentary, clips, fork links.. Exit: Card-mode predictive-sampling MPC and look-ahead judging are working. Remotion ThreeWebGPUCanvas renders 9:16 and 16:9 clips from a fight file, with Claude commentary plus TTS. Fork links are live. Five clips are posted. Continue if they beat Chris's median engagement and replies mention the mind panel or ghosts rather than only 'nice render'.
- **P3: Builder and qualifier** (4-6 weeks): Let outsiders make fighters.. Exit: Catalog of ~40 real-spec parts including brain and sensor parts; part graph to MJCF compiler; live validator; shakedown stats card; Jev limb-role labeling; signed proxy with rate limits and per-fight budgets; OpenRouter PKCE BYOK for unranked play; House Mind qualifier gauntlet. Exit when 30 or more external builds pass qualification.
- **P4: Season 1** (2-3 weeks of league ops build, then 8 weeks of running at about 1 day/week): Run the league as a weekly show.. Exit: Weekly Fight Nights computed on the farm tab and premiered as synchronized watch parties. Scar ledger, garage-hours repair economy, Elo, belts, judges' cards, Mind vs Script and Open Mind (Jev vs open clone) bouts, and a Crawler exhibition with procedural gaits. Continue into Season 2 if weekly returning viewers and active builders are both still growing in weeks 5-8.
- **P5: Season 2+ (optional)** (2-4 months, gated on P4): Widen the bodies and platforms.. Exit: Crawler becomes a full class; Gyro Duel biped exhibition (reaction-wheel part plus Coros/SIMBICON balance) passes a stand, push and 10-count get-up qualification; the Electron wrap ships for Steam.

## Risks
- Jev loses to a tuned behavior tree and is not more fun to watch. Prior art: jev_fsd's rules brain drove clean where Jev ran a red light, and the vendor admits a non-AI Doom bot plays better. → Make Mind vs Script a permanent, published weekly storyline rather than something hidden. Give Jev the parts of the job where it has an edge: plain-English plans, contingencies, calibrated distributions. Keep low-level skill fully in code. Gate at P1 with 50 bouts and a blind watchability test.
- MuJoCo WASM is too slow on consumer laptops for two contact-heavy robots plus sampling MPC. → Card mode has no real-time requirement, so a slower sim just means a longer compute queue. Spar mode uses analytic controllers only. Use primitive geoms, contype filtering and a 2 ms fallback step. Ranked compute runs on the farm tab first.
- TypeSafe changes terms, pricing or the 1,200 RPM limit, or the product disappears. It is a weeks-old startup with no SLA, and the MCA §2.3(a) standalone-service clause applies. → Build the proxy as a game endpoint with fixed templates. Get written confirmation for league use. Hide the model behind the systemone wire format so open clones (Kev-4B on OpenRouter) or the House Mind can be swapped in. The House Mind keeps the whole show running offline.
- The show is niche: AI-vs-AI spectator formats like SaltyBet and Gladiabots stay small, and clips earn 'cool render' reactions with no retention. → Fork links turn viewers into participants cheaply. Ship the builder only after the clip test passes. Keep the X engine inside Chris's existing marketing pipeline so content costs near zero.
- MuJoCo WASM is not bit-identical across browsers, which breaks verification and forks. → Keyframe resync every 1 s keeps replays visually correct. Ranked verification and forks run on the farm's pinned browser engine, and cross-browser verification waits until it is proven.
- Prompt injection or exploits through player-written fight plans, fighter names or scar text. → Opponent-authored text never enters your fighter's state. Plans are capped at 150 words and linted by Claude. Only code writes scar lines, from telemetry. Names and bios are sanitized out of Jev state.
- Legal: Zuffa trade dress, gambling adjacency, robot likenesses. → A 10-sided own-brand cage, no betting or currency in Season 1, 'G1-class'-style naming only, and a one-hour trademark review before public launch.
- Scope creep into legged or humanoid fighting, which is research-grade without training. → Season 1 is Brawlers only, with Crawlers as exhibition. Gyro bipeds are a Season 3 labeled experiment. The builder caps bodies, channels and breakables.

## Kill criteria
Drop the idea, or shrink it to a content-only side project, if any of these happens:
(1) After P1's 50 bouts, Jev fighters win under 45% against the tuned House Mind AND fewer than 60% of 20+ blind viewers pick the Jev fight as more watchable. The premise that Jev makes robots fight is then false.
(2) The five P2 clips land below Chris's median X engagement, and the replies never mention the mind panel or the ghost futures ('nice render' only).
(3) The P0 gate shows MuJoCo WASM cannot compute a 3-minute two-brawler bout in under about 30 minutes, even without MPC, on a 2021-era laptop or the farm Mac.
(4) TypeSafe refuses public league use, AND the open clones reached through the same wire format cannot beat the House Mind either.
(5) By the end of P3, fewer than 30 external builds pass qualification. In that case keep the show and drop the league: it is a content engine, not a community.
