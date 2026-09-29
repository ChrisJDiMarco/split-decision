// Motion library runtime API (mocap-derived moves for the tracking controller).
//
//   const lib = await loadLibrary('striker');
//   const jab = lib.listMoves({ label: 'jab' })[0];
//   const s = sample(jab, t, { speed: speedFor(jab, 1.3), mirror: southpaw }, scratch);
//   placeSample(s, startX, startY, facingYaw);      // move frame → arena frame
//   s.q / s.qd → servo targets and feed-forward (lib.joints order); s.rootPos / rootQuat → balance
//   targets; s.contacts → which feet / hands / knees should bear weight now.
//
// Libraries are generated per design by `npx tsx tools/mocap/build-library.ts` into ./data.
import { parseLibrary } from './library';
import type { LibraryJson, MotionLibrary } from './types';

export { CONTACT, CONTACT_NAMES } from './contacts';
export { filterMoves, mirrorMap, parseLibrary } from './library';
export { blendSamples, mirrorContacts, newSample, placeSample, sample, speedFor } from './sampler';
export { ANGLE_LABELS, FLASHY_LABELS, MOVE_LABELS } from './types';
export type {
  LimbSide, MirrorMap, MotionLibrary, MotionSample, Move, MoveFilter, MoveFlight, MoveLabel, MovePhase, MoveQuality, MoveSource,
  SampleOptions, StrikeHeight,
} from './types';

type Loader = () => Promise<LibraryJson>;

// Vite rewrites this call into lazy imports of every generated library. Outside Vite (plain Node
// tools) it throws; those use parseLibrary on the JSON directly.
let loaders: Record<string, Loader> = {};
try {
  loaders = import.meta.glob<LibraryJson>('./data/*.json', { import: 'default' });
} catch {
  loaders = {};
}

const cache = new Map<string, Promise<MotionLibrary>>();

/** Design ids that have a generated library. */
export function libraryDesigns(): string[] {
  return Object.keys(loaders).map((k) => k.replace(/^.*\/(.+)\.json$/, '$1')).sort();
}

/** Load (once) and decode the motion library of a design. */
export function loadLibrary(designId: string): Promise<MotionLibrary> {
  let p = cache.get(designId);
  if (!p) {
    const loader = loaders[`./data/${designId}.json`];
    if (!loader) return Promise.reject(new Error(`no motion library for design '${designId}': run npx tsx tools/mocap/build-library.ts`));
    p = loader().then(parseLibrary);
    cache.set(designId, p);
    p.catch(() => cache.delete(designId));
  }
  return p;
}

/** All moves of a loaded library, optionally filtered (same as lib.listMoves). */
export function listMoves(lib: MotionLibrary, filter?: Parameters<MotionLibrary['listMoves']>[0]): ReturnType<MotionLibrary['listMoves']> {
  return lib.listMoves(filter);
}
