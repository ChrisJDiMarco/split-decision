// Loading polished moves at run time (move-polish.md §5.1).
//   browser / worker   lazy Vite imports of data/polished/<design>/<moveId>.json, one file per move
//   Node               tools and tests read the JSON straight from disk
// A move whose file is missing, not 'polished', or whose compat hash differs from the robot as built
// now resolves to null: the caller plays the move raw (MotionPlayer + balance engine), as today.
import { compatHash } from './hash';
import { decodePolish, type PolishJson, type PolishedMove } from './format';

type Loader = () => Promise<PolishJson>;
let loaders: Record<string, Loader> = {};
try {
  loaders = import.meta.glob<PolishJson>('../data/polished/*/*.json', { import: 'default' });
} catch {
  loaders = {};
}

const cache = new Map<string, Promise<PolishedMove | null>>();
const hashes = new Map<string, string>();

function hashOf(designId: string): string {
  let h = hashes.get(designId);
  if (!h) {
    h = compatHash(designId);
    hashes.set(designId, h);
  }
  return h;
}

/** File name of a move id (ids contain only [a-z0-9_.]). */
export const polishFile = (moveId: string): string => `${moveId}.json`;

/** Node only: a polish JSON straight from disk, or null (browser, or no such file). */
export function readPolishFromDisk(designId: string, moveId: string): PolishJson | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof proc?.getBuiltinModule !== 'function') return null;
  try {
    const fs = proc.getBuiltinModule('node:fs') as typeof import('node:fs');
    const url = proc.getBuiltinModule('node:url') as typeof import('node:url');
    const rel = '../data/polished/' + designId + '/' + polishFile(moveId);
    const path = url.fileURLToPath(new URL(rel, import.meta.url));
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path, 'utf8')) as PolishJson;
  } catch {
    return null;
  }
}

/** Why a stored polish cannot play now, or null when it can. */
export function polishProblem(json: PolishJson): string | null {
  if (json.status !== 'polished') return `status ${json.status}${json.reason ? ` (${json.reason})` : ''}`;
  const want = hashOf(json.design);
  if (json.hash !== want) return `stale: hash ${json.hash} ≠ ${want} (robot, motors, gyro, physics or player changed)`;
  return null;
}

function accept(json: PolishJson | null): PolishedMove | null {
  if (!json || polishProblem(json)) return null;
  return decodePolish(json);
}

/** The polished version of a move, or null (play it raw). Cached per design and move. */
export function loadPolish(designId: string, moveId: string): Promise<PolishedMove | null> {
  const key = `${designId}/${moveId}`;
  let p = cache.get(key);
  if (!p) {
    const disk = readPolishFromDisk(designId, moveId);
    if (disk) p = Promise.resolve(accept(disk));
    else {
      const loader = loaders[`../data/polished/${designId}/${polishFile(moveId)}`];
      p = loader ? loader().then(accept, () => null) : Promise.resolve(null);
    }
    cache.set(key, p);
  }
  return p;
}

/** Move ids with a stored polish file for a design (any status). */
export function polishedMoveIds(designId: string): string[] {
  const pre = `../data/polished/${designId}/`;
  return Object.keys(loaders)
    .filter((k) => k.startsWith(pre) && !k.endsWith('/index.json'))
    .map((k) => k.slice(pre.length, -'.json'.length))
    .sort();
}
