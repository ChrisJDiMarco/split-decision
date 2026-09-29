// What a fighter reads off its opponent: where the strike targets are right now (world frame),
// how fast the opponent is moving, and how telegraphed its current strike is.
import type { TargetZone } from '../../../core/protocol';
import type { Vec3 } from '../../../core/types';
import type { RobotRuntime, SimContext } from '../../sim-context';
import { humanoidGeometry, isHumanoid, type HumanoidGeometry, type Side } from '../geometry';
import { mulMV, readMat, readVec, yawOf, type Mat3 } from '../math';
import { views } from '../sense';

export interface OpponentView {
  robot: RobotRuntime;
  com: Vec3;
  vel: Vec3;
  pelvis: Vec3;
  heading: number;
  head: Vec3 | null; // null once the head has come off
  chest: Vec3;
  upperArm: Record<Side, Vec3>;
  thigh: Record<Side, Vec3>; // mid-thigh (low-kick target)
  knee: Record<Side, Vec3>;
  frontDepth: number; // body half-depth toward the attacker, for aiming at the surface
  windup: number;
  skill: string;
  down: boolean;
}

interface OpponentBodies {
  geo: HumanoidGeometry | null;
  torso: number;
  head: number;
  headPart: string | null;
  upper: Record<Side, number>;
  thigh: Record<Side, number>;
  shin: Record<Side, number>;
}

const cache = new WeakMap<RobotRuntime, OpponentBodies>();

function bodiesOf(r: RobotRuntime): OpponentBodies {
  let b = cache.get(r);
  if (b) return b;
  const body = (id: string) => r.parts.get(id)?.body ?? r.rootBody;
  const humanoid = isHumanoid(r.design);
  b = {
    geo: humanoid ? humanoidGeometry(r.design) : null,
    torso: body('torso'),
    head: body('head'),
    headPart: r.parts.has('head') ? 'head' : null,
    upper: { l: body('upperarm_l'), r: body('upperarm_r') },
    thigh: { l: body('thigh_l'), r: body('thigh_r') },
    shin: { l: body('shin_l'), r: body('shin_r') },
  };
  cache.set(r, b);
  return b;
}

function at(xpos: Float64Array, xmat: Float64Array, body: number, local: Vec3): Vec3 {
  const p = readVec(xpos, body);
  const R: Mat3 = readMat(xmat, body);
  const o = mulMV(R, local);
  return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
}

export function opponentView(ctx: SimContext, opp: RobotRuntime): OpponentView {
  const v = views(ctx);
  const b = bodiesOf(opp);
  const pelvis = readVec(v.xpos, opp.rootBody);
  const com = readVec(v.subtreeCom, opp.rootBody);
  const vel = readVec(v.subtreeLinvel, opp.rootBody);
  const g = b.geo;
  const headAttached = b.headPart ? opp.parts.get(b.headPart)!.attached : false;
  const chest = g ? at(v.xpos, v.xmat, b.torso, g.torsoCenter) : [pelvis[0], pelvis[1], pelvis[2] + 0.3] as Vec3;
  const head = g && headAttached ? at(v.xpos, v.xmat, b.head, g.headCenter) : null;
  const upperArm = {
    l: g ? at(v.xpos, v.xmat, b.upper.l, [0, 0, -g.arms.l.upper * 0.5]) : chest,
    r: g ? at(v.xpos, v.xmat, b.upper.r, [0, 0, -g.arms.r.upper * 0.5]) : chest,
  };
  const thigh = {
    l: g ? at(v.xpos, v.xmat, b.thigh.l, [0, 0, -g.legs.l.thigh * 0.6]) : pelvis,
    r: g ? at(v.xpos, v.xmat, b.thigh.r, [0, 0, -g.legs.r.thigh * 0.6]) : pelvis,
  };
  const knee = { l: readVec(v.xpos, b.shin.l), r: readVec(v.xpos, b.shin.r) };
  return {
    robot: opp,
    com,
    vel,
    pelvis,
    heading: yawOf(readMat(v.xmat, opp.rootBody)),
    head,
    chest,
    upperArm,
    thigh,
    knee,
    frontDepth: g ? g.torsoHalf[0] : 0.2,
    windup: opp.windup,
    skill: opp.skill,
    down: opp.down,
  };
}

/** World point for a target zone ('left_leg' is the opponent's own left). */
export function zonePoint(o: OpponentView, zone: TargetZone): Vec3 {
  switch (zone) {
    case 'head': return o.head ?? [o.chest[0], o.chest[1], o.chest[2] + 0.2];
    case 'left_arm': return o.upperArm.l;
    case 'right_arm': return o.upperArm.r;
    case 'left_leg': return o.thigh.l;
    case 'right_leg': return o.thigh.r;
    case 'torso':
    case 'weapon':
    default: return o.chest;
  }
}

/** The opponent's lead leg as seen from `from`: the thigh nearer to the attacker. */
export function nearLeg(o: OpponentView, from: Vec3): Side {
  const dl = Math.hypot(o.thigh.l[0] - from[0], o.thigh.l[1] - from[1]);
  const dr = Math.hypot(o.thigh.r[0] - from[0], o.thigh.r[1] - from[1]);
  return dl <= dr ? 'l' : 'r';
}
