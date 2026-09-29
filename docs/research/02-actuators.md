# Actuators, materials, damage and real-world fidelity

**Headline:** Modeling real actuators is now mostly off the shelf. MuJoCo 3.7.0 (April 2026) added a native `dcmotor` actuator (back-EMF torque-speed, current limit, inductance, I²R heating with temperature-dependent resistance, cogging, LuGre friction, onboard PID), and its parameters map one-to-one onto numbers printed on real actuator datasheets. So "every in-game part is a real part with a real spec sheet" is honest and feasible for actuators, batteries, drivers and plate stock. What breaks sim-to-real is impact, fracture, fasteners, spinner contact at about 100 m/s, and balance control for arbitrary legged bodies. A sim win means "buildable within the spec tolerance". It does not mean "will win in real life".

**Recommendation:** Use MuJoCo 3.7 or later as the physics core. Rendering can be three.js through the official @mujoco/mujoco WASM package (still WIP) or a native build. Model every joint with the native `dcmotor` actuator, filled from a JSON "spec card" per real part: Kt, R, L, i_max, J_r, N, efficiency and backlash, with provenance tags and ± tolerances.

Add three small custom per-step layers:
1. A battery-bus sag model that writes V_bus into each motor's voltage limit (controller Vmax, runtime-mutable).
2. Thermal current derating and burnout from the dcmotor thermal state, since MuJoCo does not model derating.
3. An energy-ledger damage model: contact impulses to panel dents, cracks and penetration; fastener shear to part detachment via mjSpec plus mj_recompile. Resolve spinner hits analytically with bite and stored energy, never by raw contact at a 1 ms step.

Run physics at 0.5–1 ms. Scope the first playable class to NHRL-scale wheeled or walker bots (3, 12 and 30 lb, with a walker weight bonus). BOM export there is cheap, safe and honest, and no per-design balance policy is needed.

Add humanoids later as template chassis, G1- or T800-like with swappable actuators and armor, rather than free-form legs. Jev handles tactics at 5–15 Hz over a fast low-level controller. Ship BOM export as "buildable within spec tolerance, not a win guarantee." Before committing, run a one-week spike: two robots with about 25 dcmotor actuators each at 1 kHz in the browser.

# Stream: real joints, real actuators, metal bodies. What "hyper-accurate" needs and how to model it

## Bottom line
- **The motor physics is solved and native.** MuJoCo 3.7.0 (Apr 14, 2026) added the `dcmotor` actuator: "optional electrical dynamics (inductance), cogging torque, thermal resistance variation, and LuGre friction" ([changelog](https://mujoco.readthedocs.io/en/latest/changelog.html)) [doc]. The current release is 3.14.0 (Sep 22, 2026). The DeepMind write-up ([dcmotor.pdf](https://mujoco.readthedocs.io/en/latest/_static/dcmotor.pdf)) [doc] gives the full model. Three things are explicitly **not** modeled: iron losses, magnet-flux derating and thermal current derating. Those need small custom per-step code.
- **Datasheets already publish the needed parameters.** Example: CubeMars AK80-9 V3 lists Kt 0.095 N·m/A, 160 mΩ phase-to-phase, 116 µH, 9:1, rotor inertia 1118 g·cm², 15 arcmin backlash, 0.51 N·m back-drive torque, $479.90 ([CubeMars](https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html)) [vendor].
- **Energy scales decide the game design.** Humanoid punches carry tens of joules. Heavyweight spinners store tens of kilojoules. For humanoids, the largest routine energy events are **falls**, not strikes.
- **No real humanoid fight in 2025-26 was autonomous.** All were human-piloted over a learned balance controller. Jev as the fight mind would be new territory.
- **Where BOM export breaks:** custom structure, impact and fracture, unmodeled actuator dynamics, and balance for user-built legged bodies.

## (a) Electric actuator physics, and what to simulate

**Core equations** (all in the MuJoCo dcmotor doc) [doc]:
- Voltage: v = iR + Kω
- Torque: τ = Ki, so τ = (K/R)(v − Kω), a line falling from stall torque τ₀ = Kv/R to no-load speed ω₀ = v/K.
- Current limit: τ = clip((K/R)(v − Kω), ±K·i_max). This turns the torque-speed plot into a parallelogram.
- Losses outside the clamp: τ_net = … − Bω − τ_c·sgn(ω). Coulomb friction maps to `frictionloss` and viscous drag to `damping`.
- Gearing: J_eff = J_r·N². Gearbox efficiency (typically 70–90%) is modeled as K′ = ηK.
- Inductance adds a current state with time constant t_e = L/R.
- Heat: one lumped thermal node, dT/dt = P/C − (T − T_a)/(R_T·C), with P = i²R(T) and R(T) = R₀(1 + 0.0039·ΔT) for copper.
- Datasheets usually quote a peak current of "5–10× the continuous value" [doc].

**Worked example: AK80-9 into the model** [calc on vendor numbers]
- **Datasheet consistency.** Kv 100 rpm/V gives Ke = 60/(2π·100) = 0.0955 V·s/rad, which matches the stated Kt of 0.095 N·m/A. In SI units Kt = Ke, as the doc says. The datasheet is internally consistent.
- **Implied gearbox efficiency.** Output Kt ≈ 0.095×9 = 0.855 N·m/A. The 28 A peak then gives 23.9 N·m against 22 claimed (about 92%). The 12 A rated current gives 10.3 against 9 claimed (about 88%).
- **Electrical time constant.** L/R = 116 µH / 0.16 Ω ≈ 0.7 ms, about one 1 ms physics step. The stateless (quasi-static) model is adequate at 1 ms. The current state only matters below about 0.5 ms steps or with slew limits.
- **Heat is the real limiter.** Copper heat at peak versus rated current is (28/12)² ≈ **5.4×**. For the RobStride 04 (27 Apk rated, 90 Apk peak) it is (90/27)² ≈ **11×** ([OpenELAB RS04](https://openelab.io/products/robstride04-qdd-120n-m-integrated-joint-motor-module)) [vendor]. Holding a block at peak torque costs heat, not much battery. Fast strikes cost battery. That is a physically honest gameplay trade.
- **Speed envelope.** At 48 V the current limit binds almost up to the no-load speed. The corner is roughly (48 − 28·0.16)/0.0955 ≈ 455 rad/s at the motor, about 480 rpm at the output, against about 570 rpm no-load. This is rough, using line-to-line R. If the bus sags to 40 V, the corner falls to about 355 rpm, so battery sag visibly slows limbs.

**Quasi-direct-drive vs high-ratio servos.** Reflected inertia scales with N². From Wensing et al. 2017 ([MIT PDF](http://www.mit.edu/~pwensing/Papers/Wensing_et_al-2017-TRO.pdf)) [indep]:
- MIT Cheetah: rotor 3.03×10⁻⁴ kg·m² at 5.8:1 reflects to 0.0102 kg·m².
- HUBO: rotor 3.33×10⁻⁶ kg·m² at 160:1 reflects to 0.0852 kg·m². That is about 8× more, despite a rotor about 90× smaller.
- Their impact mitigation factor (IMF) puts Cheetah at 90% of a hypothetical series-elastic version and HUBO at 52%. The paper warns that too-high ratios "can break a leg upon contact."

For a fighting game this is the key physical rule. A high-ratio servo that gets hit feels a large impulsive torque at its gear teeth. That is why Dynamixel-class servos (XM430-W350: 4.1 N·m stall, 46 rpm, 15 arcmin backlash, 82 g, $310.39, [ROBOTIS](https://www.robotis.us/dynamixel-xm430-w350-t/) [vendor]) strip gears. A QDD joint backdrives and survives.

**Series elastic actuators** (Pratt & Williamson 1995, [Semantic Scholar](https://www.semanticscholar.org/paper/Series-elastic-actuators-Pratt-Williamson/e99eda93c1090c606800064f7d904fa006e64332)) [indep] offer shock tolerance, lower reflected inertia and better force control. In MuJoCo an SEA is an extra joint with a spring between the rotor body and the output. That costs one DOF per SEA.

**Pneumatics and hydraulics.** Force is pressure × area, and pneumatic motion is limited by flow (valves and lines).
- Worked example [calc]: a 2″-bore ram at 400 psi gives about 5.6 kN. Over a 6″ stroke that is at most about 850 J, before flow losses.
- SPARC v1.5 ([PDF](https://sparc.tools/SPARC_Robot_Construction_Specifications_v1.5.pdf)) [indep, read directly]:
  - Only non-flammable gases (CO₂, N₂, air).
  - Vessels must be rated for at least 120% of use pressure, with a burst disc at no more than 130% of rating.
  - Anything above 2500 psi, or unregulated, must be pre-qualified.
  - Bots of 12 lb and under are exempt if actuation is at or below 250 psi.
  - Hydraulics above 5000 psi (no accumulator) or 2000 psi (with accumulator) need pre-approval.
- BattleBots:
  - One secondary summary says 2500 psi N₂/HPA is the on-board cap ([robotfighting.org](https://www.robotfighting.org/robot-fighting-pneumatics/)). A fan wiki says 3000 psi regulated to at most 400 psi, and that CO₂ is banned ([fandom](https://battlebots.fandom.com/wiki/Rear-Hinged_Flippers)). **I could not verify either against the current BattleBots rulebook.**
  - Hydra's hydraulic flipper was claimed to flip more than 450 lb [fan wiki].

## (b) Power as a build constraint
- **Voltage sag.** Sag = I × R_internal. Fresh high-rate cells run about 2–5 mΩ; after about 200 cycles about 8–12 mΩ. Real sustained C-rate is often 50–70% of the label ([UAVMODEL](https://blog.uavmodel.com/understanding-lipo-battery-internal-resistance-what-it-means-and-how-to-measure/), [TH3SEUS](https://th3seus.net/guides/power/lipo-c-rating-explained)) [indep, community-grade].
- **Model the bus as one shared state.** V_bus = V_oc(SOC) − I_total·R_pack. Feed V_bus into every `dcmotor` as its voltage limit. `controller:Vmax` sits in gainprm[7] and can be changed at runtime ([dcmotor.pdf](https://mujoco.readthedocs.io/en/latest/_static/dcmotor.pdf)). One sagging pack then shrinks every joint's torque-speed envelope at once.
- **Phase current is not battery current.** At stall, a motor draws high phase current but low bus power, because τω ≈ 0. At speed it is the reverse.
- **Real budgets:**
  - Unitree G1: 13-series Li-ion, 9000 mAh (about 0.43–0.49 kWh), about 2 h, 35 kg ([Unitree](https://www.unitree.com/g1)) [vendor]. That averages around 220 W.
  - ODrive Pro: 12–56 V, 70 A continuous / 100 A peak, 3 kW continuous / 5 kW peak, 8 kHz loop, $229 ([ODrive](https://shop.odriverobotics.com/products/odrive-pro)) [vendor].
  - NHRL caps nominal voltage at 75 V without approval ([NHRL 2026](https://wiki.nhrl.io/wiki/index.php?title=NHRL_Open_Rules_-_2026)); SPARC caps it at 48 V ([SPARC](https://sparc.tools/SPARC_Robot_Construction_Specifications_v1.5.pdf)).

## (c) Starter parts catalog (real parts with published specs; all [vendor] unless noted)

| Part | Key specs | Price | Source |
|---|---|---|---|
| CubeMars AK80-9 V3 (QDD) | 9 / 22 N·m, 12 / 28 A, 48 V, 570 rpm no-load, 9:1, 490 g, R 160 mΩ, L 116 µH | $479.90 | [cubemars](https://www.cubemars.com/product/ak80-9-v3-0-robotic-actuator.html) |
| RobStride 02 | 17 N·m peak, 7.75:1, 405 g | ~$240 | [roboticscenter](https://www.roboticscenter.ai/store/product/robstride-02) |
| RobStride 03 | 60 N·m peak, 880 g | ~$225 | [roboticscenter](https://www.roboticscenter.ai/store/product/robstride-03) |
| RobStride 04 | 40 / 120 N·m, 27 / 90 Apk, 2.1 N·m/Arms, 0.16 Ω, 0.211 mH, 200 rpm, 9:1, 1420 g, ±10% tolerances | €254.95 | [openelab](https://openelab.io/products/robstride04-qdd-120n-m-integrated-joint-motor-module) |
| Unitree GO-M8010-6 | 23.7 N·m max, 6.33:1, 30 rad/s @ 24 V, 40 A, ~530 g | n/a | [Unitree shop](https://shop.unitree.com/products/go1-motor) |
| MIT Mini Cheetah actuator | 17 / 6.9 N·m, 6:1, 610 g, 40 rad/s @ 24 V | open design | [arXiv 2110.02799](https://arxiv.org/pdf/2110.02799) [indep] |
| MyActuator RMD-X8-60 (36:1) | 60 N·m peak, 48 V | n/a | [MyActuator](https://www.myactuator.com/x8-60-details) (medium confidence) |
| Dynamixel XM430-W350-T | 4.1 N·m stall @ 12 V, 46 rpm, 82 g | $310.39 | [ROBOTIS](https://www.robotis.us/dynamixel-xm430-w350-t/) |
| Dynamixel XH540-W270 | 12.9 N·m stall @ 14.8 V | n/a | [ROBOTIS](https://www.robotis.us/xm/) |
| AmpFlow E30-150-24 (brushed) | 5600 rpm, 5.0 N·m stall, 1.0 hp, 3.6 lb | $89 | [AmpFlow](https://www.ampflow.com/motors/highPerformance/threeInch/) |
| AmpFlow A28-400 (24 V) | 4900 rpm, 25.1 N·m stall, 4.3 hp, 6.9 lb | $569 | same |
| Flipsky 63100 190KV (BLDC) | 100 A, 5.5 kW max, 1.4 kg | n/a | [Amazon listing](https://www.amazon.com/Sensored-Outrunner-Brushless-Skateboard-Longboard/dp/B0BPCBPTFV) |
| Repeat Drive PRO (3 lb class) | 2207.5 motor + 24 mm 27:1 gearbox | n/a | [itgresa](https://itgresa.com/product/repeat-drive-pro-brushless-gearmotor/) |
| Beetle/ant weapon motors | typically 1000–3000 KV | n/a | [Repeat](https://repeat-robotics.com/product-category/beetle/?products-per-page=20&add-to-cart=2293) |
| Complete humanoids | G1: 1.32 m, 35 kg, 23–43 DOF, knee 90 / 120 N·m, $13.5k base. EngineAI T800: 173 cm, 75–85 kg, 450 N·m peak joint torque, aluminum, active leg cooling | see sources | [Unitree](https://www.unitree.com/g1), [URKL](https://urkl.org/t800) |

Scale check [calc]: about 23 RobStride-class actuators at roughly $225–255 each come to about $5.5k in actuators for a DIY G1-class humanoid, against $13.5k for a G1.

## (d) Materials

| Material | Density (g/cc) | Yield | Hardness / toughness | How combat builders use it |
|---|---|---|---|---|
| AR500 | ~7.85 (steel) | ~1.25–1.4 GPa | 477–534 HB ([MWalloys](https://www.mwalloys.com/product/ar500-steel-sheet/)) | Lifters, hammers, wedges, armor. Heating above ~500 °F anneals it ([iRobotics](https://irobotics.illinois.edu/w/index.php/30lb_Combat:_Materials)) |
| Hardox 500 | ~7.85 | 1400 MPa typical | 470–530 HBW; Charpy 37 J at −40 °C ([SSAB](https://www.ssab.com/en-us/brands-and-products/hardox/product-program/500)) [vendor] | Same role as AR500 |
| 6061-T6 | 2.70 | 276 MPa | ductile | Frames and non-impact parts ([Wikipedia](https://en.wikipedia.org/wiki/6061_aluminium_alloy)) |
| 7075-T6 | 2.81 | 503 MPa (UTS 572) | low elongation, "tends to crack" | Stiff plates; too brittle for big horizontal spinners ([Wikipedia](https://en.wikipedia.org/wiki/7075_aluminium_alloy), [OnlineMetals](https://www.onlinemetals.com/en/combat-robotics-weapons-and-armor)) |
| Ti-6Al-4V (Grade 5) | 4.43–4.51 | 880–920 MPa | ~36 HRC, 5–18% elongation | Armor, cleats, mounts; expensive; can fracture rather than bend ([Wikipedia](https://en.wikipedia.org/wiki/Ti-6Al-4V)) |
| UHMW-PE | 0.93–0.94 | 19–23 MPa | Izod >1070 J/m (no break) | Sacrificial "gumming" buffer armor ([Wikipedia](https://en.wikipedia.org/wiki/Ultra-high-molecular-weight_polyethylene)) |
| Polycarbonate | 1.20–1.22 | 55–75 MPa tensile | 80–150% elongation | Ant/beetle shells, arena windows ([Wikipedia](https://en.wikipedia.org/wiki/Polycarbonate)) |
| S7 tool steel | ~7.8 | n/a | best near 54 HRC | Weapon teeth ([Ask Aaron](https://runamok.tech/AskAaron/materials.html)) |

Ask Aaron's rules of thumb, worth encoding directly:
- Toughness rises sharply below about 50 HRC.
- Stress risers (sharp internal corners, badly placed holes) start fractures.
- Grade 5 bolts beat Grade 8 in shock loading.
- Rubber shock mounts protect internals.

## (e) Damage: physically grounded but tractable

**Energy scales** ([calc] unless cited):
- **Humanoid strike:** about 1–3 kg effective mass at 3–8 m/s gives about 5–100 J. This is my estimate.
- **Humanoid fall:** G1 at 35 kg, CoM drop about 0.6 m, gives about 200 J. T800 at 80 kg, about 0.9 m, gives about 700 J.
- **Pneumatic flipper:** at most about 850 J (the example above).
- **Beetle (1.4 kg) spinner:** about 60 J within 2 s, using Ask Aaron's rule of at least 45 J/kg of robot weight in 2 s ([spinner FAQ](https://runamok.tech/AskAaron/spinner_FAQ.html)).
- **Mid-size bar:** 5.6 kg at 52 m/s stores about 2,600 J ([Run Amok](https://runamok.tech/RunAmok/spincalc_examples2.html)).
- **Tombstone-class bar:** 34 kg (75 lb) at 250 mph (111.8 m/s).
  - A uniform bar stores KE = ½Iω² = **m·v_tip²/6 ≈ 71 kJ**. That is the lower bound.
  - The fan-wiki figure of 212 kJ ([fandom](https://vsbattles.fandom.com/wiki/Tombstone_(BattleBots))) is ½mv², which treats the whole blade as a point mass at the tip. It overstates by up to 3×.
  - The 250 mph tip-speed cap is sourced only from fan wikis ([Minotaur](https://battlebots.fandom.com/wiki/Minotaur)). Unverified.
- **Same mass and diameter at 2000 rpm:** bar 710 J, disk 970 J, eggbeater 1230 J, hollow drum 1460 J ([Ask Aaron](https://runamok.tech/AskAaron/spinner_FAQ.html)).

**Simulation trap:** a 111.8 m/s tooth moves **11 cm per 1 ms step**, so it will pass straight through thin armor between steps (tunneling). To my knowledge MuJoCo has no continuous collision detection (CCD).

**Fix:** resolve spinner hits analytically.
- Treat the weapon as a flywheel with stored ½Iω².
- When an opponent enters the swept volume, compute bite = (v_attack·60)/(rpm·n_teeth) ([Ask Aaron](https://runamok.tech/AskAaron/spinner_FAQ.html)).
- Transfer a bite-dependent fraction of the stored energy as a scripted impulse.

**A layered damage model I propose** (my design; constants must be calibrated):
1. **Contact ledger.** Per-contact normal impulse from `mj_contactForce` ([changelog](https://mujoco.readthedocs.io/en/latest/changelog.html)). Absorbed energy ≈ J²/(2m_eff), or ½·m_eff·v_n²·(1 − e²).
2. **Panels.** Each armor panel has alloy, thickness t and mount type.
   - Plastic dent: work ≈ σ_y × displaced volume.
   - Penetration: when the per-tooth energy exceeds k·σ_UTS·t².
   - Low-elongation or high-HRC materials (7075, carbon fiber, over-hard steel) crack instead of dent.
   - Shock mounts spread the impulse over a longer time.
3. **Fasteners and joints.** Shear capacity ≈ 0.6·S_u·A_s, a standard textbook approximation not verified this session. When a joint fails, detach the part with mjSpec `mjs_attach`/detach plus `mj_recompile`, which "preserv[es] the simulation state" ([modeledit](https://mujoco.readthedocs.io/en/latest/programming/modeledit.html)). Loose debris goes to sleeping islands (added in 3.4.0).
4. **Actuators.**
   - Gear damage when an external impulsive torque exceeds a multiple of rated torque. High-N servos are more fragile, per the IMF result above.
   - Burnout from the dcmotor thermal state crossing an insulation limit. Derating and demagnetization need custom code.
5. **Fatigue.** A Miner's-rule accumulator per part (textbook).
6. **Battery puncture** means immediate forfeit, mirroring real safety rules.

## (f) Real rules and real humanoid fights

**Combat-robot rules:**
- **BattleBots (2020 rules, read directly):**
  - 3-minute matches.
  - Judges score Damage 5, Aggression 3, Control 3.
  - KO is a 20-count whose final 10 is audible.
  - Heavyweight limit is 250 lb.
  - Source: ([PDF](https://battlebots.com/wp-content/uploads/2019/12/BattleBots-Tournament-Rules.Rev.2020.0.pdf), [Wikipedia](https://en.wikipedia.org/wiki/Robot_combat)).
- **NHRL 2026:**
  - Classes of 3, 12 and 30 lb.
  - A "True Walker" gets **+100% weight**, i.e. +3, +12 or +30 lb. That means legs with at least 2 independently controlled DOF.
  - 3-minute fights, 10-second KO count.
  - Judging: Attack 5, Condition 6.
  - Source: ([NHRL](https://wiki.nhrl.io/wiki/index.php?title=NHRL_Open_Rules_-_2026)).
  - Real leagues openly compensate walkers for being weaker. Copy that as a balance lever.
- **UK FRA heavyweight:** 110 kg ([Wikipedia](https://en.wikipedia.org/wiki/Robot_combat)).

**Humanoid events:**
- **CMG Mecha Fighting, Hangzhou, May 25 2025.** Unitree G1s. Operators used remote devices plus voice commands, 3 × 2-minute rounds. Standing up within 8 s was a key scoring criterion. The winner was the team "AI Tactician", a team name, not evidence of autonomy. Sources: ([TechNode](https://technode.com/2025/05/27/unitree-g1-robots-battle-in-worlds-first-humanoid-robot-combat-tournament/), [Interesting Engineering](https://interestingengineering.com/ai-robotics/china-worlds-first-humanoid-robot-combat-league)) [indep].
- **REK, San Francisco.**
  - Modified G1s (about 80 lb, 4.5 ft), piloted in VR.
  - 2 bouts of 5 × 60 s rounds.
  - Robots "fell sometimes, and needed human intervention" ([Rest of World](https://restofworld.org/2026/chinese-robot-boxing-unitree-rek/)).
  - REK2 (Aug 15, 2026) used six-foot EngineAI T800s ([RoboSports](https://robosportsglobal.com/rek-robots-san-francisco-engineai-t800-fighting-humanoid/), [Reflex Arc](https://reflexarc.co.uk/projects/rek-robots)).
  - "Software handles lower-level functions such as balance while a person directs" ([RuntimeWire](https://runtimewire.com/article/human-vs-robot-rek-put-a-human-in-the-ring-with-a-six-foot-humanoid-robot)).
  - **REK already runs a physics sim** (Steam and Quest): 3,670 matches in its championship weekend, and the winners piloted the real robots at REK2. That is a direct precedent and competitor.
- **UKRL (EngineAI, Shenzhen).** Launched Feb 2026. Free T800s go to teams. The belt is worth 10M yuan (~$1.44M). The season runs through Dec 2026 ([Interesting Engineering](https://interestingengineering.com/ai-robotics/china-worlds-first-humanoid-robot-combat-league)).
- **World Humanoid Robot Games 2026 (Aug 22–26).** Kickboxing allowed a human in the loop ([Wikipedia](https://en.wikipedia.org/wiki/World_Humanoid_Robot_Games)).

## (g) How the engines represent actuators
- **MuJoCo `general` actuator.** Force = gain·ctrl + bias with affine `gainprm` / `biasprm`, activation dynamics in `dynprm`, and output clamped by `forcerange`. Joints add `armature`, `damping` and `frictionloss` ([XML ref](https://mujoco.readthedocs.io/en/latest/XMLreference.html)).
  - Before 3.7 you hand-built a voltage-driven motor as gainprm[0] = K/R, a velocity bias of −K²/R, and forcerange = ±K·i_max.
  - Now `dcmotor` takes `motorconst`, `resistance`, `nominal`, `saturation`, `inductance`, `thermal`, `cogging`, `lugre` and `controller` (kp, ki, kd, slew, Imax, Vmax) directly.
  - Isaac Lab mapping: saturation_effort = stall_torque, velocity_limit = no_load_speed, effort_limit = saturation:torque ([dcmotor.pdf](https://mujoco.readthedocs.io/en/latest/_static/dcmotor.pdf)).
- **MuJoCo in the browser (fits Chris's three.js stack).**
  - Official `@mujoco/mujoco` npm package, marked "still a WIP".
  - Single-threaded and multi-threaded builds; the multi-threaded one needs COOP/COEP headers.
  - A three.js demo ships in the repo ([README](https://github.com/google-deepmind/mujoco/blob/main/wasm/README.md)).
  - Whether mjSpec is exposed in the JS bindings is unverified.
- **PhysX 5.6.1.**
  - `PxPerformanceEnvelope` covers the linear torque-speed line: maxEffort, velocityDependentResistance, speedEffortGradient, maxActuatorVelocity.
  - `PxJointFrictionParams` covers static, dynamic and viscous friction. Armature and maxJointVelocity are also available.
  - No thermal model and no battery bus ([PhysX docs](https://nvidia-omniverse.github.io/PhysX/physx/5.6.1/docs/Articulations.html)).
- **Unity 6.6.** `ArticulationDrive` exposes only stiffness, damping, forceLimit, targets, driveType and limits. There is no envelope ([Unity](https://docs.unity3d.com/ScriptReference/ArticulationDrive.html)), so the motor model would have to be custom code.
- **Cautionary tale.** Isaac Lab's Unitree Go2 config ignored the ~1.92 knee reduction, so the "calf gets 2x speed, 0.52x torque" ([issue #7479](https://github.com/isaac-sim/IsaacLab/issues/7479)). Gear-ratio bookkeeping needs unit tests.

## Creative angle: real parts, and a winning sim design exports a real bill of materials. Honest?

**What is honest and feasible:**
- Actuators, drivers, batteries, fasteners and plate stock all come with spec sheets. Datasheet checks like Kt = Ke and the implied efficiency validate them.
- Each part card should carry provenance: [vendor], [consistency-checked] or [bench-measured].
- The sim should randomize within the published tolerances. RS04 lists ±10% on R, L and current. A design that wins only at nominal spec gets flagged as fragile.
- Real prices roll up, so a **cost cap** can sit beside the weight classes.

**Where sim-to-real breaks:**
1. **Custom structure is not a catalog part.** Brackets and links need CAD and FEA. Limit the builder to parametric plates, tubes and extrusions, and export DXF/STEP.
2. **Actuator dynamics are richer than the DC model.** ANYmal needed a learned actuator network trained on real data ([Hwangbo 2019](https://pubmed.ncbi.nlm.nih.gov/33137755/)) [indep]. Thermal constants are usually unpublished: the AK80-9 page lists only an NTC sensor.
3. **Impact, dent, crack and bolt shear are calibrated heuristics.** Match outcomes are entertainment-grade, not engineering-grade.
4. **Control.** Real drives close current loops at 8–20 kHz (8 kHz ODrive; 20 kHz on the MIT Cheetah). A 70–500 ms Jev decision can set tactics, but a 0.5–1 kHz low-level controller must execute them. Structural compliance also cut Cheetah's force bandwidth to about 104 Hz.
5. **Balance for arbitrary user-built legs** needs a learned locomotion policy per body shape. Every real humanoid fighter relies on one.
6. **Safety and liability.** Export a BOM for a 70 kJ spinner or a 450 N·m humanoid only with a strong disclaimer, or not at all. Cap the export to beetle and 12 lb scale plus SPARC/NHRL safety rules.

**Label every export:** "buildable; sim-validated within spec tolerance; not a win guarantee."

## Open questions
- Can the official @mujoco/mujoco WASM build run 2 robots × ~25 dcmotor actuators with thermal state at 1 kHz in a browser, and does it expose mjSpec (attach/detach + mj_recompile) needed for interchangeable and detachable parts? Needs a spike.
- Thermal constants (R_T, C) are unpublished for AK/RobStride/Unitree actuators. Estimate from housing mass, or buy one unit and bench-measure to calibrate the catalog?
- Which first class: NHRL-scale wheeled or walker bots (safe BOM export, no balance policy), template humanoids (G1/T800-like), or free-form legged builds, which need a learned locomotion policy per morphology?
- Current BattleBots technical regulations (spinner tip-speed cap, 2500 vs 3000 psi pneumatics) could not be verified from a primary 2025-26 rulebook; only fan wikis and secondary summaries were found.
- Does the current Unity PhysX build expose any torque-speed envelope beyond ArticulationDrive's stiffness/damping/forceLimit? Unity docs do not state the bundled PhysX version.
- How much damage-model calibration data is obtainable (for example NHRL fight footage and builder post-mortems) to tune dent, penetration and fastener thresholds so outcomes feel right?
- Liability: should BOM export be restricted to beetleweight/12 lb scale, and what disclaimers or safety-rule links (SPARC/NHRL) are required?
- REK's physics sim is a direct precedent and competitor. How does an autonomous Jev-driven, build-your-own-robot game differentiate from REK's pilot-your-robot sim?