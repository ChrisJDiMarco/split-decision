# Octagon, presentation, prior art and opportunity

**Headline:** Build it, but start with the show rather than the game. The one thing nobody else has is a fight where you can watch the robot's mind decide, with a calibrated probability bar that flips just before the hit, in fights anyone can replay exactly. Build a cage of your own design, not a UFC Octagon replica. Run league fights offline in a mode where the sim pauses while Jev decides. Get to the first 15-second X clip before worrying about Steam.

**Recommendation:** 1. Make the show the product. Use a deterministic sim plus logged Jev decisions, so every fight is a small file that replays identically. The client renders it, an auto-director picks the cuts (it already knows when the big hit lands), and a mind panel shows each fighter's live Jev choice distribution. That panel is the thing no competitor has.
2. Build a cage engineered like a real MMA cage but with its own shape and name. Use real construction: vinyl-coated chain-link panels as compliant colliders, padded posts, raised platform, two gates that can burst open. Do not replicate the UFC Octagon or use the name. Zuffa holds the OCTAGON word mark and USPTO 3D cage registration 4706148 covering live shows and entertainment programming.
3. Scale it at about 4x robot height across. That is about 5.5 m for G1-class robots and about 7.3 m (the real 25-ft cage) for T800-class. Keep no hazards in the sanctioned humanoid ruleset and put BattleBots-style hazards in a separate "Havoc" ruleset for wheeled robots.
4. Stack: three.js WebGPURenderer (r186) for real-time, reusing Mini Moto skills. Render hero clips offline (Blender Cycles or three-gpu-pathtracer) from the same fight file. Skip Unity HDRP, which is in maintenance mode. Consider UE5 only for a later Steam version.
5. Run league fights in chess-clock mode: the sim pauses at fixed decision ticks for Jev. Latency then cannot change outcomes, and the 1,200 requests/min rate limit is not a concurrency ceiling. Money is not the constraint: about $0.12 per 3-minute fight.
6. Two-week proof of concept: two fixed robots, a 12-tactic Jev menu at 2–4 Hz above scripted or RL skills, and five 15-second X clips following the storyboard in the dossier. Continue only if people comment on the mind panel; kill it if the only reaction is "nice render."
7. Order after that: X content engine, then a browser builder with shareable replay links, then a league reusing the Out of Distribution "seat your own model" mechanic (a closed-Jev-vs-Jev-Omni card is timely). Steam comes last, and REK Sim is already free there.
8. Hard rules: free fake currency only for any betting, with no purchase or cash-out (California AB 831, New York SB 5935 and the UK's virtual-sports rules all bite otherwise). No UFC, Octagon, Real Steel or BattleBots names. No exact Unitree or EngineAI likenesses. Get a one-hour trademark review before public launch.

# Stream: the ring, the show, and whether this should exist
*Research date 2026-09-29. Tags: [vendor] = the company's own claim, [indep] = independent source, [calc] = my arithmetic, [unverified] = I could not confirm it.*

## Verdict in one paragraph
The idea is timely and the white space is real, but the real opening is narrower than "robot fighting game." Human-piloted humanoid fight leagues exploded in 2025–26: REK, URKL, UFB and the CMG/Unitree event. REK even ships a free physics "digital twin" sim on Steam. No one I found combines three things: (1) articulated robots that users build, simulated with physics, (2) an autonomous mind whose live decision probabilities viewers can see, and (3) deterministic, shareable replays. Those three together are the product. The cage itself should be engineered like a real MMA cage but must not copy the UFC Octagon's trade dress. The fastest honest path is to render fights offline as clips for X, then offer a browser replay and builder toy, then run a league. A Steam game comes last, if at all.

---

## (a) The cage: real specs, scaling, legal, physics

**Real UFC Octagon numbers (all verified):**
| Spec | Value | Source |
|---|---|---|
| Interior, across the flats | 30 ft (9.1 m) | [ufc.com/octagon](https://www.ufc.com/octagon) [vendor] |
| Side length | 12.43 ft (3.79 m) | [dimensions.com](https://www.dimensions.com/element/ufc-octagon) [indep] |
| Exterior | 38 ft (11.5 m) | [ufc.com](https://www.ufc.com/octagon) |
| Fence height | 5 ft 9 in (1.75 m) from canvas; other sources say 6 ft | [ufc.com](https://www.ufc.com/octagon), [Wikipedia](https://en.wikipedia.org/wiki/Mixed_martial_arts_cage) |
| Fence material | Metal chain link coated in black vinyl ("plastic-coated"), foam padding along the top and at each of the 8 posts | [Wikipedia](https://en.wikipedia.org/wiki/Mixed_martial_arts_cage) |
| Platform | 4 ft (1.2 m) off the ground, 4 ft walkway | [ufc.com](https://www.ufc.com/octagon) |
| Gates | 2, opposite each other, each 3 ft × 5 ft (0.9 × 1.5 m) | [ufc.com](https://www.ufc.com/octagon) |
| Canvas | Textured, hand-painted, used once per event; mat 0.31–0.5 in | [ufc.com](https://www.ufc.com/octagon), [dimensions.com](https://www.dimensions.com/element/ufc-octagon) |
| Small cage | 25 ft variant, used at the UFC Apex and small venues | [Wikipedia: UFC Apex](https://en.wikipedia.org/wiki/UFC_Apex) |

I could **not** verify the UFC's mesh gauge, diamond size, or post-padding thickness. Treat any exact number for those as an art-direction choice.

**Scaling to the robots [calc].** The UFC cage is about 5.1× a 1.8 m fighter's height across, and the fence is about 1× fighter height. REK Tokyo (July 25, 2026) fought G1s in an octagon with **1.2 m sides** ([MSN/REK Tokyo](https://www.msn.com/en-xl/sports/general/humanoid-robots-clash-in-tokyo-s-rek-2026-fighting-competition/ar-AA29zJma)). That is only about 2.9 m across, or 2.2× robot height, which is deliberately cramped to force contact. I suggest about 4× robot height, which is what the 25-ft Apex cage is for a human fighter. The Apex is associated with more finishes ([Wikipedia](https://en.wikipedia.org/wiki/UFC_Apex)).
- **Class G (G1-class, 1.32 m, ~35 kg, knee torque 90–120 N·m** per [Unitree](https://www.unitree.com/g1) [vendor]): about 5.5 m across, fence about 1.3 m, platform about 0.9 m.
- **Class H (T800-class, 1.73 m** per [Global Times](https://www.globaltimes.cn/page/202607/1366175.shtml)): about 7.3 m across. That is almost exactly the real 25-ft cage, so human-proportioned robots get true-scale MMA spacing.
- **Class B (BattleBots-class wheeled or tracked machines):** the correct reference is not a cage at all. It is BattleBots' 48 × 48 ft steel-floored BattleBox ([BattleBots wiki](https://battlebots.fandom.com/wiki/BattleBox)) or NHRL's double-wall polycarbonate boxes ([Wikipedia](https://en.wikipedia.org/wiki/National_Havoc_Robot_League)).

**Legal: do not build "the Octagon."** Zuffa owns the word mark OCTAGON (Reg. 4372981, [Justia](https://trademarks.justia.com/853/18/octagon-85318709.html)). It also holds a **USPTO 3D registration of the octagon-shaped cage design, Reg. 4706148 (2015)**, covering live shows and *entertainment programming* in MMA ([ntmblog](https://ntmblog.wordpress.com/2015/04/27/zuffa-registers-3d-octagon-shaped-cage-design-in-connection-with-ultimate-fighting-championship-arena/)). A broadcast robot league sits closer to those registered services than a video game does. A court found the eight-sided mat and enclosure "distinctive" with secondary meaning ([Sherdog](https://www.sherdog.com/news/news/Court-Rules-in-Favor-of-Zuffa-8499)). Zuffa has also gone after game makers: it sued Ubisoft over "Fighter Uncaged" ([Review-Journal](https://www.reviewjournal.com/business/ufc-sues-video-game-maker-alleging-harm-to-trademark/)), and Bam! signed a settlement acknowledging the octagon trade dress ([FCF](http://fcfighter.com/zuffa-affirms-octagon-trademark-rightsin-settlement-with-san-jose-video-game-company/)). Other promotions have used octagonal cages since 2001 ([Wikipedia](https://en.wikipedia.org/wiki/Mixed_martial_arts_cage)), but avoiding the risk costs almost nothing.

My advice: make it "hyper-accurate to real cage engineering" (vinyl-coated chain-link panels, padded posts, raised platform, two gates, canvas over foam) with **your own silhouette and name**. For example, a 10-sided steel cage with industrial trusses gives Chris a brand he owns. Also avoid "Real Steel" (DreamWorks/Disney; a Disney+ series was announced in 2022 and its status is murky, per [whatsondisneyplus](https://whatsondisneyplus.com/shawn-levy-gives-disappointing-update-on-real-steel-disney-series/)), "BattleBots", and exact Unitree or EngineAI likenesses. Say "G1-class", not "G1". I am not a lawyer; get a one-hour trademark review before launch.

**Cage physics.**
- Do not simulate individual wires. Give each panel an invisible compliant collider (a spring-damper plane) tuned so a 35 kg robot hitting it at a few m/s bows it by a few centimetres.
- Drive the visible bulge from the contact impulse in a vertex shader.
- Posts are rigid and padded. Gates are latched bodies that can burst open under a threshold impulse, a free "chaos moment" that is rare and clip-worthy.
- The Unified Rules list **"grabbing the fence" as a foul** ([Wikipedia](https://en.wikipedia.org/wiki/Unified_Rules_of_Mixed_Martial_Arts)). Exposing "grab fence (foul risk)" as one of Jev's choices is exactly the kind of legible, risky decision viewers enjoy.

**Hazards.** BattleBots uses Pulverizers (about 3,000 lb force), Killsaws (1,800 rpm), Screws, Hellraisers and a pit ([BattleBots wiki](https://battlebots.fandom.com/wiki/Pulverizers)). NHRL adds house bots with a $1,000 bounty for switching one off ([Wikipedia](https://en.wikipedia.org/wiki/National_Havoc_Robot_League)).
- **Recommendation:** the "sanctioned" humanoid cage has no hazards; the cage itself is the hazard (pinning, fence clinch, gate burst).
- Hazards belong to a separate **"Havoc Night"** ruleset and to the wheeled class. That keeps humanoid fights readable as a *sport* and gives the wheeled class spectacle.

---

## (b) Rendering and feel: the honest quality ceiling

**Engine landscape, 2026:**
- **three.js:** WebGPU reached Baseline in Chrome/Edge, Firefox (141 on Windows, 145 on Apple Silicon macOS) and Safari 26. Linux and Android coverage is still incomplete ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers), [webgpu.com](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/)). The three.js WebGPURenderer is the recommended path and falls back to WebGL2 automatically. r185 (June 2026) added clustered Forward+ lighting. r186 (Sep 2026) added SunLight with cascaded shadows, `compileComputeAsync()` and reworked PBR energy conservation ([Utsubo](https://www.utsubo.com/blog/threejs-2026-what-changed), [radiancefields](https://radiancefields.com/three.js-merges-a-native-gaussian-splat-renderer-for-webgpu-in-r186)) [indep].
- **Unity:** HDRP is in **maintenance mode, and "no new features are planned for HDRP"**. The Built-in pipeline is deprecated in 6.5; URP gets the investment ([Unity](https://unity.com/topics/render-pipelines-strategy-for-2026)) [vendor]. Starting a high-end Unity HDRP project in 2026 is a bad bet.
- **Unreal 5.7/5.8** has the highest ceiling for this look:
  - Substrate, a layered material system (metal, clear coat, oil), became production-ready in 5.7.
  - Lumen with hardware ray tracing runs at 60 Hz on supported hardware.
  - MegaLights is production-ready in 5.8 ([Epic](https://www.unrealengine.com/news/unreal-engine-5-7-is-now-available), [Tom Looman](https://tomlooman.com/unreal-engine-5-8-performance-highlights/)).
  - Unreal has no web target, though. Pixel Streaming costs about $0.13–0.53 per user-hour ([StraySpark](https://www.strayspark.studio/blog/pixel-streaming-ue5-cloud-gaming-demo)) [indep], which kills the economics of a browser toy.

**Why three.js is enough for *this* look.** A fight arena is a lighting-easy scene: one bright overhead truss rig, a dark crowd, and a matte canvas. That is the best case for a rasterizer without global illumination. The metals are what sell it:
- `MeshPhysicalMaterial` with `anisotropy` + `anisotropyRotation` + `anisotropyMap` for brushed steel ([docs](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)). Clearcoat for painted armor, iridescence for heat-tinted titanium.
- **Heat-tint as telemetry.** Overheating actuator housings shift toward straw, then blue oxide tint, the way real steel does. Viewers read motor heat without a HUD.
- Damage in three tiers: projected decals (scorch, scratches) → dent maps written into a per-part texture in UV space and applied as vertex displacement in TSL → pre-authored "crushed" swaps for extreme hits. Parts detach when a joint's impulse crosses its break threshold and become debris rigid bodies.
- **Sparks:** GPU compute particles. The official three.js example runs 500k particles ([example](https://threejs.org/examples/webgpu_compute_particles.html)). Emit at contact points along the relative tangential velocity. **Hydraulic fluid:** the MLS-MPM fluid compute example ([example](https://threejs.org/examples/webgpu_compute_particles_fluid.html)) for spurts, plus decal puddles.
- **Chain link:** an alpha-tested texture needs alpha-to-coverage plus coverage-preserving mipmaps, or it shimmers and moirés at the distances a broadcast hard-cam uses ([Wikipedia](https://en.wikipedia.org/wiki/Alpha_to_coverage), [The Witness](http://the-witness.net/news/2010/09/computing-alpha-mipmaps/)). Swap to instanced wire geometry for close-up hero shots.

**The creative unlock: the viral clip does not need to be real-time.** A deterministic fight can be re-rendered offline: glTF animation export into Blender Cycles, or [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), which is porting to WebGPU compute in 2026. That gives path-traced metal, true motion blur and depth of field, beyond any real-time engine. The browser gets the real-time version; X gets the film version of the same fight.

**Audio.**
- Layer recorded metal impacts with a small modal resonator bank per part. Use a bank of damped sinusoids in an AudioWorklet, parameterized by impulse magnitude, material and part size.
- Research lineage: NeuralSound (TOG 2022), DiffSound (SIGGRAPH 2024), differentiable modal resonators ([arXiv 2210.15306](https://arxiv.org/pdf/2210.15306)).
- Samples: the Sonniss GDC 2026 bundle, 7.47 GB, royalty-free, no attribution required ([rekkerd](https://rekkerd.org/sonniss-releases-gdc-2026-game-audio-bundle/)).
- Servo whine pitch-mapped to joint velocity and torque turns telemetry into something you hear.
- Crowd loops ducked and swelled by the same "hype score" that drives the camera director.

---

## (c) The broadcast layer

**A fight is a file.** Rapier's JS/WASM build is **"fully cross-platform deterministic"**, given the same version, the same insertion order and no `Math.sin`/`cos` during initialization. World snapshots hash identically across machines ([Rapier docs](https://rapier.rs/docs/user_guides/javascript/determinism/)) [vendor]. A fight is therefore `{engine version, seed, two builds, two fight plans, decision log}`, a few KB. It replays bit-identically in any browser. A shareable fight link is the growth loop, and it proves the fight is real simulation, not AI video. That matters in 2026: every robot clip will be suspected of being Seedance. Whichever physics engine the engine stream picks must meet this bar.

**Chess-clock mode.** Jev's docs list no latency SLA and no seed option. The 70–500 ms figure is the vendor's claim and is not in the docs ([models](https://docs.typesafe.ai/models), [API](https://docs.typesafe.ai/api)). So:
- League fights pause the sim at fixed decision ticks while Jev answers. Network latency then cannot change outcomes, which makes fights fair and reproducible.
- Every answer is logged; replays never call Jev again.
- Live play keeps real-time latency as a visible "reaction time" stat.

**Slow motion comes free.** RoboStriker ran physics at 200 Hz with a 50 Hz policy ([HF](https://huggingface.co/papers/2601.22517)) [indep]. If our sim steps at 200 Hz to 1 kHz, a replay that renders every physics substep gives roughly 3–16× genuine slow motion at 60 fps with no interpolation [calc]. Orbit or "bullet-time" cameras come from the same re-sim.

**A director that sees the future.** Esports auto-observers are an active research area ([Sci Reports 2025](https://www.nature.com/articles/s41598-025-93692-0)). Ours has an unfair advantage: in a replay, the director already knows when the big hit lands. It can cut to the right angle *before* the impact, set the slow-motion window, and pick the reaction shot.
- Scoring per camera: fighter proximity, closing velocity, impulse spikes, part detachment, and "mind flips" (Jev's top choice changing).
- Minimum shot length is about 2 s, with hysteresis. Camera set: hard-cam (high-wide), cage-side rail cams, overhead, head-POV, "fence GoPro".
- The same director renders 16:9 and 9:16 cuts from one replay.

**Telemetry overlays:**
- Per-actuator torque rings (percent of peak), motor temperature (also shown as heat-tint), battery, and a stability margin.
- **The mind panel:** each fighter's live Jev choice distribution (e.g., 12 tactics as bars) plus confidence. Jev's API returns the full probability distribution for every Choice question, up to 255 options, and Score questions with up to 10 levels ([API](https://docs.typesafe.ai/api)) [vendor].
- A win-probability line from a per-second Noul question, in the spirit of Wimbledon's "Likelihood to Win" ([IBM](https://newsroom.ibm.com/2025-06-17-the-all-england-lawn-tennis-club-and-ibm-launch-new-ai-features-for-real-time-wimbledon-fan-engagement)) [vendor]. Note that this line is exactly what a bettor would want; see risks.

**Commentary.** Jev produces no text, so play-by-play needs a separate LLM (Claude Haiku/Sonnet) reading the JSON event log, plus TTS.
- Precedent: LLM Colosseum fed LLMs text descriptions of Street Fighter III state; the **smaller, faster models won** ([The Register](https://www.theregister.com/2024/04/11/chatgpt_claude_street_fighter_3/)).
- IBM ships LLM commentary on Wimbledon highlight reels ([IBM](https://www.ibm.com/think/news/future-tennis-broadcasting-ai-sports-commentary)) [vendor].
- For offline replays, the commentator knows the ending and can foreshadow ("he doesn't know that left arm is already cracked").

---

## (d) Prior art, 2024–2026: who is close

**Real robot leagues (all human-piloted or unclear):**
- **Unitree "Iron Fist King" / CMG Mecha Fighting Series:** May 25, 2025, Hangzhou. Four G1s teleoperated via motion capture, live on CCTV-10 ([PopSci](https://www.popsci.com/technology/humanoid-robots-boxing-match/), [Live Science](https://www.livescience.com/technology/robotics/china-pits-rival-humanoids-against-each-other-in-worlds-first-robot-boxing-tournament)).
- **URKL (EngineAI):** opened July 17, 2026 in Shenzhen. 1.73 m T800s; 32 teams per [Global Times](https://www.globaltimes.cn/page/202607/1366175.shtml) versus 16 per [RoboSports Global](https://robosportsglobal.com/robot-combat-sport-2026-urkl-rek-ufb/). About $1.44M championship belt. Its viral moment was "White Eagle" kicking off "Matador's" head ([SCMP](https://www.scmp.com/video/technology/3361043/chinese-humanoid-robots-mma-clash-ends-decapitation-fighting-league-shenzhen)). **Autonomy is conflicting:** RoboSports says fully autonomous; other sources do not say [unverified].
- **REK:**
  - Events: REK1 in San Francisco, Feb 7, 2026, with tickets at $60–80 and five 60-second rounds ([Rest of World](https://restofworld.org/2026/chinese-robot-boxing-unitree-rek/)); Tokyo, July 25; REK2 with 6-ft robots, Aug 15; a human-vs-robot demo on Sep 18 went viral ([runtimewire](https://runtimewire.com/article/human-vs-robot-rek-put-a-human-in-the-ring-with-a-six-foot-humanoid-robot)).
  - Control: VR or gamepad pilots, with AI used only for balance ([Reflex Arc](https://reflexarc.co.uk/projects/rek-robots)).
- **UFB:** G1s driven with game controllers; sold-out events in San Francisco and Las Vegas ([Humanoid Sports Network](https://humanoidsportsnetwork.com/ultimate-fighting-bots/)).
- **BattleBots:** Pro League, 20 episodes on YouTube from July 2026 ([Wikipedia](https://en.wikipedia.org/wiki/BattleBots)).
- **NHRL:** about **1 billion organic social views a year** (2025), a multi-year DAZN deal (May 2026), and up to $30k in prizes per Pro Tour event ([Wikipedia](https://en.wikipedia.org/wiki/National_Havoc_Robot_League), [NHRL](https://www.nhrl.io/about-pro-tour-2026)).

**The closest competitor: REK Sim.** It is free on Steam and Quest ("coming soon"). It uses the same trained balance controller as the real robots, "no canned animations", authoritative server physics, modded G1/T800 bodies, and a ladder whose top players get to pilot the real robots ([Steam](https://store.steampowered.com/app/4582660/REK/), [rek.com/sim](https://rek.com/sim)) [vendor]. It is human-piloted, has fixed bodies, and has no AI mind.

**Games:**
- Robot Arena 2 (Havok engine, a cult modding scene that still runs tournaments, [Wikipedia](https://en.wikipedia.org/wiki/Robot_Arena_2:_Design_and_Destroy)).
- Robot Rumble 2 (real parts, electronics simulation, weight classes from 3 to 340 lb, [Steam](https://store.steampowered.com/app/884180/Robot_Rumble_2/)).
- PitBots (deformable chassis, still in development) and BotBrawl.
- Clone Drone (96% positive across 17,905 reviews, [Steam](https://store.steampowered.com/app/597170/Clone_Drone_in_the_Danger_Zone/)).
- **Toribash**: turn-based control of joint states (relax, hold, contract, extend) ([Wikipedia](https://en.wikipedia.org/wiki/Toribash)). That is structurally a per-joint *choice* question and a natural "Jev-native" mode; it now has only about 48 concurrent Steam players ([tracker.gg](https://tracker.gg/population/steam/248570)).
- **Half Sword** (UE5 active ragdoll): about 10k demo videos uploaded, 400k+ wishlists, 20k+ concurrent players at early-access launch, then *mixed* reviews over the gap between demo and release and poor optimization ([Wikipedia](https://en.wikipedia.org/wiki/Half_Sword)). It is both proof of demand and a warning.
- Gladiabots (program your squad's AI, then watch it fight; 87% of 849 reviews positive, [Steam](https://store.steampowered.com/app/871930/GLADIABOTS__AI_Combat_Arena/)).

**AI-vs-AI spectator formats:**
- SaltyBet: 24/7 AI MUGEN fights with free fake-money betting ([Fandom](https://mugen.fandom.com/wiki/SaltyBet)).
- LLM Colosseum (2024).
- Kaggle Game Arena: chess with Nakamura, GothamChess and Carlsen commentating in 2025, then poker and Werewolf in 2026 ([Google](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/kaggle-game-arena-updates/)).
- OpenRouter "Royale": 11 LLMs over 30 games, June 2026. Grok 4.1 Fast won 43%, and benchmarks did not predict winners ([OpenRouter](https://openrouter.ai/blog/insights/royale-last-agent-standing/)).
- AI Arena (ArenaX): imitation-trained fighters sold as NFTs, a $6M raise ([GamesBeat](https://gamesbeat.com/arenax-labs-raises-6m-to-develop-ai-powered-games/)).
- Bring-your-own-bot contests: Battlecode, Halite, Lux.

**Research:** RoboStriker (Jan 2026, updated Aug 2026). G1 with 29 degrees of freedom, Isaac Lab with 4,096 parallel environments, a **32-dimensional latent "strategy" at 50 Hz over a 200 Hz PD tracker**, a 100% win rate against a raw-action baseline, and a sim-to-real transfer claim ([HF](https://huggingface.co/papers/2601.22517), [arXiv](https://arxiv.org/abs/2608.16195)). This is the proven stack Jev should sit *above*. At vendor-claimed 70–500 ms, Jev is a 2–10 Hz corner coach choosing from learned skills, not a joint controller.

**What this would be first at:** I found nothing combining user-built physics robots, an autonomous mind whose calibrated choice distribution viewers can see, and deterministic shareable replays. In one line: **"the first robot fight league where you can watch the robot think."** I can only say I found nothing; I cannot prove absence.

---

## (e) Opportunity, economics, risks

**Ranked by payoff over effort:**
1. **An X content engine.** Offline sims rendered into clips; Chris's marketing-engine PoC already exists.
2. **A browser toy:** pick parts, write a fight plan, share a fight link. It reuses the three.js and Mini Moto skills, and clients render replays, so there is no GPU server cost.
3. **A league.** Visitors submit a build plus a fight plan: the state framing, option menu and criteria Jev sees. Weekly cards run autonomously. This reuses the "seat your own model" mechanic from Chris's Out of Distribution league, and a "closed Jev vs open Jev-Omni" card is timely catnip.
4. **Steam**, only after 1–3 show pull, and knowing REK Sim is free there.

**Jev cost and throughput [calc on vendor numbers].** Jev charges $0.042 per million input tokens, output is free, rate limits are 1,200 requests/min and 250k tokens/s, and a request can be up to 64k tokens ([models](https://docs.typesafe.ai/models)) [vendor].
- Assume 2 fighters × 4 decisions/s × 180 s = 1,440 calls, at about 2k tokens each ≈ 2.9M tokens ≈ **$0.12 per fight**. Money is not the constraint.
- **The rate limit is.** A live fight needs about 8 requests/s, so one key supports about 2 concurrent live fights, or about 5 if both fighters are packed into one call.
- In chess-clock mode, throughput is about 50 fights per hour per key.
- **Speculative fan-out** (the models docs mention packing many questions into one request): ask "if the opponent does X / Y / Z, what do I do?" in one call. The local 50 Hz layer then executes that contingency table between calls, which hides latency.

**Risks:**
- **Gambling adjacency (serious).** Real-money bets on simulated outcomes are "virtual sports." The UK Gambling Commission regulates them by their underlying random-number engine, i.e. as casino games ([UKGC RTS 7](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-7-generation-of-random-outcomes)).
  - In the US, California's AB 831 banned dual-currency sweepstakes from Jan 1, 2026.
  - New York's SB 5935 even reaches service providers and media affiliates.
  - At least 13 states restricted such games by June 2026 ([Venable](https://www.venable.com/insights/publications/2026/05/states-escalate-crackdown-on-sweepstakes-casinos)).
  - Chris also controls the seeds, so real-money markets would have integrity problems too.
  - **Rule:** SaltyBet-style free currency only. No purchase, no redemption, no prediction-market tie-ins.
- **Intellectual property:** see (a). Avoid Octagon, UFC, Real Steel and BattleBots names, and exact vendor robot likenesses.
- **Reputation:** URKL's decapitation was covered as "killer robots" ([Common Dreams](https://www.commondreams.org/news/humanoid-robot-fights)). Keep it a sport between machines, and no human targets.
- **Technical (biggest):** "user-built bodies" works against "learned balance." Every new body needs a controller that generalizes, which is a real ML project (see the RoboStriker pipeline). Mitigations: start with wheeled and tracked machines and simple arms, and let humanoids come from a small set of parts families.
- **Hosting:** trivial if clients render. Pixel Streaming costs $0.13–0.53 per user-hour and is the trap to avoid.

---

## What makes a 15-second clip go viral
Evidence: short physical-consequence moments travel. The URKL head kick-off and REK's influencer getting kicked were both viral ([Ubergizmo](https://www.ubergizmo.com/2026/07/damaged-humanoid-robot-continues-fighting-in-viral-clip/), [ynet](https://www.ynetnews.com/tech-and-digital/article/bjtogbeqmg)). Half Sword's demo spawned about 10k videos. Storyboard:
- **0.0–1.5 s:** open mid-exchange on the wide hard-cam. No intro. Both robots, cage and lights in frame.
- **1.5–4 s:** **the mind flips.** The HUD bar for Red jumps from "JAB 64%" to "FEINT→LOW KICK 71%". This is the new thing nobody else can show.
- **4–6 s:** the payoff in real time: a part detaches with sparks, a fluid spurt, and the fence bows.
- **6–11 s:** a path-traced super-slow-motion re-sim of the same impact from a second angle, with modal metal crunch and servo scream.
- **11–15 s:** the loser's win-probability line crashes; one commentator line; hard cut on a loopable frame; caption, e.g. "Two AIs. One cage. Each can only *choose*." The reply contains the replay link, which lets viewers orbit the camera in their browser and proves it is not AI video.
- Also: surprise builds (a hammer tripod beating a humanoid), and native 9:16 from the same replay.

## Recommendation (proof-of-concept first)
- **Weeks 1–2:**
  - Two fixed robots, no builder, in an own-brand cage at the Class G/H scales above.
  - Rapier or whatever the engine stream picks, as long as it is deterministic.
  - Jev choosing from about 12 tactics at 2–4 Hz above scripted or RL skills, in chess-clock mode.
  - Fight-file replays, the prescient director, and the mind HUD.
  - Offline path-traced export and 5 X clips.
- **Kill or continue:** continue if the clips beat Chris's engagement baseline and people comment on the *mind panel*. Kill if the only reaction is "cool render."
- **After that:** add the parts builder and shareable fight links, then the league.
- **Skip:** Unity HDRP. Use UE5 only for a later Steam version.

## Open questions
- Do TypeSafe's terms allow using Jev in a public game or league, and displaying its probability outputs on screen? Can the 1,200 requests/min limit be raised for event nights?
- What is Jev's real round-trip latency from Philadelphia? The 70–500 ms figure is the vendor's and does not appear in the docs.
- Is URKL actually autonomous or teleoperated? Sources conflict (RoboSports Global says fully autonomous; Global Times and others don't say).
- Will REK Sim add robot building or AI-controlled modes after launch? That would close the gap this idea exploits.
- Can one learned balance/skill controller generalize across user-built bodies, or do parts have to come from a few pre-trained families? This is the biggest technical unknown and belongs to the physics/controls stream.
- What CPU does a headless deterministic fight need at the required physics rate (200 Hz–1 kHz, articulated humanoids)? This needs a benchmark before any league hosting plan.
- Does an 8- or 10-sided cage in a robot fighting show infringe Zuffa's trade dress? A one-hour trademark attorney review would settle it.
- What are the UFC's chain-link mesh gauge, diamond size and post-padding thickness? Not publicly verifiable; treat as art direction.