// Parts catalog: materials and actuators with real-world numbers.
// Sources are in docs/research/02-actuators.md. Where a fighter needs more torque
// than one module gives, the catalog entry names the stack (module + extra gearing)
// and derives torque and speed from it, so the numbers stay traceable.
import type { MaterialId, MaterialSpec, MotorSpec } from '../core/types';

export const MATERIALS: Record<MaterialId, MaterialSpec> = {
  ar500: { id: 'ar500', name: 'AR500 armor steel', densityKgM3: 7850, yieldMPa: 1400, brinell: 500, friction: 0.6, sparks: true },
  steel: { id: 'steel', name: 'Mild steel', densityKgM3: 7850, yieldMPa: 250, brinell: 120, friction: 0.6, sparks: true },
  al6061: { id: 'al6061', name: '6061-T6 aluminum', densityKgM3: 2700, yieldMPa: 276, brinell: 95, friction: 0.55, sparks: false },
  al7075: { id: 'al7075', name: '7075-T6 aluminum', densityKgM3: 2810, yieldMPa: 503, brinell: 150, friction: 0.55, sparks: false },
  ti6al4v: { id: 'ti6al4v', name: 'Grade 5 titanium', densityKgM3: 4430, yieldMPa: 880, brinell: 334, friction: 0.5, sparks: true },
  uhmw: { id: 'uhmw', name: 'UHMW polyethylene', densityKgM3: 940, yieldMPa: 21, brinell: 5, friction: 0.25, sparks: false },
  polycarb: { id: 'polycarb', name: 'Polycarbonate', densityKgM3: 1200, yieldMPa: 62, brinell: 15, friction: 0.4, sparks: false },
  carbon: { id: 'carbon', name: 'Carbon fiber', densityKgM3: 1600, yieldMPa: 600, brinell: 60, friction: 0.4, sparks: false },
  rubber: { id: 'rubber', name: 'Rubber', densityKgM3: 1100, yieldMPa: 15, brinell: 1, friction: 1.1, sparks: false },
};

/**
 * Mass model. Armor, frame and sensor parts are hollow shells: mass = surface area ×
 * wall thickness × density, plus an internal fill (wiring, electronics, brackets).
 * Strikers, feet, wheels and weapons are dense, so they use a solid fill fraction.
 * Motors and the gyro core are added on top from their catalog masses.
 */
export const WALL_MM: Record<string, number> = { armor: 4, structure: 3, sensor: 3 };
export const SOLID_FILL: Record<string, number> = { striker: 0.14, foot: 0.22, wheel: 0.45, weapon: 0.5 };
export const INTERNAL_FILL_KG_M3 = 110;

const RS04_TORQUE = 120; // RobStride 04 peak, N·m, 9:1 internal
const RS04_SPEED = (200 * 2 * Math.PI) / 60; // 200 rpm no-load

export const MOTORS: Record<string, MotorSpec> = {
  'qdd.rs04': {
    id: 'qdd.rs04', name: 'RobStride 04 QDD (9:1)', kind: 'electric',
    stallTorqueNm: RS04_TORQUE, noLoadSpeedRadS: RS04_SPEED, massKg: 1.42,
    heatCapacityJPerK: 480, thermalResistanceKPerW: 0.9, maxTempC: 120, copperLossAtStallW: 1300,
    source: 'openelab.io RobStride04: 40/120 N·m, 200 rpm, 1420 g',
  },
  'qdd.rs04x3': {
    id: 'qdd.rs04x3', name: 'RobStride 04 + 3:1 cycloidal', kind: 'electric',
    stallTorqueNm: RS04_TORQUE * 3 * 0.9, noLoadSpeedRadS: RS04_SPEED / 3, massKg: 2.6,
    heatCapacityJPerK: 700, thermalResistanceKPerW: 0.8, maxTempC: 120, copperLossAtStallW: 1300,
    source: 'RobStride 04 stacked with a 3:1 cycloidal stage at 90% efficiency',
  },
  'qdd.t800': {
    id: 'qdd.t800', name: 'T800-class 450 N·m joint', kind: 'electric',
    stallTorqueNm: 450, noLoadSpeedRadS: 9, massKg: 3.8,
    heatCapacityJPerK: 1100, thermalResistanceKPerW: 0.5, maxTempC: 130, copperLossAtStallW: 2600,
    source: 'EngineAI T800: 450 N·m peak joint torque, active leg cooling (urkl.org/t800)',
  },
  'qdd.ak80': {
    id: 'qdd.ak80', name: 'CubeMars AK80-9 V3', kind: 'electric',
    stallTorqueNm: 22, noLoadSpeedRadS: (570 * 2 * Math.PI) / 60, massKg: 0.49,
    heatCapacityJPerK: 200, thermalResistanceKPerW: 1.6, maxTempC: 110, copperLossAtStallW: 280,
    source: 'cubemars.com AK80-9 V3: 9/22 N·m, 570 rpm, 490 g',
  },
  'hyd.cyl50': {
    id: 'hyd.cyl50', name: '50 mm bore hydraulic cylinder @ 210 bar', kind: 'hydraulic',
    // 41 kN at the rod through an ~0.12 m lever arm ≈ 4.9 kN·m; derated to a controllable 1.4 kN·m
    stallTorqueNm: 1400, noLoadSpeedRadS: 7, massKg: 6.5,
    heatCapacityJPerK: 3000, thermalResistanceKPerW: 0.2, maxTempC: 90, copperLossAtStallW: 900,
    source: 'Standard 50 mm bore cylinder; 210 bar × 19.6 cm² = 41 kN',
  },
  'hyd.cyl32': {
    id: 'hyd.cyl32', name: '32 mm bore hydraulic cylinder @ 210 bar', kind: 'hydraulic',
    stallTorqueNm: 650, noLoadSpeedRadS: 10, massKg: 3.2,
    heatCapacityJPerK: 1800, thermalResistanceKPerW: 0.25, maxTempC: 90, copperLossAtStallW: 500,
    source: 'Standard 32 mm bore cylinder; 210 bar × 8.0 cm² = 16.9 kN',
  },
  'pneu.ram': {
    id: 'pneu.ram', name: 'Pneumatic punch ram (CO2, 800 psi)', kind: 'pneumatic',
    stallTorqueNm: 2200, noLoadSpeedRadS: 30, massKg: 2.2,
    heatCapacityJPerK: 900, thermalResistanceKPerW: 0.3, maxTempC: 80, copperLossAtStallW: 0,
    source: 'Combat-robot flipper practice: CO2 at 800 psi through a 1.5 in bore ram',
  },
  'servo.neck': {
    id: 'servo.neck', name: 'Neck pan servo (RobStride 02)', kind: 'electric',
    stallTorqueNm: 17, noLoadSpeedRadS: 12, massKg: 0.41,
    heatCapacityJPerK: 180, thermalResistanceKPerW: 1.8, maxTempC: 110, copperLossAtStallW: 160,
    source: 'RobStride 02: 17 N·m peak, 405 g',
  },
  'drive.wheel': {
    id: 'drive.wheel', name: 'Hub drive motor (RobStride 04 direct)', kind: 'electric',
    stallTorqueNm: 120, noLoadSpeedRadS: 30, massKg: 1.6,
    heatCapacityJPerK: 500, thermalResistanceKPerW: 0.9, maxTempC: 120, copperLossAtStallW: 1200,
    source: 'RobStride 04 class hub motor',
  },
};

export function motor(id: string): MotorSpec {
  const spec = MOTORS[id];
  if (!spec) throw new Error(`Unknown motor '${id}'`);
  return spec;
}
