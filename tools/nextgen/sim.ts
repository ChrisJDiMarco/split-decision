// Headless MuJoCo harness for the NEXT GEN Phase 0 variants: one variant robot (corner 0) and a
// parked copy far away on its gantry (corner 1; the runtime always builds two), the same solver
// options as src/physics/world.ts, and only the real motor model (torque-speed line, heat, battery
// sag, thermal derate) between the scripted targets and the joints. No production controller, no
// gyro core torque: every variant is driven by the same scripts in tools/nextgen/.
import loadMujoco from '@mujoco/mujoco';
import type { MatchSetup } from '../../src/core/types';
import { buildContext } from '../../src/physics/runtime';
import type { RobotRuntime, SimContext } from '../../src/physics/sim-context';
import { motorSystem } from '../../src/physics/systems/motors';
import { COLLIDE, compileRobot } from '../../src/robots/compile-mjcf';
import type { Variant } from './variants';

type Mj = Awaited<ReturnType<typeof loadMujoco>>;
let mjPromise: Promise<Mj> | null = null;
export const mujoco = (): Promise<Mj> => (mjPromise ??= loadMujoco());

const f = (n: number) => Number(n.toFixed(5)).toString();

export interface SimOpts {
  /** Root spawn height above the design's rootHeight (m). */
  lift?: number;
  /** Weld this foot to the world where it sits at qpos0 (a planted, unslippable foot). */
  footWeld?: 'l' | 'r';
  seed?: number;
  timestep?: number;
}

export interface VSim {
  ctx: SimContext;
  r: RobotRuntime;
  mj: Mj;
  step(each?: () => void): void;
  run(seconds: number, each?: () => void): void;
  release(): void;
  dispose(): void;
}

export function worldXml(v: Variant, opts: SimOpts = {}) {
  const d = v.design;
  const r0 = compileRobot(d, 0, { pos: [0, 0, d.rootHeight + 0.02 + (opts.lift ?? 0)], yaw: 0 });
  const r1 = compileRobot(d, 1, { pos: [8, 0, d.rootHeight + 0.3], yaw: Math.PI });
  const worldAff = COLLIDE.R0 | COLLIDE.R1 | COLLIDE.DEBRIS;
  const weld = opts.footWeld ? `<weld name="foot_weld" body1="r0_foot_${opts.footWeld}" solref="0.004 1"/>` : '';
  const xml = `<mujoco model="nextgen-phase0">
  <compiler angle="degree" autolimits="true"/>
  <option timestep="${f(opts.timestep ?? 0.001)}" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="30" ls_iterations="10">
    <flag energy="disable"/>
  </option>
  <size memory="64M"/>
  <worldbody>
    <geom name="canvas" type="plane" size="30 30 0.1" contype="${COLLIDE.WORLD}" conaffinity="${worldAff}" friction="0.9 0.005 0.0001" solref="0.004 1"/>
${r0.bodyXml}
${r1.bodyXml}
${r0.debrisXml}
${r1.debrisXml}
  </worldbody>
  <equality>
    ${r0.equalityXml}
    ${r1.equalityXml}
    ${weld}
  </equality>
  <actuator>
    ${r0.actuatorXml}
    ${r1.actuatorXml}
  </actuator>
</mujoco>`;
  return { xml, robots: [r0, r1] as [typeof r0, typeof r1] };
}

export async function makeVSim(v: Variant, opts: SimOpts = {}): Promise<VSim> {
  const mj = await mujoco();
  const world = worldXml(v, opts);
  const setup: MatchSetup = {
    fighters: [
      { design: v.design.id, skin: 'factory', plan: '', temperament: 1 },
      { design: v.design.id, skin: 'factory', plan: '', temperament: 1 },
    ],
    seed: opts.seed ?? 1,
    timestep: opts.timestep ?? 0.001,
    reactionDelayS: 0,
  };
  const ctx = buildContext(mj, world, setup);
  motorSystem.init?.(ctx);
  const r = ctx.robots[0];
  const stepOnce = () => {
    motorSystem.pre?.(ctx);
    mj.mj_step(ctx.model, ctx.data);
    ctx.tick++;
    ctx.time += ctx.dt;
    motorSystem.post?.(ctx);
  };
  return {
    ctx, r, mj,
    step(each) { stepOnce(); each?.(); },
    run(seconds, each) {
      const n = Math.round(seconds / ctx.dt);
      for (let i = 0; i < n; i++) { stepOnce(); each?.(); }
    },
    release() {
      ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
      ctx.released = true;
    },
    dispose() { ctx.data.delete(); ctx.model.delete(); },
  };
}

// ---------------------------------------------------------------- honesty recorder

export interface JointPeak {
  tauFrac: number; // peak |τ| / stall
  availFrac: number; // peak |τ| / available torque at that instant (1 = saturated)
  speedFrac: number; // peak |ω| / no-load speed
  tempC: number;
  satS: number; // seconds at ≥ 98% of available torque
  limitS: number; // seconds within 1° of a range stop
}

export class Recorder {
  readonly peaks = new Map<string, JointPeak>();
  /** Joint temperatures entering the thermal derate band (maxTemp − 20 °C). */
  derated = new Set<string>();
  constructor(private readonly sim: VSim) {
    for (const j of sim.r.joints) this.peaks.set(j.name, { tauFrac: 0, availFrac: 0, speedFrac: 0, tempC: j.tempC, satS: 0, limitS: 0 });
  }
  sample() {
    const { ctx, r } = this.sim;
    const dt = ctx.dt;
    const range = ctx.model.jnt_range;
    for (const j of r.joints) {
      const p = this.peaks.get(j.name)!;
      const tau = Math.abs(ctx.data.actuator_force[j.act]);
      const stall = j.motor.stallTorqueNm;
      p.tauFrac = Math.max(p.tauFrac, tau / stall);
      const af = tau / Math.max(1e-9, j.availableTorque);
      p.availFrac = Math.max(p.availFrac, af);
      if (af >= 0.98) p.satS += dt;
      p.speedFrac = Math.max(p.speedFrac, Math.abs(ctx.data.qvel[j.dadr]) / j.motor.noLoadSpeedRadS);
      p.tempC = Math.max(p.tempC, j.tempC);
      if (j.tempC > j.motor.maxTempC - 20) this.derated.add(j.name);
      const jid = ctx.model.actuator_trnid[j.act * 2];
      const q = ctx.data.qpos[j.qadr];
      if (q - range[jid * 2] < 1 * Math.PI / 180 || range[jid * 2 + 1] - q < 1 * Math.PI / 180) p.limitS += dt;
    }
  }
  /** Summary over a set of joints (by name prefix). */
  summary(prefixes: string[]) {
    let tau = 0, sat = 0, speed = 0, temp = 0, worst = '';
    for (const [n, p] of this.peaks) {
      if (!prefixes.some((x) => n.startsWith(x))) continue;
      if (p.tauFrac > tau) { tau = p.tauFrac; worst = n; }
      sat = Math.max(sat, p.satS);
      speed = Math.max(speed, p.speedFrac);
      temp = Math.max(temp, p.tempC);
    }
    return { peakTauFrac: tau, worstJoint: worst, maxSatS: sat, peakSpeedFrac: speed, peakTempC: temp };
  }
}

/** Set robot 0's joint targets from a name → angle map (others keep their current target). */
export function setTargets(r: RobotRuntime, q: Record<string, number>) {
  for (const [name, val] of Object.entries(q)) {
    const i = r.jointIndex.get(name);
    if (i !== undefined) r.targets[i] = val;
  }
}

/** Place robot 0's joints (qpos) and targets at a pose. */
export function placeJoints(sim: VSim, q: Record<string, number>) {
  for (const [name, val] of Object.entries(q)) {
    const i = sim.r.jointIndex.get(name);
    if (i === undefined) continue;
    sim.ctx.data.qpos[sim.r.joints[i].qadr] = val;
    sim.r.targets[i] = val;
  }
}

export const bodyId = (sim: VSim, part: string) => sim.r.parts.get(part)!.body;
