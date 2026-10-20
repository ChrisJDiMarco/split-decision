// Replays each variant's recorded get-up winner (tools/nextgen/out/getup*.json params) on the same 5
// seeds, without re-searching: checks the recorded times reproduce and logs how long the ankles sit
// on their stops (§6 asks for it; the first run did not record it). Seconds, one process:
//   npx tsx tools/nextgen/getup-replay.ts [A,R,M,O,P,P2,PA]
import { existsSync, readFileSync } from 'node:fs';
import { trial, type Lie } from './tests-getup';
import { buildVariant, LABEL, VARIANTS, type VariantId } from './variants';

const recs: Record<string, Record<string, { params: Parameters<typeof trial>[2]; successes: number; medianStandS: number }>> = {};
for (const name of ['getup', 'getup-arm', 'getup-opp']) {
  const f = new URL(`./out/${name}.json`, import.meta.url);
  if (existsSync(f)) Object.assign(recs, JSON.parse(readFileSync(f, 'utf8')));
}
const ids = (process.argv[2]?.split(',') ?? VARIANTS) as VariantId[];
for (const id of ids) {
  for (const lie of ['back', 'face_down'] as Lie[]) {
    const rec = recs[id]?.[lie];
    if (!rec) continue;
    const ts = [];
    for (let s = 1; s <= 5; s++) ts.push(await trial(buildVariant(id), lie, rec.params, s, true));
    const up = ts.filter((t) => t.ok).map((t) => t.standS).sort((a, b) => a - b);
    const median = up.length ? up[Math.floor(up.length / 2)] : NaN;
    const stops = ts.map((t) => t.ankleStopS).sort((a, b) => a - b);
    console.log(`${LABEL[id].padEnd(4)} ${lie.padEnd(9)} ${up.length}/5 up, median ${median.toFixed(2)} s (recorded ${rec.successes}/5, ${rec.medianStandS.toFixed(2)} s); ankle on a stop: median ${stops[2].toFixed(2)} s, worst ${stops[4].toFixed(2)} s`);
  }
}
