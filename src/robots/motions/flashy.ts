// Flashy and angle-changing moves: hand-placed windows (ClipInfo.flashy) measured automatically,
// plus two detectors that run on the boxing and footwork clips (pivots and stance switches).
//
// Flashy strikes are stored the orthodox way: spinning moves turn clockwise seen from above (the
// direction an orthodox fighter turns his back), straight flashy strikes (jump kick, jumping knee,
// superman punch) throw the right side. The move frame's +x is the line from the pelvis at the
// start to where the striker lands, so the strike always lands on the opponent's line whatever
// the spin did on the way.
import type { ClipInfo, FlashySpec } from './clips';
import { CONTACT, runs } from './contacts';
import { otherSide, pt, SIDES, type HumanTrack, type PointId, type Side } from './human';
import { footDown, meanYaw, yawDiff, type Kin } from './kinematics';
import { norm, sub } from './math';
import type { Segment } from './segment';
import type { LimbSide, MoveLabel } from './types';

/** Labels whose windows are mirrored so they spin clockwise (heading decreasing). */
const SPIN_LABELS = new Set<MoveLabel>(['tornado_kick', 'spinning_back_kick', 'spinning_backfist']);
/** Straight flashy strikes: mirrored so the right side throws. */
const RIGHT_SIDE_LABELS = new Set<MoveLabel>(['jump_kick', 'jumping_knee', 'superman_punch']);

const BACKFIST_AIM_POWER = 4; // how strongly a backfist's landing prefers the opening line
const SQUARE_START_RAD = (20 * Math.PI) / 180; // a spinning move starts squared up to within this
const MIN_WINDUP_S = 0.2; // a spinning move starts at least this long before its strike phase
const MAX_LEAP_S = 0.4; // longest flight a derived leap adds
const ONSET = 0.3; // the strike phase starts where the striker's speed first exceeds this × peak
const MAX_ONSET_S = 0.6;
const REACH_AFTER_S = 0.25; // full reach is searched this long after the impact
const FEINT_HIP_SPEED = 0.8; // m/s: a feint's burst
const UP_CHEST = 0.8;
const UP_HIP = 0.8;
const DOWN_HIP = 0.6;
const DOWN_CHEST = 0.3;

const PIVOT = {
  minTurn: (30 * Math.PI) / 180,
  maxTurn: (120 * Math.PI) / 180,
  minSwingS: 0.1,
  maxSwingS: 0.9,
  maxTravel: 0.6, // m of hip travel
  padS: 0.15,
  tailS: 0.2,
  ballDrift: 0.1, // m the pivot foot's ball may slide
  ballHeight: 0.07, // m the pivot foot's ball may rise
};

const SWITCH = {
  stance: 0.12, // m of lead-foot offset on both sides of the switch
  maxS: 0.7,
  maxTurn: (30 * Math.PI) / 180,
  maxTravel: 0.4,
  padS: 0.1,
  tailS: 0.2,
};

const S: Record<Side, 'L' | 'R'> = { l: 'L', r: 'R' };

function segId(label: MoveLabel, clip: string, start: number, mirrored: boolean): string {
  return `${label}.${clip}.${String(start).padStart(4, '0')}${mirrored ? 'm' : ''}`;
}

/**
 * Unwrapped heading of the hip line (left hip − right hip, turned −90°): stays defined when the
 * actor folds over or goes horizontal in a butterfly kick, unlike the pelvis or head forward axis.
 */
export function hipHeading(tr: HumanTrack): Float64Array {
  const out = new Float64Array(tr.n);
  let prev = 0;
  for (let i = 0; i < tr.n; i++) {
    const l = pt(tr, 'hipL', i), r = pt(tr, 'hipR', i);
    const h = Math.atan2(l[1] - r[1], l[0] - r[0]) - Math.PI / 2;
    out[i] = i === 0 ? h : out[i - 1] + yawDiff(h, prev);
    prev = h;
  }
  return out;
}

/** Striker part ('foot_l', 'fist_r', 'shin_r') → the source point that lands. */
function strikerPoint(part: string): { point: PointId; side: Side; kind: 'foot' | 'fist' | 'knee' } {
  const side: Side = part.endsWith('_l') ? 'l' : 'r';
  if (part.startsWith('foot')) return { point: `ankle${S[side]}`, side, kind: 'foot' };
  if (part.startsWith('fist')) return { point: `fist${S[side]}`, side, kind: 'fist' };
  if (part.startsWith('shin')) return { point: `knee${S[side]}`, side, kind: 'knee' };
  throw new Error(`flashy striker '${part}' is not a foot, fist or shin`);
}

function pointSpeed(tr: HumanTrack, id: PointId, i: number): number {
  const a = Math.max(0, i - 1), b = Math.min(tr.n - 1, i + 1);
  if (a === b) return 0;
  const p = pt(tr, id, a), q = pt(tr, id, b);
  return (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) * tr.fps) / (b - a);
}

const swapPart = (part: string): string => (part.endsWith('_l') ? `${part.slice(0, -2)}_r` : `${part.slice(0, -2)}_l`);

/** Longest run of frames in [a, b) where nothing (feet, hands, knees, hips, chest) is down. */
export function airborne(contacts: ArrayLike<number>, a: number, b: number): [number, number] | null {
  const air = new Uint8Array(Math.max(0, b - a));
  for (let i = a; i < b; i++) air[i - a] = contacts[i] === 0 ? 1 : 0;
  let best: [number, number] | null = null;
  for (const [s, e] of runs(air)) if (!best || e - s > best[1] - best[0]) best = [a + s, a + e];
  return best && best[1] - best[0] >= 3 ? best : null;
}

interface StrikeTiming {
  impact: number;
  reach: number;
  strike: number;
  peak: number;
}

function strikeTiming(k: Kin, spec: FlashySpec, start: number, end: number): StrikeTiming {
  const { tr, fps } = k;
  const sp = strikerPoint(spec.striker!);
  const w0 = Math.max(start, Math.round((spec.strike?.[0] ?? spec.from) * fps));
  const w1 = Math.min(end - 1, Math.round((spec.strike?.[1] ?? spec.to) * fps));
  // A spinning backfist's arm (a spinning back kick's heel) is out all the way round: it lands
  // where it passes back through the line the fighter faced at the start, weighted by its speed.
  const facing = meanYaw(k.yaw, start, start + 12);
  const aligned = (i: number): number => {
    if (spec.label !== 'spinning_backfist' && spec.label !== 'spinning_back_kick') return 1;
    const p = pt(tr, sp.point, i), h = pt(tr, 'hipC', i);
    const c = Math.cos(yawDiff(Math.atan2(p[1] - h[1], p[0] - h[0]), facing));
    return c > 0 ? c ** BACKFIST_AIM_POWER : 0;
  };
  let impact = w0, peak = 0, best = 0;
  for (let i = w0; i <= w1; i++) {
    const v = pointSpeed(tr, sp.point, i);
    if (v * aligned(i) > best) {
      best = v * aligned(i);
      peak = v;
      impact = i;
    }
  }
  const fastest = impact;
  if (sp.kind === 'knee') {
    // A knee lands at the top of its drive (it is fastest on the way up, off the mat).
    let top = -Infinity;
    for (let i = w0; i <= w1; i++) {
      const z = pt(tr, sp.point, i)[2];
      if (z > top) {
        top = z;
        impact = i;
      }
    }
  }
  let strike = fastest;
  while (strike > start && fastest - strike < MAX_ONSET_S * fps && pointSpeed(tr, sp.point, strike - 1) > ONSET * peak) strike--;
  if (sp.kind === 'knee') return { impact, reach: impact, strike: Math.min(strike, impact), peak };
  const anchor: PointId = sp.kind === 'fist' ? `shoulder${S[sp.side]}` : 'hipC';
  let reach = impact, far = -Infinity;
  for (let i = impact; i <= Math.min(end - 1, impact + Math.round(REACH_AFTER_S * fps)); i++) {
    const d = norm(sub(pt(tr, sp.point, i), pt(tr, anchor, i)));
    if (d > far + 1e-4) {
      far = d;
      reach = i;
    } else if (d < far - 0.03) break; // coming back: full reach has passed
  }
  return { impact, reach, strike: Math.min(strike, impact), peak };
}

/**
 * Heading of the strike where it lands: from the pelvis to the striker at impact. This is the
 * move frame's +x (toward the opponent), so the opponent is in front of the body when it lands
 * even after a traveling jump.
 */
function strikeLine(k: Kin, point: PointId, impact: number): number {
  const p = pt(k.tr, point, impact), h = pt(k.tr, 'hipC', impact);
  return Math.atan2(p[1] - h[1], p[0] - h[0]);
}

/** The full turn a 'spin' derivation adds: the same way the source already turns (clockwise if not). */
const addedTurn = (hd: Float64Array, start: number, end: number): number => (hd[end - 1] - hd[start] > 0 ? 2 * Math.PI : -2 * Math.PI);

/** First frame in [from, strike − MIN_WINDUP_S] facing along the strike line (else the best). */
function squareStart(k: Kin, point: PointId, from: number, impact: number, strike: number): number {
  const line = strikeLine(k, point, impact);
  let best = from, bestErr = Infinity;
  for (let s = from; s <= strike - Math.round(MIN_WINDUP_S * k.fps); s++) {
    if (!footDown(k, 'l', s) && !footDown(k, 'r', s)) continue; // a move starts on the mat
    const err = Math.abs(yawDiff(k.yaw[s], line));
    if (err < SQUARE_START_RAD) return s;
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}

/** Kip-up sources: the rise is the strike phase (down on the hands or hips, then upright). */
function riseTiming(k: Kin, start: number, end: number): [number, number] {
  const down = (i: number) => (k.contacts[i] & (CONTACT.HAND_L | CONTACT.HAND_R | CONTACT.HIPS | CONTACT.CHEST)) !== 0
    || k.hipRatio[i] < DOWN_HIP || k.chestUp[i] < DOWN_CHEST;
  let strike = start;
  while (strike < end - 1 && !down(strike)) strike++;
  if (strike >= end - 1) strike = start;
  let recover = strike;
  while (recover < end - 1 && !(k.chestUp[recover] > UP_CHEST && k.hipRatio[recover] > UP_HIP && (footDown(k, 'l', recover) || footDown(k, 'r', recover)) && recover > strike + 6)) recover++;
  return [strike, recover];
}

/** Feints: the burst of hip speed. */
function burstTiming(k: Kin, start: number, end: number): [number, number] {
  let a = start, b = end - 1;
  while (a < end - 1 && k.hipSpeed[a] < FEINT_HIP_SPEED) a++;
  while (b > a && k.hipSpeed[b] < FEINT_HIP_SPEED) b--;
  if (a >= b) return [start + Math.round((end - start) / 3), start + Math.round((2 * (end - start)) / 3)];
  return [a, b];
}

/** The stepping foot's swing inside [a, b]: where a lunge becomes a leap. */
function stepSwing(k: Kin, a: number, b: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const s of SIDES) {
    const up = new Uint8Array(k.n);
    for (let i = 0; i < k.n; i++) up[i] = footDown(k, s, i) ? 0 : 1;
    for (const [rs, re] of runs(up)) {
      if (re <= a || rs >= b) continue;
      if (!best || re - rs > best[1] - best[0]) best = [rs, re];
    }
  }
  return best;
}

export function flashySegments(k: Kin, clip: ClipInfo): Segment[] {
  const out: Segment[] = [];
  const hd = hipHeading(k.tr);
  const { fps, n, tr } = k;
  for (const spec of clip.flashy ?? []) {
    let start = Math.max(0, Math.round(spec.from * fps));
    const end = Math.min(n, Math.round(spec.to * fps));
    if (end - start < 6) continue;
    const src = spec.striker ? strikerPoint(spec.striker) : null;
    let spin0 = hd[end - 1] - hd[start];
    if (spec.derive?.includes('spin')) spin0 += addedTurn(hd, start, end);
    let mirrored = false;
    if (SPIN_LABELS.has(spec.label)) mirrored = spin0 > 0;
    else if (RIGHT_SIDE_LABELS.has(spec.label) && src) mirrored = src.side === 'l';
    let impact: number | null = null, reach: number | null = null, strike: number, recover: number, score = 1;
    let yaw: number;
    if (src && SPIN_LABELS.has(spec.label)) {
      // A spinning strike starts squared up to where it lands: the move begins at the first frame
      // (inside the hand-placed window) where the actor faces the line to the landing point.
      const t = strikeTiming(k, spec, start, end);
      start = squareStart(k, src.point, start, t.impact, t.strike);
    }
    if (src) {
      const t = strikeTiming(k, spec, start, end);
      ({ impact, reach, strike } = t);
      recover = t.reach;
      score = t.peak;
      yaw = strikeLine(k, src.point, impact!);
    } else {
      [strike, recover] = spec.label === 'kipup_source' ? riseTiming(k, start, end) : burstTiming(k, start, end);
      yaw = meanYaw(k.yaw, start, start + 12);
    }
    const spin = hd[end - 1] - hd[start] + (spec.derive?.includes('spin') ? addedTurn(hd, start, end) : 0);
    const striker = spec.striker ? (mirrored ? swapPart(spec.striker) : spec.striker) : null;
    const side: LimbSide | null = striker ? (striker.endsWith('_l') ? 'l' : 'r') : spec.label === 'feint_left' ? 'l' : spec.label === 'feint_right' ? 'r' : null;
    const air = airborne(k.contacts, start, end);
    const base: Segment = {
      id: segId(spec.label, clip.id, start, mirrored), clip: clip.id, label: spec.label, side, height: striker ? 'high' : null,
      striker, mirrored, start, end, strike, recover, impact, reach, loop: false, yaw, score, auto: false,
      why: `${spec.note ?? clip.note}; spin ${((spin * 180) / Math.PI).toFixed(0)}°${air ? ` air ${((air[1] - air[0]) / fps).toFixed(2)} s` : ''}${impact !== null ? ` impact ${(impact / fps).toFixed(2)} s` : ''}`,
    };
    if (striker && src && spec.label !== 'superman_punch') {
      const z = pt(tr, src.point, impact!)[2] / tr.dims.standHipHeight;
      base.height = z > 1.5 ? 'high' : z > 0.9 ? 'mid' : 'low';
    }
    if (spec.derive?.includes('knee') && src) {
      base.adjust = { side: mirrored ? otherSide(src.side) : src.side, from: Math.max(start, strike - Math.round(0.25 * fps)), peak: impact!, to: Math.min(end - 1, reach! + Math.round(0.25 * fps)), dz: 0, fold: true };
    }
    if (spec.derive?.includes('spin') && src && impact !== null) {
      const [before, after] = spec.spinWindow ?? [0.2, 0.06];
      base.turn = { from: strike - Math.round(before * fps), to: impact - Math.round(after * fps), angle: addedTurn(hd, start, end), support: otherSide(src.side) };
    }
    if (spec.derive?.includes('leap') && impact !== null) {
      if (spec.leapAround) {
        base.leap = { from: impact - Math.round(spec.leapAround[0] * fps), to: impact + Math.round(spec.leapAround[1] * fps) };
      } else {
        // Over the stepping foot's swing, starting on the ground (inside the move) and at most
        // MAX_LEAP_S long: a 0.4 s flight is a 20 cm hop for a human, more for longer legs.
        const sw = stepSwing(k, strike - Math.round(0.2 * fps), impact);
        if (sw) {
          const to = sw[1];
          const from = Math.max(sw[0] - 1, start + Math.round(MIN_WINDUP_S * fps), to - Math.round(MAX_LEAP_S * fps));
          if (to - from >= 6) base.leap = { from, to };
        }
      }
    }
    out.push(base);
    if (spec.mirrorAs) {
      out.push({ ...base, id: segId(spec.mirrorAs, clip.id, start, !mirrored), label: spec.mirrorAs, mirrored: !mirrored, side: base.side ? otherSide(base.side) : null, striker: striker ? swapPart(striker) : null, yaw });
    }
  }
  return out;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/**
 * Pivots: one foot stays planted while the other swings round it and the hips turn 30–120°.
 * Stored orthodox (a southpaw source is mirrored); every pivot is also stored mirrored, the turn
 * the other way.
 */
export function pivotSegments(k: Kin, clip: ClipInfo, busy: Array<[number, number]>): Segment[] {
  const { fps, n, tr } = k;
  const hd = hipHeading(tr);
  const out: Segment[] = [];
  const pad = Math.round(PIVOT.padS * fps), tail = Math.round(PIVOT.tailS * fps);
  for (const p of SIDES) {
    const o = otherSide(p);
    const up = new Uint8Array(n);
    for (let i = 0; i < n; i++) up[i] = footDown(k, o, i) ? 0 : 1;
    for (const [a, b] of runs(up)) {
      const d = (b - a) / fps;
      if (d < PIVOT.minSwingS || d > PIVOT.maxSwingS || a - pad < 0 || b + tail >= n) continue;
      // The pivot foot turns on its ball: the ball stays on one spot of the mat (the contact flags
      // drop out while the heel swings, so the ball's drift and height are checked instead).
      const ball0 = pt(tr, `ball${S[p]}`, a - 2);
      let planted = true;
      for (let i = a - 2; i < b + 2 && planted; i++) {
        const q = pt(tr, `ball${S[p]}`, i);
        planted = Math.hypot(q[0] - ball0[0], q[1] - ball0[1]) < PIVOT.ballDrift && q[2] < PIVOT.ballHeight;
      }
      if (!planted) continue;
      const start = a - pad, end = b + tail;
      const turn = hd[b + 3] - hd[a - 3];
      if (Math.abs(turn) < PIVOT.minTurn || Math.abs(turn) > PIVOT.maxTurn) continue;
      const travel = norm(sub(pt(tr, 'hipC', end), pt(tr, 'hipC', start)));
      let upright = true;
      for (let i = start; i < end && upright; i++) upright = k.chestUp[i] > UP_CHEST && k.hipRatio[i] > UP_HIP;
      if (!upright || travel > PIVOT.maxTravel || busy.some(([x, y]) => overlaps(start, end, x, y))) continue;
      const southpaw = k.stance[start] < -SWITCH.stance;
      const left = (turn > 0) !== southpaw;
      const label: MoveLabel = left ? 'pivot_left' : 'pivot_right';
      const yaw = meanYaw(k.yaw, start, start + 6);
      const base: Segment = {
        id: segId(label, clip.id, start, southpaw), clip: clip.id, label, side: null, height: null, striker: null, mirrored: southpaw,
        start, end, strike: a, recover: b, impact: null, reach: null, loop: false, yaw,
        score: 1 - Math.abs(Math.abs(turn) - Math.PI / 2.5) - 0.3 * travel, auto: true,
        why: `pivot on ${p} turn ${((turn * 180) / Math.PI).toFixed(0)}° travel ${travel.toFixed(2)} m`,
      };
      const other: MoveLabel = left ? 'pivot_right' : 'pivot_left';
      out.push(base, { ...base, id: segId(other, clip.id, start, !southpaw), label: other, mirrored: !southpaw, score: base.score - 0.05 });
    }
  }
  return out;
}

/** Stance switches: the lead foot changes (≥ 12 cm each way) within 0.7 s, square to the opponent. */
export function switchSegments(k: Kin, clip: ClipInfo, busy: Array<[number, number]>): Segment[] {
  const { fps, n, tr } = k;
  const out: Segment[] = [];
  const st = k.stance;
  const lim = SWITCH.stance;
  let i = 0;
  while (i < n) {
    if (Math.abs(st[i]) < lim) {
      i++;
      continue;
    }
    const sign = Math.sign(st[i]);
    let a = i;
    while (a + 1 < n && Math.sign(st[a + 1]) === sign && Math.abs(st[a + 1]) >= lim) a++;
    let b = a + 1;
    while (b < n && b - a <= SWITCH.maxS * fps && !(st[b] * sign <= -lim)) b++;
    if (b >= n || b - a > SWITCH.maxS * fps) {
      i = a + 1;
      continue;
    }
    const start = Math.max(0, a - Math.round(SWITCH.padS * fps)), end = Math.min(n, b + Math.round(SWITCH.tailS * fps));
    const turn = Math.abs(yawDiff(k.yaw[end - 1], k.yaw[start]));
    const travel = norm(sub(pt(tr, 'hipC', end - 1), pt(tr, 'hipC', start)));
    let upright = true;
    for (let j = start; j < end && upright; j++) upright = k.chestUp[j] > UP_CHEST && k.hipRatio[j] > UP_HIP;
    if (upright && turn < SWITCH.maxTurn && travel < SWITCH.maxTravel && !busy.some(([x, y]) => overlaps(start, end, x, y))) {
      const mirrored = sign < 0; // stored starting orthodox
      out.push({
        id: segId('switch_stance', clip.id, start, mirrored), clip: clip.id, label: 'switch_stance', side: null, height: null, striker: null, mirrored,
        start, end, strike: a, recover: b, impact: null, reach: null, loop: false, yaw: meanYaw(k.yaw, start, start + 6),
        score: 1 / (0.2 + (b - a) / fps) - travel, auto: true,
        why: `stance ${st[a].toFixed(2)} → ${st[b].toFixed(2)} m in ${((b - a) / fps).toFixed(2)} s, turn ${((turn * 180) / Math.PI).toFixed(0)}°`,
      });
    }
    i = b;
  }
  return out;
}
