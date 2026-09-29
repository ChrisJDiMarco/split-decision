import { describe, expect, test } from 'vitest';
import type { SimEvent } from '../../../core/protocol';
import { mulberry32 } from '../../../physics/sim-context';
import { DIRECTOR, Director } from '../director';
import { CameraShake } from '../shake';
import { resolveShot } from '../shot-plan';
import { FRAMING, shotPose, type ShotKind, type Subjects } from '../shots';

const subjects = (): Subjects => ({ pos: [[-1.2, 0.4, 1], [1.1, -0.3, 1]], headZ: [1.9, 1.9], heading: [0, Math.PI], down: [false, false] });
const DT = 1 / 60;

const bigHit: SimEvent = { kind: 'impact', pos: [0, 0, 1.5], normal: [1, 0, 0], impulseNs: 80, speed: 7, energyJ: 450, striker: 0, victim: 1, part: 'head', metal: true };

function run(d: Director, seconds: number, s = subjects()): Array<{ t: number; kind: ShotKind }> {
  const cuts: Array<{ t: number; kind: ShotKind }> = [];
  for (let t = 0; t < seconds; t += DT) {
    const out = d.update(DT, s);
    if (out.cut) cuts.push({ t, kind: out.shot.kind });
  }
  return cuts;
}

describe('director', () => {
  test('live rotation never holds a shot under the minimum and never repeats a shot back to back', () => {
    const d = new Director(mulberry32(3));
    d.setMode('live');
    const cuts = run(d, 120);
    expect(cuts.length).toBeGreaterThan(15);
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i].t - cuts[i - 1].t).toBeGreaterThanOrEqual(DIRECTOR.MIN_SHOT_S - DT);
      expect(cuts[i].kind).not.toBe(cuts[i - 1].kind);
    }
  });

  test('a big impact cuts to a reaction shot, but only after the minimum shot length', () => {
    const d = new Director(mulberry32(5));
    d.setMode('live');
    run(d, 0.5);
    d.onEvents([bigHit]);
    const cuts = run(d, 1.8);
    expect(cuts[0]?.t ?? 0).toBeGreaterThanOrEqual(DIRECTOR.MIN_SHOT_S - 0.5 - DT - 1e-9);
    expect(['cage_low', 'follow']).toContain(cuts[0].kind);
    expect(d.shot.subject).toBe(1); // the victim
  });

  test('a detach cuts to the debris shot tracking the flying part', () => {
    const d = new Director(mulberry32(7));
    d.setMode('live');
    run(d, 2.5);
    d.onEvents([{ kind: 'detach', corner: 1, part: 'head', debrisBody: 42, pos: [1, 0, 2], vel: [2, 0, 4] }]);
    const s = subjects();
    s.bodyPos = (b) => (b === 42 ? [2, 0.5, 0.3] : null);
    const out = d.update(DT, s);
    expect(out.cut).toBe(true);
    expect(out.shot.kind).toBe('debris');
    expect(out.pose.target[0]).toBeCloseTo(2, 5);
  });

  test('a hit right after a cut still gets its reaction shot at the minimum length', () => {
    const d = new Director(mulberry32(9));
    d.setMode('live');
    run(d, 0.05);
    d.onEvents([bigHit]);
    const cuts = run(d, DIRECTOR.MIN_SHOT_S);
    expect(cuts).toHaveLength(1);
    expect(d.shot.subject).toBe(1);
  });

  test('every shot gives a finite pose; in-cage cameras stay inside the fence', () => {
    const inside: ShotKind[] = ['ots', 'follow', 'debris', 'intro', 'victory', 'replay'];
    const s = subjects();
    s.pos = [[3.6, 0.2, 1], [3.9, -0.4, 1]]; // pressed against the fence
    for (const kind of [...inside, 'wide', 'cage_low', 'overhead', 'establish'] as ShotKind[]) {
      for (const t of [0, 1.7, 6]) {
        const pose = shotPose({ kind, subject: 0, side: 1, anchor: [3.5, 0, 1.2], focusBody: null, angle: 0.4 }, s, t);
        for (const v of [...pose.pos, ...pose.target, pose.fov]) expect(Number.isFinite(v)).toBe(true);
        if (inside.includes(kind)) expect(Math.hypot(pose.pos[0], pose.pos[1])).toBeLessThanOrEqual(FRAMING.INSIDE_R + 1e-6);
      }
    }
  });
});

describe('occlusion', () => {
  const blocked = (pose: { pos: number[]; target: number[] }, b: number[]) => {
    const [cx, cy] = pose.pos;
    const dx = pose.target[0] - cx;
    const dy = pose.target[1] - cy;
    const u = Math.max(0, Math.min(1, ((b[0] - cx) * dx + (b[1] - cy) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(cx + dx * u - b[0], cy + dy * u - b[1]) < 0.55;
  };

  test('a replay angle a fighter blocks is turned to a clear one at the cut', () => {
    // victim under the anchor (ignored), striker standing on the preferred +x sight line
    const s: Subjects = { pos: [[0.1, 0.1, 0.4], [1.8, 0.1, 1]], headZ: [0.6, 1.9], heading: [0, 0], down: [true, false] };
    const shot = { kind: 'replay' as ShotKind, subject: 0 as const, side: 1 as const, anchor: [0, 0, 1] as [number, number, number], focusBody: null, angle: 0 };
    expect(blocked(shotPose(shot, s, 0), s.pos[1])).toBe(true);
    const resolved = resolveShot(shot, s);
    expect(resolved.angle).not.toBe(0);
    expect(blocked(shotPose(resolved, s, 0), s.pos[1])).toBe(false);
  });

  test('a clear shot is left alone', () => {
    const s: Subjects = { pos: [[0.1, 0.1, 0.4], [0, 1.8, 1]], headZ: [0.6, 1.9], heading: [0, 0], down: [true, false] };
    const shot = { kind: 'replay' as ShotKind, subject: 0 as const, side: 1 as const, anchor: [0, 0, 1] as [number, number, number], focusBody: null, angle: 0 };
    expect(resolveShot(shot, s).angle).toBe(0);
  });
});

describe('camera shake', () => {
  test('scales with impact energy and decays to rest', () => {
    expect(CameraShake.forEnergy(900)).toBeGreaterThan(CameraShake.forEnergy(100));
    const s = new CameraShake(mulberry32(1));
    s.add(CameraShake.forEnergy(900));
    const mag = (v: number[]) => Math.hypot(...v);
    let peak = 0;
    for (let i = 0; i < 10; i++) peak = Math.max(peak, mag(s.update(DT)));
    expect(peak).toBeGreaterThan(0.01);
    for (let i = 0; i < 120; i++) s.update(DT);
    expect(mag(s.update(DT))).toBe(0);
  });
});
