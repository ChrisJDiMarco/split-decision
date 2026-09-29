import { describe, expect, it } from 'vitest';
import { damageState, detachPart } from '../../src/physics/damage';
import { DESIGNS } from '../../src/robots/designs';
import { bodyPos, drain, fireRam, geomPos, makeRig, mj, ofKind, step } from './helpers';

const SETTLE_STEPS = 500;

/** Fires a ram at the Bruiser's (corner 0) head from behind, above the torso's top edge. */
function hitHead(massKg: number, speed: number) {
  const ctx = makeRig({ rams: [{ name: 'ram', massKg, halfSize: 0.12 }] });
  step(ctx, SETTLE_STEPS);
  drain(ctx);
  const head = damageState(ctx).robots[0].parts.get('head')!;
  const hg = geomPos(ctx, head.part.geoms[0]);
  fireRam(ctx, 'ram', [hg[0] - 0.4, hg[1], hg[2] + 0.1], [speed, 0, 0]);
  step(ctx, 300);
  return { ctx, head, events: drain(ctx) };
}

describe('impacts', () => {
  it('resting contacts (feet on the canvas, gantry settle) are not hits', () => {
    const ctx = makeRig();
    step(ctx, 1000);
    const events = drain(ctx);
    expect(ofKind(events, 'impact')).toHaveLength(0);
    for (const r of ctx.robots) {
      for (const j of r.joints) expect(j.health).toBe(1);
      for (const p of r.parts.values()) expect(p.damage).toBe(0);
    }
  });

  it('every design pairing builds its damage map and settles without phantom hits', () => {
    const ids = Object.keys(DESIGNS);
    for (const a of ids) {
      for (const b of ids) {
        const ctx = makeRig({ designs: [a, b] });
        const st = damageState(ctx);
        const mapped = st.geoms.filter((g) => g !== null).length;
        expect(mapped).toBe(ctx.model.ngeom); // every geom is classified
        step(ctx, 300);
        expect(ofKind(drain(ctx), 'impact')).toHaveLength(0);
        for (const r of ctx.robots) for (const j of r.joints) expect(j.health).toBe(1);
        ctx.data.delete(); // 7 designs = 49 worlds: free each one or the WASM heap runs out
        ctx.model.delete();
      }
    }
  }, 120_000);

  it('a heavy fast ram knocks the head off', () => {
    const { ctx, head, events } = hitHead(60, 12);
    const hit = ofKind(events, 'impact').find((e) => e.part === 'head')!;
    const detach = ofKind(events, 'detach');
    console.info(`[head pop] 60 kg @ 12 m/s: impulse ${hit.impulseNs.toFixed(1)} N·s (spec ${head.def.detachable!.impulseNs}), ` +
      `closing ${hit.speed.toFixed(2)} m/s, energy ${hit.energyJ.toFixed(0)} J, debris vel ${detach[0]?.vel.map((v) => v.toFixed(2))}`);
    expect(hit.impulseNs).toBeGreaterThanOrEqual(head.def.detachable!.impulseNs);
    expect(hit.victim).toBe(0);
    expect(hit.striker).toBeNull(); // a loose prop, not a fighter
    expect(hit.normal[0]).toBeGreaterThan(0.8); // pushed the way the ram was moving (+x)
    expect(detach).toHaveLength(1);
    expect(detach[0]).toMatchObject({ corner: 0, part: 'head', debrisBody: head.part.debrisBody });
    expect(head.part.attached).toBe(false);
    expect(detach[0].vel[0]).toBeGreaterThan(2); // the head flies off along the hit
    const neck = ctx.robots[0].joints.find((j) => j.name === 'neck_yaw')!;
    expect(neck.state).toBe('limp');
    // Attached geoms no longer collide; debris geoms do.
    const contype = ctx.model.geom_contype;
    for (const g of head.part.geoms) expect(contype[g]).toBe(0);
    for (const g of head.part.debrisGeoms) expect(contype[g]).not.toBe(0);
  });

  it('a light tap dents nothing and pops nothing', () => {
    const { head, events } = hitHead(5, 1.5);
    const hit = ofKind(events, 'impact').find((e) => e.part === 'head');
    console.info(`[light tap] 5 kg @ 1.5 m/s: impulse ${hit?.impulseNs.toFixed(2) ?? '<event threshold'} N·s, head hp ${head.part.hp.toFixed(4)}`);
    expect(ofKind(events, 'detach')).toHaveLength(0);
    expect(head.part.attached).toBe(true);
    expect(head.part.hp).toBeGreaterThan(0.99);
  });

  it('a mid hit below the break impulse damages the head and neck but leaves it on', () => {
    // A p90 fight strike (~40-50 N·s, tools/fight-sim.ts) against a 75 N·s break threshold.
    const { ctx, head, events } = hitHead(12, 5);
    const hit = ofKind(events, 'impact').find((e) => e.part === 'head')!;
    const neck = ctx.robots[0].joints.find((j) => j.name === 'neck_yaw')!;
    console.info(`[mid hit] 12 kg @ 5 m/s: impulse ${hit.impulseNs.toFixed(1)} N·s, head hp ${head.part.hp.toFixed(3)}, neck health ${neck.health.toFixed(3)}, slop ${neck.slop.toFixed(4)} rad`);
    expect(ofKind(events, 'detach')).toHaveLength(0);
    expect(head.part.hp).toBeLessThan(0.99); // a p90 strike dents the head a few percent
    expect(neck.health).toBeLessThan(0.99);
    expect(neck.slop).toBeGreaterThan(0);
  });

  it('debris poses are current the moment a part detaches (a frame can go out before the next step)', () => {
    const ctx = makeRig();
    step(ctx, SETTLE_STEPS);
    const st = damageState(ctx);
    const head = st.robots[0].parts.get('head')!;
    expect(detachPart(ctx, st, head, [0, 0, 0])).toBe(true);
    const at = bodyPos(ctx, head.part.body);
    const debris = bodyPos(ctx, head.part.debrisBody!);
    expect(Math.hypot(debris[0] - at[0], debris[1] - at[1], debris[2] - at[2])).toBeLessThan(0.02);
  });

  it('detached debris lands on the canvas and collides with the other robot', () => {
    const ctx = makeRig();
    step(ctx, SETTLE_STEPS);
    drain(ctx);
    const st = damageState(ctx);
    const head = st.robots[0].parts.get('head')!;
    const debris = head.part.debrisBody!;
    // Lob the head at the Striker: ~9.5 m/s forward, a little up (kick = 0.35·J/m).
    const from = bodyPos(ctx, head.part.body);
    const to = bodyPos(ctx, ctx.robots[1].parts.get('torso')!.body);
    const dx = to[0] - from[0];
    const vx = 9.5;
    const t = Math.abs(dx) / vx;
    const vz = (to[2] + 0.35 - from[2] + 4.905 * t * t) / t;
    const mass = ctx.model.body_mass[debris];
    const kick = Math.hypot(vx, vz);
    const j = (kick * mass) / 0.35;
    expect(detachPart(ctx, st, head, [(Math.sign(dx) * vx * j) / kick, 0, (vz * j) / kick])).toBe(true);

    // Mass bookkeeping: hand-updated subtree masses match what mj_setConst would compute.
    const subtree = Array.from(ctx.model.body_subtreemass as Float64Array);

    const r1Geoms = new Set([...st.robots[1].parts.values()].flatMap((p) => p.part.geoms));
    const debrisGeoms = new Set(head.part.debrisGeoms);
    const canvas = ctx.model.geom('canvas').id;
    let hitRobot = false;
    step(ctx, 3000, () => {
      if (hitRobot) return;
      const v = ctx.data.contact;
      for (let i = 0; i < ctx.data.ncon; i++) {
        const c = v.get(i);
        if ((debrisGeoms.has(c.geom1) && r1Geoms.has(c.geom2)) || (debrisGeoms.has(c.geom2) && r1Geoms.has(c.geom1))) hitRobot = true;
        c.delete();
      }
      v.delete();
    });
    const events = drain(ctx);
    const p = bodyPos(ctx, debris);
    const dofs = ctx.model.jnt_dofadr[ctx.model.body_jntadr[debris]];
    const speed = Math.hypot(ctx.data.qvel[dofs], ctx.data.qvel[dofs + 1], ctx.data.qvel[dofs + 2]);
    let onCanvas = false;
    const v = ctx.data.contact;
    for (let i = 0; i < ctx.data.ncon; i++) {
      const c = v.get(i);
      if ((c.geom1 === canvas && debrisGeoms.has(c.geom2)) || (c.geom2 === canvas && debrisGeoms.has(c.geom1))) onCanvas = true;
      c.delete();
    }
    v.delete();
    const struck = ofKind(events, 'impact').filter((e) => e.victim === 1);
    console.info(`[debris] hit robot 1: ${hitRobot} (${struck.length} impact events on it, max ${Math.max(0, ...struck.map((e) => e.impulseNs)).toFixed(1)} N·s); ` +
      `rest pos ${p.map((x) => x.toFixed(2))}, speed ${speed.toFixed(3)} m/s, on canvas ${onCanvas}`);
    expect(hitRobot).toBe(true);
    expect(struck.length).toBeGreaterThan(0);
    expect(onCanvas).toBe(true);
    expect(p[2]).toBeGreaterThan(0);
    expect(p[2]).toBeLessThan(0.35);
    expect(speed).toBeLessThan(0.2);
    expect(ofKind(events, 'ko')).toContainEqual({ kind: 'ko', corner: 0, reason: 'head' });

    mj.mj_setConst(ctx.model, ctx.data);
    const recomputed = Array.from(ctx.model.body_subtreemass as Float64Array);
    recomputed.forEach((m, i) => expect(subtree[i]).toBeCloseTo(m, 6));
  });
});
