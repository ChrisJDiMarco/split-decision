// Motion libraries for the tracking controller (src/robots/motions): one per design, decoded
// once and shared by every fighter of that design.
//   worker   the lazy Vite import is started when a controller is built; fighters run the
//            procedural moves until it lands (the walkout takes far longer than the load)
//   Node     tools and tests read the JSON straight from disk (no Vite), synchronously
// Each set also carries what playback needs per move: the robot joint of every library channel
// and, per frame, the fastest time scale the joints' motors allow (so a move plays as fast as
// the hardware can take it, and no faster).
import { loadLibrary, newSample, parseLibrary, sample, type MotionLibrary, type Move, type MoveLabel } from '../../../robots/motions';
import type { LibraryJson } from '../../../robots/motions/types';
import type { RobotRuntime } from '../../sim-context';

/** Share of a joint's no-load speed a playback may ask for: the torque-speed line leaves little
 *  torque near no-load, so the servo lags a target moving faster than this. */
export const SPEED_FRACTION = 0.85;
/** No move is played faster than this multiple of the human source, whatever the motors allow. */
export const MAX_RATE = 2.5;
const RATE_WINDOW_FRAMES = 3; // the rate eases down this many frames (50 ms) ahead of a fast segment
const RATE_SUBSTEPS = 4; // joint speed sampled this many times per frame (the spline peaks between frames)

export type JointMask = 'all' | 'upper' | 'legs';

const UPPER = /^(waist_|neck_|shoulder_|elbow_)/;
const LEGS = /^(hip_|knee_|ankle_)/;

export interface MocapSet {
  lib: MotionLibrary;
  /** r.joints index of each library channel (−1: the robot has no such joint). */
  toRobot: Int16Array;
  /** Library channel of each r.joints index (−1: none). */
  toLib: Int16Array;
  byLabel: Map<MoveLabel, Move[]>;
  /** Fastest time scale each frame of a move allows for the joints in a mask (min-filtered). */
  rates(move: Move, mask: JointMask): Float32Array;
}

const libs = new Map<string, MotionLibrary | null>();
const loading = new Set<string>();
const sets = new WeakMap<RobotRuntime, MocapSet | null>();
// SD_MOCAP=0: no mocap at all; SD_MOCAP=getup: mocap get-ups only (procedural strikes).
const ENV_MODE = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SD_MOCAP;
let enabled = ENV_MODE !== '0';
let strikes = ENV_MODE !== 'getup';

/** Tools and tests: turn mocap playback off (procedural control everywhere) or back on. */
export function setMocapEnabled(on: boolean): void {
  enabled = on;
}

export function mocapEnabled(): boolean {
  return enabled;
}

/** Tools: mocap strikes on or off (get-ups keep playing from the library either way). */
export function setMocapStrikes(on: boolean): void {
  strikes = on;
}

export function mocapStrikesEnabled(): boolean {
  return strikes;
}

/** Make a decoded library available (the worker's lazy import calls this when it lands). */
export function registerLibrary(lib: MotionLibrary): void {
  libs.set(lib.design, lib);
}

/** Node only: the design's generated library read from disk, or null (browser, or none built). */
function readFromDisk(designId: string): MotionLibrary | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof proc?.getBuiltinModule !== 'function') return null;
  try {
    const fs = proc.getBuiltinModule('node:fs') as typeof import('node:fs');
    const url = proc.getBuiltinModule('node:url') as typeof import('node:url');
    // A variable, not a literal: Vite must not turn this into a bundled asset URL.
    const rel = '../../../robots/motions/data/' + designId + '.json';
    const path = url.fileURLToPath(new URL(rel, import.meta.url));
    if (!fs.existsSync(path)) return null;
    return parseLibrary(JSON.parse(fs.readFileSync(path, 'utf8')) as LibraryJson);
  } catch {
    return null;
  }
}

/** The library of a design, if it is loaded (starts loading it in the worker otherwise). */
export function motionLibrary(designId: string): MotionLibrary | null {
  if (!enabled) return null;
  const hit = libs.get(designId);
  if (hit !== undefined) return hit;
  const disk = readFromDisk(designId);
  if (disk) {
    libs.set(designId, disk);
    return disk;
  }
  if (!loading.has(designId)) {
    loading.add(designId);
    loadLibrary(designId).then(registerLibrary, () => libs.set(designId, null));
  }
  return null;
}

/** The playback set for a robot (null until its design's library is loaded, or if it has none). */
export function mocapSet(r: RobotRuntime): MocapSet | null {
  if (!enabled) return null;
  const hit = sets.get(r);
  if (hit) return hit;
  const lib = motionLibrary(r.design.id);
  if (!lib) return null;
  const set = buildSet(r, lib);
  sets.set(r, set);
  return set;
}

function buildSet(r: RobotRuntime, lib: MotionLibrary): MocapSet {
  const toRobot = new Int16Array(lib.joints.length).fill(-1);
  const toLib = new Int16Array(r.joints.length).fill(-1);
  lib.joints.forEach((name, j) => {
    const i = r.jointIndex.get(name);
    if (i === undefined) return;
    toRobot[j] = i;
    toLib[i] = j;
  });
  const byLabel = new Map<MoveLabel, Move[]>();
  for (const m of lib.moves) {
    const list = byLabel.get(m.label) ?? [];
    list.push(m);
    byLabel.set(m.label, list);
  }
  const cache = new WeakMap<Move, Partial<Record<JointMask, Float32Array>>>();
  // The robot's own motors set the speed limits, not the library's snapshot of them (a design's
  // actuators can change without its moves being rebuilt: the strike pass, docs/research/08).
  // (A stand-in runtime without motors, as the footwork tests build, keeps the library's.)
  const speedLimit = Float64Array.from(lib.joints, (_, j) => (toRobot[j] >= 0 ? r.joints[toRobot[j]]?.motor?.noLoadSpeedRadS : undefined) ?? lib.jointSpeedLimit[j]);
  const masks: Record<JointMask, boolean[]> = {
    all: lib.joints.map(() => true),
    upper: lib.joints.map((n) => UPPER.test(n)),
    legs: lib.joints.map((n) => LEGS.test(n)),
  };
  return {
    lib, toRobot, toLib, byLabel,
    rates(move, mask) {
      const c = cache.get(move) ?? {};
      let t = c[mask];
      if (!t) {
        t = rateTable(lib, move, masks[mask], speedLimit);
        c[mask] = t;
        cache.set(move, c);
      }
      return t;
    },
  };
}

/**
 * Per frame, the largest time scale at which every masked joint stays under SPEED_FRACTION of its
 * motor's no-load speed (`speedLimit`, the robot's own motors; capped at MAX_RATE), then min-filtered so playback slows before a fast
 * segment rather than inside it. Joint speed is the sampler's own spline derivative, taken a few
 * times across each frame's half-width either side (the lookup rounds to the nearest frame): a
 * Catmull-Rom spline runs up to ~1.5x the frame-difference speed between frames.
 */
function rateTable(lib: MotionLibrary, move: Move, mask: boolean[], speedLimit: ArrayLike<number>): Float32Array {
  const nj = lib.joints.length;
  const n = move.frames;
  const raw = new Float32Array(n);
  const s = newSample(nj);
  for (let f = 0; f < n; f++) {
    let lim = MAX_RATE;
    for (let k = 0; k < RATE_SUBSTEPS; k++) {
      const t = Math.min(move.duration, Math.max(0, (f - 0.5 + (k + 0.5) / RATE_SUBSTEPS) / move.fps));
      sample(move, t, { speed: 1, loop: false }, s);
      for (let j = 0; j < nj; j++) {
        if (!mask[j]) continue;
        const v = Math.abs(s.qd[j]);
        if (v > 1e-6) lim = Math.min(lim, (SPEED_FRACTION * speedLimit[j]) / v);
      }
    }
    raw[f] = lim;
  }
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let m = raw[f];
    for (let k = Math.max(0, f - RATE_WINDOW_FRAMES); k <= Math.min(n - 1, f + RATE_WINDOW_FRAMES); k++) m = Math.min(m, raw[k]);
    out[f] = m;
  }
  return out;
}
