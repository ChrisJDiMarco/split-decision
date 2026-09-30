// Camera director: picks broadcast shots, holds each for at least MIN_SHOT_S, and cuts
// on big impacts, detaches and falls. During a referee break (a knockdown) the rotation only uses
// two-shots centred on the downed fighter getting up, with the standing one at his neutral spot in
// frame; FIGHT cuts back to the wide. Every cut is planned against the arena's sight lines
// (shot-plan.ts): a shot with no clear variant falls back to the next best kind, and a shot
// that gets blocked mid-way is cut away from once it has run MIN_SHOT_S. Pure logic
// (seeded rng), unit-tested.
import type { SimEvent } from '../../core/protocol';
import type { Corner, Vec3 } from '../../core/types';
import { strikeStrength } from '../vfx/scaling';
import { checkPose, planShot, type PlannedShot, type ShotCheck } from './shot-plan';
import { DEFAULT_ASPECT, hardCamSide, shotPose, type CameraPose, type Shot, type ShotKind, type Subjects } from './shots';

export type DirectorMode = 'idle' | 'live' | 'intro' | 'replay' | 'victory';

export const DIRECTOR = {
  MIN_SHOT_S: 2,
  CUT_IMPACT_J: 180, // impacts above this cut to a reaction shot
  CUT_STRENGTH: 0.72, // ...and so do landed hits this strong (vfx/scaling hitStrength: ~30 J on the electric roster)
  CUT_LOW_STRENGTH: 0.9, // the hardest of those cut cage-side low
  PENDING_TTL_S: 2, // a queued reaction cut goes stale after this (>= MIN_SHOT_S so early hits still land)
  INTRO_SHOT_S: 2.6,
  BLOCKED_GRACE_S: 0.25, // a pose must stay blocked this long before it forces a cut
} as const;

/** Where to go when no variant of a shot is clear, in order. */
const FALLBACK: Partial<Record<ShotKind, ShotKind[]>> = {
  wide: ['overhead', 'cage_low', 'follow'],
  cage_low: ['follow', 'wide', 'overhead'],
  follow: ['cage_low', 'wide', 'overhead'],
  ots: ['follow', 'wide', 'overhead'],
  overhead: ['wide', 'cage_low', 'follow'],
  debris: ['follow', 'overhead'],
};

/**
 * Referee break rotation: two-shots only (shot-plan checks that both fighters fit), the subject is the
 * fighter getting up. follow weights its target 0.7 on him and fits the other in; cage_low and wide
 * frame both from outside the fence.
 */
const BREAK_ROTATION: Array<{ kind: ShotKind; weight: number; min: number; max: number }> = [
  { kind: 'follow', weight: 0.45, min: 3.5, max: 5.5 },
  { kind: 'cage_low', weight: 0.35, min: 3, max: 4.5 },
  { kind: 'wide', weight: 0.2, min: 4, max: 6 },
];

/** What the director reads of the referee (RobotTelemetry.referee). */
type RefTel = { down: boolean; referee?: { break: boolean; role?: string } };

/** Live rotation: weight and duration range per shot. */
const ROTATION: Array<{ kind: ShotKind; weight: number; min: number; max: number }> = [
  { kind: 'wide', weight: 0.32, min: 4, max: 7 },
  { kind: 'follow', weight: 0.24, min: 3, max: 5 },
  { kind: 'cage_low', weight: 0.2, min: 2.5, max: 4 },
  { kind: 'ots', weight: 0.14, min: 2.5, max: 4 },
  { kind: 'overhead', weight: 0.1, min: 2.5, max: 3.5 },
];

export interface DirectorOutput {
  pose: CameraPose;
  cut: boolean; // true on the frame a new shot starts (the rig snaps instead of easing)
  shot: Shot;
}

interface PendingCut {
  shot: Omit<Shot, 'side'>;
  queuedAt: number;
  priority: number;
}

export class Director {
  mode: DirectorMode = 'live';
  shot: Shot;
  shotTime = 0;
  /** Viewport aspect (width / height); the broadcast keeps it in sync with the stage camera. */
  aspect: number = DEFAULT_ASPECT;
  /** The current pose's sight-line check (debug handle: splitDecision.broadcast.camera.director.status). */
  status: ShotCheck = { ok: true, penalty: 0, reasons: [] };
  /** Seconds the current pose has been failing its check. */
  blockedFor = 0;
  private shotLen = 5;
  private clock = 0;
  private cutFlag = true;
  private pending: PendingCut | null = null;
  private introQueue: Array<Omit<Shot, 'side'>> = [];
  private prevKind: ShotKind | null = null;
  /** During a referee break: the fighter getting up (the lower corner on a double knockdown); null while they fight. */
  private breakDown: Corner | null = null;

  constructor(private rng: () => number = Math.random) {
    this.shot = { kind: 'wide', subject: 0, side: 1, anchor: null, focusBody: null, angle: 0 };
  }

  setMode(mode: DirectorMode, opts: { subject?: Corner; anchor?: Vec3 | null } = {}): void {
    this.mode = mode;
    this.pending = null;
    const subject = opts.subject ?? 0;
    if (mode === 'idle') {
      this.startShot({ kind: 'establish', subject, anchor: null, focusBody: null, angle: -Math.PI / 2 }, Infinity);
    } else if (mode === 'live') {
      this.startShot({ kind: 'wide', subject, anchor: null, focusBody: null, angle: 0 }, 5);
    } else if (mode === 'intro') {
      this.introQueue = [
        { kind: 'intro', subject: 0, anchor: null, focusBody: null, angle: Math.PI * 0.15 },
        { kind: 'intro', subject: 1, anchor: null, focusBody: null, angle: Math.PI * 1.15 },
        { kind: 'overhead', subject: 0, anchor: null, focusBody: null, angle: 0 },
      ];
      this.startShot(this.introQueue.shift()!, DIRECTOR.INTRO_SHOT_S);
    } else if (mode === 'replay') {
      this.startShot({ kind: 'replay', subject, anchor: opts.anchor ?? null, focusBody: null, angle: this.rng() * Math.PI * 2 }, Infinity);
    } else {
      this.startShot({ kind: 'victory', subject, anchor: null, focusBody: null, angle: this.rng() * Math.PI * 2 }, Infinity);
    }
  }

  /** Force a specific shot now (harness, replay second angle). Ignores MIN_SHOT_S. */
  cut(kind: ShotKind, subject: Corner = this.shot.subject, extra: Partial<Shot> = {}): void {
    this.startShot({ kind, subject, anchor: extra.anchor ?? null, focusBody: extra.focusBody ?? null, angle: extra.angle ?? this.rng() * Math.PI * 2 }, this.pickLen(kind));
  }

  /** The fighter the referee is waiting on (a break), or null while they fight. */
  get breakSubject(): Corner | null {
    return this.breakDown;
  }

  /**
   * `tel`: the frame's telemetry, so a ground scramble (striker down) doesn't read as a big hit, and
   * the referee's break (who is getting up) steers the rotation.
   */
  onEvents(events: readonly SimEvent[], tel?: readonly RefTel[] | null): void {
    if (tel) this.breakDown = breakSubjectOf(tel, this.breakDown);
    if (this.mode !== 'live') return;
    for (const ev of events) {
      const req = reactionFor(ev, tel);
      if (req && (!this.pending || req.priority >= this.pending.priority)) {
        this.pending = { ...req, queuedAt: this.clock };
      }
    }
  }

  update(dt: number, subjects: Subjects): DirectorOutput {
    this.clock += dt;
    this.shotTime += dt;
    if (this.mode === 'live') this.updateLive(subjects);
    else if (this.mode === 'intro' && this.shotTime >= this.shotLen && this.introQueue.length) {
      this.startShot(this.introQueue.shift()!, DIRECTOR.INTRO_SHOT_S);
    } else if (this.mode === 'replay' && this.blockedFor >= DIRECTOR.BLOCKED_GRACE_S && this.shotTime >= DIRECTOR.MIN_SHOT_S) {
      // The orbit swung behind a fighter: cut to a fresh, clear replay angle.
      this.startShot({ ...this.shot, angle: this.shot.angle + Math.PI / 2 }, Infinity);
    }
    if (this.cutFlag) this.shot = this.plan({ ...this.shot, side: hardCamSide(subjects) }, subjects);
    const cut = this.cutFlag;
    this.cutFlag = false;
    const pose = shotPose(this.shot, subjects, this.shotTime, this.aspect);
    this.status = checkPose(this.shot, pose, subjects, this.aspect);
    this.blockedFor = this.status.ok ? 0 : this.blockedFor + dt;
    return { pose, cut, shot: this.shot };
  }

  /** The requested shot's best clear variant, else the first clear fallback kind, else the least-bad option. */
  private plan(shot: Shot, s: Subjects): Shot {
    let best: PlannedShot = planShot(shot, s, this.aspect);
    if (best.check.ok) return best.shot;
    const kinds = this.mode === 'live' || this.mode === 'intro' ? FALLBACK[shot.kind] ?? [] : [];
    // Prefer not to repeat the shot we just cut away from, but take it over a blocked one.
    const fallbacks = [...kinds.filter((k) => k !== this.prevKind), ...kinds.filter((k) => k === this.prevKind)];
    for (const kind of fallbacks) {
      const alt = planShot({ ...shot, kind, slot: null, angle: kind === 'overhead' ? 0 : shot.angle }, s, this.aspect);
      if (alt.check.ok) return alt.shot;
      if (alt.check.penalty < best.check.penalty) best = alt;
    }
    return best.shot;
  }

  private updateLive(s: Subjects): void {
    const canCut = this.shotTime >= DIRECTOR.MIN_SHOT_S;
    if (this.pending && this.clock - this.pending.queuedAt > DIRECTOR.PENDING_TTL_S) this.pending = null;
    if (this.pending && canCut) {
      const p = this.pending.shot;
      this.pending = null;
      this.startShot(p, this.pickLen(p.kind));
      return;
    }
    const blocked = canCut && this.blockedFor >= DIRECTOR.BLOCKED_GRACE_S;
    if (this.shotTime < this.shotLen && !blocked) return;
    const onBreak = this.breakDown !== null;
    const kind = this.pickKind(onBreak ? BREAK_ROTATION : ROTATION);
    const subject = onBreak ? this.breakDown! : pickSubject(s, this.rng);
    this.startShot({ kind, subject, anchor: null, focusBody: null, angle: this.rng() * 0.6 - 0.3 }, this.pickLen(kind, onBreak ? BREAK_ROTATION : ROTATION));
  }

  private startShot(shot: Omit<Shot, 'side'>, len: number): void {
    this.prevKind = this.shot.kind;
    this.shot = { ...shot, side: this.shot.side, slot: shot.slot ?? null };
    this.blockedFor = 0;
    this.shotTime = 0;
    this.shotLen = len;
    this.cutFlag = true;
  }

  private pickKind(rotation = ROTATION): ShotKind {
    const options = rotation.filter((r) => r.kind !== this.shot.kind);
    const total = options.reduce((s, r) => s + r.weight, 0);
    let x = this.rng() * total;
    for (const r of options) {
      x -= r.weight;
      if (x <= 0) return r.kind;
    }
    return options[options.length - 1].kind;
  }

  private pickLen(kind: ShotKind, rotation = ROTATION): number {
    const r = rotation.find((o) => o.kind === kind);
    if (!r) return kind === 'debris' ? 3.2 : 3;
    return r.min + this.rng() * (r.max - r.min);
  }
}

/**
 * The fighter to frame during a referee break: one in the 'down' role (keeping the current one while
 * he still is, so a double knockdown does not flip between them), else the one who went down and is
 * now waiting for FIGHT; null with no break.
 */
function breakSubjectOf(tel: readonly RefTel[], current: Corner | null): Corner | null {
  if (!tel.some((t) => t.referee?.break)) return null;
  const down = ([0, 1] as Corner[]).filter((c) => tel[c]?.referee?.role === 'down');
  if (current !== null && (down.includes(current) || !down.length)) return current;
  if (down.length) return down[0];
  const neutral = ([0, 1] as Corner[]).find((c) => tel[c]?.referee?.role === 'neutral');
  return neutral === undefined ? 0 : neutral === 0 ? 1 : 0;
}

function reactionFor(ev: SimEvent, tel?: readonly { down: boolean }[] | null): { shot: Omit<Shot, 'side'>; priority: number } | null {
  const base = { anchor: null, focusBody: null, angle: 0 };
  switch (ev.kind) {
    case 'detach':
      return { shot: { ...base, kind: 'debris', subject: ev.corner, anchor: ev.pos, focusBody: ev.debrisBody }, priority: 3 };
    case 'fall':
      return { shot: { ...base, kind: 'cage_low', subject: ev.corner }, priority: 2 };
    case 'ko':
      return { shot: { ...base, kind: 'follow', subject: ev.corner === 0 ? 1 : 0 }, priority: 4 };
    case 'fight': // the referee restarts it: both men squaring up again
      return { shot: { ...base, kind: 'wide', subject: 0 }, priority: 1 };
    case 'impact': {
      if (ev.striker === null || ev.victim === null) return null;
      const s = strikeStrength(ev, tel);
      if (ev.energyJ < DIRECTOR.CUT_IMPACT_J && s < DIRECTOR.CUT_STRENGTH) return null;
      const low = ev.energyJ > DIRECTOR.CUT_IMPACT_J * 2 || s >= DIRECTOR.CUT_LOW_STRENGTH;
      return { shot: { ...base, kind: low ? 'cage_low' : 'follow', subject: ev.victim }, priority: 1 };
    }
    default:
      return null;
  }
}

/** Follow whoever is moving forward harder, with some randomness. */
function pickSubject(s: Subjects, rng: () => number): Corner {
  if (s.down[0] !== s.down[1]) return s.down[0] ? 1 : 0;
  return rng() < 0.5 ? 0 : 1;
}
