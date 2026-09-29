import { describe, expect, test } from 'vitest';
import type { RobotTelemetry, SimEvent } from '../../core/protocol';
import { BRUISER, STRIKER } from '../../robots/designs';
import { compileRobot } from '../../robots/compile-mjcf';
import { tacticLabel, topTactics } from '../minds';
import { jointName, partName } from '../names';
import { RoundClock, formatClock } from '../round-clock';
import { Scorecard } from '../scorecard';
import { taleOfTheTape } from '../tale';
import { TickerFeed } from '../ticker-feed';
import { defaultPlan, wordCount } from '../select-screen';

function telemetry(corner: 0 | 1, over: Partial<RobotTelemetry> = {}): RobotTelemetry {
  return {
    corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
    battery: 1, gyroHealth: 1, gyroSaturation: 0, hydraulicPressure: {}, skill: 'stance', skillPhase: 0, windup: 0,
    parts: [], joints: [], damageTotal: 0, intent: null, ...over,
  };
}

const hit = (striker: 0 | 1, energyJ: number, part = 'head'): SimEvent => ({
  kind: 'impact', pos: [0, 0, 1.5], normal: [1, 0, 0], impulseNs: energyJ / 4, speed: 6, energyJ,
  striker, victim: striker === 0 ? 1 : 0, part, metal: true,
});

describe('names', () => {
  test('joint and part names read like commentary', () => {
    expect(jointName('knee_l')).toBe('left knee');
    expect(jointName('shoulder_pitch_r')).toBe('right shoulder');
    expect(jointName('neck_yaw')).toBe('neck');
    expect(partName('upperarm_r')).toBe('right upper arm');
    expect(partName('head')).toBe('head');
  });
});

describe('minds', () => {
  test('topTactics sorts, truncates and normalises', () => {
    const r = topTactics({ jab: 2, cross: 1, hook: 0.5, guard: 0.3, feint: 0.1, ram: 0.1, lunge: 0 }, 5);
    expect(r.map((x) => x.tactic)).toEqual(['jab', 'cross', 'hook', 'guard', 'feint']);
    expect(r[0].p).toBeCloseTo(2 / 4, 5);
    expect(topTactics({})).toEqual([]);
    expect(tacticLabel('close_distance')).toBe('CLOSE DISTANCE');
  });
});

describe('round clock', () => {
  test('signals round end then fight end, in sim time', () => {
    const c = new RoundClock(10, 3);
    expect(c.advance(1)).toBeNull(); // not running
    c.running = true;
    expect(c.advance(9.5)).toBeNull();
    expect(c.label()).toBe('0:01');
    expect(c.advance(1)).toBe('round_end');
    expect(c.running).toBe(false);
    c.nextRound(); c.running = true;
    expect(c.advance(10)).toBe('round_end');
    c.nextRound(); c.running = true;
    expect(c.advance(10)).toBe('fight_end');
    expect(c.matchClock()).toEqual({ round: 3, rounds: 3, remainingS: 0 });
  });

  test('formatClock rounds up', () => {
    expect(formatClock(120)).toBe('2:00');
    expect(formatClock(119.2)).toBe('2:00');
    expect(formatClock(61)).toBe('1:01');
    expect(formatClock(0)).toBe('0:00');
  });
});

describe('scorecard', () => {
  test('a dominant fighter wins a unanimous decision', () => {
    const s = new Scorecard();
    for (let r = 0; r < 3; r++) {
      if (r > 0) s.startRound();
      s.record([hit(0, 300), hit(0, 250), hit(1, 70)], [telemetry(0, { damageTotal: 0.05 * (r + 1) }), telemetry(1, { damageTotal: 0.2 * (r + 1) })]);
    }
    const d = s.decision();
    expect(d.winner).toBe(0);
    expect(d.kind).toBe('unanimous');
    for (const [red] of d.cards) expect(red).toBe(30);
    expect(s.totals()[0].strikes).toBe(6);
    expect(s.totals()[0].peakHitJ).toBe(300);
  });

  test('judges who weigh damage vs strikes can split', () => {
    const s = new Scorecard();
    // Red lands many light strikes; blue does more structural damage with fewer.
    s.record([hit(0, 200), hit(0, 200), hit(0, 200), hit(0, 200), hit(1, 90)], [telemetry(0, { damageTotal: 0.14 }), telemetry(1, { damageTotal: 0.04 })]);
    const d = s.decision();
    expect(['split', 'majority', 'unanimous', 'draw']).toContain(d.kind);
    const votes = d.cards.map(([r, b]) => Math.sign(r - b));
    expect(new Set(votes).size).toBeGreaterThan(1);
  });

  test('no action is a draw', () => {
    expect(new Scorecard().decision().kind).toBe('draw');
  });
});

describe('ticker feed', () => {
  test('joint failure, detach and knockouts produce broadcast lines once', () => {
    const f = new TickerFeed(['BRUISER', 'STRIKER']);
    const joint: SimEvent = { kind: 'joint', corner: 0, joint: 'knee_l', health: 0.4, state: 'degraded' };
    const items = f.ingest([joint, joint], null, 10);
    expect(items.map((i) => i.text)).toEqual(["BRUISER's left knee is failing"]);
    const head = f.ingest([{ kind: 'detach', corner: 1, part: 'head', debrisBody: 30, pos: [0, 0, 2], vel: [1, 0, 3] }], null, 11);
    expect(head[0].text).toMatch(/^HEAD OFF!/);
    expect(head[0].level).toBe('huge');
  });

  test('strikes are rate limited per striker and ignore light taps', () => {
    const f = new TickerFeed(['A', 'B']);
    expect(f.ingest([hit(0, 50)], null, 1)).toHaveLength(0);
    expect(f.ingest([hit(0, 200)], null, 1)).toHaveLength(1);
    expect(f.ingest([hit(0, 200)], null, 1.5)).toHaveLength(0);
    expect(f.ingest([hit(1, 200)], null, 1.5)).toHaveLength(1);
    expect(f.ingest([hit(0, 400)], null, 3)[0].level).toBe('alert');
  });

  test('smoke and leaks are announced on onset only', () => {
    const f = new TickerFeed(['A', 'B']);
    const part = { id: 'torso', hp: 0.3, smoke: 0.5, heat: 0.9, attached: true, leak: 0.05 };
    const t = telemetry(0, { parts: [part] });
    expect(f.ingest([], [t], 1).map((i) => i.text)).toEqual(['A is smoking from the torso', "Hydraulic leak in A's torso"]);
    expect(f.ingest([], [t], 2)).toHaveLength(0);
  });
});

describe('tale of the tape', () => {
  test('mass comes from the compiler, height and torque from the design', () => {
    const t = taleOfTheTape(BRUISER);
    expect(t.massKg).toBeCloseTo(compileRobot(BRUISER, 0, { pos: [0, 0, 1], yaw: 0 }).totalMassKg, 6);
    expect(t.heightM).toBeGreaterThan(1.6);
    expect(t.heightM).toBeLessThan(2.4);
    expect(t.peakTorqueNm).toBe(650); // hydraulic elbows
    expect(t.peakJoint).toBe('left elbow');
    expect(t.armor).toBe('AR500 armor steel');
    expect(t.hydraulics).toBe('210 BAR');
    expect(taleOfTheTape(STRIKER).hydraulics).toBe('NONE');
  });
});

describe('select screen helpers', () => {
  test('word count and default plans stay under the 150-word limit', () => {
    expect(wordCount('  jab  cross\nhook ')).toBe(3);
    expect(wordCount('')).toBe(0);
    for (const d of [BRUISER, STRIKER]) expect(wordCount(defaultPlan(d))).toBeLessThanOrEqual(150);
  });
});
