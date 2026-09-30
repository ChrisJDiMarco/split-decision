// Knockouts. Each robot gets at most one KO event; r.koReason records it.
//   head      its head came off
//   down      down for longer than KO_DOWN_S: the count runs on the canvas, in the get-up and while
//             rising out of the crouch, pauses once he is off the canvas, and resets only after a real
//             get-up (up and steady for KO_UP_STEADY_S, the referee's own test; or simply up and
//             upright for KO_UP_ANY_S). A failed rise that falls back never resets it.
//   power     battery empty
//   disabled  every limb is limp (half or more of its joints limp) or lost
import type { SimEvent } from '../../core/protocol';
import type { RobotRuntime, SimContext } from '../sim-context';
import { isDown, upAndSteady, upright } from '../systems/referee';
import { KO_BATTERY_EMPTY, KO_DOWN_S } from './constants';
import type { DamageState, Limb, RobotDamage } from './state';

type KoReason = Extract<SimEvent, { kind: 'ko' }>['reason'];

/** Up and steady this long after a knockdown: a real get-up, the down count resets. */
export const KO_UP_STEADY_S = 1.0;
/** ...or up and upright (off the canvas, done rising) this long, steady or not. */
export const KO_UP_ANY_S = 3.0;
const KO_UPRIGHT_MIN = 0.7; // the referee's standing test (torso up-axis z)

/** Per robot: seconds up and steady / up and upright since the last knockdown (the count paused). */
const upClock = new WeakMap<RobotDamage, { steady: number; up: number }>();

/**
 * Advances the down count one slow step: runs while down or getting up, holds while he is up but not
 * yet steady, and resets after a real get-up.
 */
function countDown(ctx: SimContext, rd: RobotDamage, dt: number): void {
  const r: RobotRuntime = rd.robot;
  let clock = upClock.get(rd);
  if (!clock) upClock.set(rd, (clock = { steady: 0, up: 0 }));
  if (!ctx.released) {
    rd.downS = 0;
    clock.steady = clock.up = 0;
    return;
  }
  if (isDown(r)) {
    rd.downS += dt;
    clock.steady = clock.up = 0;
    return;
  }
  if (rd.downS === 0) return;
  const standing = upright(ctx, r) >= KO_UPRIGHT_MIN;
  clock.up = standing ? clock.up + dt : 0;
  clock.steady = standing && upAndSteady(ctx, r) ? clock.steady + dt : 0;
  if (clock.steady >= KO_UP_STEADY_S || clock.up >= KO_UP_ANY_S) {
    rd.downS = 0;
    clock.steady = clock.up = 0;
  }
}

function limbIsLimp(rd: RobotDamage, limb: Limb): boolean {
  if (limb.parts.some((p) => !p.part.attached)) return true;
  if (!limb.jointIdx.length) return false;
  const limp = limb.jointIdx.filter((i) => rd.robot.joints[i].state === 'limp').length;
  return limp * 2 >= limb.jointIdx.length;
}

function koReason(rd: RobotDamage): KoReason | null {
  const r = rd.robot;
  for (const info of rd.parts.values()) {
    if (info.def.tags.includes('head') && !info.part.attached) return 'head';
  }
  if (rd.downS > KO_DOWN_S) return 'down';
  if (r.battery <= KO_BATTERY_EMPTY) return 'power';
  if (rd.limbs.length && rd.limbs.every((l) => limbIsLimp(rd, l))) return 'disabled';
  return null;
}

export function koStep(ctx: SimContext, st: DamageState, dt: number): void {
  for (const rd of st.robots) {
    const r = rd.robot;
    countDown(ctx, rd, dt);
    if (r.koReason) continue;
    const reason = koReason(rd);
    if (!reason) continue;
    r.koReason = reason;
    ctx.events.push({ kind: 'ko', corner: r.corner, reason });
  }
}
