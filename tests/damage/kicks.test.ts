import { describe, expect, it } from 'vitest';
import { MATERIALS } from '../../src/robots/catalog';
import { damageState } from '../../src/physics/damage';
import { damagePoints } from '../../src/physics/damage/wear';
import type { Surface } from '../../src/physics/damage/state';
import { drain, fireRamAt, geomPos, makeRig, ofKind, step } from './helpers';

const surface = (id: keyof typeof MATERIALS, cushion = false): Surface => {
  const m = MATERIALS[id];
  return { brinell: m.brinell, yieldMPa: m.yieldMPa, sparks: m.sparks, cushion };
};

describe('rubber-soled feet', () => {
  it('a kick into AR500 plate costs the rubber-soled foot about what it costs the plate', () => {
    // Striker front kick into the Bruiser's chest: ~53 N·s, ~160 J (effective masses from the designs).
    const foot = surface('rubber', true);
    const plate = surface('ar500');
    const onFoot = damagePoints(53, 160, plate, foot);
    const onPlate = damagePoints(53, 160, foot, plate);
    expect(onFoot).toBeLessThanOrEqual(1.5 * onPlate);
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
