// Prints the measured A/B numbers of every polished move with comparison traces, as a markdown table.
//   npx tsx tools/polish/report.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLISHED_DIR } from './store';

type M = Record<string, number | boolean | null>;
const rows: string[] = [];
const f = (v: unknown, d = 1) => (v === null || v === undefined ? '–' : typeof v === 'number' ? v.toFixed(d) : String(v));
for (const design of readdirSync(POLISHED_DIR)) {
  const dir = join(POLISHED_DIR, design, 'traces');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    const t = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { move: string; cpuS: number; metrics: Record<string, M> };
    const pj = JSON.parse(readFileSync(join(POLISHED_DIR, design, file), 'utf8')) as { validation?: { acceptance?: { repoRmsDeg: number; repoMaxDeg: number } } };
    const acc = pj.validation?.acceptance;
    for (const v of ['raw', 'raw+fb', 'polished']) {
      const m = t.metrics[v];
      if (!m) continue;
      rows.push(`| ${design} ${t.move} | ${v} | ${m.fell ? `fell${m.fellAtS ? ` ${f(m.fellAtS, 2)} s` : ''}` : 'stands'} | ${m.pushFalls}/${m.seeds} | ${m.damageFalls}/${m.seeds} | ${f(m.jointRmsDeg)} / ${f(m.legRmsDeg)} | ${f(m.rootErrCm)} / ${f(m.comErrCm)} | ${f(m.slipCm)} | ${f(m.torsoBuzzRms, 2)} | ${f(m.pelvisJerkRms, 0)} | ${m.impactErrCm === null ? '–' : `${f(m.impactErrCm)} cm, ${f(m.impactSpeed)} m/s (${f(m.impactSpeedShare, 2)}×)`} | ${f(m.peakTorqueShare, 2)} / ${f(m.peakSpeedShare, 2)} | ${f(m.legSatShare, 2)} | +${f(m.heatRiseC, 1)} | ${f(m.spinDeg, 0)} / ${f(m.clipSpinDeg, 0)} | ${f(m.wallS, 2)} s, ×${f(m.speedUp, 2)} | ${v === 'polished' ? `${Math.round(t.cpuS / 60)} min${acc ? `; repro ${f(acc.repoRmsDeg, 2)}° (max ${f(acc.repoMaxDeg, 1)}°)` : ''}` : ''} |`);
    }
  }
}
console.log('| move | playback | nominal | push falls | damage falls | joint / legs RMS (°) | pelvis / COM path (cm) | slip (cm) | torso shake (rad/s) | pelvis jerk (m/s³) | striker at impact | peak τ / ω share | leg servo ≥85% | heat (°C) | turn (° / clip) | move time, × human | CPU; reproduction |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
