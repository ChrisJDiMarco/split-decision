// Pure mappings from physical quantities to effect budgets. Kept separate so they can be
// unit tested and tuned in one place.
import { clamp } from './coords';

/** Metal-on-metal hits below this energy throw no sparks (a light tap). */
export const SPARK_MIN_ENERGY_J = 4;
/** Heavy hits above this energy knock bolts and fragments loose. */
export const DEBRIS_MIN_ENERGY_J = 350;
/** Bodies hitting the canvas faster than this raise dust. */
export const DUST_MIN_SPEED = 1.4;

export const MAX_SPARKS_PER_BURST = 320;

/** Spark count grows with the square root of energy (surface area of the torn contact). */
export function sparkCount(energyJ: number): number {
  if (energyJ < SPARK_MIN_ENERGY_J) return 0;
  return Math.round(clamp(8 + Math.sqrt(energyJ) * 4.2, 8, MAX_SPARKS_PER_BURST));
}

/** Typical launch speed of sparks in m/s. */
export function sparkSpeed(energyJ: number): number {
  return clamp(2 + Math.sqrt(Math.max(0, energyJ)) * 0.24, 2, 11);
}

/** Loose bolts and fragments thrown by a heavy impact. */
export function debrisCount(energyJ: number): number {
  if (energyJ < DEBRIS_MIN_ENERGY_J) return 0;
  return Math.round(clamp(1 + (energyJ - DEBRIS_MIN_ENERGY_J) / 300, 1, 6));
}

/** Tiny metal chips flaked off by a spark-producing hit. */
export function chipCount(energyJ: number): number {
  if (energyJ < 40) return 0;
  return Math.round(clamp(energyJ / 110, 1, 8));
}

/** Dust puffs from a slam into the canvas, by closing speed. */
export function dustPuffs(speed: number): number {
  if (speed < DUST_MIN_SPEED) return 0;
  return Math.round(clamp(4 + (speed - DUST_MIN_SPEED) * 5, 4, 22));
}

/** Light flash intensity (candela-ish, three.js physical units) for an impact. */
export function flashIntensity(energyJ: number): number {
  return clamp(Math.sqrt(Math.max(0, energyJ)) * 1.6, 0, 45);
}

/**
 * Smoke puffs per second for a telemetry smoke level 0..1. Below ~0.1 the part only
 * gives off a faint heat haze.
 */
export function smokeRate(smoke: number): number {
  const s = clamp(smoke, 0, 1);
  return s < 0.02 ? 0 : 3 + s * s * 34;
}

/** Smoke darkness 0 (light grey haze) .. 1 (thick black). */
export function smokeDarkness(smoke: number): number {
  return clamp((smoke - 0.25) / 0.6, 0, 1);
}

/** Hydraulic oil jet speed (m/s) from circuit pressure 0..1 and the leak rate. */
export function leakJetSpeed(pressure: number, leakLps: number): number {
  const p = clamp(pressure, 0, 1);
  // Bernoulli: v ∝ √ΔP. Scaled so a full-pressure rupture reads as a hard spurt
  // (~4.5 m/s) that lands near the robot; a dead circuit just dribbles.
  return 0.3 + 4.2 * Math.sqrt(p) * clamp(0.6 + leakLps * 0.4, 0.6, 1.1);
}
