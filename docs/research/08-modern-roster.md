## Split Decision electric roster: four original fighters

All four fighters are all-electric, with no hydraulic circuits. The numbers below come from running the project's own `buildHumanoid()` and `compileRobot()` on these specs from a scratch script. The new motors were added to the catalog object in memory only; no repo file was modified.

| | FIRECRACKER | SAVATE | HAYMAKER | PYLON |
|---|---|---|---|---|
| Class it draws on | Kid-size (G1 / T1 class) | Adult-size (T800 class) | Heavy adult-size, electric | Rangy adult-size (H1 / H2 class) |
| Height | 1.30 m | 1.73 m | 1.82 m | 1.89 m |
| Mass (compiled) | 37.9 kg | 82.9 kg | 103.1 kg | 79.3 kg |
| Real-world weight class (WHRG 2026: 40 / 58 / 80 kg) | 40 kg | 80 kg + 2.9 | above 80 kg (open) | 80 kg |
| Builder `scale` / `bulk` | 0.667 / 0.95 | 0.887 / 0.92 | 0.933 / 1.12 | 0.97 / 0.78 |
| Armor / frame | polycarb / al6061 | polycarb / al7075 | uhmw / al7075 | carbon / al7075 |
| Degrees of freedom | 23 | 23 | 23 | 23 |
| Actuator mass | 19.1 kg | 44.3 kg | 47.2 kg | 38.2 kg |
| Peak knee torque per kg | 3.2 N·m/kg | 5.4 | 4.4 | 4.0 |
| Stance COM height | 0.66 m | 0.85 m | 0.94 m | 0.93 m |
| Gyro core (torque / momentum / mass) | 50 N·m / 17 N·m·s / 2.3 kg | 140 / 49 / 6.5 | 195 / 68 / 9.1 | 150 / 51 / 6.8 |
| Hands | 8-oz-class gloves + headgear | bare fists | ~21-oz-class gloves | bare fists |
| Style | swarmer | kickboxer | pressure brawler | distance kicker |

For comparison, the current roster compiles to 236 kg (BRUISER), 146 kg (STRIKER) and 408 kg (GOLIATH). The heaviest robot that has actually fought is the T800 at 75–85 kg. All four new designs have more knee torque per kg than today's STRIKER (450 N·m / 146 kg = 3.1 N·m/kg), and every big leg joint turns faster than the catalog's `qdd.t800` (9 rad/s): 13.1 rad/s for the X12, 11.3 for the X15, 33.5 for the AK10-9. Lighter robots also fall softer. Fall energy (m·g·h of the COM) is 245 J for FIRECRACKER, 690 J for SAVATE, 955 J for HAYMAKER and 725 J for PYLON, against about 2,600 J for BRUISER. That is the biggest lever for faster, more human-looking fights.

### Gyro core sizing (one rule for all four)

Your balance controller scales its gyro demand with m·g and m·g·h (`gyroDemand` in `src/physics/control/balance.ts`). The existing gyros sit at 0.14–0.20 × m·g·h of torque and 0.056–0.074 s × m·g·h of momentum; STRIKER's is 0.20 and 0.074. These four use one rule:

- momentum H = 0.071 s × m·g·h_COM
- torque τ = 0.205 × m·g·h_COM. That makes τ/H ≈ 2.9 s⁻¹, a gimbal slew of about 2.9 rad/s, which matches the real Airbus CMG 15-45 S (45 N·m from 15 N·m·s, a ratio of 3.0).
- device mass = H / 7.5 N·m·s per kg

**Real hardware anchors**

| Device | Momentum | Torque | Mass | Momentum per kg | Torque per kg |
|---|---|---|---|---|---|
| Airbus CMG 15-45 S (space-rated) | 15 N·m·s | 45 N·m | 18.4 kg | 0.8 | 2.4 |
| Seakeeper 1 (boat stabilizer, 9,750 rpm) | 1,000 N·m·s | 2,620 N·m | 166 kg | 6.0 | 15.8 |
| GyBAR (wearable balance aid) | not stated | 53 N·m | 16 kg | — | 3.3 |
| GyroPack (two CMGs) | not stated | not stated | 6 kg | — | — |

- **Our density.** 7.5 N·m·s/kg is about 25% denser than Seakeeper, and torque density is about 22 N·m/kg. That is plausible for a sealed thin-rim rotor at about 220 m/s rim speed that runs in bursts of seconds. For example, a 2.2 kg steel rim at r = 0.10 m and 21,000 rpm gives about 48 N·m·s, which is SAVATE's core.
- **Current roster is denser than any hardware I found.** The existing gyros run 11–12 N·m·s/kg.
- **FIRECRACKER doesn't need a big one.** Its m·g·h is 244 N·m against HAYMAKER's 955, so 2.3 kg (6% of its mass) gives it the same relative authority as STRIKER. The real G1 has no gyro at all.
- **PYLON will saturate most often.** Its hip span is the narrowest (0.18 m) and its COM the highest. That is its designed weakness: body shots and low kicks that knock it off its base drain the gyro.

### Gloves: what they change, grounded in data

- **Evidence.** Nakano, Iino and Kojima (ISBS 2009) had nine collegiate boxers throw full-power rear straights into a free 4.36 kg head-mass target.
  - 10-oz gloves: 2,090 N peak, 18.6 N·s impulse.
  - 16-oz gloves: 1,900 N peak, 19.1 N·s impulse.
  - Contact lasted 18.5–28.8 ms. Cushioning, not glove mass, set the peak force.
- **In the engine:** a glove should keep impulse about the same, lower peak force and stretch the contact.
  - Model it with a larger, softer striker. Use a MuJoCo solref time constant of about 0.015–0.02 s instead of 0.004, so contacts last the measured 18–29 ms.
  - Your head-break threshold (`headBreakImpulseNs`) is impulse-based, so gloves will **not** save heads.
  - Gloves do cut dents and sparks on the target, and they protect the wearer's own fist part.
  - Real kid-size fighters glove up partly to protect fragile hands. URKL's T800s fight bare-fisted.
- **Per-design choice:**
  - FIRECRACKER: gloves and padded headgear, the real kid-size fight dress.
  - SAVATE: bare, as in URKL.
  - HAYMAKER: oversized gloves, so it can throw full hooks all night without breaking its hands.
  - PYLON: bare.

---

### 1. FIRECRACKER (id `firecracker`), the lightweight

*Thirty-eight kilos of fast hands, back up before the count starts.*

**Inspired by.** The kid-size class that did nearly all the 2025 fighting and still boxes in 2026:
- **Unitree G1** (1.32 m, 35 kg, 90/120 N·m knees): CMG Hangzhou, WAIC, WHRG 2025, REK1, UFB at CES 2026, and WRC 2026.
- **Booster T1** (1.18 m, 30 kg): Silicon Colosseum.

**What it keeps:** size, 23 DoF, torque class, gloves and headgear.

**What it changes:**
- A rounded pebble chest instead of a boxy flat-front torso.
- Tangerine and graphite instead of satin silver.
- Three round lenses in a downward-pointing triangle instead of a black dome with a glowing halo ring.
- Unbranded open-face headgear.
- No twin thigh stripes and no orange ankle rods.

**Build and proportions**
- 1.30 m, 37.9 kg, stance COM at 0.66 m.
- Thigh and shin 0.293 m each, about 8% shorter than a 1.30 m human (0.32 by Winter's segment ratios).
- Arm reach from shoulder, including the fist, is 0.48 m. That is 15% short of a human; the builder's arm ratio is fixed.
- Shoulder-joint span 0.39 m, 17% wider than a human's shoulders. Hip-joint span 0.15 m.
- Torso 0.22 m deep × 0.32 wide × 0.32 tall; head 0.15 × 0.13 × 0.16 m.
- Built like a squat, wide-shouldered bantam.

**Actuators**

| Joint group (builder slot) | Module | Peak / rated | No-load speed | Mass | Ratio / voltage |
|---|---|---|---|---|---|
| Hips + ankles (`leg`) | CubeMars AK10-9 V3 QDD | 53 / 18 N·m | 320 rpm = 33.5 rad/s | 0.96 kg | 9:1, 48 V |
| Knees (`knee`) | RobStride 04 QDD | 120 / 40 N·m, same as a G1 EDU knee | 200 rpm = 20.9 rad/s | 1.42 kg | 9:1 |
| Shoulders (`arm`) | RobStride 06 | 36 / 11 N·m | 480 rpm = 50.3 rad/s | 0.621 kg | 9:1 |
| Elbows (`elbow`) | RobStride 02 | 17 / 7 N·m | 410 rpm = 42.9 rad/s | 0.405 kg | 7.75:1 |
| Waist (`waist`) | RobStride 03 | 60 / 21 N·m | 195 rpm = 20.4 rad/s | 0.90 kg | 9:1 |
| Neck (`neck`) | RobStride 00 | 14 N·m | 315 rpm | 0.31 kg | 10:1 |

- **Gyro:** 50 N·m, 17 N·m·s, 2.3 kg.
- **Head break:** 32 N·s. Headgear raises it by roughly 30%; that is a tuning choice, so calibrate with `tools/fight-sim.ts`.

**Materials**
- Polycarbonate armor shells over a 6061 frame.
- Target fists are 8-oz-class foam gloves (about 0.23 kg each). The builder's `'block'` AR500 fist stands in until a glove kit exists.
- Open-face EVA-foam headgear.

**Look**
- **Chest:** a smooth pebble- or egg-shaped gloss shell, widest at the top with no flat front. Below it, a small hexagonal graphite belly plate. One warm-white chevron on the sternum.
- **Head:** a squat rounded trapezoid, wider at the jaw. Three round warm-white lenses (#FFF1DC) in a downward triangle, two at brow level and one centred at mouth level, each in a graphite bezel. A short louvered chin vent.
- **Fight gear:** open-face padded headgear with cheek pads and a brow roll, and gloves with white cuffs. Both are in the corner colour, with no lettering.
- **Limbs and joints:** rounded tangerine thigh and shin shells. Dark graphite actuator pucks exposed at shoulders, hips and knees. Slim ribbed graphite forearms.
- **Feet:** rounded graphite shoe shells with tangerine toe caps.
- **Colours:** gloss tangerine #F26B1D, graphite #2A2826.
- **Decals:** race number 07 on the left chest and right thigh.

**Fight style**
- A swarmer. It sprints inside the kicking range of longer robots and throws volume: jab-cross into hooks and uppercuts to the body and chin.
- It chops the lead knee with low kicks and uses front kicks to shove bigger robots off their base.
- Its weapon is recovery. It has the lowest COM and the smallest fall energy (about 245 J), so it should hit URKL's 3-second get-up standard more often than anyone.
- **Weaknesses:** 0.48 m reach, 120 N·m knees, and it cannot reach a tall robot's head with a kick, so `head_kick` is left out.

**Abilities:** jab, cross, hook, uppercut, front_kick, low_kick, sprint.

---

### 2. SAVATE (id `savate`), the middleweight

*A 450 N·m kickboxer. The shins are the weapon.*

**Inspired by.** EngineAI's T800 (173 cm, 75–85 kg, 450 N·m) as fought in URKL Shenzhen (16 July 2026), URKL Shanghai (19 September), REK2 and CyberHero Riyadh. Those fights featured committed roundhouse and tornado kicks, jumping knees and kip-ups, and a head knocked clean off.

**What it keeps:** the height, the 450 N·m knee class, bare fists, and kick-first fighting.

**What it changes:**
- A narrow wedge head with one **vertical** light bar, instead of a dome helmet with a horizontal LED visor.
- A faceted diamond chest plate instead of a round chest emblem.
- Aubergine and bone instead of the white/grey, gold-chrome or gunmetal-and-red liveries.
- Purchasable MyActuator modules instead of the maker's own joints.

**Build and proportions**
- 1.73 m, 82.9 kg, stance COM at 0.85 m.
- Thigh and shin 0.39 m each, about 8% short of a human. Leg length to the sole is about 0.85 m; the T800's is 0.91 m.
- Arm reach 0.64 m (16% short of a human; the T800 arm is 0.60 m).
- Shoulder-joint span 0.51 m, 13% wider than a human's. Hip span 0.20 m.
- Torso 0.28 × 0.41 × 0.43 m; head 0.20 × 0.18 × 0.21 m.
- Athletic, with a slightly tapered waist.

**Actuators**

| Joint group | Module | Peak / rated | No-load speed | Mass | Ratio / voltage |
|---|---|---|---|---|---|
| Hips + ankles | MyActuator RMD-X12-P20-320-E | 320 / 85 N·m | 125 rpm = 13.1 rad/s | 2.37 kg | 20:1, 48 V |
| Knees | MyActuator RMD-X15-P20-450-E | 450 / 145 N·m | 108 rpm = 11.3 rad/s | 3.5 kg | 20.25:1, 72 V |
| Shoulders + waist | RobStride 04 | 120 N·m | 20.9 rad/s | 1.42 kg | 9:1 |
| Elbows | RobStride 03 | 60 N·m | 20.4 rad/s | 0.90 kg | 9:1 |
| Neck | RobStride 02 (existing `servo.neck`) | 17 N·m | — | — | — |

- **Gyro:** 140 N·m, 49 N·m·s, 6.5 kg.
- **Head break:** 45 N·s. There is no headgear, so a clean head kick in a mirror match can decapitate, as happened in the URKL opener.
- **To make the real 80 kg class:** swap hips and ankles to an M107-class module (360 N·m, about 1.9 kg). That compiles to 79.7 kg, but Unitree publishes no speed for it.

**Materials**
- Polycarbonate shells over a 7075 frame; the T800 itself uses aviation aluminium plus titanium.
- Bare AR500 knuckle plates, which is the builder's `'block'` fist.
- EVA-foam shin guards over the polycarbonate shin shells. This is visual only; a softer shin contact would need builder work.

**Look**
- **Head:** a narrow forward-raked wedge, longer front-to-back than wide, in satin aubergine. One thin pale-mint (#9DFFD6) vertical light bar runs from brow to chin on the centreline. Two small round cheek sensors sit in brushed-aluminium bezels. There is no horizontal visor.
- **Chest:** a faceted diamond (kite) plate pointing down to the waist, with a raised centre ridge and separate side plates.
- **Hips:** a split two-panel hip skirt.
- **Legs:** long aubergine thigh plates over brushed-aluminium structure. Bone-white (#E9E2D0) ribbed foam shin guards cover the shins and insteps.
- **Joints:** exposed ring-shaped bearing housings in brushed aluminium (#B9BCC0) with dark graphite motor cans.
- **Fists:** compact bare fists with raised knuckle plates.
- **Feet:** black soles with aubergine heel counters.
- **Colour:** satin aubergine #3D1F4F.
- **Decals:** number 21 on the left facet of the chest diamond and on both shin guards.

**Fight style**
- An orthodox kickboxer. It measures with the jab, chops the lead leg with low kicks until the opponent's stance or gyro gives, then goes upstairs with the head kick.
- The front kick stops pressure fighters. Sprint cuts angles.
- Hands finish combinations: jab-cross-hook into a kick.
- **Weaknesses:** bare fists, no headgear, polycarbonate that dents, and 20:1 knees and hips. Those joints backdrive less than 9:1 QDD, so under your gear-damage rule they are more fragile to impacts (see Wensing et al., cited in `docs/research/02-actuators.md`).

**Abilities:** jab, cross, hook, front_kick, low_kick, head_kick, sprint.

---

### 3. HAYMAKER (id `haymaker`), the heavyweight brawler

*The heaviest thing electric joints can carry. Every punch is thrown to end it.*

**Inspired by.** It does not copy any robot that has fought. It extrapolates the adult-size electric class upward:
- **Unitree H2:** 1.82 m, 70 kg, 360 N·m legs, 120 N·m arms.
- **T800:** 450 N·m.

It stops at the heaviest mass a 450 N·m electric knee should carry:

| Robot | Knee torque per kg |
|---|---|
| HAYMAKER | 4.4 N·m/kg |
| T800 | 5.6 N·m/kg |
| H1 | 7.7 N·m/kg |

That puts it above WHRG 2026's 80 kg top Free Combat class. Above about 110 kg you are back to hydraulics, where BRUISER and GOLIATH live.

**What it changes:** UHMW slab armour from combat-robot practice instead of foam kits or plastic covers, a hammerhead head, olive drab paint, and oversized gloves.

**Build and proportions**
- 1.82 m, 103.1 kg, stance COM at 0.94 m.
- Thigh and shin 0.41 m each (8% short of a human). Arm reach 0.69 m (14% short).
- Shoulder-joint span 0.65 m, **38% wider than a human's**. Hip span 0.25 m.
- Torso 0.36 × 0.52 × 0.45 m; head 0.21 × 0.19 × 0.22 m.
- Top-heavy and barrel-chested, with almost no neck.

**Actuators**

| Joint group | Module | Peak / rated | No-load speed | Mass | Note |
|---|---|---|---|---|---|
| Hips + ankles | MyActuator X12-320 | 320 N·m | 13.1 rad/s | 2.37 kg | |
| Knees | MyActuator X15-450 | 450 N·m | 11.3 rad/s | 3.5 kg | |
| Waist yaw/pitch | MyActuator X12-320 | 320 N·m | 13.1 rad/s | 2.37 kg | Hooks and overhands come from the waist, and the upper body is about 60 kg |
| Shoulders + elbows | RobStride 04 | 120 N·m | 20.9 rad/s | 1.42 kg | Elbows sized for heavy gloves |
| Neck | RobStride 02 | 17 N·m | — | — | |

- **Gyro:** 195 N·m, 68 N·m·s, 9.1 kg.
- **Head break:** 65 N·s.

**Materials**
- UHMW-PE slab armour over a black-anodized 7075 frame. UHMW is the sacrificial "soak" armour combat builders use, at 940 kg/m³ with no-break impact toughness.
- Oversized gloves, about 21-oz class (about 0.6 kg each).

**Look**
- **Head:** a low, wide, flat-topped hammerhead block, wider than it is deep. It sits sunk between rounded shoulder cowls that rise almost to its brow. Two small round red-orange (#FF4D1A) lenses sit at its outer corners under a thick overhanging brow ledge, with a heavy chin bar below. The face is solid, with no grille or mesh.
- **Torso:** a barrel chest of thick matte olive-drab (#56613A) UHMW panels, gouged and scuffed. Exposed button-head bolts fix them to the black frame (#141516).
- **Joints:** large black actuator drums exposed at the waist, hips and knees.
- **Limbs:** thick forearm and shin panels. Gloves in the corner colour.
- **Feet:** wide square feet with thick rubber soles.
- **Decals:** stencil number 44 on the chest and back.
- **Skin:** your existing `military` skin fits almost exactly.

**Fight style**
- A pressure brawler. It walks forward behind a high guard and smothers kickers in the clinch.
- It digs uppercuts and hooks, then loads the overhand. Low kicks chop the legs of anyone trying to circle.
- **Weaknesses:** the slowest legs in the roster, the biggest fall (about 955 J), no sprint, and its gyro saturates when it chases a mover.

**Abilities:** jab, cross, hook, uppercut, overhand, low_kick, clinch.

---

### 4. PYLON (id `pylon`), the wildcard

*Six foot two of legs. It hits you from where you can't hit back.*

**Inspired by.** The rangy adult-size lineage:
- **Unitree H1:** 1.8 m, 47 kg, 360 N·m knee.
- **Unitree H2:** 1.82 m, 70 kg.

It weighs 79.3 kg, inside WHRG 2026's 80 kg class.

**What it changes:**
- It is taller than both.
- Hi-vis lime and reflective silver instead of all-black or white and silver.
- An **asymmetric** three-lens lozenge head instead of an elongated faceless helmet or a sculpted human face.
- No ball hands and no knit sweater.

**Build and proportions**
- 1.89 m, 79.3 kg, stance COM at 0.93 m.
- The longest legs in the roster: thigh and shin 0.43 m each, about 0.85 m of leg.
- Arm reach 0.69 m. That equals HAYMAKER's reach, because the builder's arm ratio is fixed and 17% short of a human's. If an `armScale` parameter is added, 1.12 would give PYLON a human-length 0.77 m jab.
- Shoulder-joint span 0.47 m (human-like). Hip span only 0.18 m.
- Torso 0.26 × 0.38 × 0.47 m; head 0.21 × 0.19 × 0.23 m.

**Actuators**

| Joint group | Module | Peak / rated | No-load speed | Mass | Note |
|---|---|---|---|---|---|
| Hips + ankles + knees | MyActuator X12-320 | 320 N·m | 125 rpm = 13.1 rad/s | 2.37 kg | Knee uses the X12, not the X15, because it is 16% faster |
| Shoulders | RobStride 03 | 60 N·m | 20.4 rad/s | 0.90 kg | |
| Elbows | RobStride 06 | 36 N·m | 50.3 rad/s | 0.621 kg | A snapping jab |
| Waist | RobStride 04 | 120 N·m | — | — | |
| Neck | RobStride 00 | 14 N·m | — | — | |

- **Gyro:** 150 N·m, 51 N·m·s, 6.8 kg.
- **Head break:** 40 N·s.

**Materials**
- Carbon-fibre shells, painted hi-vis, on the chest, forearms, shins and head.
- Dark-anodized 7075 frame for the upper arms, thighs and pelvis.
- Bare fists with rubber knuckle bumpers (visual).

**Look**
- **Head:** a slim upright lozenge, taller than wide and canted slightly forward. One large round violet (#B58CFF) lens is offset to the left, with two small lenses stacked vertically on the right. A short antenna stub sits at the right rear.
- **Shells:** fluorescent lime (#C6F000) on a narrow chest, the pelvis, forearms and shins.
- **Structure:** exposed dark-anodized (#1C1D1F) upper-arm and thigh tubes.
- **Joints:** slim retroreflective silver bands (#C9CCD1) around every joint.
- **Feet:** long, narrow and black.
- **Decals:** number 11 down the right forearm and on the back.

**Fight style**
- A distance kicker and out-fighter. It keeps range with long front kicks and pokes the jab.
- It kicks the lead leg of anyone who steps in, and throws the head kick from a range nobody else can reach. Sprint resets distance.
- **Weaknesses:** the narrowest base and a high COM, so it spends the most gyro. It dislikes the clinch and body shots. It gets no clinch ability.

**Abilities:** jab, cross, front_kick, low_kick, head_kick, sprint.

---

### Ready-to-paste specs (existing builder, fallback kits)

`head` and `fist` use existing kits as fallbacks until the new kits in the next section exist. New motor ids are listed below.

```ts
export const FIRECRACKER = buildHumanoid({
  id: 'firecracker', name: 'FIRECRACKER',
  tagline: 'Thirty-eight kilos of fast hands, back up before the count starts.',
  scale: 0.667, bulk: 0.95, armor: 'polycarb', frame: 'al6061',
  motors: { leg: 'qdd.ak10', knee: 'qdd.rs04', arm: 'qdd.rs06', elbow: 'qdd.rs02', waist: 'qdd.rs03', neck: 'qdd.rs00' },
  fist: 'block', // → 'glove' (8-oz class)
  head: 'twin',  // → 'triplet' + headgear
  gyro: { maxTorqueNm: 50, momentumNms: 17, massKg: 2.3 },
  hydraulicArms: false, headBreakImpulseNs: 32, eyeColor: '#fff1dc',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'front_kick', 'low_kick', 'sprint'],
  defaultSkin: 'racing', // → new 'tangerine'
});
export const SAVATE = buildHumanoid({
  id: 'savate', name: 'SAVATE', tagline: 'A 450 N·m kickboxer. The shins are the weapon.',
  scale: 0.887, bulk: 0.92, armor: 'polycarb', frame: 'al7075',
  motors: { leg: 'plan.x12', knee: 'plan.x15', arm: 'qdd.rs04', elbow: 'qdd.rs03', waist: 'qdd.rs04', neck: 'servo.neck' },
  fist: 'block', head: 'twin', // → 'blade'
  gyro: { maxTorqueNm: 140, momentumNms: 49, massKg: 6.5 },
  hydraulicArms: false, headBreakImpulseNs: 45, eyeColor: '#9dffd6',
  abilities: ['jab', 'cross', 'hook', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'neon', // → new 'aubergine'
});
export const HAYMAKER = buildHumanoid({
  id: 'haymaker', name: 'HAYMAKER', tagline: 'The heaviest thing electric joints can carry. Every punch is thrown to end it.',
  scale: 0.933, bulk: 1.12, armor: 'uhmw', frame: 'al7075',
  motors: { leg: 'plan.x12', knee: 'plan.x15', arm: 'qdd.rs04', elbow: 'qdd.rs04', waist: 'plan.x12', neck: 'servo.neck' },
  fist: 'block', // → 'glove' (21-oz class)
  head: 'slit',  // → 'hammer'
  gyro: { maxTorqueNm: 195, momentumNms: 68, massKg: 9.1 },
  hydraulicArms: false, headBreakImpulseNs: 65, eyeColor: '#ff4d1a',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'overhand', 'low_kick', 'clinch'],
  defaultSkin: 'military',
});
export const PYLON = buildHumanoid({
  id: 'pylon', name: 'PYLON', tagline: "Six foot two of legs. It hits you from where you can't hit back.",
  scale: 0.97, bulk: 0.78, armor: 'carbon', frame: 'al7075',
  motors: { leg: 'plan.x12', knee: 'plan.x12', arm: 'qdd.rs03', elbow: 'qdd.rs06', waist: 'qdd.rs04', neck: 'qdd.rs00' },
  fist: 'block', head: 'dome', // → 'lozenge'
  gyro: { maxTorqueNm: 150, momentumNms: 51, massKg: 6.8 },
  hydraulicArms: false, headBreakImpulseNs: 40, eyeColor: '#b58cff',
  abilities: ['jab', 'cross', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'factory', // → new 'hivis'
});
```

Head-break values are starting points. Calibrate them with `npx tsx tools/fight-sim.ts <red> <blue>` so that p90 jabs and crosses stay under each threshold, while clean head kicks and overhands can clear it.

**Catalog entries to add** (`MOTORS` in `src/robots/catalog.ts`)

Torque, speed and mass are published. The thermal fields are my estimates, scaled from the existing RS04 and T800 entries (about 340 J/(kg·K)).

| id | name | stall N·m | no-load rad/s | kg | heat J/K | K/W | copper W | source |
|---|---|---|---|---|---|---|---|---|
| `qdd.rs00` | RobStride 00 | 14 | 33.0 | 0.31 | 120 | 2.2 | 120 | github.com/RobStride/Product_Information |
| `qdd.rs02` | RobStride 02 | 17 | 42.9 | 0.405 | 180 | 1.8 | 160 | same, and roboticscenter.ai (405 g) |
| `qdd.rs03` | RobStride 03 | 60 | 20.4 | 0.90 | 330 | 1.1 | 700 | same |
| `qdd.rs06` | RobStride 06 | 36 | 50.3 | 0.621 | 240 | 1.4 | 420 | robstride.com/products/robStride06 |
| `qdd.ak10` | CubeMars AK10-9 V3 | 53 | 33.5 | 0.96 | 360 | 1.2 | 600 | cubemars.com AK10-9 V3.0 KV60 |
| `plan.x12` | MyActuator RMD-X12-320 (20:1) | 320 | 13.1 | 2.37 | 800 | 0.6 | 2000 | openelab.io RMD-X12-P20 |
| `plan.x15` | MyActuator RMD-X15-450 (20.25:1) | 450 | 11.3 | 3.5 | 1100 | 0.5 | 2600 | openelab.io RMD-X15-P20 |

The existing `servo.neck` entry is RobStride 02 at 12 rad/s. RobStride lists 410 rpm (42.9 rad/s). That is harmless for a neck, but it's why `qdd.rs02` is a separate entry.

### Builder gaps (optional; the specs above run without them)

1. **Glove kit.** Add `fist: 'glove'`: a larger striker (about 1.3× `fistHalf`), a foam/leather material, and a softer contact (solref about 0.015–0.02 s). Today the builder hard-codes the fist as AR500.
2. **New head kits.** `head.triplet` (with a headgear toggle), `head.blade`, `head.hammer` and `head.lozenge`. The existing four heads belong to the current roster.
3. **Three new skins.** `tangerine`, `aubergine` and `hivis`. Also a per-design race-number override: skins currently carry one fixed number.
4. **An `ankle` motor slot.** The `leg` slot now also drives both ankle joints. Real ankles are about 45–60 N·m (H1: 45 N·m). With an RS04 ankle, SAVATE, HAYMAKER and PYLON each shed about 4–9 kg.
5. **An `armScale` parameter.** Builder arms are about 15% shorter than human arms at every scale.
6. **Per-design battery.** `gyro.ts` assumes one 1.2 kWh pack. A G1-class pack is about 0.45 kWh; the T800's is 71.4 V × 20 Ah ≈ 1.4 kWh.

### IP-safety rationale

- **Names.** FIRECRACKER, SAVATE (a French kickboxing art), HAYMAKER (a wild punch) and PYLON are common words.
  - A search turned up no combat robot or humanoid product with these names. "The Haymaker" appears only as the nickname for a weapon on the BattleBots robot Ziggy; it's a generic boxing term.
  - Avoided: every real robot, event and fighter name in the dossier (T800, White Eagle, Matador, Golden Flash, Rekbot and the rest), fiction marks (Terminator, Iron Man, Gundam, Real Steel's robots) and your existing roster names.
- **Heads.** None uses a real signature head:
  - no black dome with a halo ring
  - no elongated faceless helmet with a crescent
  - no sculpted human face
  - no single horizontal LED visor
  - no Iron-Man-style faceplate, no V-fin crest
  - no face mesh or cage (Real Steel's sparring robot Atom has one)
  - no round ring-light head (the electric Atlas)
- **Liveries.** Real fighters wore satin silver, all-black, gloss white/grey, gold chrome with silver, gunmetal with red, and black with gold. Ours are tangerine/graphite, aubergine/bone, olive/black and hi-vis lime/anodized/reflective silver.
- **Shells.** Pebble chest, faceted diamond chest, UHMW slabs and a lozenge head. None uses a box torso with orange ankle rods, or a round chest emblem.
- **Markings.** No logos and no wordmarks. Race numbers only (07, 21, 44, 11); no real event used number decals.
- **Generic elements, used on purpose.** Exposed actuator housings, corner-colour boxing gloves and padded headgear, foam shin guards and soled feet. These are generic to the category.
- **Real products stay out of the game.** They appear only as spec sources, in catalog `source` strings and docs; never in names, UI or art prompts. The art prompts contain no brand names and ask for no text. The existing catalog display name "T800-class 450 N·m joint" never reaches the UI today (the tale screen shows joint names). If motor names ever surface, rename it "450 N·m-class joint".
- **Not legal advice.** This is good-faith design distance on overall impression, not a legal opinion.

### Sources

- **Actuators**
  - [RobStride Product_Information](https://github.com/RobStride/Product_Information)
  - [RobStride 06](https://www.robstride.com/products/robStride06)
  - [RobStride 02 at roboticscenter.ai](https://www.roboticscenter.ai/store/product/robstride-02)
  - [RobStride 04 at OpenELAB](https://openelab.io/products/robstride04-qdd-120n-m-integrated-joint-motor-module)
  - [CubeMars AK10-9 V3](https://www.cubemars.com/product/ak10-9-v3-0-kv60-robotic-actuator.html)
  - [MyActuator X12-320](https://openelab.io/products/myactuator-rmd-x12-p20-actuator)
  - [MyActuator X15-450](https://openelab.io/products/myactuator-rmd-x15-p20-actuator)
- **Reference robots**
  - [Unitree H1 and M107 (360 N·m, 189 N·m/kg)](https://www.unitree.com/h1/)
  - [Unitree G1](https://www.unitree.com/g1/)
  - [Unitree H2](https://www.unitree.com/H2/)
  - [EngineAI T800](https://en.engineai.com.cn/product-t800)
- **Gyroscopes**
  - [Airbus CMG 15-45 S datasheet](https://www.airbus.com/sites/g/files/jlcbta136/files/2022-02/AVIONICS-CMG15-45-v5-2022.pdf)
  - [Seakeeper 1 (Panbo)](https://panbo.com/seakeeper-1-installed-on-the-water-and-stable/) and [Seakeeper 1 product page](https://www.seakeeper.com/seakeeper-products/seakeeper-1/)
  - [GyBAR (Sci Rep 2020)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7320159/)
  - [GyroPack (npj Robotics)](https://www.nature.com/articles/s44182-025-00041-4)
- **Gloves**
  - [Nakano, Iino, Kojima, ISBS 2009](https://ojs.ub.uni-konstanz.de/cpa/article/view/3427/3226)
- **Names**
  - [BattleBots Ziggy](https://battlebots.fandom.com/wiki/Ziggy)
- **Events and liveries:** see the research dossier's links (URKL, REK, CMG, WHRG, UFB, CyberHero).