// Library (de)serialization and the per-design constants the builder bakes in: the joint mirror
// map and motor speed limits. No Vite-only APIs here, so Node tools and tests can use it.
import type { RobotDesign } from '../../core/types';
import { motor } from '../catalog';
import { decodeAngles, decodeBytes, decodeRoot } from './codec';
import type { RobotModel } from './robot-model';
import { LIBRARY_FORMAT, type LibraryJson, type MirrorMap, type MotionLibrary, type Move, type MoveFilter } from './types';

/** Partner joint name: '_l' ↔ '_r' suffix swap (unpaired joints map to themselves). */
export function partnerName(name: string): string {
  if (name.endsWith('_l')) return `${name.slice(0, -2)}_r`;
  if (name.endsWith('_r')) return `${name.slice(0, -2)}_l`;
  return name;
}

/**
 * Joint-level mirror across the sagittal plane. Reflecting a hinge rotation R(a, θ) by
 * M = diag(1, −1, 1) gives R(M·a, −θ); the partner joint turns about its own axis b, so its angle is
 * −θ when M·a = b and θ when M·a = −b. (Pitch joints keep their sign; roll and yaw flip.)
 */
export function mirrorMap(m: RobotModel): MirrorMap {
  const n = m.joints.length;
  const perm = new Int16Array(n);
  const sign = new Float32Array(n);
  for (const j of m.joints) {
    const partner = m.jointIndex.get(partnerName(j.name)) ?? j.index;
    const b = m.joints[partner].axis;
    const ma = [j.axis[0], -j.axis[1], j.axis[2]];
    const d = ma[0] * b[0] + ma[1] * b[1] + ma[2] * b[2];
    // perm is "where do I read from": joint i takes its (mirrored) value from its partner.
    perm[partner] = j.index;
    sign[partner] = d >= 0 ? -1 : 1;
  }
  return { perm, sign };
}

/** No-load speed of each joint's motor at the joint output (rad/s), in model joint order. */
export function jointSpeedLimits(design: RobotDesign, m: RobotModel): Float32Array {
  const out = new Float32Array(m.joints.length);
  for (const part of design.parts) {
    for (const j of part.joints ?? []) {
      const i = m.jointIndex.get(j.name);
      if (i !== undefined) out[i] = motor(j.motor).noLoadSpeedRadS / (j.gear ?? 1);
    }
  }
  return out;
}

export function parseLibrary(json: LibraryJson): MotionLibrary {
  if (json.format !== LIBRARY_FORMAT) throw new Error(`motion library: unsupported format '${json.format}'`);
  const mirror: MirrorMap = { perm: Int16Array.from(json.mirror.perm), sign: Float32Array.from(json.mirror.sign) };
  const nj = json.joints.length;
  const moves: Move[] = json.moves.map((mj) => {
    const q = decodeAngles(mj.q);
    const root = decodeRoot(mj.root);
    const contacts = decodeBytes(mj.contacts);
    if (q.length !== mj.frames * nj || root.length !== mj.frames * 7 || contacts.length !== mj.frames) {
      throw new Error(`motion library ${json.design}: move '${mj.id}' channel sizes do not match ${mj.frames} frames`);
    }
    const f = json.fps;
    return {
      id: mj.id, label: mj.label, side: mj.side, striker: mj.striker, height: mj.height, loop: mj.loop,
      fps: f, frames: mj.frames, duration: (mj.frames - 1) / f,
      phases: { strike: mj.phases[0] / f, recover: mj.phases[1] / f },
      impact: mj.impact === null ? null : mj.impact / f,
      reach: mj.reach === null ? null : mj.reach / f,
      target: mj.target, peakSpeed: mj.peakSpeed, travel: mj.travel, maxSpeed: mj.maxSpeed, switchesStance: mj.switchesStance ?? false,
      quality: mj.quality, source: mj.source,
      q, root, contacts, mirror,
    };
  });
  const byId = new Map(moves.map((m) => [m.id, m]));
  return {
    design: json.design,
    fps: json.fps,
    joints: json.joints,
    jointSpeedLimit: Float32Array.from(json.jointSpeedLimit),
    mirror,
    moves,
    listMoves: (filter?: MoveFilter) => filterMoves(moves, filter),
    move(id: string): Move {
      const m = byId.get(id);
      if (!m) throw new Error(`motion library ${json.design}: no move '${id}'`);
      return m;
    },
  };
}

export function filterMoves(moves: readonly Move[], filter?: MoveFilter): Move[] {
  if (!filter) return [...moves];
  const labels = filter.label === undefined ? null : new Set(Array.isArray(filter.label) ? filter.label : [filter.label]);
  return moves.filter((m) => (!labels || labels.has(m.label)) && (!filter.side || m.side === filter.side) && (!filter.height || m.height === filter.height));
}
