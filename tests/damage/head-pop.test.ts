// Head pops (src/physics/damage/detach.ts, impacts.ts popBlow): a head comes off only from one really
// nice hard solid clean blow: a striking surface of the other robot (or a thrown prop), not blocked by
// the guard, whose impact impulse reaches the mount (design rating × DAMAGE_TUNING.mountScale × wear).
// Never from a fall, the floor, the cage, a push, a lean, a blocked blow or accumulated damage.
// Also here: the neck rated as the head's mount, bearing wear booked once per multi-axis joint, and
// trunk blows arming the legs that stand on the canvas.
import { describe, expect, it } from 'vitest';
import type { GeomInfo, HitGroup, PartInfo, Tally } from '../../src/physics/damage/state';
import type { Episode } from '../../src/physics/damage/state';
import { damageState } from '../../src/physics/damage';
import { DAMAGE_TUNING } from '../../src/physics/damage/constants';
import { breakImpulseNs, mountFactor } from '../../src/physics/damage/detach';
import { popBlow } from '../../src/physics/damage/impacts';
import { jointLoadStep } from '../../src/physics/damage/joint-loads';
import type { SimContext } from '../../src/physics/sim-context';
import { drain, fireRam, fireRamAt, geomPos, makeRig, ofKind, step } from './helpers';

const SETTLE_STEPS = 300;

/** The geom of a robot part with the given role (the fist's striking block), else its first geom. */
function geomOf(ctx: SimContext, corner: 0 | 1, part: string, role?: string): GeomInfo {
  const st = damageState(ctx);
  const ids = ctx.robots[corner].parts.get(part)!.geoms;
  const id = ids.find((g) => !role || st.geoms[g]?.role === role) ?? ids[0];
  return st.geoms[id]!;
}

function tally(info: PartInfo, geom: GeomInfo, other: GeomInfo, o: Partial<Tally> = {}): Tally {
  return {
    info, geom, other, zone: 'head', surface: { material: 'polycarb', mode: 'whiten', thicknessM: 0, radiusM: 0, stiffness: 1, collapseN: 1, elasticJ: 1, sparks: false },
    impulse: 20, jx: 20, jy: 0, jz: 0, work: 30, peakForce: 6000, tickForce: 0, forceRing: [], filtPeak: 5000,
    pos: [0, 0, 0], normal: [1, 0, 0], localPos: [0, 0, 0], localNormal: [-1, 0, 0], striking: false, speed: 6,
    t0: 100, firstOther: other, jImpact: 20, ...o,
  };
}

function group(kind: HitGroup['kind'], tallies: Tally[]): HitGroup {
  return { kind, striker: 0, victim: 1, startTick: 100, closeTick: 130, first: null as unknown as Episode, pairs: [], tallies, impulse: 20, work: 30, peakForce: 6000, speed: 6, done: false };
}

/** Drops robot `corner` (gantry released) upside down from `z` so its head lands on the canvas first. */
function dropHeadFirst(ctx: SimContext, corner: 0 | 1, z: number): void {
  const r = ctx.robots[corner];
  ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
  const q = ctx.data.qpos;
  q[r.rootQadr + 2] = z;
  q.set([0, 1, 0, 0], r.rootQadr + 3); // 180° about x: head down
  for (let k = 0; k < 6; k++) ctx.data.qvel[r.rootDadr + k] = 0;
  ctx.mj.mj_forward(ctx.model, ctx.data);
}

describe('head pops', () => {
  it('only a clean, unblocked strike by a striking surface counts as a pop blow', () => {
    const ctx = makeRig({ designs: ['savate', 'firecracker'] });
    const st = damageState(ctx);
    const head = st.robots[1].parts.get('head')!;
    const headG = geomOf(ctx, 1, 'head');
    const fistL = geomOf(ctx, 0, 'fist_l', 'striker');
    const fistR = geomOf(ctx, 0, 'fist_r', 'striker');
    const myForearm = geomOf(ctx, 0, 'forearm_l');
    const guard = st.robots[1].parts.get('forearm_r')!;
    const guardG = geomOf(ctx, 1, 'forearm_r');
    expect(fistL.role).toBe('striker');

    const clean = tally(head, headG, fistL);
    const blow = popBlow(ctx, group('strike', [clean]), clean);
    expect(blow).toMatchObject({ cause: 'strike', byCorner: 0, impactNs: 20, windowNs: 20, speed: 6 });
    expect(blow!.by).toMatch(/^fist_l/);

    // Through the guard first (same fist, at or before the head): blocked.
    const g1 = tally(guard, guardG, fistL, { t0: 99, impulse: 3, zone: 'forearm' });
    expect(popBlow(ctx, group('strike', [g1, clean]), clean)).toBeNull();
    const g2 = tally(guard, guardG, fistL, { t0: 100, impulse: 3, zone: 'forearm' });
    expect(popBlow(ctx, group('strike', [g2, clean]), clean)).toBeNull();
    // The guard touched after the head, a brush below guardMinNs, or the other fist on the guard: not blocked.
    const late = tally(guard, guardG, fistL, { t0: 103, impulse: 3, zone: 'forearm' });
    expect(popBlow(ctx, group('strike', [late, clean]), clean)).not.toBeNull();
    const brush = tally(guard, guardG, fistL, { t0: 99, impulse: 0.5 * DAMAGE_TUNING.guardMinNs, zone: 'forearm' });
    expect(popBlow(ctx, group('strike', [brush, clean]), clean)).not.toBeNull();
    const otherFist = tally(guard, guardG, fistR, { t0: 99, impulse: 3, zone: 'forearm' });
    expect(popBlow(ctx, group('strike', [otherFist, clean]), clean)).not.toBeNull();

    // A push, a lean, the head moving into a held fist, a forearm landing first: no pop blow.
    expect(popBlow(ctx, group('push', [clean]), clean)).toBeNull();
    const lean = tally(head, headG, fistL, { speed: 0.9 * DAMAGE_TUNING.newStrikeSpeed });
    expect(popBlow(ctx, group('strike', [lean]), lean)).toBeNull();
    const ranInto = tally(head, headG, fistL, { striking: true });
    expect(popBlow(ctx, group('strike', [ranInto]), ranInto)).toBeNull();
    const forearmFirst = tally(head, headG, fistL, { firstOther: myForearm });
    expect(popBlow(ctx, group('strike', [forearmFirst]), forearmFirst)).toBeNull();
  });

  it('the mount needs rating × mountScale, less only for the neck bearing wear, never for shell damage or gear slips', () => {
    const t = DAMAGE_TUNING;
    const ctx = makeRig({ designs: ['firecracker', 'savate'] });
    const st = damageState(ctx);
    const head = st.robots[0].parts.get('head')!;
    const neck = head.jointIdx[0];
    const rating = head.def.detachable!.impulseNs;
    expect(breakImpulseNs(st, head)).toBeCloseTo(rating * t.mountScale, 9);
    // A smashed shell (hp gone) and a slipping yaw gear leave the mount as it was.
    head.part.damage = 1e5;
    ctx.robots[0].joints[neck].health = 0.2;
    expect(mountFactor(st, head)).toBe(1);
    // Bearing-channel wear (the wrench the mount carries) weakens it, down to 1 − mountWear.
    st.robots[0].mech[neck].bearingLoss = 0.5;
    expect(breakImpulseNs(st, head)).toBeCloseTo(rating * t.mountScale * (1 - 0.5 * t.mountWear), 9);
    st.robots[0].mech[neck].bearingLoss = 3;
    expect(mountFactor(st, head)).toBeCloseTo(1 - t.mountWear, 9);
  });

  it('a blow under the mount leaves the head on; a blow over it knocks it off and books who did it', () => {
    const ctx = makeRig({ designs: ['firecracker', 'striker'], rams: [{ name: 'light', massKg: 2, halfSize: 0.05 }, { name: 'heavy', massKg: 30, halfSize: 0.08 }] });
    step(ctx, SETTLE_STEPS);
    drain(ctx);
    const st = damageState(ctx);
    const head = st.robots[0].parts.get('head')!;
    const need = breakImpulseNs(st, head);
    const hg = geomPos(ctx, head.part.geoms[0]);
    fireRam(ctx, 'light', [hg[0] - 0.3, hg[1], hg[2]], [4, 0, 0]);
    step(ctx, 200);
    const light = ofKind(drain(ctx), 'impact').find((e) => e.part === 'head');
    console.info(`[head pop] FIRECRACKER mount needs ${need.toFixed(1)} N·s; 2 kg @ 4 m/s: ${light?.impulseNs.toFixed(1)} N·s over the window`);
    expect(light).toBeDefined();
    expect(light!.impulseNs).toBeLessThan(need);
    expect(head.part.attached).toBe(true);

    fireRam(ctx, 'heavy', [hg[0] - 0.4, hg[1], hg[2]], [8, 0, 0]);
    step(ctx, 200);
    const events = drain(ctx);
    expect(ofKind(events, 'detach')).toHaveLength(1);
    expect(head.part.attached).toBe(false);
    const rec = st.robots[0].ledger.detaches;
    console.info(`[head pop] 30 kg @ 8 m/s: ${JSON.stringify(rec[0])}`);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ part: 'head', cause: 'prop', byCorner: null });
    expect(rec[0].impactNs).toBeGreaterThanOrEqual(rec[0].thresholdNs);
    expect(rec[0].thresholdNs).toBeCloseTo(need, 6);
  });

  it('a head-first fall never pops a head, however battered its shell and worn its mount', () => {
    const ctx = makeRig({ designs: ['firecracker', 'striker'] });
    step(ctx, SETTLE_STEPS);
    drain(ctx);
    const st = damageState(ctx);
    const head = st.robots[0].parts.get('head')!;
    head.part.damage = 1e5;
    st.robots[0].mech[head.jointIdx[0]].bearingLoss = 5; // the weakest the mount gets
    const need = breakImpulseNs(st, head);
    ctx.released = true;
    dropHeadFirst(ctx, 0, 1.7);
    const floor: number[] = [];
    let detaches = 0;
    step(ctx, 1500, () => {
      const events = drain(ctx);
      for (const e of ofKind(events, 'impact')) if (e.victim === 0 && e.part === 'head' && e.striker === null) floor.push(e.impulseNs);
      detaches += ofKind(events, 'detach').length;
    });
    console.info(`[head pop] head-first drop: floor blows on the head ${floor.map((x) => x.toFixed(1)).join(', ')} N·s against a worn mount of ${need.toFixed(1)}`);
    expect(Math.max(0, ...floor)).toBeGreaterThan(need); // the floor hit it harder than a pop blow would need
    expect(detaches).toBe(0);
    expect(head.part.attached).toBe(true);
    expect(st.robots[0].ledger.detaches).toHaveLength(0);
  });

  it('the neck is rated as the head mount: it yields at mountBendShare of a pop load anywhere on the head, not on its module bearing', () => {
    const t = DAMAGE_TUNING;
    const ctx = makeRig({ designs: ['firecracker', 'haymaker'] });
    const st = damageState(ctx);
    for (const corner of [0, 1] as const) {
      const rd = st.robots[corner];
      const head = rd.parts.get('head')!;
      const m = rd.mech[head.jointIdx[0]];
      // Rated for the pop load anywhere on the head: the lever is its reach from the neck anchor.
      const xa = ctx.data.xanchor as Float64Array;
      const gx = ctx.data.geom_xpos as Float64Array;
      const rb = ctx.model.geom_rbound as Float64Array;
      const reach = Math.max(...head.part.geoms.map((g) => Math.hypot(gx[g * 3] - xa[m.mjJoint * 3], gx[g * 3 + 1] - xa[m.mjJoint * 3 + 1], gx[g * 3 + 2] - xa[m.mjJoint * 3 + 2]) + rb[g]));
      const sc = ctx.data.subtree_com as Float64Array;
      const com = Math.hypot(sc[m.bodyId * 3] - xa[m.mjJoint * 3], sc[m.bodyId * 3 + 1] - xa[m.mjJoint * 3 + 1], sc[m.bodyId * 3 + 2] - xa[m.mjJoint * 3 + 2]);
      expect(reach).toBeGreaterThan(1.5 * com); // the crown sits well above the centre of mass
      const mount = (t.mountBendShare * ((head.def.detachable!.impulseNs * t.mountScale) / t.mountPulseS) * reach) / (t.bearingBreak * t.bearingStaticFactor);
      expect(m.bearingMomentNm).toBeCloseTo(Math.max(m.drive.bearingMomentNm, mount), 6);
      expect(m.bearingMomentNm).toBeGreaterThan(m.drive.bearingMomentNm);
    }
  });

  it('one blow books bearing wear once on a 3-axis shoulder, on its most loaded axis', () => {
    const t = DAMAGE_TUNING;
    const ctx = makeRig({ designs: ['savate', 'savate'] });
    const st = damageState(ctx);
    const rd = st.robots[1];
    const arm = rd.parts.get('upperarm_l')!;
    expect(arm.jointIdx).toHaveLength(3);
    const mid = (t.bearingOnset + t.bearingBreak) / 2;
    arm.jointIdx.forEach((i, k) => {
      const m = rd.mech[i];
      m.inEpisode = true;
      m.role = 'victim';
      m.peak = [0, 0, mid + 0.1 * k]; // the last axis carries it most
    });
    arm.armedUntil = ctx.tick - 1; // the arm window just closed
    jointLoadStep(ctx, st);
    const lost = arm.jointIdx.map((i) => 1 - rd.robot.joints[i].health);
    expect(lost.filter((x) => x > 0)).toHaveLength(1);
    expect(lost[2]).toBeGreaterThan(0);
    expect(rd.ledger.jointLoss.bearing.victim).toBeCloseTo(lost[2], 9);
  });

  it('a blow on the trunk arms the legs standing on the canvas (A/B: trunkArmsLegs 0 does not)', () => {
    const armedFeet = (on: number) => {
      const saved = DAMAGE_TUNING.trunkArmsLegs;
      DAMAGE_TUNING.trunkArmsLegs = on;
      try {
        const ctx = makeRig({ designs: ['firecracker', 'savate'], rams: [{ name: 'ram', massKg: 10, halfSize: 0.06 }] });
        step(ctx, SETTLE_STEPS);
        drain(ctx);
        const st = damageState(ctx);
        const rd = st.robots[1];
        const feet = [rd.parts.get('foot_l')!, rd.parts.get('foot_r')!];
        const grounded = feet.filter((f) => f.groundTick >= ctx.tick - 1).length;
        const torso = rd.parts.get('torso')!;
        expect(fireRamAt(ctx, 'ram', geomPos(ctx, torso.part.geoms[0]), [1, 0, 0], 6)).toBe(true);
        let armed = 0;
        let role: string | null = null;
        step(ctx, 60, () => {
          for (const f of feet) if (f.armedUntil >= ctx.tick) { armed++; role ??= f.arm?.role ?? null; }
        });
        return { grounded, armed, role, hit: torso.armedUntil > 0 };
      } finally {
        DAMAGE_TUNING.trunkArmsLegs = saved;
      }
    };
    const on = armedFeet(1);
    const off = armedFeet(0);
    console.info(`[trunk → legs] feet on the canvas ${on.grounded}; foot-ticks armed: on ${on.armed} (${on.role}), off ${off.armed}`);
    expect(on.grounded).toBeGreaterThan(0);
    expect(on.hit && off.hit).toBe(true);
    expect(on.armed).toBeGreaterThan(0);
    expect(on.role).toBe('victim');
    expect(off.armed).toBe(0);
  });
});
