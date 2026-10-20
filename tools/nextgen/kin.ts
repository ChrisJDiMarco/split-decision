// Whole-body kinematics on a spare MjData (no stepping): poses relative to a planted support foot.
// Given joint angles, the robot's world pose is the one that puts the support foot's sole flat at the
// origin, so the COM, torso lean and kicking-foot height in the support foot's frame are functions of
// the joint angles alone. Used to plan one-leg holds and to build the balance Jacobian.
import type { RobotRuntime } from '../../src/physics/sim-context';
import { apply, mul, tr, xmatAt, v3At, sub, type M3, type V3 } from './math3';
import type { VSim } from './sim';

export interface FootFrameEval {
  com: V3; // whole-robot COM in the support sole frame (origin at the sole centre, z up the foot)
  torsoUp: V3; // torso z axis in the sole frame
  pelvisR: M3; // pelvis orientation in the sole frame
  kickAnkle: V3; // the other foot's body origin (ankle) in the sole frame
  kickFootR: M3; // the other foot's orientation in the sole frame
  thighRel: M3; // kicking thigh relative to the pelvis
}

export class Kin {
  private readonly data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly base: Record<string, number>;
  private readonly r: RobotRuntime;
  constructor(private readonly sim: VSim, readonly support: 'l' | 'r') {
    this.data = new sim.mj.MjData(sim.ctx.model);
    this.r = sim.r;
    this.base = { ...sim.r.design.stance };
  }
  dispose() { this.data.delete(); }

  eval(q: Record<string, number>): FootFrameEval {
    const { model } = this.sim.ctx;
    const d = this.data;
    const r = this.r;
    // Robot 1 (parked) stays at whatever qpos0 holds; only robot 0 matters here.
    const a = r.rootQadr;
    d.qpos[a] = 0; d.qpos[a + 1] = 0; d.qpos[a + 2] = 1;
    d.qpos[a + 3] = 1; d.qpos[a + 4] = 0; d.qpos[a + 5] = 0; d.qpos[a + 6] = 0;
    for (const j of r.joints) d.qpos[j.qadr] = q[j.name] ?? this.base[j.name] ?? 0;
    this.sim.mj.mj_kinematics(model, d);
    this.sim.mj.mj_comPos(model, d);
    const s = this.support, k = s === 'l' ? 'r' : 'l';
    const footPart = r.parts.get(`foot_${s}`)!;
    const F = xmatAt(d.xmat, footPart.body);
    const g = footPart.geoms[0];
    const half = model.geom_size[g * 3 + 2];
    const gc = v3At(d.geom_xpos, g);
    const sole: V3 = [gc[0] - half * F[2], gc[1] - half * F[5], gc[2] - half * F[8]];
    const Ft = tr(F);
    const toFoot = (p: V3) => apply(Ft, sub(p, sole));
    const com = toFoot(v3At(d.subtree_com, r.rootBody));
    const T = xmatAt(d.xmat, r.parts.get('torso')!.body);
    const P = xmatAt(d.xmat, r.parts.get('pelvis')!.body);
    const Th = xmatAt(d.xmat, r.parts.get(`thigh_${k}`)!.body);
    return {
      com,
      torsoUp: apply(Ft, [T[2], T[5], T[8]]),
      pelvisR: mul(Ft, P),
      kickAnkle: toFoot(v3At(d.xpos, r.parts.get(`foot_${k}`)!.body)),
      kickFootR: mul(Ft, xmatAt(d.xmat, r.parts.get(`foot_${k}`)!.body)),
      thighRel: mul(tr(P), Th),
    };
  }
}

/** Support-foot sole frame of the LIVE sim: sole centre, foot rotation. */
export function liveSole(sim: VSim, support: 'l' | 'r'): { sole: V3; F: M3 } {
  const { model, data } = sim.ctx;
  const footPart = sim.r.parts.get(`foot_${support}`)!;
  const F = xmatAt(data.xmat, footPart.body);
  const g = footPart.geoms[0];
  const half = model.geom_size[g * 3 + 2];
  const gc = v3At(data.geom_xpos, g);
  return { sole: [gc[0] - half * F[2], gc[1] - half * F[5], gc[2] - half * F[8]], F };
}

/** The support foot box half extents (x, y) in its own frame, and the box centre offset from the sole centre (0). */
export function footHalf(sim: VSim, support: 'l' | 'r'): [number, number] {
  const g = sim.r.parts.get(`foot_${support}`)!.geoms[0];
  return [sim.ctx.model.geom_size[g * 3], sim.ctx.model.geom_size[g * 3 + 1]];
}
