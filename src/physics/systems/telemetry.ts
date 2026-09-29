// Builds the per-robot telemetry snapshot sent to the main thread every frame.
import type { PartTelemetry, RobotTelemetry } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import type { RobotRuntime, SimContext, SimSystem } from '../sim-context';

function vec(arr: ArrayLike<number>, i: number): Vec3 {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

/** Upright = cosine between the torso's up axis and world up, mapped to 0..1. */
function uprightness(ctx: SimContext, r: RobotRuntime): number {
  const torso = r.parts.get('torso') ?? r.parts.get('chassis');
  const body = torso ? torso.body : r.rootBody;
  const zz = ctx.data.xmat[body * 9 + 8]; // R[2][2]
  return Math.max(0, Math.min(1, zz));
}

export function buildTelemetry(ctx: SimContext, r: RobotRuntime, systems: readonly SimSystem[]): RobotTelemetry {
  const { data, model } = ctx;
  const q = r.rootQadr;
  const qw = data.qpos[q + 3], qx = data.qpos[q + 4], qy = data.qpos[q + 5], qz = data.qpos[q + 6];
  const heading = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
  const parts: PartTelemetry[] = [];
  for (const p of r.parts.values()) {
    parts.push({ id: p.id, hp: p.hp, smoke: p.smoke, heat: p.heat, attached: p.attached, leak: p.leak });
  }
  const totalHp = parts.reduce((s, p) => s + p.hp, 0) / Math.max(1, parts.length);
  const out: RobotTelemetry = {
    corner: r.corner,
    upright: uprightness(ctx, r),
    balance: 1,
    down: r.down,
    comWorld: vec(data.subtree_com, r.rootBody),
    heading,
    velocity: [data.qvel[r.rootDadr], data.qvel[r.rootDadr + 1], data.qvel[r.rootDadr + 2]],
    battery: r.battery,
    gyroHealth: r.gyro?.health ?? 0,
    gyroSaturation: r.gyro?.saturation ?? 0,
    hydraulicPressure: Object.fromEntries([...r.hydraulics].map(([id, h]) => [id, h.pressure])),
    skill: r.skill,
    skillPhase: r.skillPhase,
    windup: r.windup,
    parts,
    joints: r.joints.map((j) => ({
      name: j.name,
      health: j.health,
      state: j.state,
      tempC: j.tempC,
      torqueFrac: Math.min(1, Math.abs(data.actuator_force[j.act]) / Math.max(1e-6, j.availableTorque)),
    })),
    damageTotal: 1 - totalHp,
    intent: r.intent,
  };
  void model;
  for (const s of systems) s.telemetry?.(ctx, r, out);
  return out;
}
