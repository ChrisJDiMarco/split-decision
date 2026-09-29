import { describe, expect, it } from 'vitest';
import type { JointState } from '../../src/core/protocol';
import { damageState } from '../../src/physics/damage';
import { MAX_SLOP_RAD, OVERLOAD_FACTOR } from '../../src/physics/damage/constants';
import { armLoadPath, overloadStep } from '../../src/physics/damage/wear';
import { drain, fireRamAt, geomPos, makeRig, ofKind, step } from './helpers';

describe('joint damage', () => {
  it('repeated gear overloads degrade a joint through degraded to limp', () => {
    const ctx = makeRig();
    step(ctx, 200);
    drain(ctx);
    const st = damageState(ctx);
    const r = ctx.robots[1]; // Striker: RobStride 04 elbows, 120 N·m stall
    const forearm = st.robots[1].parts.get('forearm_l')!;
    const ji = r.jointIndex.get('elbow_l')!;
    const elbow = r.joints[ji];
    const stall = elbow.motor.stallTorqueNm;
    const PULSE_TICKS = 20; // a 20 ms back-drive at 5× stall, then 20 ms of relief
    const states: JointState[] = [];
    let pulses = 0;
    while (elbow.state !== 'limp' && pulses < 500) {
      pulses++;
      for (let k = 0; k < 2 * PULSE_TICKS; k++) {
        ctx.tick++;
        armLoadPath(forearm, ctx.tick);
        ctx.data.qfrc_constraint[elbow.dadr] = k < PULSE_TICKS ? 5 * stall : 0;
        overloadStep(ctx, st);
      }
      if (states[states.length - 1] !== elbow.state) states.push(elbow.state);
    }
    const events = ofKind(drain(ctx), 'joint').filter((e) => e.joint === 'elbow_l');
    console.info(`[overload] elbow_l (${stall} N·m stall): ${pulses} pulses of 20 ms @ 5× stall to limp; states ${states.join(' → ')}`);
    expect(elbow.state).toBe('limp');
    expect(states).toEqual(['ok', 'degraded', 'limp']);
    expect(events.map((e) => e.state)).toEqual(['degraded', 'limp']);
    expect(elbow.slop).toBeGreaterThan(0.9 * MAX_SLOP_RAD);
    expect(pulses).toBeGreaterThan(10); // one overload is a dent, not a write-off
  });

  it('back-driving below 2× stall and unarmed joints take no gear damage', () => {
    const ctx = makeRig();
    const st = damageState(ctx);
    const r = ctx.robots[1];
    const forearm = st.robots[1].parts.get('forearm_l')!;
    const elbow = r.joints[r.jointIndex.get('elbow_l')!];
    for (let k = 0; k < 200; k++) {
      ctx.tick++;
      if (k < 100) armLoadPath(forearm, ctx.tick);
      // armed but under the limit, then over the limit but not on an impact's load path
      ctx.data.qfrc_constraint[elbow.dadr] = (k < 100 ? 0.95 * OVERLOAD_FACTOR : 5) * elbow.motor.stallTorqueNm;
      overloadStep(ctx, st);
    }
    expect(elbow.health).toBe(1);
  });

  it('real hits on a fist overload and wear out the arm joints', () => {
    const ctx = makeRig({ rams: [{ name: 'ram', massKg: 25, halfSize: 0.1 }] });
    step(ctx, 300);
    drain(ctx);
    const st = damageState(ctx);
    const r = ctx.robots[1];
    const fist = st.robots[1].parts.get('fist_l')!;
    const arm = ['shoulder_pitch_l', 'shoulder_roll_l', 'shoulder_yaw_l', 'elbow_l'].map((n) => r.joints[r.jointIndex.get(n)!]);
    let peak = 0;
    let hits = 0;
    const log: string[] = [];
    while (!arm.some((j) => j.state === 'limp') && hits < 60) {
      hits++;
      expect(fireRamAt(ctx, 'ram', geomPos(ctx, fist.part.geoms[0]), [0, 0, -1], 8)).toBe(true);
      step(ctx, 200, () => {
        for (const j of arm) peak = Math.max(peak, Math.abs(ctx.data.qfrc_constraint[j.dadr]) / j.motor.stallTorqueNm);
      });
      if (hits % 5 === 0) log.push(`${hits}:${arm.map((j) => j.health.toFixed(2)).join('/')}`);
    }
    const events = ofKind(drain(ctx), 'joint');
    console.info(`[fist hits] 25 kg @ 8 m/s down onto fist_l: ${hits} hits until a limp arm joint; peak back-drive ${peak.toFixed(1)}× stall; ` +
      `health (sh_pitch/sh_roll/sh_yaw/elbow) by hit ${log.join('  ')}; joint events ${events.map((e) => `${e.joint}:${e.state}`).join(', ')}`);
    expect(peak).toBeGreaterThan(OVERLOAD_FACTOR);
    expect(arm.some((j) => j.state === 'limp')).toBe(true);
    expect(hits).toBeGreaterThan(3);
  });
});
