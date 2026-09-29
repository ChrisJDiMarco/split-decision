// Sampling, mirroring, blending and placing library moves. Pure math over typed arrays: runs in
// the physics worker at control rate without allocating (pass `out`).
import type { Quat, Vec3 } from '../../core/types';
import { CONTACT } from './contacts';
import { quatMul, quatNormalize, quatSlerp, quatYaw } from './math';
import type { MirrorMap, MotionSample, Move, MovePhase, SampleOptions } from './types';

export function newSample(joints: number): MotionSample {
  return {
    time: 0, phase: 'windup', phaseU: 0,
    q: new Float64Array(joints), qd: new Float64Array(joints),
    rootPos: [0, 0, 0], rootQuat: [1, 0, 0, 0], rootVel: [0, 0, 0],
    contacts: 0, done: false,
  };
}

const jointsOf = (move: Move): number => move.q.length / move.frames;

/** Swap left/right contact bits. */
export function mirrorContacts(c: number): number {
  const swap = (a: number, b: number) => ((c & a) ? b : 0) | ((c & b) ? a : 0);
  return swap(CONTACT.FOOT_L, CONTACT.FOOT_R) | swap(CONTACT.HAND_L, CONTACT.HAND_R) | swap(CONTACT.KNEE_L, CONTACT.KNEE_R)
    | (c & (CONTACT.HIPS | CONTACT.CHEST));
}

function phaseOf(move: Move, tau: number): [MovePhase, number] {
  const { strike, recover } = move.phases;
  if (tau < strike) return ['windup', strike > 0 ? tau / strike : 1];
  if (tau < recover) return ['strike', (tau - strike) / Math.max(1e-6, recover - strike)];
  return ['recover', move.duration > recover ? Math.min(1, (tau - recover) / (move.duration - recover)) : 1];
}

/**
 * Sample a move at wall time `t` seconds after it started.
 *   speed    time scale (2 = twice as fast; keep ≤ move.maxSpeed to stay within motor limits)
 *   mirror   southpaw: swap sides (moves are stored orthodox)
 *   loop     wrap (default move.loop); looping walks accumulate their stride
 * Returns joint targets, joint velocities (for servo feed-forward), the pelvis pose relative to
 * the move start in the facing frame, and the contact flags.
 */
export function sample(move: Move, t: number, opts: SampleOptions = {}, out?: MotionSample): MotionSample {
  const nj = jointsOf(move);
  const s = out ?? newSample(nj);
  const speed = opts.speed ?? 1;
  const loop = opts.loop ?? move.loop;
  const dur = move.duration;
  let tau = Math.max(0, t * speed);
  let cycles = 0;
  s.done = false;
  if (loop && dur > 0) {
    cycles = Math.floor(tau / dur);
    tau -= cycles * dur;
  } else if (tau >= dur) {
    tau = dur;
    s.done = true;
  }
  const fpos = tau * move.fps;
  const i0 = Math.min(move.frames - 1, Math.floor(fpos));
  const i1 = Math.min(move.frames - 1, i0 + 1);
  const w = i1 === i0 ? 0 : fpos - i0;
  const rate = move.fps * speed;

  // Joints: cubic Hermite through the frames with Catmull-Rom tangents, so targets are smooth
  // (C1) between the 60 Hz frames and qd is their exact derivative (servo feed-forward without a
  // velocity step every frame). A held last frame has zero velocity.
  const q = move.q;
  const mirror: MirrorMap | null = opts.mirror ? move.mirror : null;
  const last = move.frames - 1;
  const cyclic = loop && move.loop; // stored loops repeat their first frame as their last
  const nb = (k: number, d: -1 | 1): number => {
    const x = k + d;
    if (x < 0) return cyclic ? last - 1 : 0;
    if (x > last) return cyclic ? 1 : last;
    return x;
  };
  /** Neighbours of frame k and how many frame steps lie between them (2 inside, 1 at an end). */
  const span = (k: number) => {
    const lo = nb(k, -1), hi = nb(k, 1);
    return { lo, hi, steps: Math.max(1, (lo === k ? 0 : 1) + (hi === k ? 0 : 1)) };
  };
  const t0 = span(i0), t1 = span(i1);
  const w2 = w * w, w3 = w2 * w;
  const h00 = 2 * w3 - 3 * w2 + 1, h10 = w3 - 2 * w2 + w, h01 = -2 * w3 + 3 * w2, h11 = w3 - w2;
  const d00 = 6 * w2 - 6 * w, d10 = 3 * w2 - 4 * w + 1, d01 = -6 * w2 + 6 * w, d11 = 3 * w2 - 2 * w;
  for (let j = 0; j < nj; j++) {
    const src = mirror ? mirror.perm[j] : j;
    const sg = mirror ? mirror.sign[j] : 1;
    const a = q[i0 * nj + src], b = q[i1 * nj + src];
    const m0 = (q[t0.hi * nj + src] - q[t0.lo * nj + src]) / t0.steps;
    const m1 = (q[t1.hi * nj + src] - q[t1.lo * nj + src]) / t1.steps;
    if (i1 === i0) {
      s.q[j] = sg * a;
      s.qd[j] = s.done ? 0 : sg * m0 * rate;
    } else {
      s.q[j] = sg * (h00 * a + h10 * m0 + h01 * b + h11 * m1);
      s.qd[j] = sg * (d00 * a + d10 * m0 + d01 * b + d11 * m1) * rate;
    }
  }

  const r = move.root;
  const a0 = i0 * 7, a1 = i1 * 7;
  let x = r[a0] + (r[a1] - r[a0]) * w;
  let y = r[a0 + 1] + (r[a1 + 1] - r[a0 + 1]) * w;
  const z = r[a0 + 2] + (r[a1 + 2] - r[a0 + 2]) * w;
  if (cycles > 0) {
    const last = (move.frames - 1) * 7;
    x += cycles * (r[last] - r[0]);
    y += cycles * (r[last + 1] - r[1]);
  }
  const qa: Quat = [r[a0 + 3], r[a0 + 4], r[a0 + 5], r[a0 + 6]];
  const qb: Quat = [r[a1 + 3], r[a1 + 4], r[a1 + 5], r[a1 + 6]];
  const rq = quatSlerp(qa, qb, w);
  const k0 = i1 === i0 ? Math.max(0, i0 - 1) : i0;
  const k1 = i1 === i0 ? i0 : i1;
  const vx = k1 === k0 ? 0 : (r[k1 * 7] - r[k0 * 7]) * rate;
  const vy = k1 === k0 ? 0 : (r[k1 * 7 + 1] - r[k0 * 7 + 1]) * rate;
  const vz = k1 === k0 ? 0 : (r[k1 * 7 + 2] - r[k0 * 7 + 2]) * rate;
  const my = mirror ? -1 : 1;
  s.rootPos = [x, y * my, z];
  s.rootVel = [vx, vy * my, vz];
  s.rootQuat = mirror ? [rq[0], -rq[1], rq[2], -rq[3]] : rq;
  const c = move.contacts[w < 0.5 ? i0 : i1];
  s.contacts = mirror ? mirrorContacts(c) : c;
  s.time = tau;
  const [phase, u] = phaseOf(move, tau);
  s.phase = phase;
  s.phaseU = u;
  return s;
}

/**
 * Blend two samples expressed in the same frame (w = 0 → a, 1 → b). Joint targets, velocities
 * and root position lerp, the root attitude slerps; contacts and phase come from the dominant one.
 */
export function blendSamples(a: MotionSample, b: MotionSample, w: number, out?: MotionSample): MotionSample {
  const n = a.q.length;
  const s = out ?? newSample(n);
  const k = Math.min(1, Math.max(0, w));
  for (let j = 0; j < n; j++) {
    s.q[j] = a.q[j] + (b.q[j] - a.q[j]) * k;
    s.qd[j] = a.qd[j] + (b.qd[j] - a.qd[j]) * k;
  }
  const lerp3 = (p: Vec3, r: Vec3): Vec3 => [p[0] + (r[0] - p[0]) * k, p[1] + (r[1] - p[1]) * k, p[2] + (r[2] - p[2]) * k];
  s.rootPos = lerp3(a.rootPos, b.rootPos);
  s.rootVel = lerp3(a.rootVel, b.rootVel);
  s.rootQuat = quatSlerp(a.rootQuat, b.rootQuat, k);
  const dom = k < 0.5 ? a : b;
  s.contacts = dom.contacts;
  s.phase = dom.phase;
  s.phaseU = dom.phaseU;
  s.time = dom.time;
  s.done = b.done;
  return s;
}

/**
 * Express a move-frame sample in the arena: the move started with the pelvis over (x, y) facing
 * `yaw` (the direction to the opponent). Root position, velocity and attitude are rewritten in
 * place; joints are frame-independent.
 */
export function placeSample(s: MotionSample, x: number, y: number, yaw: number, out: MotionSample = s): MotionSample {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const [px, py, pz] = s.rootPos;
  const [vx, vy, vz] = s.rootVel;
  if (out !== s) {
    out.q.set(s.q);
    out.qd.set(s.qd);
    out.contacts = s.contacts;
    out.phase = s.phase;
    out.phaseU = s.phaseU;
    out.time = s.time;
    out.done = s.done;
  }
  out.rootPos = [x + c * px - sn * py, y + sn * px + c * py, pz];
  out.rootVel = [c * vx - sn * vy, sn * vx + c * vy, vz];
  out.rootQuat = quatNormalize(quatMul(quatYaw(yaw), s.rootQuat));
  return out;
}

/** Fastest time scale the move allows within motor limits, capped by what the caller wants. */
export const speedFor = (move: Move, desired = 1): number => Math.max(0.05, Math.min(desired, move.maxSpeed));
