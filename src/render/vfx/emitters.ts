// Turns per-part telemetry (smoke level, heat, hydraulic leak) into continuous emission:
// smoke plumes, embers and oil jets at each part's vent. Vent positions come from the
// damage module's ventWorld/ventVel; until those exist the part's body pose (or the
// robot's centre of mass) stands in, and velocity is differenced from frame to frame.
import * as THREE from 'three/webgpu';
import type { PartTelemetry, RobotTelemetry, WorldMeta } from '../../core/protocol';
import { clamp, range, toWorld, toWorldAt, type Rng } from './coords';
import { leakJetSpeed, smokeDarkness, smokeRate } from './scaling';

/** Visual oil particles per litre leaked (each particle ≈ 1 mL at the default radius). */
export const PARTICLES_PER_LITRE = 1000;
/** Hard cap on oil particles emitted per second across all leaks. */
export const MAX_OIL_PARTICLES_PER_S = 1400;
const PUMP_HZ = 6.5; // pressure pulsation of a gear pump: the jet spurts
const EMBER_SMOKE_LEVEL = 0.8;
const MAX_VENT_SPEED = 8;

export interface OilSink {
  /** Spray `count` particles from `pos` along `dir` (unit) at `speed` m/s. */
  spray(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, count: number, spread: number, inherit: THREE.Vector3): void;
}

export interface SmokeSink {
  smokePuff(pos: THREE.Vector3, vel: THREE.Vector3, level: number, dark: number, heat: number): void;
}

export interface EmberSink {
  embers(pos: THREE.Vector3, vel: THREE.Vector3, count: number): void;
}

interface VentState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  hasPrev: boolean;
  smokeCarry: number;
  oilCarry: number;
  emberCarry: number;
  phase: number;
}

interface BodyMap {
  attached: number;
  debris: number | null;
}

export class TelemetryEmitters {
  private latest: [RobotTelemetry, RobotTelemetry] | null = null;
  private poses: Float32Array | null = null;
  private readonly vents = new Map<string, VentState>();
  private bodies: Map<string, BodyMap>[] = [new Map(), new Map()];
  private time = 0;
  private readonly rng: Rng;

  constructor(rng: Rng, private readonly sinks: { smoke: SmokeSink; oil: OilSink; embers: EmberSink }) {
    this.rng = rng;
  }

  setWorld(meta: WorldMeta): void {
    this.bodies = [new Map(), new Map()];
    for (const r of meta.robots) {
      for (const p of r.parts) this.bodies[r.corner].set(p.id, { attached: p.body, debris: p.debrisBody });
    }
    this.vents.clear();
  }

  setTelemetry(tel: [RobotTelemetry, RobotTelemetry], poses: Float32Array): void {
    this.latest = tel;
    this.poses = poses;
  }

  /** Latest centre of mass of a robot in world space, if telemetry has arrived. */
  com(corner: 0 | 1, out: THREE.Vector3): THREE.Vector3 | null {
    const t = this.latest?.[corner];
    return t ? toWorld(t.comWorld, out) : null;
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.latest || dt <= 0) return;
    let oilBudget = MAX_OIL_PARTICLES_PER_S * dt;
    for (const robot of this.latest) {
      toWorld(robot.comWorld, COM);
      for (const part of robot.parts) {
        if (part.smoke <= 0.02 && part.leak <= 0) continue;
        const vent = this.vent(robot.corner, part, dt);
        this.emitSmoke(vent, part, dt);
        if (part.leak > 0 && oilBudget > 0) oilBudget -= this.emitOil(vent, part, robot, dt, oilBudget);
      }
    }
  }

  private vent(corner: number, part: PartTelemetry, dt: number): VentState {
    const key = `${corner}:${part.id}`;
    let v = this.vents.get(key);
    if (!v) {
      v = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), hasPrev: false, smokeCarry: 0, oilCarry: 0, emberCarry: 0, phase: this.rng() };
      this.vents.set(key, v);
    }
    const prev = PREV.copy(v.pos);
    this.ventPosition(corner, part, v.pos);
    if (part.ventVel) toWorld(part.ventVel, v.vel);
    else if (v.hasPrev) v.vel.copy(v.pos).sub(prev).divideScalar(Math.max(dt, 1e-3));
    v.vel.clampLength(0, MAX_VENT_SPEED);
    v.hasPrev = true;
    return v;
  }

  private ventPosition(corner: number, part: PartTelemetry, out: THREE.Vector3): void {
    if (part.ventWorld) {
      toWorld(part.ventWorld, out);
      return;
    }
    const map = this.bodies[corner].get(part.id);
    const body = map ? (part.attached ? map.attached : map.debris ?? map.attached) : null;
    if (body !== null && this.poses && body * 7 + 2 < this.poses.length) {
      toWorldAt(this.poses, body * 7, out);
      return;
    }
    out.copy(COM);
  }

  private emitSmoke(v: VentState, part: PartTelemetry, dt: number): void {
    const rate = smokeRate(part.smoke);
    if (rate <= 0) return;
    v.smokeCarry += rate * dt;
    const dark = smokeDarkness(part.smoke);
    while (v.smokeCarry >= 1) {
      v.smokeCarry -= 1;
      this.sinks.smoke.smokePuff(v.pos, v.vel, part.smoke, dark, part.heat);
    }
    if (part.smoke > EMBER_SMOKE_LEVEL && part.heat > 0.85) {
      v.emberCarry += (part.heat - 0.85) * 60 * dt;
      const n = Math.floor(v.emberCarry);
      v.emberCarry -= n;
      if (n > 0) this.sinks.embers.embers(v.pos, v.vel, n);
    }
  }

  /** Returns the particle count used. */
  private emitOil(v: VentState, part: PartTelemetry, robot: RobotTelemetry, dt: number, budget: number): number {
    const pressure = circuitPressure(robot);
    // Gear-pump pulsation: the jet surges several times a second.
    const pulse = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(Math.PI * (PUMP_HZ * this.time + v.phase))), 3);
    v.oilCarry += part.leak * PARTICLES_PER_LITRE * dt * (0.4 + 0.6 * pulse);
    const count = Math.min(Math.floor(v.oilCarry), Math.floor(budget));
    if (count <= 0) return 0;
    v.oilCarry -= count;
    // Aim outward from the robot's core and a little up, wandering like a ruptured line.
    DIR.copy(v.pos).sub(COM).setY(0);
    if (DIR.lengthSq() < 1e-6) DIR.set(this.rng() - 0.5, 0, this.rng() - 0.5);
    DIR.normalize();
    DIR.y = 0.25 + 0.15 * Math.sin(this.time * 1.7 + v.phase * 6);
    DIR.x += 0.1 * Math.sin(this.time * 2.3 + v.phase * 9);
    DIR.z += 0.1 * Math.cos(this.time * 2.9 + v.phase * 4);
    DIR.normalize();
    const speed = leakJetSpeed(pressure, part.leak) * (0.55 + 0.45 * pulse);
    const spread = clamp(0.035 + (1 - pressure) * 0.25, 0.035, 0.3) + range(this.rng, 0, 0.02);
    this.sinks.oil.spray(v.pos, DIR, speed, count, spread, v.vel);
    return count;
  }

  /** Forget vents and the last telemetry, so nothing emits until the next frame arrives. */
  clear(): void {
    this.vents.clear();
    this.latest = null;
    this.poses = null;
  }
}

/** Hydraulic pressure 0..1 driving a leak: the strongest circuit (telemetry does not say which circuit a part is on). */
function circuitPressure(robot: RobotTelemetry): number {
  const values = Object.values(robot.hydraulicPressure);
  if (values.length === 0) return 0.5;
  return Math.max(...values);
}

const COM = new THREE.Vector3();
const PREV = new THREE.Vector3();
const DIR = new THREE.Vector3();
