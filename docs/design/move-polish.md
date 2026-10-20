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

## 12. Proof-of-concept results (2026-10-20)

Built and run the same day Chris said "lets just get on with it", on the robots as they stood at 15:05 (designs file of 14:59; the balance build's motor swaps for P3 were already in it). Every number below comes from rollouts through the real compiled robot, `motorSystem.pre` and `GyroCore` at 1 ms, with nothing else touching the body (checked every control tick by the honesty assertions).

### 12.1 What exists now

| Path | What |
|---|---|
| `src/robots/motions/polish/player.ts` | `PolishedPlayer`: clock at the stored per-frame rate, q = clip + Δq (C2 B-spline), velocity feed-forward, the feedback law, gyro feed-forward; mirror-aware; no allocation per tick |
| `src/robots/motions/polish/format.ts`, `spline.ts`, `hash.ts`, `load.ts` | stored format (int16 base64 via `codec.ts`), the spline, the compat hash, `loadPolish(design, moveId)` (refuses failed or stale entries) |
| `src/robots/motions/data/polished/<design>/` | one JSON per move (20-41 KB for a strike, 68-83 KB for a get-up), `index.json` (hash, source hashes, status, validation), `traces/<move>.json` for the A/B view |
| `tools/polish/*.ts` | rollout world, snapshots, sep-CMA-ES, cost, warm starts, worker pool (nice 10, load-capped), resumable runner, measurement, acceptance |
| `tests/polish/polish.test.ts` | option block and canvas match `world.ts`; bit-identical restore and replay; honesty assertions; zero-Δq `PolishedPlayer` = `MotionPlayer` + the tracker's velocity feed-forward, bit for bit; mirror; codec round trips; stored polishes replay from their file and are fresh |
| `harness/motions.html?mode=compare` | "Polish A/B": mocap, raw physics, (raw + feedback), polished physics side by side, looping, real time or lined up by clip time, the measured numbers in the panel; `motions.compareSheet(name)` exports a labelled contact sheet |

Run it: `nice -n 10 npx tsx tools/polish/run.ts --queue poc --workers 5 --run <name>` (resumes from its checkpoints under `tools/polish/.out/<name>/`; PIDs in `pids.txt`; it measures each move as soon as it is polished, on the same physics). Then `npx tsx tools/polish/accept.ts` for the full-world reproduction check. View: `http://localhost:5297/harness/motions.html?mode=compare&design=haymaker&move=hook.14_03.1228&rawfb=1`.

### 12.2 Where the build departs from §1-§8, and why

1. **The feedback law runs in the nominal too.** §5.2 had it act only on deviations from the simulated nominal, behind dead bands, so the nominal is open loop. On these robots the retargeted stances cannot stand open loop: SAVATE's cross starts with the lead sole 7-13° off flat and the rear foot on its toe edge at 33-76°, and the COM 1.5 cm from the edge of that support. Held still, open loop, it topples in about 1 s, further than a 0.3-0.4 s lookahead can see, so windowed CMA committed early windows that doomed later ones (pilots 1-3). The law now runs whenever the clip stands on its feet alone, against a **stored reference track**: the clip's mass-aware COM moved 2 cm inside the soles it stands on, and the clip's torso attitude. It is part of every rollout the optimiser scores, and the runtime plays the same code on the same stored data, so reproduction is unchanged (bit-identical in the tests). Off its feet (lying, kneeling, airborne) the law is off.
2. **The law is written in physical units.** The rotation form of §5.2 asked the ankles for about ten times more torque than a sole can transmit (132 N·m for a 3 cm COM error on SAVATE, a 32 cm COP shift), which rolled the feet onto their edges; tuning picked zero gains. Now: COP shift Δp = kD·e + kV·ė/ω0 (capped at 8 cm), sent as ankle torque F·(ẑ × Δp)·axis through Δq = τ/kp; the gyro adds the same CMP shift as a couple; the stance hips turn the torso back to the reference tilt. kL (angular momentum against the nominal) is kept at 0 (see 12.6).
3. **Kinematic warm starts instead of the `mj_rne` shift.** Before any rollout: every planted sole is turned flat with its own ankle (the leg above keeps the clip pose), then the COM is moved 4.5 cm inside the support by the legs and waist with the planted soles held (damped least squares on MuJoCo's Jacobians). Per window, a cost-checked iterative-learning step tunes every joint's Δq to the clip before CMA, and again on the joints CMA does not sample after the commit (the deterministic arm offset of §1).
4. **Windows** commit two new control points per joint (the previous point is not re-opened), with a 0.4 s lookahead. Merges and IPOP restarts are in; the speed ratchet, the gain-scale knots, the trust tube and the mirrored acceptance replay are not built yet.
5. **The nominal is stored at 250 Hz** (all 18 channels), so a strike file is 20-41 KB and a get-up 68-83 KB, not 4 KB.
6. **Contact gaps of 5 frames or less are bridged** in the cost: the clip's 9 mm boxer's bounce otherwise reads as a flight phase, and the contact term rewarded the robot for hopping.
7. **Snapshots carry MuJoCo's derived arrays** (actuator force, body and geom poses, `cvel`, ...). `mj_setState` restores only the integration state, while the motor model's heat and the sensing read the previous forward pass; without them a restore was not bit-identical.

### 12.3 What "raw" is

Raw is the retargeted clip played plainly on the servos at today's pace: `MotionPlayer`'s rate table at the tracker's wanted speed (punch 1.8×, kick 1.6× with the 0.6 limit scale, get-up 1.15×), with the tracker's velocity feed-forward. A test holds `PolishedPlayer` with zero Δq and no feedback to it bit for bit. It is the fair baseline for "can the clip itself be played physically": the in-game tracker changes the move (posture offsets, aim warps, the gait), so joint and path errors against the clip would not compare like for like. Raw + feedback adds the polished move's own feedback law to the plain clip, to show what the law alone buys. Each playback starts from the clip's first frame placed on the canvas and held 0.4 s.

### 12.4 Results, round 1 (the PoC run, `poc3`)

Falls: 20 seeds each of a 0.3-0.6 m/s torso push (0.1 s, random direction and moment of the move) and of one random joint at 40-60% health with 0.02-0.05 rad of backlash. "Nominal" is the unperturbed playback; a standing move falls when the torso passes 60°, a get-up fails when it does not end upright at standing height. Tracking numbers are against the clip at the clip time each playback reached, and stop at the fall for a playback that falls (a body on the canvas still "tracks" its joint targets). Torso shake is the torso rate's deviation from the clip's own trunk rotation, above about 3 Hz.

| Move | Playback | Nominal | Push falls | Damaged-joint falls | Joint RMS, all / legs (°) | Pelvis / COM path (cm) | Worst slip (cm) | Torso shake (rad/s) | Pelvis jerk (m/s³) | Striker at impact | Leg servo ≥ 85% | Move time, × human |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SAVATE cross | raw | falls at 0.50 s | 20/20 | 20/20 | 2.6 / 1.4 | 6.3 / 7.1 | 3.5 | 1.77 | 915 | 32 cm, 7.1 m/s (1.05× clip) | 0.46 | 0.62 s, ×1.26 |
| | raw + fb | falls at 0.87 s | 19/20 | 20/20 | 2.6 / 1.6 | 15.1 / 13.1 | 1.7 | 1.51 | 976 | 29 cm, 7.2 m/s | 0.49 | 0.62 s, ×1.26 |
| | **polished** | **stands** | **8/20** | **3/20** | 4.9 / 6.2 | 7.6 / 6.3 | **1.5** | **1.27** | **553** | **3.6 cm**, 4.0 m/s (0.59×) | **0.25** | 1.01 s, ×0.78 |
| HAYMAKER hook | raw | falls at 0.56 s | 20/20 | 20/20 | 7.0 / 3.1 | 10.9 / 11.0 | 6.0 | 2.19 | 789 | 42 cm, 8.9 m/s (1.02×) | 0.46 | 0.73 s, ×1.46 |
| | raw + fb | falls at 0.65 s | 20/20 | 20/20 | 7.1 / 4.4 | 11.3 / 10.7 | 6.7 | 2.21 | 951 | 36 cm, 8.9 m/s | 0.40 | 0.73 s, ×1.46 |
| | **polished** | **stands** | **4/20** | **0/20** | **4.5** / 5.5 | **6.8 / 6.5** | **1.7** | **1.59** | 840 | **2.1 cm, 8.7 m/s (1.00×)** | 0.70 | 0.94 s, **×1.14** |
| SAVATE head kick | raw | falls at 0.69 s | 20/20 | 20/20 | 1.6 / 1.9 | 10.5 / 9.0 | 16.5 | 1.09 | 961 | 31 cm, 4.1 m/s (0.43×) | 0.20 | 1.72 s, ×0.93 |
| | raw + fb | stands | 6/20 | 4/20 | 2.4 / 2.1 | 9.3 / 7.0 | 3.8 | 1.04 | 520 | 19 cm, 3.2 m/s (0.34×) | 0.30 | 1.72 s, ×0.93 |
| | **polished** | **stands** | 9/20 | **0/20** | 3.6 / 4.5 | **7.4 / 6.8** | **3.2** | **0.86** | **360** | **3.5 cm**, 2.6 m/s (0.28×) | **0.12** | 2.52 s, ×0.64 |
| FIRECRACKER back get-up (140_09) | raw | stays down | 20/20 | 20/20 | 1.7 / 1.6 | 37.1 / 39.6 | 10.8 | 0.95 | 602 | – | 0.24 | 3.83 s, ×1.15 |
| | raw + fb | stays down | 20/20 | 20/20 | 1.8 / 1.8 | 40.4 / 42.4 | 10.8 | 0.98 | 596 | – | 0.24 | 3.83 s, ×1.15 |
| | **polished** | **up** | 12/20 | 12/20 | 4.9 / 5.9 | **7.5 / 9.4** | **8.6** | 0.99 | **497** | – | 0.31 | 4.77 s, ×0.92 |
| FIRECRACKER tornado kick | raw | falls at 0.65 s | 20/20 | 20/20 | 2.7 / 3.7 | 22.0 / 19.3 | 7.0 | 3.12 | 1046 | 4.2 cm, 3.7 m/s (0.58×) | 0.42 | 1.50 s, ×1.02 |
| | raw + fb | falls at 1.26 s | 18/20 | 20/20 | 6.6 / 8.2 | 30.0 / 25.8 | 10.3 | 3.23 | 511 | 20 cm, 3.5 m/s | 0.74 | 1.50 s, ×1.02 |
| | **polished** | **stands** | **12/20** | **1/20** | 4.4 / 5.1 | **13.3 / 11.9** | **2.2** | 2.95 | **413** | **2.8 cm**, 2.7 m/s (0.42×) | 0.65 | 1.69 s, ×0.91 |

Other numbers: every playback touches its stall torque somewhere (peak τ/τ_stall 1.00, as the clips are fast), winding heat rises 1-4.5 °C per move, peak gyro |h|/H is 0.4-0.8 on the polished moves. CPU per move: cross 8 min, hook 10, head kick 21, tornado 18, get-up 54 (worker-CPU; 112 min for the five, 27 min wall at 2-5 workers while the other builds held the load at 13-34).

The get-up row is as re-measured at the end (kL set to 0, nominal re-recorded, and the success test of §12.7); the run itself logged 14/20 and 13/20.

**Reproduction (§6).** Replaying each stored file in the full `compileWorld()` scene (cage, both robots, opponent parked on his gantry) against the one-robot rollout it was optimised in: cross 0.000°, hook 0.000° (max 0.001°), tornado 0.0001° (max 0.003°), get-up 0.000°, head kick 0.24° RMS (max 4.4°, the landing). All under the 0.5° gate. The replay from the stored file in the same world is bit-identical (tests).

### 12.5 What round 1 says

- **Every polished move stands where the raw clip falls.** Played plainly on the servos, all five fall (the get-up never leaves the canvas); with the feedback law alone, four of five still fall. Polished, all five complete, with the striker 2-4 cm from where the clip lands it (raw: 31-42 cm off).
- **The hook is the clean win**: on target at the clip's full peak fist speed (8.7 m/s), 14% faster than the actor, 4/20 push falls and 0/20 damaged-joint falls against 20/20 and 20/20, slip 1.7 cm against 6.0.
- **The rest trade tempo and power for balance.** The cross plays at ×0.78 of the human pace with 0.59× the clip's fist speed, the head kick at ×0.64 with 0.28×, the tornado at ×0.91 with 0.42×. The optimiser slowed down because round 1's impact term scored speed against the clip's peak *at the played rate*, so a slow, soft strike scored as on speed, and slowing was only lightly penalised.
- **The tornado turns −135° of the clip's −496°.** It lands the kick and stands, but it is not a tornado yet: the root term's cap made giving up on the spin cheap.
- **The cross ends in a forward lunge** (torso 35-48° forward, 11 cm ahead of the clip's end spot), which is visible in the A/B view: it stands, but it is not graceful. Nothing in round 1's cost watched the torso's lean directly.
- **The get-up rises but is fragile**: 12/20 pushed and 12/20 damaged attempts fail, against 20/20 for raw.

Against the §9.3 KILL criteria: the hook beats raw on smoothness (torso shake 1.59 vs 2.19), fidelity (joint RMS 4.5° vs 7.0°, slip 1.7 vs 6.0 cm) and survival. The cross beats it on smoothness, slip and survival but **not on joint RMS** (4.9° vs 2.6°, raw measured only until it falls at 0.5 s; the polished move bends its legs and waist off the clip to keep the COM over its feet). Reproduction passes. The method is not killed; the cross is the case to fix. Gates from §9.2 not met yet: survival (≥ 95% punches, ≥ 85% kicks, ≥ 75% get-ups) is 40-80% on the strikes and 40% on the get-up; joint RMS ≤ 8° all and ≤ 6° legs is met except the cross's legs (6.2°); striker speed ≥ 0.9 × clip is met only by the hook; tornado heading within 30° is not met.

### 12.6 Round 2: a sharper cost (run `round2`)

Round 2 re-ran the four strikes with: torso tilt against the clip's (weight 10), pelvis heading against the clip's (weight 6, for the spin), the end position in the terminal term, impact speed scored against the actor's own peak instead of peak × played rate, slowing penalised twice as hard, root weight 8, and kL kept at 0 (so the law never reads the nominal it is recording). Then Chris's priority, the back get-ups (below).

| Move | Round | Nominal | Push / damaged-joint falls | Joint RMS all / legs (°) | Pelvis path (cm) | Worst slip (cm) | Striker at impact | Turn (° / clip) | Move time, × human | Kept |
|---|---|---|---|---|---|---|---|---|---|---|
| SAVATE cross | 1 | stands | 8/20, 3/20 | 4.9 / 6.2 | 7.6 | 1.5 | 3.6 cm, 4.0 m/s (0.59×) | 51 / 39 | 1.01 s, ×0.78 | |
| | 2 | stands | **5/20**, 3/20 | **3.9 / 4.7** | **5.5** | 3.2 | **2.4 cm, 5.2 m/s (0.78×)** | 43 / 39 | **0.87 s, ×0.90** | **round 2** |
| HAYMAKER hook | 1 | stands | **4/20, 0/20** | 4.5 / 5.5 | **6.8** | **1.7** | **2.1 cm**, 8.7 m/s (1.00×) | 32 / 30 | 0.94 s, ×1.14 | **round 1** |
| | 2 | stands | 12/20, 1/20 | 4.5 / 5.2 | 8.4 | 2.1 | 5.9 cm, 8.8 m/s (1.01×) | 11 / 30 | 0.91 s, ×1.17 | |
| SAVATE head kick | 1 | stands | 9/20, 0/20 | 3.6 / 4.5 | 7.4 | 3.2 | 3.5 cm, 2.6 m/s (0.28×) | 121 / 126 | 2.52 s, ×0.64 | |
| | 2 | stands | **6/20**, 0/20 | 4.3 / 5.5 | 8.5 | 3.6 | 4.2 cm, **3.3 m/s (0.35×)** | 120 / 126 | 2.52 s, ×0.64 | **round 2** |
| FIRECRACKER tornado | 1 | stands | 12/20, 1/20 | 4.4 / 5.1 | 13.3 | 2.2 | 2.8 cm, 2.7 m/s (0.42×) | −135 / −496 | 1.69 s, ×0.91 | |
| | 2 | stands | 9/20, 0/20 | 4.2 / 5.1 | 13.9 | 6.8 | 6.3 cm, 2.9 m/s (0.45×) | −138 / −496 | 1.51 s, ×1.02 | round 2, **status failed** |

What round 2 says:

- **The cross is now the clearest picture of what the method does**: it stands where raw falls, follows the clip more closely than round 1 (joint RMS 3.9°, pelvis 5.5 cm), throws harder (0.78× the clip's fist speed, raw 1.05× before it falls), and survives 15 of 20 pushes and 17 of 20 damaged joints, at ×0.90 of the actor's pace. Its slip got worse (3.2 cm) and its planted-leg servos sit at ≥ 85% of available torque 45% of the time (round 1: 25%).
- **The hook got worse** (4 → 12 push falls), so round 1's hook is kept. Its round-1 kL was set to 0 and its nominal re-recorded (`tools/polish/renominal.ts`); it still completes, and its numbers are re-measured in 12.8.
- **The head kick is robust but slow**: it stands, 0/20 falls on a damaged joint, but at ×0.64 of the actor's pace with the foot at 0.35× the clip's speed. A slower, softer kick is what this robot can hold with this cost; a speed ratchet (§3.6) is the next step for it.
- **The tornado cannot be made a tornado this way.** It lands a kick on target and stands, but it turns −138° of the clip's −496° in both rounds, with or without the heading term. The windowed search, with 0.4 s of lookahead, never finds the pivot that builds the spin before take-off (the gyro has no yaw axis and the canvas's torsional friction is 0.005, §9). Per §9.3 the move is marked **failed** for FIRECRACKER: `loadPolish` refuses it and the game plays it raw. The kick-and-land result is kept on disk for the record.

### 12.7 The back get-ups (Chris's priority)

`getup_back.140_08` (the one the game tries first on every modern design, `GETUP_PLAN`) and `140_09`, at a third of the strikes' search budget (`--profile lite`), measured the same way. A get-up is "up" when it ends with the pelvis at 80% of standing height or more and the torso at least as upright as the clip's own last frame less 0.15: the CMU actor ends these get-ups bent about 40° forward, and a robot that ends like the actor is up.

| Design, clip | Raw: up? | Polished: up? | Push failures raw → polished | Damaged-joint failures raw → polished | Joint RMS all / legs (°) | Pelvis path raw → polished (cm) | Worst slip raw → polished (cm) | Move time, × human |
|---|---|---|---|---|---|---|---|---|
| FIRECRACKER 140_08 | no | **yes** | 20 → **3** | 20 → 8 | 2.8 / 3.2 | 31.9 → **2.7** | 11.6 → 2.3 | 5.66 s, ×0.77 |
| FIRECRACKER 140_09 (round 1) | no | **yes** | 20 → 12 | 20 → 12 | 4.9 / 5.9 | 37.1 → 7.5 | 10.8 → 8.6 | 4.77 s, ×0.92 |
| SAVATE 140_08 | no | **yes** | 20 → 10 | 20 → 10 | 2.8 / 3.2 | 40.7 → **3.7** | 25.1 → 2.8 | 5.26 s, ×0.83 |
| SAVATE 140_09 | no | **yes** | 20 → 9 | 20 → 6 | 2.7 / 3.0 | 53.3 → 5.4 | 19.0 → 2.6 | 4.66 s, ×0.94 |
| HAYMAKER 140_08 | no | **yes** | 20 → 11 | 20 → 6 | 2.7 / 3.3 | 14.8 → 4.3 | 28.1 → 2.7 | 5.05 s, ×0.86 |
| HAYMAKER 140_09 | no | **yes** | 20 → **5** | 20 → **4** | 3.2 / 3.7 | 58.5 → 9.6 | 15.7 → 2.4 | 4.59 s, ×0.96 |
| PYLON 140_08 | no | **yes** | 20 → **5** | 20 → 7 | 2.6 / 2.9 | 43.7 → **3.1** | 31.2 → 3.5 | 5.20 s, ×0.84 |
| PYLON 140_09 | no | **yes** | 20 → 10 | 20 → 7 | 2.7 / 3.0 | 51.8 → 5.0 | 24.0 → 2.5 | 4.29 s, ×1.03 |

Played plainly, none of the eight gets up (the closest, HAYMAKER 140_08, stands at 4.1 s and tips back over in the settle). Polished, all eight get up and finish in the actor's pose, following the clip's pelvis path to 3-10 cm with soles slipping 2-4 cm (raw: 12-31 cm). They are slower than the actor (×0.77-1.03; the optimiser slows the push-up and the crouch-to-stand) and still fail 15-60% of pushed attempts. Each took 22-26 min of worker CPU. Joint RMS is 2.6-4.9° against raw's 1.1-2.1°, the way a body that really carries its weight differs from one that slides on its back while its joints follow the clip.

### 12.8 What is on disk and what plays

| Design | Move | Status | File |
|---|---|---|---|
| SAVATE | cross.13_17.1024 (round 2), head_kick.135_07.0016 (round 2), getup_back 140_08 and 140_09 | polished | 20-79 KB each |
| HAYMAKER | hook.14_03.1228 (round 1, kL set to 0 and nominal re-recorded), getup_back 140_08 and 140_09 | polished | 21-76 KB |
| PYLON | getup_back 140_08 and 140_09 | polished | 68-78 KB |
| FIRECRACKER | getup_back 140_08 (round 2) and 140_09 (round 1, kL set to 0 and nominal re-recorded) | polished | 73-83 KB |
| FIRECRACKER | tornado_kick.135_07.0179 | **failed**: turns −138° of −496° | 29 KB |

Every shipped file replays bit-identically from its stored data (tests) and in the full game scene to 0.14° joint RMS or better (max 2.4°, a get-up's contacts); all were made on the robots of 15:05 (designs file 14:59), and `index.json` holds the compat hash and the source hashes of `motors.ts`, `gyro.ts`, the player, the spline and the sampler. The balance build is swapping motors (P3): as soon as one of these designs' motors or `motors.ts` changes, the runtime refuses the stale files and plays the moves raw, and `tests/polish` fails until they are re-run (`tools/polish/run.ts`, same queue names). The nominal is stored at 250 Hz, which is most of a get-up file. The comparison traces add 44-176 KB per move under `traces/`, outside the runtime loader's glob (2.3 MB for the whole folder).

**Nothing in the game plays them yet.** `loadPolish` and `PolishedPlayer` are ready; the hook-up is the balance engine's (§5.4 requests 1-4, unchanged). One change to request 2: the polished move's feedback law already runs inside the player, so while a polished move plays the engine must not add its own stance-ankle or gyro balance on top (the same stand-down, now for the whole move rather than "inside the tube").

### 12.9 Cost, and what next

CPU, worker time: the five PoC moves 112 min (round 1, including 54 min for FIRECRACKER's 140_09 get-up at the full budget); the four strike re-runs 55 min; the seven round-2 back get-ups 2.8 h at the lite budget; about 5.6 CPU-hours in all, run with 2-5 workers at nice 10 while the Mac's 1-minute load sat between 10 and 34 from the other builds (the pool drops to 2 workers above a load of 18). The cross and hook take 7-10 min of CPU, a kick or flashy move 18-21, a get-up 22-54.

Next, in order of what it buys:

1. **Speed (the "hyper super human" part).** Only the hook is faster than the actor with full power (×1.14, 1.00× the clip's fist speed). Everything else plays at ×0.64-1.03 and kicks land at 0.35-0.45× the clip's foot speed. The speed ratchet of §3.6 is not built; round 2's impact-speed term moved the cross from 0.59× to 0.78× and the head kick from 0.28× to 0.35×. Build the ratchet, and give the head kick a take-off-block window (§3.4).
2. **Robustness.** Push survival is 70-80% on the strikes and 40-85% on the get-ups, against gates of 95% (punches) / 85% (kicks) / 75% (get-ups). The doc's own upgrade is Liu 2016 per-fragment linear feedback (§1, needs Chris's OK as the grey area under "no training"); cheaper first: Pass B with more scenarios and the gain-scale knots (not built).
3. **The cross's lean.** It still leans 30-40° forward in its recovery, where the actor stays upright; the torso-tilt term reduced it but the A/B view shows it.
4. **The tornado** needs a pivot that builds the spin before take-off; the windowed search does not find it. Either a hand-shaped yaw warm start on the support foot or the take-off block of §3.4 with a longer horizon. Until then it stays `failed` and the game plays it raw.
5. **Integration** (balance build): `loadPolish` + start gate + `PolishedPlayer` in the mocap tracker, the stand-down, mirrored (southpaw) acceptance, and a start-state funnel: these moves were optimised from the clip's first frame held still, and a fighter mid-fight starts elsewhere.
