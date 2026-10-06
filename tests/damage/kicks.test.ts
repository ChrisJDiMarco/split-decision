import { describe, expect, it } from 'vitest';
import { damageState } from '../../src/physics/damage';
import { shellResponse } from '../../src/physics/damage/dent';
import { shellSurface, solidSurface, workShare } from '../../src/physics/damage/shell';
import { drain, fireRamAt, geomPos, makeRig, ofKind, step } from './helpers';

describe('rubber-soled feet', () => {
  it('a kick into AR500 plate: the rubber sole soaks most of the work and the plate stays elastic', () => {
    // Striker front kick into the Bruiser's chest: ~160 J, peak ~20 kN (the audit's heaviest kicks).
    const sole = solidSurface('rubber');
    const plate = shellSurface('ar500', 4);
    const intoSole = workShare(sole, plate);
    expect(intoSole).toBeGreaterThan(0.9); // the pad is the soft side of the pair
    expect(shellResponse(plate, 160 * (1 - intoSole), 20e3)).toBeNull(); // 4 mm AR500: ~35 kN, ~38 J before it yields
    expect(shellResponse(sole, 160 * intoSole, 20e3)).toBeNull(); // a cushion never dents
  });

  it('five hard hits on the foot leave the ankles working', () => {
    const ctx = makeRig({ rams: [{ name: 'ram', massKg: 12, halfSize: 0.1 }] });
    step(ctx, 300);
    drain(ctx);
    const st = damageState(ctx);
    const r = ctx.robots[1]; // Striker, facing -x: its toes point at the ram
    const foot = st.robots[1].parts.get('foot_l')!;
    const ankles = ['ankle_pitch_l', 'ankle_roll_l'].map((n) => r.joints[r.jointIndex.get(n)!]);
    let impulse = 0;
    for (let hit = 0; hit < 5; hit++) {
      const toe = geomPos(ctx, foot.part.geoms[0]);
      expect(fireRamAt(ctx, 'ram', [toe[0], toe[1], 0.12], [1, 0, 0], 6)).toBe(true);
      step(ctx, 250);
      impulse = Math.max(impulse, ...ofKind(drain(ctx), 'impact').filter((e) => e.part === 'foot_l').map((e) => e.impulseNs));
    }
    console.info(`[kicks] 5 × 12 kg @ 6 m/s into foot_l (max ${impulse.toFixed(0)} N·s): foot hp ${foot.part.hp.toFixed(3)}, ` +
      `ankle health ${ankles.map((j) => `${j.name} ${j.health.toFixed(3)} ${j.state}`).join(', ')}`);
    expect(impulse).toBeGreaterThan(20);
    for (const j of ankles) expect(j.state).toBe('ok');
    expect(foot.part.hp).toBeGreaterThan(0.8);
  });
});
