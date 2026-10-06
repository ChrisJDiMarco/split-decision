// The motion-matching database for mocap footwork (docs/design/balance-engine.md, "Motion matching,
// the physics way"). Built once per design library (shared by every fighter of that design), in the
// clips' own move frame (x toward the opponent, y left: the opponent-locked root frame).
//   clips      the library's shuffles, walks and pivots, orthodox as stored (the robot stands
//              orthodox; a mirrored clip would also mirror the guard the style layer blends in)
//   steps      each clip read as a list of single-foot swings the robot can take: a foot's contact
//              off for at least MIN_SWING_S and back on. The boxers bounce: a swing inside another
//              (both feet off) is a hop and is dropped, a swing that starts before the other lands
//              waits for it (one foot at a time, never a flight), and a re-plant that moves the
//              foot less than MIN_MOVE_M is a bounce in place and is dropped
//   candidates every frame with both feet down (by those steps) and a step still to come: the
//              segment that starts there is a pick at the next lift-off
//   features   per candidate, in the root frame: both soles relative to the pelvis and their
//              velocities, the pelvis velocity, the pelvis 0.2, 0.4 and 0.6 s ahead and its facing
//              change by then (clip time at 1x). Stored normalized and weighted, so a query is one
//              brute-force pass of squared distances (about 310 candidates x 19 numbers per design,
//              measured 0.01 ms; the build takes 4-12 ms)
// Nothing here allocates per query; the build allocates once per design.
import type { Vec3 } from '../../../core/types';
import { newSample, sample, type Move, type MoveLabel } from '../../../robots/motions';
import { matFromQuat } from '../../../robots/motions/math';
import type { HumanoidGeometry, Side } from '../geometry';
import { legFK, newLegAngles } from '../ik';
import { mulMV } from '../math';
import type { P2 } from '../support';
import type { MocapSet } from './library';

/** Labels whose clips cover ground (the database) and the guard idles (style while holding). */
export const FOOTWORK_LABELS: readonly MoveLabel[] = [
  'shuffle_forward', 'shuffle_back', 'shuffle_left', 'shuffle_right', 'walk_forward', 'walk_back', 'pivot_left', 'pivot_right',
];
export const IDLE_LABEL: MoveLabel = 'guard_idle';

const MIN_SWING_S = 0.1; // clip seconds: a shorter contact gap is flicker
const MIN_MOVE_M = 0.05; // a re-plant that moves the sole less than this (and turns it less than MIN_TURN) is a bounce
const MIN_TURN_RAD = 0.2;
const MIN_DS_S = 0.06; // clip seconds of double support kept between two swings
const MIN_KEPT_SWING_S = 0.12; // a swing shortened to wait for the other foot keeps at least this
/** Feature horizon (clip seconds at 1x). */
export const FUTURE_S: readonly [number, number, number] = [0.2, 0.4, 0.6];
/** Feature layout (19 numbers). */
export const FEATURES = 19;
const F_FEET = 0; // L x,y; R x,y
const F_FOOTVEL = 4; // L vx,vy; R vx,vy
const F_HIPVEL = 8;
const F_FUTURE = 10; // 3 × x,y
const F_FACING = 16; // 3
/** Feature weights (squared-distance weights after normalizing each feature by its spread). */
export const MATCH_WEIGHTS = {
  feet: 0.7,
  footVel: 0.15,
  hipVel: 1.0,
  future: [2.0, 2.0, 1.5] as [number, number, number],
  facing: 1.2,
};

/** One swing the robot can take, in clip time (s at 1x) and the clip's move frame. */
export interface DbStep {
  side: Side;
  lift: number;
  land: number;
  apex: number; // sole height above the canvas at its highest, m
  from: P2; // sole centre at lift-off
  to: P2; // sole centre at touchdown
  yawFrom: number;
  yawTo: number;
  /** The other sole at touchdown (where the stance foot stood). */
  stance: P2;
  /** The foot passes the stance foot along x (a walking step, not a shuffle). */
  passes: boolean;
}

export interface DbClip {
  move: Move;
  index: number;
  steps: DbStep[];
  /** Median pelvis height with both feet down: the zero of the style layer's bob. */
  standZ: number;
  /** How far the pelvis bobs from standZ (95th percentile of |z − standZ|, m): the style scales its bob by it. */
  bobAmp: number;
  /** Median pelvis yaw with both feet down (the actor's blade). */
  blade: number;
  /** Median pelvis pitch and roll, and waist yaw and pitch, with both feet down (the style's zeros). */
  tilt: [number, number];
  waist: [number, number];
  /** Per frame: pelvis x, y, z, yaw (unwrapped) and both soles x, y, yaw (move frame). */
  pelvis: Float32Array; // frames × 4
  soles: Float32Array; // frames × 6 (L x, y, yaw; R x, y, yaw)
}

export interface FootworkDb {
  clips: DbClip[];
  idles: DbClip[];
  /** Candidates: clip index, clip time, index of the next step in that clip's steps. */
  n: number;
  cClip: Int16Array;
  cTime: Float32Array;
  cStep: Int16Array;
  /** The candidate's next step: its side (0 left, 1 right) and whether it passes the other foot (a walk). */
  cSide: Uint8Array;
  cPass: Uint8Array;
  /** n × FEATURES, normalized and weighted. */
  feat: Float32Array;
  /** Per feature: query = (x − mean) · scale. */
  mean: Float32Array;
  scale: Float32Array;
  /** The actors' stance (L sole − R sole, move frame, both feet down), median. */
  actorStance: P2;
}

const dbs = new WeakMap<MocapSet, FootworkDb | null>();

/** The footwork database of a design's library (null if it has no footwork clips). */
export function footworkDb(set: MocapSet, geo: HumanoidGeometry): FootworkDb | null {
  const hit = dbs.get(set);
  if (hit !== undefined) return hit;
  const db = build(set, geo);
  dbs.set(set, db);
  return db;
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

function yawOfQuat(q: readonly number[]): number {
  const [w, x, y, z] = q;
  return Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z));
}

/** Pelvis and soles of every frame of a clip, as played orthodox. */
function trace(set: MocapSet, geo: HumanoidGeometry, move: Move): { pelvis: Float32Array; soles: Float32Array; soleZ: Float32Array; trunk: Float32Array } {
  const lib = set.lib;
  const s = newSample(lib.joints.length);
  const leg = newLegAngles();
  const idx = (name: string) => lib.joints.indexOf(name);
  const jl = { l: ['hip_yaw', 'hip_roll', 'hip_pitch', 'knee', 'ankle_pitch', 'ankle_roll'].map((n) => idx(`${n}_l`)), r: ['hip_yaw', 'hip_roll', 'hip_pitch', 'knee', 'ankle_pitch', 'ankle_roll'].map((n) => idx(`${n}_r`)) };
  const pelvis = new Float32Array(move.frames * 4);
  const soles = new Float32Array(move.frames * 6);
  const soleZ = new Float32Array(move.frames * 2);
  const trunk = new Float32Array(move.frames * 4); // pelvis pitch, roll; waist yaw, pitch
  const wy = idx('waist_yaw'), wp = idx('waist_pitch');
  let yawPrev = 0;
  for (let f = 0; f < move.frames; f++) {
    sample(move, f / move.fps, { speed: 1, loop: false }, s);
    const R = matFromQuat(s.rootQuat);
    let yaw = yawOfQuat(s.rootQuat);
    if (f > 0) yaw = yawPrev + wrap(yaw - yawPrev);
    yawPrev = yaw;
    pelvis[f * 4] = s.rootPos[0];
    pelvis[f * 4 + 1] = s.rootPos[1];
    pelvis[f * 4 + 2] = s.rootPos[2];
    pelvis[f * 4 + 3] = yaw;
    const [pitch, roll] = pitchRollOfQuat(s.rootQuat);
    trunk[f * 4] = pitch;
    trunk[f * 4 + 1] = roll;
    trunk[f * 4 + 2] = wy >= 0 ? s.q[wy] : 0;
    trunk[f * 4 + 3] = wp >= 0 ? s.q[wp] : 0;
    (['l', 'r'] as const).forEach((side, k) => {
      const j = jl[side];
      leg.hipYaw = s.q[j[0]];
      leg.hipRoll = s.q[j[1]];
      leg.hipPitch = s.q[j[2]];
      leg.knee = s.q[j[3]];
      leg.anklePitch = s.q[j[4]];
      leg.ankleRoll = s.q[j[5]];
      const g = geo.legs[side];
      const fk = legFK(g, leg);
      const so = mulMV(fk.footRot, [g.footCenterX, 0, -g.soleDepth]);
      const local: Vec3 = [fk.ankle[0] + so[0], fk.ankle[1] + so[1], fk.ankle[2] + so[2]];
      const w = mulMV(R as never, local);
      // Sole yaw: the foot's x axis in the world (pelvis attitude × foot attitude in the pelvis).
      const fx = mulMV(R as never, [fk.footRot[0], fk.footRot[3], fk.footRot[6]]);
      soles[f * 6 + k * 3] = s.rootPos[0] + w[0];
      soles[f * 6 + k * 3 + 1] = s.rootPos[1] + w[1];
      soles[f * 6 + k * 3 + 2] = Math.atan2(fx[1], fx[0]);
      soleZ[f * 2 + k] = s.rootPos[2] + w[2];
    });
  }
  return { pelvis, soles, soleZ, trunk };
}

/** Pitch and roll (Z·Y·X) of a quaternion [w, x, y, z]. */
function pitchRollOfQuat(q: readonly number[]): [number, number] {
  const [w, x, y, z] = q;
  const r6 = 2 * (x * z - w * y), r7 = 2 * (y * z + w * x), r8 = 1 - 2 * (x * x + y * y);
  return [Math.asin(Math.max(-1, Math.min(1, -r6))), Math.atan2(r7, r8)];
}

/** The swings the robot can take, from the clip's foot contact bits (see the header). */
function robotSteps(move: Move, soles: Float32Array, soleZ: Float32Array): DbStep[] {
  const raw: Array<{ side: Side; f0: number; f1: number }> = [];
  for (const side of ['l', 'r'] as const) {
    const bit = side === 'l' ? 1 : 2;
    let off = -1;
    // A loop's swing may run across the seam: scan two laps and keep those that lift in the first.
    const n = move.loop ? 2 * (move.frames - 1) : move.frames;
    const bitAt = (f: number) => (move.contacts[move.loop ? f % (move.frames - 1) : f] & bit) !== 0;
    for (let f = 1; f < n; f++) {
      const on = bitAt(f), was = bitAt(f - 1);
      if (was && !on) off = f;
      if (!was && on && off >= 0) {
        if ((f - off) / move.fps >= MIN_SWING_S && off < move.frames - 1) raw.push({ side, f0: off, f1: f });
        off = -1;
      }
    }
  }
  raw.sort((a, b) => a.f0 - b.f0);
  const fps = move.fps;
  const lap = move.frames - 1;
  const at = (f: number, k: number) => {
    // A frame of the second lap of a loop: the first lap's pose moved on by the clip's travel.
    if (!move.loop || f <= lap) return soles[f * 6 + k];
    const g = f - lap;
    const d = k % 3 === 2 ? 0 : soles[lap * 6 + k] - soles[k];
    return soles[g * 6 + k] + d;
  };
  const zAt = (f: number, k: number) => soleZ[(move.loop && f > lap ? f - lap : f) * 2 + k];
  const out: DbStep[] = [];
  let lastLand = -Infinity;
  for (const s of raw) {
    let lift = s.f0 / fps;
    const land = s.f1 / fps;
    if (land <= lastLand + 1e-6) continue; // inside the previous swing: a hop
    if (lift < lastLand + MIN_DS_S) lift = lastLand + MIN_DS_S; // waits for the other foot
    if (land - lift < MIN_KEPT_SWING_S) continue;
    const k = s.side === 'l' ? 0 : 3, o = s.side === 'l' ? 3 : 0;
    const fLift = Math.min(Math.round(lift * fps), s.f1);
    const from: P2 = [at(fLift, k), at(fLift, k + 1)];
    const to: P2 = [at(s.f1, k), at(s.f1, k + 1)];
    const yawFrom = at(fLift, k + 2), yawTo = at(s.f1, k + 2);
    const moved = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (moved < MIN_MOVE_M && Math.abs(wrap(yawTo - yawFrom)) < MIN_TURN_RAD) continue; // a bounce in place
    let apex = 0;
    for (let f = fLift; f <= s.f1; f++) apex = Math.max(apex, zAt(f, s.side === 'l' ? 0 : 1));
    const stance: P2 = [at(s.f1, o), at(s.f1, o + 1)];
    const before = from[0] - stance[0], after = to[0] - stance[0];
    out.push({ side: s.side, lift, land, apex, from, to, yawFrom, yawTo, stance, passes: before * after < 0 && Math.abs(after) > 0.08 });
    lastLand = land;
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function clipOf(set: MocapSet, geo: HumanoidGeometry, move: Move, index: number): DbClip {
  const { pelvis, soles, soleZ, trunk } = trace(set, geo, move);
  const steps = robotSteps(move, soles, soleZ);
  const zs: number[] = [];
  const yaws: number[] = [];
  const tr: number[][] = [[], [], [], []];
  for (let f = 0; f < move.frames; f++) {
    if ((move.contacts[f] & 3) !== 3) continue;
    zs.push(pelvis[f * 4 + 2]);
    yaws.push(wrap(pelvis[f * 4 + 3]));
    for (let k = 0; k < 4; k++) tr[k].push(trunk[f * 4 + k]);
  }
  const standZ = zs.length ? median(zs) : pelvis[2];
  const dev: number[] = [];
  for (let f = 0; f < move.frames; f++) dev.push(Math.abs(pelvis[f * 4 + 2] - standZ));
  dev.sort((a, b) => a - b);
  return {
    move, index, steps, standZ, bobAmp: dev[Math.floor(0.95 * (dev.length - 1))] ?? 0, blade: median(yaws), pelvis, soles,
    tilt: [median(tr[0]), median(tr[1])], waist: [median(tr[2]), median(tr[3])],
  };
}

/** Pelvis (x, y, unwrapped yaw) at clip time `t` (looping clips carry their travel on). */
export function pelvisAt(c: DbClip, t: number, out: [number, number, number]): [number, number, number] {
  const m = c.move;
  const last = m.frames - 1;
  let laps = 0;
  let tt = t;
  if (m.loop && m.duration > 0) {
    laps = Math.floor(tt / m.duration);
    tt -= laps * m.duration;
  } else tt = Math.max(0, Math.min(m.duration, tt));
  const fpos = tt * m.fps;
  const i0 = Math.min(last, Math.floor(fpos)), i1 = Math.min(last, i0 + 1);
  const w = fpos - i0;
  const p = c.pelvis;
  for (let k = 0; k < 3; k++) out[k] = p[i0 * 4 + (k === 2 ? 3 : k)] + (p[i1 * 4 + (k === 2 ? 3 : k)] - p[i0 * 4 + (k === 2 ? 3 : k)]) * w;
  if (laps) {
    out[0] += laps * (p[last * 4] - p[0]);
    out[1] += laps * (p[last * 4 + 1] - p[1]);
    out[2] += laps * (p[last * 4 + 3] - p[3]);
  }
  return out;
}

/** Index of the first step of `c` lifting at or after clip time `t` (loops wrap: index ≥ steps.length means a later lap). */
export function nextStepAt(c: DbClip, t: number): number {
  const n = c.steps.length;
  if (!n) return -1;
  const m = c.move;
  if (m.loop) {
    const laps = Math.floor(t / m.duration);
    const tt = t - laps * m.duration;
    for (let i = 0; i < n; i++) if (c.steps[i].lift >= tt - 1e-6) return laps * n + i;
    return (laps + 1) * n;
  }
  for (let i = 0; i < n; i++) if (c.steps[i].lift >= t - 1e-6) return i;
  return -1;
}

/** Step `i` of a clip (loops: lap i / n, its times and soles moved on by whole laps). */
export function stepOf(c: DbClip, i: number, out: DbStep): DbStep {
  const n = c.steps.length;
  const lap = Math.floor(i / n);
  const s = c.steps[i - lap * n];
  const m = c.move;
  const dt = lap * m.duration;
  const last = m.frames - 1;
  const dx = lap * (c.soles[last * 6] - c.soles[0]), dy = lap * (c.soles[last * 6 + 1] - c.soles[1]);
  out.side = s.side;
  out.lift = s.lift + dt;
  out.land = s.land + dt;
  out.apex = s.apex;
  out.from = [s.from[0] + dx, s.from[1] + dy];
  out.to = [s.to[0] + dx, s.to[1] + dy];
  out.stance = [s.stance[0] + dx, s.stance[1] + dy];
  out.yawFrom = s.yawFrom;
  out.yawTo = s.yawTo;
  out.passes = s.passes;
  return out;
}

/** Inside a kept swing at clip time t (a looping clip's swings repeat)? */
function inSwing(c: DbClip, t: number): boolean {
  const m = c.move;
  const tt = m.loop ? t - Math.floor(t / m.duration) * m.duration : t;
  for (const s of c.steps) {
    if (tt >= s.lift - 1e-6 && tt < s.land) return true;
    // A loop swing running across the seam covers the start of the next lap too.
    if (m.loop && s.land > m.duration && tt + m.duration < s.land) return true;
  }
  return false;
}

/** Raw features of clip `c` at clip time `t` (1x), into out[o..o+FEATURES). */
function featuresAt(c: DbClip, t: number, out: Float32Array, o: number): void {
  const m = c.move;
  const fps = m.fps;
  const last = m.frames - 1;
  const frame = (tt: number) => Math.max(0, Math.min(last, Math.round(tt * fps)));
  const f = frame(t);
  const p = c.pelvis, s = c.soles;
  const px = p[f * 4], py = p[f * 4 + 1], yaw = p[f * 4 + 3];
  out[o + F_FEET] = s[f * 6] - px;
  out[o + F_FEET + 1] = s[f * 6 + 1] - py;
  out[o + F_FEET + 2] = s[f * 6 + 3] - px;
  out[o + F_FEET + 3] = s[f * 6 + 4] - py;
  const a = Math.max(0, f - 1), b = Math.min(last, f + 1);
  const k = b > a ? fps / (b - a) : 0;
  out[o + F_FOOTVEL] = (s[b * 6] - s[a * 6]) * k;
  out[o + F_FOOTVEL + 1] = (s[b * 6 + 1] - s[a * 6 + 1]) * k;
  out[o + F_FOOTVEL + 2] = (s[b * 6 + 3] - s[a * 6 + 3]) * k;
  out[o + F_FOOTVEL + 3] = (s[b * 6 + 4] - s[a * 6 + 4]) * k;
  out[o + F_HIPVEL] = (p[b * 4] - p[a * 4]) * k;
  out[o + F_HIPVEL + 1] = (p[b * 4 + 1] - p[a * 4 + 1]) * k;
  const fut: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    pelvisAt(c, t + FUTURE_S[i], fut);
    out[o + F_FUTURE + 2 * i] = fut[0] - px;
    out[o + F_FUTURE + 2 * i + 1] = fut[1] - py;
    out[o + F_FACING + i] = fut[2] - yaw;
  }
}

function build(set: MocapSet, geo: HumanoidGeometry): FootworkDb | null {
  const clips: DbClip[] = [];
  for (const label of FOOTWORK_LABELS) for (const move of set.byLabel.get(label) ?? []) clips.push(clipOf(set, geo, move, clips.length));
  const idles = (set.byLabel.get(IDLE_LABEL) ?? []).map((m, i) => clipOf(set, geo, m, i));
  const usable = clips.filter((c) => c.steps.length > 0);
  if (!usable.length) return null;
  const cand: Array<{ clip: number; t: number; step: number }> = [];
  for (const c of clips) {
    if (!c.steps.length) continue;
    const m = c.move;
    for (let f = 0; f < m.frames - (m.loop ? 1 : 0); f++) {
      const t = f / m.fps;
      if (inSwing(c, t)) continue;
      const k = nextStepAt(c, t);
      if (k < 0) continue;
      cand.push({ clip: c.index, t, step: k });
    }
  }
  const n = cand.length;
  const raw = new Float32Array(n * FEATURES);
  cand.forEach((c, i) => featuresAt(clips[c.clip], c.t, raw, i * FEATURES));
  // Normalize each feature by its spread (std over the candidates); weight by group.
  const mean = new Float32Array(FEATURES), scale = new Float32Array(FEATURES);
  const W = MATCH_WEIGHTS;
  const weight = (j: number): number => (j < F_FOOTVEL ? W.feet : j < F_HIPVEL ? W.footVel : j < F_FUTURE ? W.hipVel : j < F_FACING ? W.future[(j - F_FUTURE) >> 1] : W.facing);
  for (let j = 0; j < FEATURES; j++) {
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const v = raw[i * FEATURES + j];
      s += v;
      s2 += v * v;
    }
    const mu = s / n;
    const sd = Math.sqrt(Math.max(1e-8, s2 / n - mu * mu));
    mean[j] = mu;
    // Spreads of tiny features (a velocity that is almost always zero) are floored, so they cannot dominate.
    scale[j] = Math.sqrt(weight(j)) / Math.max(sd, j >= F_FACING ? 0.15 : 0.03);
  }
  const feat = new Float32Array(n * FEATURES);
  for (let i = 0; i < n; i++) for (let j = 0; j < FEATURES; j++) feat[i * FEATURES + j] = (raw[i * FEATURES + j] - mean[j]) * scale[j];
  const dx: number[] = [], dy: number[] = [];
  for (const c of [...clips, ...idles]) {
    for (let f = 0; f < c.move.frames; f++) {
      if ((c.move.contacts[f] & 3) !== 3) continue;
      dx.push(c.soles[f * 6] - c.soles[f * 6 + 3]);
      dy.push(c.soles[f * 6 + 1] - c.soles[f * 6 + 4]);
    }
  }
  return {
    clips, idles, n,
    cClip: Int16Array.from(cand, (c) => c.clip),
    cTime: Float32Array.from(cand, (c) => c.t),
    cStep: Int16Array.from(cand, (c) => c.step),
    cSide: Uint8Array.from(cand, (c) => (clips[c.clip].steps[c.step % clips[c.clip].steps.length].side === 'l' ? 0 : 1)),
    cPass: Uint8Array.from(cand, (c) => (clips[c.clip].steps[c.step % clips[c.clip].steps.length].passes ? 1 : 0)),
    feat, mean, scale,
    actorStance: [median(dx), median(dy)],
  };
}

/** A query in the same layout as the features (raw units: m, m/s at 1x, rad). */
export function newQuery(): Float32Array {
  return new Float32Array(FEATURES);
}

export const QUERY = { FEET: F_FEET, FOOTVEL: F_FOOTVEL, HIPVEL: F_HIPVEL, FUTURE: F_FUTURE, FACING: F_FACING } as const;

/**
 * Brute-force nearest candidates: fills `best` (candidate indices) and `cost` with the `best.length`
 * cheapest, cheapest first. `bias(i)` may scale a candidate's cost (continuity, exclusions: Infinity).
 * `q` is normalized in place into `scratch`.
 */
export function nearest(db: FootworkDb, q: Float32Array, scratch: Float32Array, best: Int32Array, cost: Float64Array, bias?: (i: number) => number): number {
  for (let j = 0; j < FEATURES; j++) scratch[j] = (q[j] - db.mean[j]) * db.scale[j];
  const k = best.length;
  let found = 0;
  const f = db.feat;
  for (let i = 0; i < db.n; i++) {
    let d = 0;
    const o = i * FEATURES;
    for (let j = 0; j < FEATURES; j++) {
      const e = f[o + j] - scratch[j];
      d += e * e;
    }
    if (bias) d *= bias(i);
    if (!(d < Infinity)) continue;
    // Insertion into the sorted top k (the list grows until it holds k).
    if (found < k) found++;
    else if (!(d < cost[k - 1])) continue;
    let p = found - 1;
    while (p > 0 && cost[p - 1] > d) {
      cost[p] = cost[p - 1];
      best[p] = best[p - 1];
      p--;
    }
    cost[p] = d;
    best[p] = i;
  }
  return found;
}
