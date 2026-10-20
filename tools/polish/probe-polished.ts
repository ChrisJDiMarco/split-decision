// Development aid: replay a stored polished move (decoded exactly as the game loads it) and print the
// trajectory against the clip, the cost terms, and the same for the plain playback.
//   npx tsx tools/polish/probe-polished.ts savate cross.13_17.1024
import { decodePolish } from '../../src/robots/motions/polish/format';
import { readPolishFromDisk } from '../../src/robots/motions/polish/load';
import type { PolishPlan } from '../../src/robots/motions/polish/player';
import { refAt } from './reference';
import { CostAcc, newTrace, TRACE_STRIDE } from './rollout';
import { MoveSession } from './session';

const [design = 'savate', moveId = 'cross.13_17.1024'] = process.argv.slice(2);
const json = readPolishFromDisk(design, moveId);
if (!json) throw new Error('no polish file');
const pm = decodePolish(json);
const ses = await MoveSession.create(design, moveId);
const raw = ses.player.plan;
const pol: PolishPlan = {
  knotS: pm.knotS, segments: pm.segments, tailS: pm.tailS, rates: pm.rates, dq: pm.dq, libJoints: pm.nj, gyroFF: pm.gyroFF,
  fb: pm.fb, deadband: pm.deadband, nominal: pm.nominal, nominalSamples: pm.nominalSamples, track: pm.track, trackFrames: pm.trackFrames,
};
const endTau = ses.spec.move.duration + pm.tailS;
for (const [name, plan] of [['raw', raw], ['polished', pol]] as const) {
  const start = ses.settle(plan);
  const acc = new CostAcc(ses.ref, 0, endTau, endTau, ses.spec.nLib, ses.spec.kind === 'getup' ? 3 / 8 : 1);
  const tr = newTrace();
  const res = ses.roll(start, plan, { untilTau: endTau, maxWallS: 15, feedback: true, cost: acc, trace: tr });
  const c = acc.result();
  console.log(`=== ${name}: cost ${c.total.toFixed(1)} fell ${c.fell} (τ ${c.fellTau.toFixed(2)}) wall ${res.wallS.toFixed(2)} s; impact err ${(c.impactErr * 100).toFixed(1)} cm speed ${c.impactSpeed.toFixed(2)}`);
  console.log('   ', Object.entries(c.terms).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  '), `impact ${c.impact.toFixed(1)} terminal ${c.terminal.toFixed(1)}`);
  const d = tr.data;
  for (let i = 0; i < tr.n; i += Math.max(1, Math.floor(tr.n / 14))) {
    const o = i * TRACE_STRIDE;
    const tau = d[o + 1];
    const rp = [0, 1, 2].map((k) => refAt(ses.ref.pelvis, 3, ses.ref, tau, k));
    const rc = [0, 1, 2].map((k) => refAt(ses.ref.com, 3, ses.ref, tau, k));
    console.log(`  t ${d[o].toFixed(2)} τ ${tau.toFixed(2)} r ${d[o + 2].toFixed(2)} up ${d[o + 53].toFixed(2)} pelvis ${[3, 4, 5].map((k) => d[o + k].toFixed(2)).join(',')} ref ${rp.map((v) => v.toFixed(2)).join(',')} com ${[33, 34, 35].map((k) => d[o + k].toFixed(2)).join(',')} ref ${rc.map((v) => v.toFixed(2)).join(',')} feet ${d[o + 45]}${d[o + 46]} legSat ${d[o + 57].toFixed(2)}`);
  }
}
