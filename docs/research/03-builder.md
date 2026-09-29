# Modular robot builder: prior art, data model, UX

**Headline:** A build-your-own robot fighter is feasible if the builder works like a compiler: a typed part graph turns into a MuJoCo model that the fight sim, the live validator and Jev all read from. The risk is putting freedom in the wrong place. Free-form weapons and upper bodies on a base that stands up by itself can ship. Free-form legs that also fight well are still a research problem, so legs should be pre-tested modules that come with their own controllers.

**Recommendation:** 1. **Compile target.** Build the robot builder as a part-graph compiler that outputs MJCF text for the official `@mujoco/mujoco` WASM build (3.14.0), rendered with three.js. Generate XML rather than relying on mjSpec in the browser.
   - Merge every group of non-breakable bolted parts into one body. This prevents KSP-style wobble.
   - Split each actuator part into a stator on the parent body and a rotor on a child body with a hinge or slide joint.
   - Close loops with `equality/connect` or `equality/weld`.
   - Model detachable parts as free-joint bodies held by a weld. Switch the weld off through `eq_active` when its constraint force exceeds the fastener rating. Cap these at about 8 per robot.
   - Use real motor models: MuJoCo's `dcmotor` with its thermal model gives motor fatigue for free.
2. **Scope v1 to bases that stand up by themselves.** Ship wheeled or tracked brawlers and four-wheel-leg hybrids with free-form arms, weapons and armor.
   - Treat legs as certified modules with bundled controllers (the Armored Core VI model), not free-form parts. Add pretrained quadruped modules in v2.
   - Keep free-form bipeds as an exhibition class with a 100% walker weight bonus (the BattleBots rule), plus an optional cloud "train my walker" job.
3. **Live validation on every edit:**
   - Hard budgets for weight class, power and complexity. Complexity means a cap of about 24 control channels.
   - Center of mass shown against the support polygon.
   - Per-joint torque-use heatmap from `mj_inverse`.
   - BattleBots-derived certification tests: lift a test weight, flip it, self-right.
   - A 3–5 s headless shakedown that produces a shareable stats card.
   - Borrow real balance rules: spinning weapons capped at 80 lb, tip speed capped at 370 ft/s. The tip cap also keeps the sim stable.
4. **Hand Jev a control manifest.** Each channel gets a semantic name and discrete Toribash-style modes (hold, relax, extend, contract), and becomes one "choice" question. Add precomputed features such as auto-generated weapon "smart zones", stability margin, motor temperatures and part hitpoints. A 500 Hz inner control loop turns modes into joint targets.
5. **UX.**
   - Typed sockets that glow only when compatible, with mirror mode on by default.
   - One key to spar against a dummy.
   - X-ray views of joints, wiring, center of mass and load.
   - Archetype kits with auto-fix suggestions for casual players.
   - Numeric editing, gear ratios, motor settings and MJCF export for engineers.
6. **Proof of concept first.** Following Spore's precedent, the first thing to test is the creator plus shakedown plus shareable stats card, then Jev fights between wheeled brawlers. Before committing, benchmark two ~30-body robots running together in MuJoCo WASM.

# Stream: the "build your own robot from interchangeable parts" system

## 0. Bottom line

Treat the builder as a compiler. The player edits a graph of typed parts. A compiler turns that graph into an MJCF model plus a "control manifest". MuJoCo then serves as the fight sim, the validator and the source of Jev's state. Give players freedom in weapons, arms, armor and bases that stand up by themselves (wheeled, tracked, four-wheel-leg). Treat legs as certified modules with bundled controllers, the way Armored Core VI treats legs as one archetype choice. Free-form legs that fight well are research-grade.

## 1. Prior art: what worked, what failed

These Steam figures come from Steam's public review and current-player APIs, pulled on 2026-09-29 around 00:10 ET. Player counts at midnight run below peak. [indep]

| Game | Reviews (% positive) | Players online now |
|---|---|---|
| Kerbal Space Program | 147,360 (96%) | 2,318 |
| Scrap Mechanic | 123,020 (92%) | 1,552 |
| Trailmakers | 39,562 (92%) | 1,194 |
| Stormworks | 60,185 (91%) | 855 |
| Besiege | 53,309 (95%) | 197 |
| Clone Drone in the Danger Zone | 39,636 (96%) | 152 |
| Armored Core VI | 86,137 (92%) | n/a |
| Toribash | 16,833 (88%) | 54 |
| GearBlocks | 802 (91%) | 23 |
| Robot Rumble 2 | 297 (80%) | 22 |
| Kerbal Space Program 2 | 32,034 (26%) | 17 |
| RoboCo | 220 (88%) | 2 |
| Main Assembly | 1,354 (83%) | 1 |
| Robot Arena III | 326 (28%) | 0 |

**The pattern.** Sandbox builders with a purpose and workshop sharing are big. Scrap Mechanic claims 3M+ copies sold [vendor] (https://en.wikipedia.org/wiki/Scrap_Mechanic). Trailmakers claims 5M players and 550k Workshop creations [vendor] (https://pressreleases.triplepointpr.com/2025/02/20/flashbulb-games-announces-trailmakers-pioneers-a-massive-creative-gameplay-content-update-coming-march-6-2025/). Besiege is estimated at about 1.6M copies [indep estimate] (https://app.sensortower.com/vgi/game/besiege). Deep builders made specifically for robot combat have stayed small. The engineering audience is niche, so the casual-fast versus engineer-deep split is load-bearing.

**Robot Arena 2** (2003, Gabriel Entertainment, Havok physics) still has an active modding scene in 2025 (https://en.wikipedia.org/wiki/Robot_Arena_2:_Design_and_Destroy). Two things kept it alive:
- **Parts are data files.** A TXT file holds parameters like mass, hitpoints and material. A GMF model holds attachment points typed Base, Axle or Generic, each Male or Female [indep] (https://beetlebros.gametechmods.com/modding.htm).
- **The community wrote the AI.** The stock AI was considered garbage, so modders wrote per-bot Python AI (https://tvtropes.org/pmwiki/pmwiki.php/YMMV/RobotArena). Each `Bindings.py` entry gives the bot's tactic class (Omni, Spinner, Pusher and others), its heading in radians ('nose') and its weapon IDs. Players also place invisible 2 kg "smartzones" that fire the weapon when the enemy enters (https://wiki.gametechmods.com/How_to_AI_your_bot; https://github.com/apanx/RA2_AI).

That is exactly the job Jev would do. The compiler should generate the heading, weapon IDs and smart zones automatically.

**Robot Arena III** (2016) has 28% positive reviews. Players complained about clunky building, broken AI, no weight classes, glitchy online play, and bots that can't be edited after Workshop upload (https://tvtropes.org/pmwiki/pmwiki.php/YMMV/RobotArena).

**Robocraft**
- It capped each garage bay at a CPU budget of 750, upgradable to 2,000. This is a complexity budget, not a weight budget (https://robocraftgame.com/devblog/agility-and-cpu-progression-system/).
- A build-restriction update was reversed after player backlash, and crate-based monetization soured the community.
- Robocraft 2 entered Early Access on 2023-11-07 and was delisted on 2024-02-02 over "lack of content, slow combat". Freejam closed on 2025-01-20 (https://en.wikipedia.org/wiki/Robocraft; https://www.gamedeveloper.com/business/robocraft-2-developer-freejam-shuts-down).

**KSP versus KSP2.** KSP2 rockets "wobbled even if excessive struts were used". It cost an estimated $50–60M against $26M revenue, and the studio closed in May 2024 (https://en.wikipedia.org/wiki/Kerbal_Space_Program_2). Lesson: never simulate a "rigid" bolted assembly as a chain of soft joints.

**Besiege** has two building tools worth copying:
- Advanced Building lets players move, rotate and scale parts off-grid.
- The Symmetry tool mirrors placing, editing and deleting, and mirrored selections move in mirror image (https://besiege-archive.fandom.com/wiki/Advanced_Building; https://besiege.fandom.com/wiki/Category:User_Interface).

**Scrap Mechanic** left Early Access on 2026-07-24 [indep, Steam]. Community guides report:
- Bearings and pistons bend under load.
- Extra bearings cut frame rate (https://steamcommunity.com/sharedfiles/filedetails/?id=1256443934).
- The Lift freezes bearings while you build, which gives a one-key switch between building and testing (https://scrapmechanic.org/wiki/parts/bearing).

The joint count is a performance budget.

**Trailmakers** builder overlays:
- A Forces overlay shows the centers of mass, thrust, lift, drag and downforce.
- Mirror mode also mirrors decals, colors and block settings (https://trailmakers.wiki.gg/wiki/Building_Tools).

**Games with programmable robot "brains"**
- Stormworks uses Lua microcontrollers (https://en.wikipedia.org/wiki/Stormworks:_Build_and_Rescue).
- RoboCo uses Python scripting, is NSF SBIR-backed, and reached 1.0 on 2026-02-06 (https://store.steampowered.com/app/1067220/RoboCo/).
- Main Assembly uses visual programming (https://www.gamereactor.eu/main-assembly-review/).

All of these are niche.

**GearBlocks** has 200+ parts and gear physics that transfers motion without slipping, including differentials (https://www.gearblocksgame.com/). It shows the depth engineers want, at a small scale.

**Robot Rumble 2** (free-to-play, 2024) is the closest competitor. It simulates motors, speed controllers and batteries, plus pneumatic flippers and gearing (https://store.steampowered.com/app/884180/Robot_Rumble_2/). It has 297 reviews. PitBots, which has a deformable chassis, is still "Coming soon" (https://store.steampowered.com/app/1474060/PitBots/).

**Clone Drone** (1.0 in 2021) is a voxel game where robot limbs get cut off, and players can't build their own robots (https://en.wikipedia.org/wiki/Clone_Drone_in_the_Danger_Zone). It shows that readable dismemberment sells.

**Armored Core VI** assembly uses hard budgets: leg load limit, arm load, EN output and attitude stability (resistance to stagger). An overburdened build can't launch. Legs are one archetype choice: biped, reverse-joint, tetrapod or tank (https://armoredcore.fandom.com/wiki/ARMORED_CORE_VI_FIRES_OF_RUBICON/Parts/Legs; https://www.ggrecon.com/guides/armored-core-6-overburdened-weight-limit-how-to-fix/).

**Toribash**
- Each fighter has 21 body parts and 20 joints plus 2 hand grips, so 22 controllables with 4 states each: hold, relax, extend or contract (source: `constants.py` in https://github.com/Miffyli/ToriLLE).
- Play is turn-based and includes dismemberment. ToriLLE exposes it as a Gym MultiDiscrete action space, and the paper found a frame-skip of about 100 ms worked best (https://arxiv.org/abs/1807.10110).

A Toribash turn maps one-to-one onto 22 Jev "choice" questions with 4 options each. That fits inside the 64-questions-per-call limit of Chris's Jev client.

**Spore Creature Creator** shipped as a standalone creator before the game. Players uploaded 1M creatures by about a week after release, and 3M+ by the full game's launch (https://en.wikipedia.org/wiki/Spore_Creature_Creator). Spore animated arbitrary bodies with morphology-independent semantic data, limb classification and IK, with no physics (https://www.chrishecker.com/Real-time_Motion_Retargeting_to_Highly_Varied_User-Created_Morphologies).

**Karl Sims (1994)** (http://www.karlsims.com/papers/siggraph94.pdf; https://www.karlsims.com/evolved-virtual-creatures.html):
- The genotype is a directed graph.
- Each node holds dimensions, a joint type (rigid, revolute, twist, universal, bend-twist, twist-bend or spherical), joint limits and a recursive limit.
- Each connection holds position, orientation, scale and a *reflection* flag that describes mirrored subtrees.
- Dynamics use Featherstone's O(N) method.
- Two co-evolving populations competed one-on-one for control of a green cube.

## 2. Data model: from part graph to simulator

**Compile target: MuJoCo.** The official WASM bindings are `@mujoco/mujoco` 3.14.0, released 2026-09-22 [indep, npm registry + GitHub release]. `MjModel.from_xml_string` works in the browser. The mjSpec editing API is bound but, per the README, "untested in real web applications" (https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md). The robust path is to generate MJCF XML text.

MuJoCo already has the pieces the builder needs:
- **Closed loops.** `equality/connect` is "a ball joint outside the kinematic tree", and `equality/weld` welds two bodies (https://mujoco.readthedocs.io/en/stable/XMLreference.html).
- **Inertia from geometry.** `compiler/inertiafromgeom` defaults to auto. Mesh `inertia` can be `convex`, `exact` (needs a watertight mesh), `shell` (mass on the surface, which suits sheet-metal armor) or `legacy`. `legacy` is the default and overcounts volume for non-convex meshes, so set `convex` (same page).
- **Real motors.** The `dcmotor` actuator was added in 3.7.0 (2026-04-14). It models resistance, motor constant, inductance, cogging, LuGre friction and a winding-temperature state, and was reworked in 3.12.0 (https://mujoco.readthedocs.io/en/stable/changelog.html; https://github.com/google-deepmind/mujoco/releases/tag/3.12.0). Motor overheating gives you fatigue for free.
- **Cylinders.** `cylinder` models pneumatic or hydraulic cylinders. `adhesion` could model magnet or grip parts.
- **Utilities.** `mj_inverse` (inverse dynamics), `mjd_transitionFD` (finite-difference linearization, with an LQR notebook in the repo) and `mj_recompile`, which recompiles "preserving the state" (https://mujoco.readthedocs.io/en/stable/programming/modeledit.html).

**Alternatives**
- **Unity articulations** allow only one root, "not allowed to have kinematic loops", with a maximum depth of 64 (https://docs.unity3d.com/Manual/physics-articulations.html).
- **Rapier JS** (0.21.0) offers multibody (reduced-coordinate) and impulse joints, and you can break a joint by reading its force (https://rapier.rs/docs/user_guides/javascript/joints/).
- **Jolt WASM** (1.1.0) has constraint motors and breakable constraints via impulse limits (https://jrouwe.github.io/JoltPhysics/).

All three are fine game engines. None ships inverse dynamics, linearization or a DC motor model, so you would build those yourself.

**Compile pipeline**
1. **Check the graph.** Socket kinds and genders must be compatible. There is one core part, the graph is connected, and no socket is used twice.
2. **Merge rigid parts.** Build a spanning tree from the core, rigid edges first. Every group of non-breakable bolted or welded parts becomes one body. This is the fix for KSP-style wobble, and it cuts body count. MuJoCo's `fusestatic` works the same way.
3. **Split actuators.** An actuator part's stator geoms join the parent body. Its rotor starts a child body with a hinge or slide joint at the socket frame.
4. **Close loops.** Edges not in the tree become `connect` (pins) or `weld` (rigid), plus `contact/exclude` for the bodies involved. Four-bar linkages like Ascento's are supported (https://arxiv.org/pdf/2005.11431).
5. **Breakable joints.**
   - The detachable part becomes a top-level body with a free joint. MuJoCo only allows free joints "in bodies that are children of the world body".
   - A `weld` holds it on.
   - Each tick, read that weld's constraint force. When it exceeds the fastener rating, set `eq_active = 0` (https://github.com/google-deepmind/mujoco/discussions/2323).
   - Cap breakables at about 8 per robot. Each weld adds 6 constraint rows.
6. **Mass.** Geom density comes from the material: steel about 7,850 kg/m³, aluminum about 2,700, titanium about 4,430. Use `shell` inertia for armor skins. Parts that are mostly electronics, like batteries and motors, get explicit catalog masses.
7. **Collision shapes.**
   - Author primitive shapes (box, capsule, cylinder) per part.
   - Run CoACD offline for everything else. Its authors report fewer, more faithful convex pieces than V-HACD [vendor-academic] (https://arxiv.org/pdf/2205.02961). A third-party comparison cites 4–24 versus 10–64 hulls [unverified] (https://rigyd.com/compare/v-hacd-vs-coacd-vs-manual-hulls).
   - MuJoCo collides meshes as convex hulls anyway.
   - For player-drawn chassis plates (RA2 and PitBots style), extrude a 2D polygon, split it into convex pieces, and use them as prisms. No runtime decomposition needed.
8. **Collision filtering for 1v1.**
   - Robot A: contype=1, conaffinity=2.
   - Robot B: contype=2, conaffinity=1.
   - Arena: 3/3.
   - Result: robots hit each other and the arena but not themselves. Add explicit `pair` entries if a limb must hit its own torso. Parent-child filtering is on by default (`filterparent`).
9. **Symmetry.**
   - A mirror link reflects the frame (Sims' reflection flag).
   - Chiral parts swap to their `mirrorVariant`.
   - Hinge axes flip, and the channel sign flips so "extend" means the same on both sides. Jev must never see sign conventions.
10. **Fasteners.** Each socket carries a force and torque rating. KSP part.cfg files carry `breakingForce` and `breakingTorque` the same way (https://wiki.kerbalspaceprogram.com/wiki/CFG_File_Documentation/ko).

## 3. Live validation and feedback

Run the checks on every edit, debounced. Show them the way Poly Bridge's stress view does, with parts shaded by load (https://www.gameskinny.com/tips/poly-bridge-beginner-guide-with-tips-and-tricks/).

**Budgets**
- **Weight class.** Enforce a hard limit, like AC6's "can't launch". Real rules to borrow from BattleBots:
  - 250.0 lb heavyweight limit.
  - Walkers get 500.0 lb, a 100% bonus.
  - Spinning weapon bars, discs and drums max 80 lb.
  - Whole-body spinning shells max 120 lb.
  - External parts max 370 ft/s tip speed.
  - A lifter must lift 250 lb to 12 in, and a flipper must throw 250 lb more than 2 ft.
  - Motion and weapon voltage max 60 V.

  Source: https://battlebots.com/wp-content/uploads/2019/12/BattleBots-Design-Rules-Rev.2020.0.pdf. The tip-speed cap also protects the sim. At a 2 ms timestep, a 113 m/s tip moves about 23 cm per step, which risks passing straight through contacts [engineering estimate]. Cap game spinners lower, or resolve spinner hits analytically.
- **Power.** Battery Wh and maximum current against the sum of actuator stall current times duty cycle, at 60 V maximum. Robot Rumble 2 already simulates motors, speed controllers and batteries.
- **Complexity.** Cap degrees of freedom and bodies, Robocraft-CPU style. Also cap control channels at about 24 so one Jev call covers every channel and leaves about 40 questions for tactics.

**Physical checks**
- **Center of mass versus support polygon.** Run `mj_forward` on the settled pose. Take the convex hull of the ground contacts, project `subtree_com` of the root onto the floor, and show the stability margin as a colored disk (KSP's COM sphere and Trailmakers' Forces overlay).
- **Can the actuators hold this?** Set the resting pose with zero acceleration and run `mj_inverse`. Compare `qfrc_inverse` per joint against actuator limits, and show % use per joint. For scale, the Unitree G1 model in MuJoCo Menagerie uses 88 N·m (hip pitch), 139 N·m (knee) and 25 N·m (shoulder and elbow) (https://github.com/google-deepmind/mujoco_menagerie/blob/main/unitree_g1/g1.xml). Those are good tier anchors for actuator parts.
- **Certification tests.** Automated BattleBots-style trials:
  - The lifter raises a test weight 30 cm.
  - The flipper throws it.
  - The robot self-rights from its back.

**Shakedown sim**, 3–5 s headless:
- Drop from 5 cm and settle, with no NaN, instability warnings or deep penetration.
- Sweep each channel and confirm it moves without self-locking.
- Drive 1 m.
- Apply a lateral push and record the tipping impulse.
- Heat each motor at stall until its thermal limit.

The outputs become the robot's **stats card**: mass, top speed, push force, reach, weapon energy (½Iω² for spinners), tip-over impulse and endurance. The card is also static state for Jev.

## 4. Body archetypes: how hard each one is

**Ship first**
- **Wheeled or tracked brawler with actuated weapons** (hammer, flipper, lifter, crusher, capped spinner, clamp arms).
  - It never has to balance, so control is differential drive plus discrete channels, and Jev at 2–5 Hz handles tactics well.
  - Simulating tracks link by link is expensive. Use hidden wheels under animated treads [engineering judgment].
- **Four-wheel-leg hybrid** (Unitree B2-W style). It stands on four wheels on its own, and the legs work as stance or suspension, or strike as weapons. The B2-W is 75 kg, rolls at 20 km/h, and has 360 N·m leg joints and 50 N·m wheels [vendor] (https://www.robotshop.com/products/unitree-b2-w-wheeled-robotic-dog).

**Second wave**
- **Two-wheel balancer** (Ascento: 10.4 kg, LQR balance, 0.4 m jumps) (https://arxiv.org/pdf/2005.11435). For player-built variants, linearize with `mjd_transitionFD` and solve for LQR gains at compile time. Plausible, but the automatic LQR step is unproven [my inference].
- **Quadruped built from certified leg modules**, each with a pretrained policy:
  - MuJoCo Playground trains quadruped policies "in minutes on a single GPU" [vendor/DeepMind] (https://playground.mujoco.org/).
  - A 2026 adaptation module picks up embodiment changes "within half a second". On a real Go2 it kept walking with a fully locked leg plus 5 kg [indep-academic] (https://arxiv.org/abs/2608.01506). That covers limbs damaged mid-fight.
- **Tail or snake appendages**: scripted wave or weapon limbs, simple to make.

**Research-grade: free-form bipeds, or any legs the player invents, fighting well**
- The first humanoid boxing tournament (Unitree G1, Hangzhou, May 2025) was **teleoperated** (https://www.robotics247.com/article/video_unitree_g1_humanoids_compete_in_robot_combat_tournament_in_china).
- Bansal et al.'s sumo humanoids learned stance and headbutts only through large-scale self-play (https://arxiv.org/pdf/1710.03748).
- General policies that work across bodies now exist:
  - URMA covers 16 embodiments (https://arxiv.org/pdf/2409.06366).
  - Embodiment Scaling Laws trained on about 1,000 procedurally generated bodies and transferred zero-shot to Go2 and H1 (https://arxiv.org/abs/2505.05753).

  That work covers locomotion, not combat. If you offer free-form legs, make them an exhibition class with the BattleBots walker bonus and an optional cloud "train my walker" job.

## 5. UX: fast for casual players, deep for engineers

- **Snapping.** While a part is dragged, only compatible sockets glow (RA2 male/female typing, KSP nodes). It snaps within a radius and rotates in clock steps around the socket normal.
- **Mirror on by default**, mirroring paint, decals and settings (Trailmakers). A symmetric-edit mode (Besiege). Radial ×2–×8 for spinners (KSP's 1–8 symmetry) (https://wiki.kerbalspaceprogram.com/wiki/Center_of_mass).
- **Gizmos off-grid** only in an Advanced mode (Besiege).
- **X-ray modes:**
  - Joint axes and range arcs.
  - Power and wiring bus.
  - COM and support polygon.
  - Torque-use heatmap.
  - Auto-generated weapon smart zones.
  - Fastener ratings.
- **One key to spar.** A Lift-style toggle drops the robot into the arena against a practice dummy, with the build state kept.
- **Casual path:**
  - Start from archetype kits.
  - Auto-fixes ("left arm is 140% over torque: swap to Servo-L or shorten 10 cm"; "move the battery 8 cm back to regain stability").
  - A shareable stats card. The Spore lesson: the creator alone can be the first product.
- **Deep path:**
  - Numeric edits.
  - Gear ratios (GearBlocks).
  - Editable motor parameters.
  - A text "fight doctrine" passed to Jev as state.
  - Export to MJCF. Robotics people can open their bot in MuJoCo, which gives the project credibility.

## 6. How the builder feeds Jev

The compiler produces a **control manifest**. Each channel has a semantic name ("hammer", "arm_L.shoulder", "drive") and discrete Toribash-style modes, and each channel becomes one `choice` question. Jev allows up to 255 options per choice and up to 10 score levels [vendor] (https://docs.typesafe.ai/api).

The compiler also produces **precomputed features**, so Jev never reasons over raw geometry:
- Is the enemy in the hammer zone?
- Stability margin.
- Motor temperatures and part hitpoints.

A 500 Hz inner loop turns modes into PD targets:
- hold = PD to the current angle
- relax = zero torque
- extend or contract = drive toward the joint limit

Jev picks modes at the rate its latency allows: 70–500 ms [vendor].

## 7. Draft part and socket schema (v0.1)

```ts
type Vec3=[number,number,number]; type Quat=[number,number,number,number]; // w,x,y,z (MuJoCo order)
type Frame={pos:Vec3; quat:Quat};                       // +Z = mating normal, +X = clocking ref
type SocketKind='struct.plate'|'struct.tube'|'axle.out'|'axle.in'|'wheel.hub'|'weapon.mount'|'leg.hip'|'power';
interface SocketDef{ id:string; kind:SocketKind; gender:'M'|'F'|'N'; size:'S'|'M'|'L';
  frame:Frame; clockSteps:4|8|24; rating:{forceN:number; torqueNm:number}; }
type MaterialId='steel_4130'|'al_6061'|'ti_6al4v'|'uhmw'|'ar500';
interface CollisionProxy{ kind:'box'|'capsule'|'cylinder'|'sphere'|'hull'; size?:number[]; hull?:string; frame:Frame; }
type Mode='hold'|'relax'|'extend'|'contract'|'fwd'|'rev'|'stop'|'spin_up'|'spin_down'|'fire'|'retract'|'grip'|'release';
interface ActuatorDef{
  joint:{type:'hinge'|'slide'; axis:Vec3; range:[number,number]; damping:number; armature:number; frictionloss:number};
  motor:{kind:'dc'|'pneumatic'|'servo'; stallTorqueNm:number; noLoadRadS:number; gear:number; volts:number;
         thermal?:{timeConstS:number; maxC:number}};          // -> <dcmotor>/<cylinder>/<position>
  electrical:{stallA:number; idleA:number};
  channel:{modes:Mode[]; defaultName:string}; }
interface PartDef{ id:string; version:number;
  category:'core'|'chassis'|'armor'|'actuator'|'link'|'wheel'|'leg_module'|'weapon'|'battery'|'sensor'|'adapter';
  visual:string /*glTF*/; material:MaterialId; massKg?:number; inertia:'convex'|'shell'|'exact';
  collision:CollisionProxy[]; sockets:SocketDef[]; actuator?:ActuatorDef;
  battery?:{wh:number; maxA:number; volts:number}; hp:number; mirrorVariant?:string;
  controller?:{policyId:string; obsSpec:string}; }         // certified leg modules only
interface PartInstance{ uid:string; partId:string; partVersion:number; label?:string;
  role?:'weapon'|'shield'|'flipper'|'drive'|'arm'|'leg'|'sensor'; paint?:string; decals?:string[]; }
interface Connection{ a:{uid:string; socket:string}; b:{uid:string; socket:string}; clock:number;
  fastener:'bolt'|'weld'|'pin'|'bearing'|'magnet'; breakable:boolean; }  // breakable -> freejoint + <weld>
interface RobotBuild{ schema:'robobuild/0.1'; name:string; weightClass:'light'|'middle'|'heavy'|'walker';
  coreUid:string; parts:PartInstance[]; connections:Connection[];         // may contain cycles
  mirrors:{source:string; target:string; plane:'sagittal'}[];
  channels:{name:string; actuatorUids:string[]; sign:1|-1}[]; doctrine?:string; }
interface CompiledRobot{ mjcf:string;
  manifest:{name:string; actuatorIds:number[]; modes:Mode[]}[];
  breakables:{eqId:number; forceN:number; torqueNm:number}[];
  zones:{name:string; site:string; radiusM:number}[];                    // auto "smartzones"
  stats:{massKg:number; dof:number; bodies:number; peakA:number; wh:number; stabilityMarginM:number;
         torqueUse:Record<string,number>; tipImpulseNs:number; weaponJ?:number}; }
```

## 8. What I could not verify

- The session's web-search budget ran out partway through. Later checks used direct page fetches and raw documentation sources.
- **Not verified:**
  - Armored Core VI sales.
  - Toribash's physics engine.
  - How KSP connects parts internally. The KSP2 wobble lesson rests on Wikipedia's account.
  - The exact ratio in the CoACD versus V-HACD comparison.
  - How fast MuJoCo WASM runs 2 robots of about 30 bodies each at a 1–2 ms step with rendering. This needs a benchmark spike.
- **Needs testing:** whether mjSpec works in the browser (the README says untested) and whether results match across platforms for online play.

## Open questions
- Is this a spectator/coach game (Jev pilots, the player only engineers and sets strategy) or can humans also drive? The answer decides whether control channels must be human-drivable and how many are allowed.
- Target platform: browser (MuJoCo WASM with three.js) or a Steam desktop build (Electron with MuJoCo WASM, or native MuJoCo)? And does online play need identical results on every machine (not verified across platforms), or can a server run the sim?
- How fast is MuJoCo WASM with two robots of about 30 bodies each at a 1–2 ms timestep plus three.js rendering? This needs a one-day benchmark before committing.
- In v1, can players draw their own chassis plates (RA2/PitBots style, extruded and split into convex pieces), or are parts catalog-only?
- Is a Jev decision rate of 2–5 Hz, given the 70–500 ms latency the vendor claims, fast enough to feel like a fight? How much of the fighting should a scripted reflex layer handle below Jev?
- Damage model for v1: hitpoints plus detachable parts via weld equality constraints, or some form of deformation? Deformation is visual-only at best in a rigid-body sim.
- For certified leg modules: who trains the controllers (Claude Code plus MuJoCo Playground on a rented GPU?), and how much design freedom (length, mass) can a module allow before it needs retraining?
- Should the first proof of concept be the creator plus shakedown plus shareable stats card alone (the Spore Creature Creator precedent), before any Jev fights?