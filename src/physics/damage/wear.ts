// Part and joint wear: damage points from hits, joint health from hits and gear overload,
// backlash (slop) and joint state transitions.
import type { JointState } from '../../core/protocol';
import type { RobotRuntime, SimContext } from '../sim-context';
import { jointStateFor } from '../systems/motors';
import {
  ENERGY_POINTS_PER_J, HARDNESS_EXPONENT, HARDNESS_MAX, HARDNESS_MIN, IMPULSE_POINTS_PER_NS, JOINT_IMPACT_SHARE,
  MAX_SLOP_RAD, OVERLOAD_FACTOR, OVERLOAD_TOLERANCE_S, PUNCTURE_MIN_POINTS, REF_BRINELL, REF_YIELD_MPA,
  RESISTANCE_MAX, RESISTANCE_MIN, SEIZE_CHANCE, SEIZE_TORQUE_FACTOR, GYRO_HP_POINTS } from './constants';
import type { DamageState, JointWear, PartInfo, RobotDamage, Surface } from './state';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Damage points one side takes from a hit: impulse and energy, harder strikers hurt more, tougher armor resists. */
export function damagePoints(impulseNs: number, energyJ: number, striker: Surface, victim: Surface): number {
  const base = IMPULSE_POINTS_PER_NS * impulseNs + ENERGY_POINTS_PER_J * energyJ;
  if (victim.cushion) return base * HARDNESS_MIN; // see CUSHION_MATERIALS
  const hardness = clamp((striker.brinell / Math.max(1, victim.brinell)) ** HARDNESS_EXPONENT, HARDNESS_MIN, HARDNESS_MAX);
  const resistance = clamp(((victim.yieldMPa / REF_YIELD_MPA) * (victim.brinell / REF_BRINELL)) ** 0.25, RESISTANCE_MIN, RESISTANCE_MAX);
  return (base * hardness) / resistance;
}

function emitJoint(ctx: SimContext, robot: RobotRuntime, index: number, state: JointState): void {
  const j = robot.joints[index];
  ctx.events.push({ kind: 'joint', corner: robot.corner, joint: j.name, health: j.health, state });
}

/** Lowers a joint's health; slop grows as health falls; emits a 'joint' event when the state changes. */
export function degradeJoint(ctx: SimContext, robot: RobotRuntime, index: number, loss: number): void {
  const j = robot.joints[index];
  if (loss <= 0 || j.state === 'limp') return;
  j.health = Math.max(0, j.health - loss);
  j.slop = MAX_SLOP_RAD * (1 - j.health);
  const byHealth = jointStateFor(j.health);
  // A seized gearbox stays seized until it is smashed loose (limp).
  const next: JointState = j.state === 'seized' && byHealth !== 'limp' ? 'seized' : byHealth;
  if (next !== j.state) {
    j.state = next;
    emitJoint(ctx, robot, index, next);
  }
}

/** The joint loses its drive entirely (a lost part, a shattered gearbox). */
export function makeLimp(ctx: SimContext, robot: RobotRuntime, index: number): void {
  const j = robot.joints[index];
  j.health = 0;
  j.slop = MAX_SLOP_RAD;
  if (j.state === 'limp') return;
  j.state = 'limp';
  emitJoint(ctx, robot, index, 'limp');
}

function seize(ctx: SimContext, robot: RobotRuntime, index: number): void {
  const j = robot.joints[index];
  if (j.state === 'limp' || j.state === 'seized') return;
  j.state = 'seized';
  emitJoint(ctx, robot, index, 'seized');
}

/** Applies damage points to an attached part: hp, the part's joints, and hydraulic punctures. */
export function applyPartDamage(ctx: SimContext, rd: RobotDamage, info: PartInfo, points: number): void {
  const { part, def } = info;
  if (!part.attached || points <= 0) return;
  part.damage += points;
  part.hp = Math.max(0, 1 - part.damage / def.hp);
  const jointPoints = points * JOINT_IMPACT_SHARE * info.woundShare;
  for (const i of info.woundJointIdx) degradeJoint(ctx, rd.robot, i, jointPoints / rd.wear[i].hp);
  if (info.circuits.length && points >= PUNCTURE_MIN_POINTS) info.punctured = true;
  // Hits on the part housing the gyro core wear the core itself: a battered fighter loses its balance aid.
  const gyro = rd.robot.gyro;
  if (gyro && def.tags.includes('gyro')) gyro.health = Math.max(0, gyro.health - points / GYRO_HP_POINTS);
}

/** Arms overload tracking on every joint between a struck part and the robot's root. */
export function armLoadPath(info: PartInfo, untilTick: number): void {
  for (const p of info.loadPath) if (p.armedUntil < untilTick) p.armedUntil = untilTick;
}

function closeOverload(ctx: SimContext, robot: RobotRuntime, index: number, w: JointWear): void {
  if (w.overloadPeakNm > SEIZE_TORQUE_FACTOR * robot.joints[index].motor.stallTorqueNm && ctx.rng() < SEIZE_CHANCE) {
    seize(ctx, robot, index);
  }
  w.inOverload = false;
  w.overloadPeakNm = 0;
}

/**
 * Gear overload. qfrc_constraint at a joint's dof is the generalized force that contacts, limits and
 * welds on everything outboard of the joint put through it. Past OVERLOAD_FACTOR × stall the gear train
 * is being back-driven: health drains with the excess angular impulse, and a violent spike can seize it.
 * Only joints on an impact's load path are tracked (armLoadPath), so footfalls and the robot's own
 * weight never count as gear damage.
 */
export function overloadStep(ctx: SimContext, st: DamageState): void {
  let qfrc: Float64Array | null = null;
  for (const rd of st.robots) {
    const { robot } = rd;
    for (const info of rd.parts.values()) {
      const armed = info.armedUntil >= ctx.tick;
      for (const i of info.jointIdx) {
        const w = rd.wear[i];
        const j = robot.joints[i];
        if (!armed || j.state === 'limp') {
          if (w.inOverload) closeOverload(ctx, robot, i, w);
          continue;
        }
        qfrc ??= ctx.data.qfrc_constraint as Float64Array;
        const stall = j.motor.stallTorqueNm;
        const tau = Math.abs(qfrc[j.dadr]);
        const limit = OVERLOAD_FACTOR * stall;
        if (tau > limit) {
          w.inOverload = true;
          if (tau > w.overloadPeakNm) w.overloadPeakNm = tau;
          degradeJoint(ctx, robot, i, ((tau - limit) * ctx.dt) / (stall * OVERLOAD_TOLERANCE_S));
        } else if (w.inOverload) {
          closeOverload(ctx, robot, i, w);
        }
      }
    }
  }
}
