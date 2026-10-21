// The modern electric roster (docs/research/08-modern-roster.md/.json): heights and masses on spec,
// electric actuators only, gloves where the design wears them, the shared kit/skin contract, and a
// real MuJoCo load. The iron-age designs must compile exactly as they did before the modern roster.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import { describe, expect, it } from 'vitest';
import type { MatchSetup, PartDef, RobotDesign } from '../../src/core/types';
import { CUSHION_MATERIALS } from '../../src/physics/damage/constants';
import { compileWorld } from '../../src/physics/world';
import { MATERIALS, motor, reflectedInertia } from '../../src/robots/catalog';
import { compileRobot, partMotorMass } from '../../src/robots/compile-mjcf';
import { DESIGNS, design } from '../../src/robots/designs';
import { ARMATURE_FLOOR_KG_M2 } from '../../src/robots/humanoid';

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'] as const;
const IRON = ['bruiser', 'striker', 'goliath'] as const;
const TOLERANCE = 0.04;
/** The modern masses stay this close to the roster doc (docs/design/robot-realism-pass.md §3). */
const MASS_BUDGET = 0.01;

const SPEC = JSON.parse(readFileSync(new URL('../../docs/research/08-modern-roster.json', import.meta.url), 'utf8')) as Array<{ id: string; height_m: number; mass_kg: number; abilities: string[] }>;
const specOf = (id: string) => SPEC.find((s) => s.id === id)!;

/** Kit recipe ids per design: the contract between the physics builder and the render kit. */
const LOOK: Record<string, { head: string; torso: string; fist: string; shin?: string; foot?: string }> = {
  firecracker: { head: 'head.trio', torso: 'torso.pebble', fist: 'fist.glove', foot: 'leg.foot.round' },
  savate: { head: 'head.wedge', torso: 'torso.diamond', fist: 'fist.knuckle', shin: 'leg.shin.guard' },
  haymaker: { head: 'head.hammer', torso: 'torso.cowl', fist: 'fist.glove' },
  pylon: { head: 'head.lozenge', torso: 'torso.slim', fist: 'fist.knuckle' },
};

const GLOVED = new Set(['firecracker', 'haymaker']);

function part(d: RobotDesign, id: string): PartDef {
  const p = d.parts.find((x) => x.id === id);
  if (!p) throw new Error(`${d.id}: no part ${id}`);
  return p;
}

/** Height of a part's body origin above the pelvis in the zero pose (the builder uses no rotations). */
function originZ(d: RobotDesign, id: string): number {
  let z = 0;
  for (let p: PartDef | undefined = part(d, id); p?.parent; p = part(d, p.parent)) z += p.pos[2];
  return z;
}

/** Standing height: sole of the foot box to the crown of the head box, legs straight. */
function standingHeight(d: RobotDesign): number {
  const box = (p: PartDef) => {
    const g = p.geoms.find((x) => x.shape.type === 'box')!;
    if (g.shape.type !== 'box') throw new Error('box');
    return { z: g.pos?.[2] ?? 0, h: g.shape.halfSize[2] };
  };
  const head = box(part(d, 'head'));
  const foot = box(part(d, 'foot_l'));
  return originZ(d, 'head') + head.z + head.h - (originZ(d, 'foot_l') + foot.z - foot.h);
}

function compiledMass(d: RobotDesign): number {
  return compileRobot(d, 0, { pos: [0, 0, d.rootHeight], yaw: 0 }).totalMassKg;
}

describe('roster order', () => {
  it('lists the four modern fighters first, then the iron age', () => {
    expect(Object.keys(DESIGNS)).toEqual([...MODERN, ...IRON]);
    for (const id of MODERN) expect(design(id).era).toBe('modern');
    for (const id of IRON) expect(design(id).era).toBe('iron');
  });
});

describe('modern roster on spec', () => {
  for (const id of MODERN) {
    const d = design(id);
    const spec = specOf(id);

    it(`${id} stands ${spec.height_m} m tall (±${TOLERANCE * 100}%)`, () => {
      const h = standingHeight(d);
      expect(Math.abs(h / spec.height_m - 1)).toBeLessThan(TOLERANCE);
    });

    it(`${id} weighs ${spec.mass_kg} kg (±${MASS_BUDGET * 100}%), per-part mass table`, () => {
      const c = compileRobot(d, 0, { pos: [0, 0, d.rootHeight], yaw: 0 });
      const rows = c.parts.map((p) => {
        const def = part(d, p.id);
        // The drives this part carries: its own, less those mounted on its parent, plus its children's
        // mounted on it (JointDef.mount).
        const motors = partMotorMass(def, d.parts.filter((x) => x.parent === p.id));
        const gyro = d.gyro?.part === p.id ? d.gyro.massKg : 0;
        return `  ${p.id.padEnd(11)} ${p.massKg.toFixed(2).padStart(6)} kg  (actuators ${motors.toFixed(2)}${gyro ? `, gyro ${gyro}` : ''}, structure ${(p.massKg - motors - gyro).toFixed(2)})`;
      });
      console.log(`${d.name}: ${c.totalMassKg.toFixed(2)} kg (spec ${spec.mass_kg}), ${standingHeight(d).toFixed(3)} m (spec ${spec.height_m})\n${rows.join('\n')}`);
      expect(Math.abs(c.totalMassKg / spec.mass_kg - 1)).toBeLessThan(MASS_BUDGET);
      // Every drive is weighed exactly once, wherever it is mounted.
      const drives = d.parts.reduce((s, p) => s + (p.joints ?? []).reduce((t, j) => t + motor(j.motor).massKg, 0), 0);
      const carried = d.parts.reduce((s, p) => s + partMotorMass(p, d.parts.filter((x) => x.parent === p.id)), 0);
      expect(carried).toBeCloseTo(drives, 9);
    });

    it(`${id} joints carry their drive train's reflected inertia; drives sit where real builds put them`, () => {
      for (const p of d.parts) {
        for (const j of p.joints ?? []) {
          const m = motor(j.motor);
          const reflected = reflectedInertia(m);
          expect(reflected, `${j.name} ${j.motor}`).toBeDefined();
          expect(j.armature, j.name).toBeCloseTo(Math.max(ARMATURE_FLOOR_KG_M2, reflected!), 12);
          const parentMounted = /^(shoulder_pitch|elbow|hip_yaw|knee|ankle_pitch|ankle_roll)_[lr]$/.test(j.name);
          expect(j.mount ?? 'self', j.name).toBe(parentMounted ? 'parent' : 'self');
        }
      }
      // The ankles are their own group, sized about 1.5-2 N·m per kg of body (robot-realism-pass.md §3).
      const m = compiledMass(d);
      for (const name of ['ankle_pitch_l', 'ankle_roll_r']) {
        const j = d.parts.flatMap((p) => p.joints ?? []).find((x) => x.name === name)!;
        const perKg = motor(j.motor).stallTorqueNm / m;
        expect(perKg, `${id} ${name} ${j.motor}`).toBeGreaterThan(1.3);
        expect(perKg, `${id} ${name} ${j.motor}`).toBeLessThan(2.2);
      }
      // No part keeps a drive it does not hold: the feet carry no motor, the forearms none.
      const c = compileRobot(d, 0, { pos: [0, 0, d.rootHeight], yaw: 0 });
      for (const pid of ['foot_l', 'foot_r', 'forearm_l', 'forearm_r']) {
        expect(partMotorMass(part(d, pid), d.parts.filter((x) => x.parent === pid)), pid).toBe(0);
        expect(c.parts.find((x) => x.id === pid)!.massKg, pid).toBeLessThan(2.5);
      }
    });

    it(`${id} runs on electric actuators only, all sourced`, () => {
      const motors = new Set(d.parts.flatMap((p) => (p.joints ?? []).map((j) => j.motor)));
      expect(motors.size).toBeGreaterThan(0);
      for (const m of motors) {
        expect(motor(m).kind, m).toBe('electric');
        expect(motor(m).source, m).toBeTruthy();
      }
      expect(d.hydraulics).toBeUndefined();
      // Position gains come from stall torque, as for every builder design.
      for (const p of d.parts) for (const j of p.joints ?? []) expect(j.kp).toBeCloseTo(motor(j.motor).stallTorqueNm / (j.name.startsWith('ankle') ? 0.1 : 0.07), 6);
    });

    it(`${id} carries the shared look / skin contract`, () => {
      const look = LOOK[id];
      expect(part(d, 'head').visual.kit).toBe(look.head);
      expect(part(d, 'torso').visual.kit).toBe(look.torso);
      expect(part(d, 'fist_l').visual.kit).toBe(look.fist);
      expect(part(d, 'fist_r').visual.kit).toBe(look.fist);
      if (look.shin) expect(part(d, 'shin_l').visual.kit).toBe(look.shin);
      if (look.foot) expect(part(d, 'foot_r').visual.kit).toBe(look.foot);
      expect(d.defaultSkin).toBe('livery');
      expect(d.palette?.primary).toMatch(/^#[0-9a-f]{6}$/);
      expect(d.palette?.secondary).toMatch(/^#[0-9a-f]{6}$/);
      expect(d.palette?.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(d.weightClass).toBeTruthy();
      expect([...d.abilities].sort()).toEqual([...spec.abilities].sort());
      const ids = ['pelvis', 'torso', 'head', 'upperarm_l', 'upperarm_r', 'forearm_l', 'forearm_r', 'fist_l', 'fist_r', 'thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'foot_l', 'foot_r'];
      expect(d.parts.map((p) => p.id).sort()).toEqual(ids.sort());
    });

    it(`${id} ${GLOVED.has(id) ? 'wears padded gloves' : 'strikes with bare knuckle plates'}`, () => {
      for (const s of ['fist_l', 'fist_r']) {
        const g = part(d, s).geoms;
        expect(g).toHaveLength(1);
        expect(g[0].role).toBe('striker');
        expect(g[0].material).toBe(GLOVED.has(id) ? 'glove' : 'ar500');
      }
      if (GLOVED.has(id)) expect(d.gloves?.color).toMatch(/^#[0-9a-f]{6}$/);
      else expect(d.gloves).toBeUndefined();
    });

    it(`${id} has a gyro core sized to its body`, () => {
      const g = d.gyro!;
      const m = compiledMass(d);
      const mgh = m * 9.81 * d.rootHeight;
      // Well under 10% of the body, and a torque in the 0.2-0.3 · m·g·h band of the sizing rule.
      expect(g.massKg / m).toBeLessThan(0.1);
      expect(g.maxTorqueNm / mgh).toBeGreaterThan(0.15);
      expect(g.maxTorqueNm / mgh).toBeLessThan(0.35);
    });
  }

  it('the glove is a soft, cushioned striker that never sparks', () => {
    expect(CUSHION_MATERIALS).toContain('glove');
    expect(MATERIALS.glove.sparks).toBe(false);
    expect(MATERIALS.glove.brinell).toBeLessThan(MATERIALS.polycarb.brinell);
  });

  it('head break impulses rise with head mass and build', () => {
    const heads = MODERN.map((id) => {
      const c = compileRobot(design(id), 0, { pos: [0, 0, 1], yaw: 0 });
      return { id, kg: c.parts.find((p) => p.id === 'head')!.massKg, ns: part(design(id), 'head').detachable!.impulseNs };
    });
    console.log(heads.map((h) => `${h.id}: head ${h.kg.toFixed(2)} kg breaks at ${h.ns} N·s`).join('\n'));
    const byId = Object.fromEntries(heads.map((h) => [h.id, h]));
    // The bantam's head pops at far less than the brawler's.
    expect(byId.firecracker.ns).toBeLessThan(byId.haymaker.ns * 0.6);
    expect(byId.haymaker.ns).toBe(Math.max(...heads.map((h) => h.ns)));
  });
});

describe('modern roster compiles and loads in MuJoCo', () => {
  it('every pairing of a modern design loads, with the compiled masses', async () => {
    const mj = await loadMujoco();
    for (let i = 0; i < MODERN.length; i++) {
      const red = MODERN[i];
      const blue = MODERN[(i + 1) % MODERN.length];
      const setup: MatchSetup = {
        fighters: [
          { design: red, skin: 'livery', plan: '', temperament: 1 },
          { design: blue, skin: 'livery', plan: '', temperament: 1 },
        ],
        seed: 1, timestep: 0.001, reactionDelayS: 0,
      };
      const world = compileWorld(setup);
      const model = mj.MjModel.from_xml_string(world.xml);
      for (const r of world.robots) {
        const root = model.body(r.parts[0].body).id as number;
        expect(root).toBeGreaterThan(0);
        expect(model.body_subtreemass[root]).toBeCloseTo(r.totalMassKg, 1);
      }
      model.delete();
    }
  }, 60_000);
});

describe('iron age unchanged', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/iron-age-baseline.json', import.meta.url), 'utf8')) as Record<string, { sha256: string; length: number; totalMassKg: number }>;
  for (const id of IRON) {
    for (const corner of [0, 1] as const) {
      it(`${id} (corner ${corner}) compiles to the same MJCF as before the modern roster`, () => {
        // Same placement as the script that wrote the fixture (at commit 37e8037).
        const c = compileRobot(design(id), corner, { pos: [corner ? 1.5 : -1.5, 0.25, 1.1], yaw: corner ? Math.PI : 0 });
        const xml = [c.bodyXml, c.debrisXml, c.actuatorXml, c.equalityXml, c.sensorXml].join('\n');
        const b = baseline[`${id}/${corner}`];
        expect(xml.length).toBe(b.length);
        expect(createHash('sha256').update(xml).digest('hex')).toBe(b.sha256);
        expect(c.totalMassKg).toBe(b.totalMassKg);
      });
    }
  }
});
