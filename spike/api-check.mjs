import loadMujoco from '@mujoco/mujoco';
const mj = await loadMujoco();
const xml = `<mujoco><option timestep="0.001"/><worldbody><geom name="floor" type="plane" size="3 3 .1"/>
<body name="box" pos="0 0 0.5"><freejoint/><geom name="g" type="box" size=".1 .1 .1" mass="5"/></body>
<body name="parked" pos="2 2 0.2"><freejoint/><geom name="pg" type="sphere" size=".05" mass="1"/></body>
</worldbody><equality><weld name="park" body1="parked"/></equality></mujoco>`;
const m = mj.MjModel.from_xml_string(xml);
const d = new mj.MjData(m);
for (let i = 0; i < 600; i++) mj.mj_step(m, d);
console.log('ncon', d.ncon);
// 1. contact force
try {
  const buf = new mj.DoubleBuffer(6);
  mj.mj_contactForce(m, d, 0, buf);
  console.log('contactForce', Array.from(buf.GetView()).map(v=>v.toFixed(1)).join(','));
  buf.delete();
} catch (e) { console.log('contactForce ERR', e.message); }
// contact fields
try { const c = d.contact; const c0 = c.get(0); console.log('contact0 geom', c0.geom1 ?? c0.geom?.[0], c0.geom2, 'pos', c0.pos && Array.from(c0.pos).slice(0,3).map(v=>v.toFixed(3)), 'efc', c0.efc_address, 'dist', c0.dist); c.delete(); } catch (e) { console.log('contact ERR', e.message); }
// 2. geom_contype writable
try { const ct = m.geom_contype; console.log('contype type', ct.constructor.name, Array.from(ct)); ct[1] = 0; console.log('after write', Array.from(m.geom_contype)); } catch (e) { console.log('contype ERR', e.message); }
// 3. xfrc_applied writable
try { const xf = d.xfrc_applied; console.log('xfrc len', xf.length, xf.constructor.name); xf[6+5] = 1; console.log('xfrc wrote', d.xfrc_applied[11]); } catch (e) { console.log('xfrc ERR', e.message); }
// 4. qpos/qvel writable, release parked weld
try { const q = d.qpos; console.log('qpos', q.constructor.name, q.length); mj.mj_setState(m, d, [0], mj.mjtState.mjSTATE_EQ_ACTIVE.value); q[7]=0; q[8]=0; q[9]=1.5; for (let i=0;i<300;i++) mj.mj_step(m,d); console.log('parked z after release', d.xpos[2*3+2].toFixed(3)); } catch (e) { console.log('qpos ERR', e.message); }
// 5. read eq_active via getState
try { const n = mj.mj_stateSize(m, mj.mjtState.mjSTATE_EQ_ACTIVE.value); const b = new mj.DoubleBuffer(n); mj.mj_getState(m, d, b, mj.mjtState.mjSTATE_EQ_ACTIVE.value); console.log('eq_active via getState', Array.from(b.GetView())); b.delete(); } catch (e) { console.log('getState ERR', e.message); }
// 6. efc_force, cfrc_ext, sensors
try { console.log('efc_force len', d.efc_force.length, 'cfrc_ext len', d.cfrc_ext.length); } catch (e) { console.log('efc ERR', e.message); }
// 7. body velocity
try { const v = new mj.DoubleBuffer(6); mj.mj_objectVelocity(m, d, mj.mjtObj.mjOBJ_BODY.value, 1, v, 0); console.log('objVel', Array.from(v.GetView()).map(x=>x.toFixed(2))); v.delete(); } catch (e) { console.log('objVel ERR', e.message); }
