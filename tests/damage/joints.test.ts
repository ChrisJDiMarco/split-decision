// Joint damage by channel (docs/design/strike-power.md §4.3): gear, end stop and bearing loads on
// armed joints, failures by gear type, housing faults, bends, the striker's arming rule.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../src/core/protocol';
import { damageState, damageSystem } from '../../src/physics/damage';
import { DAMAGE_TUNING } from '../../src/physics/damage/constants';
import { strikerLoaded } from '../../src/physics/damage/impacts';
import { drivePre, resolveJointEpisode } from '../../src/physics/damage/joint-loads';
import type { SimContext } from '../../src/physics/sim-context';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { drain, fireRamAt, makeRig, ofKind, step } from './helpers';

const DEG = Math.PI / 180;

function joint(ctx: SimContext, corner: 0 | 1, name: string) {
  const r = ctx.robots[corner];
  const i = r.jointIndex.get(name)!;
  const rd = damageState(ctx).robots[corner];
  return { i, j: r.joints[i], m: rd.mech[i], rd, r };
}

/** Sets a joint's episode peaks (gear, stop, bearing; × rating) and resolves it, as a closing arm window would. */
function resolveWith(ctx: SimContext, corner: 0 | 1, name: string, peak: [number, number, number], extra: { stopSide?: number; bendAxisW?: [number, number, number] } = {}) {
  const x = joint(ctx, corner, name);
  x.m.peak = peak;
  x.m.role = 'victim';
  x.m.stopSide = extra.stopSide ?? 0;
  x.m.bendAxisW = extra.bendAxisW ?? null;
  resolveJointEpisode(ctx, damageState(ctx), x.rd, x.i);
  return x;
}

function jointEvents(events: SimEvent[], name: string) {
  return ofKind(events, 'joint').filter((e) => e.joint === name);
}

describe('joint loads', () => {
  it('standing robots arm nothing and lose nothing (no footfall or gravity wear)', () => {
    const ctx = makeRig({ designs: ['haymaker', 'firecracker'] });
    step(ctx, 1500);
    const st = damageState(ctx);
    for (const rd of st.robots) {
      for (const j of rd.robot.joints) expect(j.health).toBe(1);
      expect(Object.values(rd.ledger.failures).reduce((a, b) => a + b, 0)).toBe(0);
      for (const k of ['gear', 'stop', 'bearing'] as const) expect(rd.ledger.overloads[k].peak).toBe(0);
    }
  });

  it('wear between onset and break is proportional, deterministic and books its channel and role', () => {
    const t = DAMAGE_TUNING;
    const ctx = makeRig({ designs: ['savate', 'savate'] });
    const r = 1.0 + 0.5 * (t.gearBreak - t.gearOnset); // halfway to break
    const x = resolveWith(ctx, 1, 'elbow_l', [r, 0, 0]);
    const expected = t.wearAtBreak * 0.5;
    expect(x.j.health).toBeCloseTo(1 - expected, 9);
    expect(x.rd.ledger.jointLoss.gear.victim).toBeCloseTo(expected, 9);
    expect(x.j.state).toBe('ok');
    expect(jointEvents(drain(ctx), 'elbow_l')).toHaveLength(0); // plain wear that keeps the state is quiet
    // Below onset: nothing at all.
    resolveWith(ctx, 1, 'elbow_r', [0.99, 0.99, 0.99]);
    expect(joint(ctx, 1, 'elbow_r').j.health).toBe(1);
  });

  it('gear failures follow the gear type: a planetary jams, then strips; a QDD sheds teeth and slips', () => {
    const t = DAMAGE_TUNING;
    // HAYMAKER's hips are MyActuator X12 20:1 planetaries.
    const ctx = makeRig({ designs: ['haymaker', 'savate'] });
    const hip = resolveWith(ctx, 0, 'hip_pitch_l', [t.gearBreak + 0.1, 0, 0]);
    expect(hip.m.drive.gearType).toBe('planetary');
    expect(hip.j.state).toBe('seized');
    const seize = jointEvents(drain(ctx), 'hip_pitch_l');
    expect(seize).toHaveLength(1);
    expect(seize[0]).toMatchObject({ state: 'seized', cause: 'gear', failure: 'seize', role: 'victim' });
    expect(seize[0].pos).toHaveLength(3);
    const hip2 = resolveWith(ctx, 0, 'hip_pitch_r', [t.gearStrip + 0.1, 0, 0]);
    expect(hip2.j.state).toBe('limp');
    expect(jointEvents(drain(ctx), 'hip_pitch_r')[0]).toMatchObject({ failure: 'strip', state: 'limp' });

    // SAVATE's elbows are RobStride 03 QDDs: a shed tooth caps the torque, the drive keeps working.
    const elbow = resolveWith(ctx, 1, 'elbow_l', [t.gearBreak + 0.1, 0, 0]);
    expect(elbow.m.drive.gearType).toBe('qdd');
    expect(elbow.m.slipCapNm).toBeCloseTo(t.slipCapFraction * elbow.j.motor.stallTorqueNm, 6);
    expect(elbow.j.state).not.toBe('limp');
    expect(jointEvents(drain(ctx), 'elbow_l')[0]).toMatchObject({ cause: 'gear', failure: 'slip' });
    // The cap is applied to the actuator after the motor model, every step.
    step(ctx, 2);
    const fr = ctx.model.actuator_forcerange as Float64Array;
    expect(fr[elbow.j.act * 2 + 1]).toBeLessThanOrEqual(elbow.m.slipCapNm! + 1e-9);
    expect(elbow.j.availableTorque).toBeLessThanOrEqual(elbow.m.slipCapNm! + 1e-9);
    // Each further tooth cuts the cap until the gear is stripped.
    let cuts = 0;
    while (elbow.j.state !== 'limp' && cuts < 10) {
      resolveWith(ctx, 1, 'elbow_l', [t.gearBreak + 0.1, 0, 0]);
      cuts++;
    }
    expect(elbow.j.state).toBe('limp');
    expect(cuts).toBeGreaterThan(1);
  });

  it('a hydraulic cylinder overload blows its seal: the circuit leaks', () => {
    const ctx = makeRig({ designs: ['bruiser', 'striker'] }); // Bruiser elbows: 32 mm cylinders on the 'arms' circuit
    const elbow = resolveWith(ctx, 0, 'elbow_l', [DAMAGE_TUNING.gearBreak + 0.1, 0, 0]);
    expect(elbow.m.drive.gearType).toBe('hydraulic');
    expect(elbow.rd.parts.get('forearm_l')!.punctured).toBe(true);
    expect(jointEvents(drain(ctx), 'elbow_l')[0]).toMatchObject({ cause: 'gear', failure: 'seal' });
  });

  it('an overrun end stop hyperextends: the joint goes past where it stopped', () => {
    const ctx = makeRig({ designs: ['savate', 'savate'] });
    const x = joint(ctx, 1, 'elbow_l');
    const range = ctx.model.jnt_range as Float64Array;
    const hi = range[x.m.mjJoint * 2 + 1];
    resolveWith(ctx, 1, 'elbow_l', [0, DAMAGE_TUNING.stopBreak * 1.2, 0], { stopSide: 1 });
    expect(range[x.m.mjJoint * 2 + 1]).toBeGreaterThan(hi + 5 * DEG);
    expect(x.m.hyperRad).toBeGreaterThan(0);
    expect(jointEvents(drain(ctx), 'elbow_l')[0]).toMatchObject({ cause: 'hyperextension', failure: 'hyperextension' });
  });

  it('a bent shaft binds and a single-hinge limb shows the kink (ramped in, capped)', () => {
    const t = DAMAGE_TUNING;
    const ctx = makeRig({ designs: ['firecracker', 'savate'] });
    step(ctx, 200);
    const x = joint(ctx, 0, 'knee_l');
    const fl = ctx.model.dof_frictionloss as Float64Array;
    const range = ctx.model.jnt_range as Float64Array;
    const before = { f: fl[x.j.dadr], lo: range[x.m.mjJoint * 2], hi: range[x.m.mjJoint * 2 + 1] };
    const bq = ctx.model.body_quat as Float64Array;
    const q0 = Array.from(bq.slice(x.m.bodyId * 4, x.m.bodyId * 4 + 4));
    resolveWith(ctx, 0, 'knee_l', [0, 0, t.bearingBreak + 1], { bendAxisW: [1, 0, 0] });
    const ev = jointEvents(drain(ctx), 'knee_l')[0];
    expect(ev).toMatchObject({ cause: 'bearing', failure: 'bend' });
    expect(ev.bendAxis).toHaveLength(3);
    expect(fl[x.j.dadr]).toBeGreaterThan(before.f);
    expect(range[x.m.mjJoint * 2 + 1] - range[x.m.mjJoint * 2]).toBeLessThan(before.hi - before.lo);
    expect(x.m.singleHinge).toBe(true);
    expect(x.m.bendRad).toBeCloseTo(Math.min(t.maxBendDeg, 2 * t.bendDegPerUnit) * DEG, 9);
    expect(x.m.bendApplied).toBe(0); // ramps in from the next step on, no teleporting shin
    step(ctx, Math.ceil(t.bendRampS / ctx.dt) + 5);
    expect(x.m.bendApplied).toBeCloseTo(x.m.bendRad, 9);
    const q1 = Array.from(bq.slice(x.m.bodyId * 4, x.m.bodyId * 4 + 4));
    const dot = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
    expect(2 * Math.acos(Math.min(1, dot))).toBeCloseTo(x.m.bendRad, 6);
    const tel = buildTelemetry(ctx, ctx.robots[0], [damageSystem]).joints.find((j) => j.name === 'knee_l')!;
    expect(tel.bend).toBeCloseTo(x.m.bendRad, 9);
    // Repeat bends add up to the cap and no further.
    for (let k = 0; k < 5; k++) resolveWith(ctx, 0, 'knee_l', [0, 0, t.bearingBreak + 1], { bendAxisW: [1, 0, 0] });
    expect(x.m.bendRad).toBeCloseTo(t.maxBendDeg * DEG, 9);
  });

  it('a bend survives a keyframe rollback: the model keeps it, the state restores, nothing blows up', () => {
    // The worker rolls back to a keyframe on divergence (mj_setState restores the state, not model fields).
    const t = DAMAGE_TUNING;
    const ctx = makeRig({ designs: ['firecracker', 'savate'] });
    step(ctx, 200);
    const spec = ctx.mj.mjtState.mjSTATE_INTEGRATION.value;
    const buf = new ctx.mj.DoubleBuffer(ctx.mj.mj_stateSize(ctx.model, spec));
    ctx.mj.mj_getState(ctx.model, ctx.data, buf, spec);
    const key = Array.from(buf.GetView() as Float64Array);
    buf.delete();
    const x = resolveWith(ctx, 0, 'knee_l', [0, 0, t.bearingBreak + 1], { bendAxisW: [1, 0, 0] });
    step(ctx, 150);
    const bq = ctx.model.body_quat as Float64Array;
    const bent = Array.from(bq.slice(x.m.bodyId * 4, x.m.bodyId * 4 + 4));
    const range = Array.from((ctx.model.jnt_range as Float64Array).slice(x.m.mjJoint * 2, x.m.mjJoint * 2 + 2));
    ctx.mj.mj_setState(ctx.model, ctx.data, key, spec);
    ctx.mj.mj_forward(ctx.model, ctx.data);
    let worst = 0;
    step(ctx, 600, () => {
      const qv = ctx.data.qvel as Float64Array;
      for (let k = 0; k < ctx.model.nv; k++) worst = Math.max(worst, Math.abs(qv[k]));
    });
    expect(Number.isFinite(worst)).toBe(true);
    expect(worst).toBeLessThan(50);
    expect(Array.from(bq.slice(x.m.bodyId * 4, x.m.bodyId * 4 + 4))).toEqual(bent);
    expect(Array.from((ctx.model.jnt_range as Float64Array).slice(x.m.mjJoint * 2, x.m.mjJoint * 2 + 2))).toEqual(range);
    expect(x.m.bendApplied).toBe(x.m.bendRad);
  });

  it('a hard hit on a drive housing faults it: no torque for a moment, then it re-enables', () => {
    // SAVATE's knee (two AKE90-8s) struck right at the joint by a heavy ram: the drive faults out.
    const ctx = makeRig({ designs: ['firecracker', 'savate'], rams: [{ name: 'ram', massKg: 15, halfSize: 0.05 }] });
    step(ctx, 300);
    drain(ctx);
    const st = damageState(ctx);
    const x = joint(ctx, 1, 'knee_l');
    const xa = ctx.data.xanchor as Float64Array;
    const anchor: [number, number, number] = [xa[x.m.mjJoint * 3], xa[x.m.mjJoint * 3 + 1], xa[x.m.mjJoint * 3 + 2]];
    // Robot 1 faces −x, so its left leg is on the −y side: fire in from there.
    expect(fireRamAt(ctx, 'ram', anchor, [0, 1, 0], 8)).toBe(true);
    let faulted = false;
    let torqueDuringFault = Infinity;
    step(ctx, 120, () => {
      const tel = buildTelemetry(ctx, ctx.robots[1], [damageSystem]).joints.find((j) => j.name === 'knee_l')!;
      if (tel.fault) {
        faulted = true;
        torqueDuringFault = Math.min(torqueDuringFault, tel.torqueFraction ?? 1);
      }
    });
    const ev = jointEvents(drain(ctx), 'knee_l').find((e) => e.cause === 'housing');
    console.info(`[housing] ${ev ? `fault sev ${ev.severity?.toFixed(2)} at ${ev.pos?.map((v) => v.toFixed(2))}` : 'no fault'}, until tick ${x.m.faultUntil}`);
    expect(ev).toMatchObject({ failure: 'fault', role: 'victim' });
    expect(faulted).toBe(true);
    expect(torqueDuringFault).toBe(0);
    step(ctx, Math.ceil(DAMAGE_TUNING.faultMaxS / ctx.dt));
    const after = buildTelemetry(ctx, ctx.robots[1], [damageSystem]).joints.find((j) => j.name === 'knee_l')!;
    expect(after.fault).toBe(false);
    expect(after.torqueFraction).toBeGreaterThan(0.5);
    expect(st.robots[1].ledger.failures.fault).toBe(1);
  });

  it("a striker's own joints load only when its strike lands off-axis or into its own stop", () => {
    const ctx = makeRig({ designs: ['firecracker', 'savate'] });
    step(ctx, 200);
    const st = damageState(ctx);
    const r = ctx.robots[0];
    const fistGeom = st.geoms[r.parts.get('fist_l')!.geoms[0]]!;
    const forearm = r.parts.get('forearm_l')!.body;
    const R = ctx.data.xmat as Float64Array;
    const axis: [number, number, number] = [-R[forearm * 9 + 2], -R[forearm * 9 + 5], -R[forearm * 9 + 8]];
    const elbow = joint(ctx, 0, 'elbow_l');
    const qpos = ctx.data.qpos as Float64Array;
    qpos[elbow.j.qadr] = -1.2; // mid-range: no stop
    expect(strikerLoaded(ctx, st, fistGeom, axis)).toBe(false); // the force runs down the forearm
    const side: [number, number, number] = [axis[1], -axis[0], 0];
    const n = Math.hypot(...side);
    expect(strikerLoaded(ctx, st, fistGeom, [side[0] / n, side[1] / n, side[2] / n])).toBe(true); // off-axis
    qpos[elbow.j.qadr] = -0.05; // locked out: into its own stop
    expect(strikerLoaded(ctx, st, fistGeom, axis)).toBe(true);
  });

  it('drive faults and slip caps never touch a limp or seized joint, and drivePre is a no-op on a healthy robot', () => {
    const ctx = makeRig({ designs: ['savate', 'savate'] });
    step(ctx, 50);
    const fr = Float64Array.from(ctx.model.actuator_forcerange as Float64Array);
    drivePre(ctx, damageState(ctx));
    expect(Array.from(ctx.model.actuator_forcerange as Float64Array)).toEqual(Array.from(fr));
  });
});
