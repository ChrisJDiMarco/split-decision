// Motor model. Every joint is a position servo whose available torque is set each step from:
//   torque-speed line   τ_avail = τ_stall · (1 − |ω| / ω_noload)
//   thermal derating    windings lose torque in the last 20 °C before max temp, then burn out
//   joint health        damaged gears slip: less torque, backlash (slop) and jitter
//   hydraulic pressure  hydraulic joints scale with their circuit's pressure
//   battery             sag above 70% draw
// Heat: copper loss ∝ (τ/τ_stall)² · P_stall, cooled through the winding thermal resistance.
import type { SimContext, SimSystem, JointRuntime, RobotRuntime } from '../sim-context';

const AMBIENT_C = 28;
const DERATE_BAND_C = 20;
const MIN_TORQUE_FRAC = 0.02; // a dead joint still has gearbox drag

export function jointStateFor(health: number): JointRuntime['state'] {
  if (health <= 0.05) return 'limp';
  if (health <= 0.35) return 'degraded';
  return 'ok';
}

function thermalFactor(j: JointRuntime): number {
  const start = j.motor.maxTempC - DERATE_BAND_C;
  if (j.tempC <= start) return 1;
  if (j.tempC >= j.motor.maxTempC) return 0.15; // cooked windings: barely holds
  return 1 - 0.85 * ((j.tempC - start) / DERATE_BAND_C);
}

function pressureFactor(r: RobotRuntime, j: JointRuntime): number {
  if (!j.hydraulicCircuit) return 1;
  return r.hydraulics.get(j.hydraulicCircuit)?.pressure ?? 1;
}

export const motorSystem: SimSystem = {
  name: 'motors',
  pre(ctx: SimContext) {
    const { model, data, dt } = ctx;
    const forcerange = model.actuator_forcerange;
    const gainprm = model.actuator_gainprm;
    const biasprm = model.actuator_biasprm;
    for (const r of ctx.robots) {
      let draw = 0;
      for (let i = 0; i < r.joints.length; i++) {
        const j = r.joints[i];
        const omega = Math.abs(data.qvel[j.dadr]);
        const speedFactor = Math.max(0, 1 - omega / j.motor.noLoadSpeedRadS);
        const healthFactor = j.state === 'limp' ? 0 : 0.25 + 0.75 * j.health;
        const avail = j.motor.stallTorqueNm * Math.max(
          MIN_TORQUE_FRAC,
          speedFactor * thermalFactor(j) * healthFactor * pressureFactor(r, j) * (0.6 + 0.4 * r.battery),
        );
        j.availableTorque = avail;
        forcerange[j.act * 2] = -avail;
        forcerange[j.act * 2 + 1] = avail;

        // A limp joint loses its servo entirely; a seized one locks up stiff.
        const kpScale = j.state === 'limp' ? 0 : j.state === 'seized' ? 3 : 1;
        gainprm[j.act * 10] = j.kp * kpScale;
        biasprm[j.act * 10 + 1] = -j.kp * kpScale;
        biasprm[j.act * 10 + 2] = -j.kd * (j.state === 'limp' ? 0.15 : 1);

        // Damaged gear trains: dead band + jitter on the commanded position.
        const jitter = j.slop > 0 ? (ctx.rng() - 0.5) * j.slop : 0;
        data.ctrl[j.act] = r.targets[i] + jitter;

        // Thermal: copper loss from the torque actually delivered.
        const tau = Math.abs(data.actuator_force[j.act]);
        const load = tau / j.motor.stallTorqueNm;
        const heatIn = load * load * j.motor.copperLossAtStallW;
        const cooling = (j.tempC - AMBIENT_C) / j.motor.thermalResistanceKPerW;
        j.tempC += ((heatIn - cooling) / j.motor.heatCapacityJPerK) * dt;
        if (j.tempC >= j.motor.maxTempC + 25 && j.state !== 'limp') {
          j.state = 'limp';
          j.health = Math.min(j.health, 0.04);
          ctx.events.push({ kind: 'joint', corner: r.corner, joint: j.name, health: j.health, state: 'limp' });
        }
        draw += tau * omega;
      }
      // Battery: ~1.2 kWh pack; draw in watts.
      r.battery = Math.max(0, r.battery - (draw * dt) / (1.2 * 3.6e6));
    }
  },
};
