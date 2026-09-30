// What the controller perceives each update, read from MuJoCo's own kinematics:
// body poses, the whole-robot centre of mass and its velocity (subtree_com / subtree_linvel),
// foot contact geometry and the opponent's strike targets. Array views are fetched once per
// physics step and shared by both robots.
import type { Vec3 } from '../../core/types';
import type { MjData, RobotRuntime, SimContext } from '../sim-context';
import type { HumanoidGeometry, Side } from './geometry';
import { mulMV, readMat, readVec, yawOf, type Mat3 } from './math';

export const GRAVITY = 9.81;

export interface Views {
  xpos: Float64Array;
  xmat: Float64Array;
  subtreeCom: Float64Array;
  subtreeLinvel: Float64Array;
  cvel: Float64Array;
  qpos: Float64Array;
  qvel: Float64Array;
  qfrcBias: Float64Array;
  xanchor: Float64Array;
  xaxis: Float64Array;
  xfrc: Float64Array;
  geomXpos: Float64Array;
  bodyMass: Float64Array;
}

const viewCache = new WeakMap<SimContext, { tick: number; views: Views }>();

/**
 * Typed-array views into MjData for this step. They are refetched each step, and also whenever
 * the WASM heap has grown since (growth detaches every old view, which then reads as empty):
 * even copying the contact list can grow it.
 */
export function views(ctx: SimContext): Views {
  const hit = viewCache.get(ctx);
  if (hit && hit.tick === ctx.tick && hit.views.xpos.length > 0) return hit.views;
  const d: MjData = ctx.data;
  // subtree_linvel is not part of mj_step; one C call fills it for every body (~1 µs).
  ctx.mj.mj_subtreeVel(ctx.model, d);
  const v: Views = {
    xpos: d.xpos, xmat: d.xmat, subtreeCom: d.subtree_com, subtreeLinvel: d.subtree_linvel, cvel: d.cvel,
    qpos: d.qpos, qvel: d.qvel, qfrcBias: d.qfrc_bias, xanchor: d.xanchor, xaxis: d.xaxis,
    xfrc: d.xfrc_applied, geomXpos: d.geom_xpos, bodyMass: ctx.model.body_mass,
  };
  viewCache.set(ctx, { tick: ctx.tick, views: v });
  return v;
}

export interface BodyIds {
  pelvis: number;
  torso: number;
  head: number;
  foot: Record<Side, number>;
  shin: Record<Side, number>;
  thigh: Record<Side, number>;
  fist: Record<Side, number>;
  forearm: Record<Side, number>;
  all: number[]; // every attached body of the robot (for mass sums)
}

export function bodyIds(r: RobotRuntime): BodyIds {
  const b = (id: string) => {
    const p = r.parts.get(id);
    if (!p) throw new Error(`robot ${r.corner}: missing part '${id}'`);
    return p.body;
  };
  return {
    pelvis: b('pelvis'),
    torso: b('torso'),
    head: b('head'),
    foot: { l: b('foot_l'), r: b('foot_r') },
    shin: { l: b('shin_l'), r: b('shin_r') },
    thigh: { l: b('thigh_l'), r: b('thigh_r') },
    fist: { l: b('fist_l'), r: b('fist_r') },
    forearm: { l: b('forearm_l'), r: b('forearm_r') },
    all: [...r.parts.values()].map((p) => p.body),
  };
}

export interface FootSense {
  ankle: Vec3; // ankle joint centre, world
  rot: Mat3;
  shinRot: Mat3; // measured shin attitude (the ankle's parent frame)
  sole: Vec3; // sole centre, world
  yaw: number;
  height: number; // lowest sole corner above the canvas
  flat: number; // foot up-axis z: 1 flat
}

/** One leg as a whole (the thigh's subtree): what a swinging leg carries of the COM's motion. */
export interface LegSense {
  mass: number;
  com: Vec3;
  vel: Vec3;
}

export interface Sense {
  time: number;
  pelvisPos: Vec3;
  pelvisRot: Mat3;
  torsoPos: Vec3;
  torsoRot: Mat3;
  torsoOmega: Vec3;
  com: Vec3;
  comVel: Vec3;
  mass: number;
  omega0: number; // √(g / h) of the linear inverted pendulum
  capture: Vec3; // instantaneous capture point on the canvas (z = 0)
  heading: number; // pelvis yaw
  upright: number; // torso up-axis z
  feet: Record<Side, FootSense>;
  fists: Record<Side, Vec3>; // fist body origins, world
  waistPitch: number; // measured, rad
  legs: Record<Side, LegSense>;
}

function footSense(v: Views, body: number, shin: number, geo: HumanoidGeometry, side: Side): FootSense {
  const ankle = readVec(v.xpos, body);
  const rot = readMat(v.xmat, body);
  const shinRot = readMat(v.xmat, shin);
  const g = geo.legs[side];
  const sole = mulMV(rot, [g.footCenterX, 0, -g.soleDepth]);
  sole[0] += ankle[0];
  sole[1] += ankle[1];
  sole[2] += ankle[2];
  // Lowest of the four bottom corners: how far the foot is off the canvas.
  let low = Infinity;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const z = ankle[2] + rot[6] * (g.footCenterX + sx * g.footHalfLength) + rot[7] * (sy * g.footHalfWidth) + rot[8] * -g.soleDepth;
      if (z < low) low = z;
    }
  }
  return { ankle, rot, shinRot, sole, yaw: yawOf(rot), height: low, flat: rot[8] };
}

export function robotMass(v: Views, ids: BodyIds): number {
  let m = 0;
  for (const b of ids.all) m += v.bodyMass[b];
  return m;
}

export function sense(ctx: SimContext, r: RobotRuntime, geo: HumanoidGeometry, ids: BodyIds, mass: number): Sense {
  const v = views(ctx);
  const root = r.rootBody;
  const com = readVec(v.subtreeCom, root);
  const comVel = readVec(v.subtreeLinvel, root);
  const h = Math.max(0.3, com[2]);
  const omega0 = Math.sqrt(GRAVITY / h);
  const torsoRot = readMat(v.xmat, ids.torso);
  const pelvisRot = readMat(v.xmat, ids.pelvis);
  return {
    time: ctx.time,
    pelvisPos: readVec(v.xpos, ids.pelvis),
    pelvisRot,
    torsoPos: readVec(v.xpos, ids.torso),
    torsoRot,
    torsoOmega: [v.cvel[ids.torso * 6], v.cvel[ids.torso * 6 + 1], v.cvel[ids.torso * 6 + 2]],
    com,
    comVel,
    mass,
    omega0,
    capture: [com[0] + comVel[0] / omega0, com[1] + comVel[1] / omega0, 0],
    heading: yawOf(pelvisRot),
    upright: torsoRot[8],
    feet: { l: footSense(v, ids.foot.l, ids.shin.l, geo, 'l'), r: footSense(v, ids.foot.r, ids.shin.r, geo, 'r') },
    fists: { l: readVec(v.xpos, ids.fist.l), r: readVec(v.xpos, ids.fist.r) },
    waistPitch: waistPitchOf(r, v),
    legs: {
      l: { mass: ctx.model.body_subtreemass[ids.thigh.l], com: readVec(v.subtreeCom, ids.thigh.l), vel: readVec(v.subtreeLinvel, ids.thigh.l) },
      r: { mass: ctx.model.body_subtreemass[ids.thigh.r], com: readVec(v.subtreeCom, ids.thigh.r), vel: readVec(v.subtreeLinvel, ids.thigh.r) },
    },
  };
}

const waistIndex = new WeakMap<RobotRuntime, number>();

function waistPitchOf(r: RobotRuntime, v: Views): number {
  let i = waistIndex.get(r);
  if (i === undefined) {
    i = r.jointIndex.get('waist_pitch') ?? -1;
    waistIndex.set(r, i);
  }
  return i < 0 ? 0 : v.qpos[r.joints[i].qadr];
}
