import loadMujoco from '@mujoco/mujoco';
import { compileWorld } from '../src/physics/world';
const mj = await loadMujoco();
const world = compileWorld({ fighters: [{ design: 'goliath', skin: 'factory', plan: '', temperament: 1 }, { design: 'striker', skin: 'factory', plan: '', temperament: 1 }], seed: 1, timestep: 0.001, reactionDelayS: 0.3 } as never);
function trial(label: string, mutate: (m: any) => void, useStance: boolean) {
  const model = mj.MjModel.from_xml_string(world.xml);
  mutate(model);
  const data = new mj.MjData(model);
  mj.mj_forward(model, data);
  let minDist = 0; let worstPair = '';
  const cons = data.contact;
  for (let i = 0; i < data.ncon; i++) { const c = cons.get(i); if (c.dist < minDist) { minDist = c.dist; worstPair = `${mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, c.geom1)} x ${mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, c.geom2)}`; } }
  cons.delete();
  const act = world.robots.flatMap((r) => r.joints.map((j) => ({ u: model.actuator(`${j.mjName}_m`).id, target: useStance ? (r.design.stance[j.name] ?? 0) : 0 })));
  let worst = 0, at = -1;
  for (let i = 0; i < 300; i++) { for (const a of act) data.ctrl[a.u] = a.target; mj.mj_step(model, data); for (let k = 0; k < model.nv; k++) if (Math.abs(data.qvel[k]) > worst) { worst = Math.abs(data.qvel[k]); at = i; } }
  console.log(`${label}: ncon0=${world ? '' : ''}minDist0=${minDist.toFixed(3)} (${worstPair}) worst qvel=${worst.toFixed(1)} @${at}`);
}
trial('baseline stance', () => {}, true);
trial('zero targets', () => {}, false);
trial('no actuators (gain 0)', (m) => { for (let i = 0; i < m.nu; i++) { m.actuator_gainprm[i*10] = 0; m.actuator_biasprm[i*10+1] = 0; m.actuator_biasprm[i*10+2] = 0; } }, true);
trial('kv only', (m) => { for (let i = 0; i < m.nu; i++) { m.actuator_gainprm[i*10] = 0; m.actuator_biasprm[i*10+1] = 0; } }, true);
