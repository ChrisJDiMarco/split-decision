// Repair for round-1 files whose tuned gyroL (angular-momentum feedback against the simulated nominal)
// read the nominal while it was being recorded, so their stored nominal is not exactly what a replay
// does (FIRECRACKER's back get-up: up to 3.4° apart). Sets gyroL to 0, which makes the law independent of
// the nominal, re-records the nominal from the stored plan, checks the move still completes, and writes the
// file back (status 'failed' if it no longer does). Then re-measure (measure.ts) and re-accept (accept.ts).
//   npx tsx tools/polish/renominal.ts firecracker/getup_back.140_09.0027
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePolish, encodeNominal, NOMINAL_STRIDE, quantizeNominal } from '../../src/robots/motions/polish/format';
import { readPolishFromDisk } from '../../src/robots/motions/polish/load';
import type { PolishPlan } from '../../src/robots/motions/polish/player';
import { newTrace, TRACE_STRIDE } from './rollout';
import { getupUp } from './measure';
import { MoveSession } from './session';
import { POLISHED_DIR, readIndex, writeIndex } from './store';

for (const id of process.argv.slice(2)) {
  const [design, moveId] = id.split('/');
  const json = readPolishFromDisk(design, moveId);
  if (!json) throw new Error(`no polish ${id}`);
  if (!json.fb.gyroL) {
    console.log(`${id}: gyroL is already 0, nothing to do`);
    continue;
  }
  const pm = decodePolish(json);
  const ses = await MoveSession.create(design, moveId);
  const fb = { ...pm.fb, gyroL: 0 };
  const nom = new Float64Array(6000 * NOMINAL_STRIDE);
  const plan: PolishPlan = {
    knotS: pm.knotS, segments: pm.segments, tailS: pm.tailS, rates: pm.rates, dq: pm.dq, libJoints: pm.nj, gyroFF: pm.gyroFF,
    fb, deadband: pm.deadband, nominal: nom, nominalSamples: 6000, track: pm.track, trackFrames: pm.trackFrames,
  };
  const endTau = ses.spec.move.duration + pm.tailS;
  const tr = newTrace();
  const res = ses.roll(ses.settle(plan), plan, { untilTau: endTau, maxWallS: endTau / 0.25 + 1, feedback: true, trace: tr, nominal: nom });
  const samples = Math.min(6000, Math.floor(res.wallS * 250) + 1);
  const o = (tr.n - 1) * TRACE_STRIDE;
  const getup = ses.ref.kind === 'getup';
  const ok = getup ? getupUp(ses.ref, tr.data[o + 53], tr.data[o + 69], ses.w.stancePelvisZ) : !Array.from({ length: tr.n }, (_, i) => tr.data[i * TRACE_STRIDE + 53]).some((u) => u < 0.5);
  const out = nom.slice(0, samples * NOMINAL_STRIDE);
  quantizeNominal(out);
  json.fb = fb;
  json.nominal = encodeNominal(out);
  json.nominalSamples = samples;
  if (!ok) {
    json.status = 'failed';
    json.reason = 'completes only with the round-1 gyroL, which reads its own nominal';
  }
  writeFileSync(join(POLISHED_DIR, design, `${moveId}.json`), JSON.stringify(json) + '\n');
  const ix = readIndex(design);
  if (ix.moves[moveId]) ix.moves[moveId].status = json.status;
  writeIndex(ix);
  console.log(`${id}: gyroL ${pm.fb.gyroL.toFixed(2)} → 0, nominal re-recorded (${samples} samples), ${ok ? 'still completes' : 'NO LONGER COMPLETES: marked failed'}`);
}
