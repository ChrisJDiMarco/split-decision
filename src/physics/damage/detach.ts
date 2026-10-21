// Detachment. A part (a head) comes off only from one really nice hard solid clean blow: a striking
// surface of the other robot (or a thrown prop), not blocked by the guard, whose impact impulse reaches
// the part's mount rating (maybeDetach; impacts.ts decides what counts as that blow). Falls, the
// floor, the cage, pushes and accumulated shell damage never pop it.
// detachPart swaps an attached part for its parked debris twin, mid-fight, without a model rebuild:
//   1. the attached geoms (and their bodies' broadphase masks) stop colliding
//   2. the attached bodies keep a token mass (body_subtreemass is kept consistent by hand)
//   3. the debris free joint takes the attached body's pose and velocity, plus a kick along the hit
//   4. debris collisions switch on (geom and body masks)
//   5. the parking weld lets go
//   6. the part (and anything rigid it carries) is marked detached, joints inside go limp
import type { Corner, Vec3 } from '../../core/types';
import { DEBRIS_CONAFFINITY, DEBRIS_CONTYPE } from '../../robots/compile-mjcf';
import type { SimContext } from '../sim-context';
import { DAMAGE_TUNING, DETACHED_BODY_MASS_KG, DETACH_KICK_SHARE, DETACH_MAX_KICK_MS } from './constants';
import type { DamageState, DetachRecord, PartInfo } from './state';
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
    for (const i of p.jointIdx) makeLimp(ctx, rd.robot, i, st, { cause: 'detach', failure: 'detach', severity: 1, role: 'victim' });
  }
  const xpos = ctx.data.xpos as Float64Array;
  ctx.events.push({
    kind: 'detach', corner: robot.corner, part: part.id, debrisBody: debris,
    pos: [xpos[part.body * 3], xpos[part.body * 3 + 1], xpos[part.body * 3 + 2]], vel,
  });
  return true;
}

/**
 * What is left of a part's mount: 1 intact, down to 1 − mountWear once the joint that holds it (the
 * neck under the head) has lost its full health to the bearing channel. That channel reads the side
 * loads the mount itself carries (the wrench through the neck), so its wear and bends are the mount's;
 * the drive's gear teeth and encoder are not the mount and do not count.
 */
export function mountFactor(st: DamageState, info: PartInfo): number {
  const mech = st.robots[info.robot.corner].mech;
  let loss = 0;
  for (const i of info.jointIdx) loss += mech[i].bearingLoss;
  return 1 - DAMAGE_TUNING.mountWear * Math.min(1, loss);
}

/** The impact impulse one clean blow needs to knock a part off now (Infinity if it can't come off). */
export function breakImpulseNs(st: DamageState, info: PartInfo): number {
  const spec = info.def.detachable;
  if (!spec || !info.part.attached) return Infinity;
  return spec.impulseNs * DAMAGE_TUNING.mountScale * mountFactor(st, info);
}

/** The blow that may knock a part off: from impacts.ts, only for a clean strike or a thrown prop. */
export interface PopBlow {
  cause: DetachRecord['cause'];
  byCorner: Corner | null;
  by: string | null;
  impactNs: number;
  windowNs: number;
  speed: number;
}

/**
 * Break check after a blow. Only one clean blow can pop a part: its impact impulse against the mount
 * (breakImpulseNs). Accumulated shell damage never pops one (the cover is not the mount, and it would
 * let a fall or the cage finish a battered head); it shows as dents, cracks and lost hp instead.
 */
export function maybeDetach(ctx: SimContext, st: DamageState, info: PartInfo, blow: PopBlow | null, impulse: Vec3): boolean {
  if (!blow || !(blow.impactNs > 0)) return false;
  const need = breakImpulseNs(st, info);
  if (blow.impactNs < need) return false;
  const mount = mountFactor(st, info);
  if (!detachPart(ctx, st, info, impulse)) return false;
  const ledger = st.robots[info.robot.corner].ledger;
  ledger.detaches.push({
    t: +ctx.time.toFixed(3), part: info.def.id, cause: blow.cause, byCorner: blow.byCorner, by: blow.by,
    impactNs: +blow.impactNs.toFixed(2), windowNs: +blow.windowNs.toFixed(2), speed: +blow.speed.toFixed(2),
    thresholdNs: +need.toFixed(2), mount: +mount.toFixed(3),
  });
  return true;
}
