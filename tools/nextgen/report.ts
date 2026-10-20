// Phase 0 tables from tools/nextgen/out/*.json, as Markdown for docs/design/next-gen-chassis.md.
//   npx tsx tools/nextgen/report.ts            (prints; nothing is written)
import { existsSync, readFileSync } from 'node:fs';
import { LABEL, VARIANTS, type VariantId } from './variants';

const out = (name: string) => {
  const f = new URL(`./out/${name}.json`, import.meta.url);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
};
/* eslint-disable @typescript-eslint/no-explicit-any */
const stat: Record<string, any> = out('static');
const gantry: Record<string, any[]> = out('gantry');
const hold: Record<string, Record<string, any[]>> = out('hold');
const pivot: Record<string, any[]> = out('pivot');
const knee: Record<string, any> = out('knee');
const getup: Record<string, Record<string, any>> = { ...out('getup'), ...out('getup-arm'), ...out('getup-opp') };

const ids = VARIANTS.filter((v) => stat[v]);
const L = (v: VariantId) => LABEL[v];
const n1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const n2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const row = (cells: Array<string | number>) => `| ${cells.join(' | ')} |`;
const head = (cells: string[]) => `${row(cells)}\n${row(cells.map(() => '---'))}`;
const lines: string[] = [];
const p = (s = '') => lines.push(s);

p('**Body.** Mass and leg swing inertia about each joint axis (leg straight; MuJoCo body inertias plus parallel axis), with each drive\'s armature.');
p();
p(head(['Variant', 'Total kg', 'Leg kg (drives)', 'Foot kg', 'I hip pitch', 'I hip roll', 'I knee', 'Armature pitch / knee']));
for (const v of ids) {
  const m = stat[v].mass;
  p(row([L(v), n1(m.totalMassKg), `${n1(m.legMassKg)} (${n1(m.legDriveMassKg)})`, n2(m.footMassKg), n2(m.inertia.hipPitch), n2(m.inertia.hipRoll), n2(m.inertia.knee), `${m.armature.hip_pitch_l.toFixed(3)} / ${m.armature.knee_l.toFixed(3)}`]));
}
p();
p('**Kick poses by IK** (thigh-direction error + knee-axis error at the variant\'s own ranges, pelvis upright), the hip\'s smallest Jacobian singular value along a straight joint path from the stance (1 = clean, 0 = gimbal lock), and the highest thigh elevation that still fits within 10° (ankle height with a straight leg).');
p();
p(head(['Variant', 'Front', 'Side', 'High side', 'Roundhouse', 'σmin side path', 'Front reach', 'Side reach', 'Roundhouse reach']));
for (const v of ids) {
  const k = Object.fromEntries(stat[v].kicks.map((x: any) => [x.kick, x]));
  const r = stat[v].reach;
  const reach = (x: any) => (x.elevDeg > -90 ? `${x.elevDeg}° · ${n2(x.ankleHeightM)} m` : 'none');
  p(row([L(v), `${n1(k.front.errDeg)}°`, `${n1(k.side.errDeg)}°`, `${n1(k.high_side.errDeg)}°`, `${n1(k.roundhouse.errDeg)}°`, n2(k.side.pathSigmaMin), reach(r.front), reach(r.side), reach(r.roundhouse)]));
}
p();
p('**Gantry reach** (pelvis on the gantry, the left leg stepped from stance to the IK fit; servo and motor model as in the game). t90 = time to cover 90% of the thigh\'s swing; error = final pose vs the target (includes the IK miss).');
p();
p(head(['Variant', 'Front t90 / err', 'Side t90 / err', 'High side t90 / err', 'Roundhouse t90 / err', 'Peak ω/ω₀']));
for (const v of ids) {
  if (!gantry[v]) continue;
  const g = Object.fromEntries(gantry[v].map((x: any) => [x.kick, x]));
  const c = (x: any) => `${Math.round(x.t90S * 1000)} ms / ${n1(x.finalPoseErrDeg)}°`;
  p(row([L(v), c(g.front), c(g.side), c(g.high_side), c(g.roundhouse), n2(Math.max(...gantry[v].map((x: any) => x.peakSpeedFrac)))]));
}
p();
p('**Knee snap** (gantry, thigh level forward, knee stepped from 90° to straight): where reflected armature shows, because the shin alone is light.');
p();
p(head(['Variant', 't90', 'Peak knee speed', 'No-load']));
for (const v of ids) if (knee[v]) p(row([L(v), `${Math.round(knee[v].t90S * 1000)} ms`, `${n1(knee[v].peakKneeRadS)} rad/s`, `${n1(knee[v].noLoadRadS)} rad/s`]));
p();
p('**One-leg hold, 1 s, 5 seeds** (free on the canvas; same planner and COM balance law for every variant; the planner may lean the torso, at a price). Held = no fall, no touch-down, no support-foot roll, no thermal derate. Lean and world error are medians over the seeds that held (the planned value when none held). Support τ = peak |τ|/stall on the support leg.');
p();
p(head(['Variant', 'Front: held · lean · err', 'Side: held · lean · err', 'High side: held · lean · err · ankle z', 'Peak support τ/stall']));
for (const v of ids) {
  if (!hold[v]) continue;
  const c = (k: string, z = false) => {
    const rs = hold[v][k];
    if (!rs) return '—';
    const ok = rs.filter((r) => r.ok);
    const lean = ok.length ? med(ok.map((r) => r.maxLeanDeg)) : rs[0].plannedLeanDeg;
    const err = ok.length ? med(ok.map((r) => r.worldErrDeg)) : rs[0].plannedWorldErrDeg;
    return `${ok.length}/5 · ${Math.round(lean)}°${ok.length ? '' : ' (plan)'} · ${n1(err)}°${z && ok.length ? ` · ${n2(med(ok.map((r) => r.kickAnkleZ)))} m` : ''}`;
  };
  const sup = Math.max(...Object.values(hold[v]).flat().map((r: any) => r.supportTauFrac));
  p(row([L(v), c('front'), c('side'), c('high_side', true), n2(sup)]));
}
p();
p('**Crouched 180° pivot** over the left foot, welded where it sits at qpos0 (8 mm above the canvas, so the weld carries the weight and every tipping moment; the same COM law keeps the COM near it), 1.5 s, whole-body plan. Hip IK = the hip alone with the pelvis level; final = measured pelvis orientation error after the turn. CoP off sole = time (of 2.0 s) and worst distance the centre of pressure the turn needs lies outside the sole box, i.e. where a real, unwelded foot would roll; "pull" = the weld had to pull the foot down. Torques in this table are weld-assisted.');
p();
p(head(['Variant', '30° crouch: hip IK · final · turn', '50° crouch: hip IK · final · turn', 'Hip travel (P / R / Y) at 50°', 'Peak τ/stall (worst)', 'CoP off sole 30° / 50°']));
for (const v of ids) {
  if (!pivot[v]) continue;
  const [a, b] = pivot[v];
  const c = (x: any) => `${n1(x.hipIkEndErrDeg)}° · ${n1(x.finalErrDeg)}° · ${Math.round(x.turnDeg)}°`;
  const cop = (x: any) => (x.copOutsideSoleS === undefined ? '—' : x.worstCopOutsideSoleM === null || x.minNormalN <= 0 ? `${n2(x.copOutsideSoleS)} s · pull` : `${n2(x.copOutsideSoleS)} s · ${Math.round(100 * x.worstCopOutsideSoleM)} cm`);
  p(row([L(v), c(a), c(b), `${Math.round(b.hipTravelDeg.pitch)}° / ${Math.round(b.hipTravelDeg.roll)}° / ${Math.round(b.hipTravelDeg.yaw)}°`, `${n2(Math.max(a.peakTauFrac, b.peakTauFrac))} (${b.worstJoint})`, `${cop(a)} / ${cop(b)}`]));
}
p();
p('**Get-ups, 5 seeds** (SAVATE\'s best mocap get-up clip through each variant\'s hip and ranges, eight playback numbers searched with the same budget, then the winner dropped 5 times). Time is from the first movement to the stand gate.');
p();
p(head(['Variant', 'Back: up · median · best', 'Face down: up · median · best', 'Peak τ/stall', 'Peak ω/ω₀', 'Peak temp', 'Derate']));
for (const v of ids) {
  const g = getup[v];
  if (!g) continue;
  const c = (x: any) => (x ? `${x.successes}/5 · ${n2(x.medianStandS)} s · ${n2(x.bestStandS)} s` : '—');
  const all = [g.back, g.face_down].filter(Boolean);
  p(row([L(v), c(g.back), c(g.face_down), n2(Math.max(...all.map((x: any) => x.peakTauFrac))), n2(Math.max(...all.map((x: any) => x.peakSpeedFrac))), `${n1(Math.max(...all.map((x: any) => x.peakTempC)))} °C`, all.flatMap((x: any) => x.derated).join(', ') || 'none']));
}
console.log(lines.join('\n'));
