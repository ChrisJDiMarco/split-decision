// Numbers → words. Jev compares words far better than floats, so every quantity the
// fighter sees goes through one of these bands first.
import type { DistanceBand } from './types';

export const CLINCH_M = 0.6;
const STRIKE_MARGIN_M = 0.15;
const OUTSIDE_MARGIN_M = 0.8;
const MID_M = 3.2;

export function distanceBand(distance: number, reach: number): DistanceBand {
  if (distance < CLINCH_M) return 'clinch';
  if (distance < reach + STRIKE_MARGIN_M) return 'striking range';
  if (distance < reach + OUTSIDE_MARGIN_M) return 'just outside reach';
  if (distance < MID_M) return 'mid range';
  return 'far';
}

/** Clock-face hour of a relative bearing: 12 = straight ahead, 3 = right, 9 = left. */
export function clockHour(bearingRad: number): number {
  const h = Math.round(-bearingRad / (Math.PI / 6));
  const m = ((h % 12) + 12) % 12;
  return m === 0 ? 12 : m;
}

export function clockWords(bearingRad: number): string {
  return `${clockHour(bearingRad)} o'clock`;
}

export function closingBand(speed: number): string {
  if (speed < -1.5) return 'separating fast';
  if (speed < -0.4) return 'gap opening';
  if (speed < 0.4) return 'steady';
  if (speed < 1.5) return 'closing slowly';
  if (speed < 3) return 'closing fast';
  return 'charging';
}

export function cageWords(gap: number, bearingRad: number): string {
  const hour = clockHour(bearingRad);
  const behind = hour >= 5 && hour <= 7;
  if (gap < 0.45) return behind ? 'back against the cage' : `pressed against the cage at your ${hour} o'clock`;
  if (gap < 1.1) return `cage close, at your ${hour} o'clock`;
  if (gap < 2) return `cage a couple of steps away at your ${hour} o'clock`;
  return 'open space around you';
}

export function opponentCageWords(gap: number): string {
  if (gap < 0.6) return 'pinned near the cage';
  if (gap < 1.3) return 'near the cage';
  return 'open space behind him';
}

export function facingWords(oppBearingRad: number): string {
  const a = Math.abs(oppBearingRad) * (180 / Math.PI);
  if (a < 30) return 'facing you square';
  if (a < 75) return 'angled off you';
  if (a < 120) return 'side-on to you';
  return 'his back to you';
}

export function balanceWords(down: boolean, upright: number, balance: number): string {
  if (down) return 'down on the canvas';
  if (upright < 0.75) return 'bent over, badly off balance';
  if (balance >= 0.7) return 'stable';
  if (balance >= 0.4) return 'wobbling';
  if (balance >= 0.15) return 'off balance';
  return 'about to fall';
}

/** Coarse balance class for the stale-answer hash. */
export function balanceClass(down: boolean, upright: number, balance: number): 'down' | 'unsteady' | 'steady' {
  if (down) return 'down';
  if (upright < 0.75 || balance < 0.4) return 'unsteady';
  return 'steady';
}

export function batteryWords(battery: number): string {
  if (battery >= 0.7) return 'battery healthy';
  if (battery >= 0.4) return 'battery half drained';
  if (battery >= 0.2) return 'battery low, motors weakening';
  return 'battery critical';
}

export function gyroWords(health: number, saturation: number): string {
  const sat = saturation < 0.3 ? 'fresh' : saturation < 0.7 ? 'loading up' : saturation < 0.9 ? 'near saturation' : 'saturated, cannot catch a stumble';
  return health < 0.5 ? `gyro damaged, ${sat}` : `gyro ${sat}`;
}

export function pressureWords(circuit: string, pressure: number): string {
  const name = `${circuit.replace(/[^a-z0-9]+/gi, ' ').trim()} hydraulics`;
  if (pressure >= 0.9) return `${name} at full pressure`;
  if (pressure >= 0.6) return `${name} losing pressure`;
  if (pressure >= 0.3) return `${name} low on pressure, strikes weak`;
  return `${name} failed`;
}

export function damageTotalWords(total: number): string {
  if (total < 0.1) return 'fresh';
  if (total < 0.3) return 'lightly damaged';
  if (total < 0.55) return 'damaged';
  if (total < 0.8) return 'heavily damaged';
  return 'barely functional';
}

export function heatWords(tempC: number, maxTempC: number): string | null {
  if (tempC >= maxTempC - 20) return 'overheating, throttled';
  if (tempC >= maxTempC - 35) return 'hot, throttling soon';
  if (tempC >= maxTempC - 55) return 'warm';
  return null;
}

export function hpWords(hp: number): string | null {
  if (hp < 0.3) return 'failing';
  if (hp < 0.55) return 'cracked';
  if (hp < 0.8) return 'dented';
  return null;
}

/** Nearest 5 %, as words ("55%"). */
export function percentWords(frac: number): string {
  return `${Math.round(Math.max(0, Math.min(1, frac)) * 20) * 5}%`;
}

export function windupWords(windup: number): string {
  if (windup < 0.35) return 'just started';
  if (windup < 0.7) return 'about halfway';
  return 'about to release';
}

export function clockRemainingWords(remainingS: number): string {
  if (remainingS > 150) return 'round just started';
  if (remainingS > 90) return 'early in the round';
  if (remainingS > 30) return 'second half of the round';
  if (remainingS > 10) return 'final 30 seconds';
  return 'final seconds';
}

export function temperamentWords(t: number): string {
  if (t < 0.6) return 'disciplined and patient, takes only clean openings';
  if (t < 0.9) return 'measured, picks spots';
  if (t < 1.2) return 'balanced, trusts the read';
  if (t < 1.5) return 'aggressive, likes to trade';
  return 'wild brawler, throws caution away';
}

export function agoWords(seconds: number): string {
  if (seconds < 1) return 'just now';
  if (seconds < 3) return 'a moment ago';
  return 'a few seconds ago';
}

// ---------------------------------------------------------------- names

const SIDE_WORDS: Record<string, string> = {
  l: 'left', r: 'right', left: 'left', right: 'right',
  fl: 'front-left', fr: 'front-right', rl: 'rear-left', rr: 'rear-right',
  bl: 'rear-left', br: 'rear-right', hl: 'rear-left', hr: 'rear-right',
  front: 'front', rear: 'rear',
};
const AXIS_TOKENS = new Set(['pitch', 'roll', 'yaw']);
const NAME_WORDS: Record<string, string> = { upperarm: 'upper arm', forearm: 'forearm' };

function splitName(id: string): { side: string | null; base: string[] } {
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let side: string | null = null;
  const base: string[] = [];
  for (const t of tokens) {
    if (SIDE_WORDS[t] && side === null) side = SIDE_WORDS[t];
    else base.push(NAME_WORDS[t] ?? t);
  }
  return { side, base };
}

/** 'upperarm_l' → 'left upper arm'. */
export function partName(id: string): string {
  const { side, base } = splitName(id);
  return [side, ...base].filter(Boolean).join(' ');
}

/** 'shoulder_pitch_r' → 'right shoulder' (all DOFs of one physical joint share a name). */
export function jointGroupName(name: string): string {
  const { side, base } = splitName(name);
  return [side, ...base.filter((t) => !AXIS_TOKENS.has(t))].filter(Boolean).join(' ');
}

/** Code-authored identifiers only: strip anything that isn't a plain word. */
export function cleanIdentifier(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}
