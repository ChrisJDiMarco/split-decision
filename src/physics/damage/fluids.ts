// Slow-rate part state: hydraulic leaks and pressure, motor heat, smoke.
// Runs every SLOW_STRIDE physics steps with the matching dt.
import {
  BREACH_PRESSURE_LOSS, FLUID_STARVE_HIGH, FLUID_STARVE_LOW, PUNCTURE_BASE_SEVERITY, PUNCTURE_SEVERITY_PER_HP,
  SMOKE_HEAT_START, SMOKE_HP, SMOKE_TAU_S,
} from './constants';
import type { DamageState, PartInfo } from './state';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** 0 = sealed, 1 = the line is wide open (or the part is gone). */
export function leakSeverity(info: PartInfo): number {
  if (!info.part.attached) return 1;
  if (!info.punctured) return 0;
  return clamp01(PUNCTURE_BASE_SEVERITY + PUNCTURE_SEVERITY_PER_HP * (1 - info.part.hp));
}

/**
 * Hydraulic circuits. Each punctured part leaks at leakLPerSAtFullDamage · severity · √pressure
 * (orifice flow). Pressure holds while the pump has fluid, starves as the reservoir runs dry, and an
 * open breach bleeds some pressure on its own. The motor system scales hydraulic joints by pressure.
 */
export function hydraulicsStep(st: DamageState, dt: number): void {
  for (const rd of st.robots) {
    const { robot } = rd;
    const circuits = robot.design.hydraulics ?? [];
    for (const circuit of circuits) for (const id of circuit.parts) { const p = rd.parts.get(id); if (p) p.part.leak = 0; }
    for (const circuit of circuits) {
      const h = robot.hydraulics.get(circuit.id);
      if (!h) continue;
      let flow = 0;
      let worst = 0;
      for (const id of circuit.parts) {
        const info = rd.parts.get(id);
        if (!info) continue;
        const severity = leakSeverity(info);
        worst = Math.max(worst, severity);
        const leak = h.fluidL > 0 ? circuit.leakLPerSAtFullDamage * severity * Math.sqrt(h.pressure) : 0;
        info.part.leak += leak;
        flow += leak;
      }
      h.fluidL = Math.max(0, h.fluidL - flow * dt);
      const fluidFrac = h.fluidL / Math.max(1e-9, circuit.reservoirL);
      const pump = smoothstep((fluidFrac - FLUID_STARVE_LOW) / (FLUID_STARVE_HIGH - FLUID_STARVE_LOW));
      h.pressure = pump * (1 - BREACH_PRESSURE_LOSS * worst);
    }
  }
}

/**
 * Heat is the hottest joint in the part as a share of its motor's max temperature. Smoke builds from
 * heat above SMOKE_HEAT_START and from structural hp under SMOKE_HP: a light haze first, then thick smoke.
 */
export function heatSmokeStep(st: DamageState, dt: number): void {
  const ease = Math.min(1, dt / SMOKE_TAU_S);
  for (const rd of st.robots) {
    const joints = rd.robot.joints;
    for (const info of rd.parts.values()) {
      const part = info.part;
      let heat = 0;
      for (const i of info.jointIdx) heat = Math.max(heat, joints[i].tempC / joints[i].motor.maxTempC);
      part.heat = clamp01(heat);
      const fromHeat = clamp01((part.heat - SMOKE_HEAT_START) / (1 - SMOKE_HEAT_START));
      const fromWounds = clamp01((SMOKE_HP - part.hp) / SMOKE_HP);
      const target = clamp01(fromHeat + fromWounds);
      part.smoke += (target - part.smoke) * ease;
    }
  }
}
