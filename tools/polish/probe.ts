// Quick look at one move played plainly (zero Δq, no feedback, today's rate): cost terms, falls,
// wall time and µs per physics step. Development aid for the optimiser.
//   npx tsx tools/polish/probe.ts savate cross.13_17.1024
import { CostAcc, newTrace, TRACE_STRIDE } from './rollout';
import { MoveSession } from './session';

const [design = 'savate', moveId = 'cross.13_17.1024'] = process.argv.slice(2);
const t0 = performance.now();
const ses = await MoveSession.create(design, moveId);
const spec = ses.spec;
console.log(`${design} ${moveId}: kind ${spec.kind}, ${spec.segments} segments, ${spec.windows} windows, sampled ${spec.sampled.length} ch, gyro ${spec.gyro}, build ${(performance.now() - t0).toFixed(0)} ms`);
const plan = ses.player.plan;
const t1 = performance.now();
const start = ses.settle(plan);
const t2 = performance.now();
const endTau = spec.move.duration + 0.5;
const acc = new CostAcc(ses.ref, 0, endTau, endTau, spec.nLib, spec.kind === 'getup' ? 3 / 8 : 1);
const trace = newTrace();
const res = ses.roll(start, plan, { untilTau: endTau, maxWallS: 12, feedback: false, cost: acc, trace });
const t3 = performance.now();
const c = acc.result();
console.log(`settle ${(t2 - t1).toFixed(0)} ms; roll ${res.steps} steps in ${(t3 - t2).toFixed(0)} ms = ${(((t3 - t2) / res.steps) * 1000).toFixed(1)} µs/step; wall ${res.wallS.toFixed(2)} s for clip ${spec.move.duration.toFixed(2)} s`);
console.log(`cost ${c.total.toFixed(1)} fell ${c.fell} at τ ${c.fellTau.toFixed(2)}; impact err ${(c.impactErr * 100).toFixed(1)} cm speed ${c.impactSpeed.toFixed(2)} m/s (peak ${spec.move.peakSpeed.toFixed(1)}×rate)`);
console.log(Object.entries(c.terms).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  '), `impact ${c.impact.toFixed(1)} terminal ${c.terminal.toFixed(1)}`);
// Torso up and pelvis height over time.
const rows: string[] = [];
for (let i = 0; i < trace.n; i += Math.max(1, Math.floor(trace.n / 16))) {
  const o = i * TRACE_STRIDE;
  const d = trace.data;
  rows.push(`t ${d[o].toFixed(2)} τ ${d[o + 1].toFixed(2)} r ${d[o + 2].toFixed(2)} up ${d[o + 53].toFixed(2)} pz ${d[o + 5].toFixed(2)} com ${d[o + 33].toFixed(2)},${d[o + 34].toFixed(2)},${d[o + 35].toFixed(2)} feet ${d[o + 45]}${d[o + 46]} τmax ${d[o + 55].toFixed(2)} legSat ${d[o + 57].toFixed(2)}`);
}
console.log(rows.join('\n'));
