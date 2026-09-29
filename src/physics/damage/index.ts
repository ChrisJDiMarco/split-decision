// Damage system (post-step). Order inside one physics step:
//   impacts    contacts → episodes → 'impact' / 'cage' events, part damage, joint wounds, breaks
//   overload   gear trains back-driven past 2× stall lose health, may seize
//   every SLOW_STRIDE steps:
//     hydraulics   punctures leak, fluid drains, pressure falls
//     heat/smoke   part heat from its joints, smoke from heat and wounds
//     ko           head / down / power / disabled
// Telemetry adds vent points (world position and velocity of each smoking or leaking part's smokePoint).
import type { PartTelemetry, RobotTelemetry } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';
import { SLOW_STRIDE } from './constants';
import { heatSmokeStep, hydraulicsStep } from './fluids';
import { impactStep } from './impacts';
import { koStep } from './ko';
import { buildDamageState, type DamageState, type PartInfo } from './state';
import { overloadStep } from './wear';

export { detachPart } from './detach';
export { damagePoints } from './wear';
export type { DamageState } from './state';

/** Parts venting less than this get no vent point in telemetry. */
const VENT_SMOKE_MIN = 0.005;

const states = new WeakMap<SimContext, DamageState>();

/** The damage model's state for a context (built on first use). */
export function damageState(ctx: SimContext): DamageState {
  let st = states.get(ctx);
  if (!st) {
    st = buildDamageState(ctx);
    states.set(ctx, st);
  }
  return st;
}

function vent(ctx: SimContext, st: DamageState, info: PartInfo, out: PartTelemetry): void {
  const body = info.part.attached ? info.part.body : info.part.debrisBody;
  if (body === null) return;
  const sp = info.def.smokePoint ?? [0, 0, 0];
  const xpos = ctx.data.xpos as Float64Array;
  const xmat = ctx.data.xmat as Float64Array;
  const m = body * 9;
  const r: Vec3 = [
    xmat[m] * sp[0] + xmat[m + 1] * sp[1] + xmat[m + 2] * sp[2],
    xmat[m + 3] * sp[0] + xmat[m + 4] * sp[1] + xmat[m + 5] * sp[2],
    xmat[m + 6] * sp[0] + xmat[m + 7] * sp[1] + xmat[m + 8] * sp[2],
  ];
  out.ventWorld = [xpos[body * 3] + r[0], xpos[body * 3 + 1] + r[1], xpos[body * 3 + 2] + r[2]];
  ctx.mj.mj_objectVelocity(ctx.model, ctx.data, ctx.mj.mjtObj.mjOBJ_XBODY.value, body, st.velBuf, 0);
  const v = st.velBuf.GetView();
  out.ventVel = [v[3] + v[1] * r[2] - v[2] * r[1], v[4] + v[2] * r[0] - v[0] * r[2], v[5] + v[0] * r[1] - v[1] * r[0]];
}

export const damageSystem: SimSystem = {
  name: 'damage',
  init(ctx) {
    states.set(ctx, buildDamageState(ctx));
  },
  post(ctx) {
    const st = damageState(ctx);
    impactStep(ctx, st);
    overloadStep(ctx, st);
    if (ctx.tick % SLOW_STRIDE === 0) {
      const dt = ctx.dt * SLOW_STRIDE;
      hydraulicsStep(st, dt);
      heatSmokeStep(st, dt);
      koStep(ctx, st, dt);
    }
  },
  telemetry(ctx: SimContext, robot: RobotRuntime, out: RobotTelemetry) {
    const st = damageState(ctx);
    const rd = st.robots[robot.corner];
    for (const p of out.parts) {
      if (p.smoke < VENT_SMOKE_MIN && p.leak <= 0) continue;
      const info = rd.parts.get(p.id);
      if (info) vent(ctx, st, info, p);
    }
  },
};
