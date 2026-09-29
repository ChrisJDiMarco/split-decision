// Pure mappings from physical quantities to effect budgets. Kept separate so they can be
// unit tested and tuned in one place.
import type { SimEvent } from '../../core/protocol';
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

// ---------------------------------------------------------------- hit feel
//
// One presentation scale for how hard a landed strike was, shared by the VFX, the camera
// (punch-in, shake, reaction cuts), hit-stop and the post pulse. Measured on the electric roster
// with a scratch copy of tools/fight-sim.ts (savate/haymaker/firecracker/pylon, 2026-09-29):
// robot-on-robot energy p50 2-4 J, p90 9-20 J, max 39-78 J; impulse p90 25-32, max 75-80 N·s.
// The iron-age heavies hit harder (energy p90 46 J, max 101 J; impulse p90 87 N·s) and saturate.

/** A strike with this much closing energy reads as a full-strength hit (strength 1). */
export const HIT_FULL_J = 60;
/** Or this much impulse, delivered at striking speed. */
export const HIT_FULL_NS = 90;
/** Impulse only counts as a blow at closing speeds from ~1 m/s (a lean or a clinch shove is not a hit)... */
const HIT_PUSH_SPEED = 1;
/** ...and fully from this speed. */
const HIT_STRIKE_SPEED = 3;

/** Strength bands (0..1): below MIN a touch produces nothing at all. */
export const HIT = {
  MIN: 0.25, // ~3.8 J: a small glove puff
  RING: 0.4, // ~10 J (about the top 15% of landed hits): shockwave ring and camera punch-in
  FLASH: 0.45, // ~12 J: surface flash on the struck part
  FLECKS: 0.7, // ~29 J (top 2-3%): armor flecks fly
  HIT_STOP: 0.6, // ~22 J at >= 3 m/s (2.5-4 per minute on the electric roster): hit-stop
  PULSE: 0.75, // ~34 J (top 1-2%): post-processing pulse
} as const;

/**
 * 0..1 presentation strength of a landed hit: the larger of √(energy / HIT_FULL_J) and the
 * impulse share (counted only at striking speed, so shoves and leans stay quiet).
 */
export function hitStrength(energyJ: number, impulseNs: number, speed: number): number {
  const byEnergy = Math.sqrt(Math.max(0, energyJ) / HIT_FULL_J);
  const striking = clamp((speed - HIT_PUSH_SPEED) / (HIT_STRIKE_SPEED - HIT_PUSH_SPEED), 0, 1);
  const byImpulse = (Math.max(0, impulseNs) / HIT_FULL_NS) * striking;
  return clamp(Math.max(byEnergy, byImpulse), 0, 1);
}

/**
 * Presentation strength of an impact as a landed strike, or 0 when it isn't one: a self-contact,
 * feet treading on each other, or limbs tangling while the striker is down (a ground scramble).
 * Without this, 3 of 4 hit-stops in an iron-age fight (2026-09-29) were two robots rolling on the
 * canvas kicking each other's shins and feet, and 1 in 4-7 on the electric roster were one foot
 * stepping on the other. `tel`: the frame's telemetry when known (each corner's down flag).
 */
export function strikeStrength(e: Extract<SimEvent, { kind: 'impact' }>, tel?: readonly { down: boolean }[] | null): number {
  if (e.striker === null || e.victim === null || e.striker === e.victim) return 0;
  if (e.part !== null && e.part.startsWith('foot')) return 0;
  if (tel?.[e.striker]?.down) return 0;
  return hitStrength(e.energyJ, e.impulseNs, e.speed);
}

/** Canvas dust from a foot planting hard (footfalls only become events from 2.5 m/s). */
export function footDustPuffs(speed: number): number {
  if (speed < 2.5) return 0;
  return Math.round(clamp(2 + (speed - 2.5) * 2.2, 2, 8));
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
