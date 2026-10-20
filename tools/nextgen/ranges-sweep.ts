// Range sensitivity for the tilted hip (static IK, seconds): how the kick fits move if the yaw
// internal limit, the roll limit or the pitch extension limit change.
//   npx tsx tools/nextgen/ranges-sweep.ts
import { kickCost, solveHip, sigmaMin } from './sweep-deps';
import { KICKS } from './poses';
import { DEG } from './math3';
const base = { p: [-150, 60], r: [-30, 110], y: [-80, 180] } as Record<'p' | 'r' | 'y', [number, number]>;
const rows: Array<[string, Record<'p' | 'r' | 'y', [number, number]>]> = [
  ['§3 proposal', base],
  ['yaw −90', { ...base, y: [-90, 180] }],
  ['yaw −100', { ...base, y: [-100, 180] }],
  ['roll 118', { ...base, r: [-30, 118] }],
  ['roll 118, yaw −90', { ...base, r: [-30, 118], y: [-90, 180] }],
  ['pitch +90', { ...base, p: [-150, 90] }],
  ['roll 125, yaw −100', { ...base, r: [-30, 125], y: [-100, 180] }],
];
for (const [name, r] of rows) {
  const rng = { p: [r.p[0] * DEG, r.p[1] * DEG], r: [r.r[0] * DEG, r.r[1] * DEG], y: [r.y[0] * DEG, r.y[1] * DEG] } as never;
  const cells = KICKS.map((k) => { const s = solveHip('tilted', 'l', rng, kickCost(k.d, k.k)); return `${k.id} ${(s.cost / DEG).toFixed(1)}° (σ ${sigmaMin('tilted', s.q).toFixed(2)})`; });
  console.log(`${name.padEnd(20)} ${cells.join('  ')}`);
}
