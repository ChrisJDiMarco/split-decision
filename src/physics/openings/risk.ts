// moveRisk: an honest 0..1 fall-or-failure risk for each flashy move, from the fighter's own body
// state right now. Jev reads it (as a band) and decides whether to gamble; the control build will
// attempt the move either way, and physics decides how it goes.
//
//   base       the move's inherent risk for a 60 kg robot with a fresh body
//   mass       aerial moves get riskier with mass (more momentum to launch, catch and land)
//   balance    a low balance margin going in (not for the kip-up: it starts on the canvas)
//   gyro       momentum budget left in the gyro core (none: no catch at all)
//   battery    a sagging pack weakens the take-off
//   joints     every joint the move needs: a limp or seized one makes it impossible (risk 1),
//              worn and hot ones add risk
import { FLASHY_MOVES, type FlashyMove } from '../../core/protocol';
import type { BodySnapshot } from './snapshot';

export const REF_MASS_KG = 60;
const MIN_RISK = 0.02;

type JointGroup = 'legs' | 'arms' | 'waist';

interface MoveProfile {
  base: number;
  aerial: number; // 0 grounded .. 1+ fully airborne: how strongly mass scales the risk
  balance: number; // sensitivity to the balance margin going in
  gyro: number; // sensitivity to the gyro budget
  needs: JointGroup[];
}

export const MOVE_PROFILES: Record<FlashyMove, MoveProfile> = {
  tornado_kick: { base: 0.45, aerial: 1, balance: 0.4, gyro: 0.3, needs: ['legs', 'waist'] },
  jump_kick: { base: 0.35, aerial: 1, balance: 0.35, gyro: 0.25, needs: ['legs'] },
  spinning_back_kick: { base: 0.28, aerial: 0.3, balance: 0.4, gyro: 0.3, needs: ['legs', 'waist'] },
  jumping_knee: { base: 0.26, aerial: 0.8, balance: 0.3, gyro: 0.2, needs: ['legs'] },
  superman_punch: { base: 0.2, aerial: 0.6, balance: 0.3, gyro: 0.2, needs: ['legs', 'arms'] },
  spinning_backfist: { base: 0.1, aerial: 0.1, balance: 0.3, gyro: 0.2, needs: ['waist', 'arms'] },
  kip_up: { base: 0.4, aerial: 1.2, balance: 0, gyro: 0.1, needs: ['legs', 'arms', 'waist'] },
};

const GROUP_PREFIX: Record<JointGroup, readonly string[]> = {
  legs: ['hip_', 'knee_', 'ankle_'],
  arms: ['shoulder_', 'elbow_'],
  waist: ['waist_'],
};
const JOINT_WEAR_RISK = 0.35; // added per unit of health lost on the worst needed joint
const HOT_FROM = 0.8; // winding temperature fraction where heat starts adding risk
const HOT_RISK = 0.6; // ... up to this much at the motor's max
const BATTERY_FROM = 0.5;
const BATTERY_RISK = 0.4;

function massFactor(massKg: number): number {
  return massKg / REF_MASS_KG;
}

/** 1 = a fresh gyro with its whole momentum budget, 0 = saturated, dead or absent. */
export function gyroBudget(b: BodySnapshot): number {
  if (!b.gyro) return 0;
  return Math.max(0, Math.min(1, b.gyro.health * (1 - b.gyro.saturation)));
}

/** Joint term for a move: Infinity if a needed joint is limp or seized. */
function jointRisk(b: BodySnapshot, needs: readonly JointGroup[]): number {
  let wear = 0;
  let heat = 0;
  for (const j of b.joints) {
    if (!needs.some((g) => GROUP_PREFIX[g].some((p) => j.name.startsWith(p)))) continue;
    if (j.state === 'limp' || j.state === 'seized') return Infinity;
    wear = Math.max(wear, 1 - j.health);
    heat = Math.max(heat, (j.heat - HOT_FROM) / (1 - HOT_FROM));
  }
  return JOINT_WEAR_RISK * wear + HOT_RISK * Math.max(0, Math.min(1, heat));
}

export function riskOf(move: FlashyMove, b: BodySnapshot): number {
  const p = MOVE_PROFILES[move];
  const joints = jointRisk(b, p.needs);
  if (!Number.isFinite(joints)) return 1;
  // Standing moves are impossible from the canvas; the kip-up is only for the canvas, but its risk
  // is still published standing so the brain knows its odds before it goes down.
  if (move !== 'kip_up' && b.down) return 1;
  const mass = p.base * (1 + p.aerial * (massFactor(b.massKg) - 1));
  const balance = p.balance * (1 - Math.max(0, Math.min(1, b.balance)));
  const gyro = p.gyro * (1 - gyroBudget(b));
  const battery = BATTERY_RISK * Math.max(0, BATTERY_FROM - b.battery);
  return Math.max(MIN_RISK, Math.min(1, mass + balance + gyro + battery + joints));
}

export function moveRisks(b: BodySnapshot): Record<FlashyMove, number> {
  const out = {} as Record<FlashyMove, number>;
  for (const m of FLASHY_MOVES) out[m] = riskOf(m, b);
  return out;
}
