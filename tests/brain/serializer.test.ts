import { describe, expect, test } from 'vitest';
import * as B from '../../src/brain/bands';
import { designReach } from '../../src/brain/geometry';
import { FightObserver } from '../../src/brain/observer';
import { serializeState } from '../../src/brain/serializer';
import { coarseKey, makeFighterContext, readSituation } from '../../src/brain/situation';
import { frame, RED_SETUP, scene } from './fixtures';

const CLOCK = { round: 2, rounds: 3, remainingS: 108 };

function stateAt(distance: number, opts: Parameters<typeof frame>[3] = {}) {
  const sc = scene();
  const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
  const f = frame(sc, 10, distance, opts);
  const s = readSituation(fc, f);
  return { fc, s, state: serializeState(fc, s, [], CLOCK, 'jab') };
}

describe('bands', () => {
  test('distance bands scale with the fighter\'s reach', () => {
    const reach = 1.0;
    expect(B.distanceBand(0.4, reach)).toBe('clinch');
    expect(B.distanceBand(1.0, reach)).toBe('striking range');
    expect(B.distanceBand(1.5, reach)).toBe('just outside reach');
    expect(B.distanceBand(2.5, reach)).toBe('mid range');
    expect(B.distanceBand(5, reach)).toBe('far');
  });

  test('bearing reads as a clock face: ahead 12, right 3, left 9, behind 6', () => {
    expect(B.clockHour(0)).toBe(12);
    expect(B.clockHour(-Math.PI / 2)).toBe(3);
    expect(B.clockHour(Math.PI / 2)).toBe(9);
    expect(B.clockHour(Math.PI)).toBe(6);
    expect(B.clockHour(-Math.PI / 6)).toBe(1);
  });

  test('closing speed, cage and resource bands', () => {
    expect(B.closingBand(2)).toBe('closing fast');
    expect(B.closingBand(0)).toBe('steady');
    expect(B.closingBand(-2)).toBe('separating fast');
    expect(B.cageWords(0.2, Math.PI)).toBe('back against the cage');
    expect(B.cageWords(3, 0)).toBe('open space around you');
    expect(B.batteryWords(0.15)).toBe('battery critical');
    expect(B.gyroWords(1, 0.95)).toContain('saturated');
    expect(B.heatWords(105, 120)).toBe('overheating, throttled');
    expect(B.heatWords(40, 120)).toBeNull();
  });

  test('names are humanized from part and joint ids', () => {
    expect(B.partName('upperarm_l')).toBe('left upper arm');
    expect(B.jointGroupName('shoulder_pitch_r')).toBe('right shoulder');
    expect(B.jointGroupName('knee_l')).toBe('left knee');
  });

  test('reach comes from the design\'s limbs (a kickboxer out-reaches a boxer)', () => {
    const sc = scene();
    expect(designReach(sc.red)).toBeGreaterThan(0.8);
    expect(designReach(sc.blue)).toBeGreaterThan(designReach(sc.red) * 0.95);
  });
});

describe('serializeState', () => {
  test('contains no raw floats, only words', () => {
    const { state } = stateAt(1.1, { blue: { velocity: [-1.234, 0.5, 0], windup: 0.42, skill: 'strike.low_kick' } });
    const json = JSON.stringify(state);
    expect(json).not.toMatch(/\d\.\d/);
    expect(state.opponent.phase).toBe('winding up a low kick, about halfway');
    expect(state.geometry.bearing).toBe("opponent at your 12 o'clock");
    expect(state.round).toEqual({ round: '2 of 3', clock: 'early in the round' });
  });

  test('damage map in words, worst first', () => {
    const sc = scene();
    const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
    const f = frame(sc, 10, 1.1);
    const me = f.telemetry[0];
    me.joints = me.joints.map((j) => (j.name === 'knee_l' ? { ...j, health: 0.55, state: 'degraded' } : j));
    me.parts = me.parts.map((p) => (p.id === 'head' ? { ...p, hp: 0.45 } : p.id === 'forearm_r' ? { ...p, leak: 0.2 } : p));
    const opp = f.telemetry[1];
    opp.parts = opp.parts.map((p) => (p.id === 'forearm_l' ? { ...p, attached: false } : p));
    const state = serializeState(fc, readSituation(fc, f), [], CLOCK, null);
    expect(state.you.damage).toContain('left knee actuator at 55% torque');
    expect(state.you.damage).toContain('head armor cracked');
    expect(state.you.damage).toContain('right forearm leaking hydraulic oil');
    expect(state.opponent.damage).toContain('left forearm torn off');
  });

  test('heat bands use the joint motor\'s rated temperature', () => {
    const sc = scene();
    const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
    const f = frame(sc, 10, 1.1);
    f.telemetry[0].joints = f.telemetry[0].joints.map((j) => (j.name === 'shoulder_pitch_r' ? { ...j, tempC: 125 } : j));
    const state = serializeState(fc, readSituation(fc, f), [], CLOCK, null);
    expect(state.you.damage).toContain('right shoulder overheating, throttled');
  });

  test('balance, down and gyro saturation are described', () => {
    const { state } = stateAt(2, { red: { down: true, gyroSaturation: 0.95 } });
    expect(state.you.balance).toBe('down on the canvas');
    expect(state.you.power).toContain('gyro saturated');
  });

  test('includes the fighter\'s own plan and temperament, never the opponent\'s text', () => {
    const { state, fc } = stateAt(1.5);
    expect(state.plan).toBe(RED_SETUP.plan);
    expect(state.personality).toBe('balanced, trusts the read');
    // The opponent is described from catalog tags and telemetry, never its builder's name or tagline.
    const json = JSON.stringify(state);
    expect(json).not.toContain(fc.oppDesign.tagline);
    expect(json).not.toContain(fc.oppDesign.name);
    expect(state.opponent.name).toBe('the blue corner fighter');
  });

  test('plan is capped at 150 words', () => {
    const sc = scene();
    const fc = makeFighterContext(0, sc.red, sc.blue, { ...RED_SETUP, plan: 'jab '.repeat(400) });
    const state = serializeState(fc, readSituation(fc, frame(sc, 1, 2)), [], CLOCK, null);
    expect(state.plan.split(' ').length).toBe(150);
  });

  test('cage proximity and opponent facing', () => {
    const sc = scene();
    const fc = makeFighterContext(0, sc.red, sc.blue, RED_SETUP);
    // Red backed onto the -x fence (apothem 4.25 m), facing +x toward blue.
    const f = frame(sc, 1, 1.2, { red: { comWorld: [-4.0, 0, 1], heading: 0 }, blue: { comWorld: [-2.8, 0, 1], heading: 0 } });
    const state = serializeState(fc, readSituation(fc, f), [], CLOCK, null);
    expect(state.geometry.cage).toBe('back against the cage');
    expect(state.opponent.facing).toBe('his back to you');
  });

  test('coarse key tracks band, opponent phase and own balance', () => {
    const a = stateAt(1.1).s;
    const b = stateAt(1.1, { blue: { windup: 0.5, skill: 'jab' } }).s;
    const c = stateAt(4).s;
    expect(coarseKey(a)).not.toBe(coarseKey(b));
    expect(coarseKey(a)).not.toBe(coarseKey(c));
    expect(coarseKey(a)).toBe(coarseKey(stateAt(1.12).s));
  });

  test('observer records the opponent\'s recent actions from physics skills', () => {
    const sc = scene();
    const obs = new FightObserver(0);
    obs.update(frame(sc, 1, 1.2, { blue: { skill: 'jab' } }));
    obs.update(frame(sc, 1.1, 1.2, { blue: { skill: 'jab' } }));
    obs.update(frame(sc, 1.5, 1.2, { blue: { skill: 'idle' } }));
    obs.update(frame(sc, 2, 1.2, { blue: { skill: 'low_kick' } }));
    const recent = obs.recentActions(2.2);
    expect(recent.map((r) => r.action)).toEqual(['low_kick', 'jab']);
  });
});
