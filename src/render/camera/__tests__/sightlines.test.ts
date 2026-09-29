import { describe, expect, test } from 'vitest';
import { APOTHEM, ARENA, panels, postPositions } from '../../../core/arena-spec';
import type { Vec3 } from '../../../core/types';
import { mulberry32 } from '../../../physics/sim-context';
import { TRUSS_Y } from '../../arena/lighting';
import { DIRECTOR, Director } from '../director';
import { checkPose, planShot } from '../shot-plan';
import { FRAMING, shotPose, type Shot, type ShotKind, type Subjects } from '../shots';
import { ARENA_OCCLUDERS, RIG, firstBlocker, fitFov, frameClutter, insideCage, segmentDistance, viewBasis } from '../sightlines';

const DT = 1 / 60;
const ASPECT = 16 / 9;
const LIVE: ShotKind[] = ['wide', 'cage_low', 'follow', 'ots', 'overhead'];

const standing = (a: [number, number], b: [number, number]): Subjects => ({
  pos: [[a[0], a[1], 1.05], [b[0], b[1], 1.05]],
  headZ: [1.8, 1.8],
  heading: [0, Math.PI],
  down: [false, false],
});

const shotOf = (kind: ShotKind, extra: Partial<Shot> = {}): Shot => ({ kind, subject: 0, side: 1, anchor: null, focusBody: null, angle: 0, slot: null, ...extra });

/** Random fight positions: anywhere inside the fence, 0.6-6 m apart, sometimes one down. */
function randomSubjects(rng: () => number): Subjects {
  const pt = (): [number, number] => {
    for (;;) {
      const p: [number, number] = [(rng() * 2 - 1) * APOTHEM, (rng() * 2 - 1) * APOTHEM];
      if (insideCage([p[0], p[1], 0], 0.35)) return p;
    }
  };
  for (;;) {
    const a = pt();
    const b = pt();
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < 0.6 || d > 6) continue;
    const s = standing(a, b);
    if (rng() < 0.2) {
      s.pos[1] = [b[0], b[1], 0.3];
      s.headZ[1] = 0.4;
      s.down[1] = true;
    }
    return s;
  }
}

describe('arena sight lines', () => {
  test('the occluder model matches the lighting rig and the cage', () => {
    expect(RIG.TRUSS_Z).toBe(TRUSS_Y);
    expect(ARENA_OCCLUDERS.filter((o) => o.kind === 'post')).toHaveLength(ARENA.SIDES);
    expect(ARENA_OCCLUDERS.filter((o) => o.kind === 'truss')).toHaveLength(ARENA.SIDES + 2);
  });

  test('segment distance handles crossing, parallel and point cases', () => {
    expect(segmentDistance([0, 0, 0], [2, 0, 0], [1, -1, 1], [1, 1, 1])).toBeCloseTo(1, 9);
    expect(segmentDistance([0, 0, 0], [1, 0, 0], [0, 2, 0], [1, 2, 0])).toBeCloseTo(2, 9);
    expect(segmentDistance([0, 0, 0], [0, 0, 0], [3, 4, 0], [3, 4, 0])).toBeCloseTo(5, 9);
  });

  test('a post between the lens and a fighter blocks; the chain link beside it does not', () => {
    const [px, py] = postPositions()[0];
    const out: Vec3 = [px * 1.25, py * 1.25, 1.2];
    expect(firstBlocker(out, [0, 0, 1.2])?.kind).toBe('post');
    const panel = panels()[0];
    const cam: Vec3 = [Math.cos(panel.normalAngle) * (APOTHEM + 0.7), Math.sin(panel.normalAngle) * (APOTHEM + 0.7), 1.2];
    expect(firstBlocker(cam, [0, 0, 1.2])).toBeNull();
  });

  test('the old overhead above the truss was blocked; the new one hangs below it and never sees it', () => {
    const s = standing([-1.2, 0.3], [1.1, -0.2]);
    const old: Vec3 = [0, -2.2, 8.8];
    expect(frameClutter(old, [0, 0, 0.4], 42, ASPECT)).toBeGreaterThan(2);
    for (const t of [0, 3, 8]) {
      const pose = shotPose(shotOf('overhead'), s, t, ASPECT);
      expect(pose.pos[2]).toBeLessThan(RIG.FIXTURE_Z - RIG.FIXTURE_R - 0.5);
      const { fwd } = viewBasis(pose.pos, pose.target);
      const pitchDown = Math.asin(-fwd[2]);
      expect(pitchDown - (pose.fov * Math.PI) / 360).toBeGreaterThan(0); // frame top still looks down
      expect(checkPose(shotOf('overhead'), pose, s, ASPECT).ok).toBe(true);
    }
  });

  test('cage-side cameras stand mid-panel, outside the fence, at chest height, clear of every post', () => {
    const s = standing([-1.4, 0.5], [1.2, -0.4]);
    for (let i = 0; i < ARENA.SIDES; i++) {
      for (const t of [0, 2, 6]) {
        const pose = shotPose(shotOf('cage_low', { slot: i }), s, t, ASPECT);
        const r = Math.hypot(pose.pos[0], pose.pos[1]);
        expect(insideCage(pose.pos)).toBe(false);
        expect(r).toBeLessThan(APOTHEM + ARENA.APRON_M);
        expect(pose.pos[2]).toBeCloseTo(FRAMING.CAGE_CAM_Z, 6);
        for (const [px, py] of postPositions()) expect(Math.hypot(pose.pos[0] - px, pose.pos[1] - py)).toBeGreaterThan(1.5);
      }
    }
    const planned = planShot(shotOf('cage_low'), s, ASPECT);
    expect(planned.check.ok).toBe(true);
    expect(frameClutter(shotPose(planned.shot, s, 0, ASPECT).pos, [0, 0, 1.2], 40, ASPECT)).toBeLessThanOrEqual(1);
  });

  test('fitFov frames every point', () => {
    const pos: Vec3 = [0, -6, 1.2];
    const pts: Vec3[] = [[-2, 0, 0.2], [2, 0, 2]];
    const fov = fitFov(pos, [0, 0, 1.1], pts, ASPECT);
    expect(fov).toBeGreaterThan(10);
    expect(fitFov(pos, [0, 0, 1.1], pts, ASPECT, 0)).toBeLessThan(fov);
    expect(fitFov(pos, [0, 0, 1.1], [[0, -7, 1]], ASPECT)).toBe(Infinity);
  });
});

describe('director sight-line planning', () => {
  test('across 400 random fight positions, every live cut lands on a clear pose', () => {
    const rng = mulberry32(11);
    let blocked = 0;
    let cuts = 0;
    const fell: Record<string, number> = {};
    for (let i = 0; i < 400; i++) {
      const s = randomSubjects(rng);
      for (const kind of LIVE) {
        const d = new Director(mulberry32(i));
        d.setMode('live');
        d.update(DT, s);
        d.cut(kind, (i % 2) as 0 | 1);
        const out = d.update(DT, s);
        cuts++;
        if (!d.status.ok) blocked++;
        if (out.shot.kind !== kind) fell[kind] = (fell[kind] ?? 0) + 1;
        // Arena hardware must never sit on a torso sight line.
        expect(d.status.reasons.filter((r) => /post|rail|truss|fixture|hardware/.test(r))).toEqual([]);
      }
    }
    expect(blocked / cuts).toBeLessThan(0.01);
  });

  test('a shot that cannot frame both fighters falls back to one that can', () => {
    const d = new Director(mulberry32(4));
    d.aspect = 1;
    d.setMode('live');
    const s = standing([-3.2, 0], [3.2, 0]);
    d.update(DT, s);
    d.cut('cage_low');
    const out = d.update(DT, s);
    expect(d.status.ok).toBe(true);
    expect(out.shot.kind).not.toBe('cage_low');
  });

  test('a fighter walking onto the cage-side lens forces a cut once the minimum shot has run', () => {
    const d = new Director(mulberry32(2));
    d.setMode('live');
    const s = standing([-1, 0.2], [1, -0.2]);
    d.update(DT, s);
    d.cut('cage_low');
    let out = d.update(DT, s);
    expect(out.shot.kind).toBe('cage_low');
    // Fighter 1 backs up against the camera's panel.
    const cam = out.pose.pos;
    const r = Math.hypot(cam[0], cam[1]);
    const moved: Subjects = { ...s, pos: [s.pos[0], [(cam[0] / r) * (APOTHEM - 0.3), (cam[1] / r) * (APOTHEM - 0.3), 1.05]] };
    let cutAt = -1;
    for (let t = DT; t < DIRECTOR.MIN_SHOT_S + 1; t += DT) {
      out = d.update(DT, moved);
      if (out.cut) {
        cutAt = t;
        break;
      }
    }
    expect(cutAt).toBeGreaterThanOrEqual(DIRECTOR.MIN_SHOT_S - 2 * DT);
    expect(cutAt).toBeLessThan(DIRECTOR.MIN_SHOT_S + DIRECTOR.BLOCKED_GRACE_S + 0.1);
  });

  test('a KO replay centres on the impact', () => {
    const d = new Director(mulberry32(8));
    const s = standing([0.4, 0.1], [1.2, 0.3]);
    const anchor: Vec3 = [0.8, 0.2, 1.3];
    d.setMode('replay', { anchor, subject: 0 });
    const out = d.update(DT, s);
    expect(out.pose.target[0]).toBeCloseTo(anchor[0], 6);
    expect(out.pose.target[1]).toBeCloseTo(anchor[1], 6);
    expect(d.status.ok).toBe(true);
  });
});
