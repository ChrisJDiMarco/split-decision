// Robot roster. Humanoids come from the parametric builder; other body types
// (quadruped, wheeled, tracked) register their own builders here.
//
// Two eras. The MODERN roster (default) is all-electric, 1.3-1.9 m and 38-103 kg, like the fighters
// of the 2025-26 China leagues (docs/research/07-china-robot-fights.md): our own four designs, specs
// in docs/research/08-modern-roster.md/.json. The IRON AGE class keeps the original hydraulic
// heavyweights (Bruiser, Striker, Goliath) as an optional selection.
import type { RobotDesign } from '../../core/types';
import { buildHumanoid, scaleForHeight, type HumanoidSpec } from '../humanoid';

// ---------------------------------------------------------------- modern (electric)
//
// Sizing notes shared by the four (numbers per design below):
//  · Height comes from scaleForHeight(spec height, proportions); proportions stretch the builder's
//    fixed segment ratios toward each design's concept art (docs/concept-art/modern/).
//  · Mass is the design's own shell model (wall thickness, internal fill, fist build) on top of the
//    catalog actuators and the gyro core; each lands within 1% of the roster doc (tests/roster).
//  · Gyro core: a control moment gyroscope sized to m·g·h (h = stance COM height): torque about
//    0.2-0.3·mgh, momentum ≈ torque / 3 s⁻¹ (Airbus CMG 15-45 S ratio), ~7.5 N·m·s per kg of core
//    (Seakeeper 1 class). The bantam gets the top of the band: it falls fastest (ω = √(g/h)).
//  · Head break impulse = head mass × 10 m/s × build factor (headgear 1.3, sunk UHMW hammerhead 1.2,
//    high slim-necked head 0.85). Calibrated on measured head strikes (tools/fight-sim.ts and gantry
//    trials, guard down): mirror-match clean shots peak near 8 N·s per kg of head (bantam 8, SAVATE
//    17, HAYMAKER 29 N·s), so a head pops to an exceptional shot or a heavier class's power punch.

const FIRECRACKER_PROPORTIONS = { shoulders: 1.06, arms: 1.06 };
const FIRECRACKER_SPEC: HumanoidSpec = {
  id: 'firecracker',
  name: 'FIRECRACKER',
  tagline: 'Thirty-eight kilos of fast hands, back up before the count starts.',
  scale: scaleForHeight(1.3, FIRECRACKER_PROPORTIONS),
  bulk: 0.95,
  proportions: FIRECRACKER_PROPORTIONS,
  armor: 'polycarb',
  frame: 'al6061',
  // Strike pass (docs/design/strike-power.md §2.8, approved 2026-10-06; gantry A/B in docs/research/
  // 08-modern-roster.md): the shoulder pitch and elbow were torque-bound through every punch.
  // Hardware pass (2026-10-20, Chris approved): hip pitch and roll on the RobStride 04 (120 N·m); the
  // AK10's 53 N·m could not hold the trunk and carry a swing's reaction (on the gantry a knee snap shoved
  // the thigh down at 5 rad/s). The ankles are their own group, still the AK10 (1.4 N·m per kg of body).
  motors: { leg: 'qdd.ak10', knee: 'qdd.rs04', arm: 'qdd.rs06', elbow: 'qdd.rs06', waist: 'qdd.rs03', neck: 'qdd.rs00', shoulderPitch: 'qdd.ak10', hipPitch: 'qdd.rs04', hipRoll: 'qdd.rs04', ankle: 'qdd.ak10' },
  fist: 'block',
  head: 'visor',
  gyro: { maxTorqueNm: 70, momentumNms: 24, massKg: 3.1 }, // mgh ≈ 250 N·m: 0.28·mgh, 8% of the body
  hydraulicArms: false,
  headBreakImpulseNs: 13, // 1.01 kg head × 10 m/s × 1.3 open-face padded headgear
  eyeColor: '#fff1dc',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'front_kick', 'low_kick', 'sprint'],
  defaultSkin: 'livery',
  look: { head: 'head.trio', torso: 'torso.pebble', fist: 'fist.glove', foot: 'leg.foot.round' },
  gloves: { color: '#d7263d', ounces: 8 },
  palette: { primary: '#f26b1d', secondary: '#2a2826', accent: '#fff1dc', finish: 'gloss' },
  weightClass: 'bantam',
  era: 'modern',
  // 2.5 mm polycarbonate covers (production-humanoid practice), a dense torso holding the pack. The
  // torso fill (pack, compute, wiring) gave the RS04 hips their 1.84 kg: 245 → 166 kg/m³, 5.67 → 3.84 kg.
  shell: { armorMm: 2.5, frameMm: 2, headMm: 2.5, fillKgM3: 100, torsoFillKgM3: 166, footFill: 0.22, handFill: 0.14, knucklePlateMm: 6 },
};
export const FIRECRACKER = buildHumanoid(FIRECRACKER_SPEC);

const SAVATE_PROPORTIONS = { legs: 1.04, arms: 1.06, torso: 0.96 };
const SAVATE_SPEC: HumanoidSpec = {
  id: 'savate',
  name: 'SAVATE',
  tagline: 'Twin-drive legs, 22 rad/s at the knee. The shins are the weapon.',
  scale: scaleForHeight(1.73, SAVATE_PROPORTIONS),
  bulk: 0.92,
  proportions: SAVATE_PROPORTIONS,
  armor: 'polycarb',
  frame: 'al7075',
  // Strike pass (strike-power.md §2.8): AKE90 shoulder pitch, a twin-AKE90 waist yaw (the chest
  // turned 6-7 of 21 rad/s on the RS04) and a twin-RS06 elbow (50 rad/s: a human elbow extends at 22-41).
  // Hardware pass (robot-realism-pass.md §3): the ankles are their own AKE90 (170 N·m, 2.0 N·m per kg of
  // body; the twin stack's 323 N·m was twice what an ankle can use on this foot).
  motors: { leg: 'qdd.ake90x2', knee: 'qdd.ake90x2', arm: 'qdd.rs04', elbow: 'qdd.rs06x2', waist: 'qdd.rs04', neck: 'servo.neck', shoulderPitch: 'qdd.ake90', waistYaw: 'qdd.ake90x2', ankle: 'qdd.ake90' },
  fist: 'block',
  head: 'slit',
  gyro: { maxTorqueNm: 140, momentumNms: 49, massKg: 6.5 }, // mgh ≈ 695 N·m: 0.2·mgh
  hydraulicArms: false,
  headBreakImpulseNs: 20, // 2.02 kg head × 10 m/s, no headgear
  eyeColor: '#9dffd6',
  abilities: ['jab', 'cross', 'hook', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'livery',
  look: { head: 'head.wedge', torso: 'torso.diamond', fist: 'fist.knuckle', shin: 'leg.shin.guard' },
  palette: { primary: '#3d1f4f', secondary: '#b9bcc0', accent: '#e9e2d0', finish: 'satin' },
  weightClass: 'middle',
  era: 'modern',
  // The 6.0 kg the lighter ankles freed went back into the torso fill (a T800-class pack): 140 → 272 kg/m³.
  shell: { armorMm: 2.5, frameMm: 2.5, headMm: 3, fillKgM3: 110, torsoFillKgM3: 272, footFill: 0.22, handFill: 0.14, knucklePlateMm: 6 },
};
export const SAVATE = buildHumanoid(SAVATE_SPEC);

const HAYMAKER_PROPORTIONS = { shoulders: 1.03, legs: 0.97, arms: 1.04, head: 0.95 };
const HAYMAKER_SPEC: HumanoidSpec = {
  id: 'haymaker',
  name: 'HAYMAKER',
  tagline: 'The heaviest thing electric joints can carry. Every punch is thrown to end it.',
  scale: scaleForHeight(1.82, HAYMAKER_PROPORTIONS),
  bulk: 1.12,
  proportions: HAYMAKER_PROPORTIONS,
  armor: 'uhmw',
  frame: 'al7075',
  // Strike pass (strike-power.md §2.8, decision D3: the hips too): AKE90 shoulder pitch, twin-AKE90
  // waist yaw, triple-AKE90 hip pitch and yaw (the X12 ran kicks at 0.75 of its 13.1 rad/s). Elbow
  // after the gantry A/B: the AKE90 (170 N·m, 22 rad/s) snaps as fast as the twin RS06 on this arm (7.05
  // vs 7.01 m/s) and pushes a 114 kg body up off the canvas (get-ups 7/8 against 5/6 and the RS04's
  // 5/8). Hip roll and the waist pitch stay on the X12. Hardware pass (robot-realism-pass.md §3): the
  // ankles moved off the X12 to their own AKE90 (170 N·m, 1.5 N·m per kg of body, backdrivable, 22 rad/s).
  motors: { leg: 'plan.x12', knee: 'qdd.ake90x3', arm: 'qdd.rs04', elbow: 'qdd.ake90', waist: 'plan.x12', neck: 'servo.neck', shoulderPitch: 'qdd.ake90', waistYaw: 'qdd.ake90x2', hipPitch: 'qdd.ake90x3', hipYaw: 'qdd.ake90x3', ankle: 'qdd.ake90' },
  fist: 'block',
  head: 'slit',
  gyro: { maxTorqueNm: 195, momentumNms: 68, massKg: 9.1 }, // mgh ≈ 950 N·m: 0.2·mgh, the biggest core
  hydraulicArms: false,
  headBreakImpulseNs: 36, // 2.97 kg head × 10 m/s × 1.2: thick UHMW hammerhead sunk between the cowls
  eyeColor: '#ff4d1a',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'overhand', 'low_kick', 'clinch'],
  defaultSkin: 'livery',
  look: { head: 'head.hammer', torso: 'torso.cowl', fist: 'fist.glove' },
  gloves: { color: '#2f4fa8', ounces: 21 },
  palette: { primary: '#56613a', secondary: '#141516', accent: '#d8d2bc', finish: 'matte' },
  weightClass: 'heavy',
  era: 'modern',
  // UHMW slabs are 15-20 mm on the chest faces and thinner elsewhere: 7 mm averaged over the shells.
  // The 3.9 kg the AKE90 ankles freed went into the torso fill (pack): 75 → 118 kg/m³.
  shell: { armorMm: 7, frameMm: 2.5, headMm: 8, fillKgM3: 100, torsoFillKgM3: 118, footFill: 0.22, handFill: 0.14, knucklePlateMm: 6 },
};
export const HAYMAKER = buildHumanoid(HAYMAKER_SPEC);

const PYLON_PROPORTIONS = { legs: 1.06, arms: 1.12, torso: 0.94, head: 0.92, shoulders: 0.95 };
const PYLON_SPEC: HumanoidSpec = {
  id: 'pylon',
  name: 'PYLON',
  tagline: "Six foot two of legs. It hits you from where you can't hit back.",
  scale: scaleForHeight(1.89, PYLON_PROPORTIONS),
  bulk: 0.78,
  proportions: PYLON_PROPORTIONS,
  armor: 'carbon',
  frame: 'al7075',
  // Strike pass (strike-power.md §2.8): AKE90 shoulder pitch, twin-RS06 elbow (the RS06 ran at
  // 0.27-0.43 of no-load, torque-bound), twin-AKE90 waist yaw. Hardware pass (robot-realism-pass.md §3):
  // the ankles are their own AKE90 (170 N·m, 2.0 N·m per kg of body).
  motors: { leg: 'qdd.ake90x2', knee: 'qdd.ake90x2', arm: 'qdd.rs03', elbow: 'qdd.rs06x2', waist: 'qdd.rs04', neck: 'qdd.rs00', shoulderPitch: 'qdd.ake90', waistYaw: 'qdd.ake90x2', ankle: 'qdd.ake90' },
  fist: 'block',
  head: 'twin',
  gyro: { maxTorqueNm: 150, momentumNms: 51, massKg: 6.8 }, // mgh ≈ 745 N·m: 0.2·mgh (it saturates first: narrow hips, high COM)
  hydraulicArms: false,
  headBreakImpulseNs: 19, // 2.24 kg head × 10 m/s × 0.85: the highest head on the slimmest neck
  eyeColor: '#b58cff',
  abilities: ['jab', 'cross', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'livery',
  look: { head: 'head.lozenge', torso: 'torso.slim', fist: 'fist.knuckle' },
  palette: { primary: '#c6f000', secondary: '#1c1d1f', accent: '#c9ccd1', finish: 'satin' },
  weightClass: 'middle',
  era: 'modern',
  // The 6.0 kg the lighter ankles freed went back into the torso fill (pack): 120 → 268 kg/m³.
  shell: { armorMm: 2.5, frameMm: 2.5, headMm: 3, fillKgM3: 110, torsoFillKgM3: 268, footFill: 0.22, handFill: 0.14, knucklePlateMm: 6 },
};
export const PYLON = buildHumanoid(PYLON_SPEC);

// ---------------------------------------------------------------- iron age (hydraulic heavyweights)

export const BRUISER = buildHumanoid({
  id: 'bruiser',
  name: 'BRUISER',
  tagline: 'Heavyweight boxer. Hydraulic forearms, AR500 plate, a jaw like a bank vault.',
  scale: 1.0,
  bulk: 1.3,
  armor: 'ar500',
  frame: 'al7075',
  // 244 kg on 450 N·m electric legs saturates in single support: 32 mm hydraulic legs (650 N·m).
  // The waist carries a 150 kg upper body (over 500 N·m bent level): it is hydraulic too.
  motors: { leg: 'hyd.cyl32', knee: 'hyd.cyl32', arm: 'qdd.rs04x3', elbow: 'qdd.rs04x3', waist: 'hyd.cyl32', neck: 'servo.neck' },
  fist: 'block',
  head: 'slit',
  gyro: { maxTorqueNm: 420, momentumNms: 160, massKg: 14 },
  hydraulicArms: true,
  hydraulicLegs: true,
  headBreakImpulseNs: 75, // measured strikes: p90 30-50 N·s, max ~73 (tools/fight-sim.ts)
  eyeColor: '#ff7a1a',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'overhand', 'front_kick', 'clinch'],
  defaultSkin: 'factory',
  weightClass: 'open',
  era: 'iron',
});

export const STRIKER = buildHumanoid({
  id: 'striker',
  name: 'STRIKER',
  tagline: 'Titanium kickboxer. Long legs, fast joints, glass jaw.',
  scale: 1.04,
  bulk: 0.95,
  armor: 'ti6al4v',
  frame: 'carbon',
  // T800 legs (450 N·m, 9 rad/s): stiffer balance and faster kicks than the stacked RS04.
  motors: { leg: 'qdd.t800', knee: 'qdd.t800', arm: 'qdd.rs04', elbow: 'qdd.rs04', waist: 'qdd.rs04x3', neck: 'servo.neck' },
  fist: 'block',
  head: 'twin',
  gyro: { maxTorqueNm: 300, momentumNms: 110, massKg: 9 },
  hydraulicArms: false,
  headBreakImpulseNs: 55, // glass jaw
  eyeColor: '#27e3ff',
  abilities: ['jab', 'cross', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'neon',
  weightClass: 'open',
  era: 'iron',
});

export const GOLIATH = buildHumanoid({
  id: 'goliath',
  name: 'GOLIATH',
  tagline: 'A walking gyroscope with pneumatic fists. Slow to start, impossible to stop.',
  scale: 1.1,
  bulk: 1.45,
  armor: 'ar500',
  frame: 'steel',
  // 380 kg is beyond electric QDD joints (t800 = 1.2 N·m/kg of knee): hydraulic legs and waist.
  // The fists are pneumatic: CO2 punch rams drive the elbows (the rocket punch).
  motors: { leg: 'hyd.cyl50', knee: 'hyd.cyl50', arm: 'qdd.t800', elbow: 'pneu.ram', waist: 'hyd.cyl50', neck: 'servo.neck' },
  fist: 'piston',
  head: 'dome',
  gyro: { maxTorqueNm: 650, momentumNms: 260, massKg: 22 },
  hydraulicArms: false,
  hydraulicLegs: true,
  headBreakImpulseNs: 90,
  eyeColor: '#ffc23d',
  abilities: ['jab', 'overhand', 'rocket_punch', 'clinch', 'front_kick'],
  defaultSkin: 'scrapyard',
  weightClass: 'open',
  era: 'iron',
});

/**
 * The modern designs' builder specs, by id: tools rebuild variants from them (an actuator A/B on the
 * gantry and in the drills, docs/research/08-modern-roster.md). The game uses DESIGNS.
 */
export const MODERN_SPECS: Readonly<Record<string, HumanoidSpec>> = {
  firecracker: FIRECRACKER_SPEC,
  savate: SAVATE_SPEC,
  haymaker: HAYMAKER_SPEC,
  pylon: PYLON_SPEC,
};

/** The whole roster in display order: the modern four first, then the iron age. */
export const DESIGNS: Record<string, RobotDesign> = {
  [FIRECRACKER.id]: FIRECRACKER,
  [SAVATE.id]: SAVATE,
  [HAYMAKER.id]: HAYMAKER,
  [PYLON.id]: PYLON,
  [BRUISER.id]: BRUISER,
  [STRIKER.id]: STRIKER,
  [GOLIATH.id]: GOLIATH,
};

export function design(id: string): RobotDesign {
  const d = DESIGNS[id];
  if (!d) throw new Error(`Unknown robot design '${id}'`);
  return d;
}
