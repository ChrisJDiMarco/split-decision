# >>> RESUME HERE (2026-10-06, session paused for tokens) <<<

1. Read this file, then `git log --oneline -15` and `git status`.
2. The balance engine build was mid-way through **p1:fix**. Its uncommitted edits in src/physics/control/** and tests/balance are on disk, backed up as tests/balance/.out/p1-fix-wip-*.patch.
3. Resume the balance build: Workflow({scriptPath: "~/.claude/projects/-Users-chrisdimarco-jarvis/35a12cda-55d8-4dbe-b6de-87829408a2a0/workflows/scripts/balance-engine-wf_38bd1af8-d17.js", resumeFromRunId: "wf_38bd1af8-d17"}).
   - p1:build and p1:verify replay from cache. p1:fix restarts and is told to review the partial edits (git diff) first.
   - Then come P5 mocap footwork + ring IQ, pace, P3 strikes + speed/impact, P2, P4 and the judge.
4. Everything else is committed (latest a333ee6).
5. Waiting on Chris:
   - "going to bed" starts the overnight move polish (resume wf_34e4f671-4ea with args {runProof: true}) and the NEXT GEN Phase 0 test.
   - The local model download (decider-4b, 2.71 GB) is parked.

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
- Chris approved OFFLINE CPU MOVE POLISH (SAMCON family; no GPU, no neural net) so mocap moves play fluidly in real physics, but heavy runs ONLY OVERNIGHT while he sleeps. `move-polish-poc` (wf_34e4f671-4ea) runs the light design phase now (three methods judged → docs/design/move-polish.md). At bedtime, resume it with args {runProof: true} and resumeFromRunId wf_34e4f671-4ea to polish 5 PoC moves (4 workers), then an adversarial verify and go/no-go for all ~875 moves. The runtime hook-up belongs to the balance engine (control/**).
- Fighter IQ (9d6c106) and hit feel (f15327d) are DONE and committed. IQ follow-ups for control:
  - Feints need a real, sellable windup, and a low feint. Right now reads are about 4 per minute and carry no signal (34% react to a feint vs 38% to no feint).
  - Chain combos in the body (`COMBO_SEQUENCING = 'body'`): 44% of plan steps are never thrown.
  - Other open items: tests/openings/perf is tight under load; the hit-feel shockwave ring may look too stylised (taste call); the harness 'Head off' holds the push-in.
- Running: `minds-and-player-integration` (wf_b27aa470-00c), which replaces the stopped player-integration run. Mind picker per corner: JEV (cloud) / LOCAL (open-source Jev on this Mac, via /api/local-jev) / HOUSE (rules only) / YOU (player); global MINDS override; player mode in the main game; FAIR MODE; guard key moved off Ctrl. The local model (Kev or Mapika decider) waits for Chris's OK on the exact download sizes.
- EngineAI study DONE (d38678a): docs/research/10-engineai-fighters.md, docs/design/next-gen-chassis.md. Chris decided: NEXT GEN era; full T800-style hip (Option 1) regardless; all three designs (PINWHEEL, JACKKNIFE, CAPSTAN); Phase 0 runs OVERNIGHT after balance-engine Phase 1.
- OVERNIGHT QUEUE (start when Chris says he's going to bed): (1) move-polish proof: resume wf_34e4f671-4ea with args {runProof: true} (design in docs/design/move-polish.md, winner = windowed CMA-ES over B-spline servo corrections through the runtime PolishedPlayer; the FIRECRACKER get-up alone is ~1.6 h wall at 4 workers). The doc makes 4 requests of the balance build (a MotionReference.polish field, in-tube stand-down, arm/gaze stand-off, the tracker calling loadPolish), all for later integration; (2) NEXT GEN Phase 0 (six SAVATE variants, byte-lock + behaviour golden) if balance-engine Phase 1 has passed.
- PARKED (Chris: "save this so we can revisit later"): Julia 1 and the local-mind eval; see docs/research/11-julia-1.md and the roadmap. Don't download any model until Chris revisits.
- After the balance engine: flashy moves + kip-ups in the body (consume `Intent.onOpening`, replace TODO(control-build) fallbacks), then a live critic.

## If the session ran out of credits mid-build (2026-09-29 ~20:45 ET)

Everything is on disk. Commit each build's files only after checking them. Resume each workflow with its script and run id; completed agents replay from cache, and unfinished ones restart on top of the files already written. Scripts are in ~/.claude/projects/-Users-chrisdimarco-jarvis/35a12cda-55d8-4dbe-b6de-87829408a2a0/workflows/scripts/.

| Build | Script | Run id | State at 20:45 |
|---|---|---|---|
| Balance engine | balance-engine-wf_38bd1af8-d17.js | wf_38bd1af8-d17 | p1:build tuning; dcm-v1 drills still FAIL (falls, slow approach, torso buzz); `CONTROL.balance` stays 'legacy' until the gate passes |
| Give-room referee | give-room-rule-wf_074db92b-250.js | wf_074db92b-250 | build done, verify:referee running |
| Mind toggles + player in main game | minds-and-player-integration-wf_b27aa470-00c.js | wf_b27aa470-00c | local:bridge running (no downloads) |
| Move polish (overnight) | move-polish-poc-wf_12353dce-98f.js | wf_34e4f671-4ea | design done; heavy proof waits for bedtime: args {runProof: true} |

Uncommitted work in progress: src/physics/control/** + src/physics/control/balance/ + tests/balance + tools/balance-drills.ts (balance engine), src/physics/systems/referee.ts + tests/referee + tools/referee-check.ts (referee), server/** + src/brain/** (local mind). Balance-engine drill logs: tests/balance/.out/.

- PREVIEW SWITCH (20:55, uncommitted: 3 small edits in src/main.ts, src/physics/worker.ts, src/core/protocol.ts): http://localhost:5297/?balance=dcm runs the in-progress balance engine with a yellow "PREVIEW · NEW BALANCE ENGINE" badge; the default stays legacy. Commit it together with the integration build's main.ts changes.
- SETTINGS WATCH: an integration-build test left the shared localStorage setting `minds: "local"`, so every tab runs LOCAL OFFLINE → HOUSE. After that build finishes, reset `minds` to 'corner' if it's still 'local'.

- REORDER (Chris, 21:00): the preview walking isn't mocap, and he wants human mocap footwork first. The balance script is edited to run P1 → verify → P5 (motion-matched mocap footwork) → P3 → P2 → P4 → judge. When p1:build's result is in the journal, stop wqstz2k1x and relaunch the script with resumeFromRunId wf_38bd1af8-d17; p1 replays from cache.

- DONE 21:15: local mind bridge (50a298d) and the mind picker + player mode in the main game (7643b20, which includes the ?balance=dcm preview switch). LOCAL needs `ollama pull hf.co/Mapika/decider-4b-GGUF:Q4_K_M` (2.71 GB, Apache-2.0), waiting for Chris's OK; then run `npx tsx tests/brain/live-local.ts`. Follow-ups:
  - The opponent panel still says 'JEV MIND' for LOCAL/HOUSE.
  - Hit-stop briefly freezes player input on their own hits.
  - The key sheet can't open during the walkout or a break.
  - LOCAL decisions are recorded with source 'jev'.
- Chris's localhost settings currently say MINDS = ALL LOCAL (neither agent claims to have set it; possibly Chris did). Ask him; don't change it.

- Referee break DONE (a9ad5fb; its one-line tactics.ts hook lands with the balance commit). Running: `referee-presentation` (wf_6c9a10d8-139). It adds brain holds with no Jev calls during a break, muted openings, real break/fight events, ticker lines, MIND panel and broadcast BREAK/FIGHT!, camera framing, the KO count fix for failed rises, and NEUTRAL_M set to 2.2 m.
- Running: `cover-art-16x9` (wf_4671f6c2-d73), a Steam-style cover made with fal openai/gpt-image-2, output in docs/art/cover/.

- 21:50: balance p1:build finished. The gate FAILS, so the default stays legacy. Phase 1 vs legacy: approach 0.34-0.53 vs 0.12-0.19 m/s, landed strikes 17.2 vs 12.1/min, first strike 4.5 vs 11.2 s, smoother (pelvis std 2.2 vs 3.7 cm); still 10 self-falls stepping/standing in sparring and weaker stance pushes on FIRECRACKER/PYLON. Relaunched in the new order (task w0pavavk5, same run id wf_38bd1af8-d17, p1:build replayed from cache): verify, then fix + reverify, then P5 mocap footwork, P3, P2, P4, judge.

- CHRIS'S BAR (21:55, after the preview): "confidence and grace", "going at each other, this is a fight not dancing and hesitating", "each real fast punch should have impact", "actuators are still moving too slow", "make them the best versions of themselves". The balance script now carries CHRIS_BAR into every later stage and runs P5 mocap footwork → NEW 'pace:commit' stage (throw from current footing, cut cooldowns, combos in the body, sellable feints, pressure footwork; target ≥ 30 thrown / ≥ 20 landed per minute, idle-in-range ≤ 20%) → P3 plus SPEED AND IMPACT (fist/shin speed vs human references; upgrade to the best real actuators where a motor is the bottleneck) → P2 → P4 → judge. If the Phase 1 gate still fails after the fix round, the build now continues with the default left on legacy. The watcher b27pjo8e1 waits for p1:verify, then stop w0pavavk5 and resume the script with run id wf_38bd1af8-d17.
- AFTER referee-presentation finishes: a brain aggression pass (House Mind temperament, Jev question wording, aggression defaults) so the minds pick the fight too.

- 22:40: the spend limit cut off the balance verify/fix/reverify and the referee review. Checkpoint commits: cb91102 (referee on screen, review pending) and 35859cd (balance P0+P1 behind the switch). Retried: balance wvdb51env (resume wf_38bd1af8-d17 with the edited script: CHRIS_BAR, pace stage, no early stop) and referee review wr74od2x9 (resume wf_6c9a10d8-139). If the limit hits again, resume both the same way.

- 23:05: referee review DONE (21fb0fe: the downed fighter covers up while the kip-up question is out; 'Double knockdown' only for real ones). BACK GET-UP: Chris turned the pop-up off the back off, but measured without it a shoved-over HAYMAKER never got up, so with Chris's OK it's back ON (2904a64). Priority for move polish: make the back get-up (getup_back 140_08/140_09) look good on every modern design; FIRECRACKER's is already a PoC move.

- RING IQ (Chris, 23:15): "no awareness of the distance ... their arm length and effective range for strikes". Spec: docs/design/ring-iq.md. BALANCE-ENGINE AGENTS (P5 footwork, pace stage) must implement its body rules: edge/pocket/outside zones, enter WITH a strike, step out after combos, predict the meeting point, no walking into guard contact. The mind side (range facts for Jev/House) is running now as `range-awareness-mind`.

- 2026-10-06: the spend limit (reset Oct 5 10pm) had cut off the balance fix and everything after it, plus the range-awareness mind build. Retried: balance wt48stc28 (resume wf_38bd1af8-d17; p1:build and p1:verify replayed from cache, p1:fix running, told to review the partial feedforward.ts edit) and range-awareness-mind w2dko0n8h (run wf_4aba2ef3-4c1, told to review and finish its partial brain edits: src/brain/ranges.ts and others). Overnight polish and the NEXT GEN Phase 0 test still wait for Chris's "going to bed".

- Ring IQ, mind side: DONE (c4675b7; details in docs/design/ring-iq.md). FOR THE BALANCE BUILD'S PACE / P3 AGENTS:
  - (a) From the edge, Jev now mostly picks close_distance. The body should turn close_distance at the edge into a step-in strike, not a walk.
  - (b) head_kick's minimum range (0.47-0.51 m on SAVATE/PYLON) sits inside the clinch band. Tighten it in the skill.
  - (c) Every measured whiff started in range, so hit rate and aim are the body's job.
  - (d) If mocap kicks turn on with clip-based ranges, keep src/brain/ranges.ts (reads def.range) in sync.

- STRIKE POWER (2026-10-06): audit + plan in docs/design/strike-power.md. Fists land at 2-4.5 m/s against a boxer's 9, mostly because of how strikes are controlled.
  - FOR THE BALANCE BUILD'S P3 AGENT: implement section 2's control side. That covers burst mode (cut servo damping during the strike), ballistic profiles aimed 25-35 cm through the target, throw distance set for 85-95% extension, a stiff aligned arm, the hip→chest→shoulder→elbow chain, step-in momentum, fast kicks (pre-shift within 1/ω0), joint aim points, and the kick anomalies.
  - D1 actuator swaps: Chris APPROVED ALL the recommended swaps (2026-10-06). Gantry A/B each one first, then the balance drills.
  - The damage overhaul (joint loads by channel, physical dents, per-design durability, events with a position) is a separate build waiting for Chris's sign-off.

- Damage overhaul APPROVED and running (`damage-overhaul`, task wfqk054jv; to resume: script damage-overhaul-wf_3264ae7f-e60.js with resumeFromRunId wf_3264ae7f-e60): joint loads by channel, physical dents (+ ~2x labelled visual boost), per-design durability, events with a position, VFX/audio by cause. Contact recoil and threshold calibration come after P3 makes strikes fast.

- Damage overhaul DONE (f96f924, reviewed). CALIBRATION AFTER P3 (stage 5b, via `tools/strike-bench.ts --tune DAMAGE_TUNING.*`):
  - Head pops are too frequent (3-4 in 8 fights, mostly FIRECRACKER's 13 N·s head).
  - Fights with an injury: 63% (target 25-50%).
  - On 3-axis shoulders and hips, wear is counted on all three joints.
  - The rs04 bearing rating's source is inconsistent.
  - HAYMAKER's forearms gouge from blocking; thicker guards would be a designs change.
  - Hits to the torso and head never arm the hips or knees.
- Balance build: p1:reverify DONE; P5 mocap footwork (+ ring IQ) is RUNNING.

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
