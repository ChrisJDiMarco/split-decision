import { describe, expect, test } from 'vitest';
import type { SimEvent } from '../../../core/protocol';
import { mulberry32 } from '../../../physics/sim-context';
import { PUNCH, PunchIn, constrainPunch, punchedPose, type PunchFx } from '../punch-in';
import { CameraShake } from '../shake';
import { shotPose, type Shot, type Subjects } from '../shots';
import { insideCage } from '../sightlines';
import { TIME_WARP, TimeWarp, slowScale } from '../time-warp';

const DT = 1 / 60;
const subjects = (): Subjects => ({ pos: [[-0.6, 0, 1], [0.6, 0, 1]], headZ: [1.8, 1.8], heading: [0, Math.PI], down: [false, false] });
const hit = (energyJ: number, speed = 5, over: Partial<Extract<SimEvent, { kind: 'impact' }>> = {}): SimEvent => ({
  kind: 'impact', pos: [0, 0, 1.5], normal: [1, 0, 0], impulseNs: 20, speed, energyJ, striker: 0, victim: 1, part: 'head', metal: false, ...over,
});

/** Wall seconds the warp spends below real time. */
function slowFor(w: TimeWarp, seconds: number, live = true): { stopS: number; minScale: number } {
  let stopS = 0;
  let minScale = 1;
  for (let t = 0; t < seconds; t += DT) {
    const s = w.update(DT, live);
    if (s < 1) stopS += DT;
    minScale = Math.min(minScale, s);
  }
  return { stopS, minScale };
}

describe('time warp', () => {
  test('a big clean strike freezes time for 50-110 ms, scaled by strength, then snaps back', () => {
    const small = new TimeWarp();
    expect(small.onEvents([hit(24)], true)).toBe('hitstop');
    const a = slowFor(small, 0.5);
    const big = new TimeWarp();
    big.onEvents([hit(90, 7)], true);
    const b = slowFor(big, 0.5);
    expect(a.minScale).toBe(TIME_WARP.HITSTOP_SCALE);
    expect(a.stopS).toBeGreaterThanOrEqual(TIME_WARP.HITSTOP_MIN_S - DT);
    expect(b.stopS).toBeGreaterThan(a.stopS);
    expect(b.stopS).toBeLessThanOrEqual(TIME_WARP.HITSTOP_MAX_S + DT);
    expect(big.update(DT, true)).toBe(1);
  });

  test('light hits, shoves and floor slams never stop time', () => {
    const w = new TimeWarp();
    expect(w.onEvents([hit(6), hit(40, 1.5), hit(300, 5, { striker: null })], true)).toBeNull();
    expect(slowFor(w, 0.3).stopS).toBe(0);
  });

  test('foot tangles and ground scrambles never stop time', () => {
    const w = new TimeWarp();
    expect(w.onEvents([hit(26, 3.5, { part: 'foot_l' })], true)).toBeNull();
    expect(w.onEvents([hit(100, 4, { part: 'shin_l' })], true, [{ down: true }, { down: true }])).toBeNull();
    expect(w.onEvents([hit(60, 6)], true, [{ down: false }, { down: false }])).toBe('hitstop');
  });

  test('never more than one hit-stop every 0.4 s', () => {
    const w = new TimeWarp();
    let stops = 0;
    for (let t = 0; t < 2; t += DT) {
      if (w.onEvents([hit(60, 6)], true) === 'hitstop') stops++;
      w.update(DT, true);
    }
    expect(stops).toBeLessThanOrEqual(Math.ceil(2 / TIME_WARP.COOLDOWN_S));
    expect(stops).toBeGreaterThanOrEqual(3);
    expect(w.stats.skippedCooldown).toBeGreaterThan(0);
  });

  test('nothing during replays, breaks or with the toggle off', () => {
    const w = new TimeWarp();
    expect(w.onEvents([hit(90, 7)], false)).toBeNull();
    const off = new TimeWarp(false);
    expect(off.onEvents([hit(90, 7), { kind: 'ko', corner: 1, reason: 'head' }], true)).toBeNull();
    expect(slowFor(off, 1).stopS).toBe(0);
    // A replay starting mid-stop cancels it at once.
    const mid = new TimeWarp();
    mid.onEvents([hit(90, 7)], true);
    expect(mid.update(DT, false)).toBe(1);
    expect(mid.update(DT, true)).toBe(1);
  });

  test('a KO slows to ~0.3x for ~1.2 s, after the hit-stop of the blow that caused it', () => {
    const w = new TimeWarp();
    w.onEvents([hit(90, 7), { kind: 'detach', corner: 1, part: 'head', debrisBody: 9, pos: [0, 0, 1.7], vel: [0, 0, 0] }, { kind: 'ko', corner: 1, reason: 'head' }], true);
    const scales: number[] = [];
    for (let t = 0; t < 2; t += DT) scales.push(w.update(DT, true));
    expect(scales[0]).toBe(TIME_WARP.HITSTOP_SCALE);
    const slow = scales.filter((s) => s > TIME_WARP.HITSTOP_SCALE && s < 1);
    expect(slow.length * DT).toBeGreaterThan(TIME_WARP.SLOWMO_S - 0.1);
    expect(Math.min(...slow)).toBeCloseTo(TIME_WARP.SLOWMO_SCALE, 5);
    expect(scales[scales.length - 1]).toBe(1);
    expect(w.stats.slowMos).toBe(1);
  });

  test('a down-count KO gets no slow motion (nothing is moving)', () => {
    const w = new TimeWarp();
    expect(w.onEvents([{ kind: 'ko', corner: 0, reason: 'down' }], true)).toBeNull();
  });

  test('slow-mo profile eases in and out', () => {
    expect(slowScale(0)).toBe(1);
    expect(slowScale(0.5)).toBe(TIME_WARP.SLOWMO_SCALE);
    expect(slowScale(TIME_WARP.SLOWMO_S - 0.01)).toBeGreaterThan(0.9);
  });
});

describe('camera punch-in', () => {
  test('a big hit pushes in and squeezes the lens fast, then settles back', () => {
    const p = new PunchIn();
    p.hit([0, 0, 1.5], 0.9);
    const series: PunchFx[] = [];
    for (let t = 0; t < 1.5; t += DT) {
      const fx = p.update(DT, subjects());
      if (fx) series.push(fx);
    }
    const peak = Math.max(...series.map((f) => f.push));
    const peakAt = series.findIndex((f) => f.push === peak);
    expect(peakAt * DT).toBeLessThan(0.1); // sharp attack
    expect(peak).toBeGreaterThan(PUNCH.PUSH * 0.6);
    expect(Math.min(...series.map((f) => f.fovScale))).toBeLessThan(0.95);
    expect(p.update(DT, subjects())).toBeNull(); // gone after the decay
  });

  test('small hits do not punch in', () => {
    const p = new PunchIn();
    p.hit([0, 0, 1.5], 0.3);
    expect(p.update(DT, subjects())).toBeNull();
  });

  test('the KO push-in builds over ~1.2 s, tracks its target, and holds until reset', () => {
    const p = new PunchIn();
    let x = 0;
    p.drama(() => [x, 0, 1.2]);
    let fx: PunchFx | null = null;
    for (let t = 0; t < 3; t += DT) {
      x += 0.01;
      fx = p.update(DT, subjects());
    }
    expect(fx!.push).toBeCloseTo(PUNCH.DRAMA_PUSH, 5);
    expect(fx!.point[0]).toBeCloseTo(x, 5);
    p.hit([0, 0, 1.5], 1); // hits don't interrupt the drama
    expect(p.update(DT, subjects())!.push).toBeCloseTo(PUNCH.DRAMA_PUSH, 5);
    p.reset();
    expect(p.update(DT, subjects())).toBeNull();
  });

  test('the punched pose moves the lens toward the contact and never past the push cap', () => {
    const pose = { pos: [0, -8, 3] as [number, number, number], target: [0, 0, 1] as [number, number, number], fov: 40 };
    const out = punchedPose(pose, { point: [0, 0, 1.5], push: 0.9, maxPushM: 0.5, aim: 0.5, fovScale: 0.9 });
    expect(Math.hypot(out.pos[0] - pose.pos[0], out.pos[1] - pose.pos[1], out.pos[2] - pose.pos[2])).toBeCloseTo(0.5, 5);
    expect(out.target[2]).toBeCloseTo(1.25, 5);
    expect(out.fov).toBeCloseTo(36, 5);
  });

  test('a punch that would hide a fighter behind the other is backed off', () => {
    const s = subjects();
    const shot: Shot = { kind: 'follow', subject: 0, side: 1, anchor: null, focusBody: null, angle: 0 };
    const pose = shotPose(shot, s, 0);
    const clean: PunchFx = { point: [0, 0, 1.4], push: 0.05, maxPushM: 0.9, aim: 0.2, fovScale: 0.95 };
    expect(constrainPunch(clean, shot, pose, s, 16 / 9)).toEqual(clean);
    // Aim a huge push at a point right behind fighter 1 so fighter 0's sight lines cross him.
    const behind: PunchFx = { point: [s.pos[1][0] + 0.4, s.pos[1][1], 1.0], push: 1, maxPushM: 50, aim: 1, fovScale: 0.8 };
    const safe = constrainPunch(behind, shot, pose, s, 16 / 9);
    expect(safe === null || safe.push < behind.push).toBe(true);
  });
});

describe('punch-in and the fence', () => {
  test('a full-strength punch never carries a cage-side lens through the fence, but still squeezes it', () => {
    const s = subjects();
    for (const slot of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const shot: Shot = { kind: 'cage_low', subject: 0, side: 1, anchor: null, focusBody: null, angle: 0, slot };
      const pose = shotPose(shot, s, 4); // late in the shot: the slow push has the lens 0.4 m off the fence
      const full: PunchFx = { point: [0.3, -0.1, 1.4], push: PUNCH.PUSH, maxPushM: PUNCH.MAX_PUSH_M, aim: PUNCH.AIM, fovScale: 1 - PUNCH.FOV_SQUEEZE };
      const safe = constrainPunch(full, shot, pose, s, 16 / 9);
      expect(safe).not.toBeNull();
      expect(insideCage(punchedPose(pose, safe!).pos, -0.1)).toBe(false);
      expect(safe!.fovScale).toBeLessThan(1);
    }
  });
});

describe('directional shake', () => {
  test('a landed hit jolts the frame along the impact normal, then rings out in ~0.2 s', () => {
    const sh = new CameraShake(mulberry32(1));
    sh.kick([0, 1, 0], 1);
    const first = sh.update(0.001);
    expect(Math.abs(first[1])).toBeGreaterThan(Math.abs(first[0]) * 5);
    expect(first[1]).toBeGreaterThan(0.03);
    let last: [number, number, number] = first;
    for (let t = 0; t < 0.3; t += DT) last = sh.update(DT);
    expect(Math.hypot(...last)).toBeLessThan(0.004);
  });
  test('trauma scales with strength and small touches add none', () => {
    expect(CameraShake.forStrength(0.1)).toBe(0);
    expect(CameraShake.forStrength(1)).toBeGreaterThan(CameraShake.forStrength(0.5));
  });
});
