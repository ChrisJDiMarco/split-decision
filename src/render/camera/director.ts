// Camera director: picks broadcast shots, holds each for at least MIN_SHOT_S, and cuts
// on big impacts, detaches and falls. Pure logic (seeded rng), unit-tested.
import type { SimEvent } from '../../core/protocol';
import type { Corner, Vec3 } from '../../core/types';
import { hardCamSide, resolveShot, shotPose, type CameraPose, type Shot, type ShotKind, type Subjects } from './shots';

export type DirectorMode = 'idle' | 'live' | 'intro' | 'replay' | 'victory';

export const DIRECTOR = {
  MIN_SHOT_S: 2,
  CUT_IMPACT_J: 180, // impacts above this cut to a reaction shot
  PENDING_TTL_S: 2, // a queued reaction cut goes stale after this (>= MIN_SHOT_S so early hits still land)
  INTRO_SHOT_S: 2.6,
} as const;

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
  private shotLen = 5;
  private clock = 0;
  private cutFlag = true;
  private pending: PendingCut | null = null;
  private introQueue: Array<Omit<Shot, 'side'>> = [];

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

  onEvents(events: readonly SimEvent[]): void {
    if (this.mode !== 'live') return;
    for (const ev of events) {
      const req = reactionFor(ev);
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
    }
    if (this.cutFlag) this.shot = resolveShot({ ...this.shot, side: hardCamSide(subjects) }, subjects);
    const cut = this.cutFlag;
    this.cutFlag = false;
    return { pose: shotPose(this.shot, subjects, this.shotTime), cut, shot: this.shot };
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
    if (this.shotTime < this.shotLen) return;
    const kind = this.pickKind();
    const subject = pickSubject(s, this.rng);
    this.startShot({ kind, subject, anchor: null, focusBody: null, angle: this.rng() * 0.6 - 0.3 }, this.pickLen(kind));
  }

  private startShot(shot: Omit<Shot, 'side'>, len: number): void {
    this.shot = { ...shot, side: this.shot.side };
    this.shotTime = 0;
    this.shotLen = len;
    this.cutFlag = true;
  }

  private pickKind(): ShotKind {
    const options = ROTATION.filter((r) => r.kind !== this.shot.kind);
    const total = options.reduce((s, r) => s + r.weight, 0);
    let x = this.rng() * total;
    for (const r of options) {
      x -= r.weight;
      if (x <= 0) return r.kind;
    }
    return options[options.length - 1].kind;
  }

  private pickLen(kind: ShotKind): number {
    const r = ROTATION.find((o) => o.kind === kind);
    if (!r) return kind === 'debris' ? 3.2 : 3;
    return r.min + this.rng() * (r.max - r.min);
  }
}

function reactionFor(ev: SimEvent): { shot: Omit<Shot, 'side'>; priority: number } | null {
  const base = { anchor: null, focusBody: null, angle: 0 };
  switch (ev.kind) {
    case 'detach':
      return { shot: { ...base, kind: 'debris', subject: ev.corner, anchor: ev.pos, focusBody: ev.debrisBody }, priority: 3 };
    case 'fall':
      return { shot: { ...base, kind: 'cage_low', subject: ev.corner }, priority: 2 };
    case 'ko':
      return { shot: { ...base, kind: 'follow', subject: ev.corner === 0 ? 1 : 0 }, priority: 4 };
    case 'impact':
      if (ev.striker === null || ev.victim === null || ev.energyJ < DIRECTOR.CUT_IMPACT_J) return null;
      return { shot: { ...base, kind: ev.energyJ > DIRECTOR.CUT_IMPACT_J * 2 ? 'cage_low' : 'follow', subject: ev.victim }, priority: 1 };
    default:
      return null;
  }
}

/** Follow whoever is moving forward harder, with some randomness. */
function pickSubject(s: Subjects, rng: () => number): Corner {
  if (s.down[0] !== s.down[1]) return s.down[0] ? 1 : 0;
  return rng() < 0.5 ? 0 : 1;
}
