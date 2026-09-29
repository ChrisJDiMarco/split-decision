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
  // Boxing glove: leather over layered EVA/PU foam. An 8 oz glove (0.23 kg) fills about 1.3 L, so the
  // bulk density is ~180 kg/m³. It is the softest striker in the cage: a glove keeps the impulse about
  // the same but lowers peak force and stretches contact to 18-29 ms (Nakano et al., ISBS 2009). The
  // damage model treats it as a cushion (CUSHION_MATERIALS) and it never throws sparks.
  glove: { id: 'glove', name: 'Boxing glove (leather over foam)', densityKgM3: 180, yieldMPa: 2, brinell: 1, friction: 0.8, sparks: false },
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

  // ---------------------------------------------------------------- electric fighter modules
  // The modern roster (docs/research/08-modern-roster.md) runs only on these. Two classes:
  //  · quasi-direct-drive (QDD, 7.75-10:1): backdrivable, fast, forgiving under impact;
  //  · planetary (20:1): more torque per kg, slower, backdrives less (more gear damage when hit).
  // Peak torque, no-load speed and mass are from the vendor sheets cited per entry. The thermal
  // numbers are not published: heat capacity is ~340 J/K per kg of module (as the RS04 entry), the
  // winding resistance falls with module size, and copper loss at stall is set so that holding the
  // rated torque warms the windings ~100 K above ambient (loss ∝ (τ/τ_stall)², as the motor model).
  'qdd.ak10': {
    id: 'qdd.ak10', name: 'CubeMars AK10-9 V3 QDD (9:1)', kind: 'electric',
    stallTorqueNm: 53, noLoadSpeedRadS: (320 * 2 * Math.PI) / 60, massKg: 0.96,
    heatCapacityJPerK: 326, thermalResistanceKPerW: 1.1, maxTempC: 110, copperLossAtStallW: 790,
    source: 'cubemars.com/product/ak10-9-v3-0-kv60-robotic-actuator.html: 18/53 N·m, 320 rpm, 960 g, 48 V',
  },
  'qdd.rs00': {
    id: 'qdd.rs00', name: 'RobStride 00 QDD (10:1)', kind: 'electric',
    stallTorqueNm: 14, noLoadSpeedRadS: (315 * 2 * Math.PI) / 60, massKg: 0.31,
    heatCapacityJPerK: 105, thermalResistanceKPerW: 1.9, maxTempC: 120, copperLossAtStallW: 410,
    source: 'github.com/RobStride/Product_Information: RobStride 00, 5/14 N·m, 315 rpm, 310 g',
  },
  'qdd.rs02': {
    id: 'qdd.rs02', name: 'RobStride 02 QDD (7.75:1)', kind: 'electric',
    stallTorqueNm: 17, noLoadSpeedRadS: (410 * 2 * Math.PI) / 60, massKg: 0.405,
    heatCapacityJPerK: 138, thermalResistanceKPerW: 1.6, maxTempC: 120, copperLossAtStallW: 370,
    source: 'github.com/RobStride/Product_Information: RobStride 02, 7/17 N·m, 410 rpm, 405 g',
  },
  'qdd.rs03': {
    id: 'qdd.rs03', name: 'RobStride 03 QDD (9:1)', kind: 'electric',
    stallTorqueNm: 60, noLoadSpeedRadS: (195 * 2 * Math.PI) / 60, massKg: 0.9,
    heatCapacityJPerK: 306, thermalResistanceKPerW: 1.0, maxTempC: 120, copperLossAtStallW: 820,
    source: 'github.com/RobStride/Product_Information: RobStride 03, 21/60 N·m, 195 rpm, 900 g',
  },
  'qdd.rs06': {
    id: 'qdd.rs06', name: 'RobStride 06 QDD (9:1)', kind: 'electric',
    stallTorqueNm: 36, noLoadSpeedRadS: (480 * 2 * Math.PI) / 60, massKg: 0.621,
    heatCapacityJPerK: 211, thermalResistanceKPerW: 1.3, maxTempC: 120, copperLossAtStallW: 820,
    source: 'robstride.com/products/robStride06: 11/36 N·m, 480 rpm, 621 g',
  },
  'plan.x12': {
    id: 'plan.x12', name: 'MyActuator RMD-X12-P20-320-E planetary (20:1)', kind: 'electric',
    stallTorqueNm: 320, noLoadSpeedRadS: (125 * 2 * Math.PI) / 60, massKg: 2.37,
    heatCapacityJPerK: 806, thermalResistanceKPerW: 0.7, maxTempC: 120, copperLossAtStallW: 2030,
    source: 'openelab.io/products/myactuator-rmd-x12-p20-actuator: 85/320 N·m, 125 rpm, 2.37 kg, 48 V, 100 A rms peak',
  },
  'plan.x15': {
    id: 'plan.x15', name: 'MyActuator RMD-X15-P20-450-E planetary (20.25:1)', kind: 'electric',
    stallTorqueNm: 450, noLoadSpeedRadS: (108 * 2 * Math.PI) / 60, massKg: 3.5,
    heatCapacityJPerK: 1190, thermalResistanceKPerW: 0.55, maxTempC: 120, copperLossAtStallW: 1750,
    source: 'openelab.io/products/myactuator-rmd-x15-p20-actuator: 145/450 N·m, 108 rpm, 3.5 kg, 72 V (the 450 N·m class EngineAI quotes for the T800)',
  },

  // ---------------------------------------------------------------- fast high-torque leg drives
  // The 20:1 planetaries above cap a kick near half human speed: a head kick swings the knee at
  // ~22 rad/s (CMU 135_07), the X15 turns 11.3 and the X12 13.1. The CubeMars AKE90-8 KV35 is a
  // real 8:1 QDD with nearly the X15's torque per kg (121 vs 129 N·m/kg) at twice its speed.
  // One module is too small for an 80-105 kg leg, so the big joints stack 2-3 of them in parallel
  // on one output (one each side of the joint, a shared splined output ring). Derived numbers:
  //  · torque   n × 170 N·m × 0.95: parallel drives share load imperfectly (each has 9 arcmin of
  //             backlash and its own current loop), so 5% is left on the table (our assumption);
  //  · speed    unchanged, 210 rpm = 22.0 rad/s (parallel modules turn together);
  //  · mass     n × 1.40 kg + 0.10 kg per added module for the coupling ring (our estimate);
  //  · thermal  as the modules above: heat capacity ~340 J/K per kg, one module 0.9 K/W (the RS04's
  //             class at the same mass), copper loss at stall set so holding the 55 N·m rated torque
  //             sits 100 K over ambient: 100 / (0.9 × (55/170)²) = 1060 W (cross-check: 72 A peak
  //             through the published 0.164 Ω line-line winding is 850-1280 W). n modules in
  //             parallel: n × heat capacity, 1/n × thermal resistance, n × copper loss.
  'qdd.ake90': {
    id: 'qdd.ake90', name: 'CubeMars AKE90-8 KV35 QDD (8:1)', kind: 'electric',
    stallTorqueNm: 170, noLoadSpeedRadS: (210 * 2 * Math.PI) / 60, massKg: 1.4,
    heatCapacityJPerK: 476, thermalResistanceKPerW: 0.9, maxTempC: 120, copperLossAtStallW: 1060,
    source: 'cubemars.com/product/ake90-8-kv35-quasi-direct-drive-actuator.html: 55/170 N·m, 210 rpm no-load, 1400 g, 8:1, 48 V, 72 A peak',
  },
  'qdd.ake90x2': {
    id: 'qdd.ake90x2', name: '2 × CubeMars AKE90-8 in parallel', kind: 'electric',
    stallTorqueNm: 2 * 170 * 0.95, noLoadSpeedRadS: (210 * 2 * Math.PI) / 60, massKg: 2 * 1.4 + 0.1,
    heatCapacityJPerK: 2 * 476, thermalResistanceKPerW: 0.9 / 2, maxTempC: 120, copperLossAtStallW: 2 * 1060,
    source: 'Stack: two CubeMars AKE90-8 KV35 (cubemars.com/product/ake90-8-kv35-quasi-direct-drive-actuator.html, 170 N·m, 210 rpm, 1.4 kg) on one output; 2 × 170 × 0.95 load share = 323 N·m, 22.0 rad/s, 2.9 kg with coupling',
  },
  'qdd.ake90x3': {
    id: 'qdd.ake90x3', name: '3 × CubeMars AKE90-8 in parallel', kind: 'electric',
    stallTorqueNm: 3 * 170 * 0.95, noLoadSpeedRadS: (210 * 2 * Math.PI) / 60, massKg: 3 * 1.4 + 0.2,
    heatCapacityJPerK: 3 * 476, thermalResistanceKPerW: 0.9 / 3, maxTempC: 120, copperLossAtStallW: 3 * 1060,
    source: 'Stack: three CubeMars AKE90-8 KV35 (cubemars.com/product/ake90-8-kv35-quasi-direct-drive-actuator.html, 170 N·m, 210 rpm, 1.4 kg) on one output; 3 × 170 × 0.95 load share = 485 N·m, 22.0 rad/s, 4.4 kg with coupling',
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
  // Grip drive of the dexterous hand (src/robots/hands.ts): one motor in the palm reels a flexor
  // tendon routed over all ten finger joints, like the single-actuator underactuated hands
  // (Dollar & Howe's SDM Hand: one actuator, four fingers, eight joints; the Yale OpenHand
  // Model T). Numbers are the drive module itself at its output; the spool ratio lives on the tendon.
  'grip.ak60': {
    id: 'grip.ak60', name: 'CubeMars AK60-6 V1.1 KV80 grip drive (6:1)', kind: 'electric',
    stallTorqueNm: 9, noLoadSpeedRadS: (320 * 2 * Math.PI) / 60, massKg: 0.368,
    heatCapacityJPerK: 125, thermalResistanceKPerW: 2.2, maxTempC: 100, copperLossAtStallW: 180,
    source: 'cubemars.com/product/ak60-6-v1-1-kv80-robotic-actuator.html: 3/9 N·m, 320 rpm, 368 g, 6:1; single-actuator tendon hand after Dollar & Howe, "The Highly Adaptive SDM Hand" (IJRR 2010)',
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
