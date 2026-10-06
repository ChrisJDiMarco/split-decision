// Phase 5, mocap footwork on the plan (docs/design/balance-engine.md §9, "Motion matching, the
// physics way"), without MuJoCo: the motion-matching database reads each design's footwork clips as
// one-foot-at-a-time swings, the brute-force search finds clips that go the way the query asks, the
// clip clock follows real contacts (holds for a late foot, jumps on an early touchdown), the
// validation rollout tracks a plan the body is on and flags one it is not, the style layer's
// offsets stay inside their caps, the take-off plan ends with the asked velocity, and ring IQ's
// zones come from the real ranges.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DcmPlan, newDcmSample } from '../../src/physics/control/balance/dcm';
import { FootstepPlanner } from '../../src/physics/control/balance/footsteps';
import { MOCAP_STEPS, MocapSteps, type PickInput } from '../../src/physics/control/balance/mocap-steps';
import { MOCAP_STYLE, MocapStyle } from '../../src/physics/control/balance/mocap-style';
import { newRolloutResult, rollout } from '../../src/physics/control/balance/rollout';
import { planTakeoff } from '../../src/physics/control/balance/takeoff';
import type { Footstep } from '../../src/physics/control/balance/types';
import { Gait } from '../../src/physics/control/gait';
import { humanoidGeometry } from '../../src/physics/control/geometry';
import { FEATURES, footworkDb, FOOTWORK_LABELS, nearest, newQuery, QUERY } from '../../src/physics/control/mocap/footwork-db';
import { mocapSet, registerLibrary } from '../../src/physics/control/mocap/library';
import { IDENTITY, type Mat3 } from '../../src/physics/control/math';
import { jointMap, newBodyCommand } from '../../src/physics/control/posture';
import { RingIq, type RingFacts } from '../../src/physics/control/ring-iq';
import type { Sense } from '../../src/physics/control/sense';
import { neutralPose } from '../../src/physics/control/skills/types';
import { stanceFor } from '../../src/physics/control/stance';
import type { RobotRuntime } from '../../src/physics/sim-context';
import { design } from '../../src/robots/designs';
import { parseLibrary } from '../../src/robots/motions';
import type { LibraryJson } from '../../src/robots/motions/types';

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'] as const;

/** The design's playback set on a stand-in runtime (joint names and indices are all the set needs). */
function setOf(id: string) {
  const lib = parseLibrary(JSON.parse(readFileSync(new URL(`../../src/robots/motions/data/${id}.json`, import.meta.url), 'utf8')) as LibraryJson);
  registerLibrary(lib);
  const r = { design: design(id), joints: lib.joints.map((name) => ({ name })), jointIndex: new Map(lib.joints.map((n, i) => [n, i])) } as unknown as RobotRuntime;
  return { set: mocapSet(r)!, r };
}

describe('footwork database', () => {
  it('reads every design\'s footwork clips as one-foot-at-a-time swings, with finite features', () => {
    for (const id of MODERN) {
      const { set } = setOf(id);
      const db = footworkDb(set, humanoidGeometry(design(id)))!;
      expect(db).not.toBeNull();
      expect(db.n).toBeGreaterThan(150);
      expect(new Set(db.clips.map((c) => c.move.label))).toEqual(new Set(FOOTWORK_LABELS));
      for (const c of db.clips) {
        for (let i = 1; i < c.steps.length; i++) expect(c.steps[i].lift).toBeGreaterThanOrEqual(c.steps[i - 1].land + 0.06 - 1e-6);
        for (const s of c.steps) {
          expect(s.land - s.lift).toBeGreaterThanOrEqual(0.12 - 1e-6);
          expect(Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]) + Math.abs(s.yawTo - s.yawFrom)).toBeGreaterThan(0.04);
        }
      }
      for (let i = 0; i < db.feat.length; i++) expect(Number.isFinite(db.feat[i])).toBe(true);
      // No candidate sits inside one of its clip's swings (one at a touchdown frame is on two feet;
      // its time is stored in float32, so it may read a few ns early).
      for (let i = 0; i < db.n; i++) {
        const c = db.clips[db.cClip[i]];
        const t = db.cTime[i] % c.move.duration;
        for (const s of c.steps) if (!c.move.loop) expect(t >= s.lift - 1e-6 && t < s.land - 1e-6).toBe(false);
      }
    }
  });

  it('matches the way a query asks to go, best first, honouring exclusions', () => {
    const { set } = setOf('savate');
    const geo = humanoidGeometry(design('savate'));
    const db = footworkDb(set, geo)!;
    const st = stanceFor(geo, { widthFraction: 1.02 });
    const q = newQuery(), scratch = newQuery();
    const best = new Int32Array(6), cost = new Float64Array(6);
    const ask = (vx: number, vy: number) => {
      q.fill(0);
      q[QUERY.FEET] = st.slots.l.x; q[QUERY.FEET + 1] = st.slots.l.y;
      q[QUERY.FEET + 2] = st.slots.r.x; q[QUERY.FEET + 3] = st.slots.r.y;
      for (let i = 0; i < 3; i++) {
        q[QUERY.FUTURE + 2 * i] = vx * 0.2 * (i + 1);
        q[QUERY.FUTURE + 2 * i + 1] = vy * 0.2 * (i + 1);
      }
      const n = nearest(db, q, scratch, best, cost);
      for (let k = 1; k < n; k++) expect(cost[k]).toBeGreaterThanOrEqual(cost[k - 1]);
      return db.clips[db.cClip[best[0]]].move;
    };
    for (const [vx, vy] of [[0.7, 0], [-0.5, 0], [0, 0.45], [0, -0.45]] as const) {
      const m = ask(vx, vy);
      expect(m.travel[0] * vx + m.travel[1] * vy).toBeGreaterThan(0);
    }
    // An excluded candidate never comes back.
    const n = nearest(db, q, scratch, best, cost, (i) => (db.cClip[i] === db.cClip[0] ? Infinity : 1));
    for (let k = 0; k < n; k++) expect(db.cClip[best[k]]).not.toBe(db.cClip[0]);
    expect(FEATURES).toBe(19);
  });
});

describe('clip clock (contact sync)', () => {
  const { set } = setOf('savate');
  const geo = humanoidGeometry(design('savate'));
  const stance = stanceFor(geo, { widthFraction: 1.02 });
  const gait = new Gait(geo, stance);
  for (const side of ['l', 'r'] as const) {
    gait.feet[side].phase = 'planted';
    gait.feet[side].place = gait.slot(side, { x: 0, y: 0, heading: 0 });
  }
  const s = { time: 0, pelvisPos: [0, 0, 0.9], comVel: [0.5, 0, 0], com: [0, 0, 0.82], omega0: 3.4 } as unknown as Sense;
  const input = (): PickInput => ({
    s, time: 0, omega: 3.4, bearing: 0, aggression: 0.5, gait, goal: { x: 2, y: 0, heading: 0 }, opp: [3, 0],
    future: Float32Array.from([0.12, 0, 0.26, 0, 0.4, 0]), facing: new Float32Array(3), drive: { stallNm: Infinity, noLoadRadS: Infinity, inertia: 1 },
    fromRest: false, doubleS: 0, allowPass: true, lastLanded: null, accept: () => true,
  });

  it('waits at a touchdown for a foot still in the air, and jumps to it when the foot lands early', () => {
    const m = new MocapSteps(set, geo, stance);
    m.follow(input());
    expect(m.following).toBe(true);
    const clip = m.clip!;
    const first = clip.steps.find((x) => x.side === 'r')!;
    m.followLift('r', 0.3);
    expect(m.tau).toBeCloseTo(first.lift, 6);
    // Late: the clock runs to the clip's touchdown by the planned landing and holds there.
    for (let t = 0; t < 0.6; t += 0.002) m.tick(t, 0.002, NaN);
    expect(m.tau).toBeCloseTo(first.land, 6);
    m.onTouchdown();
    expect(m.tau).toBeCloseTo(first.land, 6);
    // Early: a touchdown halfway through drops the rest of the fragment (a jump the style layer
    // inertializes).
    const m2 = new MocapSteps(set, geo, stance);
    m2.follow(input());
    m2.switched = false;
    m2.followLift('r', 0.3);
    m2.switched = false;
    for (let t = 0; t < 0.1; t += 0.002) m2.tick(t, 0.002, NaN);
    expect(m2.tau).toBeLessThan(first.land - 0.05);
    m2.onTouchdown();
    expect(m2.tau).toBeCloseTo(first.land, 6);
    expect(m2.switched).toBe(true);
  });

  it('follows a walk with a walk clip and step-drag with a shuffle, and re-matches when the gait changes', () => {
    const m = new MocapSteps(set, geo, stance);
    m.follow({ ...input(), allowPass: true });
    expect(m.clip!.move.label.startsWith('walk')).toBe(true);
    m.follow({ ...input(), allowPass: false });
    expect(m.clip!.move.label.startsWith('walk')).toBe(false);
    expect(m.following).toBe(true);
    m.cancel();
    expect(m.following).toBe(false);
    expect(MOCAP_STEPS.walkClips).toBe(0);
  });

  it('picks nothing without a goal (recovery is the planner\'s) or for a move too small for a clip', () => {
    const m = new MocapSteps(set, geo, stance);
    let asked = 0;
    const accept = () => (asked++, true);
    expect(m.pick({ ...input(), goal: null, accept })).toBe(false);
    expect(m.pick({ ...input(), goal: { x: 0.05, y: 0, heading: 0 }, accept })).toBe(false);
    expect(asked).toBe(0);
    expect(m.active).toBe(false);
  });
});

describe('clip steps on the plan', () => {
  it('takes a pick\'s steps first, then carries the plan on to the goal, ending at rest on the stance', () => {
    const geo = humanoidGeometry(design('savate'));
    const stance = stanceFor(geo, { widthFraction: 1.02 });
    const gait = new Gait(geo, stance);
    for (const side of ['l', 'r'] as const) {
      gait.feet[side].phase = 'planted';
      gait.feet[side].place = gait.slot(side, { x: 0, y: 0, heading: 0 });
    }
    const planner = new FootstepPlanner(geo, stance, gait);
    const dcm = new DcmPlan();
    const goal = { x: 0.6, y: 0, heading: 0 };
    const pin = {
      time: 0, omega: 3.4, goal, bearing: 0, oppDist: 1.6, aggression: 0.5, speed: null, cmpNow: [0, 0] as [number, number],
      shift: [0, 0] as [number, number], swing: null, doubleS: 0, fromRest: true, lastSide: null, opp: [1.6, 0] as [number, number], xi: [0, 0] as [number, number],
    };
    expect(planner.plan(pin, dcm)).toBe('drag');
    const lead = gait.feet.l.place;
    const clip: Footstep[] = [{ side: 'l', place: { x: lead.x + 0.2, y: lead.y, yaw: lead.yaw }, lift: 0.2, land: 0.5, cmp: [[-0.1, -0.1], [-0.1, -0.1]], clearance: 0.03, source: 'clip' }];
    planner.planClip(pin, dcm, clip, 0, 1);
    const steps = planner.steps.slice(0, planner.count);
    expect(steps[0].source).toBe('clip');
    expect(steps[0].clipIdx).toBe(0);
    expect(steps.length).toBeGreaterThan(1);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].source).not.toBe('clip');
      expect(steps[i].clipIdx).toBeUndefined();
      expect(steps[i].lift).toBeGreaterThanOrEqual(steps[i - 1].land);
    }
    // The last footsteps put the feet in the goal's slots; the reference ends at rest between them.
    const lastL = [...steps].reverse().find((x) => x.side === 'l')!.place, lastR = [...steps].reverse().find((x) => x.side === 'r')!.place;
    const sl = gait.slot('l', goal), sr = gait.slot('r', goal);
    expect(Math.hypot(lastL.x - sl.x, lastL.y - sl.y)).toBeLessThan(0.06);
    expect(Math.hypot(lastR.x - sr.x, lastR.y - sr.y)).toBeLessThan(0.06);
    const end = newDcmSample();
    dcm.sample(planner.finalTime + 5, end);
    expect(end.xi[0]).toBeCloseTo((lastL.x + lastR.x) / 2, 6);
    // A procedural plan never keeps a stale clip index (pooled footsteps).
    planner.plan(pin, dcm);
    for (const st of planner.steps.slice(0, planner.count)) expect(st.clipIdx).toBeUndefined();
  });
});

describe('validation rollout', () => {
  const geo = humanoidGeometry(design('savate'));
  const stance = stanceFor(geo, { widthFraction: 1.02 });
  const gait = new Gait(geo, stance);
  const feet = { l: gait.slot('l', { x: 0, y: 0, heading: 0 }), r: gait.slot('r', { x: 0, y: 0, heading: 0 }) };
  const w = 3.4;

  it('stays on a standing plan the body is on, and sees an error the soles cannot take back', () => {
    const plan = new DcmPlan();
    plan.add(0, 0, 0);
    plan.add(1, 0, 0);
    plan.solve(w);
    const out = newRolloutResult();
    rollout(geo, plan, [], 0, feet, null, [0, 0], [0, 0], w, 2.5, 0, 1, 0.01, 0.015, 0.13, null, 0, out);
    expect(out.maxErr).toBeLessThan(1e-6);
    // Thrown forward at 1 m/s: the DCM is 29 cm ahead, past the toes: the error runs away.
    rollout(geo, plan, [], 0, feet, null, [0, 0], [1, 0], w, 2.5, 0, 1, 0.01, 0.015, 0.13, null, 0, out);
    expect(out.maxErr).toBeGreaterThan(0.5);
    expect(out.saturated).toBeGreaterThan(0.5);
  });
});

describe('style layer', () => {
  const enabled = MOCAP_STYLE.enabled;
  beforeAll(() => {
    MOCAP_STYLE.enabled = 1; // off by default (measured); the layer itself is what is tested here
  });
  afterAll(() => {
    MOCAP_STYLE.enabled = enabled;
  });

  it('keeps every offset inside its cap, fades in, and lets go at once when a skill owns the body', () => {
    const { set, r } = setOf('savate');
    const geo = humanoidGeometry(design('savate'));
    const stance = stanceFor(geo, { widthFraction: 1.02 });
    const db = new MocapSteps(set, geo, stance).db!;
    const masses = { total: 60, upperLever: 8, arm: { l: { upper: 1.5, lower: 1.2 }, r: { upper: 1.5, lower: 1.2 } } };
    const style = new MocapStyle(set, geo, stance, jointMap(r), r.joints.length, db.idles[0] ?? null, masses);
    const clip = db.clips.find((c) => c.move.label === 'shuffle_forward')!;
    const M = MOCAP_STYLE;
    const rot = [...IDENTITY] as Mat3;
    const base = neutralPose(stance);
    const dt = 0.002;
    let peak = { drop: 0, pitch: 0, roll: 0, yaw: 0, waistYaw: 0, waistPitch: 0 };
    for (let t = 0; t < 2; t += dt) {
      const pose = neutralPose(stance), cmd = newBodyCommand();
      style.apply(pose, cmd, dt, true, clip, t % clip.move.duration, 0.5, rot, 0);
      if (t < 0.1) expect(style.w).toBeLessThanOrEqual(t / M.fadeS + dt / M.fadeS + 1e-9);
      peak = {
        drop: Math.max(peak.drop, Math.abs(pose.pelvisDrop)), pitch: Math.max(peak.pitch, Math.abs(pose.pelvisPitch)),
        roll: Math.max(peak.roll, Math.abs(pose.pelvisRoll)), yaw: Math.max(peak.yaw, Math.abs(pose.pelvisYaw)),
        waistYaw: Math.max(peak.waistYaw, Math.abs(pose.waistYaw - base.waistYaw)), waistPitch: Math.max(peak.waistPitch, Math.abs(pose.waistPitch - base.waistPitch)),
      };
      for (const side of ['l', 'r'] as const) expect(cmd.arms[side].mode).toBe('joints');
    }
    expect(style.w).toBeCloseTo(1, 9);
    expect(peak.drop).toBeLessThanOrEqual(1.5 * M.bobMaxM + 1e-9);
    expect(peak.pitch).toBeLessThanOrEqual(M.tiltMaxRad + 1e-9);
    expect(peak.roll).toBeLessThanOrEqual(M.tiltMaxRad + 1e-9);
    expect(peak.yaw).toBeLessThanOrEqual(M.swayMaxRad + 1e-9);
    expect(peak.waistYaw).toBeLessThanOrEqual(M.waistMaxRad + 1e-9);
    expect(peak.waistPitch).toBeLessThanOrEqual(M.waistMaxRad + 1e-9);
    // It moves: the shuffle turns the shoulders and sways the pelvis.
    expect(peak.waistYaw + peak.yaw).toBeGreaterThan(0.005);
    // A skill takes the body: nothing written, the weight back to 0.
    const pose = neutralPose(stance), cmd = newBodyCommand();
    style.apply(pose, cmd, dt, false, clip, 0.3, 0.5, rot, 0);
    expect(style.w).toBe(0);
    expect(pose).toEqual(neutralPose(stance));
    expect(cmd.arms.l.mode).toBe('fist');
  });
});

describe('take-off plan', () => {
  it('ends with the DCM where the asked velocity puts it over the support sole', () => {
    const plan = new DcmPlan();
    const w = 3.5;
    planTakeoff(plan, 0, [0.02, -0.01], [0.1, 0.08], 0.6, [0.4, 0.1], w);
    const a = newDcmSample();
    plan.sample(0.6, a);
    expect(a.r[0]).toBeCloseTo(0.1, 9);
    expect(a.r[1]).toBeCloseTo(0.08, 9);
    expect(a.xi[0]).toBeCloseTo(0.1 + 0.4 / w, 9);
    expect(a.xi[1]).toBeCloseTo(0.08 + 0.1 / w, 9);
    plan.sample(0, a);
    expect(a.r[0]).toBeCloseTo(0.02, 9);
  });
});

describe('ring IQ zones', () => {
  it('reads outside, edge and pocket from the ranges, and approaches to the edge, never into the guards', () => {
    const f: RingFacts = { myEdge: 0.9, hisReach: 0.8, standoff: 0.7, edge: true };
    expect(RingIq.zoneAt(f, 1.0)).toBe('outside');
    expect(RingIq.zoneAt(f, 0.85)).toBe('edge');
    expect(RingIq.zoneAt(f, 0.75)).toBe('pocket');
    const a = RingIq.approachRange(f);
    expect(a).toBeGreaterThan(0.8);
    expect(a).toBeLessThanOrEqual(0.9);
    const g: RingFacts = { myEdge: 0.75, hisReach: 0.9, standoff: 0.7, edge: false };
    expect(RingIq.zoneAt(g, 0.8)).toBe('outside');
    expect(RingIq.approachRange(g)).toBeCloseTo(0.95, 9);
    const h: RingFacts = { myEdge: 0.6, hisReach: 0.62, standoff: 0.8, edge: false };
    expect(RingIq.approachRange(h)).toBeGreaterThanOrEqual(0.82 - 1e-9);
  });
});
