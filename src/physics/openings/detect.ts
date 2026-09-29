// Openings: what one fighter can see on its opponent right now, from both bodies' physics state.
// Pure functions of two BodySnapshots (snapshot.ts) plus the time of the opponent's last hard hit.
import { APOTHEM, panels } from '../../core/arena-spec';
import type { Opening, SimEvent, Stance } from '../../core/protocol';
import { wrapAngle } from '../control/math';
import { CLEAN_HIT_MIN_SPEED } from '../damage/constants';
import type { BodySnapshot } from './snapshot';

// off_balance
export const OFF_BALANCE_MARGIN = 0.3; // balance margin below this is off balance on its own
export const WOBBLE_MARGIN = 0.55; // ... below this it is, if the COM is also moving fast or the gyro is full
export const FAST_COM_MPS = 1.0; // horizontal COM speed that counts as "moving fast"
export const OFF_BALANCE_UPRIGHT = 0.8; // torso tilted past ~37°
// turned_away
export const TURNED_AWAY_DEG = 60;
/** Below this torso up-axis z (tilted past 60°, or face-down in a get-up crouch) the torso's yaw means nothing. */
export const FACING_MIN_UPRIGHT = 0.5;
// stunned
export const STUN_WINDOW_S = 0.6;
/**
 * A strike rocks the robot it lands on at this closing energy (½·m_eff·v²), or at this impulse per
 * kg of the victim. Clean modern head shots measure about 8-29 N·s (docs: head break calibration),
 * so the impulse rule fires at roughly half a clean shot for each weight class.
 */
export const STUN_ENERGY_J = 20;
export const STUN_IMPULSE_PER_KG = 0.12;
/**
 * Only a clean shot to the head or torso rocks a robot: the damage model's clean-hit speed on a core
 * part. Shin clashes, blocked forearms, fist-on-fist and slow body bumps carry the same impulse
 * (headless fights: ~20 such contacts a minute) but rock nobody.
 */
export const STUN_PARTS: ReadonlySet<string> = new Set(['head', 'torso']);

type ImpactEvent = Extract<SimEvent, { kind: 'impact' }>;

export function isStunningHit(e: Pick<ImpactEvent, 'energyJ' | 'impulseNs' | 'speed' | 'part'>, victimMassKg: number): boolean {
  if (e.part === null || !STUN_PARTS.has(e.part) || e.speed < CLEAN_HIT_MIN_SPEED) return false;
  return e.energyJ >= STUN_ENERGY_J || e.impulseNs >= STUN_IMPULSE_PER_KG * victimMassKg;
}
// on_cage
export const ON_CAGE_M = 0.6;
// gyro_saturated
export const GYRO_SATURATED = 0.85;
export const GYRO_DEAD = 0.2;
// weak legs
export const WEAK_LEG_HEALTH = 0.5;
const LEG_JOINTS = ['knee', 'hip_pitch', 'hip_roll', 'hip_yaw'] as const;
// low_guard: both fists this far below the neck pivot
export const LOW_GUARD_TOL_M = 0.06;
// overcommitted: long strikes (anything but the jab) past their commit point, or a lunge
const LONG_STRIKES = new Set(['cross', 'hook', 'uppercut', 'overhand', 'rocket_punch', 'front_kick', 'low_kick', 'head_kick']);
export const LUNGE_MPS = 1.5;

const PANEL_NORMALS = panels().map((p) => [Math.cos(p.normalAngle), Math.sin(p.normalAngle)] as const);

/** Metres from (x, y) to the nearest fence panel of the regular polygon. */
export function fenceGap(x: number, y: number): number {
  let best = -Infinity;
  for (const [nx, ny] of PANEL_NORMALS) best = Math.max(best, x * nx + y * ny);
  return Math.max(0, APOTHEM - best);
}

/** Direction from `a` to `b` on the canvas, radians. */
function bearing(a: BodySnapshot, b: BodySnapshot): number {
  return Math.atan2(b.com[1] - a.com[1], b.com[0] - a.com[0]);
}

/** Signed angle (deg) of `me`'s shoulders off square to `opp`: 0 = squared up, CCW positive. */
export function facingOffDeg(me: BodySnapshot, opp: BodySnapshot): number {
  return (wrapAngle(me.torsoYaw - bearing(me, opp)) * 180) / Math.PI;
}

/** Orthodox when the left foot leads (is further toward the opponent), southpaw otherwise. */
export function stanceOf(me: BodySnapshot, opp: BodySnapshot): Stance {
  if (!me.feet) return 'orthodox';
  const b = bearing(me, opp);
  const ux = Math.cos(b), uy = Math.sin(b);
  const along = (p: readonly number[]) => p[0] * ux + p[1] * uy;
  return along(me.feet.l) >= along(me.feet.r) ? 'orthodox' : 'southpaw';
}

function weakLeg(opp: BodySnapshot, side: 'l' | 'r'): boolean {
  return opp.joints.some((j) => {
    if (!j.name.endsWith(`_${side}`) || !LEG_JOINTS.some((n) => j.name === `${n}_${side}`)) return false;
    return j.state !== 'ok' || j.health < WEAK_LEG_HEALTH;
  });
}

function offBalance(opp: BodySnapshot): boolean {
  if (opp.down) return false;
  const speed = Math.hypot(opp.comVel[0], opp.comVel[1]);
  const gyroFull = !!opp.gyro && opp.gyro.saturation >= GYRO_SATURATED;
  if (opp.upright < OFF_BALANCE_UPRIGHT) return true;
  // Mid-step the capture point leaves the stance foot by design, so a low margin alone is only a
  // stumble with both feet down (or in a kick); mid-step it also needs speed or a full gyro.
  if (opp.balance < OFF_BALANCE_MARGIN && !opp.stepping) return true;
  return opp.balance < WOBBLE_MARGIN && (speed > FAST_COM_MPS || gyroFull);
}

function overcommitted(me: BodySnapshot, opp: BodySnapshot): boolean {
  const k = opp.skill;
  if (k && k.phase === 'strike' && !k.landed && LONG_STRIKES.has(k.id)) return true;
  // A lunge: the whole body charging at us.
  const b = bearing(opp, me);
  return !opp.down && opp.comVel[0] * Math.cos(b) + opp.comVel[1] * Math.sin(b) > LUNGE_MPS;
}

/**
 * Every opening `me` sees on `opp` right now. `oppStunnedAt`: sim time `opp` last took a strike
 * from `me` above STUN_ENERGY_J (-Infinity if never).
 */
export function detectOpenings(me: BodySnapshot, opp: BodySnapshot, oppStunnedAt = -Infinity): Opening[] {
  const out: Opening[] = [];
  if (opp.ko) return out; // nothing to exploit: the fight is over
  if (offBalance(opp)) out.push('off_balance');
  if (!opp.down && opp.upright > FACING_MIN_UPRIGHT && Math.abs(facingOffDeg(opp, me)) > TURNED_AWAY_DEG) out.push('turned_away');
  const k = opp.skill;
  if (k && (k.kind === 'arm' || k.kind === 'leg') && k.phase === 'recover' && !k.landed) out.push('missed_recovering');
  if (opp.time - oppStunnedAt <= STUN_WINDOW_S) out.push('stunned');
  if (opp.rising) out.push('rising');
  if (fenceGap(opp.com[0], opp.com[1]) < ON_CAGE_M) out.push('on_cage');
  if (opp.gyro && (opp.gyro.saturation >= GYRO_SATURATED || opp.gyro.health < GYRO_DEAD)) out.push('gyro_saturated');
  if (weakLeg(opp, 'l')) out.push('weak_left_leg');
  if (weakLeg(opp, 'r')) out.push('weak_right_leg');
  if (!opp.down && opp.fistZ && opp.chinZ !== null && Math.max(opp.fistZ.l, opp.fistZ.r) < opp.chinZ - LOW_GUARD_TOL_M) out.push('low_guard');
  if (overcommitted(me, opp)) out.push('overcommitted');
  return out;
}
