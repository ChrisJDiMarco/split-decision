// Guard gaps: which of his target lines his arms cover right now, from the attacker's side. Pure
// function of two BodySnapshots (fists, neck pivot, COM). Measured on real standing guards of the
// modern four (fists at the neck pivot ±5 cm, lead fist 0.2-0.36 m out, rear fist 0.12-0.2 m to
// the side): every line covered. A dropped hand, an arm still out after a punch or a guard held
// above the head opens a line.
import type { Vec3 } from '../../core/types';
import type { BodySnapshot } from './snapshot';

/** Covered (true) or open (false), per line of attack on him. */
export interface GuardRead {
  center: boolean; // a straight shot down the middle to the head
  left: boolean; // the left side of his head (your right hook)
  right: boolean; // the right side of his head (your left hook)
  body: boolean; // his torso under the elbows
}

// All distances scale with his size: k = (neck pivot − COM height) / 0.65 m (SAVATE ≈ 1).
const REF_NECK_OVER_COM_M = 0.65;
const K_MIN = 0.7;
const K_MAX = 1.3;
const CENTER_LAT_M = 0.12; // a fist this close to the centreline covers the straight line
const HAND_LOW_M = 0.1; // a fist more than this below the neck pivot covers no part of the head
const SIDE_LAT_M = 0.06; // a fist may stray this far across the centreline and still cover its side
const SIDE_FWD_M = 0.45; // ... and must be at most this far out in front
const BEHIND_M = 0.05; // a fist behind the head's plane covers nothing
const EXTENDED_M = 0.5; // an arm this far out (still out after a punch) leaves that side of the body bare
const HANDS_HIGH_M = 0.12; // both fists this far above the neck pivot: a high shell, body bare

interface Local { fwd: number; lat: number; dz: number }

function local(p: Vec3, head: Vec3, fx: number, fy: number): Local {
  const dx = p[0] - head[0], dy = p[1] - head[1];
  return { fwd: dx * fx + dy * fy, lat: -dx * fy + dy * fx, dz: p[2] - head[2] };
}

export function sizeScale(opp: BodySnapshot): number {
  const head = opp.headPos;
  if (!head) return 1;
  return Math.max(K_MIN, Math.min(K_MAX, (head[2] - opp.com[2]) / REF_NECK_OVER_COM_M));
}

/** His guard as seen from `me`, or null when it cannot be read (down, headless, no fists). */
export function guardRead(opp: BodySnapshot, me: BodySnapshot): GuardRead | null {
  const head = opp.headPos;
  if (opp.down || !head || !opp.fists) return null;
  const dx = me.com[0] - head[0], dy = me.com[1] - head[1];
  const n = Math.hypot(dx, dy);
  if (n < 1e-6) return null;
  const fx = dx / n, fy = dy / n;
  const k = sizeScale(opp);
  const l = local(opp.fists.l, head, fx, fy);
  const r = local(opp.fists.r, head, fx, fy);
  const up = (f: Local) => f.dz >= -HAND_LOW_M * k && f.fwd >= -BEHIND_M;
  const centers = (f: Local) => up(f) && Math.abs(f.lat) <= CENTER_LAT_M * k && f.fwd <= EXTENDED_M * k;
  const out = (f: Local) => f.fwd > EXTENDED_M * k;
  return {
    center: centers(l) || centers(r),
    left: up(l) && l.lat >= -SIDE_LAT_M * k && l.fwd <= SIDE_FWD_M * k,
    right: up(r) && r.lat <= SIDE_LAT_M * k && r.fwd <= SIDE_FWD_M * k,
    body: !(out(l) || out(r) || (l.dz > HANDS_HIGH_M * k && r.dz > HANDS_HIGH_M * k)),
  };
}
