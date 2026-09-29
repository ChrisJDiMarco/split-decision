import loadMujoco from '@mujoco/mujoco';
import { compileWorld } from '../src/physics/world';
const mj = await loadMujoco();
const base = compileWorld({ fighters: [{ design: 'goliath', skin: 'factory', plan: '', temperament: 1 }, { design: 'striker', skin: 'factory', plan: '', temperament: 1 }], seed: 1, timestep: 0.001, reactionDelayS: 0.3 } as never);
function trial(label: string, xml: string, opts: { eqOff?: number[] } = {}) {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  if (opts.eqOff) { const e = new Array(model.neq).fill(1); for (const i of opts.eqOff) e[i] = 0; mj.mj_setState(model, data, e, mj.mjtState.mjSTATE_EQ_ACTIVE.value); }
  const act = base.robots.flatMap((r) => r.joints.map((j) => ({ u: model.actuator(`${j.mjName}_m`).id, target: r.design.stance[j.name] ?? 0 })));
  let worst = 0, at = -1;
  for (let i = 0; i < 1500; i++) { for (const a of act) data.ctrl[a.u] = a.target; mj.mj_step(model, data); for (let k = 0; k < model.nv; k++) if (Math.abs(data.qvel[k]) > worst) { worst = Math.abs(data.qvel[k]); at = i; } }
  console.log(`${label.padEnd(28)} worst qvel=${worst.toFixed(1)} @${at}`);
}
const x = base.xml;
trial('baseline', x);
trial('gantries off', x, { eqOff: [0, 2] });
trial('integrator implicit', x.replace('integrator="implicitfast"', 'integrator="implicit"'));
trial('dt 0.5ms', x.replace('timestep="0.001"', 'timestep="0.0005"'));
trial('no forcelimited', x.replace(/forcelimited="true" forcerange="[^"]+"/g, ''));
trial('solver CG', x.replace('solver="Newton"', 'solver="CG"'));
trial('no impratio', x.replace(' impratio="10"', ''));
trial('pyramidal', x.replace('cone="elliptic"', 'cone="pyramidal"'));
trial('discrete integ', x.replace('integrator="implicitfast"', 'integrator="discrete"'));
