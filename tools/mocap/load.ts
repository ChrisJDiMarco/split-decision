// Node-side clip loading for the mocap tools: BVH from assets-src → 60 Hz human track.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBvh } from '../../src/robots/motions/bvh';
import { bvhPath } from '../../src/robots/motions/clips';
import { humanTrack, type HumanTrack } from '../../src/robots/motions/human';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIBRARY_FPS = 60;

const cache = new Map<string, HumanTrack>();

export function loadTrack(clip: string, fps = LIBRARY_FPS): HumanTrack {
  const key = `${clip}@${fps}`;
  let tr = cache.get(key);
  if (!tr) {
    tr = humanTrack(clip, parseBvh(readFileSync(join(ROOT, bvhPath(clip)), 'utf8')), { fps });
    cache.set(key, tr);
  }
  return tr;
}
