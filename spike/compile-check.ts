import loadMujoco from '@mujoco/mujoco';
import { compileWorld } from '../src/physics/world';

const setup = { fighters: [
  { design: 'bruiser', skin: 'factory', plan: '', temperament: 1 },
  { design: 'striker', skin: 'neon', plan: '', temperament: 1 },
] as const, seed: 1, timestep: 0.001, reactionDelayS: 0.3 };
const world = compileWorld(setup as never);
for (const r of world.robots) console.log(r.design.id, 'mass', r.totalMassKg.toFixed(1), 'kg', 'joints', r.joints.length, 'parts', r.parts.length);
const mj = await loadMujoco();
let model;
try { model = mj.MjModel.from_xml_string(world.xml); } catch (e) { console.log(String(e)); console.log(world.xml.split('\n').slice(0, 40).join('\n')); process.exit(1); }
const data = new mj.MjData(model);
console.log(`nbody=${model.nbody} nv=${model.nv} nu=${model.nu} neq=${model.neq} ngeom=${model.ngeom}`);
// PD to stance on the gantry for 1 s, then release and hold stance (no balance yet)
const act = world.robots.flatMap((r) => r.joints.map((j) => {
  const jid = model.jnt(j.mjName).id;
  return { q: model.jnt_qposadr[jid], d: model.jnt_dofadr[jid], u: model.actuator(`${j.mjName}_m`).id, kp: j.kp, kd: j.kd, target: r.design.stance[j.name] ?? 0 };
}));
const EQ = mj.mjtState.mjSTATE_EQ_ACTIVE.value;
const neq = model.neq;
const eqOn = new Array(neq).fill(1);
const t0 = performance.now();
const pel = [model.body('r0_pelvis').id, model.body('r1_pelvis').id];
for (let i = 0; i < 4000; i++) {
  for (const a of act) data.ctrl[a.u] = a.kp * (a.target - data.qpos[a.q]) - a.kd * data.qvel[a.d];
  if (i === 1000) { const e = eqOn.slice(); e[0] = 0; e[world.robots[0].parts.filter(p=>p.debrisBody).length + 1] = 0; mj.mj_setState(model, data, e, EQ); }
  mj.mj_step(model, data);
  if (i % 250 === 0) { let mx=0; for (let k=0;k<model.nv;k++) mx=Math.max(mx,Math.abs(data.qvel[k])); console.log(`t=${(i/1000).toFixed(2)} pelvis: r0 z=${data.xpos[pel[0]*3+2].toFixed(2)} x=${data.xpos[pel[0]*3].toFixed(2)} | r1 z=${data.xpos[pel[1]*3+2].toFixed(2)} x=${data.xpos[pel[1]*3].toFixed(2)} ncon=${data.ncon} max|qvel|=${mx.toFixed(1)}`); }
}
console.log('us/step', ((performance.now() - t0) / 4000 * 1000).toFixed(0));
