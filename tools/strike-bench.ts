// Strike bench (docs/design/strike-power.md §5.1): repeatable, fixed-seed measurements of what strikes
// deliver and what the damage model does with them. The audit's scratch probes, promoted.
//
//   matrix   each design throws each strike at a standing mirror opponent from three spacings
//            (sweet: the tactics' own throw point; long: 0.9 of the strike's range; air: out of reach)
//            with two seeds: limb peak speed and contact speed (and its share of the peak), time to
//            contact, the strike episode's impulse / absorbed work / peak force, effective mass,
//            the target's Δv, pelvis and torso yaw peaks against contact (the kinetic chain), joint
//            speed and torque use along the chain, and the damage model's verdict: joint-load channel
//            peaks per joint (× rating) on striker and victim, health lost by channel and role, dents,
//            and head pops (the blow's impact impulse against the target's mount, DAMAGE_TUNING.mountScale)
//   contact  one strike into a standing target at fixed placements (the impact probe): the force
//            profile of the striking surface, contact time, penetration, impulse in the first 10 ms
//            and over the episode, target Δv at 50 / 150 ms, torso spin, and the same damage verdict
//   gantry   the robot hung on its gantry, controller off, joint targets stepped, servo damping as
//            built and removed: the hardware ceiling of fist and foot speed (no legs, no step)
//   meff     effective mass at the fist and shin along the strike line, from the mass matrix (all
//            joints limp, the striking limb rigid, the whole body rigid)
//
// Calibration hook (stage 5b): --tune DAMAGE_TUNING.key=value[,key=value] overrides any damage
// threshold for a run (src/physics/damage/constants.ts), so before/after tables use the same seeds.
// Head pops were calibrated on 2026-10-20 (mountScale); the joint-load ratings are still labelled
// assumptions. Fight-level rates (head pops per fight, injury share) come from tools/fight-metrics.ts
// with SD_TUNE='DAMAGE_TUNING.key=value'.
//
// usage:
//   npx tsx tools/strike-bench.ts --mode matrix|contact|gantry|meff|all [--designs firecracker,savate]
//     [--skills jab,cross,hook,uppercut,front_kick,low_kick,head_kick] [--spacings sweet,long,air]
//     [--seeds 1,2] [--target savate] [--aggression 1] [--jobs 2] [--out bench.json]
//     [--tune DAMAGE_TUNING.gearBreak=1.8]
import loadMujoco from '@mujoco/mujoco';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SimEvent, TargetZone } from '../src/core/protocol';
import { controllerOf } from '../src/physics/control';
import type { SkillId } from '../src/physics/control/skills/types';
import { DAMAGE_TUNING, damageState, type DamageLedger } from '../src/physics/damage';
import { breakImpulseNs } from '../src/physics/damage/detach';
import type { RobotRuntime, SimContext } from '../src/physics/sim-context';
import { SYSTEMS } from '../src/physics/systems';
import { motorSystem } from '../src/physics/systems/motors';
import { comPos, makeSim } from '../tests/control/helpers';
import { surfaceOf } from './damage-metrics';

type V3 = [number, number, number];
type Impact = Extract<SimEvent, { kind: 'impact' }>;

const MODERN = ['firecracker', 'savate', 'haymaker', 'pylon'];
const STRIKES = ['jab', 'cross', 'hook', 'uppercut', 'front_kick', 'low_kick', 'head_kick'];
const ZONE: Record<string, TargetZone> = { jab: 'head', cross: 'head', hook: 'head', uppercut: 'head', overhand: 'head', front_kick: 'torso', low_kick: 'left_leg', head_kick: 'head' };
/** Kicks thrown "sweet" sit closer in their range than punches (the tactics' throw points). */
const SWEET: Record<string, number> = { front_kick: 0.45, head_kick: 0.45 };
const SETTLE_S = 0.5;
const STAND_S = 1.2;
const TRIAL_MAX_S = 4;
const AFTER_END_S = 0.6;
/** Joints whose episode peak passed this share of a rating are listed in a trial's verdict. */
const LIST_PEAK = 0.3;
/**
 * Placements of the contact probe around the strike's own throw point (target relative to the
 * striker at the origin, facing it): square on, then a little off-line each way.
 */
const PLACES = [
  { dx: 0, y: 0, yaw: Math.PI },
  { dx: 0.05, y: 0.12, yaw: Math.PI - 0.15 },
  { dx: -0.05, y: -0.12, yaw: Math.PI + 0.15 },
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** --tune DAMAGE_TUNING.key=value,...: the calibration hook. Nested keys use dots (failLoss.seize). */
export function applyTune(spec: string): string[] {
  const done: string[] = [];
  for (const item of spec.split(',').filter(Boolean)) {
    const [path, raw] = item.split('=');
    const keys = path.replace(/^DAMAGE_TUNING\./, '').split('.');
    let obj = DAMAGE_TUNING as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
    const last = keys[keys.length - 1];
    if (typeof obj?.[last] !== 'number') throw new Error(`--tune: DAMAGE_TUNING.${keys.join('.')} is not a number`);
    obj[last] = Number(raw);
    done.push(`${keys.join('.')}=${raw}`);
  }
  return done;
}

// ---------------------------------------------------------------- the damage verdict of one trial

interface JointPeak { joint: string; gear: number; stop: number; bearing: number; role: string }

interface Verdict {
  /** Health lost by channel and role, per robot, over the trial. */
  lost: [Record<string, number>, Record<string, number>];
  /** The injuries booked during the trial: joint, cause, failure, severity, role, loss, by. */
  log: [unknown[], unknown[]];
  failures: [Record<string, number>, Record<string, number>];
  dents: [number, number];
  peaks: [JointPeak[], JointPeak[]];
  /** Parts knocked off during the trial, with the blow that did it (DamageLedger.detaches). */
  detaches: [unknown[], unknown[]];
}

function ledgerCopy(ctx: SimContext): [DamageLedger, DamageLedger] {
  const st = damageState(ctx);
  return [structuredClone(st.robots[0].ledger), structuredClone(st.robots[1].ledger)];
}

function verdict(ctx: SimContext, before: [DamageLedger, DamageLedger]): Verdict {
  const st = damageState(ctx);
  const lost: Verdict['lost'] = [{}, {}];
  const failures: Verdict['failures'] = [{}, {}];
  const peaks: Verdict['peaks'] = [[], []];
  const dents: Verdict['dents'] = [0, 0];
  const log: Verdict['log'] = [[], []];
  const detaches: Verdict['detaches'] = [[], []];
  for (const c of [0, 1] as const) {
    const now = st.robots[c].ledger, was = before[c];
    detaches[c] = now.detaches.slice(was.detaches.length);
    const seen = new Set(was.log.map((e) => JSON.stringify(e)));
    log[c] = now.log.filter((e) => !seen.has(JSON.stringify(e)));
    for (const [cause, byRole] of Object.entries(now.jointLoss)) {
      for (const [role, v] of Object.entries(byRole)) {
        const d = v - (was.jointLoss as Record<string, Record<string, number>>)[cause][role];
        if (d > 1e-9) lost[c][`${cause}.${role}`] = +d.toFixed(4);
      }
    }
    for (const [k, v] of Object.entries(now.failures)) {
      const d = v - (was.failures as Record<string, number>)[k];
      if (d) failures[c][k] = d;
    }
    dents[c] = now.dents.count - was.dents.count;
    st.robots[c].mech.forEach((m, i) => {
      if (Math.max(...m.peak) < LIST_PEAK) return;
      peaks[c].push({ joint: st.robots[c].robot.joints[i].name, gear: +m.peak[0].toFixed(2), stop: +m.peak[1].toFixed(2), bearing: +m.peak[2].toFixed(2), role: m.role });
    });
  }
  return { lost, log, failures, dents, peaks, detaches };
}

function strikeEvent(e: Impact): Record<string, unknown> {
  return {
    part: e.part, by: e.strikerPart, surface: surfaceOf(e.strikerPart), speed: +e.speed.toFixed(2), impulseNs: +e.impulseNs.toFixed(1),
    workJ: +(e.workJ ?? 0).toFixed(1), energyJ: +e.energyJ.toFixed(1), peakKN: +((e.peakForceN ?? 0) / 1000).toFixed(2), clean: !!e.clean, push: !!e.push,
    dent: e.dent ? `${e.dent.mode} ${(e.dent.depthM * 1000).toFixed(1)} mm` : null,
  };
}

// ---------------------------------------------------------------- matrix and contact trials

const CHAIN_ARM = (s: string) => ['waist_yaw', 'waist_pitch', `shoulder_pitch_${s}`, `shoulder_roll_${s}`, `shoulder_yaw_${s}`, `elbow_${s}`];
const CHAIN_LEG = (s: string) => ['waist_yaw', 'waist_pitch', `hip_yaw_${s}`, `hip_roll_${s}`, `hip_pitch_${s}`, `knee_${s}`];

function yawOf(xmat: Float64Array, b: number): number {
  return Math.atan2(xmat[b * 9 + 3], xmat[b * 9]);
}

async function strikeRange(design: string, id: string): Promise<{ lo: number; hi: number; known: boolean }> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { systems: SYSTEMS });
  sim.seconds(0.6);
  const c = controllerOf(sim.ctx.robots[0])!;
  const def = c.skillFor(id as SkillId);
  const out = def ? (() => { const [lo, hi] = def.range(c.geo); return { lo, hi, known: true }; })() : { lo: 0, hi: 0, known: false };
  sim.dispose();
  return out;
}

interface TrialSpec {
  design: string;
  target: string;
  id: string;
  seed: number;
  aggression: number;
  place: { x: number; y: number; yaw: number };
  profile: boolean; // record the striking surface's force profile (contact mode)
}

/** Throws one strike at a standing target and measures it (the audit's trial, with the damage verdict). */
async function trial(spec: TrialSpec): Promise<Record<string, unknown>> {
  const t = spec;
  const sim = await makeSim({ design: t.design, x: 0, y: 0, yaw: 0 }, { design: t.target, ...t.place }, { systems: SYSTEMS, seed: t.seed });
  const { ctx } = sim;
  const [me, opp] = ctx.robots;
  sim.seconds(SETTLE_S);
  sim.release(0);
  sim.release(1);
  sim.seconds(STAND_S, () => { ctx.events.length = 0; });
  const c = controllerOf(me)!;
  const def = c.skillFor(t.id as SkillId);
  if (!def || !c.startSkill(def, ZONE[t.id] ?? 'head', t.aggression)) {
    sim.dispose();
    return { ...t, error: def ? 'start failed' : 'no such skill' };
  }
  const before = ledgerCopy(ctx);
  const oppHead = damageState(ctx).robots[opp.corner].parts.get('head');
  const headNeedNs = oppHead ? breakImpulseNs(damageState(ctx), oppHead) : null;
  const side = def.side ?? 'l';
  const kick = def.kind === 'leg';
  const chain = (kick ? CHAIN_LEG(side) : CHAIN_ARM(side)).map((n) => me.jointIndex.get(n)).filter((i): i is number => i !== undefined);
  let tips = (kick ? [`foot_${side}`, `shin_${side}`] : [`fist_${side}`]).map((p) => me.parts.get(p)!.body);
  let strikerGeoms = new Set<number>((kick ? [`foot_${side}`, `shin_${side}`] : [`fist_${side}`]).flatMap((p) => me.parts.get(p)!.geoms));
  let strikersKnown = false;
  const oppGeoms = new Set<number>([...opp.parts.values()].flatMap((p) => p.geoms));
  const xpos = () => ctx.data.xpos as Float64Array;
  const xmat = () => ctx.data.xmat as Float64Array;
  const dt = ctx.dt;
  const dir0 = (() => { const a = comPos(ctx, me), b = comPos(ctx, opp); const n = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / n, (b[1] - a[1]) / n]; })();
  const comD = Math.hypot(comPos(ctx, opp)[0] - comPos(ctx, me)[0], comPos(ctx, opp)[1] - comPos(ctx, me)[1]);
  const prevTip = new Map<number, V3>();
  let prevOpp = comPos(ctx, opp) as V3;
  let prevPel = yawOf(xmat(), me.rootBody), prevTor = yawOf(xmat(), me.parts.get('torso')!.body);
  const series: Array<{ t: number; v: number; along: number; oppAlong: number; pel: number; tor: number; force: number; pen: number }> = [];
  const jointPk = chain.map(() => ({ w: 0, tau: 0 }));
  const strikes: Impact[] = [];
  const pushes: Impact[] = [];
  let tLanded = -1, ended = -1, fell = false;
  const z0 = comPos(ctx, me)[2];
  const t0 = ctx.time;
  for (let k = 0; k < Math.round(TRIAL_MAX_S / dt); k++) {
    sim.step();
    const now = ctx.time - t0;
    for (const e of ctx.events) {
      if (e.kind === 'impact' && e.striker === me.corner && e.victim === opp.corner) (e.push ? pushes : strikes).push(e);
      if (e.kind === 'fall' && e.corner === me.corner) fell = true;
    }
    ctx.events.length = 0;
    const run = c.skills.run;
    // The runner names the striking parts once the strike is under way (a mocap cross may use either hand).
    if (run?.strikers && !strikersKnown) {
      strikersKnown = true;
      const sp = run.strikers.filter((p: string) => /fist|foot|shin/.test(p) && me.parts.has(p));
      if (sp.length) {
        tips = sp.map((p: string) => me.parts.get(p)!.body);
        strikerGeoms = new Set(sp.flatMap((p: string) => me.parts.get(p)!.geoms));
        prevTip.clear();
      }
    }
    if (run?.landed && tLanded < 0) tLanded = now;
    let v = 0, along = 0;
    for (const b of tips) {
      const p: V3 = [xpos()[b * 3], xpos()[b * 3 + 1], xpos()[b * 3 + 2]];
      const q = prevTip.get(b);
      if (q) {
        const vv: V3 = [(p[0] - q[0]) / dt, (p[1] - q[1]) / dt, (p[2] - q[2]) / dt];
        const s = Math.hypot(vv[0], vv[1], vv[2]);
        if (s > v) { v = s; along = vv[0] * dir0[0] + vv[1] * dir0[1]; }
      }
      prevTip.set(b, p);
    }
    const oc = comPos(ctx, opp) as V3;
    const oppAlong = ((oc[0] - prevOpp[0]) * dir0[0] + (oc[1] - prevOpp[1]) * dir0[1]) / dt;
    prevOpp = oc;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const py = yawOf(xmat(), me.rootBody), ty = yawOf(xmat(), me.parts.get('torso')!.body);
    // Yaw from a tipped-over body is degenerate (falls read thousands of rad/s): count it only upright.
    const upright = (b: number) => xmat()[b * 9 + 8] > 0.7;
    const pel = upright(me.rootBody) ? wrap(py - prevPel) / dt : 0;
    const tor = upright(me.parts.get('torso')!.body) ? wrap(ty - prevTor) / dt : 0;
    prevPel = py;
    prevTor = ty;
    let force = 0, pen = 0;
    if (t.profile) {
      const cons = ctx.data.contact;
      const efc = ctx.data.efc_force as Float64Array;
      for (let i = 0; i < ctx.data.ncon; i++) {
        const cc = cons.get(i);
        if ((strikerGeoms.has(cc.geom1) && oppGeoms.has(cc.geom2)) || (strikerGeoms.has(cc.geom2) && oppGeoms.has(cc.geom1))) {
          if (cc.efc_address >= 0) force += Math.max(0, efc[cc.efc_address]);
          pen = Math.max(pen, -cc.dist);
        }
        cc.delete();
      }
      cons.delete();
    }
    series.push({ t: now, v, along, oppAlong, pel, tor, force, pen });
    chain.forEach((i, n) => {
      const j = me.joints[i];
      jointPk[n].w = Math.max(jointPk[n].w, Math.abs((ctx.data.qvel as Float64Array)[j.dadr]));
      jointPk[n].tau = Math.max(jointPk[n].tau, Math.abs((ctx.data.actuator_force as Float64Array)[j.act]));
    });
    if (!run && ended < 0) ended = now;
    if (comPos(ctx, me)[2] < 0.55 * z0) fell = true;
    if (ended >= 0 && now > ended + AFTER_END_S) break;
  }
  const v0 = verdict(ctx, before);
  const meMass = ctx.model.body_subtreemass[me.rootBody] as number;
  const oppMass = ctx.model.body_subtreemass[opp.rootBody] as number;
  const chainMeta = chain.map((i, n) => ({
    joint: me.joints[i].name, motor: me.joints[i].motor.id,
    peakVFrac: +(jointPk[n].w / me.joints[i].motor.noLoadSpeedRadS).toFixed(2),
    peakTauFrac: +(jointPk[n].tau / me.joints[i].motor.stallTorqueNm).toFixed(2),
  }));
  sim.dispose();
  // Analysis: contact = the first strike episode's first touch (or the runner's landing).
  const first = strikes[0];
  const tC = tLanded >= 0 ? tLanded : -1;
  const iC = tC >= 0 ? series.findIndex((x) => x.t >= tC - 1e-9) : -1;
  const pre = series.slice(0, iC > 0 ? iC : series.length);
  const peak = pre.reduce((m, x) => (x.v > m.v ? x : m), { v: 0, t: 0, along: 0 } as { v: number; t: number; along: number });
  // The striking surface's speed just before it touched (the fastest of the last few samples).
  const vC = iC > 0 ? Math.max(...series.slice(Math.max(0, iC - 3), iC).map((x) => x.v)) : NaN;
  const after = iC > 0 ? series[Math.min(series.length - 1, iC + 30)] : null;
  const dvTip = iC > 0 && after ? series[iC - 1].along - after.along : NaN;
  const meff = first && dvTip > 0.1 ? first.impulseNs / dvTip : NaN;
  const oppDv = (ms: number) => {
    if (iC <= 0) return NaN;
    const base = series.slice(Math.max(0, iC - 20), iC).reduce((s, x) => s + x.oppAlong, 0) / 20;
    return Math.max(...series.slice(iC, iC + ms).map((x) => x.oppAlong)) - base;
  };
  const yawPk = (k: 'pel' | 'tor') => pre.concat(series.slice(iC > 0 ? iC : 0, (iC > 0 ? iC : 0) + 30)).reduce((m, x) => (Math.abs(x[k]) > Math.abs(m.v) ? { v: x[k], t: x.t } : m), { v: 0, t: 0 });
  const pel = yawPk('pel'), tor = yawPk('tor');
  const out: Record<string, unknown> = {
    design: t.design, target: t.target, id: t.id, seed: t.seed, place: t.place, comD: +comD.toFixed(2), mocap: !!def.clip,
    landed: !!first, end: c.skills.lastEnd, fell,
    tContact: tC >= 0 ? +tC.toFixed(3) : null,
    vPeak: +peak.v.toFixed(2), vPeakBeforeContactS: tC >= 0 ? +(tC - peak.t).toFixed(3) : null,
    vContact: +vC.toFixed(2), contactShareOfPeak: peak.v > 0 && vC > 0 ? +(vC / peak.v).toFixed(2) : null,
    meffKg: +meff.toFixed(2), oppDv50: +oppDv(50).toFixed(3), oppDv150: +oppDv(150).toFixed(3),
    pelvisYawPeak: { radS: +pel.v.toFixed(1), beforeContactS: tC >= 0 ? +(tC - pel.t).toFixed(3) : null },
    torsoYawPeak: { radS: +tor.v.toFixed(1), beforeContactS: tC >= 0 ? +(tC - tor.t).toFixed(3) : null },
    meMass: +meMass.toFixed(1), oppMass: +oppMass.toFixed(1),
    strike: first ? strikeEvent(first) : null,
    strikes: strikes.length, pushes: pushes.length, pushImpulseNs: +pushes.reduce((a, e) => a + e.impulseNs, 0).toFixed(1),
    damage: {
      striker: { lost: v0.lost[0], log: v0.log[0], failures: v0.failures[0], dents: v0.dents[0], peaks: v0.peaks[0] },
      victim: { lost: v0.lost[1], log: v0.log[1], failures: v0.failures[1], dents: v0.dents[1], peaks: v0.peaks[1], headNeedNs: headNeedNs === null ? null : +headNeedNs.toFixed(1), detaches: v0.detaches[1] },
    },
    chain: chainMeta,
  };
  if (t.profile && iC > 0) {
    const touch = series.findIndex((x) => x.force > 0);
    const prof = touch >= 0 ? series.slice(touch, touch + 40) : [];
    const lastTouch = prof.reduce((m, x, k) => (x.force > 0 ? k : m), -1);
    out.contact = {
      ms: lastTouch + 1,
      peakKN: +(Math.max(0, ...prof.map((x) => x.force)) / 1000).toFixed(2),
      maxPenMm: +(Math.max(0, ...prof.map((x) => x.pen)) * 1000).toFixed(1),
      impulse10msNs: +prof.slice(0, 10).reduce((a, x) => a + x.force * dt, 0).toFixed(1),
      profileN: prof.map((x) => Math.round(x.force)),
    };
  }
  return out;
}

async function matrix(design: string, skills: string[], spacings: string[], seeds: number[], aggression: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const id of skills) {
    const range = await strikeRange(design, id);
    if (!range.known) continue;
    for (const spacing of spacings) {
      const share = spacing === 'long' ? 0.9 : SWEET[id] ?? 0.6;
      const d = spacing === 'air' ? 3 : range.lo + share * (range.hi - range.lo);
      for (const seed of spacing === 'air' ? seeds.slice(0, 1) : seeds) {
        const r = await trial({ design, target: design, id, seed, aggression, place: { x: d, y: 0, yaw: Math.PI }, profile: false });
        out.push({ ...r, spacing, range: [+range.lo.toFixed(2), +range.hi.toFixed(2)] });
        console.error(`[matrix] ${design} ${id} ${spacing} s${seed}: ${r.landed ? `contact ${r.vContact} m/s (peak ${r.vPeak}), ${(r.strike as { impulseNs: number } | null)?.impulseNs} N·s, work ${(r.strike as { workJ: number } | null)?.workJ} J` : `no contact (${r.end})`}`);
      }
    }
  }
  return out;
}

async function contact(design: string, target: string, skills: string[], aggression: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const id of skills) {
    const range = await strikeRange(design, id);
    if (!range.known) continue;
    const d = range.lo + (SWEET[id] ?? 0.6) * (range.hi - range.lo);
    for (const p of PLACES) {
      const place = { x: d + p.dx, y: p.y, yaw: p.yaw };
      const r = await trial({ design, target, id, seed: 1, aggression, place, profile: true });
      out.push({ ...r, mode: 'contact' });
      console.error(`[contact] ${design}>${target} ${id} @${place.x.toFixed(2)},${place.y}: ${r.landed ? JSON.stringify(r.contact) : 'no contact'}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- gantry ceiling and effective mass

interface Throw { name: string; tip: string; start: Record<string, number>; end: Record<string, number> }
const THROWS: Throw[] = [
  { name: 'straight arm only', tip: 'fist_r', start: {}, end: { shoulder_pitch_r: -1.6, elbow_r: -0.15, shoulder_yaw_r: 0 } },
  { name: 'straight arm + waist', tip: 'fist_r', start: { waist_yaw: -0.25 }, end: { shoulder_pitch_r: -1.6, elbow_r: -0.15, shoulder_yaw_r: 0, waist_yaw: 0.6 } },
  { name: 'hook arm + waist', tip: 'fist_r', start: { shoulder_pitch_r: -1.3, shoulder_roll_r: -1.2, elbow_r: -1.5, waist_yaw: -0.3 }, end: { shoulder_pitch_r: -1.5, shoulder_roll_r: -1.2, elbow_r: -1.5, shoulder_yaw_r: 0.9, waist_yaw: 0.7 } },
  { name: 'front snap', tip: 'foot_r', start: { hip_pitch_r: -1.4, knee_r: 2.0 }, end: { hip_pitch_r: -1.6, knee_r: 0.1 } },
  { name: 'leg swing (hip + knee)', tip: 'shin_r', start: { hip_pitch_r: 0.25, knee_r: 1.2 }, end: { hip_pitch_r: -1.5, knee_r: 0.15 } },
];

/** Robot on its gantry, controller off, targets stepped: dampScale 1 = the servo as built, 0.02 ≈ torque mode. */
async function gantry(design: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const th of THROWS) {
    for (const damp of [1, 0.02]) {
      const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { systems: [motorSystem] });
      const { ctx } = sim;
      const r = ctx.robots[0];
      const stance = (rr: RobotRuntime) => Float64Array.from(rr.joints, (j) => rr.design.stance[j.name] ?? 0);
      for (const rr of ctx.robots) rr.targets.set(stance(rr));
      const set = (arr: Float64Array, o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) { const i = r.jointIndex.get(k); if (i !== undefined) arr[i] = v; } };
      const startT = stance(r);
      set(startT, th.start);
      r.targets.set(startT);
      sim.seconds(1.2);
      const moving = Object.keys(th.end).map((k) => r.jointIndex.get(k)).filter((i): i is number => i !== undefined);
      const ds = new Float64Array(r.joints.length).fill(1);
      for (const i of moving) ds[i] = damp;
      r.mem.dampScale = ds;
      const goal = Float64Array.from(startT);
      set(goal, th.end);
      r.targets.set(goal);
      const b = r.parts.get(th.tip)!.body;
      const xp = ctx.data.xpos as Float64Array;
      let prev: V3 = [xp[b * 3], xp[b * 3 + 1], xp[b * 3 + 2]];
      let vPk = 0, tPk = 0;
      const frac: Record<string, number> = {};
      const t0 = ctx.time;
      for (let k = 0; k < 600; k++) {
        sim.step();
        const p: V3 = [xp[b * 3], xp[b * 3 + 1], xp[b * 3 + 2]];
        const v = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) / ctx.dt;
        prev = p;
        if (v > vPk) { vPk = v; tPk = ctx.time - t0; }
        for (const i of moving) {
          const j = r.joints[i];
          frac[j.name] = Math.max(frac[j.name] ?? 0, Math.abs((ctx.data.qvel as Float64Array)[j.dadr]) / j.motor.noLoadSpeedRadS);
        }
      }
      out.push({ mode: 'gantry', design, throw: th.name, servoDamping: damp, vPeak: +vPk.toFixed(2), tPeakS: +tPk.toFixed(3), jointPeakFracNoLoad: Object.fromEntries(Object.entries(frac).map(([k, v]) => [k, +v.toFixed(2)])) });
      sim.dispose();
    }
  }
  return out;
}

function invert(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row) => row.slice(n));
}

/** Effective mass along +x at the fist (arm extended) and shin (leg raised), from the full mass matrix. */
async function meff(design: string): Promise<Record<string, unknown>> {
  const sim = await makeSim({ design, x: 0, y: 0, yaw: 0 }, { design, x: 8, y: 0, yaw: Math.PI }, { systems: [] });
  const { ctx } = sim;
  const mj = ctx.mj, m = ctx.model, d = ctx.data;
  const r = ctx.robots[0];
  const qpos = d.qpos as Float64Array;
  for (const j of r.joints) qpos[j.qadr] = r.design.stance[j.name] ?? 0;
  const set = (k: string, v: number) => { const i = r.jointIndex.get(k); if (i !== undefined) qpos[r.joints[i].qadr] = v; };
  set('shoulder_pitch_r', -1.5); set('elbow_r', -0.25); set('hip_pitch_l', -1.2); set('knee_l', 0.3);
  mj.mj_forward(m, d);
  const nv = m.nv as number;
  const full = new mj.DoubleBuffer(nv * nv);
  mj.mj_fullM(m, d, full);
  const MF = full.GetView() as Float64Array;
  const dofs = [...Array(6).keys()].map((k) => r.rootDadr + k).concat(r.joints.map((j) => j.dadr));
  const res: Record<string, unknown> = { mode: 'meff', design, massKg: +(m.body_subtreemass[r.rootBody] as number).toFixed(1) };
  for (const [tip, limb] of [['fist_r', /(shoulder_|elbow_)\w*_r$/], ['shin_l', /(hip_|knee_)\w*_l$/]] as const) {
    const body = r.parts.get(tip)!.body;
    const jacp = new mj.DoubleBuffer(3 * nv), jacr = new mj.DoubleBuffer(3 * nv);
    const xp = d.xpos as Float64Array;
    mj.mj_jac(m, d, jacp, jacr, [xp[body * 3], xp[body * 3 + 1], xp[body * 3 + 2]], body);
    const J = jacp.GetView() as Float64Array;
    const row = Array.from({ length: nv }, (_, k) => J[k]); // strike along +x
    const along = (set2: number[]) => {
      const Ai = invert(set2.map((a) => set2.map((b) => MF[a * nv + b])));
      let s = 0;
      for (let a = 0; a < set2.length; a++) for (let b = 0; b < set2.length; b++) s += row[set2[a]] * Ai[a][b] * row[set2[b]];
      return +(1 / s).toFixed(2);
    };
    const limbDofs = r.joints.filter((j) => limb.test(j.name)).map((j) => j.dadr);
    res[tip] = { limpKg: along(dofs), limbRigidKg: along(dofs.filter((x) => !limbDofs.includes(x))), bodyRigidKg: along(dofs.slice(0, 6)) };
    jacp.delete();
    jacr.delete();
  }
  full.delete();
  sim.dispose();
  return res;
}

// ---------------------------------------------------------------- CLI

async function runDesign(mode: string, design: string): Promise<Array<Record<string, unknown>>> {
  const skills = arg('skills', STRIKES.join(',')).split(',');
  const spacings = arg('spacings', 'sweet,long,air').split(',');
  const seeds = arg('seeds', '1,2').split(',').map(Number);
  const aggression = Number(arg('aggression', '1'));
  const out: Array<Record<string, unknown>> = [];
  if (mode === 'matrix' || mode === 'all') out.push(...(await matrix(design, skills, spacings, seeds, aggression)).map((r) => ({ mode: 'matrix', ...r })));
  if (mode === 'contact' || mode === 'all') out.push(...(await contact(design, arg('target', design), skills, aggression)));
  if (mode === 'gantry' || mode === 'all') out.push(...(await gantry(design)));
  if (mode === 'meff' || mode === 'all') out.push(await meff(design));
  return out;
}

async function child(mode: string, design: string): Promise<Array<Record<string, unknown>>> {
  const script = fileURLToPath(import.meta.url);
  const pass = ['skills', 'spacings', 'seeds', 'aggression', 'target', 'tune'].flatMap((k) => (process.argv.includes(`--${k}`) ? [`--${k}`, arg(k, '')] : []));
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [...process.execArgv, script, '--child', mode, design, ...pass], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      const line = buf.split('\n').find((l) => l.startsWith('['));
      if (code !== 0 || !line) reject(new Error(`${mode} ${design} exited ${code}`));
      else resolve(JSON.parse(line));
    });
  });
}

async function main(): Promise<void> {
  const tuned = applyTune(arg('tune', ''));
  const ci = process.argv.indexOf('--child');
  if (ci >= 0) {
    await loadMujoco(); // warm the module before timing-free trials
    const rows = await runDesign(process.argv[ci + 1], process.argv[ci + 2]);
    console.log(JSON.stringify(rows));
    return;
  }
  const mode = arg('mode', 'matrix');
  const designs = arg('designs', MODERN.join(',')).split(',');
  const jobs = Math.max(1, Number(arg('jobs', '2')));
  const queue = [...designs];
  const rows: Array<Record<string, unknown>> = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) rows.push(...(await child(mode, d)));
  }));
  const report = { bench: 'strike-bench', mode, designs, tuned, damageTuning: DAMAGE_TUNING, wallS: Math.round((performance.now() - t0) / 1000), rows };
  const out = arg('out', '');
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(summary(rows));
}

/** One line per design × strike: contact speed, impulse, work, and the damage verdict. */
function summary(rows: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  const matrixRows = rows.filter((r) => r.mode === 'matrix' || r.mode === 'contact');
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const r of matrixRows) {
    const k = `${r.design} ${r.id} ${r.spacing ?? 'contact'}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, rs] of groups) {
    const hit = rs.filter((r) => r.landed);
    const s = hit.map((r) => r.strike as Record<string, number | string | boolean | null>);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const self = hit.reduce((a, r) => a + Object.values((r.damage as { striker: { lost: Record<string, number> } }).striker.lost).reduce((x, y) => x + y, 0), 0);
    const vict = hit.reduce((a, r) => a + Object.values((r.damage as { victim: { lost: Record<string, number> } }).victim.lost).reduce((x, y) => x + y, 0), 0);
    const dents = hit.reduce((a, r) => a + ((r.damage as { victim: { dents: number } }).victim.dents), 0);
    const pops = hit.reduce((a, r) => a + (((r.damage as { victim: { detaches?: unknown[] } }).victim.detaches?.length) ?? 0), 0);
    const need = (hit[0]?.damage as { victim: { headNeedNs?: number | null } } | undefined)?.victim.headNeedNs;
    lines.push(`${k.padEnd(28)} landed ${hit.length}/${rs.length}  contact ${mean(hit.map((r) => r.vContact as number)).toFixed(2)} m/s (${mean(hit.map((r) => (r.contactShareOfPeak as number) ?? NaN)).toFixed(2)} of peak)  ${mean(s.map((x) => x.impulseNs as number)).toFixed(1)} N·s  work ${mean(s.map((x) => x.workJ as number)).toFixed(1)} J  peak ${mean(s.map((x) => x.peakKN as number)).toFixed(1)} kN  joint loss victim ${vict.toFixed(3)} / striker ${self.toFixed(3)}  dents ${dents}  head pops ${pops}${need ? ` (mount ${need} N·s)` : ''}`);
  }
  for (const r of rows.filter((x) => x.mode === 'gantry')) lines.push(`gantry ${r.design} ${String(r.throw).padEnd(22)} damping ${r.servoDamping}: ${r.vPeak} m/s at ${r.tPeakS} s`);
  for (const r of rows.filter((x) => x.mode === 'meff')) lines.push(`meff ${r.design} ${r.massKg} kg: fist ${JSON.stringify(r.fist_r)} shin ${JSON.stringify(r.shin_l)}`);
  return lines.join('\n');
}

await main();
