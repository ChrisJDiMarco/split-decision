// Which strikes this fighter's body can still throw: a limp or seized joint in the striking limb,
// or its fist / foot torn off, rules the strike out. Sides mirror the control skills (jab and hook
// lead with the left hand, cross, uppercut and overhand with the right; every kick needs both legs,
// one to kick and one to stand on). Flashy moves are priced by moveRisk instead (a limp joint → 1).
import type { RobotTelemetry, Tactic } from '../core/protocol';
import { isFlashy } from './tactics';

/** A move whose risk is at least this is not offered: it cannot be attempted at all. */
export const IMPOSSIBLE_RISK = 0.97;

type Side = 'l' | 'r';

const ARM_SIDE: Partial<Record<Tactic, Side>> = {
  jab: 'l', hook: 'l', cross: 'r', uppercut: 'r', overhand: 'r', rocket_punch: 'r', hammer_smash: 'r',
};
const KICK_SIDE: Partial<Record<Tactic, Side>> = { front_kick: 'l', low_kick: 'r', head_kick: 'r' };
const ARM_JOINT = /^(shoulder|elbow)(_[a-z]+)?_([lr])$/;
const LEG_JOINT = /^(hip|knee|ankle)(_[a-z]+)?_([lr])$/;

function jointDead(me: RobotTelemetry, re: RegExp, side: Side | null): boolean {
  return me.joints.some((j) => {
    const m = re.exec(j.name);
    return !!m && (side === null || m[3] === side) && (j.state === 'limp' || j.state === 'seized');
  });
}

function partGone(me: RobotTelemetry, ids: readonly string[]): boolean {
  return me.parts.some((p) => !p.attached && ids.includes(p.id));
}

/** Can the body throw `t` right now as far as its limbs go? Moves without a mapped limb always can. */
export function limbReady(me: RobotTelemetry, t: Tactic): boolean {
  const arm = ARM_SIDE[t];
  if (arm) return !jointDead(me, ARM_JOINT, arm) && !partGone(me, [`fist_${arm}`, `forearm_${arm}`]);
  const leg = KICK_SIDE[t];
  if (leg) return !jointDead(me, LEG_JOINT, null) && !partGone(me, [`foot_${leg}`, `shin_${leg}`]);
  return true;
}

/** A move the body can attempt now: flashy ones below the impossible risk, others with working limbs. */
export function moveReady(me: RobotTelemetry, t: Tactic): boolean {
  if (isFlashy(t)) {
    const r = me.moveRisk?.[t];
    return !(Number.isFinite(r) && (r as number) >= IMPOSSIBLE_RISK);
  }
  return limbReady(me, t);
}

/** The combinations whose every strike the body can still throw (order kept). */
export function readyCombos(me: RobotTelemetry, combos: readonly Tactic[][]): Tactic[][] {
  return combos.filter((c) => c.every((t) => moveReady(me, t)));
}
