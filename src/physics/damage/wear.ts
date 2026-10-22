// Part and joint wear: part damage points (from shell work), joint health and state transitions,
// backlash (slop), and the joint events that carry where and why (docs/design/strike-power.md §4.3,
// §4.7). Joint damage comes only from the joint-load channels (joint-loads.ts), housing hits and lost
// parts: a hit on a part no longer spreads its damage into the part's joints.
import type { JointCause, JointFailure, JointRole, JointState, SimEvent } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import type { RobotRuntime, SimContext } from '../sim-context';
import { jointStateFor } from '../systems/motors';
import { MAX_SLOP_RAD } from './constants';
import { LEDGER_LOG, type ArmContext, type DamageState, type PartInfo, type RobotDamage } from './state';

export interface Injury {
  cause: JointCause;
  failure: JointFailure;
  severity: number;
  role: JointRole;
  arm?: ArmContext | null;
  bendAxis?: Vec3;
}

/** World position of a joint's anchor. */
export function anchorOf(ctx: SimContext, mjJoint: number): Vec3 {
  const xa = ctx.data.xanchor as Float64Array;
  return [xa[mjJoint * 3], xa[mjJoint * 3 + 1], xa[mjJoint * 3 + 2]];
}

function rdOf(st: DamageState | null, robot: RobotRuntime): RobotDamage | null {
  return st ? st.robots[robot.corner] : null;
}

function emitJoint(ctx: SimContext, robot: RobotRuntime, index: number, state: JointState, rd: RobotDamage | null, injury?: Injury): void {
  const j = robot.joints[index];
  const e: Extract<SimEvent, { kind: 'joint' }> = { kind: 'joint', corner: robot.corner, joint: j.name, health: j.health, state };
  if (injury) {
    e.cause = injury.cause;
    e.failure = injury.failure;
    e.severity = injury.severity;
    e.role = injury.role;
    if (injury.bendAxis) e.bendAxis = injury.bendAxis;
    if (injury.arm) e.by = { corner: injury.arm.byCorner, part: injury.arm.byPart, skill: injury.arm.skill };
    if (rd) e.pos = anchorOf(ctx, rd.mech[index].mjJoint);
  }
  ctx.events.push(e);
}

/** Backlash: wear plus encoder wander from housing hits, capped. */
function updateSlop(rd: RobotDamage | null, robot: RobotRuntime, index: number): void {
  const j = robot.joints[index];
  const extra = rd ? rd.mech[index].encoderSlop : 0;
  j.slop = Math.min(MAX_SLOP_RAD, MAX_SLOP_RAD * (1 - j.health) + extra);
}

/** Books an injury in the robot's ledger: loss by cause and role, the failure count, the log. */
function book(ctx: SimContext, rd: RobotDamage | null, robot: RobotRuntime, index: number, loss: number, injury: Injury): void {
  if (!rd) return;
  rd.ledger.jointLoss[injury.cause][injury.role] += loss;
  if (injury.cause === 'bearing') rd.mech[index].bearingLoss += loss;
  rd.ledger.failures[injury.failure]++;
  const a = injury.arm;
  rd.ledger.log.push({
    t: +ctx.time.toFixed(3), joint: robot.joints[index].name, cause: injury.cause, failure: injury.failure,
    severity: +injury.severity.toFixed(2), role: injury.role, loss: +loss.toFixed(4),
    by: a?.byPart ? `${a.byPart}${a.skill ? ` (${a.skill})` : ''}` : null,
  });
  if (rd.ledger.log.length > LEDGER_LOG) rd.ledger.log.shift();
}

function noteInjured(rd: RobotDamage | null, robot: RobotRuntime, index: number): void {
  if (!rd) return;
  const j = robot.joints[index];
  if (j.state !== 'ok' && !rd.ledger.injured.includes(j.name)) rd.ledger.injured.push(j.name);
}

/**
 * Lowers a joint's health by `loss` for `injury` (a cause and what failed), books it in the ledger,
 * updates slop and state, and emits ONE joint event when the state changed or a failure happened
 * (plain wear that leaves the state alone stays quiet).
 */
export function injureJoint(ctx: SimContext, st: DamageState | null, robot: RobotRuntime, index: number, loss: number, injury: Injury): void {
  const j = robot.joints[index];
  const rd = rdOf(st, robot);
  if (j.state === 'limp' && injury.failure !== 'detach') return;
  const before = j.health;
  j.health = Math.max(0, j.health - Math.max(0, loss));
  book(ctx, rd, robot, index, before - j.health, injury);
  updateSlop(rd, robot, index);
  const byHealth = jointStateFor(j.health);
  // A seized gearbox stays seized until it is smashed loose (limp).
  const next: JointState = j.state === 'seized' && byHealth !== 'limp' ? 'seized' : byHealth;
  const changed = next !== j.state;
  j.state = next;
  noteInjured(rd, robot, index);
  if (changed || injury.failure !== 'wear') emitJoint(ctx, robot, index, next, rd, injury);
}

/** A planetary that jams: it locks where it is (motors.ts holds it at seizedAt) until smashed loose. */
export function seizeJoint(ctx: SimContext, st: DamageState | null, robot: RobotRuntime, index: number, loss: number, injury: Injury): void {
  const j = robot.joints[index];
  if (j.state === 'limp' || j.state === 'seized') {
    injureJoint(ctx, st, robot, index, loss, { ...injury, failure: 'wear' });
    return;
  }
  const rd = rdOf(st, robot);
  const before = j.health;
  j.health = Math.max(0.06, j.health - loss);
  book(ctx, rd, robot, index, before - j.health, { ...injury, failure: 'seize' });
  updateSlop(rd, robot, index);
  j.state = 'seized';
  noteInjured(rd, robot, index);
  emitJoint(ctx, robot, index, 'seized', rd, injury);
}

/**
 * The joint loses its drive entirely (a lost part, a stripped gear, a blown seal). `injury` says why;
 * without one it is a part coming off (cause 'detach').
 */
export function makeLimp(ctx: SimContext, robot: RobotRuntime, index: number, st: DamageState | null = null, injury?: Injury): void {
  const j = robot.joints[index];
  const rd = rdOf(st, robot);
  const why: Injury = injury ?? { cause: 'detach', failure: 'detach', severity: 1, role: 'none' };
  if (j.state !== 'limp') book(ctx, rd, robot, index, j.health, why);
  j.health = 0;
  j.slop = MAX_SLOP_RAD;
  if (j.state === 'limp') return;
  j.state = 'limp';
  noteInjured(rd, robot, index);
  emitJoint(ctx, robot, index, 'limp', rd, why);
}

/** Applies damage points to an attached part: hp, hydraulic punctures (by work) and the gyro core. */
export function applyPartDamage(rd: RobotDamage, info: PartInfo, points: number, strike = true): void {
  const { part, def } = info;
  if (!part.attached || !(points > 0)) return;
  part.damage += points;
  part.hp = Math.max(0, 1 - part.damage / def.hp);
  rd.ledger.partPoints += points;
  // Hits on the part housing the gyro core wear the core itself: a fighter whose torso is wrecked
  // loses its balance aid (the core's capacity is the torso shell's, durability.ts gyroCapacity).
  const gyro = rd.robot.gyro;
  if (gyro && def.tags.includes('gyro')) {
    const before = gyro.health;
    gyro.health = Math.max(0, gyro.health - points / rd.profile.gyroHpPoints);
    const L = rd.ledger.gyro;
    if (strike) L.strikePoints += points;
    else L.worldPoints += points;
    L.healthLost += before - gyro.health;
  }
}

/**
 * Arms the joint-load channels on every joint between a loaded part and the robot's root, until
 * `untilTick`. A victim arming wins over a striker one inside the same window.
 */
export function armLoadPath(info: PartInfo, untilTick: number, arm: ArmContext | null = null): void {
  for (const p of info.loadPath) {
    if (p.armedUntil < untilTick) p.armedUntil = untilTick;
    if (arm && (!p.arm || p.arm.role !== 'victim' || arm.role === 'victim')) p.arm = arm;
  }
}
