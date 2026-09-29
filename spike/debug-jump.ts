import loadMujoco from '@mujoco/mujoco';
import { compileWorld } from '../src/physics/world';
const mj = await loadMujoco();
async function run(a: string, b: string, gainScale: number, label: string) {
  const world = compileWorld({ fighters: [{ design: a, skin: 'factory', plan: '', temperament: 1 }, { design: b, skin: 'factory', plan: '', temperament: 1 }], seed: 1, timestep: 0.001, reactionDelayS: 0.3 } as never);
  const model = mj.MjModel.from_xml_string(world.xml);
  const data = new mj.MjData(model);
  const act = world.robots.flatMap((r) => r.joints.map((j) => { const jid = model.jnt(j.mjName).id; return { name: j.mjName, q: model.jnt_qposadr[jid], d: model.jnt_dofadr[jid], u: model.actuator(`${j.mjName}_m`).id, kp: j.kp * gainScale, kd: j.kd * gainScale, target: r.design.stance[j.name] ?? 0 }; }));
  const pel = [model.body('r0_pelvis').id, model.body('r1_pelvis').id];
  let worst = { v: 0, t: 0, dof: -1 };
  for (let i = 0; i < 800; i++) {
    for (const x of act) data.ctrl[x.u] = x.target;
    mj.mj_step(model, data);
    for (let k = 0; k < model.nv; k++) if (Math.abs(data.qvel[k]) > worst.v) worst = { v: Math.abs(data.qvel[k]), t: i, dof: k };
  }
  const dofJoint = model.dof_jntid[worst.dof];
  const jname = mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, dofJoint);
  console.log(`${label}: r0 z=${data.xpos[pel[0]*3+2].toFixed(2)} r1 z=${data.xpos[pel[1]*3+2].toFixed(2)} x=${data.xpos[pel[1]*3].toFixed(2)} worst qvel=${worst.v.toFixed(1)} at step ${worst.t} joint ${jname}`);
}
await run('bruiser', 'striker', 1, 'bruiser v striker');
await run('striker', 'bruiser', 1, 'striker v bruiser');
await run('bruiser', 'bruiser', 1, 'bruiser v bruiser');
await run('goliath', 'striker', 1, 'goliath v striker');
