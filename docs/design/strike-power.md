# Strike power, impact and damage

> **Chris's decisions (2026-10-06):**
> - Damage overhaul: build now. Plumbing first; thresholds calibrated after the P3 strikes are fast.
> - D1 motor swaps: ALL the recommended swaps (shoulders AKE90, waists, elbows after a gantry A/B of the two options, HAYMAKER's hips too), each A/B-tested first.
> - D6 dents: physical, plus a small labelled visual boost (~2x, toggleable).
> - D5 recoil: yes, 0.2-0.37 on hard shells; gloves stay soft. Lands with the contact-tuning stage after P3.
> - Defaults until he says otherwise:
>   - D2: gantry-test both elbow options.
>   - D4: a joint injury in 25-50% of full fights, at most 1 seize per 5 fights, head pops rare and earned.
>   - D7: labelled assumptions where vendors publish no rating.
>   - D8: get-up targets as in section 4.6.
>   - D9: superhuman = elite-human limb speed plus superhuman energy.
>   - D10: the iron-age three get the same strike pass.
>   - D11: neck pitch and realistic rotor inertia go in with the balance build's tuning.


Status: PROPOSAL, 2026-10-06. Audit and design only; no source file was changed to write it.

Chris's ask: punches and kicks thrown by joints at full real power, looking like elite athletes, that move the other robot, dent it where they land, and wreck a joint when the right shot lands on the right part from the right angle. Then (follow-up): fighters built hard like the 2026 China bots, that get knocked down and pop straight back up, with each design taking damage differently according to how it is built.

This doc merges three headless audits run on 2026-10-06 (strike matrix, impact and contact probes, damage and joint-load instrumentation; scratch scripts and raw output listed in the appendix). It says where the power goes today, what to change, who owns each change, how to measure it, and what Chris has to decide.

Ownership. Everything in section 2 belongs to the balance-engine build's P3 stage ("strikes with weight transfer, speed and impact", docs/design/balance-engine.md section 5), which owns `src/physics/control/**`. Sections 3 and 4 are a separate build in `src/physics/damage/**`, `src/robots/` (catalog fields, shell data) and `src/render/**`. Section 4.6 (reactions and get-ups) is the balance build's P4 plus the overnight move polish.

## 0. The short version

- Strikes land at 2-4.5 m/s. An elite boxer's straight punch lands at 9.1 m/s and a Muay Thai shin at about 7 m/s. Impact energy goes with v², so today's hits carry roughly a tenth of a human cross's energy (20-75 J at the best spacing, against about 120 J).
- The motors are not the main reason. Every striking joint already reaches 97-100% of its peak torque and heat is negligible. Six control problems cost most of the speed: strikes start too close, trajectories slow down into the target, the servo's own damping fights fast motion, the hips and trunk barely turn, the body carries no momentum into the shot, and kicks take 0.4-1.4 s to arrive.
- The motor is the real cap in a few places: the waist on every design, SAVATE and HAYMAKER arms, HAYMAKER's 20:1 hips and waist, and FIRECRACKER's and PYLON's torque-starved arms. Real, published catalog swaps fix those, and one of them (shoulder pitch RS04 → AKE90-8) is better on every number at the same mass.
- Effective mass is already fine (an aligned arm passes 6-17 kg against 2.9 kg for a human punch). Once speed arrives, the middle and heavy robots hit with more energy than any human, because they are heavier and their fists are hard. That is the honest kind of superhuman these actuators allow.
- The damage model reads the wrong numbers. Joint wear comes from the external torque through a joint (5-20× what the gear teeth actually carry), so the puncher's own arm wears out faster than its target, every bump counts, and the hit angle barely matters. Dents exist only in the renderer and every modern shell dents the same. Both need rebuilding on real loads and real shell properties, per design.
- Resilience is the other half of the show: hard shells that shrug off jabs, explosive get-ups (EngineAI's T800 stands from supine in about 1.6 s; URKL's top score is 3 s), and damage that is rarer, bigger and earned.

## 1. Where power is lost today (measured)

All numbers are headless MuJoCo with the real `SYSTEMS` (damage on), the modern roster, aggression 1.0. "Long" spacing is 0.9 of the strike's range; "sweet" is the tactics' own throw point.

### 1.1 Contact speed

| Measure | Today | Human reference |
|---|---|---|
| Fist at contact, sweet spacing | 0.9-4.5 m/s, 0.06-0.36 s after the start, about half on the guard | 9.14 ± 2.06 m/s straight punch (Walilko, Viano & Bir 2005, Br J Sports Med 39:710) |
| Fist at contact, long spacing | 2.3-4.8 m/s (cross 2.3-3.8, hook 2.7-4.8, jab 3.0-4.0) | same |
| Fist in real fights (8 headless fights, 530 s) | p50 1.5-2.4, p90 3.2-4.1, max 4.7-8.1 m/s | same |
| Free-air peak fist speed | 3.4-9.4 m/s (hooks highest: SAVATE 9.4, HAYMAKER 8.5) | |
| Shin/foot at contact | 0.3-6.3 m/s (SAVATE front kick 6.3, HAYMAKER shin 5.8) | 5.6-7.2 m/s roundhouse at pad impact (Gavagan & Sayers 2017, PLoS ONE, PMC5571909) |
| Contact speed / own peak speed | 45-70% (SAVATE front kick 1.3/6.3, FIRECRACKER cross 2.3/5.0) | athletes peak at or just before impact |
| Time to contact | punches 0.12-0.42 s (hooks to 0.87), kicks 0.41-1.39 s | |

### 1.2 Why: the six control losses

1. Thrown from too close. At the tactics' throw point the bodies are 0.40-0.65 m apart, centre to centre (`punchRange` sets lo = 0.5 × hi; `SWEET_SPOT` 0.6). Punches connect before the limb is up to speed, often on the guard fists.
2. Profiles brake into the target. Minimum-jerk paths aimed only 0.10 m past the surface (`FOLLOW_THROUGH`, 1.15 lead) are at about half speed when they arrive. Kick knees peak 50-190 ms before contact, so the shin is slowing at impact.
3. Servo damping fights the motion. kp = peak / 0.07 rad and kd = 0.045·kp on every joint. The velocity feed-forward cancels damping only up to 7.8 rad/s (`MAX_VEL_SHIFT_RAD` 0.35). At peak joint speed the damping term is 5-11× the motor's peak torque (SAVATE knee 2,932 vs 323 N·m). The servo, not the motor, limits 25-97% of the motion. In the real strike controller, dropping damping on the striking limb (`r.mem.dampScale` 0.1) took air jabs from 5.3-5.5 to 7.65 m/s and SAVATE's cross from 8.1 to 10.1 m/s.
4. No kinetic chain. Waist yaw reaches 4-14% of no-load speed (0.8-3 rad/s) on every strike. Pelvis yaw peaks at 1.9-4.2 rad/s against 7.8-8.6 rad/s in a human roundhouse. Shoulder, waist and elbow all peak within about 0.1 s of each other. `PUNCH_TRUNK` caps the turn at 0.45 rad because a whipped chest twisted the planted feet (75 capture steps per 135 punches).
5. No body momentum. The thrower's centre of mass moves toward the target at −0.1 to +0.15 m/s at punch contact and 0-0.3 m/s on kicks. Weight transfer is a static 3-8 cm offset (`SHIFT_FWD_M` 0.07).
6. Kicks are slow to arrive and get cancelled. The windup waits up to 1.3 s for the weight shift (`SHIFT_WAIT_S`); swings are planned at 0.6 of no-load (`JOINT_SPEED_FRACTION`, `KICK_LIMIT_SCALE`); several ended "forced" by the capture-step cancel or fell. Head kicks land on the torso or pelvis (`maxElevation` 0.35).

### 1.3 Where the motor really is the cap

Fixed-root gantry throws (controller off, full-power step targets) put a ceiling on arm-plus-waist speed with no hips or legs:

| Design | Arm only | Arm + waist, as built | + servo drag removed | Catalog what-if (+ waist ake90x2, shoulder ake90) |
|---|---|---|---|---|
| FIRECRACKER | 2.6 m/s | 4.1-4.3 | 6.1 | not run |
| SAVATE | 3.0 | 4.1-4.5 | 5.3-6.4 | 6.3 as built, 7.25 with feed-forward; 8.2 with the full stack (waist ake90x3, shoulders ake90x2, elbow ake90) |
| HAYMAKER | 3.3 | 4.8-5.4 | 6.35 | not run |
| PYLON | n/a | 4.55 | 5.5 | not run |

Joint speed as a share of no-load, long spacing: SAVATE arm 0.77-1.02 (speed-limited), HAYMAKER arm 0.63-0.86, HAYMAKER X12 hips and waist 0.74-0.76 of 13.1 rad/s, FIRECRACKER shoulder and elbow 0.36-0.43 but torque-saturated 43-77% of the motion (RS06 36 N·m, RS02 17 N·m), PYLON RS06 elbow 0.27-0.43 (torque-saturated). Waist yaw on SAVATE turns 6-7 of 21 rad/s on the gantry: the RS04 (120 N·m) cannot spin the whole upper body faster. Kick knees reach 0.73-0.90 of no-load, which is already faster than a human roundhouse knee (12.3-16.5 rad/s), so the knees are not the kick problem.

Reading the two views together: the in-fight contact speed (2-4.5 m/s) sits well below even the as-built ceiling, so timing, distance and profile come first. Past that, the servo drag, then the waist and the listed arms, are the hardware-side caps. Hips and legs add on top of every gantry number and have not been measured on the gantry.

### 1.4 Not the problem

- Peak torque use: 97-100% of peak on every striking joint already. `motors.ts` gives the full peak (stall) torque with no rated-vs-peak duration gate.
- Heat: 0.9-1.7 K per strike; 25-32 s of continuous peak before derating on every module.
- Effective mass: aligned extended arm 5.6-17.2 kg from the mass matrix (FIRECRACKER 5.6/6.1 limp/rigid, SAVATE 10.6/12.4, HAYMAKER 14.6/17.2, PYLON 9.3/11.7); shin 8-20 kg. A bent arm on the guard drops to 2.8-5.4 kg, which is the alignment problem in 2.4, not a mass problem.
- Contact duration: 2-26 ms, peak normal force 1.3-7.9 kN for punches and 19-21 kN for HAYMAKER's shin. Contacts are short and hard, not mushy.

### 1.5 What a landed hit does today

- Impulse per contact: punches 3.5-21 N·s (max 38 N·s, a hook to the upper arm), SAVATE front kick 26 N·s, HAYMAKER shin 62-71 N·s (84-88 J). Head breaks need 13-36 N·s on the modern roster, so only kicks can pop a head in one blow.
- Target response 150 ms after contact: centre-of-mass Δv 0.01-0.49 m/s, torso rate 0.6-4.4 rad/s, displacement under 0.12 m in 500 ms. No falls in 23 measured contacts. The head rides on neck yaw only, so it cannot snap back.
- Only about 20% of robot-robot impacts are clean fist→torso/head; fist→fist and fist→forearm dominate.
- Joint health lost over 8 fights: 25.6 from "overload" and 15.8 from the direction-blind impact share. The puncher's own joints took 5.5 of the overload, the victim's 3.9, and 5.0 came with no robot contact at all (footfalls and canvas slams arming the load path). 7 seizes in 530 s at joint health 0.78-0.99. The waist degraded first in 5 of 8 fights and preceded 3 of 4 "down" KOs.
- Dents (render only): a 3 J touch makes a 10.8 mm crater and 10 J makes 19.8 mm on any modern shell. Polycarbonate, UHMW and carbon all clamp to the same softness; thickness is ignored.

## 2. Control side (balance build, P3)

Goal: put the limb's peak speed on the impact frame, with the whole body behind it, on the real motors at full power, with nothing added to the physics. Items are in the order they pay off.

### 2.1 Strike burst mode (servo drag off, torque unchanged)

During windup and strike, the striking chain (stance hip yaw, waist, shoulder, elbow; hip, knee for kicks) tracks the planned velocity instead of fighting it:

- Set `r.mem.dampScale` to 0.1-0.2 on those joints (motors.ts and the feed-forward already honour it, and the balance engine already writes these arrays), or feed the exact planned q̇ through `addVelocityFeedforward` with no 0.35 rad cap for those joints, capped at the motor's no-load speed so the motor model sees the same shift.
- Keep kp. The limb stays stiff at contact.
- Restore normal damping in recovery so the limb brakes (the braking quadrant gives full torque).
- Apply the same mode to get-ups and kip-ups (section 4.6). The servo drag slows them for the same reason. Not yet measured there.

This is velocity-reference tracking, which real drives do. It adds no torque. Measured effect: +35-55% free speed on the gantry; +2-2.4 m/s on air jabs and crosses in the real controller. It raises free speed only; contact speed also needs 2.2 and 2.3.

### 2.2 Ballistic profiles and follow-through

- Replace minimum-jerk-to-the-surface with a quintic that has a velocity boundary condition: speed at the predicted contact equals the planned peak, aim point 0.25-0.35 m through the target.
- Keep driving through contact plus about 30 ms, then brake. Keep the existing 60 ms follow-through window and kp through it.
- Mocap clips: time-warp so the clip's peak-speed frame lands on the predicted contact frame, instead of holding at the impact frame (`ARRIVE_HOLD_S`).
- Plan strikes at 0.9 of no-load speed (today `FIST_SPEED_FRACTION` and `JOINT_SPEED_FRACTION` are 0.6), with the motor model and the balance plan limiting it, not a fixed fraction.
- Whiffs overshoot further. Recovery and the balance plan must expect it; that cost is real and it is how people punch.

### 2.3 Throw distance and entry

- Choose the throw point from the strike's time-to-peak and reach so impact comes at 85-95% of limb extension (elbow about −10 to −20° from lockout), not from a fraction of the range.
- Cut the clinch band out of punch ranges: lo = 0.5 × hi is right for hooks and uppercuts only. Tighten head_kick's minimum range (0.47-0.51 m on SAVATE/PYLON sits inside the clinch band; ring-iq.md item b).
- Enter with the strike: step-in jab and lunging cross (ring-iq.md), not walk-then-throw from inside the guard.
- Aim at the first surface actually in the fist's path, guard included, or route around it through openings. Nine of twelve SAVATE/HAYMAKER punches in one probe hit glove or forearm.

### 2.4 Stiff, aligned arm at impact

In a 5 ms contact the joints cannot stiffen: a 120 N·m shoulder can push back only about 200 N at 0.6 m against 2-7 kN of contact force. So the only physical way to bring body mass into a punch is alignment: shoulder-to-fist line along the strike direction, elbow near (not at) its stop, so the load runs through the bearings and the arm into the torso. Target: effective mass on clean straight punches of 8 kg or more (today 2.8-5.4 kg on bent-arm contacts, 6-17 kg possible).

A locked elbow driven into a hard target loads the striker's own elbow stop. That is real and section 4.3's hard-stop channel will charge it. It is the reason boxers don't punch at full lockout.

### 2.5 Kinetic chain sequencing

Proximal to distal, each segment peaking in turn instead of all joints sharing one `minJerk(k)` in `punchPose`:

| Segment | Peak before impact (punch) |
|---|---|
| Rear-leg push, centre-of-mass drive | about −120 ms |
| Pelvis yaw (rear-heel pivot, stance hip yaw stiffness 0.35, balance-engine section 5.2) | −80 ms |
| Chest / waist yaw | −50 ms |
| Shoulder | −30 ms |
| Elbow | at impact |

- Send the yaw reaction into the gyro core's reserve and a deliberate COP shift, not sole friction. Then restore the waist's share of the clip's chest turn that `PUNCH_TRUNK` cut (turn and maxTurn 0.45 rad, waist 0).
- Kicks: pelvis turnover plus hip abduction for a real horizontal roundhouse. Current hip ranges allow yaw −45° to 70° and roll −35° to 70°; the `kicks.ts` header still says ±40° and under 45° roll, which is stale. A full roundhouse and turning kicks need the approved NEXT GEN T800-style hip.
- Gate on the balance drills. This is where the previous version fell over; it needs the P1 DCM/COP plan to hold.

Literature puts legs plus trunk at about 75% of punch force (a commonly cited 38/37/24% leg/trunk/arm split; the primary source is not checked). This is the biggest lever for human-looking power and the hardest part.

### 2.6 Ground reaction and step-in momentum

- Give the DCM planner a centre-of-mass velocity target into the strike: 0.5-1.5 m/s for a step-in jab or lunging cross, lead foot timed to plant on the impact frame (move "stepping jabs later" from balance-engine section 5.2 into P3), rear-leg push before the arm fires.
- Kicks: skip or switch step that carries the hips into the target. Pre-shift weight within 1/ω0 (0.26-0.31 s), not up to 1.3 s.
- Gate the kick lift on DCM margin before the leg goes up, instead of cancelling after (the `controller.ts` capture-step cancel near line 519).
- Raise head-kick elevation with a pelvis tilt-back and turnover so head kicks reach the head.

Body velocity adds directly to fist speed (1 m/s of step-in is 1 m/s at the fist) and to reach. It raises effective mass only a little.

### 2.7 Peak torque, burst and thermal cost

Already at full peak. Two honest additions, neither of which limits a 0.3 s strike:

- A vendor peak-duration limit (I²t) per module: peak for about 1-3 s, then fall back toward rated. The figure is not published for most modules; mark it as an assumption until sourced. It makes clinch grinding and long holds honest.
- Report strike heat to the brain (`motorTempC` is already in telemetry). 0.7-1.7 K per strike means heat only matters in long combos or after damage raised friction.

### 2.8 Actuator upgrades where the motor is the bottleneck

All parts are already in `src/robots/catalog.ts` or are stacks of catalogued modules under its existing parallel-stack convention (n × torque × 0.95, +0.1 kg coupling per added module). Every swap needs Chris's sign-off, a gantry A/B, and the balance drills before it ships. Do them after 2.1-2.3 so the gain is measured against good control.

| Design | Joint | Today | Proposed | Change | Why |
|---|---|---|---|---|---|
| all four modern | shoulder pitch | rs04 (120 N·m, 20.9 rad/s, 1.42 kg); FIRECRACKER rs06, PYLON rs03 | `qdd.ake90` (170 N·m, 22.0 rad/s, 1.40 kg) on SAVATE/HAYMAKER; see FIRECRACKER and PYLON rows | +42% torque, +5% speed, −0.02 kg | strictly better on every number |
| SAVATE, PYLON | waist yaw | rs04 (120 N·m) | `qdd.ake90x2` (323 N·m, 22.0 rad/s, 2.9 kg) | +1.5 kg | waist turns 6-7 of 21 rad/s today; the single biggest gantry gain (SAVATE fist 4.5 → 6.3 m/s) |
| HAYMAKER | waist yaw | plan.x12 (320 N·m, 13.1 rad/s, 2.37 kg) | `qdd.ake90x2` | +0.5 kg, +68% speed | X12 runs at 0.75 of its 13.1 rad/s |
| HAYMAKER | hip pitch/yaw | plan.x12 | `qdd.ake90x3` (485 N·m, 22.0 rad/s, 4.4 kg), as SAVATE/PYLON's legs are stacked | about +2 kg per joint | kick hips at 0.74-0.76 of no-load; also faster get-ups. Changes HAYMAKER's character (see decision D3) |
| SAVATE, HAYMAKER | elbow | rs03 (60 N·m, 20.4 rad/s) / rs04 | gantry A/B: `rs06x2` (new stack: about 68 N·m, 50 rad/s, about 1.3 kg) vs `qdd.ake90` (170 N·m, 22 rad/s, 1.4 kg) | new catalog stack entry for rs06x2 | human elbow extension in a punch is 22-41 rad/s; RS04/RS03 cap at 20-21 |
| FIRECRACKER | elbow | rs02 (17 N·m) | `qdd.rs06` (36 N·m, 50 rad/s, 0.62 kg) | +0.22 kg | torque-saturated 43-77% of the motion |
| FIRECRACKER | shoulder pitch | rs06 (36 N·m) | `qdd.ak10` (53 N·m, 33.5 rad/s, 0.96 kg) | +0.34 kg | torque-saturated |
| PYLON | shoulder pitch, elbow | rs03 / rs06 | `qdd.ake90` / `rs06x2` | about +0.5 kg / +0.7 kg | RS06 elbow at 0.27-0.43 of no-load, torque-saturated |
| all | knees | | no change | | already above human roundhouse knee speed |

Honest limits: no catalogued module above 120 N·m turns faster than about 22 rad/s, so 22 rad/s is a real ceiling for the big joints. Each upgrade adds 0.5-2 kg and heat, which costs balance and battery. The 8.2 m/s gantry figure is fixed-root with no legs or step.

### 2.9 Joint aim points

Add aim points for joints, not just part centres: the knee from the side and front (low and oblique kicks), the lead elbow, the hip. Choose the strike line so it bends the target joint across its axis or drives it into its stop. `OpponentView` already exposes knee positions; low kicks aim at the thigh centre today (`kicks.ts` LOW_KICK). Feed the zones to the minds' range and target vocabulary (`src/brain/ranges.ts` reads `def.range`; keep it in sync).

### 2.10 Bugs and anomalies to fix on the way

- HAYMAKER's front_kick, low_kick and head_kick intents produced the identical shin-to-shin blow at identical timestamps.
- SAVATE low and head kicks never touched the target in 6 s; PYLON head kick 0 of 3; FIRECRACKER threw 6 of 24 strikes in 6 s.
- One SAVATE jab and one HAYMAKER jab dumped the thrower at sweet spacing.
- Stale `kicks.ts` header (hip range).

## 3. Impact: contact stiffness and what softens hits

### 3.1 Robot-robot contact is inelastic

Robot-robot contacts use solref `0.004 1` and solimp `0.92 0.97 0.002`, the same as the canvas, with no per-pair or priority overrides (`compile-mjcf.ts` geomXml). Damping ratio 1 means zero restitution: the fist keeps pushing at 0.3-1.3 m/s after contact and never rebounds; force peaks on the first 1 ms tick and decays with a time constant of about 2 ms; peak penetration reaches 9.7 mm on the shin hit.

Change:

- Robot shells and strikers get their own solref: time constant 0.002 (2 × the 1 ms step, the stiffest the integrator supports) and damping ratio about 0.3-0.5, which gives restitution of roughly 0.2-0.37, in the range of hard polymer and metal shells. Plastic denting takes the rest of the energy, so e near 1 would be fake.
- Gloves keep a soft solref (about 0.006, damping ratio 1). They are a real cushion and a loadout choice; bare knuckles hit with higher peak force.
- Canvas, fence and posts get `priority="1"` in `world.ts`, so every robot-world contact keeps today's parameters. Feet, balance and get-ups stay byte-identical.
- Expected: impulse up 20-40% (J = m_eff·v·(1+e)), peak force about 2× for the same impulse, a visible recoil of fist and target. This is physics not yet measured in this project; measure before and after.
- Re-check clinches: `tests/control/contacts`, the `tools/fight-sim.ts` blow-up count, and rollback divergence.

### 3.2 Other things that soften hits

| What | Physical? | Action |
|---|---|---|
| Inelastic contact (3.1) | partly a modelling choice | change as above |
| Bent arm, guard contact | real | control, 2.3-2.4 |
| Glove | real | keep; it is the gloves loadout |
| Servo damping drag during the swing | real but over-tuned | control, 2.1 |
| Post-strike pushing split into many impacts: after a strike, robot-robot contact keeps pushing for 300 ms, adding 50-105 N·s; each piece over 4 N·s becomes its own damage event (one SAVATE hook made 9 events in 0.5 s) | accounting artefact | damage build: one strike = one impact episode (first 30 ms), the rest is tagged as a push and scored as a push |
| Effective mass estimated as body + 0.5 × parent (`CHAIN_MASS_SHARE`) for energy | approximation | damage build: use the measured absorbed work (4.2) |

## 4. Damage and consequences (separate build: `src/physics/damage`, `src/robots`, `src/render`)

Principle: damage comes from real loads compared against real ratings of the part that takes them, and each design's numbers come from its own build. A jab on a hardened shell does nothing. A clean, fast, well-aimed shot on the right part does a lot. Damage becomes rarer, bigger, and tied to a place and a cause.

### 4.1 Per-design durability profiles

A `DurabilityProfile` derived from each design's build data, not hand-tuned per design:

- shell material and thickness per zone (torso face, torso side, head, forearm, shin), panel span, frame material and wall;
- per-joint gear type, gear ratio, reflected rotor inertia, gearbox momentary torque rating, crossed-roller tilting-moment and radial ratings (new `MotorSpec` fields, sourced or marked as labelled assumptions);
- head mount factor (already in `headBreakImpulseNs`), mass, fall energy;
- part hp scaled from the shell's yield load and thickness. Today every design has the same part hp (pelvis 900, torso 1400, head 300 in `humanoid.ts`), and the material resistance clamps polycarbonate and UHMW to the same floor (0.4), so HAYMAKER's 7-17 mm UHMW counts the same as FIRECRACKER's 2.5 mm polycarbonate.

Estimated shell numbers (clamped circular plate, 0.12 m span, point load; yield load P_c = π·σy·h²/2, elastic limit E_el = P_c²/2k; scratch `strike-doc/shell.py`). These are estimates, not FEA, and must be checked against published drop-weight data before they set thresholds:

| Shell | Yield load P_c | Elastic energy before a dent | Failure mode | Measured punch peak force today |
|---|---|---|---|---|
| 2.5 mm polycarbonate (FIRECRACKER, SAVATE) | 0.6 kN | about 4 J | dents, whitens, partly springs back | 1.3-7.9 kN: every punch is above P_c, so absorbed work decides |
| 3 mm polycarbonate head (SAVATE) | 0.9 kN | about 5 J | same | |
| 7 mm UHMW average (HAYMAKER) | 1.6 kN | about 4 J | gouges, deforms, never cracks | |
| 17 mm UHMW chest face (HAYMAKER) | 9.5 kN | about 9 J | same | only kicks and big punches pass P_c |
| 2.5 mm carbon (PYLON) | 5.9 kN | about 17 J | does not dent: cracks and delaminates above a threshold, stiffness and part hp drop sharply | hard punches only |
| 2.5 mm 7075 frame (upper arm, thigh) | 4.9 kN | about 8 J | dents | |
| 4 mm Ti-6Al-4V (STRIKER) | 22 kN | about 26 J | dents a little, sparks | |
| 4 mm AR500 (BRUISER, GOLIATH) | 35 kN | about 37 J | barely dents; sparks | nothing in the game passes P_c today except kicks near 20 kN |

The audit's earlier estimate (with membrane stiffening) gave 2.5 mm polycarbonate about 4 mm at 20 J and 11 mm at 60 J; 2.5 mm 7075 no dent below about 33 J; 4 mm AR500 none below about 150 J. The two estimates bracket each other; the build picks one model and validates it.

What each design should feel like:

| Design | Mass | Build | What a hit does | What wrecks it | Δv from a 20 N·s hit | Fall energy |
|---|---|---|---|---|---|---|
| FIRECRACKER | 38 kg | 2.5 mm polycarbonate, 6061 frame, all QDD (backdrivable) joints | dents and scuffs early; gets moved a lot | being moved: knockdowns, and its small RS02/RS06 arm joints overloaded by blocking big shots | 0.53 m/s | 245 J |
| SAVATE | 83 kg | 2.5 mm polycarbonate, 7075 frame, QDD stacks | dents on clean shots; joints forgive (QDD) | knees and ankles from side kicks (bearing channel), head (no headgear, 20 N·s) | 0.24 m/s | 690 J |
| HAYMAKER | 103 kg | 7 mm UHMW average, 15-20 mm chest slabs, sunk hammerhead, 20:1 planetary hips and waist | shrugs off jabs and body shots; gouges, no cracks; hardest to move | its planetaries: a hard shot that backdrives the waist or hip loads the gear teeth about 6× more than a QDD of the same rotor (reflected inertia goes with the ratio squared: 20² vs 8²) | 0.19 m/s | 955 J |
| PYLON | 79 kg | 2.5 mm carbon, high head on a slim neck, QDD | looks untouched until a hard clean shot cracks a panel; then the part is badly weakened | its head (0.85 mount factor) and its long levers (big bending moments at elbow and knee) | 0.25 m/s | 725 J |
| BRUISER (iron) | 236 kg | 4 mm AR500, hydraulic legs and waist | nothing short of a kick dents it; sparks | hydraulic lines (puncture model exists) and falls | 0.085 m/s | about 2,600 J |
| STRIKER (iron) | 146 kg | 4 mm Ti, carbon frame, T800-class legs | sparks, small dents | glass jaw (55 N·s head), carbon frame cracks | 0.14 m/s | |
| GOLIATH (iron) | 408 kg | 4 mm AR500, steel frame, hydraulic | immovable | hydraulics, its mild-steel frame dents (P_c 3.5 kN) | 0.05 m/s | |
| NEXT GEN (later) | PINWHEEL ~76 kg, JACKKNIFE ~43 kg, CAPSTAN ~90 kg | shells not yet specified (docs/design/next-gen-chassis.md) | profiles come out of the same formula once shells are picked; CAPSTAN's exposed yaw drums are a deliberate target | | | |

Chris's "hardened bodies" therefore come in three honest kinds: thick tough polymer (HAYMAKER), hard metal (iron age), and stiff composite that holds until it doesn't (PYLON). Lightweight polycarbonate designs (FIRECRACKER, SAVATE) show damage sooner.

### 4.2 Dents at the contact point, in physics

- Integrate the absorbed work W = ∫F·v_rel dt per contact episode next to the existing peak force. Emit peakForceN, workJ, the striker part, and the contact point and normal in the victim part's frame.
- New `damage/dent.ts`: a dent needs local peak force above P_c and absorbed work above E_el; permanent depth from W − E_el = P_c(δ + δ³/3h²) (or the validated model). Material modes: metal dents; polycarbonate dents, whitens and partly springs back; carbon cracks or delaminates above an energy threshold (crack decal, raised fibres, lower part hp and stiffness); UHMW gouges.
- Split W between the two surfaces by compliance; a hard fist on a soft shell puts most of it into the shell.
- Deterministic in the worker, so replays and late joiners match. Render (`robot-kit/damage/index.ts`) uses the event's depth, radius and mode and caps cumulative depth per vertex. Add `youngsGPa` and `failureMode` to `MaterialSpec`; take thickness from the design's shell per zone.
- A clearly labelled presentation multiplier may stay if Chris wants dents to read on TV (decision D6).

### 4.3 Joint damage by hit angle and location

Replace the `qfrc_constraint > 2× stall` overload in `wear.ts` with three channels computed on armed ticks in a new `damage/joint-loads.ts` (one `mj_rnePostConstraint` call, 11.6 µs against 212 µs per step, only while an impact is armed: under 1% cost):

| Channel | Load | Against | What it represents |
|---|---|---|---|
| Gear | τ_g = actuator_force − J_refl·q̈ | gearbox momentary rating | a strike that backdrives the joint hard: planetaries strip, QDDs backdrive and survive |
| Hard stop | joint-limit constraint rows (efc_type limit, efc_id = joint) | end-stop rating | hyperextension: a straight shot into a locked elbow, a kick to the front of a straight knee |
| Bearing | cfrc_int moment about the joint anchor minus its components along the hinge axes, plus radial and axial force, filtered over about 3 ms | crossed-roller tilting-moment and radial ratings | the hook to the side of the elbow, the low kick to the side of the knee |

Measured today: gear-tooth torque in hits p90 1.0-2.7× stall (max 11.7× elbow); bearing moment at the elbow p50 87-188, max 3,866 N·m during hits against p99 21-45 N·m in normal motion (5-80×); hard-stop torque rare (7 of about 900 armed episodes above 0.5× stall) because strikes are not aimed at extended limbs yet. With these channels, angle and location matter automatically, with no move tags.

Also:

- Arm only the victim's load path, plus the striker's own when its strike lands off-axis or into its own stop. Stop arming on footfalls and canvas slams; gear torque stays below 1.07× stall in normal motion, so the gear channel needs no arming to stay quiet.
- Drop the `JOINT_IMPACT_SHARE` (0.6) path that spreads a part's damage equally into every joint of the part. Keep part hp and armour damage.
- Add a housing hit: a contact within the actuator housing radius of a joint anchor damages that drive's encoder and housing. Real fighters show this as a joint-feedback fault (docs/research/10, section 8): the drive faults out and re-enables (arm drops, then comes back), jitters, or loses torque.
- Make failures deterministic from the channel that failed, with any random band kept narrow (today: 0.6% seize chance per qfrc peak above 8× stall, about 8 seizes per 10 minutes on nearly healthy joints). Outcome by gearbox type: a planetary jams (seize, keeps its locked angle as `motors.ts` does now); a single-stage QDD sheds a tooth and slips (limp, or a torque cap with a slip clunk); a bent shaft binds (frictionloss up, range down, not fully locked).
- Permanent bend: rotate the child body's `body_quat` by the plastic bend angle (capped at about 15°), as `detach.ts` already edits `body_mass`. The forearm is really kinked, punches land off-line, and the render follows because the worker streams xquat. Rollback restores state but not model fields; test the rollback path as for detach.
- Real reflected rotor inertia per motor (`gearRatio`, `rotorInertiaKgM2` or a sourced reflected armature). Today's formula (0.02 + 0.01 × module mass) gives about 0.05 kg·m² on big leg drives against the T800's published 0.243. This changes balance and kick reversals, so it lands only together with the balance build's tuning, not underneath it.
- Ratings not in the catalog (gear momentary or ratchet torque, crossed-roller tilting moment, radial and axial load) are sourced per module; where a vendor does not publish them they go in as labelled assumptions (for example "break at about 2-3× momentary rating, assumed").

### 4.4 Stagger and knockback

- Δv = J / M. Faster aligned strikes and 3.1's restitution give 2-3× today's impulse, which is most of the visible reaction.
- Add the neck pitch (and roll) joint waiting in `humanoid.ts`, on a real servo, so heads snap back and the neck becomes a joint that can be damaged.
- Balance P4 Absorb state (balance-engine section 6): the hit chain drops to 0.6 stiffness and regains at 2/s, so struck limbs give the way back-drivable QDDs do. With the gear channel in 4.3, absorbing genuinely protects joints.
- Recover state: 1-3 capture steps, arms out, the stagger the crowd sees. Knockdowns come from momentum plus the target's own balance limits.

### 4.5 A damaged arm drops its guard

Torque loss alone will not drop a guard: `healthFactor = 0.25 + 0.75·health`, and an arm at 0.35 health still has 51% torque, far above the 15-20 N·m an arm needs to hold itself up. Honest ways a guard drops:

- the drive is limp or faulted (housing hit, 4.3), so torque is zero for the fault time;
- a stripped QDD slips at a torque cap that a held guard plus incoming shots exceed;
- a bent forearm or a seized shoulder at a low angle leaves the guard where the damage put it;
- the fighter chooses to lower a hurt arm to protect it. Publish `bend`, `fault` and `torqueFraction` in `JointTelemetry` so the guard sags with the real torque left, the brain stops leading with a bent arm (`brain/limbs.ts`, `ranges.ts`, `openings/risk.ts` treat only limp/seized as out today), and a damaged knee makes a visible limp from a shorter range and less torque.

### 4.6 Resilience: knockdowns and get-ups as the show

Where it lives:

- Balance P4 reactions (absorb, recover, brace) in `src/physics/control/**`: brace with hands out, the gyro spending its reserve, then a get-up chosen from how it landed.
- Get-up skills: `src/physics/control/getup.ts` and `rise.ts`, the mocap get-up clips (back get-up `140_08`/`140_09` first; FIRECRACKER's is already a move-polish PoC move), the cross-entropy search in `tests/control/getup-search.ts`.
- Move polish (overnight, docs/design/move-polish.md): polish get-ups first on every modern design. Clip rate can already rise to 2.5× in polish (MAX_RATE); the motor model decides what is reachable.
- Burst mode (2.1) on get-up drives.

Today (preview sparring run, `tests/balance/.out/spar-dcm-v7.json`, 2026-09-29): 11 of 18 counted falls got up within the 10 s window, mean 3.5-9.7 s by fighter; HAYMAKER got up once in 3 counted falls.

Real references: URKL scores a rise of 3 s or less as best and 20 s as zero (docs/research/07). EngineAI's published T800 supine-to-stand takes about 1.6 s from first movement, 0.83 s from pelvis lift to full height, by a deep tuck and squat-up on 415 N·m hips and knees (docs/research/10 section 6.1). Shanghai footage shows a sprawl-tuck in about 0.7 s and kip-ups in 1.2-1.6 s (unverified timing).

The motors are not the limit for healthy robots [estimate]: HAYMAKER raising 103 kg by about 0.75 m in 0.83 s needs about 0.9 kW against roughly 1 kW of peak mechanical power per X12 hip and 2.7 kW per ake90x3 knee; FIRECRACKER needs about 0.3 kW against 0.44 kW per AK10 hip and 0.63 kW per RS04 knee. So get-up speed is control, clips and polish.

| Design | Median, healthy (first movement to stable standing) | p90 | Notes |
|---|---|---|---|
| FIRECRACKER | ≤ 1.5 s | ≤ 2.5 s | lightest, fastest; the "back up before the count starts" tagline |
| SAVATE | ≤ 2.0 s | ≤ 3.0 s | |
| PYLON | ≤ 2.2 s | ≤ 3.0 s | high COM, narrow hips, gyro saturates first |
| HAYMAKER | ≤ 2.5 s (≤ 2.2 s after the hip swap) | ≤ 3.5 s | heaviest; slow X12 hips |
| STRIKER | ≤ 2.5 s | ≤ 3.5 s | |
| BRUISER, GOLIATH | ≤ 4 s | ≤ 6 s | hydraulic 7-10 rad/s, 236-408 kg: they lumber up; the contrast is part of the show |
| PINWHEEL (next gen) | ≤ 1.6 s | ≤ 2.5 s | T800 reference |
| JACKKNIFE (next gen) | ≤ 1.3 s; kip-up 1.2-1.4 s | ≤ 2.0 s | carries the kip-up attempt |
| CAPSTAN (next gen) | ≤ 2.0 s | ≤ 3.0 s | |

Success rate with healthy legs ≥ 95% within 5 s. Also measure knockdown-to-guard-up (time from touching down to standing with the guard set) and how often the fighter is hit again in the first second after rising.

Damage limits the pop-up through physics only: a knee below 0.5 health rises on the other leg and both hands (p90 ≤ 5 s); a limp or seized leg needs a one-leg variant (≤ 8 s or fails); both legs out means no rise and a 20 s KO. Those variants need clips and polish; the outcome is never scripted.

### 4.7 Effects and sound by part and cause

- Joint events carry `pos` (xanchor), `cause` (gear | bearing | hyperextension | housing | thermal | detach), `severity` and `bendAxis`. Today the event is `{corner, joint, health, state}` and `event-router.ts` gives joint events no particle effect.
- VFX: a gear strip throws sparks and chips at the joint; a bearing failure crunches with flecks; a hyperextension snaps with a bright flash and the limb shows bent past its stop; a housing hit sparks from the drive cover; a carbon crack throws fibre flecks; UHMW sheds shavings; AR500 and titanium spark; polycarbonate whitens.
- Audio: play at the joint position, not the robot's corner (`broadcast-audio.ts` uses `placeCorner`), voiced by cause.
- Ticker and replay: name the cause ("left knee bearing, side kick").

## 5. Measurable targets and how to measure them

### 5.1 Tools

- Promote the scratch probes into `tools/strike-bench.ts`: the strike matrix (4 designs × 7 strikes × 3 spacings × 2 seeds), the gantry ceiling, effective mass from the mass matrix, and the contact probe. Output JSON per run; fixed seeds.
- Extend `tools/fight-metrics.ts`: contact speed by striking surface, elbow angle at contact, part hit (clean vs guard), absorbed work, target Δv and torso rate, stagger steps, knockdowns from strikes, joint channel loads and failures by cause and role (striker/victim), dents by design and zone, get-up median/p90/success and knockdown-to-guard time.
- Fight sample: at least 8 fights per pairing across the modern four (mirror and cross), same seeds before and after each stage.

### 5.2 Targets

Strike targets scale with size for speed (same joint angular speeds on a shorter limb give less linear speed): the human 9.1 m/s at 1.8 m becomes about 6.6 m/s for FIRECRACKER (1.30 m), 8.7 for SAVATE, 9.2 for HAYMAKER, 9.6 for PYLON.

| Metric | Today | After stage 1-2 (control) | After stage 3 (swaps) | Reference |
|---|---|---|---|---|
| Clean fist contact speed p50 / p90 | about 2 / 4 m/s | ≥ 4.5 / ≥ 6 | FIRECRACKER ≥ 5 / ≥ 6.5; SAVATE, HAYMAKER ≥ 6 / ≥ 8; PYLON ≥ 5.5 / ≥ 7.5 | 9.1 ± 2.1 m/s (Walilko 2005) |
| Shin contact speed p50 / p90 | 4.5-6.3 max | ≥ 6 / ≥ 7.5 | ≥ 7 / ≥ 9 (HAYMAKER ≥ 8 p90) | 5.6-7.2 m/s at pad (Gavagan & Sayers 2017) |
| Contact speed / own peak speed | 45-70% | ≥ 85% | ≥ 85% | athletes peak at impact |
| Punches landing within 25° of elbow lockout | about 0% (−60 to −84° in every probe) | ≥ 60% | | |
| Effective mass, clean straight punches | 2.8-5.4 kg (bent) | ≥ 8 kg median | | 2.9 kg human |
| Clean power punch impulse p90 | 21 N·s | FIRECRACKER ≥ 20, middle ≥ 35, HAYMAKER ≥ 50 | FIRECRACKER ≥ 25, middle ≥ 45, HAYMAKER ≥ 70 | human about 26 N·s (2.9 kg × 9.1 m/s) |
| Clean power punch energy p90 | about 33 J | ≥ 80 J middle/heavy | ≥ 150 J SAVATE/PYLON, ≥ 200 J HAYMAKER, ≥ 60 J FIRECRACKER | about 120 J elite cross |
| Kick impulse p90 | 26-71 N·s | ≥ 60 | ≥ 80 middle/heavy | |
| Clean share of strike contacts (torso/head) | about 20% | ≥ 35% | | |
| Target Δv after a clean power shot | 0.01-0.49 m/s | ≥ 0.5 m/s median (middleweights) | | |
| Stagger (≥ 1 recover step) after a clean power shot | rare | ≥ 30% (with P4) | | |
| Knockdowns from strikes per fight | about 0 (falls are mostly self-falls) | 1-3 | | |
| Self-falls | baseline per balance gate | no more than +10% over baseline | | |
| Fight time to first strike, landed/min | pace stage targets (≥ 30 thrown, ≥ 20 landed per minute) | unchanged or better | | |

Damage targets (game-design calibration, decision D4; set after stages 1-3 from measured distributions, never before):

| Metric | Today | Target |
|---|---|---|
| Joint health lost from blocks, jabs, footfalls | most of it | about 0 on every design |
| Striker share of its own joint damage | 5.5 vs 3.9 victim | ≤ 10% of all joint damage, all of it from its own off-axis or locked-out strikes |
| Seizes | about 8 per 10 min, at health 0.78-0.99 | ≤ 1 per 5 fights, always tied to a named overload |
| Any joint injury (degraded or worse) | most fights | 25-50% of full-length fights |
| Joint wrecked (seized, stripped, bent, limp) | | ≤ 1 per 3 fights |
| Waist as first degraded joint | 5 of 8 fights | no single joint over 30% of first injuries |
| Visible dents per minute of exchanges | about 24 (half of 48 contacts) | HAYMAKER and iron age about 0 from non-clean hits; polycarbonate designs dent on ≥ 50% of clean power shots |
| Head pops | kicks only (after P3: a routine jab, see §8) | rare and earned: well under 1 in 4 fights, only from the hardest clean blows (§8: 2 of 32 fights) |
| Step cost of the damage probe | n/a | ≤ 3% |

## 6. Honesty rules

1. No hidden or injected forces, impulses, torques, gravity multipliers or pin forces. Every force comes from a motor inside its torque-speed, heat, health and battery limits, the gyro inside its torque and momentum, the ground, or a contact.
2. Real published actuators only. A stack of catalogued modules uses the catalog's existing load-share convention and shows its derivation in `source`.
3. Control may choose targets, timing, stiffness and damping, as a real drive's controller can. It may not add torque.
4. The velocity feed-forward is capped at the motor's no-load speed, and the motor model sees the same shift.
5. Contact parameters stay inside what the integrator supports (time constant ≥ 2 × dt) and restitution stays in the range of the real materials.
6. Ratings and material constants come from vendor sheets or references, or are labelled as assumptions in the code and here.
7. Thresholds (clean speed, head break, overload ratings once sourced, dent multiplier) follow measured strike distributions. Never lower them to fake impressive breaks.
8. Any presentation-only exaggeration (dent depth, hit-stop, shockwave) is labelled as presentation and never touches physics state.
9. Damage is deterministic in the worker so replays and late joiners match; any random band is narrow and seeded.
10. Every gain is measured with the same seeds before and after. "Should be faster" is not a result.

## 7. Build order and what Chris must decide

### 7.1 Order

| Stage | What | Owner | Gate |
|---|---|---|---|
| 0 | `tools/strike-bench.ts` and fight-metrics fields (5.1); record the baseline | damage build (tools only) | baseline JSON saved; no behaviour change |
| 1 | Burst mode (2.1), ballistic profiles and clip time-warp (2.2), throw distance and entry (2.3), alignment (2.4), kick pre-shift and speed fraction (2.6 kick items), anomalies (2.10) | balance P3 | stage 1-2 column in 5.2; balance drills pass |
| 2 | Kinetic chain (2.5), step-in momentum and rear-leg drive (2.6), joint aim points (2.9) | balance P3 | balance drills; self-falls within +10% |
| 3 | Catalog swaps (2.8), each gantry A/B first, then fights | balance P3 with Chris's sign-off; catalog edit in `src/robots` | stage 3 column; balance drills per design |
| 4 | Contact solref, gloves, world priority (3.1), one-strike-one-impact accounting (3.2) | damage build | clinch and blow-up tests; impulse +20-40% |
| 5a | Durability profiles and new `MotorSpec`/`MaterialSpec` fields, three joint-load channels, dent physics, drive faults, bends, joint events with position and cause, VFX and audio (4.1-4.3, 4.7) | damage build (`src/physics/damage`, `src/robots`, `src/render`) | plumbing can start in parallel with stage 1; tests on recorded hits |
| 5b | Calibrate thresholds and damage-rate targets from stage 1-3 strike distributions | damage build | damage table in 5.2 |
| 6 | Reflected rotor inertia in `humanoid.ts` | coordinated with balance tuning | balance drills re-pass |
| 7 | Neck pitch joint, P4 reactions, get-up polish and the get-up targets (4.4, 4.6) | balance P4 + overnight move polish | get-up table in 4.6 |
| 8 | Brain wiring: degraded/bent/fault awareness, joint target zones, favouring a hurt limb (4.5) | brain follow-up | |

Stage 5a can be built while P3 runs because it lives in other directories, but its thresholds must not be tuned until stage 3's strikes exist; tuned on today's 2 m/s punches they would over-fire later.

### 7.2 Decisions for Chris

- D1. Catalog swaps: approve the table in 2.8 (all, some, or none). The shoulder-pitch AKE90 swap is better on every number; the waist and HAYMAKER hip swaps add 0.5-2 kg per joint.
- D2. Elbow choice for SAVATE/HAYMAKER/PYLON: a new two-RS06 stack (fast, 50 rad/s, lighter torque) or AKE90 (strong, 22 rad/s). Recommendation: gantry A/B both, keep the faster one if balance holds.
- D3. HAYMAKER's planetary hips and waist: keep them as a designed weakness (strong, slow, and the gear teeth are its soft spot under the new damage model), or swap to AKE90 stacks (faster kicks and get-ups, loses that character).
- D4. Damage-rate targets in 5.2: how often a fight should see a joint wrecked, a seize, a head pop.
- D5. Contact restitution 0.2-0.37 for hard shells: allow the visible bounce?
- D6. Dents: physical size only, or a labelled presentation multiplier for broadcast readability?
- D7. Ratings the vendors do not publish (gear break, crossed-roller moment): accept labelled assumptions, or source each before stage 5b?
- D8. Get-up targets per design (4.6), including the deliberately slow iron age.
- D9. "Superhuman": these motors reach elite-human limb speed at best (big joints cap near 22 rad/s; only RS06-class arms go faster). The superhuman part is energy and impulse from mass and hard fists. Is that the right reading?
- D10. Should the iron-age three get the same strike pass, or stay as they are?
- D11. Neck pitch joint and reflected rotor inertia both touch `humanoid.ts` and balance tuning: confirm they go in with the balance build (stage 6-7), not before.

## 8. Calibration after P3 (stage 5b), 2026-10-20

Measured on the P3 strikes (fists 4-5.7 m/s peak), headless, `SD_BALANCE=dcm`, House Mind, the four judge pairs (SAVATE v HAYMAKER, FIRECRACKER v PYLON, SAVATE v FIRECRACKER, HAYMAKER v PYLON) × seeds 1-8 × 90 s, robots frozen at e97fe26 so the parallel hardware stage's edits did not move the numbers. Every head contact was traced with its cause, part, impact impulse and the attacker's limb.

### 8.1 Why heads popped

- Symptom: FIRECRACKER's head came off live at 0:28 and 0:14 with "0 significant strikes, 0 J peak hit" on the result card. In the judge's 48 sparring fights, 23 of FIRECRACKER's 24 fights ended by its head at 4-55 s.
- Cause 1: the one-blow ratings sat at the median clean head blow. They were set when strikes landed at 2-4.5 m/s, as head mass × 10 m/s × mount factor (FIRECRACKER 13 N·s, SAVATE 20, HAYMAKER 36, PYLON 19). After P3, FIRECRACKER's clean head blows measure 12-14 N·s median and 15-16 at p90, so a routine jab popped it. All 20 pops in the before set were fist strikes flagged clean (jab, hook, cross at 4.6-8.4 m/s). None came from a fall, the canvas, the cage, debris or the neck's own load or heat.
- Cause 2: the rating was compared with the strike's whole 30 ms window, so the lean after the blow counted. 5 of the 20 pops only reached the rating that way (HAYMAKER's 36 N·s head came off a 21.6 N·s blow).
- Cause 3 (latent): the accumulated-damage break (`BreakSpec.damage` 150) was still in pre-overhaul points. Since f96f924 a point is a joule of plastic shell work (×3 when polycarbonate cracks): one 64 J cracking jab booked 182 points. The break was also checked on every contact, including head-first canvas impacts (up to 56 N·s and 131 points in falls), so a battered head could have come off in a fall.
- The result card counts a "significant strike" at 60 J of presentation energy (½·m_eff·v², `src/ui/scorecard.ts`). A head-popping jab carries only 15-40 J of that (30-64 J of measured absorbed work), so the card read 0 and 0 J. Not changed here (UI).

### 8.2 The rule now (`src/physics/damage/detach.ts`, `impacts.ts` `popBlow`)

- A part pops only from one clean blow, which must:
  - be a strike by the other robot, or a thrown prop;
  - have its first and its hardest contact on the part made by a fist, glove, foot or shin, arriving at strike speed (≥ `newStrikeSpeed`, 1.5 m/s);
  - not have met the guard first (the same striking part touching an arm or leg of the struck robot at or before the head, with ≥ `guardMinNs`);
  - deliver an impact impulse (its first `impactWindowS`, 8 ms) of at least rating × `mountScale` (2.0) × mount factor.
- There is no speed threshold: a faster punch only pops a head by landing a harder blow.
- The mount factor is 1 − `mountWear` (0.4) × min(1, health the neck lost to its bearing channel). That channel reads the wrench the mount carries. Gear slips and shell damage do not weaken the mount.
- Falls, the floor, the cage, debris, pushes, leans, blocked blows and accumulated shell damage never pop a part. `BreakSpec.damage` is no longer used.
- The neck is rated as the head's mount. Its bearing floor is `mountBendShare` (0.8) × (rating × `mountScale` / `mountPulseS` 3 ms) × the head's reach from the neck anchor, ÷ (bearingBreak × static factor). It bends only from blows near a pop landing anywhere on the head, and no longer on the RS00 or servo bearing under routine jabs.
- Each pop is booked in `DamageLedger.detaches` with who, what, impact impulse, threshold and mount factor. `tools/fight-metrics.ts` prints them, and `tools/strike-bench.ts` reports the target's mount and pops per trial.

### 8.3 Before and after (32 fights each, same seeds)

| | Before (e97fe26) | After |
|---|---|---|
| Fights ended by a head pop | 20 of 32 (62%); FIRECRACKER 16 of 16, SAVATE 2, PYLON 1, HAYMAKER 1 | 2 of 32 (6%), both FIRECRACKER |
| Time to first head pop | median 18.5 s (4.9-65.8 s) | 33.6 s and 67.6 s |
| What popped them | 20 routine clean fist strikes at 13-21 N·s (blow) | a cross at 8.1 m/s, 34.9 N·s and a jab at 6.2 m/s, 32.9 N·s, against a 26 N·s mount (the top 0.6% of 343 clean head blows) |
| Pops from falls, floor, cage, blocks, pushes | 0 (but possible through the accumulated break) | 0, and impossible by rule (tested) |
| Fights with a joint injury (degraded or worse) | 24 of 32 (75%), mostly necks | 12 of 32 (38%) |
| Fights with a joint wrecked | 10 of 32 (31%) in 24.5 min of fighting | 11 of 32 (34%) in 45.9 min |
| Injured joints per fight-minute | 1.02 | 0.31 |

With the sparring stand-in mind (the one the balance judge used), seeds 1-4: 0 head pops in 16 fights, all to time (the judge's run had 23 of 24 FIRECRACKER fights end by its head). A joint injury in 7 of 16 fights, a wrecked joint in 4 of 16.

The same 16 House Mind fights on the parallel hardware stage's robot edits as they stood at 23:20 (FIRECRACKER RS04 hips, ankle drives, masses moved): 0 pops, a joint injury in 4 of 16 fights, a wrecked joint in 7 of 16 (striker shoulder bends, FIRECRACKER neck-yaw slips and waist bends).

Of the 511 head contacts in the after set, 343 were clean blows. The other 168 could never pop a head:
- 71 pushes;
- 53 leans slower than strike speed;
- 18 heads moving into a held fist;
- 9 blows blocked by the guard;
- 6 that did not land with a striking surface;
- 11 canvas or cage blows, up to 137 N·s.

### 8.4 The rest of the list

- 3-axis wear: every joint of one body reads the same wrench through it, so the bearing channel now books a blow once, on the joint it overloaded most. Gear and end-stop loads stay per axis, since each axis has its own gear train and stop.
- Trunk blows (torso, head, pelvis) now also arm the legs whose feet are on the canvas (`trunkArmsLegs`). Today's blows stay inside the leg ratings: only a little FIRECRACKER ankle gear wear and hip-yaw housing faults from steps.
- Injury share is in the 25-50% target. Most injuries are FIRECRACKER's neck yaw (RobStride 00) slipping teeth when hooks and off-centre jabs spin its light head (0.31 of the yaw torque goes through the rotor's reflected inertia). That is honest physics on an assumed gear rating; a bigger neck drive or a slip clutch is a design call.
- Still open:
  - Striker self-damage is 15-24% of joint loss (target ≤ 10%). It is mostly the striker's own shoulder bearings bending on hooks and downward jabs into FIRECRACKER's head, and wrecked joints sit at about 1 in 3 fights because of it. Some of these hits land with the 3-axis shoulder close to gimbal lock (roll near ±90°), where the bearing carries the moment structurally.
  - The RobStride 04 bearing rating uses a 110 mm housing (`src/robots/catalog.ts`), but the published housing is 120 × 120 × 56 mm (OpenELab). At 120 mm the rating would be 4.8 kN radial and 202 N·m (now 4.4 kN and 169 N·m). This needs a catalog edit.
  - HAYMAKER's forearms gouge from blocks: 1.5-2.9 per fight, 3-6 mm deep, mostly from PYLON's AR500 knuckle plates on 7 mm UHMW. That is consistent with the flat-plate shell model. The fix is thicker forearm guards (a designs change), or a curved-shell model for limb capsules that needs a sourced formula.

### 8.5 For the punch-speed stage

Impact impulse goes with closing speed (J ≈ m_eff·v). Scaling the 343 measured clean head blows: ×1.2 would pop in 9% of fights, ×1.35 (about the gantry's 6-7.7 m/s against today's 4-5.7) in 19%, ×1.5 in 31%. Re-check the head-pop rate once strikes are faster, and re-tune if needed with `SD_TUNE='DAMAGE_TUNING.mountScale=2.2' npx tsx tools/fight-metrics.ts --pairs ... --mind house --balance dcm` (the same seeds before and after). Never lower it to fake pops.

## Appendix: sources and raw data

Scratch probes (session scratchpad `/private/tmp/claude-501/-Users-chrisdimarco-jarvis/35a12cda-55d8-4dbe-b6de-87829408a2a0/scratchpad/`):

- `strike-audit/audit.mts`, `ceiling.mts`, `meff.mts`; output `out-*.json`, `damp-*.json`, `ceil-*.txt` (strike matrix, gantry ceilings, effective mass, damping test).
- `impact-probe.mts`, `probe2.mts`, `swing-ceiling.mts`, `swing2.mts`; logs `batchA.log`, `batchB.log`, `probe2.log`, `swing.log`; data `probe-*.jsonl`, `p2.jsonl` (contact shape, restitution, joint loads, catalog what-ifs).
- `joint-audit.mts`, `joint-audit-lim.mts`, `rne-bench.mts`, `jsum.py`; output `a1-a4.json`, `dmgaudit/b1-b4.json`, `lim1.json` (8 fights, overload attribution, three-channel loads, hard-stop torque, probe cost).
- `strike-doc/shell.py` (shell yield loads and dent estimates in 4.1).

References: Walilko, Viano & Bir 2005 (Br J Sports Med 39:710), punch speed, force and effective mass. RobStride 04 housing 120 × 120 × 56 mm, 1420 g (OpenELab, openelab.io/blogs/learn/robstride04-qdd-120n-m-integrated-joint-bldc-gear-motor-complete-guide; a reseller page, not RobStride's own datasheet). Boira Bernabeu et al. 2016 (repositorio.comillas.edu/xmlui/handle/11531/16610), elbow extension 22-41 rad/s. Gavagan & Sayers 2017 (PLoS ONE, PMC5571909), roundhouse kick kinematics. docs/research/07-china-robot-fights.md (URKL rules), docs/research/10-engineai-fighters.md (T800 get-up, reflected armature, joint-feedback faults), docs/design/balance-engine.md (sections 5-6), docs/design/ring-iq.md, docs/design/move-polish.md, docs/design/next-gen-chassis.md.
