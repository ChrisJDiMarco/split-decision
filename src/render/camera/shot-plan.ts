// Shot validation and planning. At every cut the director asks planShot() for the best
// variant of a shot (which fence panel, which hard-cam position, which orbit angle), and
// checkPose() re-checks the live pose every frame so a shot that becomes blocked mid-way
// can be cut away from. A pose passes when:
//   - no arena hardware (posts, top rail, truss, fixture cans) sits on a sight line from the
//     lens to either fighter's torso (sightlines.ts);
//   - no hardware fills the frame in front of the subjects (the post-in-the-lens failure);
//   - both fighters fit in the frame at the shot's lens;
//   - no fighter is hugging an outside lens, and neither fighter hides the other.
import type { Corner, Vec3 } from '../../core/types';
import {
  cagePanelOrder, DEFAULT_ASPECT, framePoints, shotPose, sightPoints, WIDE_SLOTS,
  type CameraPose, type Shot, type ShotKind, type Subjects,
} from './shots';
import { firstBlocker, fitFov, frameClutter, segmentDistance } from './sightlines';

export interface ShotCheck {
  ok: boolean;
  penalty: number; // 0 when ok; lower is better when nothing passes
  reasons: string[];
}

export const CHECK = {
  CLUTTER_MAX: 2, // grid rays (of 15) allowed to hit hardware before the subjects
  NEAR_OUTSIDE_M: 1.3, // a fighter this close to a cage-side / hard-cam lens fills it
  NEAR_INSIDE_M: 1.6,
  FIGHTER_R: 0.28, // torso capsule radius when one fighter might hide the other
  FIGHTER_CLEAR_M: 0.55,
  ANCHOR_IGNORE_M: 0.9, // a fighter this close to a debris/replay focus is the subject, not a blocker
  FOV_SLACK_DEG: 0.5,
} as const;

const TWO_SHOTS: ReadonlySet<ShotKind> = new Set<ShotKind>(['wide', 'cage_low', 'overhead', 'follow', 'replay']);
const OUTSIDE: ReadonlySet<ShotKind> = new Set<ShotKind>(['wide', 'cage_low']);
const FIGHTER_OCCLUSION: ReadonlySet<ShotKind> = new Set<ShotKind>(['wide', 'cage_low', 'overhead', 'follow', 'replay']);
const UNCHECKED: ReadonlySet<ShotKind> = new Set<ShotKind>(['establish', 'intro', 'victory']);

const other = (c: Corner): Corner => (c === 0 ? 1 : 0);

/** Points the lens must see for this shot. */
function seenPoints(shot: Shot, pose: CameraPose, s: Subjects): Vec3[] {
  if (TWO_SHOTS.has(shot.kind)) return [...sightPoints(s, 0), ...sightPoints(s, 1)];
  if (shot.kind === 'ots') return sightPoints(s, other(shot.subject));
  if (shot.kind === 'debris') return [pose.target];
  return [];
}

/** Ground-plane distance from `b` to the segment a→t is at least the fighter clearance. */
function clearOf2D(a: Vec3, t: Vec3, b: Vec3): boolean {
  const dx = t[0] - a[0];
  const dy = t[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / len2));
  return Math.hypot(a[0] + dx * u - b[0], a[1] + dy * u - b[1]) >= CHECK.FIGHTER_CLEAR_M;
}

/** Fighter `c` is hidden when every sight line to its torso passes through the other fighter. */
function hiddenBehindOther(pos: Vec3, s: Subjects, c: Corner): boolean {
  const o = s.pos[other(c)];
  const a: Vec3 = [o[0], o[1], 0.25];
  const b: Vec3 = [o[0], o[1], Math.max(o[2], s.headZ[other(c)])];
  return sightPoints(s, c).every((p) => segmentDistance(pos, p, a, b) < CHECK.FIGHTER_R);
}

export function checkPose(shot: Shot, pose: CameraPose, s: Subjects, aspect: number): ShotCheck {
  if (UNCHECKED.has(shot.kind)) return { ok: true, penalty: 0, reasons: [] };
  const reasons: string[] = [];
  let penalty = 0;

  for (const p of seenPoints(shot, pose, s)) {
    const blocker = firstBlocker(pose.pos, p);
    if (blocker) {
      reasons.push(`${blocker.kind} on sight line`);
      penalty += 4;
    }
  }
  const clutter = frameClutter(pose.pos, pose.target, pose.fov, aspect);
  if (clutter > CHECK.CLUTTER_MAX) {
    reasons.push(`hardware fills frame (${clutter} rays)`);
    penalty += clutter - CHECK.CLUTTER_MAX;
  }
  if (TWO_SHOTS.has(shot.kind)) {
    const keep = [...framePoints(s, 0), ...framePoints(s, 1)];
    if (shot.kind === 'replay') keep.push(pose.target);
    if (fitFov(pose.pos, pose.target, keep, aspect) > pose.fov + CHECK.FOV_SLACK_DEG) {
      reasons.push('fighters out of frame');
      penalty += 3;
    }
  }
  if (OUTSIDE.has(shot.kind)) {
    for (const p of s.pos) {
      if (Math.hypot(p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]) < CHECK.NEAR_OUTSIDE_M) {
        reasons.push('fighter on the lens');
        penalty += 3;
      }
    }
  }
  if (FIGHTER_OCCLUSION.has(shot.kind)) {
    for (const c of [0, 1] as const) {
      if (hiddenBehindOther(pose.pos, s, c)) {
        reasons.push(`fighter ${c} hidden`);
        penalty += 2;
      }
    }
  }
  if (shot.kind === 'replay' || shot.kind === 'debris') {
    // A fighter at the shot's focus (the victim under its own flying head, the striker who
    // just landed) is what the shot is aimed at, so it can't stand across the sight line,
    // but it still must not hug the lens.
    const focus = pose.target;
    for (const b of s.pos) {
      const atFocus = Math.hypot(b[0] - focus[0], b[1] - focus[1]) <= CHECK.ANCHOR_IGNORE_M;
      if ((!atFocus && !clearOf2D(pose.pos, pose.target, b)) || Math.hypot(pose.pos[0] - b[0], pose.pos[1] - b[1]) <= CHECK.NEAR_INSIDE_M) {
        reasons.push('fighter blocks the angle');
        penalty += 2;
      }
    }
  }
  return { ok: reasons.length === 0, penalty, reasons };
}

const ORBIT_TURNS = [0, Math.PI, Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4];
const FOLLOW_TURNS = [0, 0.6, -0.6, 1.2, -1.2];
const OVERHEAD_TURNS = [0, Math.PI / 2, -Math.PI / 2, Math.PI];

/** Variants of a shot to try, best first. */
function variants(shot: Shot, s: Subjects): Shot[] {
  switch (shot.kind) {
    case 'cage_low':
      return cagePanelOrder(shot, s).map((slot) => ({ ...shot, slot }));
    case 'wide':
      return WIDE_SLOTS.map((_, slot) => ({ ...shot, slot }));
    case 'replay':
    case 'debris':
      return ORBIT_TURNS.map((turn) => ({ ...shot, angle: shot.angle + turn }));
    case 'follow':
      return FOLLOW_TURNS.map((turn) => ({ ...shot, angle: shot.angle + turn }));
    case 'overhead':
      return OVERHEAD_TURNS.map((turn) => ({ ...shot, angle: shot.angle + turn }));
    case 'ots':
      return [shot, { ...shot, side: shot.side === 1 ? -1 : 1 }];
    default:
      return [shot];
  }
}

export interface PlannedShot {
  shot: Shot;
  check: ShotCheck;
}

/** Shot times probed at the cut: moving shots must stay clear along their path, not just open clear. */
const PROBE_S: Partial<Record<ShotKind, number[]>> = { replay: [0, 1.5, 3], follow: [0, 2.5], overhead: [0, 3], cage_low: [0, 3] };

function checkPath(shot: Shot, s: Subjects, aspect: number): ShotCheck {
  const checks = (PROBE_S[shot.kind] ?? [0]).map((t) => checkPose(shot, shotPose(shot, s, t, aspect), s, aspect));
  return {
    ok: checks.every((c) => c.ok),
    penalty: checks.reduce((sum, c) => sum + c.penalty, 0),
    reasons: [...new Set(checks.flatMap((c) => c.reasons))],
  };
}

/** The first variant of `shot` whose path (with the fighters where they are now) passes checkPose, else the least-bad one. */
export function planShot(shot: Shot, s: Subjects, aspect: number): PlannedShot {
  let best: PlannedShot | null = null;
  for (const cand of variants(shot, s)) {
    const check = checkPath(cand, s, aspect);
    if (check.ok) return { shot: cand, check };
    if (!best || check.penalty < best.check.penalty) best = { shot: cand, check };
  }
  return best!;
}

/**
 * Called once at a cut: rotate the shot to the first orientation (or pick the first camera
 * position) whose sight lines are clear. Deciding at the cut keeps the camera from swinging
 * mid-shot.
 */
export function resolveShot(shot: Shot, s: Subjects, aspect = DEFAULT_ASPECT): Shot {
  return planShot(shot, s, aspect).shot;
}
