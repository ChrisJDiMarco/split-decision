// Shell mechanics and per-design durability (docs/design/strike-power.md §4.1-4.2).
import { describe, expect, it } from 'vitest';
import { MATERIALS, MOTORS } from '../../src/robots/catalog';
import { geomArea, geomVolume } from '../../src/robots/compile-mjcf';
import { DESIGNS } from '../../src/robots/designs';
import { DAMAGE_TUNING } from '../../src/physics/damage/constants';
import { driveRatings, durabilityProfile, SHELL_BUILDS, shellBuild, zoneOf } from '../../src/physics/damage/durability';
import { shellResponse } from '../../src/physics/damage/dent';
import { collapseLoad, dentDepth, plateStiffness, shellSurface, solidSurface, workShare } from '../../src/physics/damage/shell';

const kN = (n: number) => n / 1000;

describe('shell mechanics', () => {
  it("reproduces the audit's shell table (clamped plate, 0.12 m span)", () => {
    // docs/design/strike-power.md §4.1: yield load P_c and elastic work before a dent.
    const table: Array<[keyof typeof MATERIALS, number, number, number]> = [
      ['polycarb', 2.5, 0.6, 4],
      ['uhmw', 7, 1.6, 4],
      ['uhmw', 17, 9.5, 9],
      ['carbon', 2.5, 5.9, 17],
      ['ar500', 4, 35, 37],
    ];
    for (const [mat, mm, pcKn, eJ] of table) {
      const s = shellSurface(mat, mm, 0.12);
      expect(kN(s.collapseN), `${mat} ${mm} mm P_c`).toBeCloseTo(pcKn, 0);
      expect(s.elasticJ / eJ, `${mat} ${mm} mm E_el`).toBeGreaterThan(0.75);
      expect(s.elasticJ / eJ, `${mat} ${mm} mm E_el`).toBeLessThan(1.3);
    }
  });

  it('the dent depth solves P_c·(δ + δ³/3h²) = W − E_el', () => {
    const h = 0.0025;
    const pc = collapseLoad(62e6, h);
    for (const wp of [0.5, 5, 20, 80]) {
      const d = dentDepth(wp, pc, h);
      expect(pc * (d + (d * d * d) / (3 * h * h))).toBeCloseTo(wp, 6);
    }
    expect(dentDepth(0, pc, h)).toBe(0);
    expect(plateStiffness(2.4e9, 0.37, h, 0.06)).toBeGreaterThan(0);
  });

  it('the work splits by stiffness: a steel fist puts it all into a thin shell, a glove keeps most of it', () => {
    const pc = shellSurface('polycarb', 2.5);
    const fist = solidSurface('ar500');
    const glove = solidSurface('glove');
    const chest = shellSurface('uhmw', 17);
    expect(workShare(pc, fist)).toBeGreaterThan(0.99);
    expect(workShare(glove, chest)).toBeGreaterThan(0.95);
    expect(workShare(pc, pc)).toBeCloseTo(0.5, 9);
  });

  it('elastic below the collapse load or the elastic work; then each material fails its own way', () => {
    const pc = shellSurface('polycarb', 2.5);
    expect(shellResponse(pc, 50, 0.5 * pc.collapseN)).toBeNull(); // not enough force
    expect(shellResponse(pc, 0.9 * pc.elasticJ, 10 * pc.collapseN)).toBeNull(); // not enough work
    const dent = shellResponse(pc, 30, 3e3)!;
    expect(dent.mode).toBe('whiten');
    expect(dent.depthM).toBeGreaterThan(0.002);
    expect(dent.whiten).toBeGreaterThan(0);
    expect(dent.points).toBeCloseTo(dent.plasticJ * DAMAGE_TUNING.pointsPerPlasticJ, 9);
    const carbon = shellSurface('carbon', 2.5);
    const crack = shellResponse(carbon, 60, 8e3)!;
    expect(crack.mode).toBe('crack');
    expect(crack.cracked).toBe(true);
    expect(crack.points).toBeCloseTo(crack.plasticJ * DAMAGE_TUNING.crackPointsFactor, 9);
    expect(shellResponse(shellSurface('uhmw', 7), 40, 4e3)!.mode).toBe('gouge');
    expect(shellResponse(shellSurface('al7075', 2.5), 40, 8e3)!.mode).toBe('dent');
    // A cracked panel is weaker: the same hit that a whole panel shrugs off now does damage.
    expect(shellResponse(carbon, 15, 4e3)).toBeNull();
    expect(shellResponse(carbon, 15, 4e3, 0.5)).not.toBeNull();
  });
});

describe('per-design durability', () => {
  it("the shell builds match the designs' own mass model (they cannot drift apart)", () => {
    for (const [id, b] of Object.entries(SHELL_BUILDS)) {
      const d = DESIGNS[id];
      if (!d) continue;
      for (const p of d.parts) {
        for (const g of p.geoms) {
          if (g.massKg === undefined || g.role === 'striker' || g.role === 'foot') continue;
          const torso = p.tags.includes('torso');
          const wallMm = p.tags.includes('head') ? b.headMm : g.role === 'structure' ? b.frameMm : b.armorMm;
          const fill = torso ? b.torsoFillKgM3! : b.fillKgM3!;
          const mass = geomArea(g) * (wallMm / 1000) * MATERIALS[g.material].densityKgM3 + geomVolume(g) * fill;
          expect(mass, `${id}/${p.id}`).toBeCloseTo(g.massKg, 6);
          expect(g.material, `${id}/${p.id} material`).toBe(g.role === 'structure' ? b.frame : b.armor);
        }
      }
    }
  });

  it('hardened designs need far more to dent: AR500 > UHMW chest > carbon > polycarbonate', () => {
    const inputs = { massKg: 80, headKg: 2, comHeightM: 1 };
    const pc = (id: string) => durabilityProfile(DESIGNS[id], inputs).zones.torso_face.collapseN;
    expect(pc('bruiser')).toBeGreaterThan(pc('haymaker'));
    expect(pc('haymaker')).toBeGreaterThan(pc('pylon'));
    expect(pc('pylon')).toBeGreaterThan(pc('savate'));
    expect(pc('savate')).toBeCloseTo(pc('firecracker'), 6);
    // HAYMAKER's chest faces are its thick slabs; its sides are the 7 mm average.
    const hay = durabilityProfile(DESIGNS.haymaker, inputs).zones;
    expect(hay.torso_face.collapseN).toBeGreaterThan(4 * hay.torso_side.collapseN);
    // The iron age (no shell build) gets the catalog's wall model on its own materials.
    expect(shellBuild(DESIGNS.bruiser)).toMatchObject({ source: 'catalog', build: { armor: 'ar500', armorMm: 4 } });
  });

  it('zones come from the part and where on it the contact landed', () => {
    const torso = DESIGNS.haymaker.parts.find((p) => p.id === 'torso')!;
    expect(zoneOf(torso, torso.geoms[0], [1, 0, 0])).toBe('torso_face');
    expect(zoneOf(torso, torso.geoms[0], [0, -1, 0])).toBe('torso_side');
    const fist = DESIGNS.savate.parts.find((p) => p.id === 'fist_l')!;
    expect(zoneOf(fist, fist.geoms[0], null)).toBe('fist');
  });

  it('every catalog actuator has its drive train; a planetary reflects far more inertia than a QDD', () => {
    for (const m of Object.values(MOTORS)) {
      const r = driveRatings(m);
      expect(r.defaulted, m.id).toBe(false);
      expect(r.gearShockNm, m.id).toBeGreaterThan(m.stallTorqueNm);
      expect(r.bearingMomentNm, m.id).toBeGreaterThan(0);
      expect(m.ratingsSource, m.id).toBeTruthy();
    }
    const x12 = driveRatings(MOTORS['plan.x12']);
    const ake90 = driveRatings(MOTORS['qdd.ake90']);
    expect(x12.reflectedKgM2).toBeCloseTo(1.29e-3 * 400, 9);
    expect(x12.reflectedKgM2 / ake90.reflectedKgM2).toBeGreaterThan(20);
  });
});
