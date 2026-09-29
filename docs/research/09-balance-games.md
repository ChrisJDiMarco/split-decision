# Balance research: games

**Key techniques:**
- Euphoria behaviour architecture: abilities output per-limb target frames, arbitrated by weighted importance, then limb IK controllers (NaturalMotion patent US9449416B2, Chapman & Lowe)
- Reference-space scaling of all behaviour parameters by length, mass and time-to-fall-own-height (Euphoria patent) -> express Split Decision timing in units of 1/omega0
- Euphoria ConfigureBalance knobs: PredictionTime 0.2 s, PredictionTimeHip 0.3 s, LegsApartRestep 0.2 m, AvoidLeg, MinKneeAngle 0.4, BalanceAbortThreshold 0.6, GiveUpHeight 0.5 m, stable 0.3 m/s & 0.3 rad/s, MaxSteps
- Euphoria BodyBalance upper body: arms-out driven by torso angular velocity above 1.2 rad/s and lean above 0.3 rad, leg-coupled arm swing, HeadLook, body turn, MinBraceTime 0.3 s, hand asymmetry 0.3-0.7 s
- Euphoria StaggerFall/CatchFall: per-step stiffness ramp-down, committed protective fall with stiff arms (15) and soft legs (6)
- Cheat forces in shipped systems: Euphoria StayUpright (velocity-gated 0.5-4 m/s forces, 2.5 m/s torques), UE5 world-space controls/physical animation, per-body gravity multiplier, PuppetMaster pinWeight AddForce, TABS/Gang Beasts external forces, Exanima locomotion 'invisible forces'
- Honest alternatives: SIMBICON world-frame torso via stance hip (tau_A = -tau_torso - tau_B) plus foot-placement feedback theta_d = theta_d0 + cd*d + cv*v; Coros 2010 Jacobian-transpose virtual forces
- Gyro budget policy: gyro buys ~0.17-0.19 m extra sole for ~0.35 s; sustained demand above H/tau_bleed (20-57 N·m) saturates it; gate it to emergencies and keep a touchdown reserve
- Combat footwork separate from walking: step-drag shuffles with >=50% double support inside fighting range, gait hysteresis, arrive already square
- DReCon-style residual feedback on mocap without RL: corrections only on hips, knees, ankles, spine and shoulders, postural corrections low-passed (beta 0.2 at 30 Hz, ~0.15 s), capture steps unfiltered
- Contact-driven phase: mocap phase advanced by actual foot contacts, not clip time (Exanima)
- Motion-matching-lite clip selection at each lift-off from actual physical state features
- PuppetMaster-style impact compliance done honestly: scale limb kp down on hit impulse, spread to neighbours, regain ~2/s
- Limb arbitration with lexicographic priority for legs/pelvis and weighted blending only for arms/head
- Anti-chatter hysteresis and minimum hold times (0.3 s) on step, brace and gait decisions

# Game engines: how shipped games make simulated fighters look competent

Lens: shipped games and middleware (Euphoria, Bodycam v0.8, UE5 Physics Control, PuppetMaster, the active-ragdoll indies, Exanima, Half Sword, Ubisoft's physics tracking). I did not edit any project files. I read `balance.ts`, `gyro.ts`, `stepping.ts`, `walk.ts`, `posture.ts`, `feedforward.ts`, `mocap/player.ts` and `mocap/footwork.ts`. Tags: **[src]** means a source says it; **[inf]** means my inference; **[est]** means my estimate.

## Bottom line

1. **No shipped game walks a fully simulated humanoid into a fight.** Characters that look competent are kinematic: motion matching, as in For Honor ([Clavet, GDC 2016](https://gdcvault.com/play/1023280/Motion-Matching-and-The-Road)). Physics comes in only for reactions, as in Euphoria in GTA and RDR, and in Bodycam v0.8. The fully simulated melee games are honest about the cost:
   - Exanima's January 2026 dev diary says walking and running are "the most artificial part of our character physics", built on hand-designed motions "with some invisible forces and essentially hacks to help the character stay upright" ([Exanima, Jan 2026](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1819386365123229)) **[src]**.
   - Half Sword's developers call their body a "unified dynamic physics system" where every new procedural animation "introduces new variables that must be tested and rebalanced" ([Half Sword, Mar 2026](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1827626365753967)) **[src]**.
2. **Most "self-balancing ragdolls" are partly held up by external forces.** Examples: Euphoria's `StayUpright`, UE5 world-space controls, PuppetMaster's pin weight, and TABS, Gang Beasts and Human: Fall Flat. Split Decision rules these out (`docs/research/concept-physical-truth.md`: stabilisers only as parts with mass, power and saturation). The gyro core is the honest version of Euphoria's torque-based `StayUpright`. It should be spent the way Euphoria gates that cheat: only on fast, large errors.
3. **What transfers is Euphoria's structure and tuning knobs, not its cheats.** In practice that means:
   - behaviours that write per-limb targets with importance weights;
   - a balancer that steps on a predicted centre of mass, with explicit restep, give-up and stability thresholds;
   - upper-body behaviours (arms out, head look, brace) triggered by lean and angular rate;
   - stiffness ramps;
   - a committed protective fall instead of flailing.
4. **Bodycam published no technical detail.** Anything beyond "procedural, early, stumble logic added" is inference (section 1).

## 1. Bodycam v0.8: what is actually known

- **May 19, 2026 X post:** "a brand new self-balancing ragdoll system. Operators dynamically fight to recover balance and protect themselves after impacts in real time. Fully procedural." ([Reissad Studio on X](https://x.com/ReissadStudio/status/2056766838034329752); coverage by [80.lv](https://80.lv/articles/ultra-realistic-fps-bodycam-reveals-advanced-self-balancing-ragdolls)).
- **v0.8 release notes (Sep 2, 2026):** a "Stumbling System & Ragdoll" section says only "Added stumbling logic to ragdoll reactions" and "Stumbling is still an early system and will need further polish" ([Steam](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1842846814441066)).
- **Devlogs:** the four v0.8 devlogs cover animation and loadout, sound, trenches, and player-driven fixes. None is a physics deep-dive. A community summary video has a "Ragdolls" chapter at 03:44 ([YouTube](https://www.youtube.com/watch?v=VY3nfKjiEMI)). The auto-captions for the devlogs could not be retrieved.
- **Other channels:** I scanned all 40 recent Bodycam Steam news posts via the Steam API. None has further detail.

**[inf]** Bodycam runs on UE5, and the player moves kinematically, so this is almost certainly a hit-reaction layer. The likely recipe:
- impact, then blend into a physics-driven body that tracks an animation pose (UE's Physics Control or Physical Animation);
- a stumble-step rule when the centre of mass leaves the feet;
- protective arm targets;
- full ragdoll when the stumble fails.

It is the Euphoria model, not a model for fighters who must walk and fight under full physics. The part worth copying for Chris's ask is the *look*: fighting to recover, and protecting the head.

## 2. Euphoria in detail (the reference design)

### Architecture

The Euphoria patent is NaturalMotion US20130222433A1, granted as US9449416B2, inventors Danny Chapman and Thomas Lowe ([Google Patents](https://patents.google.com/patent/US20130222433)) **[src]**. It describes three stages:
- A **behaviour module** runs "abilities" such as balance ("adjust its stance or take steps"), hazard protection ("raising the arms") and wound response. Their outputs are arbitrated "as a weighted combination", with weighting parameters.
- A **limb controller** exists per limb (arm, leg, spine, head, neck). It uses IK to turn target frames into joint targets.
- A **physics module** applies "virtual forces/torques/wrenches".

A second patent adds per-part control restricted to chosen degrees of freedom, via virtual wrenches or simulated springs ([US9177409B2](https://patents.google.com/patent/US9177409B2)).

The first patent also scales every behaviour parameter from a **reference space** by three factors: length, mass, and time. The time factor is the "time taken ... to fall its own height". One behaviour set then fits a dwarf or a giant.

Per his LinkedIn as surfaced in search, Chapman was later "lead Euphoria developer at NaturalMotion" and now works on physical animation at Epic ([LinkedIn](https://www.linkedin.com/in/danny-chapman-a27a5961/)). So UE5's Physics Control plugin is in Euphoria's lineage.

### The balancer's knobs

These are Rockstar's NM message parameters as exposed in GTA V, from the [ConfigureBalance docs](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_configure_balance_helper.html) **[src]**:

| Parameter | Default | Meaning |
|---|---|---|
| PredictionTime | 0.2 s | Step to where the COM will be; larger means fewer, bigger steps |
| PredictionTimeHip | 0.3 s | Hip lean anticipates further ahead |
| LegsApartRestep / LegsTogetherRestep | 0.2 m / off | Re-step if feet end up too wide or too narrow after balancing |
| StepIfInSupport | true | May step even when statically supported |
| AvoidLeg, AvoidFootWidth | off, 0.1 m | Never step across the stance-foot line |
| MinKneeAngle | 0.4 recommended | Keep knees bent |
| OpposeGravityLegs / Ankles | 1.0 | Gravity compensation (0.1 at the ankles in StaggerFall) |
| LegStiffness | 12 (6-16) | Swing damping 1.0; "drunk uses 1.25" |
| BalanceAbortThreshold | 0.6 | Lean at which balance is declared lost |
| GiveUpHeight | 0.5 m | Minimum height of COM above the lowest foot |
| MaxSteps / MaxBalanceTime | — | Step and time budgets before falling |
| StableLin/RotSpeedThresh | 0.3 m/s, 0.3 rad/s | Definition of "balanced" |
| FallType | RampDownStiffness | Failure ramps stiffness down, with options to bend over and reduce gravity compensation |

### Upper body, protection and failure

- **BodyBalance** ([docs](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_body_balance_helper.html)):
  - arm swing coupled to the legs (Elbow 0.9, Shoulder 1.0);
  - arms out on push, driven by angular velocity: multiplier (4, 1, 4), threshold (1.2, 3.0, 1.2) rad/s for (somersault, twist, side-somersault), plus a 0.3 rad lean threshold;
  - head look and body turn toward a target;
  - bracing, with a 0.3 s minimum brace time "so the character doesn't look twitchy" and a 0.3-0.7 s delay between hands "to introduce some asymmetry".
- **StaggerFall** ([docs](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_stagger_fall_helper.html)): lower-body stiffness drops by 0.7 per step after 2 steps (13 falling to 8) so the character falls over plausibly. It also has lean-into-velocity terms and push-off rules.
- **CatchFall** ([docs](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_catch_fall_helper.html)): stiff arms (15), soft legs (6), torso 9, and the arms aimed ahead (+0.4) or behind (−0.3).

### Its cheats

- **StayUpright** ([docs](https://nitanmarcel.github.io/shvdn-docs.github.io/class_g_t_a_1_1_natural_motion_1_1_stay_upright_helper.html)) applies "force based" and "torque based" upright constraints:
  - forces start above 0.5 m/s COM velocity and saturate at 4 m/s;
  - torques are off by default and start at 2.5 m/s;
  - a StepUpHelp "cheat force applied upwards";
  - "cheat torques to face the direction of bullets".
- **ConfigureBalance.ResistAcc:** a "cheat force" resisting floor acceleration.
- NaturalMotion said openly that Euphoria allows "cheating the system with various forces and stronger constraints" ([MCV, 2013](https://www.mcvuk.com/ecstatic-movement-naturalmotion-on-euphoria/)).

The upright cheat is velocity-gated: it is for violent events, not steady posture.

## 3. Who cheats, and what the honest versions are

| System | How it stays up | Honest? |
|---|---|---|
| Euphoria (GTA IV/V, RDR 1/2, Backbreaker, Max Payne 3 ([list](https://en.wikipedia.org/wiki/Euphoria_(software)))) | Joint drives plus balancer, with optional StayUpright forces and torques | Partly |
| UE5 Physical Animation | Non-local mode: `position_strength`/`velocity_strength` "only used for non-local simulation", i.e. world-space drives ([docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PhysicalAnimationData?application_version=5.4)) | No in world mode, yes in local mode |
| UE5 Physics Control | "WorldSpace" controls use the world as parent. Also a per-body `gravity_multiplier` "typically between 0 and 1", and target-velocity multiplier 0, meaning "damping acts like drag" ([component](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PhysicsControlComponent?application_version=5.4), [data](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PhysicsControlData?application_version=5.4), [modifiers](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/PhysicsControlModifierData?application_version=5.4)). ParentSpace controls are joint drives. | ParentSpace only |
| PuppetMaster (Unity) | `pinWeight`: "pinning the muscles to ... their animated targets using simple AddForce" (cheat). `muscleWeight`: ConfigurableJoint slerp drive (honest) ([docs](http://root-motion.com/puppetmasterdox/html/page5.html)). Collision impulses unpin muscles, which regain pin at `regainPinSpeed`, and a `knockOutDistance` from target triggers a fall ([BehaviourPuppet](http://root-motion.com/puppetmasterdox/html/page10.html)). | Mixed |
| Gang Beasts, Human: Fall Flat, Octodad, TABS | "Some sort of external forces" ([jacasch, Medium](https://medium.com/@jacasch/balancing-of-active-ragdolls-in-games-367f146b25fb); search snippet only, page blocked). TABS-style "marionette": hips pulled toward a COM object by constant force ([640Lab](https://medium.com/@640Lab/active-ragdoll-physics-puppeteer-marionette-balance-technique-a2c09a4d8d6a)) | No |
| Exanima | Combat footwork via virtual muscles and a dynamic balancer that "must smoothly take over, sometimes briefly and barely assisting" ([Feb 2026](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1823191198611182)). Walking and running used hacks, now being overhauled | Combat yes, locomotion partly |
| Half Sword | Active ragdoll, rebuilt from scratch in 0.6.1 for "twice as good" performance ([0.6.1](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1835871199308915)). No balance internals published | Unknown |
| Toribash | No balancer; the player sets each joint to contract, extend, hold or relax per turn ([ToriLLE](https://arxiv.org/pdf/1807.10110)) | Yes (falling is the game) |
| Ubisoft DReCon | Motion-matching targets used as open-loop servo targets, plus learned offsets on 10 joints. Notes that methods using external forces trade "physical realism" ([paper](https://www.theorangeduck.com/media/uploads/other_stuff/DReCon.pdf)) | Yes |
| SIMBICON / Coros 2010 | World-frame torso control realised with internal torques only: τ_stanceHip = −τ_torso − τ_swingHip. Jacobian-transpose virtual forces for gravity and velocity ([SIMBICON](https://www.cs.ubc.ca/~van/papers/2007-siggraph-simbicon.pdf), [GBWC](https://www.cs.ubc.ca/~van/papers/2010-TOG-gbwc/index.html)) | Yes |

Split Decision already sits in the honest column:
- the pelvis attitude is commanded in the world frame through leg IK (`posture.ts`: SIMBICON's trick);
- gravity feed-forward uses τ = qfrc_bias − JᵀF_ground, shifted into servo targets by τ/kp (`feedforward.ts`: Coros's Jacobian-transpose idea);
- the gyro enforces conservation of momentum.

So the gains will come from the *behaviour* layer and the *gyro policy*, not from new physics.

## 4. Recommendations for Split Decision

### R1. Spend the gyro like Euphoria spends its cheat torque

**Budget.** Each gyro is worth a sole extension Δ = τ_max/(m·g) for H/τ_max seconds (from specs in `designs/index.ts`):

| Robot | Extra sole reach | Duration |
|---|---|---|
| FIRECRACKER | 70/(38·9.81) ≈ 0.19 m | 24/70 ≈ 0.34 s |
| SAVATE | ≈ 0.17 m | 0.35 s |
| PYLON | ≈ 0.19 m | 0.34 s |
| HAYMAKER | ≈ 0.19 m | 0.35 s |

In short, the gyro buys **one swing's worth of a foot about 18 cm longer**.

**How it fills up.** In `gyro.ts` the bleed makes the steady state h = D·τ_bleed with zero net torque delivered. So a sustained demand D saturates the rotor once D > H/τ_bleed (τ_bleed = 1.2 s):

| Robot | Saturating sustained demand |
|---|---|
| FIRECRACKER | ≈ 20 N·m |
| SAVATE | ≈ 41 N·m |
| PYLON | ≈ 43 N·m |
| HAYMAKER | ≈ 57 N·m |

The handoff's "sat 1.00 while walking" means the gyro is being asked for posture, not rescue **[inf]**.

**Policy:**
- Gate demand the way StayUpright does: zero below a threshold on capture-point excursion outside the support and on torso rate. You already have deadbands (0.16 rad tilt, 0.15 rad/s rate); add the capture-point gate to the tilt/rate terms, not only the COP term.
- Hold a **reserve** (e.g. h ≤ 0.5·H outside emergencies), so the 0.35 s "virtual foot" is available at touchdown.
- Log *reserve at touchdown* as a metric.

Failure mode: if the reserve is too large, torso wobble gets worse, so tune it against the torso-rate RMS.

### R2. Don't walk inside fighting range: shuffle in double support

Euphoria, Exanima and motion-matching games all separate combat footwork from free locomotion, and Exanima says its combat footwork is the robust part.

- **Current state:** walking is single support most of the cycle, with only 0.1 s of double support (`walk.ts`: `DS_S = 0.1`). The FOOTWORK module walks beyond 1.3 m.
- **Proposed rule:** inside about 2 m of the opponent **[est]**, only step-drag shuffles. The lead foot steps and the rear follows, with the COM moved over the new support before the next lift, keeping double support ≥ 50% of the time **[est]**. Walk only to close large distances.
- **Hysteresis:** apply it on distance (e.g. 2.2 m out, 1.8 m in) so the fighters don't flip between gaits.
- **Arrival:** end each approach with the stance already square (a lead step that *lands* in stance), not a walk followed by several squaring steps. Several small correction steps are what reads as "clunky".

### R3. Anticipate like Euphoria

- Use a 0.2 s step-prediction horizon (your ξ-at-touchdown already does this) and a **0.3 s hip lean-ahead**: pre-lean the pelvis toward ξ(t+0.3 s) = p + (ξ − p)·e^{0.3·ω0}.
- Add Euphoria's restep rules:
  - re-step if the feet end up more than hip-width + 0.2·(leg length / 0.9 m) apart, or narrower than a set minimum;
  - forbid landings across the stance-foot line (AvoidLeg, 0.1 m inset).
- Express every timing constant in units of 1/ω0, following the patent's time scale (time to fall one's own height).
- **[est] numbers:** COM ≈ 0.54 × height gives ω0 ≈ 3.7 rad/s for FIRECRACKER and ≈ 3.1 for PYLON. Then the fixed `SWING_MIN_S = 0.34 s` means ω0·T ≈ 1.27 vs 1.05: the small robot's capture point diverges ×3.6 per swing versus ×2.9.

Failure mode: restepping chatters. Hold each decision for at least 0.3 s (the NM brace minimum).

### R4. A Euphoria-style limb arbiter on top of the mocap

Per limb, compute target q_L = Σ wᵢqᵢ / Σ wᵢ and stiffness k_L = maxᵢ(wᵢkᵢ).

- **Legs and pelvis:** do NOT blend. Balance and capture have lexicographic priority, and the mocap leg pose is a reference that balance edits. Averaging a mocap stride with a capture step lands the foot in neither place.
- **Arms** (highest weight first):
  1. Strike (Jev/mocap).
  2. Brace/Catch: when the give-up test (R6) fires, or an incoming strike is predicted within 0.3 s.
  3. ArmsOut: shoulder abduction Δθ = k·max(0, |ω_torso,⊥| − 1.2 rad/s) + k′·max(0, lean − 0.3 rad), with the fall-side arm first. The NM multiplier is 4 rad per rad/s, which starts too large for a guard; begin at 0.5 **[est]**.
  4. Guard idle (mocap).
- **Neck:** HeadLook at the opponent's head in the world frame, always, except in a tuck while falling. A stabilised, locked-on head reads as competence more than anything else, and costs nothing.
- **Arm windmill** as the last stage before a capture step is an honest second gyro **[est]**. A 5 kg, 0.65 m arm has I ≈ 0.7 kg·m² about the shoulder, so both arms at 8 rad/s give about 11 N·m·s, roughly a fifth to a quarter of a gyro. It looks desperate, so gate it hard.

### R5. Residual feedback on mocap, DReCon-style without learning

DReCon plays motion-matched poses as open-loop PD targets. It adds corrections only to {both hips, knees, ankles and toes, spine, both shoulders}. It runs the policy every k = 2 steps of a 60 Hz sim and smooths the corrections with yₜ = βaₜ + (1−β)yₜ₋₁, β = 0.2. That is a time constant ≈ −Δt/ln(1−β) ≈ 0.15 s; the paper chose it because faster corrections looked "twitchy". Runtime was 340 µs per character, 200 µs of it physics ([paper](https://www.theorangeduck.com/media/uploads/other_stuff/DReCon.pdf)).

The hand-built analogue for Split Decision:
- **Swing hip, sagittal and coronal:** SIMBICON's θ_d = θ_d0 + c_d·d + c_v·v, with d and v the stance-ankle-to-COM offset and COM velocity, or your capture-point landing law.
- **Stance ankle and hip:** COP correction.
- **Spine:** hip strategy.
- Low-pass only the *postural* part of the correction (τ ≈ 50-150 ms, β ≈ 0.013-0.04 per 2 ms tick). Keep the capture-step placement unfiltered.

Let the capture law override the clip's landing well beyond `maxSteerM = 0.12 m` when ξ is far out: style yields to balance. Also drive phase from real contacts, not clip time, which is Exanima's "based on what was physically happening rather than what was expected in the reference animation".

### R6. Commit to a competent fall

Declare the fall when either:
- ξ is outside the reachable capture region (|ξ − p_stance| > max step + half sole) and the gyro reserve can't cover the gap; or
- lean > 0.6 rad; or
- COM height above the lowest foot < ~0.28 × body height (Euphoria's 0.5 m, scaled).

Then within one tick:
- lower bodyweight (knees down, gravity compensation ramped out over ~0.2 s);
- CatchFall arms (arms stiff, legs soft);
- chin tuck.

A fighter who drops to a knee and rises beats one who stumbles four steps. Euphoria caps steps and balance time for the same reason. Pair it with the get-up.

### R7. Stiffness and impact compliance

- **Stiffness bands:** use Euphoria's (legs 12, spine 10, arms 9-12, damping about critical) as a *relative* guide: stance leg stiffer than swing, spine stiff, arms firm. Loose arms and spine read "drunk" (NM's drunk presets raise swing damping and shoulder offsets).
- **Implementation [inf]:** treat NM stiffness as natural frequency, so kp = I·ω_n² and kv = 2ζ·I·ω_n.
- **Impact compliance:** PuppetMaster-style but honest. On a hit impulse J, scale that limb's kp by 1 − min(1, J/J_res), spread to the parent and child limbs at about 0.5×, and regain at about 2/s **[est]**. Lowering gains adds no force, and hits then read on screen.
- **Caveat:** feed-forward is delivered as a target shift τ/kp, so the shift grows as kp drops. Clamp it.

### R8. Motion-matching-lite at lift-off

At each lift-off, choose the next footwork clip segment whose start features best match the *actual* state, rather than the ideal state. Features:
- swing sole relative to stance sole (2);
- COM velocity (2);
- ξ − p_stance (2);
- heading error (1);
- phase (1).

Use a weighted L2 distance over about 100 segments. Transition mismatch is where tracking controllers fall, so this removes the most corrections at the source.

## 5. Compute at 500 Hz, ~30 DoF, JavaScript [est]

| Piece | Rate | Cost per robot |
|---|---|---|
| Limb arbiter (6 limbs × ~5 behaviours) | 500 Hz | < 2 µs |
| Gyro gate and reserve, ArmsOut, HeadLook | 500 Hz | < 1 µs |
| SIMBICON/capture feedback, EWMA filters | 500 Hz | < 1 µs |
| Jacobian-transpose force (if added; one `mj_jac*` call, 3×36) | 500 Hz | ~2-5 µs (the WASM call dominates) |
| Motion-match search (100 × 8) | per lift-off, ~3 Hz | ~1 µs per event |

The total is under about 10 µs per robot per tick, against about 95 µs per 1 ms step of physics for two robots. Sampling-based lookahead (rolling the MuJoCo model forward) costs about 300 steps per candidate, so it belongs in offline tuning (your cross-entropy searches), not per tick.

## 6. Failure modes to watch

- **Blending conflicts:** blended leg targets land the foot in neither place (priority fixes it). Blended arm targets are fine.
- **Chatter:** step, brace and gait flips need about 0.3 s holds and distance hysteresis.
- **Over-smoothing:** DReCon's β = 0.2 filter applied to capture steps would add lag. Filter only the posture corrections.
- **Gyro reserve too big:** more wobble. Too small: nothing left at touchdown.
- **Mis-scaling:** Euphoria's metre-valued thresholds assume a ~1.8 m human. Scale by height and ω0 for FIRECRACKER.

## 7. What to measure

Add these to `tools/fight-metrics.ts`:
- gyro reserve at each touchdown;
- double-support fraction inside 2 m;
- steps per recovery;
- time-to-stable (NM: < 0.3 m/s and < 0.3 rad/s);
- torso angular-rate RMS during the approach (a "clunkiness" proxy);
- head-orientation jitter;
- self-falls per minute, split into walk, approach, stance and strike.

**Unverified:** Bodycam's implementation, Half Sword's balance internals, and the Gang Beasts / Human: Fall Flat / TABS force details. The last come from secondary sources that I could only read as search snippets.