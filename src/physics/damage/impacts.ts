// Contact episodes → impacts. Every step: group contacts by geom pair, integrate the normal
// impulse (∫F dt) over the first IMPACT_WINDOW_S of each episode, and when the episode ends (or the
// window closes) emit one 'impact' event and apply damage to both sides. Resting contacts (feet on
// the canvas, a fist leaning on a guard) are recognised at first touch by their low closing speed
// and skipped until they separate, which keeps the per-step cost down. So are pairs that start deeply
// interpenetrated (spawn overlap), whose push-out force is a solver artifact, not a hit.
import type { Corner, Vec3 } from '../../core/types';
import type { SimContext } from '../sim-context';
import {
  CAGE_MIN_SPEED, CHAIN_MASS_SHARE, IMPACT_WINDOW_S, MAX_ENTRY_PENETRATION_M, MIN_EVENT_IMPULSE_NS, MIN_SPEED_DEBRIS, MIN_SPEED_FOOT_CANVAS,
  MIN_SPEED_PROP, MIN_SPEED_ROBOT_ROBOT, MIN_SPEED_ROBOT_WORLD, OVERLOAD_ARM_TAIL_S,
} from './constants';
import { maybeDetach } from './detach';
import { GEOM_KIND, type DamageState, type Episode, type GeomInfo } from './state';
import { applyPartDamage, armLoadPath, damagePoints } from './wear';

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

/** Mass a hit "feels" on this side: the body plus part of the limb behind it. World geometry is immovable. */
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

/** Velocity of a world point riding on a body. */
function pointVelocity(ctx: SimContext, st: DamageState, body: number, p: ArrayLike<number>): Vec3 {
  if (body === 0) return [0, 0, 0];
  ctx.mj.mj_objectVelocity(ctx.model, ctx.data, ctx.mj.mjtObj.mjOBJ_XBODY.value, body, st.velBuf, 0);
  const v = st.velBuf.GetView();
  const xpos = ctx.data.xpos as Float64Array;
  const rx = p[0] - xpos[body * 3], ry = p[1] - xpos[body * 3 + 1], rz = p[2] - xpos[body * 3 + 2];
  return [v[3] + v[1] * rz - v[2] * ry, v[4] + v[2] * rx - v[0] * rz, v[5] + v[0] * ry - v[1] * rx];
}

function startEpisode(ctx: SimContext, st: DamageState, a: number, b: number, c: ContactView): Episode {
  const ga = st.geoms[a]!, gb = st.geoms[b]!;
  const f = c.frame;
  const s = c.geom1 === a ? 1 : -1; // MuJoCo's normal points geom1 → geom2; make it point a → b
  const nx = f[0] * s, ny = f[1] * s, nz = f[2] * s;
  const va = pointVelocity(ctx, st, ga.body, c.pos);
  const vb = pointVelocity(ctx, st, gb.body, c.pos);
  const approachA = va[0] * nx + va[1] * ny + va[2] * nz;
  const approachB = -(vb[0] * nx + vb[1] * ny + vb[2] * nz);
  const speed = Math.max(0, approachA + approachB);
  const active = speed >= minSpeed(ga, gb) && c.dist > -MAX_ENTRY_PENETRATION_M;
  if (active) {
    const until = ctx.tick + Math.ceil((IMPACT_WINDOW_S + OVERLOAD_ARM_TAIL_S) / ctx.dt);
    for (const g of [ga, gb]) if (isRobot(g) && g.part) armLoadPath(g.part, until);
  }
  return {
    a, b,
    startTick: ctx.tick,
    lastTick: ctx.tick,
    active,
    impulse: 0, jx: 0, jy: 0, jz: 0,
    peakForce: 0,
    pos: [c.pos[0], c.pos[1], c.pos[2]],
    speed,
    massEff: reducedMass(sideMass(ctx, ga), sideMass(ctx, gb)),
    striker: approachA >= approachB ? 'a' : 'b',
  };
}

function accumulate(ep: Episode, c: ContactView, force: number, dt: number): void {
  const f = c.frame;
  const s = c.geom1 === ep.a ? 1 : -1; // force on geom2 is +F·n; we store the impulse on geom b
  const j = force * dt;
  ep.impulse += j;
  ep.jx += s * j * f[0];
  ep.jy += s * j * f[1];
  ep.jz += s * j * f[2];
  if (force > ep.peakForce) {
    ep.peakForce = force;
    const p = c.pos;
    ep.pos = [p[0], p[1], p[2]];
  }
}

/** A detachable part whose running impulse already beats its break spec pops now, not at episode end. */
function breaksNow(st: DamageState, ep: Episode): boolean {
  for (const g of [st.geoms[ep.a]!, st.geoms[ep.b]!]) {
    const spec = isRobot(g) ? g.part?.def.detachable : undefined;
    if (spec && g.part!.part.attached && ep.impulse >= spec.impulseNs) return true;
  }
  return false;
}

function unit(v: Vec3): Vec3 {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m > 1e-12 ? [v[0] / m, v[1] / m, v[2] / m] : [0, 0, 1];
}

function emitImpact(ctx: SimContext, ep: Episode, ga: GeomInfo, gb: GeomInfo, energyJ: number): void {
  const onB: Vec3 = [ep.jx, ep.jy, ep.jz];
  const onA: Vec3 = [-ep.jx, -ep.jy, -ep.jz];
  let striker: Corner | null = null;
  let victim: GeomInfo | null = null;
  if (isRobot(ga) && isRobot(gb)) {
    victim = ep.striker === 'a' ? gb : ga;
    striker = (ep.striker === 'a' ? ga : gb).corner;
  } else if (isRobot(ga) || isRobot(gb)) {
    victim = isRobot(ga) ? ga : gb;
  }
  // Normal: the direction the victim was pushed (or the loose piece, for debris landing on the canvas).
  const pushed = victim ?? (isWorld(ga) ? gb : ga);
  ctx.events.push({
    kind: 'impact',
    pos: ep.pos,
    normal: unit(pushed === gb ? onB : onA),
    impulseNs: ep.impulse,
    speed: ep.speed,
    energyJ,
    striker,
    victim: victim ? victim.corner : null,
    part: victim?.part?.def.id ?? null,
    metal: ga.surface.sparks && gb.surface.sparks,
  });
  const cage = ga.kind === GEOM_KIND.FENCE || ga.kind === GEOM_KIND.POST ? gb : gb.kind === GEOM_KIND.FENCE || gb.kind === GEOM_KIND.POST ? ga : null;
  if (cage && isRobot(cage) && ep.speed >= CAGE_MIN_SPEED) {
    ctx.events.push({ kind: 'cage', corner: cage.corner!, pos: ep.pos, speed: ep.speed });
  }
}

/** Closes the measurement of an episode: event, damage on both sides, break checks. */
function finalize(ctx: SimContext, st: DamageState, ep: Episode): void {
  ep.active = false;
  if (ep.impulse < MIN_EVENT_IMPULSE_NS) return;
  const ga = st.geoms[ep.a]!, gb = st.geoms[ep.b]!;
  const energyJ = 0.5 * ep.massEff * ep.speed * ep.speed;
  emitImpact(ctx, ep, ga, gb, energyJ);
  const sides: Array<[GeomInfo, GeomInfo, Vec3]> = [
    [ga, gb, [-ep.jx, -ep.jy, -ep.jz]],
    [gb, ga, [ep.jx, ep.jy, ep.jz]],
  ];
  for (const [self, other, impulseOnSelf] of sides) {
    if (!isRobot(self) || !self.part || !self.part.part.attached) continue;
    const rd = st.robots[self.corner!];
    applyPartDamage(ctx, rd, self.part, damagePoints(ep.impulse, energyJ, other.surface, self.surface));
    maybeDetach(ctx, st, self.part, ep.impulse, impulseOnSelf);
  }
}

function trackContact(ctx: SimContext, st: DamageState, c: ContactView, efc: Float64Array): void {
  const g1 = c.geom1, g2 = c.geom2;
  const i1 = st.geoms[g1], i2 = st.geoms[g2];
  if (!i1 || !i2 || !interesting(i1, i2)) return;
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
  const force = efc[c.efc_address]; // elliptic cones: the first row is the normal force
  if (force > 0) accumulate(ep, c, force, ctx.dt);
}

function readContacts(ctx: SimContext, st: DamageState): void {
  const { data } = ctx;
  const n = data.ncon as number;
  if (n === 0) return;
  // The vector and each element it hands out are heap copies (~0.7 KB per contact). An undeleted
  // element leaks for good and grows the WASM heap, which detaches every typed view taken before the
  // growth, so efc_force is read after the vector copy is made.
  const contacts = data.contact;
  try {
    const efc = data.efc_force as Float64Array;
    for (let i = 0; i < n; i++) {
      const c = contacts.get(i) as ContactView;
      try {
        trackContact(ctx, st, c, efc);
      } finally {
        c.delete();
      }
    }
  } finally {
    contacts.delete();
  }
}

/** One step of impact tracking. Call after mj_step. */
export function impactStep(ctx: SimContext, st: DamageState): void {
  readContacts(ctx, st);
  for (const [key, ep] of st.episodes) {
    if (ep.lastTick !== ctx.tick) {
      if (ep.active) finalize(ctx, st, ep);
      st.episodes.delete(key);
    } else if (ep.active && ((ctx.tick - ep.startTick + 1) * ctx.dt >= IMPACT_WINDOW_S || breaksNow(st, ep))) {
      finalize(ctx, st, ep);
    }
  }
}
