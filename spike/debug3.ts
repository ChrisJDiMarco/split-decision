import loadMujoco from '@mujoco/mujoco';
import { compileWorld } from '../src/physics/world';
const mj = await loadMujoco();
const world = compileWorld({ fighters: [{ design: 'goliath', skin: 'factory', plan: '', temperament: 1 }, { design: 'striker', skin: 'factory', plan: '', temperament: 1 }], seed: 1, timestep: 0.001, reactionDelayS: 0.3 } as never);
const model = mj.MjModel.from_xml_string(world.xml);
const opt = model.opt;
console.log('integrator', opt.integrator, 'timestep', opt.timestep, 'enums', JSON.stringify(Object.keys(mj.mjtIntegrator ?? {})));
const u = model.actuator('r0_knee_l_m').id;
console.log('gainprm', Array.from(model.actuator_gainprm.slice(u*10, u*10+3)), 'biasprm', Array.from(model.actuator_biasprm.slice(u*10, u*10+3)), 'biastype', model.actuator_biastype[u], 'gaintype', model.actuator_gaintype[u]);
// effective inertia per dof at spawn
const data = new mj.MjData(model); mj.mj_forward(model, data);
const nv = model.nv; const M = new mj.DoubleBuffer(nv*nv); mj.mj_fullM(model, data, M); const Mv = M.GetView();
const rows: string[] = [];
for (let i = 0; i < nv; i++) { const j = model.dof_jntid[i]; rows.push(`${mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, j)}:${Mv[i*nv+i].toFixed(3)}`); }
console.log(rows.filter((r) => parseFloat(r.split(':')[1]) < 0.08).join(' '));
