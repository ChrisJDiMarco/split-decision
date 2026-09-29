// Stance hysteresis, planted-read move risk, and side-on vs turned-away, on hand-built snapshots
// (the rules are pure functions of BodySnapshots) plus one real walking fight.
import { describe, expect, test } from 'vitest';
import { sparringIntent } from '../../src/physics/control';
import { detectOpenings, heldStance, moveRisks, newStanceMemory, snapshot, stanceOf, STANCE_HOLD_S, type BodySnapshot } from '../../src/physics/openings';
import { riskInputs, settleRisk } from '../../src/physics/openings';
import { SYSTEMS } from '../../src/physics/systems';
import { buildTelemetry } from '../../src/physics/systems/telemetry';
import { makeSim } from '../control/helpers';

function body(corner: 0 | 1, over: Partial<BodySnapshot> = {}): BodySnapshot {
  const x = corner === 0 ? -0.8 : 0.8;
  const dir = corner === 0 ? 1 : -1;
  return {
    corner, time: 0, com: [x, 0, 0.9], comVel: [0, 0, 0], torsoYaw: corner === 0 ? 0 : Math.PI,
    balance: 0.9, stepping: false, planted: true, upright: 1, gyro: { health: 1, saturation: 0.2 }, battery: 1, massKg: 70,
    down: false, ko: false, rising: false, skill: null, fistZ: { l: 1.4, r: 1.4 }, chinZ: 1.3,
    // orthodox: the left foot nearer the opponent
    feet: { l: [x + dir * 0.15, 0.1, 0.05], r: [x - dir * 0.15, -0.1, 0.05] },
    joints: [], ...over,
  };
}

const southpawFeet = (b: BodySnapshot): BodySnapshot['feet'] => ({ l: b.feet!.r, r: b.feet!.l });

describe('stance hysteresis', () => {
  test('a lead swap mid-step is ignored; a new lead held planted for 0.4 s is published', () => {
    const opp = body(1);
    const mem = newStanceMemory();
    const ortho = body(0);
    const south = { ...ortho, feet: southpawFeet(ortho) };
    expect(heldStance(mem, { ...ortho, time: 0 }, opp)).toBe('orthodox');
    // Walking: the feet swap every step, planted only briefly each time.
    for (let t = 0.1; t < 3; t += 0.3) {
      expect(heldStance(mem, { ...south, time: t, planted: false, stepping: true }, opp)).toBe('orthodox');
      expect(heldStance(mem, { ...south, time: t + 0.1 }, opp)).toBe('orthodox'); // planted southpaw, but not for long
      expect(heldStance(mem, { ...ortho, time: t + 0.2 }, opp)).toBe('orthodox');
    }
    // A real switch: southpaw, planted, for the hold time.
    expect(heldStance(mem, { ...south, time: 5 }, opp)).toBe('orthodox');
    expect(heldStance(mem, { ...south, time: 5 + STANCE_HOLD_S / 2 }, opp)).toBe('orthodox');
    expect(heldStance(mem, { ...south, time: 5 + STANCE_HOLD_S }, opp)).toBe('southpaw');
    expect(stanceOf(south, opp)).toBe('southpaw');
  });

  test('move risk reads balance and gyro load from planted moments only, smoothed', () => {
    const held = { balance: 1, saturation: 0, at: null as number | null };
    const planted = body(0, { balance: 0.9, gyro: { health: 1, saturation: 0.2 } });
    const base = moveRisks(riskInputs(held, planted)).spinning_back_kick;
    // Mid-step the margin dips by design and the gyro loads up: the published risk does not move.
    const midStep = body(0, { time: 0.2, planted: false, stepping: true, balance: 0.25, gyro: { health: 1, saturation: 0.7 } });
    expect(moveRisks(riskInputs(held, midStep)).spinning_back_kick).toBeCloseTo(base, 6);
    expect(moveRisks(midStep).spinning_back_kick).toBeGreaterThan(base + 0.2); // what the live read would say
    // A limp knee counts at once, planted or not.
    const limp = { ...midStep, joints: [{ name: 'knee_l', health: 0.02, state: 'limp' as const, heat: 0.3 }] };
    expect(moveRisks(riskInputs(held, limp)).spinning_back_kick).toBe(1);
    // A real stumble off the planted read (tipping over) counts at once and is held until planted reads settle it.
    const stumbled = { balance: 1, saturation: 0, at: null as number | null };
    riskInputs(stumbled, planted);
    expect(moveRisks(riskInputs(stumbled, { ...midStep, upright: 0.6 })).spinning_back_kick).toBeGreaterThan(base + 0.2);
    expect(moveRisks(riskInputs(stumbled, { ...midStep, time: 0.3 })).spinning_back_kick).toBeGreaterThan(base + 0.2);
    let settled = 1;
    for (let t = 0.35; t < 2; t += 0.05) settled = moveRisks(riskInputs(stumbled, body(0, { time: t }))).spinning_back_kick;
    expect(settled).toBeCloseTo(base, 2);
    // A planted wobble raises it, smoothed (not all at once, but most of the way in 1 s).
    const shaky = (t: number) => body(0, { time: t, balance: 0.3 });
    const r1 = moveRisks(riskInputs(held, shaky(0.25))).spinning_back_kick;
    expect(r1).toBeGreaterThan(base);
    let r = r1;
    for (let t = 0.3; t <= 1.25; t += 0.05) r = moveRisks(riskInputs(held, shaky(t))).spinning_back_kick;
    expect(r).toBeGreaterThan(r1);
    expect(r).toBeCloseTo(moveRisks(shaky(2)).spinning_back_kick, 1);
  });
});

test('a published risk hovering at a band edge does not flicker (0.05 deadband)', () => {
  let pub = settleRisk(null, { tornado_kick: 0.4, kip_up: 0.3 });
  pub = settleRisk(pub, { tornado_kick: 0.38, kip_up: 0.33 });
  expect(pub).toEqual({ tornado_kick: 0.4, kip_up: 0.3 });
  pub = settleRisk(pub, { tornado_kick: 0.47, kip_up: 1 });
  expect(pub).toEqual({ tornado_kick: 0.47, kip_up: 1 }); // a real move, and an impossibility, go through
  expect(settleRisk(pub, { tornado_kick: 0.47, kip_up: 0.98 }).kip_up).toBe(0.98);
});

describe('side-on vs turned away', () => {
  test('60-120° off square is side-on, past 120° is his back', () => {
    const me = body(0);
    const at = (deg: number) => detectOpenings(me, body(1, { torsoYaw: Math.PI + (deg * Math.PI) / 180 }));
    expect(at(20)).not.toContain('side_on');
    expect(at(20)).not.toContain('turned_away');
    expect(at(90)).toContain('side_on');
    expect(at(-90)).toContain('side_on');
    expect(at(90)).not.toContain('turned_away');
    expect(at(150)).toContain('turned_away');
    expect(at(150)).not.toContain('side_on');
    expect(at(180)).toContain('turned_away');
  });
});

test('a real fight: the published stance flips far less often than the lead foot does', async () => {
  const sim = await makeSim({ design: 'haymaker', x: -1.4, y: 0, yaw: 0 }, { design: 'savate', x: 1.4, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
  sim.seconds(0.3);
  sim.release(0);
  sim.release(1);
  let raw = 0, pub = 0;
  let lastRaw: string | null = null, lastPub: string | null = null;
  for (let i = 0; i < 900; i++) { // 15 s of telemetry frames at 60 Hz
    if (i % 30 === 0) for (const r of sim.ctx.robots) r.intent = sparringIntent(sim.ctx, r);
    sim.step(17);
    const r0 = sim.ctx.robots[0];
    if (r0.down) continue;
    const t = buildTelemetry(sim.ctx, r0, SYSTEMS);
    const now = stanceOf(snapshot(sim.ctx, r0), snapshot(sim.ctx, sim.ctx.robots[1]));
    if (lastRaw !== null && now !== lastRaw) raw++;
    if (lastPub !== null && t.stance !== lastPub) pub++;
    lastRaw = now;
    lastPub = t.stance ?? null;
  }
  console.log(`15 s: lead foot changed ${raw}×, published stance ${pub}×`);
  expect(raw).toBeGreaterThanOrEqual(6);
  expect(pub).toBeLessThanOrEqual(raw / 2);
  sim.dispose();
}, 120_000);
