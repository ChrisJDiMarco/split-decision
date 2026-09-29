# Physics engine and platform selection

**Headline:** Build it on MuJoCo 3.14 running as the official WebAssembly build in a Web Worker, with three.js rendering interpolated poses, and train the fighting skills on the same robot model files with MuJoCo Warp/mjlab. It is the only option where the game engine and the RL training engine are the same physics, and it has the most realistic actuator models of anything that runs in a browser. Runner-up is Rapier. The honest limit: no real-time engine simulates metal impact physics (dents, fracture, spinner "bite"), so impacts and damage need a calibrated game-layer model on top of MuJoCo.

**Recommendation:** Choose MuJoCo 3.14.x, specifically the official @mujoco/mujoco single-threaded WASM build, running in a Web Worker at a fixed 1 ms step (2 ms fallback), using the implicitfast or discrete integrator, the Newton solver and elliptic cones. Render with three.js by interpolating the last two physics snapshots. Ship to Steam by wrapping the same pinned .wasm in Electron, so web and desktop players get identical physics.

- **Robot builder.** Compile the part graph to MJCF in TypeScript.
- **Actuators.** Model them with dcmotor (including the thermal model) or pid actuators, plus gear, armature and forcerange.
- **Detachable parts.** Make them top-level free bodies held by weld equalities that switch off through eq_active when the seam force passes a threshold.
- **Weapons.** Resolve spinner and hammer hits with an analytic impulse model, because MuJoCo has no rigid-body CCD.
- **Training.** Train low-level fighting skills offline on the same MJCF with mjlab or MuJoCo Playground on MuJoCo Warp, using self-play against an Elo pool. Export the policies to ONNX and run them in the worker with onnxruntime-web.
- **Jev.** Have Jev choose among a fixed skill menu at 2–10 Hz. Apply each decision after a fixed reaction delay, and log the decisions so replays and slow-mo are deterministic re-simulations at the same step size.
- **Robot shapes.** Start with wheeled/tracked BattleBots-style robots on scripted controllers, plus one legged template with trained skills. Postpone free-form legged morphologies.
- **Week-1 gates:** (1) two 30-body robots in a clinch hold 1 kHz in the worker; (2) replay hashes match across Chrome, Firefox and Safari on x64 and ARM; (3) contact and constraint forces can be read without leaks in the official package.
- **Fallback.** If gate 1 or 3 fails, move to Rapier's deterministic JS package with scripted moves only and no RL, which is the runner-up.

# Stream: which physics engine for articulated, motor-driven metal robots fighting in an octagon

## Bottom line

**Winner: MuJoCo 3.14.** Use DeepMind's official `@mujoco/mujoco` WebAssembly package in a Web Worker, render with three.js, and ship to Steam by wrapping it in Electron. Train the low-level fighting skills offline on the **same MJCF robot files** with MuJoCo Warp (via mjlab or MuJoCo Playground). Jev then chooses among those skills a few times per second.

**Runner-up: Rapier 0.36 / rapier.js 0.21.** Pick it if the robots will run scripted moves and you never plan to train RL controllers.

**Not suitable as the game runtime:** Isaac Sim/Lab, Newton, Genesis, Drake, Chrono, Bullet/ammo.js. Unreal Chaos and the Unity DOTS physics packages (Unity Physics, Havok) also miss on the criteria below; Unity's built-in PhysX articulations get their own row in the ranking.

## What "hyper-accurate" can and cannot mean

- **Can be highly accurate:** articulated dynamics, gear-reflected inertia, torque limits, friction, motor electrical behavior, and servo control loops. MuJoCo is the engine robotics labs use for sim-to-real transfer. For example, DeepMind's 1v1 soccer robots were "trained in simulation and transferred to real robots zero-shot" ([arXiv 2304.13653](https://arxiv.org/abs/2304.13653)) [indep, peer-reviewed].
- **Cannot be accurate in real time with any engine on this list:** a metal-on-metal hit, meaning plastic deformation, fracture, or the very short contact when a spinner tooth strikes.
  - Rigid-body engines reduce an impact to restitution and friction coefficients.
  - MuJoCo's contacts are deliberately soft. Its own docs say restitution is only approximate "because the contact itself is soft and takes several time steps" ([modeling: Restitution](https://mujoco.readthedocs.io/en/stable/modeling.html#restitution)).
- **So:** make the joints and actuators physically real, and treat impacts and damage as an energy-based game model that reads the solver's contact forces. Dents should be a render-side effect driven by damage events, not simulated physics.

## Ranking against the 9 criteria

| Rank | Engine / platform | Joints + stiff motors | Metal contacts / CCD | Actuator realism | Determinism | Breakable parts | ~1 kHz, 2 robots | RL in same engine | License / maturity | Fit (three.js, Steam) |
|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **MuJoCo 3.14 WASM + MJWarp** | Reduced coordinates, soft constraints, implicit/discrete integrators | Soft contacts, **no rigid-body CCD** | Best: dcmotor, pid, delays, armature | Same version + same architecture (a single WASM binary acts as one architecture) | `eq_active` weld toggling; topology fixed at compile time | Plausible, must benchmark | **Yes** (MJWarp / Playground / mjlab) | Apache-2.0, bindings WIP | Excellent |
| 2 | Rapier 0.36 (rapier.js 0.21) | JS: maximal-coordinate impulse joints only | Sweep CCD, force events | PD motors only | **Official cross-platform deterministic package** | Trivial (remove joint) | Fast (SIMD WASM) | No batched GPU training | Apache-2.0, very active | Excellent |
| 3 | Unity 6.x + PhysX ArticulationBody | Reduced coordinates (Featherstone), TGS | Mature | PD drives, friction, armature | Same platform at best | **Articulation joints unbreakable** | Native, fine | ML-Agents only (CPU) | Proprietary engine | C# rewrite |
| 4 | Jolt (JoltPhysics.js / Godot 4.6) | Maximal coordinates; ragdoll motors | LinearCast CCD | PD motors | Cross-platform with a build flag; Save/RestoreState | Break via lambda | Fast | No | MIT, very mature | Good |
| 5 | Newton 1.6 / Isaac Lab 3.0 | Excellent | Excellent | Actuator nets, DC-motor models | GPU, not a game runtime | n/a | n/a | Yes | Apache/BSD, NVIDIA GPU | Training tooling only |
| — | Genesis, Drake, Chrono, Bullet/ammo.js, Unreal Chaos, Unity Physics/Havok | See notes | | | | | | | | |

## Engine notes (verified as of 2026-09-29)

**MuJoCo 3.14.0 (2026-09-22).**
- **Web package.** The official `@mujoco/mujoco` npm package is versioned in lockstep with MuJoCo. It went from 0.0.0 on 2026-03-11 to 3.14.0 on 2026-09-22 (npm registry, [jsDelivr](https://www.jsdelivr.com/package/npm/@mujoco/mujoco)).
- **Two builds.** There is a single-threaded build and an `/mt` build that uses Web Workers and SharedArrayBuffer. The `/mt` build needs the COOP/COEP headers ([wasm README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)) [vendor].
- **Maturity caveats.** The README calls the bindings "still a WIP". Windows is "experimental", memory is managed by hand with `.delete()`, and the model-editing API (`mjspec.h` bindings) is "untested in real web applications" [vendor].
- **Community projects.** zalo's `mujoco_wasm` is now just a demo suite on top of the official bindings ([repo](https://github.com/zalo/mujoco_wasm)) [indep].
- **Actuator features added in 2026** ([changelog](https://mujoco.readthedocs.io/en/latest/changelog.html)) [vendor]:
  - Actuator and sensor **delays** through history buffers (3.5).
  - A **`dcmotor` actuator** (3.7) with inductance, cogging torque, **thermal resistance variation** and LuGre friction ([XML ref](https://mujoco.readthedocs.io/en/latest/XMLreference.html#actuator-dcmotor)).
  - Actuator **armature and damping** reflected through the gear ratio squared (3.7).
  - Multi-contact convex collision on by default (3.8).
  - A native **`pid` actuator** with anti-windup and a slew-rate limit (`slewmax`) (3.12).
  - A new **`discrete` integrator** (3.13). It makes "actuator position gains stable at timesteps far beyond the explicit stability limit", which is the classic failure of stiff servos.
  - Contact **adhesion**, usable for magnets, and **surface velocity** (3.11).
- **Backlash.** There is a documented pattern: a second hinge with a small range plus armature ([modeling: Backlash](https://mujoco.readthedocs.io/en/stable/modeling.html#backlash)).
- **Breakable seams.** `mjData.eq_active` switches equality constraints on and off at runtime ([simulation docs](https://mujoco.readthedocs.io/en/stable/programming/simulation.html)).
- **Seam forces are now correct.** 3.14 fixed weld torques in `mj_rnePostConstraint`, so force/torque sensors on welded bodies report correctly [vendor].

**Training on the same engine.**
- **MuJoCo Warp (v3.14.0).** Claims the same features as MuJoCo except the PGS/noslip solvers, plugin actuators/sensors and some flex features. It is float32 and "optimized for NVIDIA hardware" ([README](https://github.com/google-deepmind/mujoco_warp), [docs](https://mujoco.readthedocs.io/en/latest/mjwarp/)) [vendor].
- **MuJoCo Playground** now uses MuJoCo Warp as its default backend ([repo](https://github.com/google-deepmind/mujoco_playground)).
- **mjlab** (Apache-2.0) puts Isaac Lab's manager API on top of MuJoCo Warp ([repo](https://github.com/mujocolab/mjlab)).
- **Existence proof of the whole pipeline.** [wbc-mjlab/wbc-demo](https://github.com/wbc-mjlab/wbc-demo) runs mjlab-trained Unitree G1 whole-body policies in the browser. It uses `@mujoco/mujoco` with onnxruntime-web at 50 Hz, then PD torques, then physics substeps [indep].

**Rapier 0.36.0 (2026-09-24).**
- **Core advances, 2025–26** ([CHANGELOG](https://github.com/dimforge/rapier/blob/master/CHANGELOG.md)) [vendor]:
  - Sweep-based CCD, on by default against fixed colliders (0.35).
  - Contact force events with a "started" flag (0.35).
  - Quarantine of bodies that go NaN (0.35).
  - A pure-Rust MJCF loader (0.33).
  - Multibody armature, passive springs and DoF coupling (0.34).
  - Soft bodies with plasticity and tearing (0.36).
- **2026 goal.** Dimforge's stated 2026 top goal is robotics: a "more accurate constraint solver", with MuJoCo named as the inspiration ([blog](https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/)).
- **The catch I verified in source.** In the TypeScript bindings on master (npm 0.21.0), the motor methods of `UnitMultibodyJoint` are **commented out** ([multibody_joint.ts](https://github.com/dimforge/rapier/blob/master/bindings/typescript/src.ts/dynamics/multibody_joint.ts)) [indep, source code]. That covers revolute and prismatic joints; only spherical multibody joints have motors. From JavaScript, the realistic path for robots is maximal-coordinate impulse joints with PD motors.
- **Determinism.** The JS build is "fully cross-platform deterministic", but only if you avoid `Math.sin`/`Math.cos` in inputs ([determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)) [vendor].

**PhysX 5 / Unity.**
- PhysX articulations are reduced-coordinate and support drives, friction, armature and mimic joints. However, "articulation joints are not breakable like rigid-body joints" ([PhysX 5.6 docs](https://nvidia-omniverse.github.io/PhysX/physx/5.6.0/docs/Articulations.html)) [vendor].
- Unity articulations have a "maximum hierarchy depth of 64" ([Unity 6.6 manual](https://docs.unity3d.com/6000.6/Documentation/Manual/physics-articulations.html)) [vendor].
- NVIDIA open-sourced the PhysX GPU code under BSD-3 in April 2025 ([CG Channel](https://www.cgchannel.com/2025/04/nvidia-open-sources-physxs-gpu-simulation-code/)).
- I **could not confirm** whether Unity 6.6 ships PhysX 4.1 or 5.x.
- The official MuJoCo Unity plugin exists, but "adding and removing MuJoCo components causes complete scene recreation" ([docs](https://mujoco.readthedocs.io/en/latest/unity.html)). That is bad for a robot builder.
- Dark horse: `physx-js-webidl` 2.8.0 (2026-09-27) exposes PhysX 5's reduced-coordinate articulations to JavaScript ([repo](https://github.com/fabmax/physx-js-webidl)). It is maintained by one person.

**Jolt.**
- Deterministic on one platform when single-threaded. `JPH_CROSS_PLATFORM_DETERMINISTIC` extends that across platforms at a performance cost.
- `SaveState`/`RestoreState` support rollback. Motors have force and torque limits.
- Constraints can be broken by checking `GetTotalLambdaPosition`. `LinearCast` handles CCD.
- Defaults are 10 velocity / 2 position iterations at 60 Hz ([docs](https://jrouwe.github.io/JoltPhysics/)) [vendor].
- JoltPhysics.js 1.1.0 is MIT-licensed; cross-platform determinism is a build flag ([repo](https://github.com/jrouwe/JoltPhysics.js)).
- Godot 4.4 built Jolt in, and 4.6 made it the default for new 3D projects ([devclass](https://devclass.com/2025/03/05/godot-4-4-released-open-source-game-engine-adds-jolt-physics-net-8-and-more/), [AlternativeTo](https://alternativeto.net/news/2026/1/godot-4-6-debuts-modern-theme-jolt-physics-node-ids-and-libgodot-embed)).
- It uses maximal coordinates, so there is no reduced-coordinate advantage.

**The rest.**
- **Newton 1.6.0 (2026-09-10, Apache-2.0).** A Warp-based engine whose main backend is MuJoCo Warp ([repo](https://github.com/newton-physics/newton)). It is GPU training infrastructure, not a game runtime.
- **Isaac Lab / Isaac Sim.** Same category: training infrastructure. Isaac Lab 3.0.0-EA (2026-09-16) and Isaac Sim 6.1 are on GitHub.
- **Genesis.** Its speed claims were debunked as "up to 10x slower than existing GPU sims" on non-trivial scenes ([Stone Tao](https://stoneztao.substack.com/p/the-new-hyped-genesis-simulator-is)) [indep].
- **Drake** (v1.57.0). Accuracy-first hydroelastic contact, "slower than the point contact models" ([tutorial](https://drake.mit.edu/tutorials/hydroelastic_contact_basics.html)), and no web target.
- **Chrono** (10.0, BSD-3). Engineering multiphysics, not a game engine ([Wikipedia](https://en.wikipedia.org/wiki/Project_Chrono)).
- **Bullet/ammo.js.** Stale: last bullet3 release 3.25 in April 2022; ammo.js last on npm in 2016 ([releases](https://github.com/bulletphysics/bullet3/releases)).
- **Unreal Chaos.** Not deterministic across platforms, per forum reports ([UE forum](https://forums.unrealengine.com/t/ue5-fully-deterministic-physics-in-ue5-is-it-possible/513853)) [weak].
- **Unity Physics / Havok.** A DOTS stack; I found no reduced-coordinate articulations (unverified).

## Why MuJoCo wins for this idea

1. **No sim-to-sim gap.** The MJCF you compile from the robot builder is the same file you train on with MJWarp and the same file the browser steps. The only gap is float32 during training versus float64 in the WASM build. Handle it with domain randomization. Every other option has a gap: train in Isaac, run in Unity; or train in MuJoCo, run in Rapier.
2. **Actuators that behave like hardware.** DC-motor electrical dynamics, thermal derating, cogging, LuGre friction, gear-reflected rotor inertia, PID servos with slew limits, and control latency are all native. For gameplay, "my shoulder motor is overheating, torque is dropping" becomes physics rather than a hand-coded stat.
3. **Reduced coordinates.** Joints cannot stretch or drift under violent impacts, which is the typical ragdoll failure of maximal-coordinate engines when mass ratios are high.
4. **Determinism for a single version on a single architecture** ([docs](https://mujoco.readthedocs.io/en/stable/computation/index.html#reproducibility)).
   - WebAssembly's listed sources of nondeterminism are NaN bit patterns, relaxed SIMD, threads, and resource exhaustion ([WASM design](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md)).
   - So shipping one pinned `.wasm` to browsers and to Electron should give identical trajectories on every machine. **This is my inference, not a guarantee from MuJoCo. Test it on Chrome, Firefox and Safari, on x64 and ARM.**
5. **Fits your stack.** A TypeScript worker plus three.js is the Mini Moto stack. Steam goes through the Electron kit you already have.

## MuJoCo's failure modes and mitigations

1. **Fast weapons tunnel through armor.** MuJoCo has no continuous collision detection for rigid bodies; the only CCD is the new flex-only `ipc` mode in 3.14. At a 1 kHz step, a spinner tip moving 100 m/s travels 10 cm per step, which is enough to skip straight through a 5 mm plate.
   - A spinning symmetric disk does not change shape as it turns, so collide the disk as a cylinder.
   - Resolve "bite" analytically: when a target enters the disk radius, apply an impulse whose size comes from stored kinetic energy and the tooth phase.
   - Keep the collision geometry of armor thick, and cap bullet-speed parts.
2. **Soft contacts feel mushy.** Tune `solref`/`solimp` on metal geoms. Negative `solref` gives direct stiffness and damping and therefore restitution. Enable `diagexact` (3.9) when inertias are anisotropic.
3. **Model topology is fixed at compile time.** Free joints are only allowed in "children of the world body" ([XML ref](https://mujoco.readthedocs.io/en/stable/XMLreference.html)). Anything that can detach must be designed in up front:
   - Model each detachable part (armor panel, wheel, weapon head) as a top-level free body bound by a `weld` equality.
   - During the match, set `eq_active=0` when the seam force passes a threshold.
   - A limb that can be ripped off needs either this soft-seam pattern or a deterministic `mjSpec` recompile at the break tick. `mjSpec` is untested in WASM.
4. **Rough edges in the bindings.**
   - Contact access has open issues: `mj_contactForce` "doesn't seem to do anything" and `data.contact.get(i)` leaks memory ([#3067](https://github.com/google-deepmind/mujoco/issues/3067), [#3068](https://github.com/google-deepmind/mujoco/issues/3068)). Both were filed against the community `mujoco-js` package, so re-test on the official one. The fallback is reading the typed-array views of `efc_force` directly.
   - The `/mt` build pre-spawns `hardwareConcurrency` threads. One user reported memory going from ~60 MB to ~480 MB on a 32-thread CPU ([#3144](https://github.com/google-deepmind/mujoco/issues/3144)). Use the single-threaded build for ranked matches.
5. **Every version bump breaks replays.** Pin the exact package version for each season and store the engine version in each replay header.
6. **Performance is not proven.** See the budget section below.
7. **No robot builder comes with it.** You write the part-graph-to-MJCF compiler in TypeScript. The simplest route is generating an XML string and calling `mj_loadXML`.

## Architecture sketch

```
Main thread: Next.js/React UI + three.js
  - Builder: part graph (JSON) -> TS "MJCF compiler" -> XML string
  - Render at display Hz: interpolate the last two physics snapshots
    (lerp positions, slerp quaternions), rendered one physics frame behind
  - Cosmetic dents, sparks, audio are driven by damage/contact events
Physics Worker (@mujoco/mujoco, single-threaded build, pinned version)
  - Fixed step dt = 1 ms (fallback 2 ms); integrator implicitfast or discrete;
    Newton solver; elliptic cone
  - Every 10–20 ms: low-level controller (ONNX skill policy via
    onnxruntime-web, or scripted motion primitive) writes ctrl targets
  - Every step: damage hooks read the contact list + efc_force,
    accumulate impulse per part, toggle weld eq_active on break,
    step dcmotor thermal state
  - Every ~100 ms: keyframe via mj_getState(mjSTATE_INTEGRATION)
  - Outputs xpos/xquat through a transferable Float32Array
    (or a SharedArrayBuffer ring if COOP/COEP headers are set)
Brain (Jev adapter; server-side so the API key never reaches clients)
  - At 2–10 Hz per robot: typed state summary -> choice
    (skill from a fixed menu), noul (disengage?), score (aggression)
  - Decision is applied at tick_request + FIXED reaction delay (e.g. 300 ms)
    for both robots. A late answer keeps the previous decision.
    This makes fairness independent of API jitter.
Replay / slow-mo
  - Replay = engine version + MJCF + seed + decision log (tick, robot,
    option). Jev is never re-queried.
  - Slow-mo re-simulates from the nearest keyframe at the SAME dt and renders
    more frames per sim step. At 1 kHz, 10x slow-mo at 60 fps is about
    1.7 steps per rendered frame. Never re-simulate at a finer dt: contact
    chaos makes it a different fight.
Training (offline, rented NVIDIA GPU)
  - Same MJCF -> mjlab / Playground on MuJoCo Warp -> PPO self-play
    (prioritized fictitious self-play with an Elo pool, as TimeChamber does)
    for skills: stance, strike, block, clinch, recover, push-to-wall
  - Export ONNX -> physics worker
```

**Morphology problem.** RL policies are tied to a specific body shape, and players build arbitrary robots. There are three ways out:

- **(a) Templates.** Ship chassis templates such as biped, quadruped and tracked, each with trained skills. Randomize limb lengths and masses during training so one policy covers variations.
- **(b) Make most bots BattleBots-style wheeled or tracked.** Driving and weapon actuation need only scripted controllers, and Jev does the tactics.
- **(c) Research option: one universal controller.** MetaMorph showed zero-shot transfer to unseen modular morphologies in MuJoCo ([arXiv 2203.11931](https://arxiv.org/abs/2203.11931)).

Start with (b) plus one template from (a).

**Prior art worth knowing:**
- Toribash (ODE engine) runs turn-based joint-state fights ([Wikipedia](https://en.wikipedia.org/wiki/Toribash)). A "tactical tick" mode that pauses the sim for a Jev decision would remove latency as a problem entirely.
- OpenAI's MuJoCo sumo humanoids learned stances through self-play ([OpenAI](https://openai.com/index/competitive-self-play/)).
- Robot Rumble 2 already sells a robot-combat builder with motors, ESCs, batteries, pneumatics and gearing on Steam ([Steam](https://store.steampowered.com/app/884180/Robot_Rumble_2/)). Deep, physically real articulated joints plus AI minds are the differentiator.

## Step rates and solver settings real robotics sims use

| Stack | Physics step | Policy rate | Solver settings |
|---|---|---|---|
| MuJoCo default | 2 ms (500 Hz) | — | Newton solver, up to 100 iterations, Euler integrator by default ([XML ref](https://mujoco.readthedocs.io/en/stable/XMLreference.html)) |
| MuJoCo Menagerie G1 / Spot / ANYmal | 2 ms (default) | — | `implicitfast`, elliptic cone, `impratio` 100; G1 joints armature 0.01, frictionloss 0.3, position kp 500 ([g1.xml](https://github.com/google-deepmind/mujoco_menagerie/blob/main/unitree_g1/g1.xml)) |
| Playground Go1 / G1 | 4 ms / 2 ms | 20 ms (50 Hz) | Go1 Kp 35, Kd 0.5 ([joystick.py](https://github.com/google-deepmind/mujoco_playground/blob/main/mujoco_playground/_src/locomotion/go1/joystick.py)) |
| legged_gym (PhysX) | 5 ms | decimation 4 (50 Hz) | 4 position / 0 velocity iterations, contact_offset 0.01 m, max depenetration 1 m/s ([config](https://github.com/leggedrobotics/legged_gym/blob/master/legged_gym/envs/base/legged_robot_config.py)) |
| Isaac Lab ANYmal | 5 ms | decimation 4 | 4/0 iterations; DC-motor actuator with 80 N·m effort limit, 120 saturation, stiffness 40, damping 5 ([anymal.py](https://github.com/isaac-sim/IsaacLab/blob/main/source/isaaclab_assets/isaaclab_assets/robots/anymal.py)) |
| Jolt game default | 16.7 ms (60 Hz) | — | 10 velocity / 2 position iterations |

Recommendation for this game:
- Physics at **1 kHz**: two to five times the robotics norm, because weapon impacts are more violent than walking.
- A 50–100 Hz skill or controller loop.
- Jev at 2–10 Hz.

## Performance budget (estimate, must benchmark)

- **Native humanoid baseline.** MuJoCo's humanoid.xml (27 DoF) ran about 12.3k steps/s on one thread of a loaded 48-core machine, about 81 µs/step ([Discussion #1522](https://github.com/google-deepmind/mujoco/discussions/1522)) [indep].
- **WASM overhead.** WASM averaged 45–55% slower than native on SPEC benchmarks ([USENIX ATC'19](https://www.usenix.org/system/files/atc19-jangda.pdf)) [indep].
- **My estimate.** Two 20–40-body robots in a clinch, with 50–150 contacts, cost roughly 0.25–1.0 ms per step in WASM. That is 25–100% of one core at 1 kHz, and half that at 500 Hz.
- **To make it fit:**
  - Use primitive and convex collision geoms only.
  - Use `contype`/`conaffinity` filtering.
  - Cap solver iterations.
- **Week-1 gate.** Benchmark two 30-body MJCF bots in a scripted clinch. If they do not hold 1 kHz in the worker on a 2021-era laptop, ship at 500 Hz.

## Runner-up in one paragraph

Rapier is the choice if the plan becomes "Jev picks scripted moves" and never includes RL. What it offers:
- An official cross-platform deterministic npm package with snapshots.
- Breakable joints (just remove the joint) and modern sweep-based CCD.
- Contact-force threshold events, plus soft bodies and tearing for cosmetic damage.
- The most TypeScript-native developer experience of any option.

What it costs:
- Impulse joints are maximal-coordinate, so stiff PD motors on light links jitter and stretch.
- There is no real motor model.
- There is no batched GPU training in the same engine.

Watch the TS bindings. If they expose multibody motors and the MJCF loader, the gap with MuJoCo narrows sharply.

## Open questions
- Can the @mujoco/mujoco single-threaded WASM build step two 20-40-body robots with 50-150 contacts at 1 kHz inside a Web Worker on a mid-range laptop? My estimate of 0.25-1.0 ms per step is unmeasured.
- Are MuJoCo WASM trajectories bit-identical across Chrome, Firefox and Safari on x64 and ARM? Does the /mt threadpool preserve determinism?
- Do the official @mujoco/mujoco bindings expose contact and constraint forces without the leak and no-op bugs reported against the community mujoco-js package (issues #3067, #3068)?
- Does mjSpec model editing work in the WASM build, and how long does a recompile take? This decides whether a limb can be ripped off mid-match or detachables must be pre-modeled as welded free bodies.
- Does MuJoCo Warp support the new dcmotor, pid and discrete-integrator features, which shipped after its parity statement? If not, what is the float32 GPU versus float64 WASM sim-to-sim gap for trained skills?
- How free should robot morphology be? Templates with trained skills, wheeled/tracked scripted bots, or a MetaMorph-style universal controller. This drives the whole RL scope.
- Which PhysX version does Unity 6.6 ship (4.1 or 5.x)? Unverified. It matters only if the Unity route is reconsidered.
- Will Rapier's TS bindings expose multibody motors and the MJCF loader soon? If so, the runner-up gap narrows a lot.