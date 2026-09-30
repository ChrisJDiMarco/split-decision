// The measured centre of pressure: the normal-force-weighted mean of a robot's foot contacts with
// the canvas (MuJoCo's contact list and efc_force). Tools only: it copies the contact list.
import type { RobotRuntime, SimContext } from '../../src/physics/sim-context';

interface ContactView { geom1: number; geom2: number; pos: Float64Array | number[]; efc_address: number; delete(): void }

const footGeoms = new WeakMap<RobotRuntime, Set<number>>();

function feetOf(r: RobotRuntime): Set<number> {
  let s = footGeoms.get(r);
  if (!s) {
    s = new Set([...(r.parts.get('foot_l')?.geoms ?? []), ...(r.parts.get('foot_r')?.geoms ?? [])]);
    footGeoms.set(r, s);
  }
  return s;
}

/** [x, y, total normal force N], or null with no foot on the canvas. */
export function measuredCop(ctx: SimContext, r: RobotRuntime): [number, number, number] | null {
  const data = ctx.data;
  const n = data.ncon as number;
  if (!n) return null;
  const canvas = ctx.model.geom('canvas').id as number;
  const feet = feetOf(r);
  const contacts = data.contact;
  let fx = 0, fy = 0, fz = 0;
  try {
    const efc = data.efc_force as Float64Array;
    for (let i = 0; i < n; i++) {
      const c = contacts.get(i) as ContactView;
      try {
        const g1 = c.geom1, g2 = c.geom2;
        if (!((g1 === canvas && feet.has(g2)) || (g2 === canvas && feet.has(g1)))) continue;
        const f = efc[c.efc_address];
        if (!(f > 0)) continue;
        fx += c.pos[0] * f;
        fy += c.pos[1] * f;
        fz += f;
      } finally {
        c.delete();
      }
    }
  } finally {
    contacts.delete();
  }
  return fz > 0 ? [fx / fz, fy / fz, fz] : null;
}
