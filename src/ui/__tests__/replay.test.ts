import { describe, expect, test } from 'vitest';
import type { RobotTelemetry, SimEvent } from '../../core/protocol';
import { ReplayBuffer, eventsBetween, findHighlight, findKoHighlight, frameIndexAt, samplePoses, type ReplayFrame } from '../replay-buffer';
import { REPLAY, ReplayPlayer } from '../replay-player';

const TEL = [{} as RobotTelemetry, {} as RobotTelemetry] as [RobotTelemetry, RobotTelemetry];

/** One body at x = time, identity rotation. */
function frame(time: number, events: SimEvent[] = [], x = time): ReplayFrame {
  return { time, poses: new Float32Array([x, 0, 1, 1, 0, 0, 0]), events, telemetry: TEL };
}

const impact = (energyJ: number): SimEvent => ({
  kind: 'impact', pos: [1, 2, 3], normal: [1, 0, 0], impulseNs: 10, speed: 5, energyJ, striker: 0, victim: 1, part: 'head', metal: true,
});

describe('replay buffer', () => {
  test('keeps only the last window of sim time and ignores paused frames', () => {
    const b = new ReplayBuffer(10, 2000);
    for (let i = 0; i <= 1500; i++) b.push(frame(i / 60));
    expect(b.last()!.time).toBeCloseTo(25, 5);
    expect(b.last()!.time - b.first()!.time).toBeLessThanOrEqual(10);
    expect(b.last()!.time - b.first()!.time).toBeGreaterThan(9.9);
    expect(b.push(frame(25))).toBe(false); // sim paused: same time
  });

  test('capacity overflow drops the oldest frames', () => {
    const b = new ReplayBuffer(100, 5);
    for (let i = 0; i < 12; i++) b.push(frame(i));
    expect(b.size).toBe(5);
    expect(b.snapshot().map((f) => f.time)).toEqual([7, 8, 9, 10, 11]);
  });

  test('samplePoses interpolates position and normalises quaternions', () => {
    const a = frame(0, [], 0);
    const b: ReplayFrame = { time: 1, poses: new Float32Array([0.5, 0, 1, Math.SQRT1_2, 0, 0, Math.SQRT1_2]), events: [], telemetry: TEL };
    const p = samplePoses([a, b], 0.5);
    expect(p[0]).toBeCloseTo(0.25, 5);
    expect(Math.hypot(p[3], p[4], p[5], p[6])).toBeCloseTo(1, 5);
    expect(p[6]).toBeGreaterThan(0.3);
  });

  test('teleports (debris un-parking) snap instead of streaking', () => {
    const a = frame(0, [], 40);
    const b = frame(1, [], 0);
    expect(samplePoses([a, b], 0.3)[0]).toBe(40);
    expect(samplePoses([a, b], 0.7)[0]).toBe(0);
  });

  test('eventsBetween returns events in (t0, t1]', () => {
    const frames = [frame(0, [impact(1)]), frame(1, [impact(2)]), frame(2, [impact(3)])];
    const got = eventsBetween(frames, 0, 2).map((e) => (e.kind === 'impact' ? e.energyJ : -1));
    expect(got).toEqual([2, 3]);
  });

  test('a detach outranks any impact as the highlight', () => {
    const detach: SimEvent = { kind: 'detach', corner: 1, part: 'head', debrisBody: 9, pos: [0, 0, 2], vel: [0, 0, 1] };
    const frames = [frame(0, [impact(900)]), frame(1, [detach]), frame(2, [impact(100)])];
    expect(findHighlight(frames)!.time).toBe(1);
    expect(findHighlight(frames.slice(0, 1))!.pos).toEqual([1, 2, 3]);
  });
});

describe('KO replay highlight', () => {
  const fall: SimEvent = { kind: 'fall', corner: 1 };
  const onWinner: SimEvent = { ...impact(900), striker: 1, victim: 0, pos: [9, 9, 9] } as SimEvent;

  test('a down-count KO still holds and replays the knockdown blow when the replay starts', () => {
    // blow on the loser at 20 s, fall at 20.5 s, KO 10 s later, replay after a 2.8 s KO hold
    const koT = 30.5;
    const b = new ReplayBuffer();
    for (let i = 0; i <= Math.round((koT + 2.8) * 60); i++) {
      const ev = i === 1200 ? [impact(420)] : i === 1230 ? [fall] : i === 1500 ? [onWinner] : [];
      b.push(frame(i / 60, ev));
    }
    const frames = b.snapshot();
    const hl = findKoHighlight(frames, 1, koT, 'down')!;
    expect(hl.time).toBeCloseTo(20, 5);
    expect(hl.pos).toEqual([1, 2, 3]);
    const p = new ReplayPlayer(frames, hl);
    expect(p.start).toBeCloseTo(20 - REPLAY.LEAD_S, 5);
    expect(eventsBetween(frames, p.start, p.end)).toContain(frames[frameIndexAt(frames, 20)].events[0]);
  });

  test('a down-count KO through failed rises replays the knockdown that started the count', () => {
    // blow at 20 s, knockdown at 20.5 s; failed rises fall again at 27 s and 33 s (no blow); the count
    // runs through them (damage/ko.ts), so the KO lands 20 s after the knockdown
    const koT = 40.5;
    const b = new ReplayBuffer();
    for (let i = 0; i <= Math.round((koT + 2.8) * 60); i++) {
      const ev = i === 1200 ? [impact(420)] : i === 1230 || i === 1620 || i === 1980 ? [fall] : [];
      b.push(frame(i / 60, ev));
    }
    const hl = findKoHighlight(b.snapshot(), 1, koT, 'down')!;
    expect(hl.time).toBeCloseTo(20, 5);
    expect(hl.pos).toEqual([1, 2, 3]);
  });

  test('a head KO replays the head coming off, not an earlier knockdown', () => {
    const detach: SimEvent = { kind: 'detach', corner: 1, part: 'head', debrisBody: 9, pos: [0, 0, 2], vel: [0, 0, 1] };
    const frames = [frame(0), frame(1, [impact(300)]), frame(1.2, [fall]), frame(4, [detach]), frame(5)];
    expect(findKoHighlight(frames, 1, 4, 'head')!.time).toBe(4);
  });

  test('a down KO with no blow on record replays the fall itself', () => {
    const frames = [frame(0, [onWinner]), frame(2, [fall]), frame(12)];
    const hl = findKoHighlight(frames, 1, 12, 'down')!;
    expect(hl.time).toBe(2);
    expect(hl.pos).toBeNull();
  });
});

describe('replay player', () => {
  test('leads in at half speed, plays the highlight at 0.25x and ends after it', () => {
    const frames: ReplayFrame[] = [];
    for (let i = 0; i <= 600; i++) frames.push(frame(i / 60, i === 480 ? [impact(500)] : []));
    const p = new ReplayPlayer(frames);
    expect(p.start).toBeCloseTo(8 - REPLAY.LEAD_S, 5);
    expect(p.end).toBeCloseTo(8 + REPLAY.TAIL_S, 5);
    let wall = 0;
    let sawImpact = false;
    let slowSpeed = 1;
    for (;;) {
      const tick = p.update(1 / 60);
      wall += 1 / 60;
      if (tick.events.length) sawImpact = true;
      if (p.t > 8) slowSpeed = Math.min(slowSpeed, tick.speed);
      if (tick.done) break;
      if (wall > 60) throw new Error('replay never ended');
    }
    expect(sawImpact).toBe(true);
    expect(slowSpeed).toBeCloseTo(REPLAY.SLOW_SPEED, 2);
    // lead ~2.2 s at ~0.5x plus ~2.4 s at 0.25x
    expect(wall).toBeGreaterThan(12);
    expect(wall).toBeLessThan(17);
    expect(p.poses()[0]).toBeCloseTo(p.t, 3);
  });

  test('needs at least two frames', () => {
    expect(() => new ReplayPlayer([frame(0)])).toThrow();
  });
});
