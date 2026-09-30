# Move polish: making every mocap move physically feasible

Chris, 2026-09-29: the robots don't move "smoothly and with grace like the mocap movements", and the goal is robots that are "hyper super human and look incredible". He approved an offline CPU optimisation step with no GPU and no neural network training.

This doc says how. Each retargeted mocap move becomes a physically feasible reference for its design. It is optimised offline by running the real game physics, stored as a small table, and played at runtime with a small, fixed feedback law. When the robot leaves the move's validated envelope, the balance engine (`docs/design/balance-engine.md`) takes over.

## 1. The decision

Three designs were judged. Each was scored 1-10 on five axes:

- quality: graceful, faithful to the mocap, powerful;
- robustness: pushes, damage, the opponent's hits, runtime feedback;
- CPU cost for about 875 moves (7 designs × about 125);
- integration with the balance engine;
- physics honesty.

| Method | Quality | Robust | CPU | Integration | Honesty | Verdict |
|---|---|---|---|---|---|---|
| A. SAMCON classic (Liu 2010/2015) with CMA, a speed ratchet, then learned per-fragment linear feedback (Liu 2016) | 7 | 8 | 4 | 7 | 8 | Most proven on acrobatics. The feedback-learning stage is about 80% of its compute (15-20 h per design), and its regression feedback is the grey area under "no training". |
| **B. Windowed CMA-ES over smooth B-spline corrections, optimised through a frozen hand-structured feedback law, robust over perturbed scenarios** | **8** | **7** | **7** | **8** | **9** | **Winner.** Smooth by construction, so it has none of SAMCON's sampling jitter. The optimiser and the runtime share one player file. Pushes are used only as tests. Its cost numbers were measured on this Mac. |
| C. Receding-horizon MPPI, then iLQG with TVLQR gains compressed to a reduced state | 7 | 7 | 7 | 7 | 9 | The best diagnostics and the honest B matrix. But iLQG and TVLQR through contact switches are fragile (Posa 2016), it needs the most new numerical code, and the feedback is invalid across the contact switches that every kick and get-up has. |

Why B wins:

1. Smoothness is what Chris asked for. Cubic B-splines with 0.1 s knots cannot inject the high-frequency noise that SAMCON needed elite averaging to remove (noise-to-signal ratio 6-27 in Liu 2015).
2. The player that the optimiser rolls out is the player the game runs. That makes "reproducible from stored data plus runtime feedback" a test we can run, not a promise.
3. Its feedback is about 10 hand-structured gains per move (Lee 2010 / SIMBICON form). Nothing is regressed or learned, so the "no neural network" question doesn't arise.

### What we take from the runners-up

- From A (SAMCON):
  - **Window boundaries snap to events.** Contact switches, take-off, landing and impact become boundaries.
  - **Liu 2010's deterministic arm offset.** Non-striking arms and the neck get Δq += (q_ref − q_sim) from the previous pass instead of being sampled. This cuts search dimensions by about 40%.
  - **An explicit speed ratchet** for the "faster than human" part.
  - **Foot-skate and contact-mismatch terms.**
  - **Landed-strike validation** with the real opponent standing at the target.
  - **A start-state funnel gate and a statistical abort.**
  - **Iron-age flashy moves are marked infeasible, not faked.**
  - **Liu 2016 per-fragment linear feedback is kept as a documented upgrade** if the hand-structured gains miss the robustness gate. It is used only with Chris's OK.
- From C (MPPI/iLQG):
  - **Inverse-dynamics warm start** (Xie & Kry 2022): the initial Δq is the `mj_rne` torque on the reference divided by kp, so the search starts from a pose the servos can actually hold.
  - **The headroom cost** Σ max(0, |τ|/τ_avail − 0.85)². A saturated servo has no authority left for feedback.
  - **A per-knot trust tube** from Monte-Carlo validation, used as the hand-off test.
  - **A harness assertion** that `xfrc_applied` holds nothing but the GyroCore couple.
  - **Restore rules** (§3.3).

## 2. What the optimiser may change (and what it may not)

It may change only what a real controller on this hardware can command:

| Variable | Per knot | Range | Enforced by |
|---|---|---|---|
| Servo target correction Δq(t), all 23 joints | cubic B-spline control point every 0.1 s | \|Δq\| ≤ 0.3 rad | the player clamps it; `motors.ts` still limits torque |
| Clip time-warp w(t) | 1 per 0.1 s | clip rate e^w ∈ [0.5, 2.5] (MAX_RATE) | the motor model: if a target is too fast, the servo lags and the tracking cost rises |
| Gyro pitch/roll feed-forward demand | 1 per 0.1 s, flashy and kick moves only | ±τ_max | the unchanged `GyroCore.update` (τ ≤ τ_max·health, \|h\| ≤ H, 1.2 s bleed) |
| Group kp scale: stance leg, swing leg, waist, arms (kv follows √kp) | 1 per 0.1 s | [0.3, 1.0] | the existing `r.mem.gainScale` / `dampScale` path in `motors.ts` |
| Feedback gains (§5.2), about 10 per move | per move | bounded boxes | the player |

It never touches forces, masses, welds, the timestep, contact parameters or joint limits. It never adds a root assist or any xfrc besides the gyro couple. Every step of every rollout runs:

1. the real `motorSystem.pre`: torque-speed line, full torque in the braking quadrant, thermal derate, health, backlash from `ctx.rng`, battery sag, gain scales;
2. the real `GyroCore.update`;
3. `mj_step` on the real compiled MJCF with the game's `<option>` block: 1 ms step, implicitfast, elliptic cone, Newton 30/10, and the canvas geom string from `world.ts` (friction 0.9 0.005 0.0001, solref 0.004 1).

The fastest speed a move reaches is set by the torque-speed lines, not by a rule.

## 3. How the optimiser works

### 3.1 Rollout world

The rollout world has one robot, built from `compileRobot(design)`, with the canvas and option block copied from `world.ts`. A unit test asserts the strings match, so they cannot drift. A parked second robot on the gantry still costs full price (16 contacts), so optimisation rollouts leave it out.

Final acceptance runs in the full `compileWorld()` scene through the game's control stack (§6).

### 3.2 Reference and warm start

The target is the library move as `sample()` returns it: q, root, contacts, impact, target.

The balance targets are the move's mass-aware centroid table (COM, L̇, DCM ξ̂; balance-engine.md §5.1). If `tools/mocap/centroid-tables.ts` doesn't exist yet when we start, the harness computes the same thing itself with `mj_kinematics` / `mj_subtreeVel`.

The initial Δq is the inverse-dynamics shift τ_ID/kp. τ_ID comes from `mj_rne` on the reference q, q̇, q̈ with the clip's planted feet, and the shift is clamped to ±0.35 rad and 90% of available torque, as in balance-engine.md §3.6. It is baked into the stored Δq, so the runtime needs no inverse-dynamics call.

The initial rate is today's `MotionPlayer` rate table (0.85 × no-load speed, capped at 2.5).

### 3.3 Snapshots and determinism

Measured today on the 2-robot test world:

| Restore method | Result |
|---|---|
| `mj_getState` / `mj_setState` with **`mjSTATE_INTEGRATION`** (533 doubles for 2 robots), state passed as a **`Float64Array`** | 3.1 µs get, 2.5 µs set. Restoring and re-running 300 steps is **bit-identical** (max \|Δqpos\| = 0). |
| `mjSTATE_FULLPHYSICS` | Leaves out the solver warmstart. The same replay drifts by 8.6e-11 after 300 steps, which contact chaos amplifies. Not usable. |
| `Array.from(...)`, the pattern in `worker.ts` | 13 µs. |
| `DoubleBuffer` | Throws. |

So the harness uses INTEGRATION state passed as a typed array.

The JS side of a snapshot holds:

- every `JointRuntime` (tempC, health, state, slop goal and timer);
- the battery;
- the GyroCore `h`, `applied` and `saturation`;
- the player's clock and filter state.

`ctx.rng` is a `mulberry32` closure, which can't be snapshotted. The harness therefore installs its own mulberry32 whose state is a readable number. It uses the same algorithm, so backlash statistics are unchanged.

### 3.4 Windows

- Knots every 0.1 s of clip time.
- Each window commits 0.2 s: two new control points per joint, plus the previous window's last point re-opened so the C2 spline stays consistent.
- Window edges snap to the nearest contact switch, take-off, landing or impact within ±50 ms.
- A rollout starts 0.1 s before the window from the committed snapshot. It runs the window plus a **0.3 s lookahead**, which is at least 1/ω0 (0.26-0.31 s). A weight shift that will fail shows up inside its own window. During the lookahead, later knots are held at their warm-start values.
- The last window runs 0.5 s into `guard_idle`, so every move has to end balanced and ready.
- **Take-off block:** for a move with flight, take-off − 0.3 s to landing + 0.2 s is optimised as one window, because take-off momentum decides the landing. Legs and waist keep 0.1 s knots there; arms go to 0.2 s knots.

### 3.5 Search in each window

The search is separable CMA-ES (sep-CMA, diagonal covariance), with IPOP restarts that double the population λ.

- σ0 = 0.05 rad on legs and waist, 0.03 on the striking arm, 0.15 on log-rate, 0.2·τ_max on gyro knots and 0.15 on gain scales.
- Non-striking arms and the neck are not sampled; they get the deterministic offset from §1.
- Window size: about 30 dimensions for a standard window, λ = 12-16. The tornado take-off block has about 150 dimensions, λ = 32.

The search runs in two passes:

- **Pass A, nominal only.** It looks for a candidate that doesn't fall and that tracks. Budget 40 generations.
- **Pass B, robust.** Each candidate is scored over K scenarios (§7.1) with common random numbers inside a generation, as F = mean + 0.5·max. K = 4 for punches, 6 for kicks, get-ups and flashy moves. Budget 50-80 generations, stopping early after 10 without improvement.

A window with no surviving candidate restarts IPOP-style once, then merges with the previous window, at most 2 merges. The committed mean is re-simulated once from the snapshot and becomes the next window's start state.

After the Δq pass, the feedback gains are optimised by CMA over the whole move with Δq fixed. Then one short Δq pass runs with the new gains, since the two interact.

### 3.6 Speed ratchet

Once a move passes its gates, the optimiser tries to make it faster:

1. Raise the rate by 10% in every window where all joints stayed under 0.85 of their torque-speed-limited torque and under 0.85 of no-load speed.
2. Re-run Pass B warm-started.
3. Keep the result only if it still passes every gate.

At most 2 rounds. The stored move is the fastest version that passed.

## 4. Cost function

Terms are sampled every 10 ms over the rollout, compared against the reference at the clip time the rollout has reached. Terms are normalised by fixed scales (0.1 rad, 5 cm, 0.5 m/s), so the starting weights follow SAMCON's ratio: pose 8, root 5, end-effector 20, balance 20. Liu 2010 found that ratio insensitive.

| Term | What it measures | Weight (start) |
|---|---|---|
| Pose | mass-weighted Σ(q − q̂)² + 0.1·Σ(q̇ − q̂̇)² | 8 |
| Root | pelvis position and attitude error in the placed move frame | 5 |
| COM | \|c − ĉ\|² against the mass-aware centroid table; the robots' limbs are 1.3-2× heavier than the actor's, so this is soft | 3 |
| End-effectors | planted feet (and hands and knees in get-ups) against the clip; the striker's path through the strike phase | 20 |
| Impact | at impact: striker distance to `target`², impact-time error², and a reward on striker speed, −min(v/(peakSpeed·rate), 1.2) | 20 |
| Foot slip | Σ planted-sole speed² while the clip says planted and the sim has contact. In physics, skate only happens as a real slip | 30 |
| Contacts | clip contact bit vs sim contact, with ±30 ms tolerance (relaxed for get-ups) | 5 |
| Balance margin | max(0, 0.02 m − margin of ξ in the support)² while supported | 20 |
| Smoothness | Σ(d³q_target/dt³)² from the spline (analytic), plus torso angular rate above 3 Hz (the visible buzz) | 2 |
| Headroom | Σ max(0, \|τ\|/τ_avail − 0.85)² on planted-leg joints (today 70-83% of kick phases sit at the limit) | 10 |
| Effort and heat | Σ(τ/τ_stall)²·dt, plus a hard budget on winding temperature rise per move | 0.5 |
| Gyro reserve | max(0, \|h\|/H − 0.5)² during the move; \|h\|/H ≤ 0.5 at the end | 5 |
| Speed | −(clip progress per wall second), in ratchet rounds only | 1 |
| Terminal | after the 0.5 s tail: ξ ≥ 2 cm inside the support, \|ċ\| < 0.3 m/s, torso rate < 0.3 rad/s, pose near `guard_idle` frame 0 | 20 |
| Fall | torso up-axis < 0.5, or any contact the clip doesn't plan (knee, hand or torso outside get-ups) → +1000 and the rollout stops | hard |

For get-ups, pose weight drops to 3. Get-up progress becomes a task term (COM height against the clip's COM-height profile, and the planned support contacts in order), because in places the retargeted get-up can't be reached (legs 60-80° off the actor, feet dragging 15-44 cm).

## 5. Runtime playback

### 5.1 Files

| Path | What | Owner |
|---|---|---|
| `src/robots/motions/polish/player.ts` | `PolishedPlayer`, pure and worker-safe; the optimiser imports the same file | this build |
| `src/robots/motions/polish/format.ts`, `load.ts` | encode/decode with `codec.ts`; `loadPolish(design, moveId)` via `import.meta.glob('../data/polished/*/*.json')` | this build |
| `src/robots/motions/data/polished/<design>/<moveId>.json` | one stored move (§8) | generated |
| `src/robots/motions/data/polished/<design>/index.json` | compat hash, every move's status (`polished` / `infeasible` / `failed` / `stale`), summary metrics | generated |
| `tools/polish/*.ts` | rollout world, snapshots, sep-CMA, cost, scenarios, validation, resumable queue, report | this build |
| `tests/polish/*.test.ts` | determinism, honesty assertions, zero-Δq equivalence, codec round-trip, mirror | this build |

The library's `./data/*.json` glob isn't recursive, so the `polished/` folder doesn't affect it.

### 5.2 Every 2 ms control tick

1. **Clock.** τ advances at the stored warp rate. Contact sync (Lee 2010) uses the *simulated* contact events, not the actor's: a touchdown up to 30 ms early jumps to the next knot; a late one holds the clock up to 60 ms, then aborts.
2. **Targets.**
   - q = `sample(move, τ).q` + Δq(τ), mirrored through `lib.mirror` for southpaw.
   - q̇ and q̈ come analytically from the spline times the rate, so there is no finite-difference noise.
3. **Feedback.** Reference-relative, measured against the *simulated nominal*, not the clip. The nominal is a trajectory the robot has already achieved.
   - Stance ankle pitch and roll: Δθ = c_d·(d − d̂) + c_v·(v − v̂). Here d and v are the COM relative to the stance-sole centroid, in the heading frame.
   - Stance hip pitch and roll: the same form with its own gains, plus k_t·(torso tilt error).
   - Swing hip, single-support moves only: a SIMBICON-style placement term with its own c_d and c_v.
   - Gyro: ff(τ) + k_L·(L̂ − L), pitch and roll only, clamped by GyroCore.
   - All of these are clamped to ±0.15 rad per joint.
   - Cost: under 2 µs per robot. The features are ones `sense.ts` already has: c, ċ, L from `subtree_angmom`, and foot positions.
4. **Gains.** The group kp scales go out through the MotionReference extension below.

### 5.3 Start gate

The polished move starts only if all of these hold:

- the start state is inside the stored box (e.g. \|ξ − ξ̂(0)\| < 3 cm, COM speed < 0.3 m/s, torso tilt within 5°);
- the gyro reserve is at or above the stored requirement;
- every joint the move uses is at or above the envelope's minimum health, and none is limp or seized;
- the battery is at or above the envelope minimum.

If the gate fails, the move plays the raw way (MotionPlayer + balance engine), exactly as today, and Jev's `moveRisk` sees the higher risk.

Aiming works two ways:

- **Kicks** aim by start placement (`placeSample`), never by warping the kicking leg, which is 21-27% of body mass.
- **Punches** may use an arm-only IK warp of up to ±5 cm. That warp is inside the robustness scenarios.

### 5.4 Hand-off to the balance engine

The balance engine owns runtime balance. The polished move feeds it through `MotionReference` (balance-engine.md §7):

- q, q̇, q̈ from step 2, with feedback added;
- `weight`: legs, waist and arms at 1.0;
- `trunk`, from the simulated pelvis track;
- `footsteps`, from the simulated lift and land events, placed with `placeSample`. They are feasible by construction, unlike the clip's;
- `centroid` = {com, comVel, comAcc, Ldot} from the **simulated nominal**. The DCM reference the engine builds from it is one the robot has really achieved, so ξ − ξ_ref ≈ 0 on nominal;
- contacts, phase, tau as usual.

**Requests to the balance build.** These are their files; this doc only asks.

1. Add one optional field: `MotionReference.polish?: { authority: 'polished'; gainScale: Float64Array; gyroFF: [number, number]; inTube: boolean }`.
2. While `inTube`, the engine keeps sensing and publishing `BalanceState`. It does not re-IK the stance leg, passes `gainScale` through its impedance module, and drives the gyro with `gyroFF` only. It adds its DCM residual only beyond a 2 cm dead band on \|ξ − ξ_ref\|. Inside the tube, the runtime then equals the optimiser's rollout.
3. The arm and neck behaviours (`hands.ts`, `gaze.ts`, the arm arbiter) stand off polished joints during the move. Gaze is allowed on the neck only if the acceptance replay (§6) still reproduces.
4. The mocap tracker asks `loadPolish(design, moveId)` and the start gate before playing a strike or get-up, and it calls `PolishedPlayer` instead of `MotionPlayer` when both pass.

**Abort.** The move hands full ownership to the engine (recover or brace mode, 0.1-0.2 s inertialized blend) when any of these happens:

- any feature leaves the trust tube × 1.5;
- ξ leaves the support shrunk by 1 cm while the move plans no step;
- a contact appears that the plan doesn't have (a block, a clinch, the fence).

After the move and its 0.3 s settle tail, ownership returns to the engine with at least 0.5 H of gyro reserve.

## 6. Proving it reproduces

Acceptance replays the stored move from t = 0 in the full `compileWorld()` scene, through the game's own systems, with the opponent parked far away. It passes only if:

- the nominal replay matches the optimiser's rollout to **joint RMS < 0.5°**;
- the mirrored (southpaw) replay also passes every gate. If it doesn't, southpaw plays raw until a southpaw entry is optimised separately.

**Honesty assertions.** These run in every nominal and validation-nominal rollout and fail the job:

- `xfrc_applied` equals the GyroCore couple on the torso and is zero everywhere else;
- the `body_mass` checksum is unchanged;
- the `eq_active` pattern is unchanged after release;
- `opt.timestep` is 0.001;
- `qfrc_applied` is zero.

The compat hash stored in `index.json` covers:

- the compiled robot MJCF string;
- the design's motor catalog entries;
- the gyro spec;
- the physics option string;
- the `PolishedPlayer` version.

A test recomputes the source hashes of `motors.ts`, `gyro.ts` and the player, and marks the design's polish `stale` when any of them changes. The runtime refuses a stale or mismatched entry and plays the move raw. A stale polish can never ship.

## 7. Robustness plan

### 7.1 Scenarios (Pass B and the gain pass)

Scenario 0 is always nominal. The others draw from:

- **Start state:** one of about 200 guard snapshots recorded from `fight-sim` runs, plus the end states of likely predecessors (guard idle, shuffles, the recovery of each strike).
- **Damage:** 1-3 random joints at health 0.6-1.0 with backlash slop; windings at 40-80 °C; battery 0.5-1.0; gyro health 0.5-1.0.
- **Latency:** 0-4 ms of reference jitter, and a different backlash rng seed.
- **Pushes:** in about one scenario in six, a 0-25 N·s torso push at a random time, standing in for an opponent's hit.
  - Pushes never appear in the nominal, never in what is stored, and never in the reproduction check.
  - If Chris wants no xfrc in optimisation at all, they are replaced by initial-velocity noise, at some cost to robustness.

### 7.2 Validation (per move, full world)

- 100 Monte-Carlo replays drawn from the scenario distribution.
- A push ladder: 0.1 s torso pushes in 8 directions, raised in 2.5 N·s steps until the robot falls, at the move's riskiest instant.
- For strikes, 20 replays with the real opponent standing at the target, so the landed impact (p90 30-50 N·s in logged fights) hits the thrower's own trajectory.
- The trust tube is recorded per 0.1 s knot: the 95th percentile of \|δφ\| over the successful replays, for 10 features (torso roll and pitch, pelvis height, COM relative to support 2, COM velocity 2, L 3).

### 7.3 Damage in play

Inside the validated envelope, the move plays as stored with its feedback. Outside it, the gate or the abort falls back to the balance engine. A damaged fighter loses his polished moves one at a time and fights with the plain tracker; he doesn't fall mid-move.

## 8. Stored format

One file per move, lazily loaded: `src/robots/motions/data/polished/<design>/<moveId>.json`. It is stored orthodox, and the int16 blobs are base64 via `codec.ts` at QUANT.angle = 5e-4 rad.

```jsonc
{
  "format": 1, "design": "savate", "move": "cross.13_17.1024",
  "status": "polished",             // or "infeasible" | "failed" (with reason)
  "hash": "…",                      // must equal index.json and the runtime's computed hash
  "rate": 1.08, "impact": 0.21, "impactSpeed": 7.4,
  "knots": 12,                      // 0.1 s spacing in clip time (tail included)
  "warp":  "<int16 × knots, ms>",
  "dq":    "<int16 × 23 × (knots+3) B-spline control points>",
  "gyroFF":"<int16 × 2 × knots>",   // absent on moves that don't use it
  "gain":  "<uint8 × 4 × knots>",   // stance, swing, waist, arms
  "fb":    [/* ~10 float gains */],
  "nominal": "<int16 × 30 Hz × 15 ch: com 3, comVel 3, L 3, pelvis quat 4, ξ 2>",
  "events":  [/* simulated lift/land: side, t, x, y */],
  "tube":    "<uint8 × knots × 10>",
  "envelope": { "startBox": {…}, "minHealth": {…}, "gyroReserve": 0.6, "battery": 0.5 },
  "validation": { "survival": 0.97, "pushLadderNs": [...], "jointRmsDeg": 4.1, "slipCm": 0.4, … }
}
```

Size: about 3.2 KB raw, 4.3 KB as JSON, for a 1.5 s move. That is about 400 KB per design for all 95 polishable moves.

## 9. Proof of concept: 5 moves

Each move is the default pick for its label in the library (`listMoves({ label })[0]`), since that is the move the game plays. Numbers are from the built libraries today:

| # | Move id | Length | Kinematic max speed | What makes it hard |
|---|---|---|---|---|
| 1 | SAVATE `cross.13_17.1024` | 0.78 s | 1.14× | the easy case: feet down, a 9 mm bounce in the recovery |
| 2 | SAVATE `head_kick.135_07.0016` | 1.60 s | 0.89× | the library has **no plain roundhouse**: every head kick is a pivoting switch kick from the same CMU clip as the tornado kicks, turning 125-137°, with 8-11 airborne frames. It gets a take-off block |
| 3 | HAYMAKER `hook.14_03.1228` | 1.07 s | 1.13× | a stance-switching hook with a 1 cm hop, on the heaviest modern design (105 kg) |
| 4 | FIRECRACKER `getup_back.140_09.0027` | 4.40 s | 2.58× | 23 windows, multimodal, 1.8% of joint-frames on a range limit, a 4 cm hop near the end; SAMCON 2010 lost 2/3 of its hardest get-up runs |
| 5 | FIRECRACKER `tornado_kick.135_07.0179` | 1.53 s | 0.98× | 0.33 s airborne at 19 cm, −496° of turn; the gyro has no yaw axis and the canvas torsional friction is 0.005, so the whole spin must come from the pivot before take-off |

What "hyper super human" can mean here: the kinematic ceilings above are before torque limits, so real speed-ups will be smaller. Expect:

- FIRECRACKER get-ups and punches clearly faster than the actor (kinematic max 1.6-2.6×);
- SAVATE and HAYMAKER punches around 1.0-1.1×;
- no kick faster than the actor on any design.

On the heavy designs, the superhuman look has to come from power at impact (heavier limbs at the actor's pace), clean weight transfer and stillness, not tempo.

### 9.1 Steps

1. **Harness (daytime, no heavy CPU).**
   - Build `tools/polish/` and `PolishedPlayer`.
   - Tests:
     - bit-identical restore and replay;
     - the honesty assertions;
     - with zero Δq, zero gains and today's rate, `PolishedPlayer` reproduces raw `MotionPlayer` tracking in the same world;
     - codec and mirror round-trips.
2. **Baseline.** Play the 5 moves the raw way, as the game does today, and measure everything in §9.2. This is the "before".
3. **Night 1:** cross (the pilot, which measures real generation counts and µs per step under load), hook, head kick.
4. **Night 2:** get-up and tornado.
5. **Chris's A/B.** Record joint traces for raw and polished and play them kinematically side by side in the motions harness, in our own browser tab at `localhost:5297`. Chris's eye is the final gate.

Runs are headless: `nice -n 10 npx tsx tools/polish/run.ts --queue poc --workers 4`.

- At most 4 worker processes.
- Each run writes its PIDs to a file.
- Jobs checkpoint after every window and resume.
- A run is stopped only by its exact PIDs after `ps -p <pid> -o command=`.
- Nothing opens a window on Chris's desktop.

### 9.2 Metrics and gates (per move)

| Metric | Gate |
|---|---|
| Nominal falls | 0 |
| Joint RMS vs the clip | ≤ 8° overall, ≤ 6° legs (get-ups ≤ 12°) |
| Root path error | ≤ 5 cm (get-ups ≤ 10 cm); tornado end heading within 30° |
| Planted-foot slip per stance phase | ≤ 1 cm |
| Contact timing vs clip | ≤ 30 ms per event |
| Striker at impact | within the library's gates; speed ≥ 0.9 × peakSpeed × achieved rate, and at least the raw path's |
| Torso rate RMS above 3 Hz | ≤ 0.10 rad/s |
| Planted-leg servo time above 0.85 τ_avail | ≤ 10% of kick phases (today 70-83%) |
| Gyro | peak \|h\|/H ≤ 0.6 on punches, ≤ 0.8 on kicks and flashy moves; ≤ 0.5 at the end |
| Winding temperature rise | ≤ the per-design budget |
| Monte-Carlo survival | ≥ 95% punches, ≥ 85% kicks, ≥ 75% get-ups, ≥ 60% tornado |
| Push ladder at the riskiest instant | report; ≥ 25 N·s mid-kick, ≥ 60 N·s standing on the 80-105 kg designs (balance-engine targets) |
| Runtime reproduction | joint RMS < 0.5° vs the optimiser's rollout |
| Achieved rate | report, against the raw rate |
| Wall time per move | report, against the §10 estimate |

### 9.3 KILL criteria

- **Kill the method** if the cross and the hook, the easy cases, don't beat the raw path on both smoothness (torso rate above 3 Hz) and fidelity (joint RMS, slip) with equal or better survival.
- **Kill the method** if Chris doesn't see a clear difference in the A/B, whatever the metrics say.
- **Kill the method** if runtime reproduction can't be brought under 0.5° RMS. Then "reproducible from stored data" isn't true, and the honesty rule wins.
- **Kill it for kicks, keep it for punches and get-ups** if the head kick doesn't reach 85% survival with ≤ 10% saturation after 3 IPOP attempts. Kicks then stay with balance-engine Phase 3.
- **Before any library run, try the upgrade** if survival misses its gate but nominal quality passes: Liu 2016 per-fragment linear feedback, only with Chris's OK on the grey area.
- **Mark the move infeasible for that design, not the method,** if the tornado or the get-up fails. It is recorded in `index.json` and plays raw or is withheld from Jev.
- **Cut the full-library plan to the top-1-per-label set** if measured cost is above 2× the §10 estimate.

## 10. CPU budget and full-library plan

Unit costs:

- **Measured.** `mj_step` in the one-robot SAVATE world is 33.5 µs (8 contacts), and `motorSystem.pre` is about 10 µs per robot. Today at load 15-17, the 2-robot test world stepped at 54-70 µs.
- **Planning number: 45 µs per robot-step,** times 1.3 for the other builds' load.
- A 0.6 s window rollout costs about 27 ms of CPU.

PoC estimate with 4 workers:

| Move | Windows | CPU-s (before the load factor) | Wall |
|---|---|---|---|
| SAVATE cross, 0.78 s | 5 + ratchet + gains + validation | ≈ 1,300 | ≈ 7 min |
| HAYMAKER hook, 1.07 s | 7 + ratchet + gains + validation | ≈ 1,800 | ≈ 10 min |
| SAVATE head kick, 1.60 s | take-off block + 6, K = 6 | ≈ 2,900 per attempt | ≈ 16 min; 25-40 min with restarts |
| FIRECRACKER get-up, 4.40 s | 23, λ = 24, K = 6, 2 attempts + 1 ratchet round | ≈ 18,000 | ≈ 1.6 h (kill at 3 h) |
| FIRECRACKER tornado, 1.53 s | 150-D take-off block + 4, 3 attempts | ≈ 13,000 | ≈ 70 min |

The PoC fits in 2 nights, with the pilot calibrating everything after it.

Planning rates per clip-second, load included:

- strikes, kicks and angle footwork: about 2,600 CPU-s;
- get-ups: about 5,900 CPU-s;
- flashy moves: about 10,000 CPU-s.

What gets polished. Per design, about 95 moves and 141 s of clip: strikes, kicks, blocks, get-ups, flashy moves and feints/pivots/switches.

What doesn't. Guard idle, shuffles, walks, victory and `kipup_source`, about 35 s per design. The balance engine's footstep plan owns footwork, and a time-indexed polish would fight its step adjuster.

Pre-screen: flight moves with kinematic max speed below 0.6 are marked `infeasible: motors` without spending CPU. That is 21-31 moves on each iron-age design, and 0-2 on the modern ones.

| Stage | Scope | Wall time, 4 workers |
|---|---|---|
| 0 | Wait until motors, impedance and designs are frozen: balance-engine Phase 2 gate passed, and Chris's next-gen chassis decision made. Any change to those invalidates every polish | none |
| 1 | Four modern designs (FIRECRACKER, SAVATE, HAYMAKER, PYLON), top move per label (24 labels, about 40 s of clip) | about 15 h per design (about 210k CPU-s), about 2 nights each, 7-8 nights |
| 2 | Three iron-age designs, top move per label minus infeasible flashy moves | about 8 h each, about 3 nights |
| 3 | The rest of the polish set, ordered by how often Jev picks each move in logged fights, modern designs first | about 4 nights per modern design and 2-3 per iron-age design, about 24 nights for all 7 |

About 875 moves in all (7 designs × about 125). Of those, about 665 are polishable, and the pre-screen removes about 80 of them (78 on the iron-age designs).

The top-per-label library for every design is about 10-11 nights. That is the recommendation. The full set goes only to moves the fights actually use.

Savings to confirm in the pilot:

- Warm-starting a design from another design's polished Δq, which is the same source clip retargeted, should cut generations by about half.
- The head kicks, low kicks and tornado kicks share CMU clip 135_07, so they can warm-start each other.

Re-runs cost the same as first runs. That is SAMCON's known brittleness (09-balance-academic.md §4), and the compat hash makes it safe but not free.

## 11. Risks

- **The physics under us is changing.** `motors.ts`, `humanoid.ts`, the designs and the balance engine's impedance are all being edited, and a next-gen chassis study is running. The PoC answers "does this work" and may go stale. The library waits for Stage 0.
- **The integration contract isn't agreed yet.** Without the `polish` field and the in-tube stand-down (§5.4), the engine's own modulation changes the targets. Then the runtime won't reproduce the rollout, the reproduction gate fails, and the move plays raw.
- **Other target writers.** `hands.ts`, `gaze.ts` and the arm arbiter writing polished joints break exact reproduction. They have to stand off, or be modelled inside the rollout.
- **Flight and spin.** Take-off decides everything and the gyro has no yaw. Expect the tornado to fail on iron-age designs and possibly to ship with less turn on FIRECRACKER.
- **Get-ups.** The reference can't be reached in places. The result may be a valid get-up that looks less like the actor, so the pose weight is lowered on purpose.
- **Local minima at contact switches.** The cost is discontinuous there. Window snapping, IPOP restarts and merges are the mitigation, and they make cost unpredictable. The pilot measures it.
- **Out-of-distribution play.** Chained combos, blocked strikes, clinches and big hits above about 40 N·s leave the tube and abort to the engine. Polish helps most on clean, unobstructed moves.
- **Southpaw mirroring assumes symmetric MJCF.** The mirrored acceptance replay checks it. An asymmetric design needs double storage and double compute.
- **Late-fight heat.** A move polished for 40-80 °C starts can still reach the derate band late in a long fight. The heat term reduces this but can't remove it.
