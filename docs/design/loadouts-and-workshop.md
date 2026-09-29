# Loadouts and the workshop

Status: hands slot built (2026-09-29). The other slots, damage persistence and the workshop UI are the plan.

Chris asked for switchable hands ("what they currently have, fully dexterous hands, or later weapons") and, eventually, a workshop where you build, customise and repair bots. This doc sets the model so every later slot plugs into the same path.

## The slot model

A **loadout** is a design id plus one choice per slot:

```ts
// src/core/types.ts
type HandsOption = 'stock' | 'glove' | 'knuckle' | 'dexterous';
interface Loadout { design: string; hands: HandsOption }   // later: head, arms, legs, armour, weapon
FighterSetup.loadout?: Loadout                              // MatchSetup.fighters[i].loadout
```

| Slot | Now | Later options |
|---|---|---|
| hands | stock, gloves, knuckle plates, dexterous | weapons: hammer fist, shield, claw |
| head | (stock) | sensor mast, armoured dome, twin-camera visor (changes head break impulse and gaze range) |
| arms | (stock) | faster elbow drive, stacked shoulder, hydraulic forearm |
| legs | (stock) | twin-drive knees, wider feet, shin guards |
| armour | (stock) | shell material and thickness per zone (UHMW, polycarb, AR500 plates) |
| weapon | none | one mount per design, from the catalog |

`'stock'` always means the design as built. A choice the design already wears counts as stock: FIRECRACKER and HAYMAKER are gloved, so for them GLOVES is stock and the picker shows it that way.

## How a loadout compiles

```
design(id) ─► applyLoadout(design, loadout) ─► compileRobot ─► MJCF
                 (src/robots/loadout.ts)
```

- `applyLoadout` is pure. A stock loadout, no loadout, or a choice the design already wears returns the **same design object**, so the compiled MJCF is byte-identical (tests/loadout: every design, every corner). Anything else returns a new design with `design.loadout` set, which the renderer and the tale of the tape key off.
- The physics (`src/physics/world.ts`) and the renderer (`WorldMeta.robots[i].loadout` → `render/robot-kit/build.ts`) run the same function, so the meshes always match the collision bodies.
- A slot swaps **parts** and adds **mechanisms**. It never edits the builder (`src/robots/humanoid.ts`) and it never changes a servo joint. Anything the controller reads stays where it was: the fist part keeps its id `fist_l` / `fist_r`, so reach, strike aim, get-ups and damage still find the hand.
- Joints a slot adds are **passive** (`JointDef.passive`: a spring, no servo) and are driven through **tendons** (`RobotDesign.tendons`: a fixed MuJoCo tendon plus one position actuator, appended after every servo actuator so actuator ids never shift). Passive joints stay out of `RobotRuntime.joints`, so the controller, the motor model, telemetry and the HUD see exactly the joints they saw before.

## Hands, as built

| Option | Striker | Mass per hand (SAVATE) | Notes |
|---|---|---|---|
| gloves | padded box 1.18 × the bare fist, `glove` material (cushioned: keeps the impulse, soft contact) | hollow 7075 hand + 8 / 10 / 16 oz by class | glove colour: the design's glove colour, else its livery primary |
| knuckle plates | bare block, AR500 | hollow hand + 6 mm AR500 plate | iron-age fists are already AR500 blocks: stock |
| dexterous | palm box (0.8 × fist thickness) + 10 capsule phalanges | 1.45 kg vs 1.40 stock | see below |

**Dexterous hand** (`src/robots/hands.ts`): four fingers and a thumb, two phalanges each on two flexion joints, all ten joints on one flexor tendon (spool ratio 0.3) reeled by one drive in the palm, with return springs. That is an underactuated tendon hand in the line of Dollar & Howe's SDM Hand (one actuator, eight joints) and the Yale OpenHand Model T: the fingers close together and each stops where it meets something.

- Grip drive: CubeMars AK60-6 V1.1 KV80 (9 N·m peak, 3 N·m rated, 320 rpm, 368 g), catalog `grip.ak60`. Each finger joint feels up to 2.7 N·m. The drive only pulls (force range 0 to stall); the springs open the hand.
- Measured in MuJoCo: fist in ~0.1 s (tendon within 2%, finger joints 85-87°, thumb 70° after 0.2 s), open in ~0.3 s.
- Grip system (`src/physics/systems/hands.ts`, after control): fist when striking, guarding or in range; half-closed hook in the clinch; open flat when falling; fist on the canvas and rising (the get-ups plant the knuckles); relaxed on the gantry or far apart; slack when knocked out or the battery is flat. Published as `RobotTelemetry.grip`.
- Damage: phalanges are parts (tag `finger`) whose geoms count as the palm for damage, so a punch on the fingers wounds the hand, the HUD and telemetry never list them, and a finger never detaches. A detachable finger would need its own debris twin with jointed children, which the debris model does not allow; not built.
- Cost: 20 more bodies and dofs per robot. MuJoCo step for two dexterous robots is ~125 µs vs ~82 µs stock (Node, standing). The finger armature is raised to 0.002 kg·m² for solver conditioning; below that the solver needs about 30% more iterations.

## Damage and repairs between fights (planned)

A fighter has a **chassis record**: design id, loadout, and per part `hp`, per joint `health` and `state`, hydraulic fluid, battery cycles. After a fight the worker's final telemetry is folded into the record:

- Part hp and joint health carry over. A limp or seized joint stays that way until repaired.
- A detached part is **lost**: it must be replaced before the next fight (the slot shows empty, the design will not compile without it).
- Heat and battery reset (cool-down and charge between fights), but a battery that ran below 5% loses 1% capacity.

At fight start the runtime seeds `PartRuntime.hp` and `JointRuntime.health` from the record instead of 1. Nothing else in the physics changes: a worn gearbox already has less torque and more backlash.

**Repairs** cost time and parts: re-shimming a degraded gearbox restores health to 0.8, replacing an actuator restores 1.0 and takes the part from a spares pool, re-skinning a shell restores hp. The workshop shows each repair's cost against what the damage does in the fight (for example "left knee at 40%: 25% less torque, backlash 2°").

## Workshop UI sketch

```
┌ WORKSHOP ─ SAVATE #21 ───────────────────────────────────────────────┐
│  [ rotating 3D model on the stand, the selected slot highlighted ]   │
│                                                                      │
│  SLOTS              OPTIONS (real specs)             STATS DELTA     │
│  ▸ HANDS  dexterous  ○ stock · knuckle plates  1.40 kg  mass  +0.1 kg │
│    HEAD   stock      ○ gloves 10 oz            1.01 kg  reach  +0 cm │
│    ARMS   stock      ● dexterous · AK60-6 grip 1.45 kg  dof   +2     │
│    LEGS   stock                                                      │
│    ARMOUR stock                                                      │
│    WEAPON —          DAMAGE   L knee 40% (backlash 2°)  [REPAIR 2 h] │
│                               R fist hp 72%             [RESKIN 1 h] │
│  [ TEST ON THE STAND ]  [ SPAR 30 s ]  [ SAVE BUILD ]                │
└──────────────────────────────────────────────────────────────────────┘
```

- The stand runs the real physics (the showroom's physics mode) so a new part is felt before a fight: stand, walk, throw.
- Every option lists its source (catalog `source` field) and mass. The tale of the tape updates live (the select screen already shows HANDS).
- SAVE BUILD writes the loadout and chassis record; the select screen offers saved builds next to the stock designs.

## Keeping it physically honest

1. Every part and drive comes from the catalog with a cited source, a mass, and (for drives) torque, speed and thermal numbers. A slot option without a source does not ship.
2. Mass is computed, never set for balance: shells from area × wall × density, fills from volume × solid share, drives from their datasheet mass. The tale of the tape shows the compiled mass.
3. Power: every servo draws from the same battery through the motor model. The grip drive is not on that model yet (its torque is fixed at the datasheet peak and it draws nothing); a weapon slot must be, and the grip drive should join it then.
4. The controller is never told about a loadout. If a part changes how the body moves (a heavier fist, a longer reach, open fingers on the canvas), the fight shows it. Measured: HAYMAKER's get-ups were tuned on its 21 oz gloves and rise less often on bare or dexterous hands (2-3 of 5-6 shoves vs 5 of 6). That result is left in, not tuned out.
5. Stock stays byte-identical (tests/loadout), so existing tuning and fixtures hold.
