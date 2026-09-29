// The generated motion libraries (src/robots/motions/data, built by tools/mocap/build-library.ts):
// one per biped design, on the runtime contract the tracking controller reads, with the minimum
// move inventory, and geometrically sound: a mirrored sample is the reflected pose, no limb sits
// in the mat, strikes land in front, loops wrap with their stride.
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { DESIGNS } from '../../src/robots/designs';
import { partnerName, parseLibrary } from '../../src/robots/motions/library';
import { matFromQuat } from '../../src/robots/motions/math';
import { bodyLowestZ, fk, newFrames, robotModel, type RobotModel } from '../../src/robots/motions/robot-model';
import { blendSamples, newSample, placeSample, sample, speedFor } from '../../src/robots/motions/sampler';
import { ANGLE_LABELS, FLASHY_LABELS, LIBRARY_FORMAT, MOVE_LABELS, type LibraryJson, type MotionLibrary, type MotionSample, type MoveLabel } from '../../src/robots/motions/types';

const BIPEDS = Object.values(DESIGNS).filter((d) => d.bodyType === 'biped').map((d) => d.id);
const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'];
const MAX_BYTES = 1.5 * 1024 * 1024;

/** Minimum moves per label every design must have (the controller's repertoire). */
const MINIMUM: Partial<Record<MoveLabel, number>> = {
  jab: 3, cross: 3, hook: 2, uppercut: 2, front_kick: 2, low_kick: 2, head_kick: 1, guard_idle: 1,
  shuffle_forward: 1, shuffle_back: 1, shuffle_left: 1, shuffle_right: 1, walk_forward: 1, walk_back: 1,
  getup_face_down: 1, getup_back: 1, victory: 1,
};

const dataUrl = (id: string) => new URL(`../../src/robots/motions/data/${id}.json`, import.meta.url);
const libs = new Map<string, MotionLibrary>();
function lib(id: string): MotionLibrary {
  let l = libs.get(id);
  if (!l) {
    l = parseLibrary(JSON.parse(readFileSync(dataUrl(id), 'utf8')) as LibraryJson);
    libs.set(id, l);
  }
  return l;
}

/** World body positions of a sample posed in its move frame. */
function pose(m: RobotModel, s: MotionSample): Vec3[] {
  const f = fk(m, s.rootPos, matFromQuat(s.rootQuat), s.q, newFrames(m));
  return f.pos.map((p) => [...p] as Vec3);
}

describe('motion libraries', () => {
  it('exist for every biped design, modern roster included', () => {
    expect(BIPEDS).toEqual(expect.arrayContaining(MODERN));
    for (const id of BIPEDS) expect(statSync(dataUrl(id)).size, id).toBeGreaterThan(0);
  });

  for (const id of BIPEDS) {
    describe(id, () => {
      it('is on the runtime contract and under 1.5 MB', () => {
        expect(statSync(dataUrl(id)).size).toBeLessThan(MAX_BYTES);
        const json = JSON.parse(readFileSync(dataUrl(id), 'utf8')) as LibraryJson;
        expect(json.format).toBe(LIBRARY_FORMAT);
        expect(json.design).toBe(id);
        expect(json.fps).toBe(60);
        expect(json.joints).toEqual(robotModel(DESIGNS[id]).joints.map((j) => j.name));
        for (const mv of lib(id).moves) expect(MOVE_LABELS).toContain(mv.label);
      });

      it('has the minimum repertoire (strikes, kicks, footwork, walks, get-ups, victory)', () => {
        const count = (l: MoveLabel) => lib(id).listMoves({ label: l }).length;
        for (const [label, n] of Object.entries(MINIMUM) as Array<[MoveLabel, number]>) expect(count(label), label).toBeGreaterThanOrEqual(n);
      });

      it('stores flashy and angle moves with honest flight, spin and stance data', () => {
        for (const mv of lib(id).moves) {
          if (!mv.flight) continue;
          const a = Math.round(mv.flight.takeoff * mv.fps), b = Math.round(mv.flight.land * mv.fps);
          expect(b, mv.id).toBeGreaterThan(a);
          for (let i = a; i < b; i++) expect(mv.contacts[i], `${mv.id} frame ${i} is airborne`).toBe(0);
          expect(mv.flight.height, mv.id).toBeGreaterThanOrEqual(0);
        }
        // Jumps leave the mat; spins are stored clockwise (the orthodox turn); pivots turn their way.
        for (const mv of lib(id).listMoves({ label: ['tornado_kick', 'jump_kick', 'jumping_knee', 'superman_punch'] })) expect(mv.flight, mv.id).not.toBeNull();
        for (const mv of lib(id).listMoves({ label: ['tornado_kick', 'spinning_back_kick', 'spinning_backfist'] })) expect(mv.spin, mv.id).toBeLessThan(-Math.PI / 2);
        for (const mv of lib(id).listMoves({ label: 'pivot_left' })) expect(mv.spin, mv.id).toBeGreaterThan(0.3);
        for (const mv of lib(id).listMoves({ label: 'pivot_right' })) expect(mv.spin, mv.id).toBeLessThan(-0.3);
        for (const mv of lib(id).listMoves({ label: 'switch_stance' })) expect(mv.switchesStance, mv.id).toBe(true);
        for (const mv of lib(id).listMoves({ label: 'jumping_knee' })) expect(mv.striker, mv.id).toMatch(/^shin_/);
      });

      it('stores strikes orthodox: jabs lead with the left fist, crosses throw the right', () => {
        for (const mv of lib(id).listMoves({ label: 'jab' })) expect([mv.side, mv.striker]).toEqual(['l', 'fist_l']);
        for (const mv of lib(id).listMoves({ label: 'cross' })) expect([mv.side, mv.striker]).toEqual(['r', 'fist_r']);
      });

      it('lands every strike in front, inside its strike window', () => {
        for (const mv of lib(id).moves.filter((x) => x.striker)) {
          expect(mv.target, mv.id).not.toBeNull();
          expect(mv.target![0], mv.id).toBeGreaterThan(0.2);
          expect(mv.impact!, mv.id).toBeGreaterThanOrEqual(mv.phases.strike - 1e-9);
          expect(mv.impact!, mv.id).toBeLessThanOrEqual((mv.reach ?? mv.duration) + 1e-9);
          expect(mv.peakSpeed, mv.id).toBeGreaterThan(1);
        }
      });

      it('keeps every body out of the mat (within the 6 cm gate)', () => {
        const m = robotModel(DESIGNS[id]);
        const f = newFrames(m);
        const nj = m.joints.length;
        for (const mv of lib(id).moves) {
          let sink = 0;
          for (let i = 0; i < mv.frames; i++) {
            const o = i * 7;
            fk(m, [mv.root[o], mv.root[o + 1], mv.root[o + 2]], matFromQuat([mv.root[o + 3], mv.root[o + 4], mv.root[o + 5], mv.root[o + 6]]), mv.q.subarray(i * nj, (i + 1) * nj), f);
            for (let b = 0; b < m.bodies.length; b++) sink = Math.max(sink, -bodyLowestZ(m, f, b));
          }
          expect(sink, mv.id).toBeLessThan(0.065);
        }
      });

      it('mirrors into the reflected pose (southpaw is orthodox seen in a mirror)', () => {
        const m = robotModel(DESIGNS[id]);
        const partner = m.bodies.map((b) => m.bodyIndex.get(partnerName(b.id)) ?? b.index);
        for (const label of MOVE_LABELS) {
          const mv = lib(id).listMoves({ label })[0];
          if (!mv) continue;
          for (const u of [0.2, 0.5, 0.8]) {
            const t = u * mv.duration;
            const a = pose(m, sample(mv, t));
            const b = pose(m, sample(mv, t, { mirror: true }));
            m.bodies.forEach((_, i) => {
              const p = a[partner[i]], q = b[i];
              expect(Math.hypot(q[0] - p[0], q[1] + p[1], q[2] - p[2]), `${mv.id} ${m.bodies[i].id} @${t.toFixed(2)}`).toBeLessThan(0.004);
            });
          }
        }
      });
    });
  }
});

describe('flashy repertoire (electric roster)', () => {
  for (const id of MODERN) {
    it(`${id} has every flashy, angle and kip-up source move`, () => {
      for (const label of [...FLASHY_LABELS, ...ANGLE_LABELS, 'kipup_source' as const]) {
        expect(lib(id).listMoves({ label }).length, label).toBeGreaterThanOrEqual(1);
      }
    });
  }
});

describe('sampler', () => {
  const l = () => lib('savate');

  it('wraps loops and carries their stride into the next cycle', () => {
    const walk = l().listMoves({ label: 'walk_forward' })[0];
    expect(walk.loop).toBe(true);
    const a = sample(walk, 0.3), b = sample(walk, walk.duration + 0.3);
    expect(b.rootPos[0] - a.rootPos[0]).toBeCloseTo(walk.travel[0], 3);
    for (let j = 0; j < a.q.length; j++) expect(b.q[j]).toBeCloseTo(a.q[j], 9);
    expect(b.done).toBe(false);
  });

  it('holds the last frame of a one-shot move and reports done', () => {
    const jab = l().listMoves({ label: 'jab' })[0];
    const s = sample(jab, jab.duration * 3);
    expect(s.done).toBe(true);
    expect(s.time).toBeCloseTo(jab.duration, 9);
    expect(s.phase).toBe('recover');
  });

  it('scales time: speed 2 reaches the impact in half the time, with twice the joint velocity', () => {
    const jab = l().listMoves({ label: 'jab' })[0];
    const slow = sample(jab, jab.impact!), fast = sample(jab, jab.impact! / 2, { speed: 2 });
    for (let j = 0; j < slow.q.length; j++) {
      expect(fast.q[j]).toBeCloseTo(slow.q[j], 6);
      expect(fast.qd[j]).toBeCloseTo(2 * slow.qd[j], 4);
    }
  });

  it('gives joint velocities that are the derivative of the (smooth) joint targets', () => {
    const hook = l().listMoves({ label: 'hook' })[0];
    const h = 1e-4;
    // On a frame, just past one, and mid-segment: the targets are C1 between frames.
    for (const t of [hook.impact!, hook.impact! + 0.2 / 60, hook.impact! + 0.5 / 60]) {
      const s = sample(hook, t), a = sample(hook, t - h), b = sample(hook, t + h);
      for (let j = 0; j < s.q.length; j++) expect(s.qd[j], `joint ${j} at ${t}`).toBeCloseTo((b.q[j] - a.q[j]) / (2 * h), 2);
    }
  });

  it('passes exactly through the stored frames', () => {
    const jab = l().listMoves({ label: 'jab' })[0];
    const nj = l().joints.length;
    for (const k of [0, 7, jab.frames - 1]) {
      const s = sample(jab, k / jab.fps);
      for (let j = 0; j < nj; j++) expect(s.q[j]).toBeCloseTo(jab.q[k * nj + j], 6);
    }
  });

  it('clamps the requested speed to the motors (speedFor)', () => {
    const mv = l().moves[0];
    expect(speedFor(mv, 100)).toBe(mv.maxSpeed);
    expect(speedFor(mv, 0.5)).toBe(Math.min(0.5, mv.maxSpeed));
  });

  it('blends two samples: endpoints are the inputs', () => {
    const [x, y] = l().listMoves({ label: 'guard_idle' });
    const a = sample(x, 0.1), b = sample(y ?? x, 0.4);
    const w0 = blendSamples(a, b, 0), w1 = blendSamples(a, b, 1), out = newSample(a.q.length);
    expect(Array.from(w0.q)).toEqual(Array.from(a.q));
    expect(Array.from(blendSamples(a, b, 1, out).q)).toEqual(Array.from(b.q));
    expect(w1.rootPos).toEqual(b.rootPos);
  });

  it('places a move-frame sample in the arena (position and heading)', () => {
    const mv = l().listMoves({ label: 'shuffle_forward' })[0];
    const s = sample(mv, mv.duration);
    const yaw = Math.PI / 2;
    const p = placeSample({ ...s, q: s.q.slice(), qd: s.qd.slice() }, 1, 2, yaw);
    expect(p.rootPos[0]).toBeCloseTo(1 - s.rootPos[1], 9);
    expect(p.rootPos[1]).toBeCloseTo(2 + s.rootPos[0], 9);
    const heading = (qq: readonly number[]) => {
      const R = matFromQuat(qq as [number, number, number, number]);
      return Math.atan2(R[3], R[0]);
    };
    const d = heading(p.rootQuat) - heading(s.rootQuat) - yaw;
    expect(Math.abs(Math.atan2(Math.sin(d), Math.cos(d)))).toBeLessThan(1e-6);
  });
});
