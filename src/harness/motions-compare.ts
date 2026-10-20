// Move-polish comparison data for the motion preview (harness/motions.html?mode=compare): the
// recorded physics playbacks of a move (tools/polish/measure.ts), raw and polished, played back
// kinematically next to the mocap, with the measured numbers.
import type { Vec3 } from '../core/types';
import { matFromQuat, type Mat3 } from '../robots/motions/math';

export interface TraceSet {
  fps: number;
  n: number;
  wall: number[];
  tau: number[];
  root: number[]; // n × 7: x y z qw qx qy qz
  q: number[]; // n × joints
}

export type VariantName = 'raw' | 'raw+fb' | 'polished';
export const VARIANTS: VariantName[] = ['raw', 'raw+fb', 'polished'];

export interface CompareMetrics {
  fell: boolean;
  fellAtS?: number | null;
  jointRmsDeg: number;
  legRmsDeg: number;
  rootErrCm: number;
  comErrCm: number;
  impactErrCm: number | null;
  impactSpeed: number | null;
  impactSpeedShare: number | null;
  strikerPeakSpeed: number | null;
  slipCm: number;
  slipTotalCm: number;
  torsoHfRms: number;
  torsoBuzzRms?: number;
  pelvisJerkRms: number;
  jointJerkRms: number;
  peakTorqueShare: number;
  peakSpeedShare: number;
  legSatShare: number;
  heatRiseC: number;
  gyroPeak: number;
  spinDeg?: number;
  clipSpinDeg?: number;
  wallS: number;
  clipS: number;
  speedUp: number;
  pushFalls: number;
  damageFalls: number;
  seeds: number;
}

export interface CompareData {
  format: number;
  design: string;
  move: string;
  clipS: number;
  knotS: number;
  tailS: number;
  stale: boolean;
  hash: string;
  cpuS: number;
  metrics: Record<VariantName, CompareMetrics>;
  traces: Record<VariantName, TraceSet>;
  joints: string[];
}

type Loader = () => Promise<CompareData>;
let loaders: Record<string, Loader> = {};
try {
  loaders = import.meta.glob<CompareData>('../robots/motions/data/polished/*/traces/*.json', { import: 'default' });
} catch {
  loaders = {};
}

/** Every design/move with recorded comparison traces. */
export function compareKeys(): Array<{ design: string; move: string }> {
  return Object.keys(loaders)
    .map((k) => /polished\/([^/]+)\/traces\/(.+)\.json$/.exec(k))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ design: m[1], move: m[2] }))
    .sort((a, b) => a.design.localeCompare(b.design) || a.move.localeCompare(b.move));
}

const cache = new Map<string, Promise<CompareData>>();
export function loadCompare(design: string, move: string): Promise<CompareData> {
  const key = `../robots/motions/data/polished/${design}/traces/${move}.json`;
  let p = cache.get(key);
  if (!p) {
    const l = loaders[key];
    if (!l) return Promise.reject(new Error(`no comparison traces for ${design}/${move}: run tools/polish`));
    p = l();
    cache.set(key, p);
  }
  return p;
}

export interface TracePose {
  q: Record<string, number>;
  pos: Vec3;
  rot: Mat3;
  tau: number;
}

/** The recorded pose at wall time `wall` (s after the move's clock started), linear between samples. */
export function traceAt(set: TraceSet, joints: readonly string[], wall: number): TracePose {
  const x = Math.max(0, Math.min(set.n - 1, wall * set.fps));
  const i = Math.min(set.n - 2, Math.floor(x)), w = Math.max(0, x - i);
  const nj = joints.length;
  const lerp = (a: number, b: number) => a + (b - a) * w;
  const q: Record<string, number> = {};
  for (let j = 0; j < nj; j++) q[joints[j]] = lerp(set.q[i * nj + j], set.q[(i + 1) * nj + j]);
  const r0 = i * 7, r1 = (i + 1) * 7;
  const pos: Vec3 = [lerp(set.root[r0], set.root[r1]), lerp(set.root[r0 + 1], set.root[r1 + 1]), lerp(set.root[r0 + 2], set.root[r1 + 2])];
  let qa = [set.root[r0 + 3], set.root[r0 + 4], set.root[r0 + 5], set.root[r0 + 6]];
  const qb = [set.root[r1 + 3], set.root[r1 + 4], set.root[r1 + 5], set.root[r1 + 6]];
  if (qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0) qa = qa.map((v) => -v);
  const qq = [0, 1, 2, 3].map((k) => lerp(qa[k], qb[k]));
  const nq = Math.hypot(qq[0], qq[1], qq[2], qq[3]) || 1;
  return { q, pos, rot: matFromQuat([qq[0] / nq, qq[1] / nq, qq[2] / nq, qq[3] / nq]), tau: lerp(set.tau[i], set.tau[i + 1]) };
}

/** Wall time at which a recording reached clip time `tau` (its end if never). */
export function wallAtTau(set: TraceSet, tau: number): number {
  for (let i = 1; i < set.n; i++) {
    if (set.tau[i] >= tau) {
      const a = set.tau[i - 1], b = set.tau[i];
      const w = b > a ? (tau - a) / (b - a) : 0;
      return set.wall[i - 1] + (set.wall[i] - set.wall[i - 1]) * w;
    }
  }
  return set.wall[set.n - 1];
}

export const lastWall = (set: TraceSet): number => set.wall[set.n - 1];

const fmt = (v: number | null | undefined, d = 1): string => (v === null || v === undefined ? '–' : v.toFixed(d));

/** The measured numbers side by side, as HTML for the info panel. */
export function metricsTable(c: CompareData, shown: readonly VariantName[]): string {
  const rows: Array<[string, (m: CompareMetrics) => string, 'low' | 'high' | null]> = [
    ['falls, nominal', (m) => (m.fell ? (m.fellAtS ? `FELL ${m.fellAtS.toFixed(2)}s` : 'FELL') : 'stands'), null],
    [`falls, pushes 0.3-0.6 m/s`, (m) => `${m.pushFalls}/${m.seeds}`, 'low'],
    ['falls, 1 damaged joint', (m) => `${m.damageFalls}/${m.seeds}`, 'low'],
    ['joint RMS vs clip (°)', (m) => fmt(m.jointRmsDeg), 'low'],
    ['  legs (°)', (m) => fmt(m.legRmsDeg), 'low'],
    ['pelvis path err (cm)', (m) => fmt(m.rootErrCm), 'low'],
    ['COM path err (cm)', (m) => fmt(m.comErrCm), 'low'],
    ['foot slip, worst (cm)', (m) => fmt(m.slipCm), 'low'],
    ['torso shake >3 Hz (rad/s)', (m) => fmt(m.torsoBuzzRms ?? m.torsoHfRms, 2), 'low'],
    ['pelvis jerk (m/s³)', (m) => fmt(m.pelvisJerkRms, 0), 'low'],
    ['striker at impact (cm)', (m) => fmt(m.impactErrCm), 'low'],
    ['striker speed (m/s)', (m) => fmt(m.impactSpeed), 'high'],
    ['peak torque / stall', (m) => fmt(m.peakTorqueShare, 2), null],
    ['leg servo ≥85% (share)', (m) => fmt(m.legSatShare, 2), 'low'],
    ['heat rise (°C)', (m) => fmt(m.heatRiseC, 2), 'low'],
    ['gyro peak |h|/H', (m) => fmt(m.gyroPeak, 2), null],
    ['turn achieved (°)', (m) => (m.spinDeg === undefined ? '–' : `${fmt(m.spinDeg, 0)} / ${fmt(m.clipSpinDeg, 0)}`), null],
    ['move time (s)', (m) => fmt(m.wallS, 2), null],
    ['speed vs human', (m) => `×${fmt(m.speedUp, 2)}`, 'high'],
  ];
  const head = `<tr><td></td>${shown.map((v) => `<td><b>${v.toUpperCase()}</b></td>`).join('')}</tr>`;
  const body = rows.map(([label, f, better]) => {
    const vals = shown.map((v) => (c.metrics[v] ? f(c.metrics[v]) : '–'));
    const nums = vals.map((s) => Number.parseFloat(s.replace(/^×/, '')));
    let best = -1;
    if (better && nums.every((n) => Number.isFinite(n))) {
      const target = better === 'low' ? Math.min(...nums) : Math.max(...nums);
      if (nums.filter((n) => n === target).length === 1) best = nums.indexOf(target);
    }
    return `<tr><td>${label}</td>${vals.map((s, i) => `<td${i === best ? ' class="best"' : ''}>${s}</td>`).join('')}</tr>`;
  }).join('');
  return [
    `<b>${c.design.toUpperCase()} · ${c.move}</b>`,
    `clip ${c.clipS.toFixed(2)} s · polish CPU ${Math.round(c.cpuS / 60)} min${c.stale ? ' · <span class="warn">STALE: robot changed since</span>' : ''}`,
    `<table class="metrics">${head}${body}</table>`,
    `Tracking numbers of a playback that falls stop at the fall.`,
    `RAW: the retargeted clip played plainly on the servos (today's rate, velocity feed-forward).`,
    `RAW+FB: the same with the polished move's feedback law. POLISHED: the stored move as the game loads it.`,
  ].join('\n');
}
