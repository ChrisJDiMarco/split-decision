// Referee break rules on a stand-in context (no physics): when the break starts and ends, who is
// sent where, when he stops, and what goes out in telemetry. The fighters are points the test moves.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RobotTelemetry } from '../../src/core/protocol';
import type { SimContext } from '../../src/physics/sim-context';
import { GRACE_S, MAX_WAIT_S, NEUTRAL_M, ROOM_TOL_M, STALL_S, refereeSystem } from '../../src/physics/systems/referee';

const DT = 0.001;

interface Fighter {
  down: boolean;
  koReason: string | null;
  rising: boolean;
  ready: boolean;
}

let ctx: SimContext;
let f: Fighter[];
const com = new Float64Array(6);
const xmat = new Float64Array(18);

function place(c: number, x: number, y = 0): void {
  com[c * 3] = x;
  com[c * 3 + 1] = y;
}

beforeEach(() => {
  f = [0, 1].map(() => ({ down: false, koReason: null, rising: false, ready: true }));
  const robots = [0, 1].map((c) => ({
    corner: c,
    rootBody: c,
    parts: new Map([['torso', { body: c }]]),
    get down() { return f[c].down; },
    get koReason() { return f[c].koReason; },
    mem: { control: { getUp: { active: false }, get rising() { return f[c].rising; }, readyToStrike: () => f[c].ready } },
  }));
  com.fill(0);
  xmat.fill(0);
  xmat[8] = xmat[17] = 1; // both torsos upright
  place(0, -0.5);
  place(1, 0.5);
  ctx = { released: true, tick: 0, time: 0, dt: DT, robots, events: [], data: { subtree_com: com, xmat } } as unknown as SimContext;
  refereeSystem.init!(ctx);
});

function run(seconds: number, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    each?.();
    refereeSystem.pre!(ctx);
    ctx.tick++;
    ctx.time += DT;
  }
}

const st = () => ctx.referee!;
const gap = () => Math.hypot(com[3] - com[0], com[4] - com[1]);
const fights = () => st().log.filter((e) => e.kind === 'fight');

/** Blue goes down now and is back up and steady `downS` later. */
function knockdown(downS = 2): void {
  f[1].down = true;
  run(downS);
  f[1].down = false;
}

describe('referee break', () => {
  it('starts the control tick a fighter goes down, and sends the other one away, facing him', () => {
    run(0.1);
    expect(st().active).toBe(false);
    f[1].down = true;
    run(0.004);
    expect(st().active).toBe(true);
    expect(st().log).toEqual([{ kind: 'break', down: [1], seq: 0, time: expect.any(Number) }]);
    expect(st().roles).toEqual(['neutral', 'down']);
    const g = st().orders[0]!.goal!;
    expect(g.x).toBeLessThan(com[0]); // backing away from him (he is at +x)
    expect(Math.cos(g.heading - Math.atan2(com[4] - g.y, com[3] - g.x))).toBeCloseTo(1, 9);
    expect(st().orders[1]!.goal).toBeNull();
  });

  it('does not restart until the standing fighter has his room, however long the downed one has been up', () => {
    // Red backs off at 0.15 m/s from 1 m apart; blue is down 2 s. FIGHT only once red is within
    // ROOM_TOL_M of NEUTRAL_M (both steady GRACE_S), ~7 s after blue is back up.
    const walk = () => {
      if (gap() < NEUTRAL_M) place(0, com[0] - 0.15 * DT);
    };
    f[1].down = true;
    run(2, walk);
    f[1].down = false;
    run(20, walk);
    const [fight] = fights();
    expect(fight).toMatchObject({ kind: 'fight', reason: 'room' });
    const walkS = (NEUTRAL_M - ROOM_TOL_M - 1) / 0.15;
    expect(fight.time).toBeGreaterThan(walkS - 0.05);
    expect(fight.time).toBeLessThan(walkS + 0.1);
    expect(st().active).toBe(false);
    expect(st().orders).toEqual([null, null]);
  });

  it('stops him at his neutral distance and walks him on once he is short of the room', () => {
    f[1].down = true; // blue stays down for the whole test
    run(0.01);
    place(0, 0.5 - (NEUTRAL_M - 0.2));
    run(0.01);
    expect(st().orders[0]!.goal).not.toBeNull();
    place(0, 0.5 - NEUTRAL_M);
    run(0.01);
    expect(st().orders[0]!.goal).toBeNull(); // arrived: stand
    place(0, 0.5 - (NEUTRAL_M - ROOM_TOL_M + 0.03));
    run(0.01);
    expect(st().orders[0]!.goal).toBeNull(); // swaying a little: still standing
    place(0, 0.5 - (NEUTRAL_M - ROOM_TOL_M - 0.03)); // he crawled toward him: short of the room, back off again
    run(0.01);
    expect(st().orders[0]!.goal).not.toBeNull();
  });

  it('waits for the downed fighter to be steady, not just upright', () => {
    place(0, 0.5 - NEUTRAL_M);
    f[1].down = true;
    run(1);
    f[1].down = false;
    f[1].ready = false; // up, but still wobbling
    run(3);
    expect(fights()).toHaveLength(0);
    f[1].ready = true;
    run(GRACE_S - 0.01);
    expect(fights()).toHaveLength(0);
    run(0.02);
    expect(fights()).toEqual([expect.objectContaining({ reason: 'room' })]);
  });

  it('stops waiting when he makes no progress (stalled) or after MAX_WAIT_S (timeout)', () => {
    knockdown(1);
    run(GRACE_S + STALL_S + 0.01); // red stuck at 1 m
    expect(fights()).toEqual([expect.objectContaining({ reason: 'stalled' })]);
    expect(fights()[0].time).toBeCloseTo(1 + GRACE_S + STALL_S, 1);

    knockdown(1);
    f[1].ready = false; // never steady: only the timeout ends it
    run(MAX_WAIT_S + GRACE_S + 0.1, () => place(0, com[0] - 0.02 * DT));
    expect(fights().at(-1)).toMatchObject({ reason: 'timeout' });
  });

  it('a double knockdown: both just get up; the first one up is sent to the neutral spot', () => {
    f[0].down = f[1].down = true;
    run(0.01);
    expect(st().roles).toEqual(['down', 'down']);
    expect(st().log.at(-1)).toMatchObject({ kind: 'break', down: [0, 1] });
    f[0].down = false;
    run(0.01);
    expect(st().roles).toEqual(['neutral', 'down']);
    // The standing fighter falls on his own during a break: it becomes a double.
    f[0].down = true;
    run(0.01);
    expect(st().log.filter((e) => e.kind === 'break')).toHaveLength(1); // both were already down in this break
    f[0].down = f[1].down = false;
    place(0, 0.5 - NEUTRAL_M);
    run(GRACE_S + 0.1);
    expect(fights()).toHaveLength(1);
  });

  it('a KO ends the break without a FIGHT', () => {
    f[1].down = true;
    run(1);
    f[1].koReason = 'down';
    run(0.01);
    expect(st().active).toBe(false);
    expect(st().orders).toEqual([null, null]);
    expect(fights()).toHaveLength(0);
  });

  it('publishes each event once per corner in telemetry, numbered', () => {
    const tel = (c: number) => {
      const out = {} as RobotTelemetry;
      refereeSystem.telemetry!(ctx, ctx.robots[c], out);
      return out.referee!;
    };
    expect(tel(0)).toEqual({ break: false });
    knockdown(1);
    const t0 = tel(0);
    expect(t0).toMatchObject({ break: true, role: 'neutral', neutral: expect.any(Array), breakS: expect.any(Number) });
    expect(t0.events).toEqual([expect.objectContaining({ kind: 'break', seq: 0 })]);
    expect(tel(0).events).toBeUndefined(); // sent
    place(0, 0.5 - NEUTRAL_M);
    run(GRACE_S + 0.1);
    expect(tel(1).events!.map((e) => [e.kind, e.seq])).toEqual([['break', 0], ['fight', 1]]); // blue's own cursor
    expect(tel(0).events!.map((e) => [e.kind, e.seq])).toEqual([['fight', 1]]);
  });

  it('puts each event once in the frame\'s SimEvent list too, as it happens', () => {
    const events = ctx.events;
    knockdown(1);
    expect(events).toEqual([{ kind: 'break', down: [1] }]);
    place(0, 0.5 - NEUTRAL_M);
    run(GRACE_S + 0.1);
    expect(events.map((e) => e.kind)).toEqual(['break', 'fight']);
    expect(events[1]).toMatchObject({ kind: 'fight', reason: 'room' });
    expect(events.length).toBe(st().log.length); // one SimEvent per logged event: nothing fires twice
  });

  it('sends him a bit of space: 2.2 m, still outside every strike and the reflex range', () => {
    expect(NEUTRAL_M).toBe(2.2);
    expect(NEUTRAL_M - ROOM_TOL_M).toBeGreaterThan(1.35 + 0.5);
  });
});
