# Split Decision: Demo 1 PRD

Status: approved to build by Chris on 2026-09-29 ("when you're done thinking and planning let's make the demo on my comp"). Research lives in `docs/CONCEPT.md` and `docs/research/`.

## Problem

Nobody has shown physically real robots, with real joints, real motors and real damage, fighting in a cage while a decision model picks every move, running in a plain browser with zero trained policies. Demo 1 answers one question: is watching Jev-driven robots fight in a physically believable octagon compelling?

## Success criteria

1. Runs locally on Chris's M3 Max in Chrome and Safari: render at 60 fps, physics real-time at 1 kHz (500 Hz fallback) in a Web Worker.
2. At least five robot designs across three body types (humanoid bipeds, a quadruped, a wheeled or tracked brawler), each with six skins and its own abilities.
3. Jev is the only pilot. Each fighter asks Jev several typed questions per decision through a local proxy; the key stays in the macOS Keychain. A broadcast HUD shows each fighter's live decision distribution. A local fallback brain takes over if Jev is unreachable and the HUD says so.
4. Damage is physical and visible:
   - heads and limbs come off when seam force passes a threshold (MuJoCo weld equalities switched off at runtime);
   - joints degrade with accumulated damage: torque loss, slop, jitter, then limp or seized;
   - motors heat up under load and smoke when pushed, and the thermal model throttles torque;
   - hydraulic parts lose pressure and leak oil (GPU particle fluid) when hit;
   - metal hits throw sparks, leave dents and scratches, and knock off debris.
5. Robots read as heavy: mass-correct inertia, real torque limits, camera shake, impact audio, footfall weight.
6. The octagon matches real UFC proportions (scaled to robot size) with a chain-link cage, padded posts, canvas mat, broadcast lighting and haze.
7. Every KO gets a slow-motion replay re-simulated from the decision log.

## Constraints

- Browser only. No native install, no NVIDIA GPU, no trained policies.
- Physics: `@mujoco/mujoco` 3.14.0 single-threaded WASM, pinned. Rendering: three.js r184 `WebGPURenderer` with WebGL2 fallback. Oil fluid (`threejs-particle-fluids`, WebGPU only) is an enhancement that turns off on the fallback.
- Jev never outputs torques. Motion comes from PD servos, IK strikes, procedural gaits, classical balance control and a physically real gyro stabilizer part.
- Known binding bug: `MjData.eq_active` crashes on read. Toggle welds with `mj_setState(..., mjSTATE_EQ_ACTIVE)`.

## Decisions taken (defaults from the research, overridable)

- Legged fighters are in Demo 1 because the brief asks for kicks and knocked-off heads. The research recommended wheeled-only v1 because legs can't balance without learned control. The answer here is a gyro core: a real stabilizer part with mass, torque limits and power draw. Damage it and the robot loses balance.
- Show first: Jev fights run live in the demo; a lockstep tournament mode comes later.
- No human pilot. No betting or real-value currency, ever.

## Out of scope for Demo 1

The part-by-part robot builder UI (Demo 1 ships preset designs with skin and loadout choices), the league, online play, the Steam build, the Claude corner coach.

## Build plan

| Phase | What | Verify |
|---|---|---|
| 0. Spine | Vite app, physics worker protocol, robot schema, MJCF compiler, body-to-mesh sync, Jev proxy | Two robots stand in the cage at real-time; a Jev call returns |
| 1. Parallel modules | Controllers and balance; damage model; VFX (sparks, smoke, oil, dents); robot visual kit and skins; arena and lighting; Jev brain and HUD; broadcast camera, replay and audio | Each module has a harness page or test that shows it working alone |
| 2. Integration | Wire modules into the fight loop | Full fight to KO with Jev live |
| 3. Polish and review | Visual QA in the browser, performance pass, code review | Grader pass; Chris watches a fight |

## Kill criteria

If, after integration, Jev fights are less watchable than the fallback brain in a blind side-by-side, Jev stays for the HUD, judging and camera direction only.
