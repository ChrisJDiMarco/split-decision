// Damage unit fixes (2026-10-21):
//  · the gyro core's capacity is the torso shell's: the points it takes to breach every panel once, in
//    post-overhaul points (a joule of plastic shell work, × crackPointsFactor when polycarbonate cracks);
//  · the result card counts a significant strike by the damage model's own numbers (impulse, absorbed
//    work), so a head-popping jab shows on it;
//  · the RobStride 04's output bearing is rated on its published 120 × 120 × 56 mm housing;
//  · the bearing channel holds a tick whose wrench breaks the joint's own axis balance (a contact's first
//    tick between two robots) and drops no real load.
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../src/core/protocol';
import { damageState } from '../../src/physics/damage';
import { DAMAGE_TUNING, GYRO_BREACH_DEPTH_H } from '../../src/physics/damage/constants';
import { durabilityProfile, gyroCapacity, panelBreachPoints } from '../../src/physics/damage/durability';
import { shellResponse } from '../../src/physics/damage/dent';
import { shellSurface } from '../../src/physics/damage/shell';
import { applyPartDamage } from '../../src/physics/damage/wear';
import { DESIGNS } from '../../src/robots/designs';
import { MOTORS } from '../../src/robots/catalog';
import { hitWorkJ, isSignificantStrike, Scorecard } from '../../src/ui/scorecard';
import { drain, fireRamAt, geomPos, makeRig, step } from './helpers';

const PROFILE_IN = { massKg: 50, headKg: 3, comHeightM: 1 };

describe('gyro core capacity (post-overhaul points)', () => {
  it('a polycarbonate panel is breached where it cracks through, and books the crack factor', () => {
    const pc = shellSurface('polycarb', 2.5);
    expect(GYRO_BREACH_DEPTH_H).toBeGreaterThanOrEqual(DAMAGE_TUNING.whitenCrackDepthH);
    const pts = panelBreachPoints(pc);
    // The same work through the dent model cracks the panel and books the same points.
    const work = pc.elasticJ + pts / DAMAGE_TUNING.crackPointsFactor;
    const res = shellResponse(pc, work * 1.0001, 10 * pc.collapseN)!;
    expect(res.cracked).toBe(true);
    expect(res.points).toBeCloseTo(pts, -1);
    expect(pts).toBeGreaterThan(100);
    expect(pts).toBeLessThan(130);
  });

  it("FIRECRACKER's core dies only when its whole torso shell is wrecked (~4,350 points, was 420)", () => {
    const fc = durabilityProfile(DESIGNS.firecracker, PROFILE_IN);
    expect(fc.gyroHpPoints).toBeGreaterThan(4200);
    expect(fc.gyroHpPoints).toBeLessThan(4500);
    expect(gyroCapacity(DESIGNS.firecracker, fc.zones.torso_face, fc.zones.torso_side)).toBeCloseTo(fc.gyroHpPoints, 6);
    // ~38 panels of 116 points: at least ten cracking jabs' worth (a 64 J cracking jab books ~180).
    expect(fc.gyroHpPoints / 182).toBeGreaterThan(20);
  });

  it('every number comes from the build: bigger and tougher torsos hold more', () => {
    const cap = (id: string) => durabilityProfile(DESIGNS[id], PROFILE_IN).gyroHpPoints;
    expect(cap('savate')).toBeGreaterThan(cap('firecracker')); // same 2.5 mm polycarbonate, bigger torso
    expect(cap('pylon')).toBeGreaterThan(cap('savate')); // carbon cracks late
    expect(cap('haymaker')).toBeGreaterThan(10 * cap('pylon')); // 7-17 mm UHMW barely yields
    for (const id of Object.keys(DESIGNS)) expect(Number.isFinite(cap(id)) && cap(id) > 0, id).toBe(true);
  });

  it('points on the torso wear the core by points / capacity, booked by source', () => {
    const ctx = makeRig({ designs: ['firecracker', 'savate'] });
    const rd = damageState(ctx).robots[0];
    const torso = rd.parts.get('torso')!;
    const gyro = ctx.robots[0].gyro!;
    expect(gyro.health).toBe(1);
    applyPartDamage(rd, torso, 182, true); // one deep cracking jab
    applyPartDamage(rd, torso, 50, false); // a fall
    expect(gyro.health).toBeCloseTo(1 - 232 / rd.profile.gyroHpPoints, 9);
    expect(rd.ledger.gyro.strikePoints).toBe(182);
    expect(rd.ledger.gyro.worldPoints).toBe(50);
    expect(rd.ledger.gyro.healthLost).toBeCloseTo(232 / rd.profile.gyroHpPoints, 9);
    // The head is not the core's housing.
    applyPartDamage(rd, rd.parts.get('head')!, 500, true);
    expect(gyro.health).toBeCloseTo(1 - 232 / rd.profile.gyroHpPoints, 9);
  });
});

describe('RobStride 04 bearing', () => {
  it('is rated on the published 120 mm housing: 4.8 kN radial, ~202 N·m tilting', () => {
    const m = MOTORS['qdd.rs04'];
    expect(m.housingDiameterMm).toBe(120);
    expect(m.bearingRadialN).toBeCloseTo(4800, 6);
    expect(m.bearingMomentNm).toBeCloseTo(201.6, 6);
  });
});

describe('result card: significant strikes by the damage model', () => {
  const impact = (o: Partial<Extract<SimEvent, { kind: 'impact' }>>): SimEvent => ({
    kind: 'impact', pos: [0, 0, 1.5], normal: [1, 0, 0], impulseNs: 10, speed: 6, energyJ: 20,
    striker: 0, victim: 1, part: 'head', metal: false, workJ: 10, ...o,
  });

  it('a head-popping jab counts (29 N·s, 40 J absorbed, only 25 J of presentation energy)', () => {
    const pop = impact({ impulseNs: 28.9, workJ: 40, energyJ: 25, clean: true, strikerPart: 'fist_r' });
    expect(isSignificantStrike(pop)).toBe(true);
    const s = new Scorecard();
    s.record([pop], null);
    expect(s.totals()[0].strikes).toBe(1);
    expect(s.totals()[0].peakHitJ).toBe(40);
  });

  it('a light touch, a push and a robot hitting itself or the floor do not', () => {
    expect(isSignificantStrike(impact({ impulseNs: 6, workJ: 4 }))).toBe(false);
    expect(isSignificantStrike(impact({ impulseNs: 40, workJ: 80, push: true }))).toBe(false);
    expect(isSignificantStrike(impact({ striker: null }))).toBe(false);
    expect(isSignificantStrike(impact({ victim: 0 }))).toBe(false);
  });

  it('either measure is enough: a hard shove-free blow by impulse, a denting one by work', () => {
    expect(isSignificantStrike(impact({ impulseNs: 16, workJ: 5 }))).toBe(true);
    expect(isSignificantStrike(impact({ impulseNs: 8, workJ: 25 }))).toBe(true);
  });

  it('a recording from before the damage overhaul (no workJ) keeps the old presentation-energy rule', () => {
    const old = impact({ workJ: undefined, energyJ: 70, impulseNs: 5 });
    expect(isSignificantStrike(old)).toBe(true);
    expect(hitWorkJ(old as Extract<SimEvent, { kind: 'impact' }>)).toBe(70);
    expect(isSignificantStrike(impact({ workJ: undefined, energyJ: 50, impulseNs: 30 }))).toBe(false);
  });
});

describe('bearing channel: the wrench must balance about the joint axis', () => {
  it('drops no real load: a heavy ram on the side of a limb reads the same peak with the check on and off', () => {
    const peakOf = (check: number, part: string, joint: string) => {
      const saved = DAMAGE_TUNING.wrenchCheckStall;
      DAMAGE_TUNING.wrenchCheckStall = check;
      try {
        const ctx = makeRig({ designs: ['firecracker', 'savate'], rams: [{ name: 'ram', massKg: 20, halfSize: 0.06 }] });
        step(ctx, 300);
        drain(ctx);
        const rd = damageState(ctx).robots[1];
        const ji = rd.robot.joints.findIndex((j) => j.name === joint);
        const m = rd.mech[ji];
        expect(fireRamAt(ctx, 'ram', geomPos(ctx, rd.parts.get(part)!.part.geoms[0]), [0, 1, 0], 8)).toBe(true);
        let peak = 0;
        step(ctx, 80, () => { if (m.inEpisode) peak = Math.max(peak, m.peak[2]); });
        return { peak, health: rd.robot.joints[ji].health };
      } finally {
        DAMAGE_TUNING.wrenchCheckStall = saved;
      }
    };
    for (const [part, joint] of [['upperarm_l', 'shoulder_pitch_l'], ['shin_l', 'knee_l']] as const) {
      const on = peakOf(1, part, joint);
      const off = peakOf(0, part, joint);
      expect(on.peak, joint).toBeGreaterThan(0.1); // a 640 J ram does load the bearing...
      expect(on.peak, joint).toBeCloseTo(off.peak, 6); // ...and the check takes none of it away
      expect(on.health, joint).toBeCloseTo(off.health, 9);
    }
  }, 120_000);
});
