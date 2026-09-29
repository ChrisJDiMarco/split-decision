// Automatic segmentation: a human track sliced into labelled moves with phase boundaries.
//
// Strikes are speed peaks of a fist (relative to the chest) or an ankle, classified from the
// trajectory in the facing frame: straight (along the facing), hook (inward sweep, elbow up),
// uppercut (rising), overhand (over the top, coming down), and for kicks front (thrust forward,
// hips square), roundhouse (sweep across, hips turned over) and side (thrust with the hips side-on).
// Lead / rear comes from the feet: the actor's stance at the strike decides whether the segment is
// mirrored so every stored move is orthodox (left side leads). Footwork, guard, walks and get-ups
// come from contacts, hip travel and posture. Phases: windup [start, strike), strike
// [strike, recover), recover [recover, end); impact = peak striker speed, reach = full extension.
import { detectorsOf, type ClipInfo, type Detector, type GetupPosture } from './clips';
import { runs } from './contacts';
import { fr, pt, SIDES, otherSide, type HumanTrack, type Side } from './human';
import { footDown, kinematics, meanYaw, toFacing, v3, yawDiff, type Kin } from './kinematics';
import { cross, dot, norm, sub } from './math';
import { peaks } from './signals';
import type { StrikeAdjust } from './retarget';
import type { LimbSide, MoveLabel, StrikeHeight } from './types';

export interface Segment {
  id: string;
  clip: string;
  label: MoveLabel;
  side: LimbSide | null; // orthodox side, after mirroring ('l' leads)
  height: StrikeHeight | null;
  striker: string | null; // part that should land, after mirroring
  mirrored: boolean; // retarget the mirrored track (a southpaw source made orthodox)
  start: number; // track frame, inclusive
  end: number; // track frame, exclusive
  strike: number; // first frame of the strike phase
  recover: number; // first frame of the recover phase
  impact: number | null; // track frame
  reach: number | null;
  loop: boolean;
  yaw: number; // facing heading in the source track (before mirroring), radians
  score: number; // ranking within a label: higher is cleaner / harder / more useful
  auto: boolean;
  why: string; // compact feature summary for reports
  /** Derived move: retarget the source with this strike re-aim (see StrikeAdjust). */
  adjust?: StrikeAdjust;
}

// ---------------------------------------------------------------- thresholds

const STANCE_MIN_M = 0.12; // |lead-foot offset| below this: square stance (kept as orthodox)

const ARM = {
  minPeak: 2.6, // m/s, fist relative to the chest
  gap: 8, // frames between peaks of one fist
  onset: 0.22, // the strike phase starts where the speed first exceeds this × peak
  maxStrikeS: 0.45,
  maxWindupS: 0.35,
  maxReachS: 0.35,
  maxRecoverS: 0.7,
  minTravel: 0.12, // m the fist moves over the strike phase
};

const KICK = {
  minPeak: 3.4, // m/s, ankle
  gap: 24,
  minHeight: 0.4, // × standing hip height: the ankle rises at least this high
  minExtension: 0.78, // × leg length: hip-to-ankle at full reach (knee strikes stay folded)
  minReachHeight: 0.4, // × standing hip height: the ankle at full reach
  preS: 0.25,
  postS: 0.35,
  maxSwingS: 1.4,
};

const LOW_KICK = {
  minSourceHeight: 0.95, // × standing hip height: only body or head kicks are lowered
  height: 0.6, // × standing hip height: the ankle at impact (the opponent's thigh)
};

const GUARD = {
  fistSpeed: 2.0,
  ankleSpeed: 3.0,
  hipSpeed: 0.45,
  minRunS: 1.0,
  minLoopS: 0.8,
  maxLoopS: 1.8,
  clearS: 0.15, // keep this far from strikes and steps
};

const STEP = {
  minSwingS: 0.08,
  maxSwingS: 0.9,
  pairGapS: 0.4, // second foot starts within this after the first lands
  minTravel: 0.12, // m of hip travel
  maxS: 1.4,
  padS: 0.12,
};

const WALK = {
  minSpeed: 0.3,
  minRunS: 1.6,
  minCycleS: 0.7,
  maxCycleS: 1.7,
  maxTurn: 0.26, // rad of pelvis heading change over one cycle: more is a curve, not a straight walk
};

const GETUP = {
  lyingHip: 0.42, // hip-centre height ratio
  lyingSpineUp: 0.55, // hips → neck direction · up
  standHip: 0.8,
  standSpineUp: 0.8,
  stillSpeed: 0.3, // m/s body speed (settled after standing)
  restSpeed: 0.18, // m/s mean body speed over a resting spell on the mat
  restS: 0.3,
  mergeS: 0.25,
  minLyingS: 0.3,
  maxRiseS: 7,
  settleS: 0.3,
  preS: 0.25,
};

// ---------------------------------------------------------------- helpers

const S: Record<Side, 'L' | 'R'> = { l: 'L', r: 'R' };

function segId(label: MoveLabel, clip: string, start: number, mirrored: boolean): string {
  return `${label}.${clip}.${String(start).padStart(4, '0')}${mirrored ? 'm' : ''}`;
}

/** Side after mirroring. */
const orth = (s: Side, mirrored: boolean): Side => (mirrored ? otherSide(s) : s);

function meanOf(x: ArrayLike<number>, a: number, b: number): number {
  let s = 0, c = 0;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) {
    s += x[i];
    c++;
  }
  return c ? s / c : 0;
}

function maxOf(x: ArrayLike<number>, a: number, b: number): number {
  let m = -Infinity;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) m = Math.max(m, x[i]);
  return m;
}

function argMin(x: ArrayLike<number>, a: number, b: number): number {
  let best = Math.max(0, a);
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) if (x[i] < x[best]) best = i;
  return best;
}

function argMax(x: ArrayLike<number>, a: number, b: number): number {
  let best = Math.max(0, a);
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) if (x[i] > x[best]) best = i;
  return best;
}

const inSkip = (c: ClipInfo, fps: number, a: number, b: number): boolean =>
  (c.skip ?? []).some(([s, e]) => a < e * fps && b > s * fps);

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/** Stance at frame range: mirrored when the right foot leads. */
function southpaw(k: Kin, a: number, b: number): boolean {
  return meanOf(k.stance, a, b) < -STANCE_MIN_M;
}

// ---------------------------------------------------------------- arm strikes and blocks

export interface ArmEvent {
  s: Side;
  start: number; strike: number; peak: number; reach: number; end: number;
  vp: number;
  u: [number, number, number]; // unit fist velocity at the peak: fwd, inward, up
  travel: [number, number, number]; // strike-phase displacement: fwd, inward, up
  straightness: number;
  startAbove: number; // fist above its shoulder at the strike start, m
  maxAbove: number; // highest fist over the strike phase, above the shoulder, m
  reachAbove: number; // fist above the shoulder at reach
  elbowAbove: number; // elbow above the shoulder at reach
  extension: number; // shoulder→fist at reach / arm length
  otherPeak: number; // the other fist's top speed over the strike, / vp
}

export function armEvents(k: Kin, s: Side, minPeak: number): ArmEvent[] {
  const { n, fps, tr } = k;
  const sp = k.fist[s].speed;
  const inward = (v: number[]) => (s === 'l' ? -v[1] : v[1]);
  const out: ArmEvent[] = [];
  for (const p of peaks(sp, minPeak, ARM.gap)) {
    const vp = sp[p];
    const vel = v3(k.fist[s].vel, p);
    const vn = norm(vel) || 1;
    const u: [number, number, number] = [vel[0] / vn, inward(vel) / vn, vel[2] / vn];
    const r = sub(v3(k.fist[s].rel, p), v3(k.shoulder[s], p));
    const radial = dot(vel, r) / (vn * (norm(r) || 1));
    if (radial < -0.35 || u[0] < -0.3) continue; // pulling back, not striking
    let a = p;
    while (a > 0 && p - a < ARM.maxStrikeS * fps && sp[a - 1] > ARM.onset * vp) a--;
    const strike = a;
    const start = Math.min(strike - 2, argMin(sp, strike - Math.round(ARM.maxWindupS * fps), strike + 1));
    let reach = p;
    while (reach + 1 < n && reach - p < ARM.maxReachS * fps && sp[reach + 1] <= sp[reach]) reach++;
    // Recovery: the fist comes back to where the strike began (or as close as it gets).
    const home = v3(k.fist[s].rel, strike);
    const dist = new Float64Array(n);
    for (let i = reach; i < Math.min(n, reach + Math.round(ARM.maxRecoverS * fps)); i++) {
      dist[i] = norm(sub(v3(k.fist[s].rel, i), home)) + 0.02 * sp[i];
    }
    const end = Math.min(n, argMin(dist, reach + 4, reach + Math.round(ARM.maxRecoverS * fps)) + 3);
    const d = sub(v3(k.fist[s].rel, reach), home);
    let path = 0;
    for (let i = strike + 1; i <= reach; i++) path += norm(sub(v3(k.fist[s].rel, i), v3(k.fist[s].rel, i - 1)));
    const above = (i: number) => k.fist[s].rel[i * 3 + 2] - k.shoulder[s][i * 3 + 2];
    let maxAbove = -Infinity;
    for (let i = strike; i <= reach; i++) maxAbove = Math.max(maxAbove, above(i));
    const extension = norm(sub(pt(tr, `fist${S[s]}`, reach), pt(tr, `shoulder${S[s]}`, reach))) / tr.dims.armLength;
    out.push({
      s, start: Math.max(0, start), strike, peak: p, reach, end, vp, u,
      travel: [d[0], inward(d), d[2]],
      straightness: path > 1e-6 ? norm(d) / path : 0,
      startAbove: above(strike), maxAbove, reachAbove: above(reach),
      elbowAbove: k.elbow[s][reach * 3 + 2] - k.shoulder[s][reach * 3 + 2],
      extension,
      otherPeak: maxOf(k.fist[otherSide(s)].speed, strike, reach + 1) / vp,
    });
  }
  return out;
}

type PunchKind = 'straight' | 'hook' | 'uppercut' | 'overhand';

export function classifyPunch(e: ArmEvent): { kind: PunchKind | null; confidence: number } {
  const [uf, ui, uu] = e.u;
  const [df, di, du] = e.travel;
  const travel = Math.hypot(df, di, du);
  if (travel < ARM.minTravel) return { kind: null, confidence: 0 };
  // Uppercut: the fist rises in front of the body with the arm still bent (a rising punch that
  // ends fully extended is a straight thrown from a low guard).
  if (uu > 0.5 && du > 0.18 && e.extension < 0.84 && e.startAbove < -0.1 && df > -0.05 && di < 0.25 && du > di) {
    return { kind: 'uppercut', confidence: uu };
  }
  if (e.maxAbove > 0.05 && uu < -0.25 && df > 0.08 && e.startAbove > -0.02) return { kind: 'overhand', confidence: -uu };
  // Straight: a line from the guard to a fully extended arm (diagonal to the centre line is fine).
  if (e.extension >= 0.8 && e.straightness >= 0.88 && df > 0.15 && uf > 0.35) {
    return { kind: 'straight', confidence: Math.min(1, uf + 0.2) * Math.min(1, e.straightness + 0.05) };
  }
  // Hook: the arm stays bent and the fist sweeps inward on an arc with the elbow lifted.
  if (e.extension < 0.9 && di > 0.15 && (ui > 0.4 || e.straightness < 0.7) && e.elbowAbove > -0.3 && uu < 0.75) {
    return { kind: 'hook', confidence: Math.max(ui, 1 - e.straightness) };
  }
  return { kind: null, confidence: 0 };
}

function punchSegments(k: Kin, clip: ClipInfo, block: boolean): Segment[] {
  const out: Segment[] = [];
  for (const s of SIDES) {
    for (const e of armEvents(k, s, block ? 2.0 : ARM.minPeak)) {
      if (inSkip(clip, k.fps, e.start, e.end)) continue;
      const mirrored = southpaw(k, e.strike - 12, e.peak);
      const side = orth(s, mirrored);
      const high = e.reachAbove > -0.12;
      const why = `v${e.vp.toFixed(1)} u[${e.u.map((x) => x.toFixed(2)).join(',')}] d[${e.travel.map((x) => x.toFixed(2)).join(',')}] st${e.straightness.toFixed(2)} ext${e.extension.toFixed(2)} up${e.startAbove.toFixed(2)}/${e.maxAbove.toFixed(2)}/${e.reachAbove.toFixed(2)} el${e.elbowAbove.toFixed(2)} o${e.otherPeak.toFixed(2)}`;
      let label: MoveLabel;
      let confidence: number;
      if (block) {
        if (Math.hypot(...e.travel) < 0.1) continue;
        label = 'block';
        confidence = 1;
      } else {
        const c = classifyPunch(e);
        if (!c.kind) continue;
        confidence = c.confidence;
        label = c.kind === 'straight' ? (side === 'l' ? 'jab' : 'cross') : c.kind;
      }
      out.push({
        id: segId(label, clip.id, e.start, mirrored), clip: clip.id, label, side, height: high ? 'high' : 'mid',
        striker: `fist_${side}`, mirrored, start: e.start, end: e.end, strike: e.strike, recover: e.reach,
        impact: e.peak, reach: e.reach, loop: false, yaw: meanYaw(k.yaw, e.start, e.peak + 1),
        score: e.vp * confidence * (1 - 0.5 * Math.min(1, e.otherPeak)), auto: true, why,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- kicks

function kickSegments(k: Kin, clip: ClipInfo): Segment[] {
  const { tr, n, fps } = k;
  const H = tr.dims.standHipHeight;
  const out: Segment[] = [];
  for (const s of SIDES) {
    const sp = k.ankle[s].speed;
    const seen = new Set<number>(); // liftoff frames: one kick per swing
    for (const p of peaks(sp, KICK.minPeak, KICK.gap).sort((x, y) => sp[y] - sp[x])) {
      if (footDown(k, s, p)) continue;
      let a = p;
      while (a > 0 && !footDown(k, s, a - 1) && p - a < KICK.maxSwingS * fps) a--;
      let b = p;
      while (b < n - 1 && !footDown(k, s, b) && b - p < KICK.maxSwingS * fps) b++;
      if (seen.has(a)) continue;
      seen.add(a);
      let hmax = -Infinity, ext = 0, reach = p;
      for (let i = a; i < b; i++) {
        const an = pt(tr, `ankle${S[s]}`, i);
        hmax = Math.max(hmax, an[2]);
        const e = norm(sub(an, pt(tr, 'hipC', i)));
        if (e > ext && i >= p - Math.round(0.1 * fps)) {
          ext = e;
          reach = i;
        }
      }
      const extension = ext / tr.dims.legLength;
      if (hmax < KICK.minHeight * H || extension < KICK.minExtension) continue;
      const impact = argMax(sp, reach - Math.round(0.2 * fps), reach + 3);
      const start = Math.max(0, a - Math.round(KICK.preS * fps));
      const end = Math.min(n, b + Math.round(KICK.postS * fps));
      if (inSkip(clip, fps, start, end)) continue;
      const yawF = meanYaw(k.yaw, start, a + 1);
      const turn = yawDiff(k.pelvisYaw[reach], yawF);
      const vel = v3(k.ankle[s].vel, impact);
      const vn = norm(vel) || 1;
      const inward = (s === 'l' ? -vel[1] : vel[1]) / vn;
      const fwd = vel[0] / vn;
      const rel = toFacing(sub(pt(tr, `ankle${S[s]}`, reach), pt(tr, 'hipC', reach)), yawF);
      const heightR = pt(tr, `ankle${S[s]}`, reach)[2] / H;
      // Which way the sole faces at full reach: at the target for a side kick (heel / blade
      // thrust), sideways or back for a roundhouse (instep or ball of the foot whipped around).
      const F = fr(tr, `foot${S[s]}`, reach);
      const sole = toFacing([-F[2], -F[5], -F[8]], yawF);
      if (fwd < 0.2 || heightR < KICK.minReachHeight) continue; // stepping back, or a knee lift
      // Leg plane at the chamber (knee most folded while raised): a front kick folds in a vertical
      // plane (flexion axis horizontal), a roundhouse or side kick with the hip rolled over folds
      // in a horizontal one (axis vertical).
      let chamber = a, fold = Infinity;
      for (let i = a; i <= reach; i++) {
        const d = norm(sub(pt(tr, `ankle${S[s]}`, i), pt(tr, `hip${S[s]}`, i)));
        if (pt(tr, `knee${S[s]}`, i)[2] > 0.55 * H && d < fold) {
          fold = d;
          chamber = i;
        }
      }
      const hipP = pt(tr, `hip${S[s]}`, chamber), kneeP = pt(tr, `knee${S[s]}`, chamber), ankP = pt(tr, `ankle${S[s]}`, chamber);
      const axis = cross(sub(hipP, kneeP), sub(ankP, kneeP));
      const axisUp = Math.abs(axis[2]) / (norm(axis) || 1);
      let kind: 'front' | 'round' | 'side';
      if (clip.kick) kind = clip.kick;
      else if (axisUp < 0.3 && fwd > 0.35) kind = 'front';
      else if (sole[0] > 0.6 && Math.abs(turn) > 1.15 && axisUp > 0.66) kind = 'side';
      else kind = 'round';
      const height: StrikeHeight = heightR > 1.5 ? 'high' : heightR > 0.9 ? 'mid' : 'low';
      const label: MoveLabel = kind === 'front' ? 'front_kick' : kind === 'side' ? 'side_kick' : height === 'high' ? 'head_kick' : 'low_kick';
      const mirrored = southpaw(k, a - 12, a);
      const side = orth(s, mirrored);
      const why = `v${sp[impact].toFixed(1)} fwd${fwd.toFixed(2)} in${inward.toFixed(2)} turn${turn.toFixed(2)} axisUp${axisUp.toFixed(2)} sole[${sole.map((x) => x.toFixed(2)).join(',')}] h${heightR.toFixed(2)} ext${extension.toFixed(2)} rel[${rel.map((x) => x.toFixed(2)).join(',')}]${clip.kick ? ' (clip)' : ''}`;
      const seg: Segment = {
        id: segId(label, clip.id, start, mirrored), clip: clip.id, label, side, height, striker: `foot_${side}`, mirrored,
        start, end, strike: a, recover: reach, impact, reach, loop: false, yaw: yawF,
        score: sp[impact] * Math.min(1.2, extension), auto: true, why,
      };
      out.push(seg);
      // The source set has body- and head-height roundhouses but no leg kicks: a low kick is the
      // same kick re-aimed at the thigh (the ankle path lowered around impact, the rest untouched).
      if (kind === 'round' && heightR > LOW_KICK.minSourceHeight) {
        const dz = LOW_KICK.height * H - pt(tr, `ankle${S[s]}`, reach)[2];
        out.push({
          ...seg, id: `${segId('low_kick', clip.id, start, mirrored)}L`, label: 'low_kick', height: 'low',
          score: seg.score * 0.9, why: `${why} lowered ${dz.toFixed(2)} m`,
          adjust: { side, from: a, peak: reach, to: Math.min(end - 1, reach + (reach - a)), dz },
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- steps, shuffles and walks

interface Swing {
  s: Side;
  a: number; // first airborne frame
  b: number; // first frame down again
}

function swings(k: Kin): Swing[] {
  const out: Swing[] = [];
  for (const s of SIDES) {
    const down = new Uint8Array(k.n);
    for (let i = 0; i < k.n; i++) down[i] = footDown(k, s, i) ? 0 : 1;
    for (const [a, b] of runs(down)) {
      const d = (b - a) / k.fps;
      if (a > 0 && b < k.n && d >= STEP.minSwingS && d <= STEP.maxSwingS) out.push({ s, a, b });
    }
  }
  return out.sort((x, y) => x.a - y.a);
}

/** Heading label of a displacement in the facing frame. */
function direction(d: [number, number]): 'forward' | 'back' | 'left' | 'right' {
  const a = Math.atan2(d[1], d[0]);
  if (Math.abs(a) < 0.87) return 'forward';
  if (Math.abs(a) > Math.PI - 0.87) return 'back';
  return a > 0 ? 'left' : 'right';
}

function travelIn(k: Kin, a: number, b: number, yaw: number): [number, number] {
  const p0 = pt(k.tr, 'hipC', a), p1 = pt(k.tr, 'hipC', Math.min(k.n - 1, b));
  const d = toFacing(sub(p1, p0), yaw);
  return [d[0], d[1]];
}

function shuffleSegments(k: Kin, clip: ClipInfo, busy: Array<[number, number]>): Segment[] {
  const { fps, n } = k;
  const out: Segment[] = [];
  const sw = swings(k);
  const used = new Set<number>();
  for (let i = 0; i < sw.length; i++) {
    if (used.has(i)) continue;
    const w1 = sw[i];
    const j = sw.findIndex((w, x) => x > i && !used.has(x) && w.s !== w1.s && w.a >= w1.a && w.a - w1.b <= STEP.pairGapS * fps);
    if (j < 0) continue;
    const w2 = sw[j];
    const start = Math.max(0, w1.a - Math.round(STEP.padS * fps));
    const end = Math.min(n, Math.max(w1.b, w2.b) + Math.round(STEP.padS * fps) + 1);
    if ((end - start) / fps > STEP.maxS) continue;
    if (busy.some(([a, b]) => overlaps(start, end, a, b)) || inSkip(clip, fps, start, end)) continue;
    const yaw = meanYaw(k.yaw, start, end);
    const d = travelIn(k, w1.a, Math.max(w1.b, w2.b), yaw);
    const dist = Math.hypot(d[0], d[1]);
    if (dist < STEP.minTravel) continue;
    used.add(i);
    used.add(j);
    const dir = direction(d);
    const label: MoveLabel = `shuffle_${dir}`;
    const mirrored = southpaw(k, start, w1.a + 1);
    // Mirroring flips left and right travel: the stored label follows the mirrored motion.
    const stored: MoveLabel = mirrored && (dir === 'left' || dir === 'right') ? (dir === 'left' ? 'shuffle_right' : 'shuffle_left') : label;
    out.push({
      id: segId(stored, clip.id, start, mirrored), clip: clip.id, label: stored, side: null, height: null, striker: null, mirrored,
      start, end, strike: w1.a, recover: Math.max(w1.b, w2.b), impact: null, reach: null, loop: false, yaw,
      score: Math.min(dist, 0.6) / ((end - start) / fps), auto: true,
      why: `d[${d.map((x) => x.toFixed(2)).join(',')}] ${w1.s}${w2.s} ${((end - start) / fps).toFixed(2)}s`,
    });
  }
  return out;
}

function walkSegments(k: Kin, clip: ClipInfo, busy: Array<[number, number]>): Segment[] {
  const { fps, n } = k;
  const out: Segment[] = [];
  const moving = new Uint8Array(n);
  for (let i = 0; i < n; i++) moving[i] = k.hipSpeed[i] > WALK.minSpeed ? 1 : 0;
  const sw = swings(k);
  for (const [ra, rb] of runs(moving)) {
    if ((rb - ra) / fps < WALK.minRunS) continue;
    // Gait cycles: consecutive touchdowns of one foot with the other foot's step in between.
    const inRun = sw.filter((w) => w.b > ra && w.b < rb);
    const cycles: Array<[number, number]> = [];
    for (let i = 0; i + 2 < inRun.length; i++) {
      const a = inRun[i], mid = inRun[i + 1], b = inRun[i + 2];
      if (a.s !== b.s || mid.s === a.s) continue;
      const d = (b.b - a.b) / fps;
      if (d >= WALK.minCycleS && d <= WALK.maxCycleS) cycles.push([a.b, b.b]);
    }
    // Steady state only: drop the first and last cycles of the run (starting, stopping).
    for (const [a, b] of cycles.slice(1, -1)) {
      if (busy.some(([x, y]) => overlaps(a, b, x, y)) || inSkip(clip, fps, a, b)) continue;
      // A loop repeats: a cycle that turns would be bent back straight at its seam.
      const turn = Math.abs(yawDiff(k.pelvisYaw[b], k.pelvisYaw[a]));
      if (turn > WALK.maxTurn) continue;
      // Walks are read in the body's frame (pelvis heading): an actor strolling sideways while
      // looking where they go is a side step, not a walk forward.
      const yaw = meanYaw(k.pelvisYaw, a, b);
      const d = travelIn(k, a, b, yaw);
      const dir = direction(d);
      const heading = Math.abs(yawDiff(Math.atan2(d[1], d[0]), 0));
      if (Math.hypot(d[0], d[1]) < 0.3) continue;
      const label: MoveLabel = dir === 'forward' ? 'walk_forward' : dir === 'back' ? 'walk_back' : dir === 'left' ? 'shuffle_left' : 'shuffle_right';
      const straight = dir === 'forward' ? 1 - heading / 0.87 : dir === 'back' ? 1 - (Math.PI - heading) / 0.87 : 0.5;
      out.push({
        id: segId(label, clip.id, a, false), clip: clip.id, label, side: null, height: null, striker: null, mirrored: false,
        start: a, end: b + 1, strike: a, recover: b, impact: null, reach: null, loop: true, yaw,
        score: Math.max(0.05, straight) * (1 - (0.5 * turn) / WALK.maxTurn), auto: true,
        why: `cycle ${((b - a) / fps).toFixed(2)}s d[${d.map((x) => x.toFixed(2)).join(',')}] turn ${turn.toFixed(2)}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- guard

/** Pose distance used to close guard loops: limb points relative to the hips (facing frame), feet on the mat. */
function poseDistance(k: Kin, a: number, b: number): number {
  let e = 0;
  for (const s of SIDES) {
    e += norm(sub(v3(k.fist[s].rel, a), v3(k.fist[s].rel, b))) ** 2;
    e += norm(sub(v3(k.ankle[s].rel, a), v3(k.ankle[s].rel, b))) ** 2;
    e += 0.05 * norm(sub(v3(k.fist[s].vel, a), v3(k.fist[s].vel, b))) ** 2;
  }
  // The feet must come back to the same spots on the mat too: closing a loop that stepped or
  // drifted drags planted feet.
  for (const s of SIDES) {
    const fa = pt(k.tr, `ankle${S[s]}`, a), fb = pt(k.tr, `ankle${S[s]}`, b);
    e += 4 * ((fa[0] - fb[0]) ** 2 + (fa[1] - fb[1]) ** 2);
  }
  const ha = pt(k.tr, 'hipC', a)[2], hb = pt(k.tr, 'hipC', b)[2];
  return Math.sqrt(e + 4 * (ha - hb) ** 2);
}

function guardSegments(k: Kin, clip: ClipInfo, busy: Array<[number, number]>): Segment[] {
  const { fps, n } = k;
  const clear = Math.round(GUARD.clearS * fps);
  const quiet = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    quiet[i] = k.fist.l.speed[i] < GUARD.fistSpeed && k.fist.r.speed[i] < GUARD.fistSpeed
      && k.ankle.l.speed[i] < GUARD.ankleSpeed && k.ankle.r.speed[i] < GUARD.ankleSpeed
      && k.hipSpeed[i] < GUARD.hipSpeed && k.chestUp[i] > 0.85
      && k.fist.l.rel[i * 3 + 2] > -0.12 && k.fist.r.rel[i * 3 + 2] > -0.12 // hands up
      && !busy.some(([a, b]) => i >= a - clear && i < b + clear) ? 1 : 0;
  }
  const out: Segment[] = [];
  for (const [ra, rb] of runs(quiet)) {
    if ((rb - ra) / fps < GUARD.minRunS || inSkip(clip, fps, ra, rb)) continue;
    let best = { a: -1, b: -1, e: Infinity };
    const minL = Math.round(GUARD.minLoopS * fps), maxL = Math.round(GUARD.maxLoopS * fps);
    for (let a = ra; a + minL < rb; a += 2) {
      for (let b = a + minL; b < Math.min(rb, a + maxL); b += 2) {
        const e = poseDistance(k, a, b) - 0.02 * ((b - a) / fps); // prefer longer loops a little
        if (e < best.e) best = { a, b, e };
      }
    }
    if (best.a < 0) continue;
    const mirrored = southpaw(k, best.a, best.b);
    out.push({
      id: segId('guard_idle', clip.id, best.a, mirrored), clip: clip.id, label: 'guard_idle', side: null, height: null, striker: null,
      mirrored, start: best.a, end: best.b + 1, strike: best.a, recover: best.b, impact: null, reach: null, loop: true,
      yaw: meanYaw(k.yaw, best.a, best.b), score: 1 / (0.05 + best.e), auto: true,
      why: `loop ${((best.b - best.a) / fps).toFixed(2)}s err ${best.e.toFixed(3)} run ${((rb - ra) / fps).toFixed(1)}s`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- get-ups

export function getupPosture(k: Kin, i: number): GetupPosture {
  const f = k.chestFwdUp[i];
  return f < -0.45 ? 'face_down' : f > 0.45 ? 'back' : 'side';
}

function getupSegments(k: Kin, clip: ClipInfo): Segment[] {
  const { fps, n, tr } = k;
  // Lying: hips near the mat with the spine (hips → neck) near horizontal. Standing: hips high
  // and the spine within ~37° of vertical (a careful ready crouch counts as up).
  const lying = new Uint8Array(n), standing = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hc = pt(tr, 'hipC', i), nk = pt(tr, 'neck', i);
    const spineUp = (nk[2] - hc[2]) / (norm(sub(nk, hc)) || 1);
    lying[i] = k.hipRatio[i] < GETUP.lyingHip && spineUp < GETUP.lyingSpineUp ? 1 : 0;
    standing[i] = k.hipRatio[i] > GETUP.standHip && spineUp > GETUP.standSpineUp ? 1 : 0;
  }
  // Lying runs: brief breaks (propping up on an elbow) merged, blips dropped.
  const lies: Array<[number, number]> = [];
  for (const r of runs(lying)) {
    const last = lies[lies.length - 1];
    if (last && r[0] - last[1] < GETUP.mergeS * fps) last[1] = r[1];
    else lies.push([r[0], r[1]]);
  }
  for (let i = lies.length - 1; i >= 0; i--) if (lies[i][1] - lies[i][0] < GETUP.minLyingS * fps) lies.splice(i, 1);
  const out: Segment[] = [];
  let prevStandEnd = 0;
  for (const st of runs(standing)) {
    if (st[1] - st[0] < 0.4 * fps) continue;
    // The last lying run before this standing run, with no standing in between.
    const lie = [...lies].reverse().find(([, b]) => b <= st[0] && b >= prevStandEnd && st[0] - b < GETUP.maxRiseS * fps);
    prevStandEnd = st[1];
    if (!lie) continue;
    const [la, lb] = lie;
    // Start: the end of the last resting spell while lying (the actor settled on the mat), so
    // any roll or reposition before the push is part of the get-up.
    const rest = Math.round(GETUP.restS * fps);
    let start = la;
    for (let i = lb - 1; i >= la + rest; i--) {
      if (meanOf(k.bodySpeed, i - rest, i + 1) < GETUP.restSpeed) {
        start = i;
        break;
      }
    }
    start = Math.max(la, start - Math.round(GETUP.preS * fps));
    // End: settled after standing up.
    let end = st[0];
    while (end < st[1] - 1 && k.bodySpeed[end] > GETUP.stillSpeed) end++;
    end = Math.min(n, end + Math.round(GETUP.settleS * fps));
    if (inSkip(clip, fps, start, end)) continue;
    const posture = getupPosture(k, start);
    const label: MoveLabel = `getup_${posture}`;
    // Which way the actor ends up facing is the move's forward.
    const yaw = meanYaw(k.yaw, st[0], Math.min(n, st[0] + Math.round(0.4 * fps)));
    out.push({
      id: segId(label, clip.id, start, false), clip: clip.id, label, side: null, height: null, striker: null, mirrored: false,
      start, end, strike: lb, recover: st[0], impact: null, reach: null, loop: false, yaw,
      score: 1, auto: true,
      why: `lying ${((lb - la) / fps).toFixed(1)}s rise ${((st[0] - lb) / fps).toFixed(2)}s chestFwd ${k.chestFwdUp[start].toFixed(2)}${clip.posture && clip.posture !== posture ? ` (note says ${clip.posture})` : ''}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- manual

function manualSegments(k: Kin, clip: ClipInfo): Segment[] {
  return (clip.manual ?? []).map((m) => {
    const start = Math.max(0, Math.round(m.from * k.fps));
    const end = Math.min(k.n, Math.round(m.to * k.fps));
    const mirrored = !!m.mirror;
    return {
      id: segId(m.label, clip.id, start, mirrored), clip: clip.id, label: m.label, side: m.side ?? null, height: null,
      striker: null, mirrored, start, end, strike: start, recover: end - 1, impact: null, reach: null, loop: !!m.loop,
      yaw: meanYaw(k.yaw, start, end), score: 1, auto: false, why: m.note ?? 'manual',
    };
  });
}

// ---------------------------------------------------------------- entry point

export interface SegmentResult {
  kin: Kin;
  segments: Segment[];
}

/** Segment one clip. Detectors run per the clip table; manual segments are appended. */
export function segmentClip(tr: HumanTrack, clip: ClipInfo, only?: readonly Detector[]): SegmentResult {
  const k = kinematics(tr);
  const det = new Set(only ?? detectorsOf(clip));
  const segs: Segment[] = [];
  if (det.has('punch')) segs.push(...punchSegments(k, clip, false));
  if (det.has('block')) segs.push(...punchSegments(k, clip, true));
  if (det.has('kick')) segs.push(...kickSegments(k, clip));
  const busy = (): Array<[number, number]> => segs.map((s) => [s.strike, s.recover]);
  if (det.has('walk')) segs.push(...walkSegments(k, clip, busy()));
  if (det.has('shuffle')) segs.push(...shuffleSegments(k, clip, busy()));
  if (det.has('guard')) segs.push(...guardSegments(k, clip, segs.map((s) => [s.start, s.end] as [number, number])));
  if (det.has('getup')) segs.push(...getupSegments(k, clip));
  segs.push(...manualSegments(k, clip));
  return { kin: k, segments: segs.sort((a, b) => a.start - b.start) };
}

/** Hip-centre travel of a segment in its facing frame (m), for reports. */
export function segmentTravel(k: Kin, s: Segment): [number, number] {
  return travelIn(k, s.start, s.end - 1, s.yaw);
}

