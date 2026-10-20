// Phase 0 physics runner. One process; results merge into tools/nextgen/out/<test>.json per variant.
//   npx tsx tools/nextgen/run.ts gantry [A,R,M,O,P,P2]
//   npx tsx tools/nextgen/run.ts hold   [variants] [kicks=front,side,high_side] [seeds=5]
//   npx tsx tools/nextgen/run.ts pivot  [variants]
//   npx tsx tools/nextgen/run.ts getup  [variants] [sides=back,face_down] [budget=…]
// Keep at most two of these running at once (the Mac is shared with other builds).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { KICKS } from './poses';
import { buildVariant, VARIANTS, type VariantId } from './variants';

const [test, vArg, a3, a4] = process.argv.slice(2);
const ids = (vArg && vArg !== 'all' ? vArg.split(',') : VARIANTS) as VariantId[];
const outDir = new URL('./out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const file = new URL(`./${test}${process.env.NG_TAG ? `-${process.env.NG_TAG}` : ''}.json`, outDir);
const results: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const save = () => writeFileSync(file, JSON.stringify(results, null, 1));
const t0 = Date.now();
const fmt = (x: unknown) => (typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : JSON.stringify(x));

for (const id of ids) {
  const v = buildVariant(id);
  if (test === 'gantry') {
    const { gantry } = await import('./tests-kick');
    const rows = await gantry(v);
    results[id] = rows;
    for (const r of rows) console.log(`${v.label} gantry ${r.kick.padEnd(10)} IK ${r.ikErrDeg.toFixed(1)}° final ${r.finalPoseErrDeg.toFixed(1)}° track ${r.trackErrDeg.toFixed(1)}° move ${r.moveDeg.toFixed(0)}° t90 ${(r.t90S * 1000).toFixed(0)} ms τ/stall ${r.peakTauFrac.toFixed(2)} (${r.worstJoint}) ω/ω0 ${r.peakSpeedFrac.toFixed(2)} ${r.peakTempC.toFixed(1)}°C`);
  } else if (test === 'knee') {
    const { kneeSnap } = await import('./tests-kick');
    const r = await kneeSnap(v);
    results[id] = r;
    console.log(`${v.label} knee snap 90°→0: t90 ${(r.t90S * 1000).toFixed(0)} ms, peak ${r.peakKneeRadS.toFixed(1)} rad/s (no-load ${r.noLoadRadS.toFixed(1)}), τ/stall ${r.kneeTauFrac.toFixed(2)}`);
  } else if (test === 'hold') {
    const { hold } = await import('./tests-kick');
    const kicks = (a3 ?? 'front,side,high_side').split(',');
    const seeds = Number(a4 ?? 5);
    const prev = (results[id] ?? {}) as Record<string, unknown>;
    for (const kid of kicks) {
      const k = KICKS.find((x) => x.id === kid)!;
      const runs = [];
      for (let s = 1; s <= seeds; s++) {
        const r = await hold(v, k, s);
        runs.push(r);
        console.log(`${v.label} hold ${kid.padEnd(10)} seed ${s}: ${r.ok ? 'HELD' : `FAIL (${r.why})`} margin ${(r.minMarginM * 100).toFixed(1)} cm lean ${r.maxLeanDeg.toFixed(1)}° pose ${r.poseErrDeg.toFixed(1)}° world ${r.worldErrDeg.toFixed(1)}° (plan ${r.plannedWorldErrDeg.toFixed(1)}° lean ${r.plannedLeanDeg.toFixed(0)}°) ankle z ${r.kickAnkleZ.toFixed(2)} m hip τ/stall ${r.hipTauFrac.toFixed(2)} (${r.hipWorst}) support ${r.supportTauFrac.toFixed(2)} ankle-stop ${r.ankleStopS.toFixed(2)} s plan COM ${r.planComErrMm.toFixed(1)} mm${process.env.NG_DEBUG ? ` ${JSON.stringify(r.supportPeaks)}` : ''}`);
      }
      prev[kid] = runs;
    }
    results[id] = prev;
  } else if (test === 'pivot') {
    const { pivot } = await import('./tests-pivot');
    const rows = await pivot(v);
    results[id] = rows;
    for (const r of rows) console.log(`${v.label} pivot ${Object.entries(r).map(([k, x]) => `${k} ${fmt(x)}`).join(' ')}`);
  } else if (test === 'getup') {
    const { getup } = await import('./tests-getup');
    const sides = (a3 ?? 'back,face_down').split(',');
    const prev = (results[id] ?? {}) as Record<string, unknown>;
    for (const side of sides) {
      const r = await getup(v, side as 'back' | 'face_down', a4 ? Number(a4) : undefined);
      prev[side] = r;
    }
    results[id] = prev;
  } else {
    console.error(`unknown test '${test}'`);
    process.exit(1);
  }
  save();
  console.log(`  (${v.label} done, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
