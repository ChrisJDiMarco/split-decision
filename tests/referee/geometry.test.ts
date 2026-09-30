// Referee break geometry: where the standing fighter is sent while his opponent is down.
import { describe, expect, it } from 'vitest';
import { APOTHEM } from '../../src/core/arena-spec';
import { NEUTRAL_M, neutralGoal, neutralSpot } from '../../src/physics/systems/referee';

const ARENA_LIMIT_M = APOTHEM - 0.9;
type P2 = [number, number];
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a: P2) => Math.hypot(a[0], a[1]);

describe('neutral spot', () => {
  it('backs straight away on open floor, NEUTRAL_M from the downed fighter', () => {
    const o: P2 = [0.5, 0], me: P2 = [-0.5, 0];
    const spot = neutralSpot(me, o);
    expect(dist(spot, o)).toBeCloseTo(NEUTRAL_M, 6);
    expect(spot[1]).toBeCloseTo(0, 6); // same bearing: straight back
    expect(spot[0]).toBeLessThan(me[0]);
  });

  it('never walks back in: a fighter already farther away stays at his distance', () => {
    const o: P2 = [1, 0], me: P2 = [-2, 0.1];
    const spot = neutralSpot(me, o);
    expect(dist(spot, o)).toBeCloseTo(dist(me, o), 6);
    expect(dist(spot, me)).toBeLessThan(1e-6);
  });

  it('with the fence behind him, rotates around the downed fighter to open floor instead of pinning him', () => {
    for (const ang of [0, 0.4, 1.3, Math.PI, -2.2]) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const o: P2 = [2.2 * c, 2.2 * s]; // downed near the fence
      const me: P2 = [3.0 * c - 0.1 * s, 3.0 * s + 0.1 * c]; // standing between him and the fence
      const spot = neutralSpot(me, o);
      expect(norm(spot)).toBeLessThanOrEqual(ARENA_LIMIT_M + 1e-9);
      expect(dist(spot, o)).toBeCloseTo(NEUTRAL_M, 6);
    }
  });

  it('picks the smallest rotation that is open floor', () => {
    const o: P2 = [-2.0, 0], me: P2 = [-2.8, 0.05];
    const spot = neutralSpot(me, o);
    const turned = Math.abs(Math.atan2(spot[1] - o[1], spot[0] - o[0]) - Math.atan2(me[1] - o[1], me[0] - o[0]));
    // Straight back (x = -4.5) is outside the cage: open floor starts ~81° round (cos a >= -0.097
    // on the 2.5 m circle about him); the spot is the first 10° search step past it, not further round.
    expect(turned).toBeGreaterThan(1.35);
    expect(turned).toBeLessThan(1.35 + 0.35);
  });
});

describe('neutral goal (the walk there)', () => {
  it('goes around the arc, never closer to the downed fighter than he is', () => {
    const o: P2 = [0, 0];
    const spot: P2 = [0, NEUTRAL_M]; // a quarter turn around him
    let me: P2 = [1.0, 0];
    for (let i = 0; i < 60; i++) {
      const g = neutralGoal(me, o, spot);
      expect(dist([g.x, g.y], o)).toBeGreaterThanOrEqual(Math.min(dist(me, o), NEUTRAL_M) - 1e-9);
      // faces the downed fighter
      expect(Math.cos(g.heading - Math.atan2(o[1] - g.y, o[0] - g.x))).toBeCloseTo(1, 9);
      // take a 0.1 m step toward the goal
      const d = dist([g.x, g.y], me);
      if (d < 1e-6) break;
      const k = Math.min(1, 0.1 / d);
      me = [me[0] + (g.x - me[0]) * k, me[1] + (g.y - me[1]) * k];
    }
    expect(dist(me, spot)).toBeLessThan(0.3);
  });

  it('is the spot itself once there', () => {
    const o: P2 = [0, 0], spot: P2 = [-NEUTRAL_M, 0];
    const g = neutralGoal([-NEUTRAL_M + 0.1, 0.05], o, spot);
    expect(g.x).toBeCloseTo(spot[0], 9);
    expect(g.y).toBeCloseTo(spot[1], 9);
  });

  it('stays inside the cage', () => {
    const o: P2 = [2.4, 0], spot = neutralSpot([3.2, 0.2], o);
    const g = neutralGoal([3.2, 0.2], o, spot);
    expect(norm([g.x, g.y])).toBeLessThanOrEqual(ARENA_LIMIT_M + 1e-9);
  });
});
