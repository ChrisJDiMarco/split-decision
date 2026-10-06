// The balance engine's math, without MuJoCo: the DCM reference solves ξ̇ = ω(ξ − r) and ends at rest
// on the last CMP; connect() starts a plan at the body's own DCM; quintic swings land where they are
// sent with the foot at rest and never jump when re-aimed; inertialized switches decay and smooth
// motion passes through untouched; the footstep planner walks into the stance slots and step-drags.
import { describe, expect, it } from 'vitest';
import { DcmPlan, newDcmSample } from '../../src/physics/control/balance/dcm';
import { FOOTWORK_TUNING, FootstepPlanner } from '../../src/physics/control/balance/footsteps';
import { Inertializer } from '../../src/physics/control/balance/inertialize';
import { Swing } from '../../src/physics/control/balance/swing';
import { Gait } from '../../src/physics/control/gait';
import { humanoidGeometry } from '../../src/physics/control/geometry';
import { stanceFor } from '../../src/physics/control/stance';
import { design } from '../../src/robots/designs';

const W = 3.4;

describe('DCM reference', () => {
  it('satisfies ξ̇ = ω(ξ − r) along a piecewise-linear CMP plan and ends at rest', () => {
    const p = new DcmPlan();
    p.add(0, 0, 0);
    p.add(0.3, 0.1, 0.05);
    p.add(0.7, 0.35, -0.05);
    p.add(0.8, 0.4, 0);
    p.add(1.2, 0.5, 0);
    p.solve(W);
    const a = newDcmSample(), b = newDcmSample();
    const h = 1e-5;
    for (let t = 0.01; t < 1.19; t += 0.037) {
      p.sample(t, a);
      p.sample(t + h, b);
      for (let i = 0; i < 2; i++) {
        const xd = (b.xi[i] - a.xi[i]) / h;
        expect(xd).toBeCloseTo(W * (a.xi[i] - a.r[i]), 3);
      }
    }
    p.sample(1.5, a);
    expect(a.xi[0]).toBeCloseTo(0.5, 9);
    expect(a.r[0]).toBeCloseTo(0.5, 9);
  });

  it('is continuous across knots (no CMP or DCM jumps)', () => {
    const p = new DcmPlan();
    p.add(0, 0, 0);
    p.add(0.25, 0.08, 0.1);
    p.add(0.6, 0.2, 0.1);
    p.add(0.9, 0.3, -0.1);
    p.solve(W);
    const a = newDcmSample(), b = newDcmSample();
    for (const k of [0.25, 0.6]) {
      p.sample(k - 1e-7, a);
      p.sample(k + 1e-7, b);
      expect(Math.hypot(a.xi[0] - b.xi[0], a.xi[1] - b.xi[1])).toBeLessThan(1e-5);
      expect(Math.hypot(a.r[0] - b.r[0], a.r[1] - b.r[1])).toBeLessThan(1e-5);
    }
  });

  it('connect() starts the plan at the measured DCM', () => {
    const p = new DcmPlan();
    p.add(0, 0, 0);
    p.add(0.5, 0.07, 0.1);
    p.add(0.9, 0.14, 0.1);
    p.add(1.3, 0.14, 0.1);
    p.solve(W);
    p.connect([0.01, -0.02], (q) => q);
    const a = newDcmSample();
    p.sample(0, a);
    expect(a.xi[0]).toBeCloseTo(0.01, 9);
    expect(a.xi[1]).toBeCloseTo(-0.02, 9);
  });
});

describe('quintic swing', () => {
  it('lands on its target at rest, and re-aiming mid-flight never jumps the foot', () => {
    const sw = new Swing();
    sw.start(0, { x: 0, y: 0.1, yaw: 0 }, 0, { x: 0.4, y: 0.1, yaw: 0.2 }, 0.4, 0.04, 0);
    let last = 0;
    let maxStep = 0;
    for (let t = 0; t <= 0.45; t += 0.002) {
      if (Math.abs(t - 0.2) < 1e-9) sw.retarget(t, { x: 0.5, y: 0.15, yaw: 0.2 });
      sw.sample(t);
      if (t > 0) maxStep = Math.max(maxStep, Math.abs(sw.pos[0] - last));
      last = sw.pos[0];
    }
    expect(sw.pos[0]).toBeCloseTo(0.5, 6);
    expect(sw.pos[1]).toBeCloseTo(0.15, 6);
    expect(sw.vel[0]).toBeCloseTo(0, 6);
    expect(sw.z).toBeLessThanOrEqual(0);
    // No tick moves the command further than a fast foot could travel (5 m/s × 2 ms).
    expect(maxStep).toBeLessThan(0.01);
  });
});

describe('inertialized switches', () => {
  it('decay a marked jump within 0.2 s and pass smooth motion through', () => {
    const inert = new Inertializer(2, [20, 20], [], [0]);
    const q = new Float64Array(2);
    const dt = 0.002;
    inert.apply(q, dt);
    // Joint 1 ramps smoothly at 5 rad/s: untouched.
    let t = 0;
    for (; t < 0.1; t += dt) {
      q[0] = 0;
      q[1] = 5 * t;
      inert.apply(q, dt);
      expect(q[1]).toBeCloseTo(5 * t, 9);
    }
    // Joint 0 switches source by 0.5 rad: the output starts where it was and settles on the new source.
    inert.mark([0]);
    q[0] = 0.5;
    q[1] = 5 * t;
    inert.apply(q, dt);
    expect(q[0]).toBeLessThan(0.05);
    for (let k = 0; k < 100; k++) {
      q[0] = 0.5;
      q[1] = 0;
      inert.apply(q, dt);
    }
    expect(Math.abs(q[0] - 0.5)).toBeLessThan(0.01);
  });

  it('never re-triggers on a fast leg (only arms and waist auto-detect)', () => {
    const inert = new Inertializer(1, [20], [], []);
    const q = new Float64Array(1);
    inert.apply(q, 0.002);
    q[0] = 0.3; // a jump on a joint without auto-detection passes straight through
    inert.apply(q, 0.002);
    expect(q[0]).toBe(0.3);
  });
});

describe('footstep planner', () => {
  const geo = humanoidGeometry(design('savate'));
  const stance = stanceFor(geo, { widthFraction: 1.02 });
  const standing = () => {
    const gait = new Gait(geo, stance);
    const frame = { x: 0, y: 0, heading: 0 };
    for (const side of ['l', 'r'] as const) {
      gait.feet[side].phase = 'planted';
      gait.feet[side].place = gait.slot(side, frame);
    }
    return gait;
  };
  const input = (goal: { x: number; y: number; heading: number }, oppDist: number) => ({
    time: 0, omega: W, goal, bearing: 0, oppDist, aggression: 0.5, speed: null, cmpNow: [0, 0] as [number, number],
    shift: [0, 0] as [number, number], swing: null, doubleS: 0, fromRest: true, lastSide: null, opp: null, xi: [0, 0] as [number, number],
  });

  it('walks to a far goal and arrives with the lead foot, then the rear foot, in their slots', () => {
    const gait = standing();
    const planner = new FootstepPlanner(geo, stance, gait);
    const dcm = new DcmPlan();
    const goal = { x: 1.6, y: 0, heading: 0 };
    expect(planner.plan(input(goal, 4), dcm)).toBe('walk');
    const n = planner.count;
    expect(n).toBeGreaterThanOrEqual(4);
    const steps = planner.steps.slice(0, n);
    for (let i = 1; i < n; i++) expect(steps[i].side).not.toBe(steps[i - 1].side);
    const lead = gait.slot('l', goal), rear = gait.slot('r', goal);
    expect(steps[n - 2].side).toBe('l');
    expect(Math.hypot(steps[n - 2].place.x - lead.x, steps[n - 2].place.y - lead.y)).toBeLessThan(0.02);
    expect(steps[n - 1].side).toBe('r');
    expect(Math.hypot(steps[n - 1].place.x - rear.x, steps[n - 1].place.y - rear.y)).toBeLessThan(0.02);
    // No walking step longer than half a leg, lifts and landings in order.
    for (let i = 1; i < n - 1; i++) expect(Math.abs(steps[i].place.x - steps[i - 1].place.x)).toBeLessThanOrEqual(FOOTWORK_TUNING.walkMaxStep * geo.legLength + 1e-9);
    for (let i = 0; i < n; i++) {
      expect(steps[i].land).toBeGreaterThan(steps[i].lift);
      if (i) expect(steps[i].lift).toBeGreaterThanOrEqual(steps[i - 1].land);
    }
    // The plan ends at rest on the new stance centroid.
    const end = newDcmSample();
    dcm.sample(planner.finalTime + 5, end);
    expect(end.xi[0]).toBeCloseTo((lead.x + rear.x) / 2, 6);
  });

  it('step-drags a short way backward, the rear foot first, the feet never passing', () => {
    const gait = standing();
    const planner = new FootstepPlanner(geo, stance, gait);
    const dcm = new DcmPlan();
    expect(planner.plan(input({ x: -0.3, y: 0, heading: 0 }, 1.2), dcm)).toBe('drag');
    const steps = planner.steps.slice(0, planner.count);
    expect(steps[0].side).toBe('r');
    for (const s of steps) {
      const other = s.side === 'l' ? steps.find((x) => x.side === 'r') : steps.find((x) => x.side === 'l');
      if (other) expect(s.side === 'l' ? s.place.y > other.place.y : s.place.y < other.place.y).toBe(true);
    }
  });

  it('holds when the goal is where the feet already are', () => {
    const gait = standing();
    const planner = new FootstepPlanner(geo, stance, gait);
    expect(planner.plan(input({ x: 0.02, y: 0, heading: 0.05 }, 1.2), new DcmPlan())).toBe('hold');
    expect(planner.count).toBe(0);
  });
});
