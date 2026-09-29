// Detachment: swaps an attached part for its parked debris twin, mid-fight, without a model rebuild.
//   1. the attached geoms (and their bodies' broadphase masks) stop colliding
//   2. the attached bodies keep a token mass (body_subtreemass is kept consistent by hand)
//   3. the debris free joint takes the attached body's pose and velocity, plus a kick along the hit
//   4. debris collisions switch on (geom and body masks)
//   5. the parking weld lets go
//   6. the part (and anything rigid it carries) is marked detached, joints inside go limp
import type { Vec3 } from '../../core/types';
import { DEBRIS_CONAFFINITY, DEBRIS_CONTYPE } from '../../robots/compile-mjcf';
import type { SimContext } from '../sim-context';
import { DETACHED_BODY_MASS_KG, DETACH_KICK_SHARE, DETACH_MAX_KICK_MS } from './constants';
import type { DamageState, PartInfo } from './state';
import { makeLimp } from './wear';

function shrinkBody(ctx: SimContext, body: number): void {
  const { model } = ctx;
  const mass = model.body_mass as Float64Array;
  const inertia = model.body_inertia as Float64Array;
  const subtree = model.body_subtreemass as Float64Array;
  const parent = model.body_parentid as Int32Array;
  const before = mass[body];
  if (before <= DETACHED_BODY_MASS_KG) return;
  const ratio = DETACHED_BODY_MASS_KG / before;
  mass[body] = DETACHED_BODY_MASS_KG;
  for (let k = 0; k < 3; k++) inertia[body * 3 + k] *= ratio;
  const delta = before - DETACHED_BODY_MASS_KG;
  for (let b = body; ; b = parent[b]) {
    subtree[b] -= delta;
    if (b === 0) break;
  }
}

/** World-frame linear and angular velocity of a body's frame origin. */
function bodyVelocity(ctx: SimContext, st: DamageState, body: number): { lin: Vec3; ang: Vec3 } {
  ctx.mj.mj_objectVelocity(ctx.model, ctx.data, ctx.mj.mjtObj.mjOBJ_XBODY.value, body, st.velBuf, 0);
  const v = st.velBuf.GetView();
  return { ang: [v[0], v[1], v[2]], lin: [v[3], v[4], v[5]] };
}

function kickVelocity(impulse: Vec3, debrisMass: number): Vec3 {
  const mag = Math.hypot(impulse[0], impulse[1], impulse[2]);
  if (mag < 1e-9) return [0, 0, 0];
  const dv = Math.min(DETACH_MAX_KICK_MS, (DETACH_KICK_SHARE * mag) / Math.max(debrisMass, 0.1));
  return [(impulse[0] / mag) * dv, (impulse[1] / mag) * dv, (impulse[2] / mag) * dv];
}

function placeDebris(ctx: SimContext, from: number, debris: number, lin: Vec3, ang: Vec3): void {
  const { model, data } = ctx;
  const jnt = model.body_jntadr[debris];
  const qa = model.jnt_qposadr[jnt];
  const da = model.jnt_dofadr[jnt];
  const qpos = data.qpos as Float64Array;
  const qvel = data.qvel as Float64Array;
  const xpos = data.xpos as Float64Array;
  const xquat = data.xquat as Float64Array;
  const xmat = data.xmat as Float64Array;
  for (let k = 0; k < 3; k++) qpos[qa + k] = xpos[from * 3 + k];
  for (let k = 0; k < 4; k++) qpos[qa + 3 + k] = xquat[from * 4 + k];
  for (let k = 0; k < 3; k++) qvel[da + k] = lin[k];
  // Free-joint angular velocity is in the body frame: ω_local = Rᵀ ω_world (xmat is row-major).
  for (let i = 0; i < 3; i++) {
    qvel[da + 3 + i] = xmat[from * 9 + i] * ang[0] + xmat[from * 9 + 3 + i] * ang[1] + xmat[from * 9 + 6 + i] * ang[2];
  }
}

/**
 * Knocks a detachable part off its robot. `impulse` is the hit's impulse on the part (N·s, world frame);
 * pass [0, 0, 0] for a part that simply gives out. Returns false if the part cannot detach.
 */
export function detachPart(ctx: SimContext, st: DamageState, info: PartInfo, impulse: Vec3): boolean {
  const { part, robot } = info;
  if (!part.attached || part.debrisBody === null) return false;
  const debris = part.debrisBody;
  const { model } = ctx;
  const going = [info, ...info.carried];

  // MuJoCo's broadphase also filters on body_contype / body_conaffinity (the OR of a body's geoms,
  // fixed at compile time), so both levels have to change or the debris falls through the canvas.
  const contype = model.geom_contype as Int32Array;
  const conaff = model.geom_conaffinity as Int32Array;
  const bodyContype = model.body_contype as Int32Array;
  const bodyConaff = model.body_conaffinity as Int32Array;
  for (const p of going) {
    for (const g of p.part.geoms) { contype[g] = 0; conaff[g] = 0; }
    bodyContype[p.part.body] = 0;
    bodyConaff[p.part.body] = 0;
  }

  const { lin, ang } = bodyVelocity(ctx, st, part.body);
  const kick = kickVelocity(impulse, model.body_mass[debris]);
  const vel: Vec3 = [lin[0] + kick[0], lin[1] + kick[1], lin[2] + kick[2]];
  placeDebris(ctx, part.body, debris, vel, ang);
  // Poses (xpos) otherwise stay parked until the next mj_step, and a frame, the camera's debris shot or
  // a vent point can read them before that step runs.
  ctx.mj.mj_kinematics(model, ctx.data);
  for (const p of going) shrinkBody(ctx, p.part.body);

  for (const g of part.debrisGeoms) { contype[g] = DEBRIS_CONTYPE; conaff[g] = DEBRIS_CONAFFINITY; }
  bodyContype[debris] = DEBRIS_CONTYPE;
  bodyConaff[debris] = DEBRIS_CONAFFINITY;
  const weld = robot.compiled.parkingWelds[part.id];
  if (weld) ctx.setEqActive(ctx.eqIndex(weld), false);

  const rd = st.robots[robot.corner];
  for (const p of going) {
    p.part.attached = false;
    for (const i of p.jointIdx) makeLimp(ctx, rd.robot, i);
  }
  const xpos = ctx.data.xpos as Float64Array;
  ctx.events.push({
    kind: 'detach', corner: robot.corner, part: part.id, debrisBody: debris,
    pos: [xpos[part.body * 3], xpos[part.body * 3 + 1], xpos[part.body * 3 + 2]], vel,
  });
  return true;
}

/** Break check after a hit: a single impulse over the break spec, or accumulated damage over it. */
export function maybeDetach(ctx: SimContext, st: DamageState, info: PartInfo, impulseNs: number, impulse: Vec3): boolean {
  const spec = info.def.detachable;
  if (!spec || !info.part.attached) return false;
  if (impulseNs < spec.impulseNs && info.part.damage < spec.damage) return false;
  return detachPart(ctx, st, info, impulse);
}
