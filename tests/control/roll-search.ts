// Offline roll search (not a test; run with npx tsx): cross-entropy over a design's roll keys (roll-keys.ts),
// the way the iron age's were searched. Each candidate is scored on how soon the robot stands after being laid
// on its back or a side (and, with SD_POSES, from recorded fall endings): it rolls onto the front, then plays
// its face-down clip (getup-speed.ts rollFirst), and the score counts standing, the hand-over to balance, the
// face-down catch and, failing those, how far it rolled.
//   npx tsx tests/control/roll-search.ts <design> [init.json] [out.json] [iterations] [population]
//   SD_STARTS=back:1,back:2,side_l:1,side_r:2   laid-down starts (orientation:seed)
//   SD_POSES=falls.jsonl                       recorded fall endings to start from too (tests/balance/capture-falls.ts;
//                                              the back and side ones of this design)
//   SD_FIXED=1                                 time-based keys only (no `until` / `skip` angles searched)
//   SD_GU='{"rollDone":-0.6}'                  get-up speed table values for the run (getup-speed.ts)
// Prints every iteration and writes the best keys (JSON, roll-keys.ts RollKey[]) to out.json, and each
// iteration's best to out.itN.json. Paste the result into roll-keys.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import type { SimEvent } from '../../src/core/protocol';
import { controllerOf } from '../../src/physics/control';
import { GETUP_DESIGN, GETUP_SPEED } from '../../src/physics/control/getup-speed';
import { ROLL_OVERRIDE, type RollKey } from '../../src/physics/control/roll-keys';
import { makeSim } from './helpers';

const [design = 'pylon', initPath = '', outPath = 'roll-best.json', itersS = '16', popS = '24'] = process.argv.slice(2);
const ITERS = Number(itersS), POP = Number(popS), ELITE = Math.max(3, Math.round(POP / 4));
const STATE = !process.env.SD_FIXED;
const CAP_S = 8;

// The design rolls first whatever its table entry says; SD_GU then sets the rest for the run.
GETUP_SPEED.rollFirst = 1;
for (const d of Object.values(GETUP_DESIGN)) delete (d as Record<string, unknown>).rollFirst;
if (process.env.SD_GU) {
  const o = JSON.parse(process.env.SD_GU) as Record<string, number>;
  Object.assign(GETUP_SPEED, o);
  for (const d of Object.values(GETUP_DESIGN)) for (const k of Object.keys(o)) delete (d as Record<string, unknown>)[k];
}

const LAY: Record<string, [number, number, number, number]> = {
  back: [Math.cos(-Math.PI / 4), 0, Math.sin(-Math.PI / 4), 0],
  side_l: [Math.cos(-Math.PI / 4), Math.sin(-Math.PI / 4), 0, 0],
  side_r: [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0, 0],
};
interface Start { orient: string; seed: number; pose?: { root: number[]; joints: Record<string, number> } }
const starts: Start[] = (process.env.SD_STARTS ?? 'back:1,back:2,side_l:1,side_r:2').split(',').filter(Boolean).map((x) => {
  const [o, s] = x.split(':');
  return { orient: o, seed: Number(s) };
});
if (process.env.SD_POSES) {
  for (const line of readFileSync(process.env.SD_POSES, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = JSON.parse(line) as { design: string; orient: string; root: number[]; joints: Record<string, number> };
    if (p.design === design && p.orient !== 'face_down') starts.push({ orient: p.orient, seed: 1, pose: { root: p.root, joints: p.joints } });
  }
}

// The joints a key sets (the ankles stay at 20°, shoulder yaw at 0), for a roll to the right, and their ranges.
const J = ['hip_pitch_l', 'hip_pitch_r', 'hip_roll_l', 'hip_roll_r', 'hip_yaw_l', 'hip_yaw_r', 'knee_l', 'knee_r', 'shoulder_pitch_l', 'shoulder_pitch_r', 'shoulder_roll_l', 'shoulder_roll_r', 'elbow_l', 'elbow_r', 'waist_pitch', 'waist_yaw'];
const LO: Record<string, number> = { hip_pitch_l: -130, hip_pitch_r: -130, hip_roll_l: -35, hip_roll_r: -60, hip_yaw_l: -45, hip_yaw_r: -60, knee_l: 0, knee_r: 0, shoulder_pitch_l: -175, shoulder_pitch_r: -175, shoulder_roll_l: -35, shoulder_roll_r: -125, elbow_l: -150, elbow_r: -150, waist_pitch: -20, waist_yaw: -90 };
const HI: Record<string, number> = { hip_pitch_l: 20, hip_pitch_r: 20, hip_roll_l: 60, hip_roll_r: 35, hip_yaw_l: 60, hip_yaw_r: 45, knee_l: 140, knee_r: 140, shoulder_pitch_l: 40, shoulder_pitch_r: 40, shoulder_roll_l: 125, shoulder_roll_r: 35, elbow_l: 0, elbow_r: 0, waist_pitch: 60, waist_yaw: 40 };
const K = 3;
const lo: number[] = [], hi: number[] = [], sd0: number[] = [];
for (let k = 0; k < K; k++) {
  lo.push(0.12, 0); hi.push(0.6, 0.4); sd0.push(0.08, 0.06);
  for (const j of J) { lo.push(LO[j]); hi.push(HI[j]); sd0.push(22); }
}
if (STATE) { lo.push(20, 80); hi.push(80, 150); sd0.push(10, 12); }

function decode(x: number[]): RollKey[] {
  const keys: RollKey[] = [];
  for (let k = 0; k < K; k++) {
    const o = k * (2 + J.length);
    const pose: Record<string, number> = { ankle_pitch_l: 20, ankle_pitch_r: 20, shoulder_yaw_l: 0, shoulder_yaw_r: 0 };
    J.forEach((j, i) => { pose[j] = Math.round(x[o + 2 + i]); });
    keys.push({ dur: Number(x[o].toFixed(3)), hold: Number(x[o + 1].toFixed(3)), pose });
  }
  if (STATE) {
    const u1 = Math.round(x[K * (2 + J.length)]);
    const u2 = Math.max(u1 + 20, Math.round(x[K * (2 + J.length) + 1]));
    keys[0] = { ...keys[0], until: u1, skip: u1 - 10 };
    keys[1] = { ...keys[1], until: u2, skip: u2 - 10 };
  }
  return keys;
}

/** Keys (a key may name only the joints it moves) as K full poses. */
function encode(keys: readonly RollKey[]): number[] {
  const acc: Record<string, number> = {};
  const fill: Record<string, number> = { hip_pitch_l: 0, hip_pitch_r: 0, hip_roll_l: 0, hip_roll_r: 0, hip_yaw_l: 0, hip_yaw_r: 0, knee_l: 10, knee_r: 10, shoulder_pitch_l: -30, shoulder_pitch_r: -30, shoulder_roll_l: 0, shoulder_roll_r: 0, elbow_l: -30, elbow_r: -30, waist_pitch: 0, waist_yaw: 0 };
  const x: number[] = [];
  const pick = keys.length <= K ? keys.map((_, i) => i) : Array.from({ length: K }, (_, i) => Math.round((i * (keys.length - 1)) / (K - 1)));
  let at = 0;
  for (let k = 0; k < K; k++) {
    const upto = pick[Math.min(k, pick.length - 1)];
    let dur = 0, hold = 0;
    for (; at <= upto; at++) { Object.assign(acc, keys[at].pose); dur += keys[at].dur; hold = keys[at].hold; }
    x.push(Math.min(0.6, Math.max(0.12, dur || 0.3)), hold);
    for (const j of J) x.push(acc[j] ?? fill[j]);
  }
  if (STATE) x.push(keys[0]?.until ?? 45, keys[1]?.until ?? 115);
  return x;
}

/** One start: stood up (time), handed over to balance, caught face down, or how far it rolled. */
async function trial(st: Start): Promise<{ s: number; tag: string }> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { seed: st.seed });
  const parked = controllerOf(sim.ctx.robots[1]);
  if (parked) parked.enabled = false;
  const { ctx } = sim;
  sim.seconds(0.6);
  sim.release(0);
  const r = ctx.robots[0];
  const c = controllerOf(r)!;
  const a = r.rootQadr;
  const qpos = ctx.data.qpos as Float64Array;
  if (st.pose) {
    for (let i = 0; i < 7; i++) qpos[a + i] = st.pose.root[i];
    qpos[a + 2] += 0.01;
    r.joints.forEach((j, i) => {
      if (st.pose!.joints[j.name] !== undefined) qpos[j.qadr] = st.pose!.joints[j.name];
      r.targets[i] = qpos[j.qadr];
    });
    const v = ctx.data.qvel as Float64Array;
    for (let i = 0; i < 6; i++) v[r.rootDadr + i] = 0;
    for (const j of r.joints) v[j.dadr] = 0;
  } else {
    qpos[a + 2] = 0.28 + 0.04 * ((st.seed - 1) % 3);
    for (let i = 0; i < 4; i++) qpos[a + 3 + i] = LAY[st.orient][i];
  }
  ctx.mj.mj_forward(ctx.model, ctx.data);
  ctx.events.length = 0;
  let fallAt = -1, prone = Infinity, up = Infinity, stable = Infinity, standSince = -1, best = 0;
  let lastPhase = '';
  const n = Math.round(CAP_S / ctx.dt);
  for (let i = 0; i < n; i++) {
    sim.step();
    for (const e of ctx.events as SimEvent[]) {
      if ((e.kind !== 'fall' && e.kind !== 'getup') || e.corner !== 0) continue;
      if (e.kind === 'fall' && fallAt < 0) fallAt = ctx.time;
      if (e.kind === 'getup' && fallAt >= 0 && !Number.isFinite(up)) up = ctx.time - fallAt;
    }
    ctx.events.length = 0;
    if (fallAt < 0) { if (ctx.time > 3) break; continue; }
    const g = c.getUp;
    const ph = g.active ? g.phase : 'up';
    if (lastPhase === 'roll' && ph !== 'roll' && ph !== 'settle' && !Number.isFinite(prone)) prone = ctx.time - fallAt;
    lastPhase = ph;
    const s = c.lastSense;
    if (s && !Number.isFinite(prone)) best = Math.max(best, (1 - s.torsoRot[6]) / 2);
    const standing = !r.down && !g.active && !c.rising && !!s && s.upright > 0.9 && s.pelvisPos[2] > 0.9 * c.stance.pelvisHeight && Math.hypot(s.comVel[0], s.comVel[1]) < 0.3 && c.gait.bothPlanted();
    if (!standing) standSince = -1;
    else if (standSince < 0) standSince = ctx.time;
    else if (ctx.time - standSince >= 0.3) { stable = standSince - fallAt; break; }
  }
  sim.dispose();
  if (Number.isFinite(stable)) return { s: 4 + (CAP_S - stable), tag: `S${stable.toFixed(1)}` };
  if (Number.isFinite(up)) return { s: 3, tag: `U${up.toFixed(1)}` };
  if (Number.isFinite(prone)) return { s: 1.5 + Math.max(0, 3 - prone) / 3, tag: `P${prone.toFixed(1)}` };
  return { s: best, tag: `r${best.toFixed(2)}` };
}

async function evaluate(x: number[]): Promise<{ score: number; detail: string }> {
  ROLL_OVERRIDE.keys = decode(x);
  let score = 0;
  const tags: string[] = [];
  for (const st of starts) {
    const t = await trial(st);
    score += t.s;
    tags.push(t.tag);
  }
  return { score: score / starts.length, detail: tags.join(' ') };
}

// ---------------------------------------------------------------- cross-entropy
let rng = 12345 + design.length;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const gauss = () => { const u = Math.max(1e-9, rand()), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const init = initPath ? encode(JSON.parse(readFileSync(initPath, 'utf8')) as RollKey[]) : lo.map((l, i) => (l + hi[i]) / 2);
let mean = init.slice();
let sd = sd0.slice();
let bestX = init.slice();
let bestR = await evaluate(init);
console.log(`${design}: ${starts.length} starts; init ${bestR.score.toFixed(3)} ${bestR.detail}`);
for (let it = 0; it < ITERS; it++) {
  const pop: Array<{ x: number[]; r: { score: number; detail: string } }> = [];
  for (let p = 0; p < POP; p++) {
    const x = mean.map((m, i) => Math.min(hi[i], Math.max(lo[i], m + sd[i] * gauss())));
    pop.push({ x, r: await evaluate(x) });
  }
  pop.sort((a, b) => b.r.score - a.r.score);
  const el = pop.slice(0, ELITE);
  const alpha = 0.7;
  const mu = mean.map((_, i) => el.reduce((s, e) => s + e.x[i], 0) / ELITE);
  sd = sd.map((v, i) => Math.max(sd0[i] * 0.08, (1 - alpha) * v + alpha * Math.sqrt(el.reduce((s, e) => s + (e.x[i] - mu[i]) ** 2, 0) / ELITE)));
  mean = mean.map((m, i) => (1 - alpha) * m + alpha * mu[i]);
  writeFileSync(outPath.replace(/\.json$/, `.it${it + 1}.json`), JSON.stringify(decode(pop[0].x), null, 1));
  if (pop[0].r.score > bestR.score) {
    bestR = pop[0].r;
    bestX = pop[0].x;
    writeFileSync(outPath, JSON.stringify(decode(bestX), null, 1));
  }
  console.log(`iter ${it + 1}: best ${pop[0].r.score.toFixed(3)} (${pop[0].r.detail}) elite mean ${(el.reduce((s, e) => s + e.r.score, 0) / ELITE).toFixed(3)} | overall ${bestR.score.toFixed(3)} ${bestR.detail}`);
}
const mr = await evaluate(mean);
console.log(`mean: ${mr.score.toFixed(3)} ${mr.detail}`);
if (mr.score > bestR.score) { bestR = mr; bestX = mean; }
writeFileSync(outPath, JSON.stringify(decode(bestX), null, 1));
console.log(`best ${bestR.score.toFixed(3)} ${bestR.detail} → ${outPath}`);
