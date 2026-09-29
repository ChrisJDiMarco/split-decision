# Handoff: where Split Decision stands (paused 2026-09-29 ~11:00 ET)

Chris paused the session to move back to his apartment. Everything on disk is committed (see `git log`). Resume by reading this file.

## Working now

- Full fight night runs at http://localhost:5297 (`npm run dev`): select screen → walkout → tale of the tape → fight with live Jev minds (~265 ms p50, probabilities on screen) → knockdown count → KO replay → winner card.
- Physics: MuJoCo 3.14 WASM worker, 1 ms step, ~95 µs/step for two robots, keyframe rollback on divergence.
- Modules integrated: control, damage (heads detach, joints wear/limp/seize, hydraulics, smoke, KO), robot kit (6 skins), arena (cage, truss lights, haze, crowd, post), VFX (sparks, smoke, PBF oil), Jev brain + House Mind fallback, broadcast (HUD, director, replay, procedural audio).
- Camera director (done this session): analytic sightlines for posts, rails, truss and fixtures; no occluded shots.
- Settings (select screen): SOUND (off by default, Chris is watching films while we test) and OIL SPILLS & HISS (off by default). Presentation only; physics unchanged.
- KO rule is now 20 s down (URKL rule). Head break thresholds: striker 55, bruiser 75, goliath 90 N·s (measured strikes: p90 30-50, max ~73).

## Not good enough yet (Chris's bar)

Chris wants movement that is "competent and fast and violently cool", human-like walking, real hard punches and kicks, and get-ups that use all limbs (unless legs or joints are wrecked). He also wants the roster to be modern **electric** robots like the 2025-26 China fights, our own designs.

Measured on the last run (heavy roster, procedural control, tools/fight-metrics.ts):
- The new fast gait (`src/physics/control/walk.ts`, WIP) reaches 0.9-1.0 m/s but all three heavy robots fall within ~4 s with the gyro saturated (sat 1.00).
- Self-falls happen mostly while stepping or standing, then in the get-up rise.
- A get-up parameter search (cross-entropy) was mid-run: some settings rose 3/3.

## Chris's newer asks (2026-09-29 afternoon)

- Heads must only pop from a "really nice hard solid hit" (done in e03d382: clean-strike rule; thresholds to be set from measured strike distributions of the new roster, top few percent only).
- No blinding flash in slow-motion replays (done in e03d382).
- Superhuman balance and capability, but physically grounded; robots should ATTEMPT tornado kicks, kip-ups and other flashy moves, not always squared up, "opportunistic, creative and intelligent". Spec: `docs/design/fighter-intelligence.md`. Twenty more CMU clips for this (spin and jump kicks, handspring family, feints) are in assets-src/mocap/cmu/ (approved).

## In flight (2026-09-29 ~15:30)

- Committed since resume: electric roster + kits (5e2616f), mocap library for all 7 designs (e8d860d), openings detector + creative brain (8437d7f), head-pop/flash fixes (e03d382), select-screen livery fix (6a831f0).
- Running: `tracking-controller` workflow (mocap tracking core + flashy library → flashy moves + kip-up search → metrics + live critic) and `brain-gaps` workflow (pre-armed opening reflexes `Intent.onOpening`, kip-up appetite, stance hysteresis, side_on vs turned_away, injury-aware combos, stable MIND panel).
- Fast leg drives DONE (a036c68): kicks now ~0.9-1.2x human speed. Open: PYLON/SAVATE torso internals got light to pay for leg stacks (PYLON 4.84 kg, below FIRECRACKER's 5.67; battery realism); front kick falls a bit more under the old procedural controller (SAVATE X12-hip fallback exists if needed); docs/research/08-modern-roster.md actuator tables are stale.
- brain-gaps DONE. After the tracking workflow: the control layer must consume `Intent.onOpening` exactly per docs/design/onopening-control-contract.md, and replace any remaining TODO(control-build) fallbacks. Known brain follow-ups: reflexes may fire too often (spinning backfist dominates the menu), `stunned` rarely fires, `rising` spans the whole knockdown.

- Chris (16:50): heads must move and eyes/lights react; hands are a swappable customization (stock gloves/knuckles, dexterous tendon hands, later weapons); eventually a full WORKSHOP to build, customize and repair bots. Running: `expressive-heads-and-hands` workflow (gaze + grip systems, reactive eyes, loadout slot, HANDS picker, docs/design/loadouts-and-workshop.md). Neck pitch joint waits for the balance-engine build (humanoid.ts).
- Chris approved the order: tracking core → BALANCE ENGINE (design from `balance-engine-design` workflow; fusion of mocap style + physics-correct foot placement, Euphoria/Bodycam-style recovery) → flashy moves + kip-ups → live critic. Stop the tracking workflow after core:tracking completes, before its Flashy stage.

## In flight (2026-09-29 evening)

- Committed: tracking core + flashy library (22d78a6), motion-matching notes in the balance design (54266c9), fight audio (3e273eb, listen at /harness/audio.html), heads/eyes/hands loadout (cea595e).
- Running: `balance-engine` workflow (wf_38bd1af8-d17): Phase 0 drills + Phase 1 "walk in like a fighter" with inertialized target switches → independent verify (one fix round, stops if the gate still fails) → Phases 2-5 (impedance, weight-transfer strikes + mocap kicks + strike warping, Euphoria-style reactions, motion-matched mocap footwork) → judge. `CONTROL.balance` flips to 'dcm' only when Phase 1 passes.
- Running: `fighter-iq-and-hit-feel` (brain, openings, camera, vfx, post) and `player-mode` (src/player, harness/player.html). Commit their files when they finish; integrate player mode into the main game per docs/design/player-mode-integration.md.
- Known follow-ups: walkout tale of the tape ignores the loadout (src/ui/broadcast.ts ~line 210: `taleOfTheTape(applyLoadout(...))`); HAYMAKER's lock-on flare fires too often (uppercut in the physics big-shot list); HAYMAKER get-ups weaker with dexterous/knuckle hands; tests/openings/fallback.test.ts 'thrown' count 2 (needs >2) after control changes.
- Chris (evening): "when someone is on the ground the other robot should give them a bit of space so they can get up before fighting again". Running: `give-room-rule` (wf_074db92b-250), a referee break in `src/physics/systems/referee.ts` plus one hook in tactics.ts: no new strikes on a downed fighter, back off to a neutral spot, FIGHT once he's up. Brain/HUD follow-up after the fighter-IQ build finishes: house-mind's "opponent down: finish" becomes "give him room", no Jev calls during a break, BREAK/FIGHT on the MIND panel, broadcast and player HUD.
- Chris (evening): build "even better robots with more advanced joints and parts" like EngineAI's URKL fighters (multi-joint legs, fast twist-up get-ups). Running: `engineai-design-study` (wf_070bb48b-6c2) → docs/research/10-engineai-fighters.md + docs/design/next-gen-chassis.md (a PROPOSAL; needs Chris's sign-off before any build). Scope: a NEW generation of our own designs alongside the current roster (nothing converted); borrow the engineering, not the look.
- Player mode DONE (1ef3ac0): playable at /harness/player.html. Follow-ups:
  - Control side (balance engine / flashy stage): plant on `move {0,0}`; throw player strikes from the current footing (finish at most one step, then throw). Today only 5 of 12 live presses start (median 512 ms) because the robot is always mid-step.
  - `circle_left` actually steps to the fighter's own right; the player key map compensates, so flip both together if it's renamed.
  - Publish `RobotTelemetry.committed`.
  - Main game (after the fighter-IQ build frees main.ts/broadcast.ts): JEV/YOU toggle per corner, PlayerMode wiring per the integration doc, BREAK on the player HUD from the referee events.
  - Controls: remap main's S/Q/R and the broadcast's C/H; move the default guard off Ctrl (Ctrl+Tab/W/Space clash with browser and OS shortcuts); check pointer lock in real Chrome.
- After the balance engine: flashy moves + kip-ups in the body (consume `Intent.onOpening`, replace TODO(control-build) fallbacks), then a live critic.

## Next steps, in order

1. **Build the electric roster** from `docs/research/08-modern-roster.json` (FIRECRACKER 1.30 m/38 kg, SAVATE 1.73 m/83 kg, HAYMAKER 1.82 m/103 kg, PYLON 1.89 m/79 kg; art in `docs/concept-art/modern/`). New humanoid specs, electric catalog motors, robot-kit recipes for their heads/shells/gloves. Make them the default roster; keep Bruiser/Striker/Goliath as an optional "iron age" heavyweight class. Lighter bodies should balance far more easily.
2. **Finish the mocap library** (`src/robots/motions/`, `tools/mocap/`): only `data/striker.json` (99 moves) is generated. Run `npx tsx tools/mocap/build-library.ts` for every design once the new roster exists. Check the preview at /harness/motions.html. Raw CMU BVH clips are in `assets-src/mocap/cmu/` (git-ignored, 87 MB; credits in `assets-src/mocap/CREDITS.md`).
3. **Tracking controller**: the control module plays mocap moves (strikes, kicks, footwork, get-ups from front/back/side) as servo targets with inverse-dynamics-style feed-forward, a balance layer and the gyro; damaged joints make moves fail naturally. Replace procedural skills where mocap is better.
4. **Measure** with `tools/fight-metrics.ts` (self-falls, get-up rate, approach speed, landed strikes/min, head-hit share, fight length), then a fresh critic watches live Jev fights.
5. Later: headless robots keep fighting blind (a real 2026 bout did); gate bursts; 10-sided cage before anything public.

## Rules learned the hard way

- Never `pkill`/`killall`/pattern kills (a subagent's `pkill -f "cat"` force-quit ~15 of Chris's apps). Kill only PIDs you started.
- MuJoCo WASM: `data.eq_active` crashes (use `ctx.setEqActive`); named access is `model.jnt()`; never JS-side PD torques or `impratio` (both exploded).
- Browser checks: each agent uses its own tab.

Research: `docs/CONCEPT.md`, `docs/research/` (engines, actuators, builder, control, Jev, arena, fact-check, UniMate, China fights, modern roster).
