// Referee breaks on camera: while a knockdown holds the fight, the director frames the fighter getting
// up with the standing one at his neutral spot in the same shot; FIGHT cuts back to the wide.
import { describe, expect, test } from 'vitest';
import type { SimEvent } from '../../../core/protocol';
import { mulberry32 } from '../../../physics/sim-context';
import { DIRECTOR, Director } from '../director';
import type { Subjects } from '../shots';

const DT = 1 / 60;
// Blue on the canvas getting up, red 2.2 m away at his neutral spot.
const scene = (): Subjects => ({ pos: [[-1.5, 0.4, 1.0], [0.6, -0.2, 0.35]], headZ: [1.85, 0.55], heading: [0, Math.PI], down: [false, true] });
const onBreak = [
  { down: false, referee: { break: true, role: 'neutral' as const } },
  { down: true, referee: { break: true, role: 'down' as const } },
];
const fighting = [{ down: false, referee: { break: false } }, { down: false, referee: { break: false } }];

describe('director during a referee break', () => {
  test('every shot of the break is a two-shot on the downed fighter, with both fighters in frame', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const d = new Director(mulberry32(seed));
      d.setMode('live');
      const s = scene();
      for (let t = 0; t < 1; t += DT) d.update(DT, s);
      d.onEvents([{ kind: 'fall', corner: 1 }, { kind: 'break', down: [1] }], onBreak);
      expect(d.breakSubject).toBe(1);
      let cuts = 0;
      for (let t = 0; t < 30; t += DT) {
        d.onEvents([], onBreak);
        const out = d.update(DT, s);
        if (!out.cut) continue;
        cuts++;
        expect(['follow', 'cage_low', 'wide']).toContain(out.shot.kind);
        if (out.shot.kind !== 'wide') expect(out.shot.subject).toBe(1);
        expect(d.status.ok, `${out.shot.kind}: ${d.status.reasons.join(', ')}`).toBe(true); // both fighters fit
      }
      expect(cuts).toBeGreaterThan(4);
    }
  });

  test('FIGHT ends the break framing and cuts to the wide', () => {
    const d = new Director(mulberry32(8));
    d.setMode('live');
    const s = scene();
    d.onEvents([{ kind: 'break', down: [1] }], onBreak);
    for (let t = 0; t < 3; t += DT) d.update(DT, s);
    const fight: SimEvent = { kind: 'fight', breakS: 9.5, reason: 'room' };
    const up: Subjects = { ...s, pos: [s.pos[0], [0.6, -0.2, 1.0]], headZ: [1.85, 1.85], down: [false, false] };
    d.onEvents([fight], fighting);
    expect(d.breakSubject).toBeNull();
    let first: string | null = null;
    for (let t = 0; t < DIRECTOR.MIN_SHOT_S + 0.5 && !first; t += DT) {
      const out = d.update(DT, up);
      if (out.cut) first = out.shot.kind;
    }
    expect(first).toBe('wide');
  });

  test('a double knockdown keeps one subject instead of flipping between the two', () => {
    const d = new Director(mulberry32(3));
    const both = [
      { down: true, referee: { break: true, role: 'down' as const } },
      { down: true, referee: { break: true, role: 'down' as const } },
    ];
    d.onEvents([], onBreak);
    expect(d.breakSubject).toBe(1);
    d.onEvents([], both);
    expect(d.breakSubject).toBe(1);
    // Blue is up and waiting, red still down: red is the one to watch now.
    d.onEvents([], [both[0], { down: false, referee: { break: true, role: 'hold' as const } }]);
    expect(d.breakSubject).toBe(0);
  });
});
