// Habit counting (pure): feint bites per level, pressure episodes (circles left / right, backs
// straight up), a hand dropping after a punch, landed shots per zone, and what gets published.
import { describe, expect, test } from 'vitest';
import type { FeintRead } from '../../src/core/protocol';
import type { Vec3 } from '../../src/core/types';
import type { SkillRun } from '../../src/physics/control/skills/types';
import { habitsOf, newHabitState, onHisHands, onLanded, onPressure, onRead, type HabitState } from '../../src/physics/openings';

const read = (level: FeintRead['level'], bit: boolean, reactions: FeintRead['reactions'] = bit ? ['covered'] : []): FeintRead =>
  ({ seq: 1, time: 0, level, limb: 'arm', skill: 'jab', deliberate: true, bit, reactions });

/** You walk at him along +x at 0.6 m/s for `secs`; he moves with `himVel`. Then the pressure stops. */
function episode(h: HabitState, t0: number, secs: number, himVel: Vec3): number {
  const dt = 0.004;
  let me: Vec3 = [-1, 0, 0.9], him: Vec3 = [0.5, 0, 0.9], t = t0;
  for (; t < t0 + secs; t += dt) {
    onPressure(h, { t, dt, me, meVel: [0.6, 0, 0], him, himVel, eitherDown: false });
    me = [me[0] + 0.6 * dt, me[1], me[2]];
    him = [him[0] + himVel[0] * dt, him[1] + himVel[1] * dt, him[2]];
  }
  for (const end = t + 0.4; t < end; t += dt) onPressure(h, { t, dt, me, meVel: [0, 0, 0], him, himVel: [0, 0, 0], eitherDown: false });
  return t;
}

describe('habit model', () => {
  test('bites per level and counters, published from two feints on', () => {
    const h = newHabitState();
    onRead(h, read('high', true));
    expect(habitsOf(h)).toEqual([]); // one feint is no habit
    onRead(h, read('high', true));
    onRead(h, read('high', false));
    onRead(h, read('high', true, ['countered']));
    onRead(h, read('low', false));
    onRead(h, read('low', false));
    const habits = habitsOf(h);
    expect(habits).toContainEqual({ kind: 'bites', level: 'high', n: 3, of: 4 });
    expect(habits).toContainEqual({ kind: 'bites', level: 'low', n: 0, of: 2 });
    expect(habits.find((x) => x.kind === 'counters')).toBeUndefined(); // once is not a habit
  });

  test('under pressure: he circles to his left (he faces −x, so his left is −y)', () => {
    const h = newHabitState();
    let t = 0;
    // He faces −x (toward you); his left is −y.
    for (let i = 0; i < 3; i++) t = episode(h, t, 1.0, [0, -0.4, 0]);
    t = episode(h, t, 1.0, [0, 0.4, 0]);
    expect(habitsOf(h)).toContainEqual({ kind: 'circles', side: 'left', n: 3, of: 4 });
    // Short bursts of pressure are not episodes.
    const g = newHabitState();
    for (let i = 0; i < 4; i++) t = episode(g, t, 0.3, [0, -0.4, 0]);
    expect(habitsOf(g)).toEqual([]);
  });

  test('under pressure: he backs straight up', () => {
    const h = newHabitState();
    let t = 0;
    for (let i = 0; i < 3; i++) t = episode(h, t, 1.0, [0.5, 0, 0]);
    expect(habitsOf(h)).toContainEqual({ kind: 'retreats_straight', n: 3, of: 3 });
  });

  test('he drops his right hand after the cross (2 of 3), never after the jab', () => {
    const h = newHabitState();
    const run = (id: string, side: 'l' | 'r', phase: SkillRun['phase']) => ({ def: { id, side, kind: 'arm' }, phase } as unknown as SkillRun);
    let t = 0;
    const punch = (id: string, side: 'l' | 'r', drop: boolean) => {
      const r = run(id, side, 'strike');
      for (let i = 0; i < 50; i++, t += 0.004) onHisHands(h, t, r, { l: 1.45, r: 1.45 }, 1.45);
      for (let i = 0; i < 150; i++, t += 0.004) onHisHands(h, t, null, { l: 1.45, r: drop && i > 20 && i < 80 ? 1.2 : 1.45 }, 1.45);
    };
    punch('cross', 'r', true);
    punch('cross', 'r', false);
    punch('cross', 'r', true);
    punch('jab', 'l', false);
    punch('jab', 'l', false);
    for (let i = 0; i < 10; i++, t += 0.004) onHisHands(h, t, null, { l: 1.45, r: 1.45 }, 1.45);
    const habits = habitsOf(h);
    expect(habits).toContainEqual({ kind: 'drops_hand', side: 'right', after: 'cross', n: 2, of: 3 });
    expect(habits.some((x) => x.kind === 'drops_hand' && x.after === 'jab')).toBe(false);
    // A pulled windup is not a punch he threw.
    const g = newHabitState();
    const pulled = run('cross', 'r', 'windup');
    onHisHands(g, 0, pulled, { l: 1.45, r: 1.45 }, 1.45);
    for (let i = 1; i < 200; i++) onHisHands(g, i * 0.004, null, { l: 1.45, r: 1.1 }, 1.45);
    expect(g.drops.size).toBe(0);
  });

  test('landed shots per zone, one per strike', () => {
    const h = newHabitState();
    onLanded(h, 'head', 20, 1.0);
    onLanded(h, 'head', 20, 1.05); // the same strike touching again
    onLanded(h, 'head', 3, 2.0); // a touch, not a shot
    onLanded(h, 'left_leg', 12, 2.5);
    onLanded(h, 'head', 15, 3.0);
    expect(h.landed).toEqual({ head: 2, left_leg: 1 });
  });
});
