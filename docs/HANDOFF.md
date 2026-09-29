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
- After both: the control layer must consume `Intent.onOpening` (fire the armed gamble locally when the opening appears; see brain-gaps report) and replace any remaining TODO(control-build) fallbacks.

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
