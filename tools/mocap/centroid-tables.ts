// Mass-aware centroid tables (docs/design/balance-engine.md §5.1): every strike move of a design's
// motion library run through MuJoCo with the robot's own masses and motors. Per 60 Hz frame:
//
//   com    the whole-body centre of mass in the move frame (x toward the opponent, y left), the
//          clip's root and joints as played (the actor's weight transfer, on the robot's heavy limbs)
//   dp     the centre of pressure the move implies beyond its COM at 1× speed,
//            Δp₁ = (−c̈x/ω₀² − L̇y/(mg),  −c̈y/ω₀² + L̇x/(mg))
//          (L about the COM), averaged over 1/ω₀ of the clip: the DCM integrates the COP over about
//          that long (ξ̇ = ω₀(ξ − p)), so a fast arm that throws the implied COP out and back inside it
//          (a jab's swing peaks near 0.5 m on the robot's heavy arms, then reverses) leaves little
//          error, while a sustained shift does not. Played at rate r the implied COP is com + r²·Δp₁:
//          the r_bal time warp plays a move no faster than r_bal = √(margin / |Δp₁|)
//   rLimb  the fastest rate the robot's real motors allow at that frame for the limbs the tracker
//          drives (both arms; for a kick also the kicking leg): for every joint, the inverse-dynamics
//          torque with the pelvis held, τ(r) = r²·A + G (A = M·q̈ + C(q̇) at 1×, G = gravity; mj_rne),
//          inside the torque-speed line τ ≤ κ·τ_stall·(1 − |ω|/ω_noload) while driving, κ·τ_stall
//          while braking, |ω| = r·|q̇| ≤ 0.98·ω_noload (κ = 0.85: the servo keeps some for feedback)
//   rTrunk the same for the waist at the clip's full trunk motion (the tracker plays a share of it)
//   Lpk    (per move) the largest horizontal angular momentum about the COM at 1×, N·m·s: what a
//          kick asks of the gyro's reserve
//
// Written to src/physics/control/mocap/centroid/<design>.json (the tracker reads it at load). Rebuild
// after a motion library or a design's masses or motors change; tests/balance/centroid.test.ts checks
// the tables against the library and the compiled robot.
//
//   npx tsx tools/mocap/centroid-tables.ts                 every design with a motion library
//   npx tsx tools/mocap/centroid-tables.ts savate pylon    some of them
//   npx tsx tools/mocap/centroid-tables.ts --report        also print each move's numbers
//   --motors 'savate.elbow=qdd.rs04,...' --out DIR          an actuator variant's tables (tools/motor-variants.ts),
//                                                           read back with SD_CENTROID_DIR=DIR
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIGNS } from '../../src/robots/designs';
import { newSample, parseLibrary, sample, type MotionLibrary } from '../../src/robots/motions';
import type { LibraryJson } from '../../src/robots/motions/types';
import { CENTROID_FORMAT, CENTROID_LABELS, KICK_LABELS, type CentroidJson, type CentroidMoveJson } from '../../src/physics/control/mocap/centroid';
import { makeSim } from '../../tests/control/helpers';
import { applyMotorVariants } from '../motor-variants';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(HERE, '..', '..', 'src', 'robots', 'motions', 'data');
const OUT_DIR = join(HERE, '..', '..', 'src', 'physics', 'control', 'mocap', 'centroid');
const G = 9.81;
const KAPPA = 0.85; // torque the inverse dynamics may use, × what the torque-speed line gives
const SPEED_CAP = 0.98; // × no-load speed
const R_MAX = 3; // fastest rate considered (× the human source)
const R_STEP = 0.01;
const DIFF_S = 1 / 240; // half-step for the sampled velocities' derivative

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Angular velocity in the body frame (MuJoCo's free-joint convention) from q(t−h) and q(t+h). */
function bodyOmega(qa: Quat, qb: Quat, h2: number): Vec3 {
  const inv: Quat = [qa[0], -qa[1], -qa[2], -qa[3]];
  let d = quatMul(inv, qb);
  if (d[0] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const s = Math.hypot(d[1], d[2], d[3]);
  const ang = 2 * Math.atan2(s, d[0]);
  if (s < 1e-12) return [0, 0, 0];
  const k = ang / s / h2;
  return [d[1] * k, d[2] * k, d[3] * k];
}

interface JointMotor { qadr: number; dadr: number; stall: number; noLoad: number }

/** Frames either side in the Savitzky-Golay derivative fits (quadratic, 2·SG_HALF + 1 frames). */
const SG_HALF = 4;

/**
 * Savitzky-Golay derivative (order 1 or 2, per frame step) of channel k of a series with `stride`
 * values per frame, at frame f, fitting a quadratic over the frames within SG_HALF (clipped at the ends).
 */
function sgDeriv(x: Float64Array, stride: number, k: number, f: number, n: number, order: 1 | 2): number {
  const h = Math.min(SG_HALF, f, n - 1 - f);
  if (h < 2) return 0;
  // Quadratic least squares on offsets −h..h: slope = Σ i·x_i / Σ i², curvature = Σ (i² − m)·x_i / Σ (i² − m)², m = mean i².
  let si2 = 0;
  for (let i = -h; i <= h; i++) si2 += i * i;
  const m2 = si2 / (2 * h + 1);
  let num = 0, den = 0;
  for (let i = -h; i <= h; i++) {
    const v = x[stride * (f + i) + k];
    if (order === 1) {
      num += i * v;
      den += i * i;
    } else {
      const c = i * i - m2;
      num += c * v;
      den += c * c;
    }
  }
  return order === 1 ? num / den : (2 * num) / den;
}

/** What bound a frame's rate: the joint, and whether its speed or its torque ran out first. */
interface Limit { r: number; joint: number; kind: 'speed' | 'torque' | 'none' }

/** The fastest rate at which every joint of `chain` stays on its torque-speed line at this frame. */
function maxRate(chain: number[], A: Float64Array, Gv: Float64Array, qd: Float64Array, mot: JointMotor[], out: Limit): number {
  let best = R_MAX;
  out.joint = -1;
  out.kind = 'none';
  for (const j of chain) {
    const m = mot[j];
    const a = A[m.dadr], g = Gv[m.dadr], v = qd[j];
    let r = best;
    let kind: Limit['kind'] = 'none';
    for (; r > 0.05; r -= R_STEP) {
      const w = r * v;
      if (Math.abs(w) > SPEED_CAP * m.noLoad) {
        kind = 'speed';
        continue;
      }
      const tau = r * r * a + g;
      const avail = tau * w > 0 ? m.stall * (1 - Math.abs(w) / m.noLoad) : m.stall;
      if (Math.abs(tau) <= KAPPA * avail) break;
      kind = 'torque';
    }
    r = Math.max(0.05, r);
    if (r < best) {
      best = r;
      out.joint = j;
      out.kind = kind;
    }
  }
  out.r = best;
  return best;
}

async function buildDesign(id: string, report: boolean): Promise<CentroidJson | null> {
  const path = join(LIB_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  const lib: MotionLibrary = parseLibrary(JSON.parse(readFileSync(path, 'utf8')) as LibraryJson);
  const design = DESIGNS[id];
  const sim = await makeSim({ design: id, x: 0, y: 0, yaw: 0 }, { design: id, x: 20, y: 0, yaw: Math.PI }, { systems: [] });
  const { ctx } = sim;
  const mj = ctx.mj, m = ctx.model, d = ctx.data;
  const r = ctx.robots[0];
  const nv = m.nv as number;
  const toRobot = lib.joints.map((n) => r.jointIndex.get(n) ?? -1);
  const mot: JointMotor[] = lib.joints.map((_, j) => {
    const i = toRobot[j];
    if (i < 0) return { qadr: -1, dadr: -1, stall: 1, noLoad: 1 };
    const jr = r.joints[i];
    return { qadr: jr.qadr, dadr: jr.dadr, stall: jr.motor.stallTorqueNm, noLoad: jr.motor.noLoadSpeedRadS };
  });
  const chainOf = (re: RegExp) => lib.joints.flatMap((n, j) => (re.test(n) && toRobot[j] >= 0 ? [j] : []));
  const arms = chainOf(/^(shoulder_|elbow_)/);
  const trunk = chainOf(/^waist_/);
  const legOf = (s: string) => chainOf(new RegExp(`^(hip_yaw|hip_roll|hip_pitch|knee|ankle_pitch)_${s}$`));
  const root = r.rootBody;
  const qpos = () => d.qpos as Float64Array;
  const qvel = () => d.qvel as Float64Array;
  const qacc = () => d.qacc as Float64Array;
  const res = new mj.DoubleBuffer(nv);
  const resG = new mj.DoubleBuffer(nv);
  const mass = m.body_subtreemass[root] as number;
  // Stance: the design's stance angles, the pelvis at its standing height: the COM height for ω₀.
  qpos().fill(0);
  qpos()[r.rootQadr + 2] = design.rootHeight;
  qpos()[r.rootQadr + 3] = 1;
  for (const j of r.joints) qpos()[j.qadr] = design.stance[j.name] ?? 0;
  mj.mj_kinematics(m, d);
  mj.mj_comPos(m, d);
  const zc = (d.subtree_com as Float64Array)[root * 3 + 2];
  const w0 = Math.sqrt(G / zc);
  const s = newSample(lib.joints.length), sa = newSample(lib.joints.length), sb = newSample(lib.joints.length);
  const qdd = new Float64Array(lib.joints.length);
  const moves: Record<string, CentroidMoveJson> = {};
  const rows: string[] = [];
  const tally = new Map<string, number>();
  for (const move of lib.moves) {
    if (!CENTROID_LABELS.includes(move.label)) continue;
    const kick = KICK_LABELS.includes(move.label);
    const limb = kick && move.side ? [...legOf(move.side), ...arms] : arms;
    const n = move.frames;
    const com = new Float64Array(2 * n), L = new Float64Array(3 * n);
    const rLimb = new Float64Array(n), rTrunk = new Float64Array(n);
    const lim: Limit = { r: 0, joint: -1, kind: 'none' }, limT: Limit = { r: 0, joint: -1, kind: 'none' };
    const limits: Limit[] = new Array(n), limitsT: Limit[] = new Array(n);
    for (let f = 0; f < n; f++) {
      const t = f / move.fps;
      sample(move, t, { speed: 1, loop: false }, s);
      const ta = Math.max(0, t - DIFF_S), tb = Math.min(move.duration, t + DIFF_S);
      sample(move, ta, { speed: 1, loop: false }, sa);
      sample(move, tb, { speed: 1, loop: false }, sb);
      for (let j = 0; j < lib.joints.length; j++) qdd[j] = tb > ta ? (sb.qd[j] - sa.qd[j]) / (tb - ta) : 0;
      // ---- inverse dynamics with the pelvis held upright at its standing height
      qpos().fill(0);
      qvel().fill(0);
      qacc().fill(0);
      qpos()[r.rootQadr + 2] = design.rootHeight;
      qpos()[r.rootQadr + 3] = 1;
      for (let j = 0; j < lib.joints.length; j++) if (mot[j].qadr >= 0) qpos()[mot[j].qadr] = s.q[j];
      mj.mj_kinematics(m, d);
      mj.mj_comPos(m, d);
      mj.mj_comVel(m, d);
      mj.mj_rne(m, d, 0, resG);
      for (let j = 0; j < lib.joints.length; j++) {
        if (mot[j].dadr < 0) continue;
        qvel()[mot[j].dadr] = s.qd[j];
        qacc()[mot[j].dadr] = qdd[j];
      }
      mj.mj_comVel(m, d);
      mj.mj_rne(m, d, 1, res);
      const full = res.GetView() as Float64Array, grav = resG.GetView() as Float64Array;
      const A = new Float64Array(nv);
      for (let k = 0; k < nv; k++) A[k] = full[k] - grav[k];
      rLimb[f] = maxRate(limb, A, grav, s.qd, mot, lim);
      limits[f] = { ...lim };
      rTrunk[f] = maxRate(trunk, A, grav, s.qd, mot, limT);
      limitsT[f] = { ...limT };
      // ---- the centroid: the clip as played, root and all
      qpos().fill(0);
      qvel().fill(0);
      qpos()[r.rootQadr] = s.rootPos[0];
      qpos()[r.rootQadr + 1] = s.rootPos[1];
      qpos()[r.rootQadr + 2] = s.rootPos[2];
      for (let k = 0; k < 4; k++) qpos()[r.rootQadr + 3 + k] = s.rootQuat[k];
      for (let j = 0; j < lib.joints.length; j++) {
        if (mot[j].qadr < 0) continue;
        qpos()[mot[j].qadr] = s.q[j];
        qvel()[mot[j].dadr] = s.qd[j];
      }
      qvel()[r.rootDadr] = s.rootVel[0];
      qvel()[r.rootDadr + 1] = s.rootVel[1];
      qvel()[r.rootDadr + 2] = s.rootVel[2];
      const om = bodyOmega(sa.rootQuat as Quat, sb.rootQuat as Quat, tb - ta);
      qvel()[r.rootDadr + 3] = om[0];
      qvel()[r.rootDadr + 4] = om[1];
      qvel()[r.rootDadr + 5] = om[2];
      mj.mj_kinematics(m, d);
      mj.mj_comPos(m, d);
      mj.mj_comVel(m, d);
      mj.mj_subtreeVel(m, d);
      const sc = d.subtree_com as Float64Array, am = d.subtree_angmom as Float64Array;
      com[2 * f] = sc[root * 3];
      com[2 * f + 1] = sc[root * 3 + 1];
      L[3 * f] = am[root * 3];
      L[3 * f + 1] = am[root * 3 + 1];
      L[3 * f + 2] = am[root * 3 + 2];
    }
    // Derivatives of the 60 Hz series by Savitzky-Golay fits over SG_HALF frames either side (a
    // second difference of mocap at 60 Hz turns millimetres of jitter into metres of COP; the soles
    // answer at the pendulum's pace, 1/ω₀ ≈ 0.3 s, not to single frames).
    const fps = move.fps;
    const raw = new Float64Array(2 * n);
    for (let f = 0; f < n; f++) {
      const ax = sgDeriv(com, 2, 0, f, n, 2) * fps * fps, ay = sgDeriv(com, 2, 1, f, n, 2) * fps * fps;
      const Lx = sgDeriv(L, 3, 0, f, n, 1) * fps, Ly = sgDeriv(L, 3, 1, f, n, 1) * fps;
      raw[2 * f] = -ax / (w0 * w0) - Ly / (mass * G);
      raw[2 * f + 1] = -ay / (w0 * w0) + Lx / (mass * G);
    }
    const half = Math.max(1, Math.round(fps / w0 / 2));
    const dp = new Float64Array(2 * n);
    for (let f = 0; f < n; f++) {
      for (let k = 0; k < 2; k++) {
        let sum = 0;
        for (let q = f - half; q <= f + half; q++) sum += q >= 0 && q < n ? raw[2 * q + k] : 0;
        dp[2 * f + k] = sum / (2 * half + 1);
      }
    }
    let Lpk = 0;
    for (let f = 0; f < n; f++) Lpk = Math.max(Lpk, Math.hypot(L[3 * f], L[3 * f + 1]));
    moves[move.id] = {
      label: move.label,
      n,
      com: Array.from(com, (x) => Math.round(x * 1000)),
      dp: Array.from(dp, (x) => Math.round(x * 1000)),
      rLimb: Array.from(rLimb, (x) => Math.round(x * 100)),
      rTrunk: Array.from(rTrunk, (x) => Math.round(x * 100)),
      Lpk: Math.round(Lpk * 10) / 10,
    };
    if (report) {
      const imp = move.impact ?? move.reach ?? move.phases.recover;
      const win = (arr: Float64Array) => {
        let lo = Infinity;
        for (let f = Math.max(0, Math.floor((move.phases.strike - 0.15) * fps)); f <= Math.min(n - 1, Math.ceil(imp * fps)); f++) lo = Math.min(lo, arr[f]);
        return lo;
      };
      const who = (arr: Float64Array, ls: Limit[]) => {
        let lo = Infinity, at = -1;
        for (let f = Math.max(0, Math.floor((move.phases.strike - 0.15) * fps)); f <= Math.min(n - 1, Math.ceil(imp * fps)); f++) if (arr[f] < lo) { lo = arr[f]; at = f; }
        const l = at >= 0 ? ls[at] : null;
        const name = l && l.joint >= 0 ? lib.joints[l.joint] : '-';
        tally.set(`${move.label} ${name} ${l?.kind ?? '-'}`, (tally.get(`${move.label} ${name} ${l?.kind ?? '-'}`) ?? 0) + 1);
        return `${name}/${l?.kind ?? '-'}`;
      };
      let dpk = 0;
      for (let f = 0; f < n; f++) dpk = Math.max(dpk, Math.hypot(dp[2 * f], dp[2 * f + 1]));
      const exc = Math.hypot(com[2 * (n - 1)] - com[0], com[2 * (n - 1) + 1] - com[1]);
      rows.push(`  ${move.id.padEnd(30)} rLimb ${win(rLimb).toFixed(2)} (${who(rLimb, limits)}) rTrunk ${win(rTrunk).toFixed(2)} (${who(rTrunk, limitsT)}) |Δp₁| peak ${(dpk * 100).toFixed(1)} cm, COM travel ${(exc * 100).toFixed(1)} cm, L peak ${Lpk.toFixed(1)} N·m·s`);
    }
  }
  res.delete();
  resG.delete();
  sim.dispose();
  if (report) {
    console.log(`${id}: m ${mass.toFixed(1)} kg, z_c ${zc.toFixed(3)} m, ω₀ ${w0.toFixed(2)}\n${rows.join('\n')}`);
    console.log(`  what binds the rate (slowest frame of each move's windup → impact): ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join('; ')}`);
  }
  return { format: CENTROID_FORMAT, design: id, massKg: Math.round(mass * 100) / 100, zc: Math.round(zc * 1000) / 1000, omega0: Math.round(w0 * 1000) / 1000, fps: lib.fps, moves };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const report = process.argv.includes('--report');
  const motors = flag('motors');
  const outDir = flag('out') ?? OUT_DIR;
  const skip = new Set([motors, flag('out')].filter(Boolean));
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--') && !skip.has(a));
  applyMotorVariants(motors);
  const designs = ids.length ? ids : Object.keys(DESIGNS);
  mkdirSync(outDir, { recursive: true });
  for (const id of designs) {
    const t0 = performance.now();
    const table = await buildDesign(id, report);
    if (!table) {
      console.log(`${id}: no motion library, skipped`);
      continue;
    }
    const file = join(outDir, `${id}.json`);
    writeFileSync(file, JSON.stringify(table));
    console.log(`${id}: ${Object.keys(table.moves).length} moves → ${file} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
