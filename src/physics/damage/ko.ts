// Knockouts. Each robot gets at most one KO event; r.koReason records it.
//   head      its head came off
//   down      r.down for longer than KO_DOWN_S
//   power     battery empty
//   disabled  every limb is limp (half or more of its joints limp) or lost
import type { SimEvent } from '../../core/protocol';
import type { SimContext } from '../sim-context';
import { KO_BATTERY_EMPTY, KO_DOWN_S } from './constants';
import type { DamageState, Limb, RobotDamage } from './state';

type KoReason = Extract<SimEvent, { kind: 'ko' }>['reason'];

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
    rd.downS = ctx.released && r.down ? rd.downS + dt : 0;
    if (r.koReason) continue;
    const reason = koReason(rd);
    if (!reason) continue;
    r.koReason = reason;
    ctx.events.push({ kind: 'ko', corner: r.corner, reason });
  }
}
