// The polish rollout world (docs/design/move-polish.md §3.1): one robot from compileRobot(design) on
// the game's canvas with the game's <option> block (src/physics/world.ts, checked by tests/polish), the
// game's real motor model (motorSystem.pre: torque-speed line, braking quadrant, heat, health,
// backlash, battery) and the real GyroCore. Nothing else touches the body: no xfrc but the gyro couple,
// no qfrc_applied, no welds after release, no mass or timestep changes.
//   full = true  the acceptance world: compileWorld() (cage + both robots), the opponent parked on
//                its gantry at its spawn spot, motors running for both
import loadMujoco from '@mujoco/mujoco';
import type { MatchSetup } from '../../src/core/types';
import { GyroCore } from '../../src/physics/control/gyro';
import { buildContext } from '../../src/physics/runtime';
import type { JointRuntime, RobotRuntime, SimContext } from '../../src/physics/sim-context';
import { motorSystem } from '../../src/physics/systems/motors';
import { compileWorld, type CompiledWorld } from '../../src/physics/world';
import { COLLIDE } from '../../src/robots/compile-mjcf';
import { design } from '../../src/robots/designs';
import { parseLibrary, type MotionLibrary } from '../../src/robots/motions';
import type { LibraryJson } from '../../src/robots/motions/types';
import { CANVAS_CONTACT, PHYSICS_OPTION, polishRobot } from '../../src/robots/motions/polish/hash';
import { newBodySense, playerJoints, type BodySense, type PlayerJoint } from '../../src/robots/motions/polish/player';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mj = any;

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const LIB_DIR = join(ROOT, 'src', 'robots', 'motions', 'data');

let mjPromise: Promise<Mj> | null = null;
export const mujoco = (): Promise<Mj> => (mjPromise ??= (loadMujoco as unknown as () => Promise<Mj>)());

const libs = new Map<string, MotionLibrary>();
export function library(designId: string): MotionLibrary {
  let lib = libs.get(designId);
  if (!lib) {
    lib = parseLibrary(JSON.parse(readFileSync(join(LIB_DIR, `${designId}.json`), 'utf8')) as LibraryJson);
    libs.set(designId, lib);
  }
  return lib;
}

/** The one-robot rollout MJCF: the game's option block and canvas, robot 0, its debris and welds. */
export function rolloutXml(designId: string): { xml: string; compiled: ReturnType<typeof polishRobot> } {
  const r0 = polishRobot(designId);
  const worldAff = COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;
  const xml = `<mujoco model="polish">
  <compiler angle="degree" autolimits="true"/>
  ${PHYSICS_OPTION}
    <flag energy="disable"/>
  </option>
  <size memory="64M"/>
  <worldbody>
    <geom name="canvas" type="plane" size="30 30 0.1" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" ${CANVAS_CONTACT}/>
${r0.bodyXml}
${r0.debrisXml}
  </worldbody>
  <equality>
    ${r0.equalityXml}
  </equality>
  <actuator>
    ${r0.actuatorXml}
  </actuator>
</mujoco>`;
  return { xml, compiled: r0 };
}

/** mulberry32 with its state in the open, so a snapshot can hold it (the game's rng is a closure). */
export class Rng {
  constructor(public s: number) {
    this.s = s >>> 0;
  }
  readonly next = (): number => {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PolishWorld {
  mj: Mj;
  ctx: SimContext;
  r: RobotRuntime;
  lib: MotionLibrary;
  designId: string;
  full: boolean;
  joints: PlayerJoint[];
  gyro: GyroCore | null;
  rng: Rng;
  sense: BodySense;
  ids: { root: number; pelvis: number; torso: number; head: number; foot: [number, number]; footGeom: [number, number]; fist: [number, number]; shin: [number, number]; jnt: Int32Array };
  /** Geoms of robot 0 that may not touch the canvas outside get-ups, by part. */
  geomPart: Map<number, string>;
  robotGeoms: number[];
  footHalf: [number, number, number];
  mass: number;
  stateSpec: number;
  stateSize: number;
  stateBuf: any; // DoubleBuffer
  /** Standing pelvis height of the design (stance pose). */
  stancePelvisZ: number;
  /** The compiled actuator parameters (the motor model rewrites them every step; a fresh start restores them). */
  pristine: { forcerange: Float64Array; gainprm: Float64Array; biasprm: Float64Array };
}

export async function makeWorld(designId: string, full = false): Promise<PolishWorld> {
  const mj = await mujoco();
  const d = design(designId);
  let world: CompiledWorld;
  const setup: MatchSetup = {
    fighters: [
      { design: designId, skin: 'factory', plan: '', temperament: 1 },
      { design: full ? designId : designId, skin: 'factory', plan: '', temperament: 1 },
    ],
    seed: 1,
    timestep: 0.001,
    reactionDelayS: 0,
  };
  if (full) world = compileWorld(setup);
  else {
    const { xml, compiled } = rolloutXml(designId);
    // buildContext resolves two robots; the second is the same compiled robot and is dropped below.
    world = { xml, robots: [compiled, compiled] };
  }
  const ctx = buildContext(mj, world, setup);
  if (!full) (ctx as { robots: RobotRuntime[] }).robots = [ctx.robots[0]];
  const r = ctx.robots[0];
  const rng = new Rng(1);
  ctx.rng = rng.next;
  // Release robot 0 from its gantry; the opponent (full world) stays on his.
  ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  ctx.released = true;
  const lib = library(designId);
  const names = r.joints.map((j) => j.name);
  const joints = playerJoints(names, lib.joints, r.joints.map((j) => j.motor.noLoadSpeedRadS));
  const part = (id: string) => r.parts.get(id)!.body;
  const model = ctx.model;
  const geomBody = model.geom_bodyid as Int32Array;
  const footGeom = (side: string): number => {
    const b = part(`foot_${side}`);
    for (let g = 0; g < model.ngeom; g++) if (geomBody[g] === b) return g;
    throw new Error(`no foot geom ${side}`);
  };
  const geomPart = new Map<number, string>();
  const robotGeoms: number[] = [];
  for (const p of r.parts.values()) for (const g of p.geoms) {
    geomPart.set(g, p.id);
    robotGeoms.push(g);
  }
  const fg: [number, number] = [footGeom('l'), footGeom('r')];
  const gs = model.geom_size as Float64Array;
  const footHalf: [number, number, number] = [gs[fg[0] * 3], gs[fg[0] * 3 + 1], gs[fg[0] * 3 + 2]];
  const jnt = new Int32Array(r.joints.map((j) => model.jnt(`${r.compiled.prefix}${j.name}`).id as number));
  const spec = mj.mjtState.mjSTATE_INTEGRATION.value as number;
  const size = mj.mj_stateSize(model, spec) as number;
  return {
    mj, ctx, r, lib, designId, full, joints,
    gyro: d.gyro ? new GyroCore(d.gyro) : null,
    rng,
    sense: Object.assign(newBodySense(r.joints.length), { mass: model.body_subtreemass[r.rootBody] as number }),
    ids: {
      root: r.rootBody, pelvis: part('pelvis'), torso: part('torso'), head: part('head'),
      foot: [part('foot_l'), part('foot_r')], footGeom: fg, fist: [part('fist_l'), part('fist_r')], shin: [part('shin_l'), part('shin_r')], jnt,
    },
    geomPart, robotGeoms, footHalf,
    mass: model.body_subtreemass[r.rootBody] as number,
    stateSpec: spec,
    stateSize: size,
    stateBuf: new mj.DoubleBuffer(size),
    stancePelvisZ: d.rootHeight,
    pristine: {
      forcerange: Float64Array.from(model.actuator_forcerange as Float64Array),
      gainprm: Float64Array.from(model.actuator_gainprm as Float64Array),
      biasprm: Float64Array.from(model.actuator_biasprm as Float64Array),
    },
  };
}

// ---------------------------------------------------------------- snapshots (move-polish.md §3.3)

type JointSnap = Pick<JointRuntime, 'tempC' | 'health' | 'state' | 'slop' | 'availableTorque' | 'seizedAt' | 'slopOffset' | 'slopGoal' | 'slopTimer'>;

/**
 * Derived MjData arrays the motor model and the sensing read BEFORE the next mj_step (they hold the last
 * forward pass, not a function of the restored state): mj_setState does not restore them, so a snapshot
 * carries them too, or the first tick after a restore would read the previous run's leftovers.
 */
const DERIVED = ['actuator_force', 'xpos', 'xmat', 'xquat', 'xipos', 'ximat', 'xaxis', 'xanchor', 'subtree_com', 'cinert', 'cvel', 'cdof', 'geom_xpos', 'geom_xmat', 'qfrc_bias'] as const;

export interface Snapshot {
  state: Float64Array;
  derived: Float64Array[];
  joints: JointSnap[];
  battery: number;
  gyro: { h: [number, number]; applied: [number, number, number]; bleeding: [number, number, number]; saturation: number; powerW: number; impulse: number } | null;
  gyroHealth: number;
  rng: number;
  tick: number;
  time: number;
  /** Robot 1's motor state in the full world (its battery drains too). */
  other?: { joints: JointSnap[]; battery: number };
}

const snapJoint = (j: JointRuntime): JointSnap => ({
  tempC: j.tempC, health: j.health, state: j.state, slop: j.slop, availableTorque: j.availableTorque,
  seizedAt: j.seizedAt, slopOffset: j.slopOffset, slopGoal: j.slopGoal, slopTimer: j.slopTimer,
});

export function snapshot(w: PolishWorld): Snapshot {
  const { mj, ctx, r } = w;
  mj.mj_getState(ctx.model, ctx.data, w.stateBuf, w.stateSpec);
  const g = w.gyro;
  const other = w.full ? ctx.robots[1] : null;
  const d = ctx.data;
  return {
    state: Float64Array.from(w.stateBuf.GetView() as Float64Array),
    derived: DERIVED.map((k) => Float64Array.from(d[k] as Float64Array)),
    joints: r.joints.map(snapJoint),
    battery: r.battery,
    gyro: g ? { h: [g.h[0], g.h[1]], applied: [...g.applied] as [number, number, number], bleeding: [...g.bleeding] as [number, number, number], saturation: g.saturation, powerW: g.powerW, impulse: g.impulseDelivered } : null,
    gyroHealth: r.gyro?.health ?? 0,
    rng: w.rng.s,
    tick: ctx.tick,
    time: ctx.time,
    ...(other ? { other: { joints: other.joints.map(snapJoint), battery: other.battery } } : {}),
  };
}

export function restore(w: PolishWorld, s: Snapshot): void {
  const { mj, ctx, r } = w;
  mj.mj_setState(ctx.model, ctx.data, s.state, w.stateSpec);
  DERIVED.forEach((k, i) => (ctx.data[k] as Float64Array).set(s.derived[i]));
  r.joints.forEach((j, i) => {
    const x = s.joints[i];
    j.tempC = x.tempC; j.health = x.health; j.state = x.state; j.slop = x.slop; j.availableTorque = x.availableTorque;
    j.seizedAt = x.seizedAt; j.slopOffset = x.slopOffset; j.slopGoal = x.slopGoal; j.slopTimer = x.slopTimer;
  });
  r.battery = s.battery;
  if (w.gyro && s.gyro) {
    w.gyro.h[0] = s.gyro.h[0];
    w.gyro.h[1] = s.gyro.h[1];
    for (let k = 0; k < 3; k++) {
      w.gyro.applied[k] = s.gyro.applied[k];
      w.gyro.bleeding[k] = s.gyro.bleeding[k];
    }
    w.gyro.saturation = s.gyro.saturation;
    w.gyro.powerW = s.gyro.powerW;
    w.gyro.impulseDelivered = s.gyro.impulse;
  }
  if (r.gyro) {
    r.gyro.health = s.gyroHealth;
    r.gyro.saturation = s.gyro?.saturation ?? 0;
  }
  w.rng.s = s.rng;
  ctx.tick = s.tick;
  ctx.time = s.time;
  if (s.other && w.full) {
    const o = ctx.robots[1];
    o.joints.forEach((j, i) => Object.assign(j, s.other!.joints[i]));
    o.battery = s.other.battery;
  }
}

// ---------------------------------------------------------------- sensing (what PolishedPlayer reads)

/** Fill w.sense from the current MjData (the views lag qpos by one step, exactly as the game's controller sees them). */
export function readSense(w: PolishWorld): BodySense {
  const { mj, ctx, r, sense: s, ids } = w;
  const d = ctx.data;
  mj.mj_subtreeVel(ctx.model, d);
  const sc = d.subtree_com as Float64Array, lv = d.subtree_linvel as Float64Array, am = d.subtree_angmom as Float64Array;
  const xm = d.xmat as Float64Array, xp = d.xpos as Float64Array, gx = d.geom_xpos as Float64Array, gm = d.geom_xmat as Float64Array;
  const xa = d.xaxis as Float64Array;
  const b = ids.root * 3;
  for (let k = 0; k < 3; k++) {
    s.com[k] = sc[b + k];
    s.comVel[k] = lv[b + k];
    s.L[k] = am[b + k];
    s.pelvis[k] = xp[ids.pelvis * 3 + k];
  }
  for (let k = 0; k < 9; k++) s.torsoRot[k] = xm[ids.torso * 9 + k];
  const hz = w.footHalf[2];
  for (let f = 0; f < 2; f++) {
    const g = ids.footGeom[f];
    const o = g * 9;
    // Sole centre: the box centre minus half its height along its own z axis.
    s.foot[f * 3] = gx[g * 3] - gm[o + 2] * hz;
    s.foot[f * 3 + 1] = gx[g * 3 + 1] - gm[o + 5] * hz;
    s.foot[f * 3 + 2] = gx[g * 3 + 2] - gm[o + 8] * hz;
    s.footDown[f] = lowestBoxZ(gx, gm, g, w.footHalf) < FOOT_DOWN_M ? 1 : 0;
  }
  const gainScale = r.mem.gainScale as Float64Array | undefined;
  const dampScale = r.mem.dampScale as Float64Array | undefined;
  for (let i = 0; i < r.joints.length; i++) {
    const j = r.joints[i];
    const ja = ids.jnt[i] * 3;
    s.axis[i * 3] = xa[ja];
    s.axis[i * 3 + 1] = xa[ja + 1];
    s.axis[i * 3 + 2] = xa[ja + 2];
    s.kp[i] = j.state === 'limp' ? 0 : j.state === 'seized' ? j.kp * 3 : j.kp * (gainScale ? gainScale[i] : 1);
    s.kd[i] = j.kd * (dampScale && j.state === 'ok' ? dampScale[i] : 1);
  }
  return s;
}

/** A sole this close to the canvas counts as down (the gait's touchdown height). */
export const FOOT_DOWN_M = 0.006;

export function lowestBoxZ(gx: Float64Array, gm: Float64Array, g: number, half: readonly number[]): number {
  const o = g * 9;
  return gx[g * 3 + 2] - (Math.abs(gm[o + 6]) * half[0] + Math.abs(gm[o + 7]) * half[1] + Math.abs(gm[o + 8]) * half[2]);
}

/** Lowest point of any geom (box, sphere, capsule, cylinder) of the model, world z. */
export function lowestGeomZ(w: PolishWorld, g: number, gx: Float64Array, gm: Float64Array): number {
  const m = w.ctx.model;
  const type = (m.geom_type as Int32Array)[g];
  const sz = m.geom_size as Float64Array;
  const o = g * 9;
  const cz = gx[g * 3 + 2];
  switch (type) {
    case 6: // box
      return cz - (Math.abs(gm[o + 6]) * sz[g * 3] + Math.abs(gm[o + 7]) * sz[g * 3 + 1] + Math.abs(gm[o + 8]) * sz[g * 3 + 2]);
    case 2: // sphere
      return cz - sz[g * 3];
    case 3: // capsule: half-length along local z
      return cz - Math.abs(gm[o + 8]) * sz[g * 3 + 1] - sz[g * 3];
    case 5: // cylinder
      return cz - Math.abs(gm[o + 8]) * sz[g * 3 + 1] - Math.sqrt(Math.max(0, 1 - gm[o + 8] * gm[o + 8])) * sz[g * 3];
    default:
      return cz;
  }
}

/** One physics step the way the game takes it: control (every 2nd step) → motors → mj_step. */
export function physicsStep(w: PolishWorld): void {
  const { mj, ctx } = w;
  motorSystem.pre!(ctx);
  mj.mj_step(ctx.model, ctx.data);
  ctx.tick++;
  ctx.time += ctx.dt;
}

/** Honesty checks (move-polish.md §6): only the gyro couple in xfrc_applied, no qfrc_applied. */
export function honestyViolation(w: PolishWorld): string | null {
  const d = w.ctx.data;
  const xf = d.xfrc_applied as Float64Array;
  const torso = w.ids.torso;
  for (let b = 0; b < w.ctx.model.nbody; b++) {
    for (let k = 0; k < 6; k++) {
      const v = xf[b * 6 + k];
      if (v === 0) continue;
      if (b === torso && k >= 3 && w.gyro) {
        if (Math.abs(v - w.gyro.applied[k - 3]) > 1e-9) return `xfrc torso torque ${k - 3} ${v} ≠ gyro ${w.gyro.applied[k - 3]}`;
        continue;
      }
      return `xfrc on body ${b} [${k}] = ${v}`;
    }
  }
  const qf = d.qfrc_applied as Float64Array;
  for (let i = 0; i < w.ctx.model.nv; i++) if (qf[i] !== 0) return `qfrc_applied[${i}] = ${qf[i]}`;
  if (w.ctx.model.opt.timestep !== 0.001) return `timestep ${w.ctx.model.opt.timestep}`;
  return null;
}

/** Body-mass checksum (the honesty assertion: masses never change). */
export function massChecksum(w: PolishWorld): number {
  const bm = w.ctx.model.body_mass as Float64Array;
  let s = 0;
  for (let i = 0; i < bm.length; i++) s += bm[i] * (i + 1);
  return s;
}
