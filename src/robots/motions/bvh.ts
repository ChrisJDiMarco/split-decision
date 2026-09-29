// BVH motion capture parser and forward kinematics. Pure string → data, no Node or DOM APIs, so
// the offline tools and the browser preview share it.
//
//   const clip = parseBvh(text);
//   const pose = bvhPose(clip, frame);            // world positions and rotations of every joint
//
// Conventions (the BVH ones): rotation channels compose in the order listed, so
// "Zrotation Yrotation Xrotation" means R = Rz·Ry·Rx; a joint's world transform is
// parent · T(offset) · R(channels). Position channels replace the matching offset component
// (the three.js BVHLoader behaviour; CMU roots have a zero offset so both readings agree).
// Angles in the file are degrees; units are whatever the file uses (CMU: 1/0.45 inch).
import type { Vec3 } from '../../core/types';
import { axisAngle, mulMM, mulMV, type Mat3 } from './math';

export type BvhChannel = 'Xposition' | 'Yposition' | 'Zposition' | 'Xrotation' | 'Yrotation' | 'Zrotation';

const CHANNELS: readonly BvhChannel[] = ['Xposition', 'Yposition', 'Zposition', 'Xrotation', 'Yrotation', 'Zrotation'];

export interface BvhJoint {
  name: string;
  index: number;
  parent: number; // -1 for the root
  offset: Vec3;
  channels: BvhChannel[];
  channelStart: number; // column of the first channel in a frame row
  endSite: Vec3 | null; // End Site offset in this joint's frame, if the joint ends a chain
  children: number[];
}

export interface BvhClip {
  joints: BvhJoint[];
  jointIndex: Map<string, number>;
  channelCount: number;
  frameCount: number;
  frameTime: number; // seconds
  /** frameCount × channelCount values, row-major, as written in the file. */
  data: Float32Array;
}

export class BvhParseError extends Error {}

class Tokens {
  private i = 0;
  constructor(private readonly t: string[]) {}
  next(): string {
    if (this.i >= this.t.length) throw new BvhParseError('unexpected end of file');
    return this.t[this.i++];
  }
  peek(): string | undefined {
    return this.t[this.i];
  }
  expect(word: string): void {
    const got = this.next();
    if (got !== word) throw new BvhParseError(`expected '${word}', got '${got}'`);
  }
  number(): number {
    const s = this.next();
    const v = Number(s);
    if (!Number.isFinite(v)) throw new BvhParseError(`expected a number, got '${s}'`);
    return v;
  }
  get position(): number {
    return this.i;
  }
  set position(v: number) {
    this.i = v;
  }
}

function parseJoint(tk: Tokens, name: string, parent: number, joints: BvhJoint[], channelCursor: { n: number }): number {
  const index = joints.length;
  const joint: BvhJoint = { name, index, parent, offset: [0, 0, 0], channels: [], channelStart: channelCursor.n, endSite: null, children: [] };
  joints.push(joint);
  if (parent >= 0) joints[parent].children.push(index);
  tk.expect('{');
  for (;;) {
    const word = tk.next();
    if (word === '}') break;
    if (word === 'OFFSET') {
      joint.offset = [tk.number(), tk.number(), tk.number()];
    } else if (word === 'CHANNELS') {
      const n = tk.number();
      joint.channelStart = channelCursor.n;
      for (let k = 0; k < n; k++) {
        const c = tk.next() as BvhChannel;
        if (!CHANNELS.includes(c)) throw new BvhParseError(`joint '${name}': unknown channel '${c}'`);
        joint.channels.push(c);
      }
      channelCursor.n += n;
    } else if (word === 'JOINT') {
      parseJoint(tk, tk.next(), index, joints, channelCursor);
    } else if (word === 'End') {
      tk.expect('Site');
      tk.expect('{');
      tk.expect('OFFSET');
      joint.endSite = [tk.number(), tk.number(), tk.number()];
      tk.expect('}');
    } else {
      throw new BvhParseError(`joint '${name}': unexpected '${word}'`);
    }
  }
  return index;
}

/** Parse BVH text (hierarchy + motion). Throws BvhParseError on malformed input. */
export function parseBvh(text: string): BvhClip {
  const tokens = text.split(/\s+/).filter((s) => s.length > 0);
  const tk = new Tokens(tokens);
  tk.expect('HIERARCHY');
  const joints: BvhJoint[] = [];
  const cursor = { n: 0 };
  tk.expect('ROOT');
  parseJoint(tk, tk.next(), -1, joints, cursor);
  if (tk.peek() === 'ROOT') throw new BvhParseError('multiple ROOT hierarchies are not supported');
  tk.expect('MOTION');
  tk.expect('Frames:');
  const frameCount = tk.number();
  tk.expect('Frame');
  tk.expect('Time:');
  const frameTime = tk.number();
  if (!(frameTime > 0)) throw new BvhParseError(`bad frame time ${frameTime}`);
  const channelCount = cursor.n;
  const data = new Float32Array(frameCount * channelCount);
  for (let i = 0; i < data.length; i++) data[i] = tk.number();
  if (tk.peek() !== undefined) throw new BvhParseError(`${tokens.length - tk.position} values after the last frame`);
  const jointIndex = new Map(joints.map((j) => [j.name, j.index]));
  return { joints, jointIndex, channelCount, frameCount, frameTime, data };
}

// ---------------------------------------------------------------- forward kinematics

export interface BvhPose {
  /** World position of each joint origin, joints × 3. */
  pos: Float64Array;
  /** World rotation of each joint frame, joints × 9 (row-major). */
  rot: Float64Array;
  /** World position of each End Site (NaN for joints without one), joints × 3. */
  end: Float64Array;
}

export function newBvhPose(clip: BvhClip): BvhPose {
  const n = clip.joints.length;
  return { pos: new Float64Array(n * 3), rot: new Float64Array(n * 9), end: new Float64Array(n * 3).fill(Number.NaN) };
}

const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
const DEG = Math.PI / 180;

/** Local rotation and translation of a joint for one frame. */
export function bvhLocal(clip: BvhClip, joint: BvhJoint, frame: number): { t: Vec3; r: Mat3 } {
  const row = frame * clip.channelCount + joint.channelStart;
  const t: Vec3 = [...joint.offset];
  let r: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let k = 0; k < joint.channels.length; k++) {
    const v = clip.data[row + k];
    switch (joint.channels[k]) {
      case 'Xposition': t[0] = v; break;
      case 'Yposition': t[1] = v; break;
      case 'Zposition': t[2] = v; break;
      case 'Xrotation': r = mulMM(r, axisAngle(X, v * DEG)); break;
      case 'Yrotation': r = mulMM(r, axisAngle(Y, v * DEG)); break;
      case 'Zrotation': r = mulMM(r, axisAngle(Z, v * DEG)); break;
    }
  }
  return { t, r };
}

/** World pose of every joint at `frame` (parents always precede children in `joints`). */
export function bvhPose(clip: BvhClip, frame: number, out: BvhPose = newBvhPose(clip)): BvhPose {
  if (frame < 0 || frame >= clip.frameCount) throw new RangeError(`frame ${frame} outside 0..${clip.frameCount - 1}`);
  for (const j of clip.joints) {
    const { t, r } = bvhLocal(clip, j, frame);
    let R: Mat3 = r;
    let p: Vec3 = t;
    if (j.parent >= 0) {
      const pr = readMat(out.rot, j.parent);
      const pp = readVec(out.pos, j.parent);
      R = mulMM(pr, r);
      const o = mulMV(pr, t);
      p = [pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]];
    }
    out.rot.set(R, j.index * 9);
    out.pos.set(p, j.index * 3);
    if (j.endSite) {
      const e = mulMV(R, j.endSite);
      out.end.set([p[0] + e[0], p[1] + e[1], p[2] + e[2]], j.index * 3);
    }
  }
  return out;
}

export function readVec(arr: ArrayLike<number>, i: number): Vec3 {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

export function readMat(arr: ArrayLike<number>, i: number): Mat3 {
  const o = i * 9;
  return [arr[o], arr[o + 1], arr[o + 2], arr[o + 3], arr[o + 4], arr[o + 5], arr[o + 6], arr[o + 7], arr[o + 8]];
}

/** Channel values of one joint in one frame (for tests and debugging). */
export function channelValues(clip: BvhClip, joint: string, frame: number): number[] {
  const j = clip.joints[clip.jointIndex.get(joint) ?? -1];
  if (!j) throw new Error(`no joint '${joint}'`);
  const row = frame * clip.channelCount + j.channelStart;
  return Array.from(clip.data.subarray(row, row + j.channels.length));
}

/**
 * True when frame 0 is a bind/reference pose rather than motion. The CMU conversions start every
 * file with the ASF rest pose: every rotation channel an integer (mostly 0), the root copied from
 * frame 1. Motion frames never look like that.
 */
export function firstFrameIsRestPose(clip: BvhClip): boolean {
  if (clip.frameCount < 2) return false;
  let rotations = 0, integers = 0;
  for (const j of clip.joints) {
    for (let k = 0; k < j.channels.length; k++) {
      if (!j.channels[k].endsWith('rotation')) continue;
      rotations++;
      const v = clip.data[j.channelStart + k];
      if (Math.abs(v - Math.round(v)) < 1e-6) integers++;
    }
  }
  return rotations > 0 && integers / rotations > 0.95;
}
