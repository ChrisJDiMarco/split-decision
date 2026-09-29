// Robot roster. Humanoids come from the parametric builder; other body types
// (quadruped, wheeled, tracked) register their own builders here.
import type { RobotDesign } from '../../core/types';
import { buildHumanoid } from '../humanoid';

export const BRUISER = buildHumanoid({
  id: 'bruiser',
  name: 'BRUISER',
  tagline: 'Heavyweight boxer. Hydraulic forearms, AR500 plate, a jaw like a bank vault.',
  scale: 1.0,
  bulk: 1.3,
  armor: 'ar500',
  frame: 'al7075',
  motors: { leg: 'qdd.t800', knee: 'qdd.t800', arm: 'qdd.rs04x3', elbow: 'qdd.rs04x3', waist: 'qdd.t800', neck: 'servo.neck' },
  fist: 'block',
  head: 'slit',
  gyro: { maxTorqueNm: 420, momentumNms: 160, massKg: 14 },
  hydraulicArms: true,
  headBreakImpulseNs: 260,
  eyeColor: '#ff7a1a',
  abilities: ['jab', 'cross', 'hook', 'uppercut', 'overhand', 'front_kick', 'clinch'],
  defaultSkin: 'factory',
});

export const STRIKER = buildHumanoid({
  id: 'striker',
  name: 'STRIKER',
  tagline: 'Titanium kickboxer. Long legs, fast joints, glass jaw.',
  scale: 1.04,
  bulk: 0.95,
  armor: 'ti6al4v',
  frame: 'carbon',
  motors: { leg: 'qdd.rs04x3', knee: 'qdd.t800', arm: 'qdd.rs04', elbow: 'qdd.rs04', waist: 'qdd.rs04x3', neck: 'servo.neck' },
  fist: 'block',
  head: 'twin',
  gyro: { maxTorqueNm: 300, momentumNms: 110, massKg: 9 },
  hydraulicArms: false,
  headBreakImpulseNs: 190,
  eyeColor: '#27e3ff',
  abilities: ['jab', 'cross', 'front_kick', 'low_kick', 'head_kick', 'sprint'],
  defaultSkin: 'neon',
});

export const GOLIATH = buildHumanoid({
  id: 'goliath',
  name: 'GOLIATH',
  tagline: 'A walking gyroscope with pneumatic fists. Slow to start, impossible to stop.',
  scale: 1.1,
  bulk: 1.45,
  armor: 'ar500',
  frame: 'steel',
  motors: { leg: 'qdd.t800', knee: 'qdd.t800', arm: 'qdd.t800', elbow: 'qdd.rs04x3', waist: 'qdd.t800', neck: 'servo.neck' },
  fist: 'piston',
  head: 'dome',
  gyro: { maxTorqueNm: 650, momentumNms: 260, massKg: 22 },
  hydraulicArms: true,
  headBreakImpulseNs: 320,
  eyeColor: '#ffc23d',
  abilities: ['jab', 'overhand', 'rocket_punch', 'clinch', 'front_kick'],
  defaultSkin: 'scrapyard',
});

export const DESIGNS: Record<string, RobotDesign> = {
  [BRUISER.id]: BRUISER,
  [STRIKER.id]: STRIKER,
  [GOLIATH.id]: GOLIATH,
};

export function design(id: string): RobotDesign {
  const d = DESIGNS[id];
  if (!d) throw new Error(`Unknown robot design '${id}'`);
  return d;
}
