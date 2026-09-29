// Build the per-design motion libraries from the CMU clips in assets-src/mocap/cmu.
//
//   npx tsx tools/mocap/build-library.ts              every biped design in the roster
//   npx tsx tools/mocap/build-library.ts striker      one design (or several)
//   npx tsx tools/mocap/build-library.ts --moves      also print every selected move
//
// Pipeline: BVH → 60 Hz human track → segments (labelled, phased, orthodox) → ranked per label
// (design-independent: speed, cleanliness) → per design: retarget each source clip once (and its
// mirror when a segment needs it) → slice, align to the move frame, close loops, measure → keep
// the best moves per label that pass the quality gates → src/robots/motions/data/<design>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RobotDesign } from '../../src/core/types';
import { DESIGNS } from '../../src/robots/designs';
import { CLIPS } from '../../src/robots/motions/clips';
import { CONTACT } from '../../src/robots/motions/contacts';
import { leapTrack, mirrorTrack, spinTrack, type HumanTrack } from '../../src/robots/motions/human';
import { jointSpeedLimits, mirrorMap } from '../../src/robots/motions/library';
import { buildMove, type BuiltMove } from '../../src/robots/motions/moves';
import { retarget, type Retargeted } from '../../src/robots/motions/retarget';
import { robotModel } from '../../src/robots/motions/robot-model';
import { segmentClip, type Segment } from '../../src/robots/motions/segment';
import { ANGLE_LABELS, FLASHY_LABELS, LIBRARY_FORMAT, MOVE_LABELS, type LibraryJson, type MoveLabel } from '../../src/robots/motions/types';
import { LIBRARY_FPS, loadTrack, ROOT } from './load';

/** Moves kept per label and design. */
export const CAPS: Record<MoveLabel, number> = {
  jab: 8, cross: 8, hook: 8, uppercut: 6, overhand: 5,
  front_kick: 6, low_kick: 4, head_kick: 4, side_kick: 5,
  block: 6, guard_idle: 4,
  shuffle_forward: 5, shuffle_back: 5, shuffle_left: 4, shuffle_right: 4,
  walk_forward: 3, walk_back: 2,
  getup_face_down: 5, getup_back: 4, getup_side: 4,
  victory: 3,
  tornado_kick: 4, spinning_back_kick: 2, jump_kick: 2, jumping_knee: 2, superman_punch: 3, spinning_backfist: 4,
  feint_left: 2, feint_right: 2, pivot_left: 3, pivot_right: 3, switch_stance: 3,
  kipup_source: 6,
};

/** A human joint never turns faster than this at 1×: anything above is an IK branch flip. */
const MAX_JOINT_SPEED = 35;

/** Worst striker miss over the strike phase (m): above this the strike was eased across an IK flip. */
const MAX_FIST_PATH_ERR = 0.12;
const MAX_FOOT_PATH_ERR = 0.2;
/** Deepest a collision geom may go below the mat (m): a limb in the floor is a target no servo can hold. */
const MAX_SINK = 0.06;
/** Fighting moves start and end squared up to the opponent (head within this of +x, rad): a jab
 * that finishes turned 90° away leaves the fighter facing the wrong way when it chains the next. */
const MAX_LOOK_AWAY = (40 * Math.PI) / 180;
/** Footwork and guard keep the fighter's level: they chain, so they must end where they began. */
const LEVEL_LABELS = new Set<MoveLabel>(['guard_idle', 'shuffle_forward', 'shuffle_back', 'shuffle_left', 'shuffle_right', 'walk_forward', 'walk_back']);
const MAX_LEVEL_CHANGE = 0.1; // m of pelvis height, end vs start
/** The idle loops all fight long: its feet must stay put (m of planted-foot drift per loop). */
const MAX_GUARD_SLIDE = 0.06;
/** A round or side kick turns the body over: it may land further round (the controller squares up). */
const MAX_LOOK_AWAY_AFTER_KICK = (80 * Math.PI) / 180;
const FACING_LABELS = new Set<MoveLabel>([
  'jab', 'cross', 'hook', 'uppercut', 'overhand', 'front_kick', 'low_kick', 'head_kick', 'side_kick',
  'block', 'guard_idle', 'shuffle_forward', 'shuffle_back', 'shuffle_left', 'shuffle_right', 'walk_forward', 'walk_back',
]);

/** Labels where both sides are worth keeping (lead and rear hooks, left and right blocks...). */
const TWO_SIDED = new Set<MoveLabel>(['hook', 'uppercut', 'overhand', 'block', 'front_kick', 'low_kick', 'head_kick', 'side_kick']);

const FLASHY = new Set<MoveLabel>(FLASHY_LABELS);
const ANGLES = new Set<MoveLabel>(ANGLE_LABELS);
const deg = (x: number) => ((x * 180) / Math.PI).toFixed(0);
/**
 * Flashy strikes are allowed a flight phase, contorted legs and more joint-frames on a limit,
 * and may start bladed (up to 60° off square, a set-up turn), but not sink into the mat, not
 * start turned away and not look away from the target when they land (100°: a spinning back
 * kick spots it over the shoulder).
 */
const FLASHY_GATE = {
  footReach: 0.3, footPath: 0.3, fistReach: 0.08, fistPath: 0.15, kneeReach: 0.2, kneePath: 0.25,
  feet: 0.12, limits: 0.25, startLook: (60 * Math.PI) / 180, impactLook: (100 * Math.PI) / 180, jointSpeed: 45,
  /** A spinning kick's foot travels a 2-3 m arc: where the hip yaw saturates at the chamber it
   * swings wide of the actor's path, and still lands on the target (the reach gate holds that). */
  spinFootPath: 0.55,
  /** A jump starts on the mat and winds up for at least this long (s) ... */
  minWindup: 0.15,
  /** ... and a flashy strike carries the fighter toward the target, not this far away from it (m). */
  maxRetreat: 0.3,
  /** Feints and pivots may end in the crouch they burst from (m of pelvis height). */
  angleLevel: 0.16,
};
const SPIN_KICKS = new Set<MoveLabel>(['tornado_kick', 'spinning_back_kick']);
/** Angle footwork: start squared up; how far round it may end (a pivot turns by design). */
const ANGLE_END_LOOK: Partial<Record<MoveLabel, number>> = {
  feint_left: (70 * Math.PI) / 180, feint_right: (70 * Math.PI) / 180, switch_stance: (45 * Math.PI) / 180,
  pivot_left: (140 * Math.PI) / 180, pivot_right: (140 * Math.PI) / 180,
};

/** Gates for the flashy, angle and kip-up source moves (null: use the standard gates). */
function passesFlashy(seg: Segment, b: BuiltMove): string | null {
  const m = b.metrics;
  if (m.sink > MAX_SINK) return `sinks ${(m.sink * 100).toFixed(0)} cm into the mat`;
  let peak = 0;
  m.jointPeak.forEach((v) => { peak = Math.max(peak, v); });
  if (peak > FLASHY_GATE.jointSpeed) return `a joint jumps at ${peak.toFixed(0)} rad/s (IK branch flip)`;
  if (m.limitRate > FLASHY_GATE.limits) return `${(m.limitRate * 100).toFixed(0)}% of joint-frames on a limit`;
  // A jump or spin starts and ends on the mat (footwork may bounce: boxers are on their toes).
  const onFeet = (c: number) => (c & (CONTACT.FOOT_L | CONTACT.FOOT_R)) !== 0;
  if (FLASHY.has(seg.label) && !onFeet(b.contacts[0])) return 'starts in the air';
  if (!ANGLES.has(seg.label) && !onFeet(b.contacts[b.contacts.length - 1])) return 'ends in the air';
  if (seg.label === 'kipup_source') {
    if (m.footErr > 0.12 || m.fistErr > 0.15) return `limbs off target (feet ${(m.footErr * 100).toFixed(0)} cm, hands ${(m.fistErr * 100).toFixed(0)} cm)`;
    return null;
  }
  if (m.lookAway[0] > FLASHY_GATE.startLook) return `starts looking ${deg(m.lookAway[0])}° away from the opponent`;
  if (ANGLES.has(seg.label)) {
    if (m.footErr > 0.08) return `feet off target by ${(m.footErr * 100).toFixed(1)} cm`;
    const end = ANGLE_END_LOOK[seg.label] ?? MAX_LOOK_AWAY;
    if (m.lookAway[1] > end) return `ends looking ${deg(m.lookAway[1])}° away from the opponent`;
    if (Math.abs(b.json.travel[2]) > FLASHY_GATE.angleLevel) return `pelvis ends ${(b.json.travel[2] * 100).toFixed(0)} cm from where it started`;
    return null;
  }
  if (m.footErr > FLASHY_GATE.feet) return `feet off target by ${(m.footErr * 100).toFixed(1)} cm`;
  if (b.json.flight && b.json.flight[0] < FLASHY_GATE.minWindup * LIBRARY_FPS) return 'leaves the mat before it has wound up';
  if (b.json.travel[0] < -FLASHY_GATE.maxRetreat) return `travels ${(-b.json.travel[0] * 100).toFixed(0)} cm away from its target`;
  const kind = seg.striker?.slice(0, 4);
  const [reach, path] = kind === 'fist' ? [FLASHY_GATE.fistReach, FLASHY_GATE.fistPath] : kind === 'shin' ? [FLASHY_GATE.kneeReach, FLASHY_GATE.kneePath]
    : [FLASHY_GATE.footReach, SPIN_KICKS.has(seg.label) ? FLASHY_GATE.spinFootPath : FLASHY_GATE.footPath];
  if (m.strikerErr > reach) return `striker misses its target by ${(m.strikerErr * 100).toFixed(0)} cm`;
  if (m.strikerPathErr > path) return `striker strays ${(m.strikerPathErr * 100).toFixed(0)} cm off the actor's path mid-strike`;
  if (m.lookAtImpact > FLASHY_GATE.impactLook) return `looks ${deg(m.lookAtImpact)}° away from the target when it lands`;
  if (b.json.target && b.json.target[0] < 0.2) return `lands only ${(b.json.target[0] * 100).toFixed(0)} cm in front`;
  return null;
}

/** Quality gates per family: IK error of the striker at full reach, share of joints on a limit. */
function passes(seg: Segment, b: BuiltMove): string | null {
  if (FLASHY.has(seg.label) || ANGLES.has(seg.label) || seg.label === 'kipup_source') return passesFlashy(seg, b);
  const m = b.metrics;
  const fist = seg.striker?.startsWith('fist');
  const foot = seg.striker?.startsWith('foot');
  if (fist && m.strikerErr > 0.06) return `fist misses its target by ${(m.strikerErr * 100).toFixed(0)} cm`;
  if (foot && m.strikerErr > 0.25) return `foot misses its target by ${(m.strikerErr * 100).toFixed(0)} cm`;
  if (fist && m.strikerPathErr > MAX_FIST_PATH_ERR) return `fist strays ${(m.strikerPathErr * 100).toFixed(0)} cm off the actor's path mid-strike`;
  if (foot && m.strikerPathErr > MAX_FOOT_PATH_ERR) return `foot strays ${(m.strikerPathErr * 100).toFixed(0)} cm off the actor's path mid-strike`;
  if (seg.label.startsWith('getup')) {
    if (m.footErr > 0.12 || m.fistErr > 0.15) return `get-up limbs off target (feet ${(m.footErr * 100).toFixed(0)} cm, hands ${(m.fistErr * 100).toFixed(0)} cm)`;
  } else if (m.footErr > 0.06) return `feet off target by ${(m.footErr * 100).toFixed(1)} cm`;
  if (FACING_LABELS.has(seg.label)) {
    const deg = (x: number) => ((x * 180) / Math.PI).toFixed(0);
    const endMax = foot ? MAX_LOOK_AWAY_AFTER_KICK : MAX_LOOK_AWAY;
    if (m.lookAway[0] > MAX_LOOK_AWAY) return `starts looking ${deg(m.lookAway[0])}° away from the opponent`;
    if (m.lookAway[1] > endMax) return `ends looking ${deg(m.lookAway[1])}° away from the opponent`;
  }
  if (LEVEL_LABELS.has(seg.label) && Math.abs(b.json.travel[2]) > MAX_LEVEL_CHANGE) return `pelvis ends ${(b.json.travel[2] * 100).toFixed(0)} cm from where it started (a rise or a duck, not footwork)`;
  if (seg.label === 'guard_idle' && m.footSlide > MAX_GUARD_SLIDE) return `guard loop drags a planted foot ${(m.footSlide * 100).toFixed(0)} cm`;
  if (m.sink > MAX_SINK) return `sinks ${(m.sink * 100).toFixed(0)} cm into the mat`;
  if (m.limitRate > 0.18) return `${(m.limitRate * 100).toFixed(0)}% of joint-frames on a limit`;
  let peak = 0, which = 0;
  m.jointPeak.forEach((v, j) => { if (v > peak) { peak = v; which = j; } });
  if (peak > MAX_JOINT_SPEED) return `joint ${which} jumps at ${peak.toFixed(0)} rad/s (IK branch flip)`;
  return null;
}

/**
 * Order candidates of one label by `score`: best first, spread over source clips, alternating
 * sides where both matter. Leftovers follow (a second copy from one clip beats an empty label).
 */
function diversify<T extends { clip: string; side: string | null }>(label: MoveLabel, items: T[], score: (x: T) => number): T[] {
  const cap = CAPS[label];
  const perClip = Math.max(2, Math.ceil(cap / 3));
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const out: T[] = [];
  const used = new Map<string, number>();
  const take = (pred: (x: T) => boolean) => {
    for (const x of sorted) {
      if (out.includes(x) || !pred(x)) continue;
      if ((used.get(x.clip) ?? 0) >= perClip) continue;
      out.push(x);
      used.set(x.clip, (used.get(x.clip) ?? 0) + 1);
      return true;
    }
    return false;
  };
  if (TWO_SIDED.has(label)) {
    let side: 'l' | 'r' = 'r';
    while (take((x) => x.side === side) || take(() => true)) side = side === 'l' ? 'r' : 'l';
  } else {
    while (take(() => true));
  }
  for (const x of sorted) if (!out.includes(x)) out.push(x);
  return out;
}

/** Frames retargeted before and after a derived move (the solver settles before it starts). */
const ADJUST_MARGIN = 30;

/** Candidates built per label before choosing: this many × the cap (at least POOL_MIN). */
const POOL_FACTOR = 3;
const POOL_MIN = 12;

/**
 * Design-side score. Strikes: the striker speed the robot can actually deliver (peak speed at
 * the fastest time scale its motors allow, capped), docked for IK error and joints on limits.
 * Everything else: the segmenter's score, docked the same way.
 */
function designScore(seg: Segment, b: BuiltMove): number {
  const m = b.metrics;
  const clean = (1 - Math.min(0.9, m.limitRate * 2)) * (1 - Math.min(0.8, m.footErr * 4));
  if (seg.striker) return b.json.peakSpeed * Math.min(b.json.maxSpeed, 1.25) * clean / (1 + m.strikerErr * 10);
  return seg.score * clean;
}

interface SourceSegments {
  track: HumanTrack;
  segments: Segment[];
}

function segmentAll(): Map<string, SourceSegments> {
  const out = new Map<string, SourceSegments>();
  for (const c of CLIPS) {
    const track = loadTrack(c.id, LIBRARY_FPS);
    out.set(c.id, { track, segments: segmentClip(track, c).segments });
  }
  return out;
}

export interface DesignReport {
  design: string;
  bytes: number;
  gzipBytes: number;
  moves: Array<{ id: string; label: MoveLabel; side: string | null; seconds: number; maxSpeed: number; strikerErrCm: number; strikerPathErrCm: number; fistErrCm: number; footErrCm: number; limitPct: number; slowest: string }>;
  rejected: Array<{ id: string; why: string }>;
  clampPct: Record<string, number>; // joint → % of frames on a limit over the selected moves
}

export function buildDesign(design: RobotDesign, sources: Map<string, SourceSegments>): { json: LibraryJson; report: DesignReport } {
  const model = robotModel(design);
  const limits = jointSpeedLimits(design, model);
  const cache = new Map<string, Retargeted>();
  const retargeted = (clip: string, mirrored: boolean): Retargeted => {
    const key = `${clip}${mirrored ? 'm' : ''}`;
    let r = cache.get(key);
    if (!r) {
      const src = sources.get(clip)!.track;
      r = retarget(mirrored ? mirrorTrack(src) : src, model);
      cache.set(key, r);
    }
    return r;
  };
  /** Derived moves re-aim one strike, so they get their own (short) retarget. */
  const retargetAdjusted = (seg: Segment): Retargeted => {
    const src = sources.get(seg.clip)!.track;
    const turned = seg.turn ? spinTrack(src, seg.turn.from, seg.turn.to, seg.turn.angle, seg.turn.support) : src;
    const lifted = seg.leap ? leapTrack(turned, seg.leap.from, seg.leap.to) : turned;
    const track = seg.mirrored ? mirrorTrack(lifted) : lifted;
    return retarget(track, model, { from: Math.max(0, seg.start - ADJUST_MARGIN), to: seg.end + ADJUST_MARGIN, adjust: seg.adjust ? [seg.adjust] : [] });
  };
  const byLabel = new Map<MoveLabel, Segment[]>();
  for (const { segments } of sources.values()) {
    for (const s of segments) byLabel.set(s.label, [...(byLabel.get(s.label) ?? []), s]);
  }
  const built: BuiltMove[] = [];
  const report: DesignReport = { design: design.id, bytes: 0, gzipBytes: 0, moves: [], rejected: [], clampPct: {} };
  for (const label of MOVE_LABELS) {
    const cap = CAPS[label];
    const pool = diversify(label, byLabel.get(label) ?? [], (x) => x.score).slice(0, Math.max(POOL_MIN, cap * POOL_FACTOR));
    const ok: Array<{ clip: string; side: string | null; seg: Segment; b: BuiltMove; score: number }> = [];
    for (const seg of pool) {
      const r = seg.adjust || seg.leap || seg.turn ? retargetAdjusted(seg) : retargeted(seg.clip, seg.mirrored);
      const b = buildMove(seg, r, limits);
      const why = passes(seg, b);
      if (why) report.rejected.push({ id: seg.id, why });
      else ok.push({ clip: seg.clip, side: seg.side, seg, b, score: designScore(seg, b) });
    }
    for (const x of diversify(label, ok, (y) => y.score).slice(0, cap)) built.push(x.b);
  }
  const nj = model.joints.length;
  const clampFrames = new Float64Array(nj);
  let frames = 0;
  for (const b of built) {
    const J = b.json;
    frames += J.frames;
    for (let i = 0; i < J.frames; i++) {
      for (let j = 0; j < nj; j++) {
        const v = b.q[i * nj + j], jt = model.joints[j];
        if (v - jt.lo < 2e-3 || jt.hi - v < 2e-3) clampFrames[j]++;
      }
    }
    report.moves.push({
      id: J.id, label: J.label, side: J.side, seconds: (J.frames - 1) / LIBRARY_FPS, maxSpeed: J.maxSpeed,
      strikerErrCm: b.metrics.strikerErr * 100, strikerPathErrCm: b.metrics.strikerPathErr * 100, fistErrCm: b.metrics.fistErr * 100, footErrCm: b.metrics.footErr * 100,
      limitPct: b.metrics.limitRate * 100, slowest: b.metrics.slowest,
    });
  }
  model.joints.forEach((j, i) => { report.clampPct[j.name] = frames ? (100 * clampFrames[i]) / frames : 0; });
  const mm = mirrorMap(model);
  const json: LibraryJson = {
    format: LIBRARY_FORMAT,
    design: design.id,
    generated: new Date().toISOString(),
    fps: LIBRARY_FPS,
    joints: model.joints.map((j) => j.name),
    jointSpeedLimit: Array.from(limits, (v) => Math.round(v * 1000) / 1000),
    mirror: { perm: Array.from(mm.perm), sign: Array.from(mm.sign) },
    moves: built.map((b) => b.json),
  };
  return { json, report };
}

function main(): void {
  const args = process.argv.slice(2);
  const showMoves = args.includes('--moves');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const designs = (wanted.length ? wanted : Object.keys(DESIGNS)).map((id) => {
    const d = DESIGNS[id];
    if (!d) throw new Error(`unknown design '${id}'`);
    return d;
  }).filter((d) => d.bodyType === 'biped');
  const t0 = Date.now();
  const sources = segmentAll();
  const nSeg = [...sources.values()].reduce((a, s) => a + s.segments.length, 0);
  console.log(`segmented ${sources.size} clips into ${nSeg} candidate moves in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const outDir = join(ROOT, 'src', 'robots', 'motions', 'data');
  mkdirSync(outDir, { recursive: true });
  for (const d of designs) {
    const t1 = Date.now();
    const { json, report } = buildDesign(d, sources);
    const text = JSON.stringify(json);
    writeFileSync(join(outDir, `${d.id}.json`), text);
    report.bytes = text.length;
    report.gzipBytes = gzipSync(text).length;
    const counts = new Map<string, { n: number; s: number }>();
    for (const m of report.moves) {
      const c = counts.get(m.label) ?? { n: 0, s: 0 };
      counts.set(m.label, { n: c.n + 1, s: c.s + m.seconds });
    }
    console.log(`\n${d.id}: ${report.moves.length} moves, ${(report.bytes / 1024).toFixed(0)} KB (${(report.gzipBytes / 1024).toFixed(0)} KB gzip), ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    console.log('  ' + MOVE_LABELS.map((l) => `${l} ${counts.get(l)?.n ?? 0}`).join(', '));
    const clamps = Object.entries(report.clampPct).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]);
    console.log(`  joints on a limit (% of move frames): ${clamps.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') || 'none ≥ 1%'}`);
    if (report.rejected.length) console.log(`  rejected ${report.rejected.length}: ${report.rejected.slice(0, 8).map((r) => `${r.id} (${r.why})`).join('; ')}${report.rejected.length > 8 ? '; …' : ''}`);
    if (showMoves) {
      for (const m of report.moves) {
        console.log(`    ${m.id.padEnd(30)} ${(m.side ?? '-').padEnd(2)} ${m.seconds.toFixed(2)}s ×${m.maxSpeed.toFixed(2)} (${m.slowest}) striker ${m.strikerErrCm.toFixed(1)}cm path ${m.strikerPathErrCm.toFixed(1)}cm fist ${m.fistErrCm.toFixed(1)}cm foot ${m.footErrCm.toFixed(1)}cm limits ${m.limitPct.toFixed(1)}%`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
