import { describe, expect, it } from 'vitest';
import { damageState, damageSystem } from '../../src/physics/damage';
import { makeLimp } from '../../src/physics/damage/wear';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { drain, fireRamAt, geomPos, makeRig, ofKind, step } from './helpers';

/** 10-30 s of simulated time runs 4-6 s in vitest on a busy machine; the 5 s default flakes. */
const LONG_SIM_TIMEOUT_MS = 30_000;

/** Mean available torque of a joint over n steps (smooths the speed term of the torque-speed line). */
function meanTorque(ctx: ReturnType<typeof makeRig>, corner: 0 | 1, joint: string, n: number): number {
  const r = ctx.robots[corner];
  const j = r.joints[r.jointIndex.get(joint)!];
  let sum = 0;
  step(ctx, n, () => { sum += j.availableTorque; });
  return sum / n;
}

describe('hydraulics', () => {
  it('a hit on a hydraulic forearm punctures the circuit: fluid leaks, pressure and elbow torque fall', () => {
    const ctx = makeRig({ rams: [{ name: 'ram', massKg: 30, halfSize: 0.1 }] });
    step(ctx, 400);
    const st = damageState(ctx);
    const r = ctx.robots[0]; // Bruiser: both elbows on the 'arms' circuit (210 bar, 6 L)
    const circuit = r.hydraulics.get('arms')!;
    const forearm = st.robots[0].parts.get('forearm_l')!;
    const before = meanTorque(ctx, 0, 'elbow_r', 200);
    drain(ctx);

    expect(fireRamAt(ctx, 'ram', geomPos(ctx, forearm.part.geoms[0]), [0, -1, 0], 9)).toBe(true);
    step(ctx, 100);
    const hit = ofKind(drain(ctx), 'impact').find((e) => e.part === 'forearm_l');
    expect(hit).toBeDefined();
    expect(forearm.punctured).toBe(true);
    expect(forearm.part.leak).toBeGreaterThan(0);

    const telemetry = buildTelemetry(ctx, r, [damageSystem]);
    const vent = telemetry.parts.find((p) => p.id === 'forearm_l')!;
    expect(vent.leak).toBeGreaterThan(0);
    expect(vent.ventWorld).toHaveLength(3);
    expect(vent.ventVel).toHaveLength(3);

    step(ctx, 4000);
    const after = meanTorque(ctx, 0, 'elbow_r', 200);
    const elbowR = r.joints[r.jointIndex.get('elbow_r')!];
    console.info(`[hydraulics] forearm_l hit ${hit!.impulseNs.toFixed(0)} N·s → hp ${forearm.part.hp.toFixed(3)}, leak ${forearm.part.leak.toFixed(3)} L/s; ` +
      `after 4 s: fluid ${circuit.fluidL.toFixed(2)}/6 L, pressure ${circuit.pressure.toFixed(3)}; ` +
      `undamaged elbow_r (health ${elbowR.health.toFixed(2)}) available torque ${before.toFixed(0)} → ${after.toFixed(0)} N·m`);
    expect(circuit.fluidL).toBeLessThan(6);
    expect(circuit.pressure).toBeLessThan(0.95);
    expect(elbowR.health).toBe(1); // the right elbow lost torque through pressure alone
    expect(after).toBeLessThan(before * 0.95);
  });

  it('a hydraulic circuit bled dry loses its pressure', () => {
    const ctx = makeRig();
    const st = damageState(ctx);
    const r = ctx.robots[0];
    const forearm = st.robots[0].parts.get('forearm_r')!;
    forearm.punctured = true;
    forearm.part.damage = forearm.def.hp; // wrecked: full leak
    forearm.part.hp = 0;
    step(ctx, 30000);
    const circuit = r.hydraulics.get('arms')!;
    console.info(`[hydraulics] wide-open breach, 30 s: fluid ${circuit.fluidL.toFixed(2)} L, pressure ${circuit.pressure.toFixed(3)}`);
    expect(circuit.pressure).toBeLessThan(0.05);
  }, LONG_SIM_TIMEOUT_MS);
});

describe('smoke', () => {
  it('a badly damaged part smokes, lightly at first then thick', () => {
    const ctx = makeRig();
    const st = damageState(ctx);
    const torso = st.robots[1].parts.get('torso')!;
    torso.part.hp = 0.3; // under the 40% hp line
    step(ctx, 200);
    const early = torso.part.smoke;
    torso.part.hp = 0.02;
    step(ctx, 3000);
    const late = torso.part.smoke;
    const t = buildTelemetry(ctx, ctx.robots[1], [damageSystem]).parts.find((p) => p.id === 'torso')!;
    console.info(`[smoke] torso hp 0.30 → smoke ${early.toFixed(3)} after 0.2 s; hp 0.02 → ${late.toFixed(3)} after 3 s; vent ${t.ventWorld?.map((x) => x.toFixed(2))}`);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.3);
    expect(late).toBeGreaterThan(0.9);
    expect(t.ventWorld).toBeDefined();
  });

  it('a motor running hot makes its part smoke', () => {
    const ctx = makeRig();
    const r = ctx.robots[0];
    const knee = r.joints[r.jointIndex.get('knee_l')!];
    step(ctx, 10, () => { knee.tempC = knee.motor.maxTempC * 0.97; });
    step(ctx, 2000, () => { knee.tempC = knee.motor.maxTempC * 0.97; });
    const shin = r.parts.get('shin_l')!;
    expect(shin.heat).toBeGreaterThan(0.9);
    expect(shin.smoke).toBeGreaterThan(0.5);
    expect(r.parts.get('shin_r')!.smoke).toBe(0);
  });
});

describe('knockouts', () => {
  it('fires down, power and disabled once each, and never twice for a robot', () => {
    const down = makeRig();
    down.released = true;
    down.robots[0].down = true;
    step(down, 9900);
    expect(ofKind(drain(down), 'ko')).toHaveLength(0);
    step(down, 300);
    expect(ofKind(drain(down), 'ko')).toEqual([{ kind: 'ko', corner: 0, reason: 'down' }]);
    expect(down.robots[0].koReason).toBe('down');
    down.robots[0].battery = 0;
    step(down, 100);
    expect(ofKind(drain(down), 'ko')).toHaveLength(0);

    const power = makeRig();
    power.robots[1].battery = 0;
    step(power, 20);
    expect(ofKind(drain(power), 'ko')).toEqual([{ kind: 'ko', corner: 1, reason: 'power' }]);

    const disabled = makeRig();
    const r = disabled.robots[1];
    const limbJoints = r.joints.flatMap((j, i) => (/^(shoulder|elbow|hip|knee|ankle)_/.test(j.name) ? [i] : []));
    for (const i of limbJoints.slice(0, -4)) makeLimp(disabled, r, i); // three and a bit limbs: not yet
    step(disabled, 20);
    expect(ofKind(drain(disabled), 'ko')).toHaveLength(0);
    for (const i of limbJoints) makeLimp(disabled, r, i);
    step(disabled, 20);
    expect(ofKind(drain(disabled), 'ko')).toEqual([{ kind: 'ko', corner: 1, reason: 'disabled' }]);
  }, LONG_SIM_TIMEOUT_MS);
});
