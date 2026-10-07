// Centroid tables at run time (docs/design/balance-engine.md §5.1; built offline by
// tools/mocap/centroid-tables.ts into ./centroid/<design>.json). Per strike move and 60 Hz frame:
// the whole-body COM in the move frame, the extra centre of pressure the move implies at 1× speed
// (Δp₁: at playback rate r the implied COP is com + r²·Δp₁), and the fastest rate the robot's own
// motors allow for the limbs and the trunk (inverse dynamics on the torque-speed lines).
//   worker   a lazy Vite import, started the first time a fighter of the design asks; strikes play
//            without it (library rates, no preview) until it lands
//   Node     tools and tests read the JSON straight from disk, synchronously
import type { MoveLabel } from '../../../robots/motions';
import type { P2 } from '../support';

export const CENTROID_FORMAT = 'split-decision/centroid@1';
export const KICK_LABELS: readonly MoveLabel[] = ['front_kick', 'low_kick', 'head_kick'];
export const CENTROID_LABELS: readonly MoveLabel[] = ['jab', 'cross', 'hook', 'uppercut', 'overhand', ...KICK_LABELS];
/** Rates ease down this many frames ahead of a demanding segment (as the library's rate tables). */
const RATE_WINDOW_FRAMES = 3;

export interface CentroidMoveJson {
  label: string;
  n: number;
  com: number[]; // mm, x/y interleaved, move frame
  dp: number[]; // mm at 1×, x/y interleaved
  rLimb: number[]; // fastest rate × 100
  rTrunk: number[];
  Lpk: number; // N·m·s at 1×
}

export interface CentroidJson {
  format: string;
  design: string;
  massKg: number;
  zc: number;
  omega0: number;
  fps: number;
  moves: Record<string, CentroidMoveJson>;
}

export interface CentroidTrack {
  n: number;
  fps: number;
  com: Float32Array; // m
  dp: Float32Array; // m at 1×
  rLimb: Float32Array; // min-filtered
  rTrunk: Float32Array;
  Lpk: number;
}

export interface CentroidSet {
  design: string;
  massKg: number;
  zc: number;
  omega0: number;
  tracks: Map<string, CentroidTrack>;
}

type Loader = () => Promise<CentroidJson>;
let loaders: Record<string, Loader> = {};
try {
  loaders = import.meta.glob<CentroidJson>('./centroid/*.json', { import: 'default' });
} catch {
  loaders = {};
}

const sets = new Map<string, CentroidSet | null>();
const loading = new Set<string>();

function minFiltered(src: number[]): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let m = Infinity;
    for (let k = Math.max(0, f - RATE_WINDOW_FRAMES); k <= Math.min(n - 1, f + RATE_WINDOW_FRAMES); k++) m = Math.min(m, src[k]);
    out[f] = m / 100;
  }
  return out;
}

export function parseCentroid(json: CentroidJson): CentroidSet {
  if (json.format !== CENTROID_FORMAT) throw new Error(`centroid table: unsupported format '${json.format}'`);
  const tracks = new Map<string, CentroidTrack>();
  for (const [id, m] of Object.entries(json.moves)) {
    tracks.set(id, {
      n: m.n, fps: json.fps,
      com: Float32Array.from(m.com, (x) => x / 1000),
      dp: Float32Array.from(m.dp, (x) => x / 1000),
      rLimb: minFiltered(m.rLimb),
      rTrunk: minFiltered(m.rTrunk),
      Lpk: m.Lpk,
    });
  }
  return { design: json.design, massKg: json.massKg, zc: json.zc, omega0: json.omega0, tracks };
}

/** Node only: the table read from disk, or null (browser, or none built). */
function readFromDisk(designId: string): CentroidJson | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof proc?.getBuiltinModule !== 'function') return null;
  try {
    const fs = proc.getBuiltinModule('node:fs') as typeof import('node:fs');
    const url = proc.getBuiltinModule('node:url') as typeof import('node:url');
    const rel = './centroid/' + designId + '.json';
    const path = url.fileURLToPath(new URL(rel, import.meta.url));
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, 'utf8')) as CentroidJson;
  } catch {
    return null;
  }
}

/** The centroid tables of a design if they are loaded (starts loading them in the worker otherwise). */
export function centroidSet(designId: string): CentroidSet | null {
  const hit = sets.get(designId);
  if (hit !== undefined) return hit;
  const disk = readFromDisk(designId);
  if (disk) {
    const set = parseCentroid(disk);
    sets.set(designId, set);
    return set;
  }
  const loader = loaders[`./centroid/${designId}.json`];
  if (!loader) {
    sets.set(designId, null);
    return null;
  }
  if (!loading.has(designId)) {
    loading.add(designId);
    loader().then((json) => sets.set(designId, parseCentroid(json)), () => sets.set(designId, null));
  }
  return null;
}

/** Linear sample of a track at clip time `tau` (s at 1×): the COM and Δp₁ (move frame; y flipped for a mirrored playback). */
export function sampleCentroid(t: CentroidTrack, tau: number, mirror: boolean, com: P2, dp: P2): void {
  const f = Math.max(0, Math.min(t.n - 1, tau * t.fps));
  const i0 = Math.floor(f), i1 = Math.min(t.n - 1, i0 + 1), w = f - i0;
  const my = mirror ? -1 : 1;
  com[0] = t.com[2 * i0] + (t.com[2 * i1] - t.com[2 * i0]) * w;
  com[1] = my * (t.com[2 * i0 + 1] + (t.com[2 * i1 + 1] - t.com[2 * i0 + 1]) * w);
  dp[0] = t.dp[2 * i0] + (t.dp[2 * i1] - t.dp[2 * i0]) * w;
  dp[1] = my * (t.dp[2 * i0 + 1] + (t.dp[2 * i1 + 1] - t.dp[2 * i0 + 1]) * w);
}
