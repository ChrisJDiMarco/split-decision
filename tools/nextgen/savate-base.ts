// The Phase 0 baseline: SAVATE exactly as committed at 92a0259 (before the strike-pass actuator
// swaps, docs/design/strike-power.md §2.8, which were mid-build when Phase 0 ran). Frozen here so the
// six variants don't move while another build edits src/robots/designs. The swaps change SAVATE's arms
// and waist yaw only (elbow rs06x2, shoulder pitch ake90, waist yaw ake90x2): its legs, which are what
// Phase 0 measures, are the same drives (ake90x2 hips, knee and ankles) either way.
// tools/nextgen/check.ts proves this builds to the locked MJCF (tests/nextgen/fixtures/modern-mjcf.json).
import type { RobotDesign } from '../../src/core/types';
import { buildHumanoid, scaleForHeight } from '../../src/robots/humanoid';

const SAVATE_PROPORTIONS = { legs: 1.04, arms: 1.06, torso: 0.96 };
export const SAVATE_BASE: RobotDesign = buildHumanoid({
  id: 'savate',
  name: 'SAVATE',
  tagline: 'Twin-drive legs, 22 rad/s at the knee. The shins are the weapon.',
  scale: scaleForHeight(1.73, SAVATE_PROPORTIONS),
  bulk: 0.92,
  proportions: SAVATE_PROPORTIONS,
  armor: 'polycarb',
  frame: 'al7075',
  motors: { leg: 'qdd.ake90x2', knee: 'qdd.ake90x2', arm: 'qdd.rs04', elbow: 'qdd.rs03', waist: 'qdd.rs04', neck: 'servo.neck' },
  fist: 'block',
  head: 'slit',
  gyro: { maxTorqueNm: 140, momentumNms: 49, massKg: 6.5 },
  hydraulicArms: false,
  headBreakImpulseNs: 20,
  eyeColor: '#9dffd6',
  abilities: ['jab', 'cross', 'hook', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'livery',
  look: { head: 'head.wedge', torso: 'torso.diamond', fist: 'fist.knuckle', shin: 'leg.shin.guard' },
  palette: { primary: '#3d1f4f', secondary: '#b9bcc0', accent: '#e9e2d0', finish: 'satin' },
  weightClass: 'middle',
  era: 'modern',
  shell: { armorMm: 2.5, frameMm: 2.5, headMm: 3, fillKgM3: 110, torsoFillKgM3: 140, footFill: 0.22, handFill: 0.14, knucklePlateMm: 6 },
});
