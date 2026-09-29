// Independent retarget audit: reads the generated library (not the builder's metrics), poses the
// robot with its own forward kinematics at every frame and compares it with the source actor
// mapped into the move frame. Catches what a quality score can hide: flipped axes, wrong
// mirroring, wrist / ankle twist, backwards knees, feet sliding while planted, root drift, wrong
// facing, mislabelled strikes.
//
//   npx tsx tools/mocap/audit.ts                    every generated library
//   npx tsx tools/mocap/audit.ts savate --all       one design, every move (not only flagged)
//   npx tsx tools/mocap/audit.ts --json out.json    machine-readable report
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Vec3 } from '../../src/core/types';
import { DESIGNS } from '../../src/robots/designs';
import { CONTACT, runs } from '../../src/robots/motions/contacts';
import { fr, mirrorTrack, pt, type HumanTrack, type PointId, type Side } from '../../src/robots/motions/human';
import { parseLibrary } from '../../src/robots/motions/library';
import { col, dot, matFromQuat, mulMM, mulMV, norm, rotZ, sub, type Mat3 } from '../../src/robots/motions/math';
import { bodyLowestZ, bodyPoint, fk, newFrames, robotModel, type RobotModel } from '../../src/robots/motions/robot-model';
import type { LibraryJson, Move, MoveLabel } from '../../src/robots/motions/types';
import { loadTrack, ROOT } from './load';

const DEG = 180 / Math.PI;
const SWITCH_M = 0.08; // lead foot this far ahead counts as a stance

/** Flag thresholds. */
export const AUDIT = {
  segmentDeg: 50, // p95 angle between a robot limb segment and the actor's (upper arm, forearm, thigh, shin)
  facingDeg: 25, // p95 pelvis heading difference
  torsoDeg: 30, // p95 chest attitude difference
  footYawDeg: 30, // p95 foot heading difference while planted (ankle twist)
  slideCm: 4, // planted sole drift within one contact run
  floatCm: 3, // planted sole above the floor (median over the run)
  sinkCm: 1.5, // any collision point below the floor
  guardDriftCm: 8, // guard idle root travel
  headingDeg: 45, // a fighter watches the opponent (+x) when a strike starts
  stanceCm: 3, // orthodox: the left (lead) foot at least this far ahead at the start of a fighting move
} as const;

/** Mirrors ARC_LABELS in moves.ts: these strikes' target is taken at impact, the rest at reach. */
const ARCS = new Set<MoveLabel>(['hook', 'overhand', 'low_kick', 'head_kick']);

const FIGHTING = new Set<MoveLabel>(['jab', 'cross', 'hook', 'uppercut', 'overhand', 'block', 'guard_idle']);

export interface MoveAudit {
  id: string;
  label: MoveLabel;
  segDeg: Record<string, number>; // p95 per segment
  facingDeg: number;
  torsoDeg: number;
  footYawDeg: number;
  slideCm: number;
  floatCm: number;
  sinkCm: number;
  stanceCm: number; // left ankle x − right ankle x where the strike phase starts (move frame)
  headingDeg: number; // head heading off +x (toward the opponent) where the strike phase starts
  switchesStance: boolean; // starts orthodox (left foot ahead) and ends with the right foot ahead, or back
  travel: Vec3;
  strikeFwd: number | null; // striker x at reach relative to the pelvis, m
  flags: string[];
}

const p95 = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
};

const angle = (a: Vec3, b: Vec3): number => {
  const na = norm(a), nb = norm(b);
  if (na < 1e-6 || nb < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (na * nb)))) * DEG;
};

const yawOf = (v: Vec3): number => Math.atan2(v[1], v[0]);
const yawDiffDeg = (a: number, b: number): number => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) * DEG;
};

export function auditMove(model: RobotModel, move: Move, track: HumanTrack): MoveAudit {
  const nj = model.joints.length;
  const src = move.source.mirrored ? mirrorTrack(track) : track;
  const Rinv = rotZ(-move.source.align.yaw);
  const H = (id: PointId, i: number): Vec3 => mulMV(Rinv, pt(src, id, move.source.start + i));
  const HR = (id: 'pelvis' | 'chest' | 'footL' | 'footR', i: number): Mat3 => mulMM(Rinv, fr(src, id, move.source.start + i));
  const f = newFrames(model);
  const seg: Record<string, number[]> = {};
  const push = (k: string, v: number) => (seg[k] ??= []).push(v);
  const facing: number[] = [], torso: number[] = [], footYaw: number[] = [];
  const pose = (i: number) => {
    const o = i * 7;
    const r = move.root;
    fk(model, [r[o], r[o + 1], r[o + 2]], matFromQuat([r[o + 3], r[o + 4], r[o + 5], r[o + 6]]), move.q.subarray(i * nj, (i + 1) * nj), f);
  };
  let sink = 0;
  const S: Record<Side, 'L' | 'R'> = { l: 'L', r: 'R' };
  const d = model.dims;
  const ball: Vec3 = [d.footCenterX + 0.6 * d.footHalf[0], 0, -d.soleDepth];
  const soles: Record<Side, Vec3[]> = { l: [], r: [] };
  const soleZ: Record<Side, number[]> = { l: [], r: [] };
  let stance = 0;
  let heading = 0;
  let endStance = 0; // head heading off the move frame's +x (toward the opponent) where the strike starts
  const stanceFrame = Math.min(move.frames - 1, Math.round(move.phases.strike * move.fps)); // the lead at the strike
  for (let i = 0; i < move.frames; i++) {
    pose(i);
    for (const s of ['l', 'r'] as const) {
      const X = S[s];
      const [ua, fa, fi] = model.arms[s].bodies;
      const [th, sh, fo] = model.legs[s].bodies;
      push(`upperarm_${s}`, angle(sub(f.pos[fa], f.pos[ua]), sub(H(`elbow${X}`, i), H(`shoulder${X}`, i))));
      push(`forearm_${s}`, angle(sub(f.pos[fi], f.pos[fa]), sub(H(`fist${X}`, i), H(`elbow${X}`, i))));
      push(`thigh_${s}`, angle(sub(f.pos[sh], f.pos[th]), sub(H(`knee${X}`, i), H(`hip${X}`, i))));
      push(`shin_${s}`, angle(sub(f.pos[fo], f.pos[sh]), sub(H(`ankle${X}`, i), H(`knee${X}`, i))));
      soles[s].push(bodyPoint(f, fo, ball));
      soleZ[s].push(bodyLowestZ(model, f, fo));
      const bit = s === 'l' ? CONTACT.FOOT_L : CONTACT.FOOT_R;
      if (move.contacts[i] & bit) {
        const rf = col(f.rot[fo], 0), hf = col(HR(`foot${X}`, i), 0);
        if (Math.hypot(rf[0], rf[1]) > 0.5 && Math.hypot(hf[0], hf[1]) > 0.5) footYaw.push(yawDiffDeg(yawOf(rf), yawOf(hf)));
      }
    }
    const lying = (move.contacts[i] & (CONTACT.HIPS | CONTACT.CHEST)) !== 0;
    const Rp = f.rot[model.pelvis], Hp = HR('pelvis', i);
    if (!lying && Math.hypot(Rp[0], Rp[3]) > 0.5 && Math.hypot(Hp[0], Hp[3]) > 0.5) facing.push(yawDiffDeg(yawOf(col(Rp, 0)), yawOf(col(Hp, 0))));
    const Rt = f.rot[model.torso], Ht = HR('chest', i);
    torso.push(Math.max(angle(col(Rt, 0), col(Ht, 0)), angle(col(Rt, 2), col(Ht, 2))));
    for (let b = 0; b < model.bodies.length; b++) sink = Math.max(sink, -bodyLowestZ(model, f, b));
    if (i === move.frames - 1) endStance = f.pos[model.legs.l.bodies[2]][0] - f.pos[model.legs.r.bodies[2]][0];
    if (i === stanceFrame) {
      stance = f.pos[model.legs.l.bodies[2]][0] - f.pos[model.legs.r.bodies[2]][0];
      heading = yawDiffDeg(yawOf(col(f.rot[model.head], 0)), 0);
    }
  }
  // Planted feet: drift of the ball of the foot within each contact run, and height off the floor.
  let slide = 0, float = 0;
  for (const s of ['l', 'r'] as const) {
    const bit = s === 'l' ? CONTACT.FOOT_L : CONTACT.FOOT_R;
    for (const [a, b] of runs(move.contacts, bit)) {
      if (b - a < 4) continue;
      const p0 = soles[s][a];
      for (let i = a; i < b; i++) slide = Math.max(slide, Math.hypot(soles[s][i][0] - p0[0], soles[s][i][1] - p0[1]));
      const zs = soleZ[s].slice(a, b).sort((x, y) => x - y);
      float = Math.max(float, zs[Math.floor(zs.length / 2)]);
    }
  }
  let strikeFwd: number | null = null;
  const landsAt = ARCS.has(move.label) ? move.impact : move.reach; // where Move.target is taken
  if (move.striker && landsAt !== null) {
    const i = Math.min(move.frames - 1, Math.round(landsAt * move.fps));
    pose(i);
    const b = model.bodyIndex.get(move.striker)!;
    strikeFwd = f.pos[b][0] - f.pos[model.pelvis][0]; // move frame: x toward the opponent
  }
  const segDeg: Record<string, number> = {};
  for (const [k, v] of Object.entries(seg)) segDeg[k] = p95(v);
  const a: MoveAudit = {
    id: move.id, label: move.label, segDeg,
    facingDeg: p95(facing), torsoDeg: p95(torso), footYawDeg: p95(footYaw),
    slideCm: slide * 100, floatCm: float * 100, sinkCm: sink * 100, stanceCm: stance * 100, headingDeg: heading,
    switchesStance: Math.abs(stance) > SWITCH_M && Math.abs(endStance) > SWITCH_M && Math.sign(stance) !== Math.sign(endStance),
    travel: move.travel, strikeFwd, flags: [],
  };
  const flag = (c: boolean, msg: string) => c && a.flags.push(msg);
  // A derived low kick deliberately lowers the source roundhouse: its kicking leg differs by design.
  const derivedLeg = move.label === 'low_kick' && move.id.endsWith('L') && move.striker ? move.striker.slice(-1) : null;
  for (const [k, v] of Object.entries(segDeg)) {
    if (derivedLeg && (k === `thigh_${derivedLeg}` || k === `shin_${derivedLeg}`)) continue;
    flag(v > AUDIT.segmentDeg, `${k} off the actor by ${v.toFixed(0)}° (p95)`);
  }
  flag(a.facingDeg > AUDIT.facingDeg, `pelvis heading off by ${a.facingDeg.toFixed(0)}°`);
  flag(a.torsoDeg > AUDIT.torsoDeg, `chest attitude off by ${a.torsoDeg.toFixed(0)}°`);
  flag(a.footYawDeg > AUDIT.footYawDeg, `planted foot twisted ${a.footYawDeg.toFixed(0)}° from the actor's`);
  flag(a.slideCm > AUDIT.slideCm, `planted foot slides ${a.slideCm.toFixed(1)} cm`);
  flag(a.floatCm > AUDIT.floatCm, `planted foot floats ${a.floatCm.toFixed(1)} cm`);
  flag(a.sinkCm > AUDIT.sinkCm, `sinks ${a.sinkCm.toFixed(1)} cm into the floor`);
  flag(move.label === 'guard_idle' && Math.hypot(move.travel[0], move.travel[1]) * 100 > AUDIT.guardDriftCm, `guard drifts ${(Math.hypot(move.travel[0], move.travel[1]) * 100).toFixed(0)} cm`);
  flag((FIGHTING.has(move.label) || move.striker !== null) && heading > AUDIT.headingDeg, `looks ${heading.toFixed(0)}° away from the opponent at the strike`);
  flag(FIGHTING.has(move.label) && a.stanceCm < AUDIT.stanceCm, `not orthodox at the strike (left foot ${a.stanceCm.toFixed(0)} cm ahead)`);
  flag(strikeFwd !== null && strikeFwd < 0.1, `striker only ${((strikeFwd ?? 0) * 100).toFixed(0)} cm in front of the pelvis where it lands`);
  const tr = move.travel;
  const dir = move.label.match(/^(shuffle|walk)_(forward|back|left|right)$/)?.[2];
  if (dir) {
    const want: Record<string, [number, number]> = { forward: [1, 0], back: [-1, 0], left: [0, 1], right: [0, -1] };
    const [wx, wy] = want[dir];
    const along = tr[0] * wx + tr[1] * wy, across = Math.abs(tr[0] * wy - tr[1] * wx);
    flag(along < 0.08 || across > along, `travels [${tr[0].toFixed(2)}, ${tr[1].toFixed(2)}] m for '${dir}'`);
  }
  return a;
}

export function auditLibrary(designId: string): MoveAudit[] {
  const json = JSON.parse(readFileSync(join(ROOT, 'src', 'robots', 'motions', 'data', `${designId}.json`), 'utf8')) as LibraryJson;
  const lib = parseLibrary(json);
  const model = robotModel(DESIGNS[designId]);
  return lib.moves.map((m) => auditMove(model, m, loadTrack(m.source.clip)));
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const ji = args.indexOf('--json');
  const jsonOut = ji >= 0 ? args[ji + 1] : null;
  const ids = args.filter((a, i) => !a.startsWith('--') && (ji < 0 || i !== ji + 1));
  const dataDir = join(ROOT, 'src', 'robots', 'motions', 'data');
  const designs = ids.filter((a) => DESIGNS[a]).length ? ids.filter((a) => DESIGNS[a]) : readdirSync(dataDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const report: Record<string, MoveAudit[]> = {};
  for (const id of designs) {
    const res = auditLibrary(id);
    report[id] = res;
    const flagged = res.filter((r) => r.flags.length);
    const worst = (k: keyof MoveAudit) => Math.max(...res.map((r) => r[k] as number));
    console.log(`\n${id}: ${res.length} moves, ${flagged.length} flagged | worst: facing ${worst('facingDeg').toFixed(0)}°, chest ${worst('torsoDeg').toFixed(0)}°, foot yaw ${worst('footYawDeg').toFixed(0)}°, slide ${worst('slideCm').toFixed(1)} cm, float ${worst('floatCm').toFixed(1)} cm, sink ${worst('sinkCm').toFixed(1)} cm`);
    for (const r of all ? res : flagged) {
      const segs = Object.entries(r.segDeg).map(([k, v]) => `${k.replace(/arm|_/g, (m) => (m === '_' ? '' : 'a'))} ${v.toFixed(0)}`).join(' ');
      console.log(`  ${r.id.padEnd(30)} ${r.flags.join('; ') || 'ok'}${all ? `  [${segs}] face ${r.facingDeg.toFixed(0)} chest ${r.torsoDeg.toFixed(0)} footYaw ${r.footYawDeg.toFixed(0)} slide ${r.slideCm.toFixed(1)} float ${r.floatCm.toFixed(1)} stance ${r.stanceCm.toFixed(0)} head ${r.headingDeg.toFixed(0)}${r.switchesStance ? ' SWITCH' : ''}` : ''}`);
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
