// Contact episodes → impacts (docs/design/strike-power.md §3.2, §4.2).
//   pairs     every contact pair (two geoms) from first touch to separation. Each tick its normal force
//             F (efc_force) and closing speed v (−efc_vel) add to the impulse ∫F dt and to the work
//             the contact absorbed ∫F·v dt. Pairs that touch slowly (feet on the canvas, a fist
//             leaning on a guard) or start deeply interpenetrated (a spawn overlap) are skipped until
//             they separate.
//   strikes   one strike = one episode: every pair between the two robots that touches in the first
//             strikeWindowS of a strike sums into one group, tallied per part on both sides. Contact
//             between them in the pushTailS after that window is a push group, unless a fresh pair
//             arrives at newStrikeSpeed (the next punch of a combo).
//   the rest  canvas, cage, debris and props: one group per pair.
// When a group closes: one 'impact' event; per part the work its shell took (split by stiffness)
// gives dents, cracks and part damage (shell.ts), punctures and breaks. A strike arms the joint-load
// channels (joint-loads.ts) on the victim's load path, and on the striker's when it landed off-axis or
// into its own stop; a hard strike right on a drive's housing faults that drive.
import type { Corner, PartTag, Vec3 } from '../../core/types';
import type { SimContext } from '../sim-context';
import {
  CAGE_MIN_SPEED, CHAIN_MASS_SHARE, CLEAN_HIT_MIN_SPEED, DAMAGE_TUNING, MAX_ENTRY_PENETRATION_M, MIN_EVENT_IMPULSE_NS, MIN_SPEED_DEBRIS,
  MIN_SPEED_FOOT_CANVAS, MIN_SPEED_PROP, MIN_SPEED_ROBOT_ROBOT, MIN_SPEED_ROBOT_WORLD, NON_STRIKE_DAMAGE_SCALE, OVERLOAD_ARM_TAIL_S,
} from './constants';
import { breakImpulseNs, maybeDetach, type PopBlow } from './detach';
import { surfaceOf, zoneOf } from './durability';
import { faultDrive } from './joint-loads';
import { recordDent, shellResponse, type ShellResponse } from './dent';
import { workShare, type Surface as ShellSurface } from './shell';
import { GEOM_KIND, type ArmContext, type DamageState, type Episode, type GeomInfo, type HitGroup, type PartInfo, type RobotDamage, type Tally } from './state';
import { applyPartDamage, armLoadPath } from './wear';

/** The slice of MuJoCo's mjContact wrapper this module reads. */
interface ContactView {
  geom1: number;
  geom2: number;
  efc_address: number;
  dist: number;
  pos: ArrayLike<number>;
  frame: ArrayLike<number>;
  /** Every element the contact vector hands out is a heap copy with no finalizer: it must be deleted. */
  delete(): void;
}

const isWorld = (g: GeomInfo) => g.kind === GEOM_KIND.CANVAS || g.kind === GEOM_KIND.FENCE || g.kind === GEOM_KIND.POST;
const isRobot = (g: GeomInfo) => g.kind === GEOM_KIND.ROBOT;
const ticks = (ctx: SimContext, s: number) => Math.max(1, Math.round(s / ctx.dt));

function interesting(x: GeomInfo, y: GeomInfo): boolean {
  if (isRobot(x) || isRobot(y)) return true;
  return x.kind === GEOM_KIND.DEBRIS || y.kind === GEOM_KIND.DEBRIS;
}

function minSpeed(x: GeomInfo, y: GeomInfo): number {
  if (isRobot(x) && isRobot(y)) return MIN_SPEED_ROBOT_ROBOT;
  if (x.kind === GEOM_KIND.DEBRIS || y.kind === GEOM_KIND.DEBRIS) return MIN_SPEED_DEBRIS;
  if (x.kind === GEOM_KIND.PROP || y.kind === GEOM_KIND.PROP) return MIN_SPEED_PROP;
  const robot = isRobot(x) ? x : y;
  const other = robot === x ? y : x;
  return robot.role === 'foot' && other.kind === GEOM_KIND.CANVAS ? MIN_SPEED_FOOT_CANVAS : MIN_SPEED_ROBOT_WORLD;
}

/** Mass a hit "feels" on this side (presentation energy only): the body plus part of the limb behind it. */
function sideMass(ctx: SimContext, g: GeomInfo): number {
  if (isWorld(g)) return Infinity;
  const mass = ctx.model.body_mass as Float64Array;
  let m = mass[g.body];
  if (isRobot(g)) {
    const parent = ctx.model.body_parentid[g.body] as number;
    if (parent > 0) m += CHAIN_MASS_SHARE * mass[parent];
  }
  return m;
}

function reducedMass(ma: number, mb: number): number {
  if (!Number.isFinite(ma)) return Number.isFinite(mb) ? mb : 0;
  if (!Number.isFinite(mb)) return ma;
  return (ma * mb) / (ma + mb);
}

/**
 * Body poses (mjData's fixed xmat / xpos fields). Every property read on the MuJoCo wrappers builds a
 * new typed view, so they are kept per data object and rebuilt only when WASM heap growth detached
 * them (a detached view reads byteLength 0: the contact vector copy can grow the heap).
 */
type Poses = { xmat: Float64Array; xpos: Float64Array };
const poseViews = new WeakMap<object, Poses>();

function poses(ctx: SimContext): Poses {
  let p = poseViews.get(ctx.data);
  if (!p || p.xmat.byteLength === 0 || p.xpos.byteLength === 0) {
    p = { xmat: ctx.data.xmat as Float64Array, xpos: ctx.data.xpos as Float64Array };
    poseViews.set(ctx.data, p);
  }
  return p;
}

/** Velocity of a world point riding on a body. */
function pointVelocity(ctx: SimContext, st: DamageState, body: number, p: ArrayLike<number>): Vec3 {
  if (body === 0) return [0, 0, 0];
  ctx.mj.mj_objectVelocity(ctx.model, ctx.data, ctx.mj.mjtObj.mjOBJ_XBODY.value, body, st.velBuf, 0);
  const v = st.velBuf.GetView();
  const xpos = poses(ctx).xpos;
  const rx = p[0] - xpos[body * 3], ry = p[1] - xpos[body * 3 + 1], rz = p[2] - xpos[body * 3 + 2];
  return [v[3] + v[1] * rz - v[2] * ry, v[4] + v[2] * rx - v[0] * rz, v[5] + v[0] * ry - v[1] * rx];
}

/** World vector → body frame (xmat is row-major: R·local = world, so local = Rᵀ·world). */
function toLocal(ctx: SimContext, body: number, v: Vec3, point: boolean): Vec3 {
  const { xmat: R, xpos: x } = poses(ctx);
  const o = body * 9;
  const d: Vec3 = point ? [v[0] - x[body * 3], v[1] - x[body * 3 + 1], v[2] - x[body * 3 + 2]] : v;
  return [
    R[o] * d[0] + R[o + 3] * d[1] + R[o + 6] * d[2],
    R[o + 1] * d[0] + R[o + 4] * d[1] + R[o + 7] * d[2],
    R[o + 2] * d[0] + R[o + 5] * d[1] + R[o + 8] * d[2],
  ];
}

/** The surface a contact meets on geom g (into g along `into`, world). */
function contactSurface(ctx: SimContext, st: DamageState, g: GeomInfo, into: Vec3): { surface: ShellSurface; zone: ReturnType<typeof zoneOf> } {
  if (g.mech) return { surface: g.mech, zone: 'other' };
  const info = g.part!;
  const rd = st.robots[g.corner!];
  const local = toLocal(ctx, g.body, into, false);
  const zone = zoneOf(info.def, g.def!, local);
  return { surface: surfaceOf(rd.profile, zone, g.def!), zone };
}

/** The other robot (or a thrown prop): the only contacts that count as strikes. */
function isStrike(victim: GeomInfo, other: GeomInfo): boolean {
  if (other.kind === GEOM_KIND.PROP) return isRobot(victim);
  return isRobot(victim) && isRobot(other) && victim.corner !== other.corner;
}

/** A fist, glove, foot or shin of the other robot, or a thrown prop. */
function strikingSurface(other: GeomInfo): boolean {
  if (other.kind === GEOM_KIND.PROP) return true;
  return other.role === 'striker' || other.role === 'foot' || !!other.part?.def.tags.includes('shin');
}

/** A clean, committed shot: a striking surface (fist, glove, foot, shin) landing fast. */
function isCleanHit(victim: GeomInfo, other: GeomInfo, speed: number): boolean {
  if (!isStrike(victim, other) || speed < CLEAN_HIT_MIN_SPEED) return false;
  return strikingSurface(other);
}

function unit(v: Vec3): Vec3 {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m > 1e-12 ? [v[0] / m, v[1] / m, v[2] / m] : [0, 0, 1];
}

function newTally(info: PartInfo, geom: GeomInfo, other: GeomInfo, zone: Tally['zone'], surface: ShellSurface, striking: boolean): Tally {
  return {
    info, geom, other, zone, surface, impulse: 0, jx: 0, jy: 0, jz: 0, work: 0, peakForce: 0, tickForce: 0, forceRing: [], filtPeak: 0,
    pos: [0, 0, 0], normal: [0, 0, 1], localPos: [0, 0, 0], localNormal: [0, 0, 1], striking, speed: 0, t0: -1, firstOther: null, jImpact: 0,
  };
}

/** Parts that guard: a strike that meets one of these first is blocked. */
const GUARD_TAGS: PartTag[] = ['upperarm', 'forearm', 'fist', 'finger', 'shield', 'thigh', 'shin'];

/** Did the striking part meet the struck robot's guard (an arm or a leg) at or before it reached part t? */
function blockedBy(g: HitGroup, t: Tally, first: GeomInfo): boolean {
  const striker = first.part;
  if (!striker) return false; // a thrown prop
  for (const u of g.tallies) {
    if (u === t || u.info.robot !== t.info.robot || u.t0 < 0 || u.t0 > t.t0 || u.impulse < DAMAGE_TUNING.guardMinNs) continue;
    if (!u.info.def.tags.some((x) => GUARD_TAGS.includes(x))) continue;
    if ((u.firstOther ?? u.other).part === striker) return true;
  }
  return false;
}

/**
 * The blow that may knock part t off, or null. Only a really nice hard solid clean hit can: a strike
 * by the other robot (not a push, not the floor, the cage or debris) or a thrown prop, whose first and
 * hardest contacts on the part were a striking surface (fist, glove, foot, shin) arriving at strike
 * speed, and that did not meet the guard first. What then counts against the mount is its impact
 * impulse (DAMAGE_TUNING.impactWindowS), not the lean that follows, and no speed threshold: a faster
 * punch only pops a head by delivering a harder blow. Exported for tests.
 */
export function popBlow(ctx: SimContext, g: HitGroup, t: Tally): PopBlow | null {
  if (!t.info.def.detachable || !t.info.part.attached || t.striking || t.t0 < 0) return null;
  const prop = t.other.kind === GEOM_KIND.PROP;
  if (g.kind === 'push' || (g.kind === 'pair' && !prop) || !isStrike(t.geom, t.other)) return null;
  const first = t.firstOther ?? t.other;
  if (!strikingSurface(first) || !strikingSurface(t.other) || t.speed < DAMAGE_TUNING.newStrikeSpeed) return null;
  if (blockedBy(g, t, first)) return null;
  const corner = isRobot(first) ? first.corner : null;
  const skill = corner !== null ? ctx.robots[corner].skill : null;
  const part = first.part?.def.id ?? null;
  return {
    cause: prop ? 'prop' : 'strike', byCorner: corner, by: part ? `${part}${skill ? ` (${skill})` : ''}` : null,
    impactNs: t.jImpact, windowNs: t.impulse, speed: t.speed,
  };
}

/** The group's tally for a part (one per part per group; several pairs can land on one part). */
function tallyFor(g: HitGroup, info: PartInfo, make: () => Tally): Tally {
  for (const t of g.tallies) if (t.info === info) return t;
  const t = make();
  g.tallies.push(t);
  return t;
}

function newGroup(ctx: SimContext, kind: HitGroup['kind'], striker: Corner | null, victim: Corner | null, first: Episode, windowS: number): HitGroup {
  return {
    kind, striker, victim,
    startTick: ctx.tick,
    closeTick: ctx.tick + ticks(ctx, windowS) - 1,
    first, pairs: [], tallies: [],
    impulse: 0, work: 0, peakForce: 0, speed: first.speed, done: false,
  };
}

const open = (ctx: SimContext, g: HitGroup | null): g is HitGroup => !!g && !g.done && ctx.tick <= g.closeTick;

// ---------------------------------------------------------------- arming

/** Whose strike this is, for the joint events' cause (r.skill: what the striking body was doing). */
function armContext(ctx: SimContext, role: ArmContext['role'], striker: GeomInfo): ArmContext {
  const corner = isRobot(striker) ? striker.corner : null;
  return { role, byCorner: corner, byPart: striker.part?.def.id ?? null, skill: corner !== null ? ctx.robots[corner].skill : null };
}

/**
 * Does a strike load the striker's own joints? Only when it lands off-axis (an arm strike whose
 * contact force runs well off the forearm's line) or into its own stop (the elbow or knee within
 * stopMarginDeg of a limit): docs/design/strike-power.md §4.3.
 */
export function strikerLoaded(ctx: SimContext, st: DamageState, striker: GeomInfo, into: Vec3): boolean {
  const info = striker.part;
  if (!info || !isRobot(striker)) return false;
  const rd = st.robots[striker.corner!];
  const t = DAMAGE_TUNING;
  const tags = info.def.tags;
  const arm = tags.includes('fist') || tags.includes('finger');
  const leg = tags.includes('foot') || tags.includes('shin');
  if (!arm && !leg) return false;
  // The end joint: the elbow (the fist's parent forearm) or the knee (the shin, or the foot's parent).
  const limb = tags.includes('shin') ? info : rd.parts.get(info.def.parent ?? '');
  if (!limb) return false;
  const margin = (t.stopMarginDeg * Math.PI) / 180;
  const range = ctx.model.jnt_range as Float64Array;
  const qpos = ctx.data.qpos as Float64Array;
  for (const i of limb.jointIdx) {
    const m = rd.mech[i];
    const q = qpos[rd.robot.joints[i].qadr];
    if (q - range[m.mjJoint * 2] < margin || range[m.mjJoint * 2 + 1] - q < margin) return true;
  }
  if (!arm) return false;
  // Forearm axis (elbow → fist): the capsule runs along the forearm body's −z.
  const R = ctx.data.xmat as Float64Array;
  const o = limb.part.body * 9;
  const axis: Vec3 = [-R[o + 2], -R[o + 5], -R[o + 8]];
  const cos = axis[0] * into[0] + axis[1] * into[1] + axis[2] * into[2];
  return cos < Math.cos((t.strikerOffAxisDeg * Math.PI) / 180);
}

const LIMB_TAGS = ['upperarm', 'forearm', 'fist', 'finger', 'thigh', 'shin', 'foot'];

/** Is geom g on the limb that threw strike g (the first pair's striking part and its limb above it)? */
function onStrikingLimb(st: DamageState, g: HitGroup, geom: GeomInfo): boolean {
  const first = g.first;
  const s = st.geoms[first.striker === 'a' ? first.a : first.b];
  if (!s?.part || !geom.part) return false;
  return s.part.loadPath.some((p) => p === geom.part && p.def.tags.some((t) => LIMB_TAGS.includes(t)));
}

/**
 * Arms the load paths a strike pair loads: the victim's always, the striker's when it is loaded.
 * Roles follow the strike, not the pair: inside a strike, a pair whose faster side is the struck
 * robot meeting the striking limb (a guard moving into the punching arm) still makes the puncher the
 * striker, so its own limb is armed only by strikerLoaded, never as a 'victim'. A counter that lands
 * elsewhere on the puncher (his head, his body) inside the window still arms him as its victim.
 */
function armStrike(ctx: SimContext, st: DamageState, g: HitGroup, ep: Episode, victimIn: GeomInfo, strikerIn: GeomInfo, intoIn: Vec3): void {
  const swap = g.kind === 'strike' && isRobot(victimIn) && victimIn.corner === g.striker && onStrikingLimb(st, g, victimIn);
  const victim = swap ? strikerIn : victimIn;
  const striker = swap ? victimIn : strikerIn;
  const into: Vec3 = swap ? [-intoIn[0], -intoIn[1], -intoIn[2]] : intoIn;
  const until = g.closeTick + ticks(ctx, OVERLOAD_ARM_TAIL_S);
  if (victim.part && isRobot(victim)) {
    const arm = armContext(ctx, 'victim', striker);
    armLoadPath(victim.part, until, arm);
    if (DAMAGE_TUNING.trunkArmsLegs && TRUNK_TAGS.some((x) => victim.part!.def.tags.includes(x))) armStandingLegs(ctx, st.robots[victim.corner!], until, arm);
  }
  if (isRobot(striker) && striker.part && strikerLoaded(ctx, st, striker, into)) armLoadPath(striker.part, until, armContext(ctx, 'striker', striker));
  void ep;
}

const TRUNK_TAGS: PartTag[] = ['torso', 'chassis', 'head', 'pelvis'];

/**
 * A blow on the trunk goes to the ground through the legs standing on the canvas: arm their hips,
 * knees and ankles (each foot's load path up to the pelvis). Their channels then read what the legs
 * really carried; a leg in the air carries almost nothing and books nothing.
 */
function armStandingLegs(ctx: SimContext, rd: RobotDamage, until: number, arm: ArmContext): void {
  for (const p of rd.parts.values()) {
    if (p.groundTick >= ctx.tick - 1 && p.part.attached && p.def.tags.includes('foot')) armLoadPath(p, until, arm);
  }
}

// ---------------------------------------------------------------- episodes

function startEpisode(ctx: SimContext, st: DamageState, a: number, b: number, c: ContactView): Episode {
  const ga = st.geoms[a]!, gb = st.geoms[b]!;
  const f = c.frame;
  const s = c.geom1 === a ? 1 : -1; // MuJoCo's normal points geom1 → geom2; make it point a → b
  const n: Vec3 = [f[0] * s, f[1] * s, f[2] * s];
  const va = pointVelocity(ctx, st, ga.body, c.pos);
  const vb = pointVelocity(ctx, st, gb.body, c.pos);
  const approachA = va[0] * n[0] + va[1] * n[1] + va[2] * n[2];
  const approachB = -(vb[0] * n[0] + vb[1] * n[1] + vb[2] * n[2]);
  const speed = Math.max(0, approachA + approachB);
  const ep: Episode = {
    a, b,
    startTick: ctx.tick,
    lastTick: ctx.tick,
    active: false,
    group: null,
    impulse: 0, jx: 0, jy: 0, jz: 0, work: 0,
    tickF: 0, tickFV: 0, prevF: 0, prevV: 0,
    peakForce: 0,
    pos: [c.pos[0], c.pos[1], c.pos[2]],
    speed,
    massEff: reducedMass(sideMass(ctx, ga), sideMass(ctx, gb)),
    striker: approachA >= approachB ? 'a' : 'b',
    shareA: 0.5,
    tallyA: null,
    tallyB: null,
  };
  const fresh = c.dist > -MAX_ENTRY_PENETRATION_M; // not a spawn overlap being pushed apart
  const canStart = fresh && speed >= minSpeed(ga, gb);
  if (isRobot(ga) && isRobot(gb) && ga.corner !== gb.corner) robotPair(ctx, st, ep, ga, gb, n, canStart, fresh);
  else if (canStart) {
    const victim = isRobot(ga) ? ga : isRobot(gb) ? gb : null;
    const g = newGroup(ctx, 'pair', null, victim?.corner ?? null, ep, DAMAGE_TUNING.strikeWindowS);
    st.pairGroups.add(g);
    join(ctx, st, g, ep, ga, gb, n);
    // A thrown prop is a strike on the robot it hits: it loads that robot's joints.
    const prop = ga.kind === GEOM_KIND.PROP ? ga : gb.kind === GEOM_KIND.PROP ? gb : null;
    if (prop && victim) armStrike(ctx, st, g, ep, victim, prop, prop === ga ? n : [-n[0], -n[1], -n[2]]);
  }
  return ep;
}

/** Closes every armed load path of a robot now: its joint episodes resolve on the peaks they have. */
function endArming(ctx: SimContext, st: DamageState, corner: Corner): void {
  for (const info of st.robots[corner].parts.values()) if (info.armedUntil >= ctx.tick) info.armedUntil = ctx.tick - 1;
}

/** A pair between the two robots: it joins the open strike, starts one, or is a push. */
function robotPair(ctx: SimContext, st: DamageState, ep: Episode, ga: GeomInfo, gb: GeomInfo, n: Vec3, canStart: boolean, fresh: boolean): void {
  const t = DAMAGE_TUNING;
  const sGeom = ep.striker === 'a' ? ga : gb;
  const vGeom = sGeom === ga ? gb : ga;
  const sc = sGeom.corner!, vc = vGeom.corner!;
  const into: Vec3 = sGeom === ga ? n : [-n[0], -n[1], -n[2]]; // from the striker into the victim
  // An open strike between these two (either way round) takes every pair that touches inside it.
  const strike = open(ctx, st.strikes[sc]) ? st.strikes[sc] : open(ctx, st.strikes[vc]) ? st.strikes[vc] : null;
  if (strike) {
    if (!fresh) return;
    join(ctx, st, strike, ep, ga, gb, n);
    if (canStart) armStrike(ctx, st, strike, ep, vGeom, sGeom, into);
    return;
  }
  if (!canStart) return;
  const tail = ticks(ctx, t.pushTailS);
  const inTail = ctx.tick - st.strikeEnd[sc] <= tail || ctx.tick - st.strikeEnd[vc] <= tail;
  if (!inTail || ep.speed >= t.newStrikeSpeed) {
    const prior = st.pushes[sc] ?? st.pushes[vc];
    if (prior && !prior.done) finalize(ctx, st, prior); // a fresh strike ends the push before it
    const g = newGroup(ctx, 'strike', sc, vc, ep, t.strikeWindowS);
    st.strikes[sc] = g;
    join(ctx, st, g, ep, ga, gb, n);
    armStrike(ctx, st, g, ep, vGeom, sGeom, into);
    return;
  }
  // A push arms no joints, and it also ends what is left of the strike's arm tail on both robots:
  // otherwise a fist sliding off the guard into the body inside the tail loads the joint channels
  // (with the stiff contact's first-step spike) as if it were the strike.
  endArming(ctx, st, sc);
  endArming(ctx, st, vc);
  const push = open(ctx, st.pushes[sc]) ? st.pushes[sc] : open(ctx, st.pushes[vc]) ? st.pushes[vc] : null;
  if (push) {
    join(ctx, st, push, ep, ga, gb, n);
    return;
  }
  const g = newGroup(ctx, 'push', sc, vc, ep, t.pushTailS);
  st.pushes[sc] = g;
  join(ctx, st, g, ep, ga, gb, n);
}

/** Adds a pair to a group: its tallies on both sides and how its work splits between the two surfaces. */
function join(ctx: SimContext, st: DamageState, g: HitGroup, ep: Episode, ga: GeomInfo, gb: GeomInfo, n: Vec3): void {
  ep.group = g;
  ep.active = true;
  g.pairs.push(ep);
  const intoA: Vec3 = [-n[0], -n[1], -n[2]];
  const sa = contactSurface(ctx, st, ga, intoA);
  const sb = contactSurface(ctx, st, gb, n);
  ep.shareA = workShare(sa.surface, sb.surface);
  const strikerA = ep.striker === 'a';
  // Robot geoms (attached) get tallies; debris (a lost part) and the arena take no damage.
  if (isRobot(ga) && ga.part) ep.tallyA = tallyFor(g, ga.part, () => newTally(ga.part!, ga, gb, sa.zone, sa.surface, strikerA));
  if (isRobot(gb) && gb.part) ep.tallyB = tallyFor(g, gb.part, () => newTally(gb.part!, gb, ga, sb.zone, sb.surface, !strikerA));
  for (const t of [ep.tallyA, ep.tallyB]) if (t && ep.speed > t.speed) t.speed = ep.speed;
}

function addToTally(ctx: SimContext, t: Tally, other: GeomInfo, j: number, dir: Vec3, force: number, p: ArrayLike<number>): void {
  if (t.t0 < 0) {
    t.t0 = ctx.tick;
    t.firstOther = other;
  }
  if (ctx.tick - t.t0 < ticks(ctx, DAMAGE_TUNING.impactWindowS)) t.jImpact += j;
  t.impulse += j;
  t.jx += j * dir[0];
  t.jy += j * dir[1];
  t.jz += j * dir[2];
  if (force > t.tickForce) t.tickForce = force;
  if (force > t.peakForce) {
    t.peakForce = force;
    t.other = other;
    t.pos = [p[0], p[1], p[2]];
    t.normal = dir;
    // In the part's own frame now: the dent lands where the hit landed however the part moves after.
    t.localPos = toLocal(ctx, t.geom.body, t.pos, true);
    t.localNormal = toLocal(ctx, t.geom.body, [-dir[0], -dir[1], -dir[2]], false);
  }
}

function accumulate(ctx: SimContext, st: DamageState, ep: Episode, c: ContactView, force: number, closing: number): void {
  const g = ep.group!;
  const dt = ctx.dt;
  const f = c.frame;
  const s = c.geom1 === ep.a ? 1 : -1; // force on geom2 is +F·n; we store the impulse on geom b
  const n: Vec3 = [s * f[0], s * f[1], s * f[2]];
  const j = force * dt;
  ep.impulse += j;
  ep.jx += j * n[0];
  ep.jy += j * n[1];
  ep.jz += j * n[2];
  ep.tickF += force;
  ep.tickFV += force * closing;
  if (force > ep.peakForce) {
    ep.peakForce = force;
    ep.pos = [c.pos[0], c.pos[1], c.pos[2]];
  }
  g.impulse += j;
  if (force > g.peakForce) g.peakForce = force;
  const ga = st.geoms[ep.a]!, gb = st.geoms[ep.b]!;
  if (ep.tallyA) addToTally(ctx, ep.tallyA, gb, j, [-n[0], -n[1], -n[2]], force, c.pos);
  if (ep.tallyB) addToTally(ctx, ep.tallyB, ga, j, n, force, c.pos);
}

/** Adds absorbed work to a pair, its group and the two surfaces (split by stiffness). */
function addWork(ep: Episode, w: number): void {
  ep.work += w;
  if (ep.group) ep.group.work += w;
  if (ep.tallyA) ep.tallyA.work += w * ep.shareA;
  if (ep.tallyB) ep.tallyB.work += w * (1 - ep.shareA);
}

/**
 * Work over the step the last settled force acted: F·½(v_before + v_after)·dt (trapezoid rule; the
 * closing speed can halve inside one stiff step, so F·v_before alone overcounts). v is the
 * force-weighted closing speed of the pair's contacts. Negative while the surfaces spring apart.
 */
function settleWork(ctx: SimContext, ep: Episode): void {
  const v = ep.tickF > 0 ? ep.tickFV / ep.tickF : ep.prevV;
  if (ep.prevF > 0) addWork(ep, ep.prevF * 0.5 * (ep.prevV + v) * ctx.dt);
  ep.prevF = ep.tickF;
  ep.prevV = v;
  ep.tickF = 0;
  ep.tickFV = 0;
}

/** Folds this step's largest contact force on each tally into its moving average and filtered peak. */
function settleForces(g: HitGroup): void {
  const n = DAMAGE_TUNING.forceFilterSteps;
  for (const t of g.tallies) {
    const ring = t.forceRing;
    ring.push(t.tickForce);
    if (ring.length > n) ring.shift();
    let sum = 0;
    for (let k = 0; k < ring.length; k++) sum += ring[k];
    const avg = sum / n; // a one-step spike counts for 1/n of itself
    if (avg > t.filtPeak) t.filtPeak = avg;
    t.tickForce = 0;
  }
}

/** The pair stopped (separated or its group closed): the last force acted while it came to rest. */
function flushWork(ctx: SimContext, ep: Episode): void {
  if (ep.prevF > 0) addWork(ep, ep.prevF * 0.5 * ep.prevV * ctx.dt);
  ep.prevF = 0;
}

/** A detachable part whose clean blow already reaches its mount's break impulse pops now. */
function breaksNow(ctx: SimContext, st: DamageState, g: HitGroup): boolean {
  if (g.kind === 'push') return false;
  for (const t of g.tallies) {
    if (!t.info.def.detachable) continue;
    const blow = popBlow(ctx, g, t);
    if (blow && blow.impactNs >= breakImpulseNs(st, t.info)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- closing a group

function mainVictim(g: HitGroup): Tally | null {
  let best: Tally | null = null;
  for (const t of g.tallies) {
    if (g.victim !== null && t.info.robot.corner !== g.victim) continue;
    if (!best || t.impulse > best.impulse) best = t;
  }
  return best;
}

function emitImpact(ctx: SimContext, st: DamageState, g: HitGroup, main: Tally | null, dent: ShellResponse | null): void {
  const ep = g.first;
  const ga = st.geoms[ep.a]!, gb = st.geoms[ep.b]!;
  let pos: Vec3 = ep.pos;
  let normal: Vec3;
  let striker: Corner | null = null;
  let victimCorner: Corner | null = null;
  let part: string | null = null;
  let metal = ga.surface.sparks && gb.surface.sparks;
  let strikerPart: string | null = null;
  if (main) {
    pos = main.pos;
    normal = unit([main.jx, main.jy, main.jz]);
    victimCorner = main.info.robot.corner;
    part = main.info.def.id;
    metal = main.geom.surface.sparks && main.other.surface.sparks;
    if (g.kind !== 'pair') {
      striker = g.striker;
      const s = ep.striker === 'a' ? ga : gb;
      strikerPart = s.part?.def.id ?? null;
    }
  } else {
    // A loose piece landing: the direction it was pushed.
    const pushed = isWorld(ga) ? gb : ga;
    normal = unit(pushed === gb ? [ep.jx, ep.jy, ep.jz] : [-ep.jx, -ep.jy, -ep.jz]);
  }
  const clean = !!main && g.kind === 'strike' && isCleanHit(main.geom, main.other, main.speed);
  ctx.events.push({
    kind: 'impact',
    pos,
    normal,
    impulseNs: g.impulse,
    speed: main ? Math.max(main.speed, g.speed) : g.speed,
    energyJ: 0.5 * ep.massEff * ep.speed * ep.speed,
    striker,
    victim: victimCorner,
    part,
    metal,
    workJ: Math.max(0, g.work),
    peakForceN: g.peakForce,
    strikerPart,
    clean,
    push: g.kind === 'push',
    ...(dent && main ? { dent: { part: main.info.def.id, mode: dent.mode, depthM: dent.depthM, radiusM: dent.radiusM, cracked: dent.cracked } } : {}),
  });
  const cage = ga.kind === GEOM_KIND.FENCE || ga.kind === GEOM_KIND.POST ? gb : gb.kind === GEOM_KIND.FENCE || gb.kind === GEOM_KIND.POST ? ga : null;
  if (cage && isRobot(cage) && ep.speed >= CAGE_MIN_SPEED) {
    ctx.events.push({ kind: 'cage', corner: cage.corner!, pos: ep.pos, speed: ep.speed });
  }
}

/**
 * A hard strike right on a drive's housing faults it (the struck part's own joints and those at its
 * far end). Measured in the struck part's frame: the contact where it was at the peak, the anchors
 * where they sit on the part (an anchor is fixed on its part however the limb has moved since).
 */
function housingHits(ctx: SimContext, st: DamageState, rd: RobotDamage, t: Tally, arm: ArmContext): void {
  const tune = DAMAGE_TUNING;
  if (t.filtPeak < tune.housingForceN || !strikingSurface(t.other)) return;
  const xa = ctx.data.xanchor as Float64Array;
  // The drive whose housing the blow landed on: the nearest within reach (a 3-axis hip or shoulder
  // stacks its modules at one point; one blow faults the one it hit).
  let best = -1, bestD = Infinity;
  for (const i of [...t.info.jointIdx, ...t.info.childJointIdx]) {
    const m = rd.mech[i];
    const k = m.mjJoint * 3;
    const a = toLocal(ctx, t.geom.body, [xa[k], xa[k + 1], xa[k + 2]], true);
    const d = Math.hypot(t.localPos[0] - a[0], t.localPos[1] - a[1], t.localPos[2] - a[2]);
    if (d <= m.housingReachM && d < bestD) { best = i; bestD = d; }
  }
  if (best >= 0) faultDrive(ctx, st, rd, best, t.filtPeak / tune.housingForceN, arm);
}

/** Closes a group: one event, then shells, dents, part damage, punctures, housing hits and breaks. */
function finalize(ctx: SimContext, st: DamageState, g: HitGroup): void {
  if (g.done) return;
  g.done = true;
  for (const ep of g.pairs) {
    if (ep.active) flushWork(ctx, ep);
    ep.active = false; // spent until the pair separates
  }
  if (g.kind === 'strike' && g.striker !== null && st.strikes[g.striker] === g) {
    st.strikes[g.striker] = null;
    st.strikeEnd[g.striker] = ctx.tick;
  } else if (g.kind === 'push' && g.striker !== null && st.pushes[g.striker] === g) st.pushes[g.striker] = null;
  else st.pairGroups.delete(g);
  if (g.impulse < MIN_EVENT_IMPULSE_NS) return;
  const tune = DAMAGE_TUNING;
  const main = mainVictim(g);
  const results = new Map<Tally, ShellResponse | null>();
  for (const t of g.tallies) {
    const spread = isWorld(t.other) ? tune.worldSpread : 1;
    results.set(t, t.info.part.attached ? shellResponse(t.surface, Math.max(0, t.work), t.filtPeak, t.info.weakening[t.zone] ?? 1, spread) : null);
  }
  emitImpact(ctx, st, g, main, main ? results.get(main) ?? null : null);
  for (const t of g.tallies) {
    if (!t.info.part.attached) continue;
    const rd = st.robots[t.info.robot.corner];
    const strike = isStrike(t.geom, t.other);
    const res = results.get(t) ?? null;
    applyPartDamage(rd, t.info, (res?.points ?? 0) * (strike ? 1 : NON_STRIKE_DAMAGE_SCALE), strike);
    if (res) recordDent(ctx, rd, t, res);
    if (t.info.circuits.length && t.work >= tune.punctureWorkJ) t.info.punctured = true;
    if (strike && g.kind !== 'push' && !t.striking) housingHits(ctx, st, rd, t, armContext(ctx, 'victim', t.other));
    // Only one really nice hard solid clean blow pops a part (popBlow); falls, the floor, the cage,
    // pushes, blocked blows and accumulated damage never do.
    if (t.info.def.detachable) maybeDetach(ctx, st, t.info, popBlow(ctx, g, t), [t.jx, t.jy, t.jz]);
  }
}

function trackContact(ctx: SimContext, st: DamageState, c: ContactView, efc: Float64Array, efcVel: Float64Array): void {
  const g1 = c.geom1, g2 = c.geom2;
  const i1 = st.geoms[g1], i2 = st.geoms[g2];
  if (!i1 || !i2 || !interesting(i1, i2)) return;
  // A part on the canvas (a foot: that leg carries the trunk's blows to the ground, armStrike).
  if (i1.kind === GEOM_KIND.CANVAS && isRobot(i2) && i2.part) i2.part.groundTick = ctx.tick;
  else if (i2.kind === GEOM_KIND.CANVAS && isRobot(i1) && i1.part) i1.part.groundTick = ctx.tick;
  const a = g1 < g2 ? g1 : g2;
  const b = g1 < g2 ? g2 : g1;
  const key = a * st.ngeom + b;
  let ep = st.episodes.get(key);
  if (!ep) {
    ep = startEpisode(ctx, st, a, b, c);
    st.episodes.set(key, ep);
  }
  ep.lastTick = ctx.tick;
  if (!ep.active) return;
  const g = ep.group;
  if (!g || g.done || ctx.tick > g.closeTick) return;
  const addr = c.efc_address;
  if (addr < 0) return;
  const force = efc[addr]; // elliptic cones: the first row is the normal force
  // A force beyond anything a body can deliver is the solver diverging (the worker rolls those back).
  if (force > 0 && force < DAMAGE_TUNING.maxContactForceN) accumulate(ctx, st, ep, c, force, -efcVel[addr]); // efc_vel < 0 while closing
}

function readContacts(ctx: SimContext, st: DamageState): void {
  const { data } = ctx;
  const n = data.ncon as number;
  if (n === 0) return;
  // The vector and each element it hands out are heap copies (~0.7 KB per contact). An undeleted
  // element leaks for good and grows the WASM heap, which detaches every typed view taken before the
  // growth, so efc_force and efc_vel are read after the vector copy is made.
  const contacts = data.contact;
  try {
    const efc = data.efc_force as Float64Array;
    const efcVel = data.efc_vel as Float64Array;
    for (let i = 0; i < n; i++) {
      const c = contacts.get(i) as ContactView;
      try {
        trackContact(ctx, st, c, efc, efcVel);
      } finally {
        c.delete();
      }
    }
  } finally {
    contacts.delete();
  }
}

/** Groups still open in this state (strikes, pushes, single pairs). */
function openGroups(st: DamageState): HitGroup[] {
  const out: HitGroup[] = [];
  for (const g of st.strikes) if (g && !g.done) out.push(g);
  for (const g of st.pushes) if (g && !g.done) out.push(g);
  for (const g of st.pairGroups) if (!g.done) out.push(g);
  return out;
}

/** One step of impact tracking. Call after mj_step. */
export function impactStep(ctx: SimContext, st: DamageState): void {
  readContacts(ctx, st);
  for (const [key, ep] of st.episodes) {
    if (ep.lastTick !== ctx.tick) {
      if (ep.active) flushWork(ctx, ep);
      st.episodes.delete(key);
    } else if (ep.active) settleWork(ctx, ep);
  }
  for (const g of openGroups(st)) {
    settleForces(g);
    // A strike or push keeps its whole window (a glance off the guard and the hit behind it are one
    // strike); a single pair (canvas, cage, debris, props) closes when it separates.
    const separated = g.kind === 'pair' && !g.pairs.some((ep) => ep.lastTick === ctx.tick);
    if (ctx.tick >= g.closeTick || separated || breaksNow(ctx, st, g)) finalize(ctx, st, g);
  }
}
