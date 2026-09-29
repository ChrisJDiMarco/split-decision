// Feasibility spike: can official MuJoCo WASM step two ~15-body robots in a
// contact-heavy clinch at 1 kHz, and can a welded head be knocked off via eq_active?
import loadMujoco from '@mujoco/mujoco';

const STEP_SECONDS = 0.001;
const SIM_SECONDS = 5;

function robot(name, x, facing, rgba) {
  const f = facing; // +1 faces +x, -1 faces -x
  const limb = (side) => {
    const s = side === 'l' ? 1 : -1;
    return `
      <body name="${name}_uarm_${side}" pos="0 ${0.24 * s} 0.42">
        <joint name="${name}_sh_pitch_${side}" type="hinge" axis="0 1 0" range="-170 60" armature="0.02" damping="2"/>
        <joint name="${name}_sh_roll_${side}" type="hinge" axis="1 0 0" range="-90 90" armature="0.02" damping="2"/>
        <geom type="capsule" fromto="0 0 0 ${0.28 * f} 0 0" size="0.055" mass="4"/>
        <body name="${name}_farm_${side}" pos="${0.28 * f} 0 0">
          <joint name="${name}_elbow_${side}" type="hinge" axis="0 0 1" range="-150 0" armature="0.02" damping="1.5"/>
          <geom type="capsule" fromto="0 0 0 ${0.26 * f} 0 0" size="0.06" mass="4"/>
          <geom name="${name}_fist_${side}" type="box" pos="${0.3 * f} 0 0" size="0.07 0.07 0.07" mass="2.5"/>
        </body>
      </body>`;
  };
  const leg = (side) => {
    const s = side === 'l' ? 1 : -1;
    return `
      <body name="${name}_thigh_${side}" pos="0 ${0.12 * s} -0.1">
        <joint name="${name}_hip_pitch_${side}" type="hinge" axis="0 1 0" range="-120 40" armature="0.05" damping="4"/>
        <joint name="${name}_hip_roll_${side}" type="hinge" axis="1 0 0" range="-40 40" armature="0.05" damping="4"/>
        <geom type="capsule" fromto="0 0 0 0 0 -0.42" size="0.08" mass="8"/>
        <body name="${name}_shin_${side}" pos="0 0 -0.42">
          <joint name="${name}_knee_${side}" type="hinge" axis="0 1 0" range="0 150" armature="0.05" damping="4"/>
          <geom type="capsule" fromto="0 0 0 0 0 -0.42" size="0.07" mass="6"/>
          <body name="${name}_foot_${side}" pos="0 0 -0.45">
            <joint name="${name}_ankle_${side}" type="hinge" axis="0 1 0" range="-45 45" armature="0.03" damping="3"/>
            <geom type="box" pos="${0.05 * f} 0 0" size="0.14 0.07 0.03" mass="2.5" friction="1.2 0.02 0.001"/>
          </body>
        </body>
      </body>`;
  };
  const joints = ['sh_pitch_l', 'sh_roll_l', 'elbow_l', 'sh_pitch_r', 'sh_roll_r', 'elbow_r',
    'hip_pitch_l', 'hip_roll_l', 'knee_l', 'ankle_l', 'hip_pitch_r', 'hip_roll_r', 'knee_r', 'ankle_r'];
  const body = `
    <body name="${name}_pelvis" pos="${x} 0 1.05">
      <freejoint name="${name}_root"/>
      <geom type="box" size="0.14 0.2 0.1" mass="12" rgba="${rgba}"/>
      <body name="${name}_torso" pos="0 0 0.1">
        <joint name="${name}_waist" type="hinge" axis="0 0 1" range="-60 60" armature="0.05" damping="4"/>
        <geom type="box" pos="0 0 0.28" size="0.16 0.24 0.22" mass="25" rgba="${rgba}"/>
        ${limb('l')}${limb('r')}
      </body>
      ${leg('l')}${leg('r')}
    </body>
    <body name="${name}_head" pos="${x} 0 1.9">
      <freejoint name="${name}_head_free"/>
      <geom type="box" size="0.11 0.1 0.12" mass="5" rgba="${rgba}"/>
    </body>`;
  const actuators = [...joints, 'waist'].map((j) =>
    `<position name="${name}_act_${j}" joint="${name}_${j}" kp="600" kv="30" forcerange="-250 250"/>`).join('\n');
  const eq = `<weld name="${name}_neck" body1="${name}_torso" body2="${name}_head" solref="0.004 1"/>`;
  return { body, actuators, eq };
}

const a = robot('red', -0.45, 1, '0.8 0.2 0.1 1');
const b = robot('blue', 0.45, -1, '0.1 0.3 0.8 1');
const xml = `
<mujoco model="spike">
  <option timestep="${STEP_SECONDS}" integrator="implicitfast" cone="elliptic" solver="Newton" iterations="30"/>
  <worldbody>
    <light pos="0 0 5"/>
    <geom name="floor" type="plane" size="6 6 0.1" friction="1 0.02 0.001"/>
    ${a.body}${b.body}
  </worldbody>
  <equality>${a.eq}${b.eq}</equality>
  <actuator>${a.actuators}${b.actuators}</actuator>
</mujoco>`;

const mj = await loadMujoco();
const model = mj.MjModel.from_xml_string(xml);
const data = new mj.MjData(model);
console.log(`nbody=${model.nbody} nq=${model.nq} nv=${model.nv} nu=${model.nu} neq=${model.neq}`);

const ctrl = data.ctrl;
const EQ_ACTIVE = mj.mjtState.mjSTATE_EQ_ACTIVE.value;
const INTEGRATION = mj.mjtState.mjSTATE_INTEGRATION.value;
const steps = Math.round(SIM_SECONDS / STEP_SECONDS);
let maxContacts = 0;
let contactSum = 0;
const headStart = data.xpos[model.body('red_head').id * 3 + 2];
const t0 = performance.now();
for (let i = 0; i < steps; i++) {
  const t = i * STEP_SECONDS;
  // Both robots lean in and flail their arms: a crude clinch to generate lots of contacts.
  for (let u = 0; u < model.nu; u++) ctrl[u] = 0.6 * Math.sin(3 * t + u);
  if (i === 2500) mj.mj_setState(model, data, [0, 1], EQ_ACTIVE); // "knock off" the red head halfway through
  mj.mj_step(model, data);
  const n = data.ncon;
  contactSum += n;
  if (n > maxContacts) maxContacts = n;
}
const ms = performance.now() - t0;
const headEnd = data.xpos[model.body('red_head').id * 3 + 2];
console.log(`${steps} steps in ${ms.toFixed(0)} ms -> ${(ms / steps * 1000).toFixed(1)} us/step, ${(steps / ms * 1000).toFixed(0)} steps/s`);
console.log(`contacts avg=${(contactSum / steps).toFixed(1)} max=${maxContacts}`);
console.log(`red head z: start=${headStart.toFixed(2)} end=${headEnd.toFixed(2)} `);

// Rollout cost for look-ahead planning: copy state, simulate 300 ms ahead.
const scratch = new mj.MjData(model);
const r0 = performance.now();
const ROLLOUTS = 20;
for (let r = 0; r < ROLLOUTS; r++) {
  mj.mj_copyState(model, data, scratch, INTEGRATION);
  for (let i = 0; i < 300; i++) mj.mj_step(model, scratch);
}
const rms = performance.now() - r0;
console.log(`${ROLLOUTS} rollouts x 300 steps: ${rms.toFixed(0)} ms (${(rms / ROLLOUTS).toFixed(1)} ms per 300-ms rollout)`);
scratch.delete(); data.delete(); model.delete();
