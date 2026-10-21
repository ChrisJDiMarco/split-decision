// Joint loads (docs/design/strike-power.md §4.3). On ticks when a strike has armed a load path, three
// channels per joint, each filtered over DAMAGE_TUNING.loadFilterS and taken against the drive's own
// ratings (catalog drive trains, src/physics/damage/durability.ts):
//   gear     tooth torque τ_g = (I·τ_act − J·τ_ext) / (I + J): the motor's torque less what the rotor's
//            reflected inertia J soaks while a hit backdrives it (one-dof estimate on the link
//            inertia I, with the catalog's J so the simulator's armature does not decide it; a cylinder
//            carries all of τ_ext). Against the gear's shock rating: a high-ratio planetary (J ∝ N²)
//            takes far more of a hit through its teeth than a QDD.
//   stop     the joint-limit constraint force: a straight shot into a locked elbow, a kick to the front
//            of a straight knee. Against DAMAGE_TUNING.stopRatingStall × stall.
//   bearing  the wrench through the joint (cfrc_int, one mj_rnePostConstraint per armed tick) about its
//            anchor: the moment off its own axis, the radial and the axial force. Against the output
//            bearing's ratings: a hook to the side of the elbow, a low kick to the side of the knee.
// When the arm window closes, the episode's filtered peaks decide, deterministically by channel and
// gear type: wear between onset and break; at break a planetary jams (or strips), a QDD sheds a tooth
// and slips, a cylinder seal blows, a stop gives way, a shaft bends and binds.
// The drive state this leaves (a slip cap, a fault, a bend) is applied every step in drivePre, after
// the motor model has set its limits.
import type { Vec3 } from '../../core/types';
import type { SimContext } from '../sim-context';
import { DAMAGE_TUNING, MAX_SLOP_RAD } from './constants';
import { rigidDrive } from './durability';
import { FILTER_TAPS, type ArmContext, type DamageState, type JointMech, type PartInfo, type RobotDamage } from './state';
import { injureJoint, makeLimp, seizeJoint, type Injury } from './wear';

const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Signed generalized force of each joint-limit row this tick, by model joint id (+ pushes q up).
 * MuJoCo lays the constraint rows out as equality, friction, limits, contacts: the limit rows are
 * [ne + nf, ne + nf + nl).
 */
function limitForces(ctx: SimContext, M: ModelViews, out: Map<number, number>): void {
  out.clear();
  const { data } = ctx;
  const nl = data.nl as number;
  if (!nl) return;
  const r0 = (data.ne as number) + (data.nf as number);
  const type = data.efc_type as Int32Array;
  const id = data.efc_id as Int32Array;
  const force = data.efc_force as Float64Array;
  const LIMIT = ctx.mj.mjtConstraint.mjCNSTR_LIMIT_JOINT.value as number;
  const range = M.jntRange;
  const qpos = ctx.data.qpos as Float64Array;
  const qadr = M.qposAdr;
  for (let r = r0; r < r0 + nl; r++) {
    if (type[r] !== LIMIT) continue;
    const j = id[r];
    const q = qpos[qadr[j]];
    const lower = q - range[j * 2] < range[j * 2 + 1] - q; // nearer the lower limit: the row pushes q up
    out.set(j, (out.get(j) ?? 0) + (lower ? force[r] : -force[r]));
  }
}

const limits = new Map<number, number>();

/** Constant model arrays, read once per model (re-read if WASM heap growth detached them). */
interface ModelViews {
  Mrow: Int32Array;
  Mnnz: Int32Array;
  armature: Float64Array;
  rootOf: Int32Array;
  jntRange: Float64Array;
  qposAdr: Int32Array;
}

const modelViews = new WeakMap<object, ModelViews>();

function modelViewsOf(ctx: SimContext): ModelViews {
  let v = modelViews.get(ctx.model);
  if (!v || v.Mrow.byteLength === 0 || v.jntRange.byteLength === 0) {
    const m = ctx.model;
    v = { Mrow: m.M_rowadr, Mnnz: m.M_rownnz, armature: m.dof_armature, rootOf: m.body_rootid, jntRange: m.jnt_range, qposAdr: m.jnt_qposadr };
    modelViews.set(ctx.model, v);
  }
  return v;
}

/**
 * Typed views of mjData's fixed fields (their addresses never move; only WASM heap growth detaches the
 * views, which then read byteLength 0). Every property read on the MuJoCo wrappers builds a fresh view
 * (~0.4 µs each), so they are kept per data object and rebuilt only after a detach. The constraint
 * (efc_*) arrays live in the per-step arena and are read fresh.
 */
interface Views extends ModelViews {
  qfrcAct: Float64Array;
  qfrcSmooth: Float64Array;
  qfrcCon: Float64Array;
  M: Float64Array;
  cfrc: Float64Array;
  subtreeCom: Float64Array;
  xanchor: Float64Array;
  xaxis: Float64Array;
}

const dataViews = new WeakMap<object, Views>();

function views(ctx: SimContext, mv: ModelViews): Views {
  let v = dataViews.get(ctx.data);
  if (!v || v.qfrcAct.byteLength === 0 || v.Mrow !== mv.Mrow) {
    const { data } = ctx;
    v = {
      ...mv,
      qfrcAct: data.qfrc_actuator, qfrcSmooth: data.qfrc_smooth, qfrcCon: data.qfrc_constraint,
      M: data.M, cfrc: data.cfrc_int, subtreeCom: data.subtree_com, xanchor: data.xanchor, xaxis: data.xaxis,
    };
    dataViews.set(ctx.data, v);
  }
  return v;
}

/** Samples the three channels for one armed joint and folds them into its episode peaks. */
function sample(V: Views, rd: RobotDamage, i: number, m: JointMech): void {
  const j = rd.robot.joints[i];
  const d = j.dadr;
  const drive = m.drive;
  // ---- gear: tooth torque
  const tauAct = V.qfrcAct[d];
  const limitGen = limits.get(m.mjJoint) ?? 0;
  const tauExt = V.qfrcSmooth[d] + V.qfrcCon[d] - tauAct - limitGen;
  let tooth: number;
  if (rigidDrive(drive)) tooth = -tauExt;
  else {
    const adr = V.Mrow[d] + V.Mnnz[d] - 1;
    const I = Math.max(1e-5, V.M[adr] - V.armature[d]);
    const J = drive.reflectedKgM2;
    tooth = (I * tauAct - J * tauExt) / (I + J);
  }
  const gear = Math.abs(tooth) / drive.gearShockNm;
  // ---- stop: joint-limit force, against the stop's rating (the housing's, at least 2× the drive)
  const k0 = DAMAGE_TUNING.bearingStaticFactor;
  const stopRating = Math.max(DAMAGE_TUNING.stopRatingStall * drive.stallNm, k0 * m.bearingMomentNm);
  const stop = Math.abs(limitGen) / stopRating;
  // ---- bearing: the wrench through the joint, about its anchor
  const cf = V.cfrc;
  const sc = V.subtreeCom;
  const xa = V.xanchor;
  const ax = V.xaxis;
  const b = m.bodyId;
  const root = V.rootOf[b];
  const t: Vec3 = [cf[b * 6], cf[b * 6 + 1], cf[b * 6 + 2]];
  const f: Vec3 = [cf[b * 6 + 3], cf[b * 6 + 4], cf[b * 6 + 5]];
  const k = m.mjJoint * 3;
  const r: Vec3 = [sc[root * 3] - xa[k], sc[root * 3 + 1] - xa[k + 1], sc[root * 3 + 2] - xa[k + 2]];
  const mp: Vec3 = [t[0] + r[1] * f[2] - r[2] * f[1], t[1] + r[2] * f[0] - r[0] * f[2], t[2] + r[0] * f[1] - r[1] * f[0]];
  const a: Vec3 = [ax[k], ax[k + 1], ax[k + 2]];
  const ma = mp[0] * a[0] + mp[1] * a[1] + mp[2] * a[2];
  const mperp: Vec3 = [mp[0] - ma * a[0], mp[1] - ma * a[1], mp[2] - ma * a[2]];
  const fa = f[0] * a[0] + f[1] * a[1] + f[2] * a[2];
  const fr = Math.hypot(f[0] - fa * a[0], f[1] - fa * a[1], f[2] - fa * a[2]);
  const mOff = Math.hypot(mperp[0], mperp[1], mperp[2]);
  const bearing = Math.max(mOff / m.bearingMomentNm, fr / drive.bearingRadialN, Math.abs(fa) / drive.bearingAxialN) / k0;
  const cap = DAMAGE_TUNING.maxLoadRatio;
  if (!(gear < cap && stop < cap && bearing < cap)) return; // NaN, or a solver crush: not a load
  // ---- filter (moving average over FILTER_TAPS armed ticks) and peaks
  const slot = (m.ringN % FILTER_TAPS) * 3;
  m.ring[slot] = gear;
  m.ring[slot + 1] = stop;
  m.ring[slot + 2] = bearing;
  m.ringN++;
  const nTaps = Math.min(m.ringN, FILTER_TAPS);
  let g = 0, s = 0, br = 0;
  for (let q = 0; q < nTaps; q++) {
    g += m.ring[q * 3];
    s += m.ring[q * 3 + 1];
    br += m.ring[q * 3 + 2];
  }
  // Filtered over the full window: a single-tick spike counts for a third of itself.
  g /= FILTER_TAPS;
  s /= FILTER_TAPS;
  br /= FILTER_TAPS;
  if (g > m.peak[0]) m.peak[0] = g;
  if (s > m.peak[1]) {
    m.peak[1] = s;
    m.stopSide = limitGen < 0 ? 1 : -1; // pushed back down off the upper limit
  }
  if (br > m.peak[2]) {
    m.peak[2] = br;
    m.bendAxisW = mOff > 1e-9 ? [mperp[0] / mOff, mperp[1] / mOff, mperp[2] / mOff] : null;
  }
}

function startEpisode(m: JointMech, info: PartInfo): void {
  m.inEpisode = true;
  m.ring.fill(0);
  m.ringN = 0;
  m.peak = [0, 0, 0];
  m.stopSide = 0;
  m.bendAxisW = null;
  m.arm = info.arm;
  m.role = info.arm?.role ?? 'none';
}

/**
 * One step of the joint-load channels. Samples every joint on an armed load path (one
 * mj_rnePostConstraint when anything is armed), and resolves each joint's episode when its arm
 * window closes.
 */
export function jointLoadStep(ctx: SimContext, st: DamageState): void {
  const tick = ctx.tick;
  let armed = false;
  for (const rd of st.robots) {
    for (const info of rd.parts.values()) if (info.armedUntil >= tick) { armed = true; break; }
    if (armed) break;
  }
  let V: Views | null = null;
  if (armed) {
    ctx.mj.mj_rnePostConstraint(ctx.model, ctx.data);
    const mv = modelViewsOf(ctx);
    limitForces(ctx, mv, limits);
    V = views(ctx, mv);
  }
  for (const rd of st.robots) {
    for (const info of rd.parts.values()) {
      const on = info.armedUntil >= tick && info.part.attached;
      let closing = false;
      for (const i of info.jointIdx) {
        const m = rd.mech[i];
        if (on) {
          if (!m.inEpisode) startEpisode(m, info);
          if (info.arm && (info.arm.role === 'victim' || m.role !== 'victim')) {
            m.arm = info.arm;
            m.role = info.arm.role;
          }
          if (V && rd.robot.joints[i].state !== 'limp') sample(V, rd, i, m);
        } else if (m.inEpisode) closing = true;
      }
      if (closing) resolvePart(ctx, st, rd, info);
      if (!on && info.arm && info.armedUntil < tick) info.arm = null;
    }
  }
}

/**
 * Closes the episodes of a part's joints together. Joints of one body (a 3-axis shoulder or hip, a
 * 2-axis waist or ankle) share one load path:
 *   bearing   every joint of the body reads the same wrench through it, so it is one load, booked
 *             once, on the joint it overloaded most (its weakest bearing); the others are relieved.
 *             Before this a 3-axis shoulder or hip booked one blow's wear three times.
 *   gear, stop  each axis has its own gear train and stop and carries its own torque: when several
 *             would break on the same channel, the most overloaded one gives way and that relieves
 *             the rest, which keep only their wear.
 */
function resolvePart(ctx: SimContext, st: DamageState, rd: RobotDamage, info: PartInfo): void {
  const t = DAMAGE_TUNING;
  const breaks = [t.gearBreak, t.stopBreak, t.bearingBreak];
  const closing = info.jointIdx.filter((i) => rd.mech[i].inEpisode);
  if (closing.length > 1) {
    let worst = closing[0];
    for (const i of closing) if (rd.mech[i].peak[2] > rd.mech[worst].peak[2]) worst = i;
    for (const i of closing) if (i !== worst) rd.mech[i].peak[2] = 0;
  }
  for (let ch = 0; ch < 2; ch++) {
    let worst = -1;
    for (const i of closing) if (rd.mech[i].peak[ch] >= breaks[ch] && (worst < 0 || rd.mech[i].peak[ch] > rd.mech[worst].peak[ch])) worst = i;
    if (worst < 0) continue;
    for (const i of closing) if (i !== worst && rd.mech[i].peak[ch] >= breaks[ch]) rd.mech[i].peak[ch] = breaks[ch] * 0.999;
  }
  for (const i of closing) {
    rd.mech[i].inEpisode = false;
    resolve(ctx, st, rd, i, rd.mech[i]);
  }
}

// ---------------------------------------------------------------- resolution

function injury(m: JointMech, cause: Injury['cause'], failure: Injury['failure'], severity: number, bendAxis?: Vec3): Injury {
  return { cause, failure, severity, role: m.role, arm: m.arm, bendAxis };
}

function wearLoss(r: number, onset: number, brk: number): number {
  return DAMAGE_TUNING.wearAtBreak * clamp((r - onset) / Math.max(1e-6, brk - onset), 0, 1);
}

/**
 * Decides a joint's load episode from its filtered peaks: wear or failure per channel, by gear type.
 * Deterministic. Exported for tests (they set m.peak directly).
 */
export function resolveJointEpisode(ctx: SimContext, st: DamageState, rd: RobotDamage, i: number): void {
  resolve(ctx, st, rd, i, rd.mech[i]);
}

function resolve(ctx: SimContext, st: DamageState, rd: RobotDamage, i: number, m: JointMech): void {
  const t = DAMAGE_TUNING;
  const [gear, stop, bearing] = m.peak;
  const L = rd.ledger.overloads;
  const book = (k: 'gear' | 'stop' | 'bearing', r: number, onset: number, brk: number) => {
    L[k].peak = Math.max(L[k].peak, r);
    if (r >= onset) L[k].onset++;
    if (r >= brk) L[k].broke++;
  };
  book('gear', gear, t.gearOnset, t.gearBreak);
  book('stop', stop, t.stopOnset, t.stopBreak);
  book('bearing', bearing, t.bearingOnset, t.bearingBreak);
  const robot = rd.robot;
  // Hyperextension first: an overrun stop also takes the load off the gear.
  if (stop >= t.stopBreak) hyperextend(ctx, st, rd, i, m, stop / t.stopBreak);
  else if (stop >= t.stopOnset) injureJoint(ctx, st, robot, i, wearLoss(stop, t.stopOnset, t.stopBreak), injury(m, 'hyperextension', 'wear', stop));
  if (gear >= t.gearBreak) gearFailure(ctx, st, rd, i, m, gear);
  else if (gear >= t.gearOnset) injureJoint(ctx, st, robot, i, wearLoss(gear, t.gearOnset, t.gearBreak), injury(m, 'gear', 'wear', gear));
  if (bearing >= t.bearingBreak) bend(ctx, st, rd, i, m, bearing);
  else if (bearing >= t.bearingOnset) injureJoint(ctx, st, robot, i, wearLoss(bearing, t.bearingOnset, t.bearingBreak), injury(m, 'bearing', 'wear', bearing));
}

/** The gear train failed: what that means depends on what kind of gear train it is. */
function gearFailure(ctx: SimContext, st: DamageState, rd: RobotDamage, i: number, m: JointMech, r: number): void {
  const t = DAMAGE_TUNING;
  const robot = rd.robot;
  const stall = m.drive.stallNm;
  switch (m.drive.gearType) {
    case 'planetary':
    case 'cycloidal':
      // A high-ratio train can't backdrive out of it: the teeth jam (seize, it locks where it is), or
      // on a big enough shock they shear and the output spins free.
      if (r >= t.gearStrip) makeLimp(ctx, robot, i, st, injury(m, 'gear', 'strip', r));
      else seizeJoint(ctx, st, robot, i, t.failLoss.seize, injury(m, 'gear', 'seize', r));
      return;
    case 'qdd': {
      // A single-stage QDD sheds a tooth: from now on it slips (clunks) above a torque cap, and each
      // further tooth cuts the cap again (a shock past the strip level sheds two).
      const cuts = r >= t.gearStrip ? 2 : 1;
      let cap = m.slipCapNm ?? (t.slipCapFraction / t.slipCapCut) * stall;
      for (let k = 0; k < cuts; k++) cap *= t.slipCapCut;
      m.slipCapNm = cap;
      m.teeth += cuts;
      if (cap < t.slipStripBelow * stall) makeLimp(ctx, robot, i, st, injury(m, 'gear', 'strip', r));
      else injureJoint(ctx, st, robot, i, t.failLoss.slip, injury(m, 'gear', 'slip', r));
      return;
    }
    case 'hydraulic': {
      // No teeth: the cylinder's seals blow. On a circuit the line leaks (the pressure model takes it
      // from there: the part nearest the joint on that circuit is punctured); with no circuit it dies.
      const circuit = robot.joints[i].hydraulicCircuit;
      const own = rd.parts.get(robot.joints[i].part);
      const onCircuit = (p: PartInfo | undefined) => !!p && p.circuits.some((c) => c.id === circuit);
      const parent = own?.def.parent ? rd.parts.get(own.def.parent) : undefined;
      const host = !circuit ? undefined : onCircuit(own) ? own : onCircuit(parent) ? parent : [...rd.parts.values()].find((p) => onCircuit(p) && p.part.attached);
      if (host) {
        host.punctured = true;
        injureJoint(ctx, st, robot, i, t.failLoss.seal, injury(m, 'gear', 'seal', r));
      } else makeLimp(ctx, robot, i, st, injury(m, 'gear', 'seal', r));
      return;
    }
    case 'pneumatic':
      makeLimp(ctx, robot, i, st, injury(m, 'gear', 'seal', r));
      return;
    case 'direct':
      injureJoint(ctx, st, robot, i, t.wearAtBreak, injury(m, 'gear', 'wear', r));
      return;
  }
}

/** The end stop gave way: the joint now goes past where it used to stop. */
function hyperextend(ctx: SimContext, st: DamageState, rd: RobotDamage, i: number, m: JointMech, severity: number): void {
  const t = DAMAGE_TUNING;
  const sev = Math.min(1.5, severity);
  const give = t.hyperextensionDeg * sev * DEG;
  const range = ctx.model.jnt_range as Float64Array;
  if (m.stopSide > 0) range[m.mjJoint * 2 + 1] += give;
  else range[m.mjJoint * 2] -= give;
  m.hyperRad += give;
  injureJoint(ctx, st, rd.robot, i, t.failLoss.hyperextension * sev, injury(m, 'hyperextension', 'hyperextension', severity));
}

/** The output shaft bent: it binds (friction up, range down), and a single-hinge limb is visibly kinked. */
function bend(ctx: SimContext, st: DamageState, rd: RobotDamage, i: number, m: JointMech, r: number): void {
  const t = DAMAGE_TUNING;
  const { model } = ctx;
  const j = rd.robot.joints[i];
  const sev = r - t.bearingBreak + 1;
  // Bind: dry friction up, range down toward where the joint is (never past it).
  (model.dof_frictionloss as Float64Array)[j.dadr] += t.bindFrictionStall * m.drive.stallNm * sev;
  const range = model.jnt_range as Float64Array;
  const q = (ctx.data.qpos as Float64Array)[j.qadr];
  const shrink = t.bindRangeDeg * sev * DEG;
  const lo = range[m.mjJoint * 2], hi = range[m.mjJoint * 2 + 1];
  const mid = (lo + hi) / 2;
  range[m.mjJoint * 2] = Math.max(lo, Math.min(lo + shrink, q - 0.02, mid - 0.05));
  range[m.mjJoint * 2 + 1] = Math.min(hi, Math.max(hi - shrink, q + 0.02, mid + 0.05));
  // Permanent bend, about the axis the off-axis moment bent it. A body with one hinge (forearm, shin,
  // head) shows it: its quaternion turns in the parent's frame (drivePre ramps it in). A multi-axis
  // body (shoulder, hip, waist) just binds. A shaft that bends again bends further about the same axis.
  const axisW = m.bendAxisW;
  const room = t.maxBendDeg * DEG - m.bendRad;
  if (room > 0 && axisW) {
    if (m.singleHinge && !m.bendAxisP) {
      const parent = (model.body_parentid as Int32Array)[m.bodyId];
      const R = ctx.data.xmat as Float64Array;
      const o = parent * 9;
      m.bendAxisP = [
        R[o] * axisW[0] + R[o + 3] * axisW[1] + R[o + 6] * axisW[2],
        R[o + 1] * axisW[0] + R[o + 4] * axisW[1] + R[o + 7] * axisW[2],
        R[o + 2] * axisW[0] + R[o + 5] * axisW[1] + R[o + 8] * axisW[2],
      ];
    }
    m.bendRad += Math.min(room, t.bendDegPerUnit * sev * DEG);
  }
  injureJoint(ctx, st, rd.robot, i, t.failLoss.bend, injury(m, 'bearing', 'bend', r, axisW ?? undefined));
}

/** A hard hit on a drive's housing: encoder and drive fault out for a moment, then re-enable. */
export function faultDrive(ctx: SimContext, st: DamageState, rd: RobotDamage, i: number, severity: number, arm: ArmContext): void {
  const t = DAMAGE_TUNING;
  const m = rd.mech[i];
  const j = rd.robot.joints[i];
  if (j.state === 'limp' || j.state === 'seized') return;
  const s = clamp((severity - 1) / 2, 0, 1);
  const holdS = t.faultMinS + (t.faultMaxS - t.faultMinS) * s;
  m.faultUntil = Math.max(m.faultUntil, ctx.tick + Math.round(holdS / ctx.dt));
  m.faults++;
  m.encoderSlop = Math.min(MAX_SLOP_RAD, m.encoderSlop + t.faultSlopRad);
  const inj: Injury = { cause: 'housing', failure: 'fault', severity, role: arm.role, arm };
  injureJoint(ctx, st, rd.robot, i, Math.min(0.1, t.failLoss.fault * severity), inj);
}

// ---------------------------------------------------------------- applying drive damage each step

/**
 * Runs after the motor model (damageSystem.pre comes after motorSystem.pre): a faulted drive gives
 * no torque and no stiffness until it re-enables; a slipping QDD gives at most its cap; a bend
 * ramps into the body's quaternion over DAMAGE_TUNING.bendRampS.
 */
export function drivePre(ctx: SimContext, st: DamageState): void {
  const { model } = ctx;
  const forcerange = model.actuator_forcerange as Float64Array;
  const gainprm = model.actuator_gainprm as Float64Array;
  const biasprm = model.actuator_biasprm as Float64Array;
  const t = DAMAGE_TUNING;
  for (const rd of st.robots) {
    const joints = rd.robot.joints;
    for (let i = 0; i < joints.length; i++) {
      const m = rd.mech[i];
      const j = joints[i];
      if (m.bendApplied < m.bendRad) rampBend(ctx, m, (ctx.dt / t.bendRampS) * t.maxBendDeg * DEG);
      if (j.state === 'limp' || j.state === 'seized') continue;
      if (m.faultUntil >= ctx.tick) {
        const drag = 0.02 * j.motor.stallTorqueNm; // a dead drive still has its gearbox drag
        forcerange[j.act * 2] = -drag;
        forcerange[j.act * 2 + 1] = drag;
        gainprm[j.act * 10] = 0;
        biasprm[j.act * 10 + 1] = 0;
        biasprm[j.act * 10 + 2] = -j.kd * 0.15;
        j.availableTorque = drag;
      } else if (m.slipCapNm !== null && j.availableTorque > m.slipCapNm) {
        forcerange[j.act * 2] = -m.slipCapNm;
        forcerange[j.act * 2 + 1] = m.slipCapNm;
        j.availableTorque = m.slipCapNm;
      }
    }
  }
}

function rampBend(ctx: SimContext, m: JointMech, step: number): void {
  const axis = m.bendAxisP;
  if (!axis) {
    m.bendApplied = m.bendRad;
    return;
  }
  m.bendApplied = Math.min(m.bendRad, m.bendApplied + step);
  const h = m.bendApplied / 2;
  const s = Math.sin(h);
  // q_body = q_bend ⊗ q_base: the bend turns the body in its parent's frame, about its own origin (the joint).
  const bw = Math.cos(h), bx = axis[0] * s, by = axis[1] * s, bz = axis[2] * s;
  const [w, x, y, z] = m.baseQuat;
  const bq = ctx.model.body_quat as Float64Array;
  const o = m.bodyId * 4;
  bq[o] = bw * w - bx * x - by * y - bz * z;
  bq[o + 1] = bw * x + bx * w + by * z - bz * y;
  bq[o + 2] = bw * y - bx * z + by * w + bz * x;
  bq[o + 3] = bw * z + bx * y - by * x + bz * w;
}

/** Share of the motor's peak torque a joint can still give after damage (telemetry torqueFraction). */
export function torqueFraction(ctx: SimContext, rd: RobotDamage, i: number): number {
  const j = rd.robot.joints[i];
  const m = rd.mech[i];
  if (j.state === 'limp' || m.faultUntil >= ctx.tick) return 0;
  const health = 0.25 + 0.75 * j.health; // the motor model's health factor (motors.ts)
  const cap = m.slipCapNm === null ? 1 : m.slipCapNm / j.motor.stallTorqueNm;
  return Math.max(0, Math.min(1, health, cap));
}
