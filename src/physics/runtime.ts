// Builds the SimContext from a compiled world: resolves MuJoCo ids once.
import type { MatchSetup } from '../core/types';
import { motor } from '../robots/catalog';
import type { CompiledRobot } from '../robots/compile-mjcf';
import { mulberry32, type JointRuntime, type MjModel, type Mujoco, type PartRuntime, type RobotRuntime, type SimContext } from './sim-context';
import type { CompiledWorld } from './world';

function buildRobot(mj: Mujoco, model: MjModel, compiled: CompiledRobot, setup: MatchSetup): RobotRuntime {
  const corner = compiled.corner;
  const design = compiled.design;
  const rootJoint = model.jnt(`${compiled.prefix}root`).id;
  const joints: JointRuntime[] = compiled.joints.map((j) => {
    const jid = model.jnt(j.mjName).id;
    return {
      name: j.name,
      part: j.part,
      qadr: model.jnt_qposadr[jid],
      dadr: model.jnt_dofadr[jid],
      act: model.actuator(`${j.mjName}_m`).id,
      motor: motor(j.motor),
      kp: j.kp,
      kd: j.kd,
      hydraulicCircuit: j.hydraulicCircuit,
      health: 1,
      state: 'ok',
      tempC: 30,
      availableTorque: motor(j.motor).stallTorqueNm,
      slop: 0,
    };
  });
  const geomId = (name: string) => model.geom(name).id as number;
  const parts = new Map<string, PartRuntime>();
  for (const p of compiled.parts) {
    parts.set(p.id, {
      id: p.id,
      body: model.body(p.body).id,
      debrisBody: p.debrisBody ? model.body(p.debrisBody).id : null,
      geoms: p.geomNames.map(geomId),
      debrisGeoms: p.debrisGeomNames.map(geomId),
      hp: 1,
      damage: 0,
      attached: true,
      smoke: 0,
      heat: 0,
      leak: 0,
    });
  }
  const targets = new Float64Array(joints.length);
  joints.forEach((j, i) => { targets[i] = design.stance[j.name] ?? 0; });
  void mj;
  return {
    corner,
    setup: setup.fighters[corner],
    design,
    compiled,
    rootBody: model.body(`${compiled.prefix}${design.parts[0].id}`).id,
    rootQadr: model.jnt_qposadr[rootJoint],
    rootDadr: model.jnt_dofadr[rootJoint],
    joints,
    jointIndex: new Map(joints.map((j, i) => [j.name, i])),
    parts,
    targets,
    feedforward: new Float64Array(joints.length),
    intent: null,
    pendingIntents: [],
    hydraulics: new Map((design.hydraulics ?? []).map((h) => [h.id, { pressure: 1, fluidL: h.reservoirL }])),
    gyro: design.gyro ? { health: 1, saturation: 0 } : null,
    battery: 1,
    down: false,
    koReason: null,
    skill: 'stance',
    skillPhase: 0,
    windup: 0,
    mem: {},
  };
}

export function buildContext(mj: Mujoco, world: CompiledWorld, setup: MatchSetup): SimContext {
  const model = mj.MjModel.from_xml_string(world.xml);
  const data = new mj.MjData(model);
  const EQ_ACTIVE = mj.mjtState.mjSTATE_EQ_ACTIVE.value;
  const eqActive: number[] = new Array(model.neq).fill(1);
  const ctx: SimContext = {
    mj,
    model,
    data,
    robots: [buildRobot(mj, model, world.robots[0], setup), buildRobot(mj, model, world.robots[1], setup)],
    tick: 0,
    time: 0,
    dt: setup.timestep,
    released: false,
    events: [],
    rng: mulberry32(setup.seed),
    eqActive,
    setEqActive(index, on) {
      if (index < 0) return;
      eqActive[index] = on ? 1 : 0;
      mj.mj_setState(model, data, eqActive, EQ_ACTIVE);
    },
    eqIndex(name) {
      return model.eq(name).id as number;
    },
  };
  // Start with every robot joint at its stance so the gantry lowers a fighter, not a mannequin.
  for (const r of ctx.robots) r.joints.forEach((j, i) => { data.qpos[j.qadr] = r.targets[i]; });
  mj.mj_forward(model, data);
  return ctx;
}
