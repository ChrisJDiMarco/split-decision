// Print the automatic segmentation of source clips (labels, frames, features) for tuning.
//   npx tsx tools/mocap/segments.ts                 all clips
//   npx tsx tools/mocap/segments.ts 13_17 135_07    some clips
//   npx tsx tools/mocap/segments.ts --label hook    only one label
import { CLIPS, clipInfo } from '../../src/robots/motions/clips';
import { segmentClip } from '../../src/robots/motions/segment';
import { LIBRARY_FPS, loadTrack } from './load';

const args = process.argv.slice(2);
const labelArg = args.indexOf('--label');
const onlyLabel = labelArg >= 0 ? args[labelArg + 1] : null;
const ids = args.filter((a, i) => !a.startsWith('--') && (labelArg < 0 || i !== labelArg + 1));
const clips = ids.length ? ids.map(clipInfo) : CLIPS;
const totals = new Map<string, number>();
for (const c of clips) {
  const tr = loadTrack(c.id);
  const { segments } = segmentClip(tr, c);
  const shown = segments.filter((s) => !onlyLabel || s.label === onlyLabel);
  console.log(`\n${c.id} (${c.kind}, ${(tr.n / LIBRARY_FPS).toFixed(1)} s): ${segments.length} segments`);
  for (const s of shown) {
    totals.set(s.label, (totals.get(s.label) ?? 0) + 1);
    const t = (f: number | null) => (f === null ? '  -  ' : (f / LIBRARY_FPS).toFixed(2).padStart(5));
    console.log(`  ${s.label.padEnd(15)} ${(s.side ?? '-').padEnd(1)} ${(s.height ?? '-').padEnd(4)} ${s.mirrored ? 'M' : ' '} ${t(s.start)}-${t(s.end)} strike ${t(s.strike)} imp ${t(s.impact)} rec ${t(s.recover)} sc ${s.score.toFixed(2).padStart(5)}  ${s.why}`);
  }
}
console.log('\ntotals:', [...totals.entries()].sort().map(([k, v]) => `${k} ${v}`).join(', '));
