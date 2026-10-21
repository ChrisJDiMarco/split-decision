// Phase 4 metrics for one fighter in a fight (docs/design/balance-engine.md §6, §8; strike-power.md §4.6),
// sampled after every physics step by tools/fight-metrics.ts:
//   hits        blows the body felt (the reactions' proprioceptive detector), absorbs, pre-braces
//   recoveries  each 'recover' episode: the steps it took and how long until the reactions called the body
//               steady again (or it braced / fell)
//   falls       whether the brace came before the first part other than a sole touched the canvas, what
//               touched first (the head?), and the get-up: first movement and stable standing after the fall
import { controllerOf, type HumanoidController } from '../../src/physics/control';
import type { RobotRuntime, SimContext } from '../../src/physics/sim-context';
import { CanvasContacts, contactClass } from './canvas-contact';

const STAND_HOLD_S = 0.3;
const STABLE_SPEED = 0.3;

export interface ReactionFall {
  t: number;
  braceAt: number | null; // sim time the brace started (null: none before the contact)
  braceWhy: string;
  contactAt: number | null; // first part other than a sole on the canvas
  contact: string[];
  moveAt: number | null; // the get-up's first movement
  stableAt: number | null; // standing, risen and stable
}

export interface ReactionMetrics {
  hits: number;
  absorbs: number;
  preBraces: number;
  braces: number;
  braceExits: number;
  recoveries: Array<{ steps: number; s: number; ok: boolean }>;
  falls: ReactionFall[];
}

export class ReactionRecorder {
  private readonly c: HumanoidController;
  private readonly cc: CanvasContacts;
  private readonly torso: number;
  private mode = 'steady';
  private rec: { t: number; touch: number } | null = null;
  private braceAt = -1;
  private braceWhy = '';
  private fall: (ReactionFall & { down?: boolean }) | null = null;
  private standSince = -1;
  private wasDown = false;
  readonly out: ReactionMetrics = { hits: 0, absorbs: 0, preBraces: 0, braces: 0, braceExits: 0, recoveries: [], falls: [] };

  constructor(ctx: SimContext, private readonly r: RobotRuntime) {
    this.c = controllerOf(r)!;
    this.cc = new CanvasContacts(ctx, r);
    this.torso = r.parts.get('torso')!.body;
  }

  sample(ctx: SimContext): void {
    const c = this.c;
    const e = c.engine;
    if (!e) return;
    const t = ctx.time;
    const mode = e.state.mode;
    if (mode !== this.mode) {
      if (mode === 'recover' && !this.rec) this.rec = { t, touch: c.probe.touchdowns };
      if (this.rec && mode === 'steady') {
        this.out.recoveries.push({ steps: c.probe.touchdowns - this.rec.touch, s: t - this.rec.t, ok: true });
        this.rec = null;
      }
      if (mode === 'brace') {
        this.braceAt = t;
        this.braceWhy = e.reactions.braceWhy;
        if (this.rec) {
          this.out.recoveries.push({ steps: c.probe.touchdowns - this.rec.touch, s: t - this.rec.t, ok: false });
          this.rec = null;
        }
      }
      this.mode = mode;
    }
    // A fall: opened when the body goes down or when something other than a sole touches the canvas on the way
    // (whichever comes first; the other joins it), closed once it is standing again.
    const down = this.r.down;
    if (down && !this.wasDown) {
      this.open(t).down = true;
      this.standSince = -1;
      if (this.rec) {
        this.out.recoveries.push({ steps: c.probe.touchdowns - this.rec.touch, s: t - this.rec.t, ok: false });
        this.rec = null;
      }
    }
    this.wasDown = down;
    const s = c.lastSense;
    const tipping = mode === 'brace' || down || (!!s && s.upright < 0.9);
    if (tipping && (!this.fall || this.fall.contactAt === null || t - this.fall.t > 3)) {
      const parts = this.cc.nonFoot(ctx);
      if (parts.length) {
        const f = this.open(t);
        if (f.contactAt === null) {
          f.contactAt = t;
          f.contact = parts;
        }
      }
    }
    const f = this.fall;
    if (f && f.stableAt === null) {
      if (f.moveAt === null && c.getUp.active && c.getUp.phase !== 'settle') f.moveAt = t;
      const cv = ctx.data.cvel as Float64Array;
      const rate = Math.hypot(cv[this.torso * 6], cv[this.torso * 6 + 1]);
      const standing = !down && !c.getUp.active && !c.rising && !!s && s.upright > 0.9 && s.pelvisPos[2] > 0.9 * c.stance.pelvisHeight
        && Math.hypot(s.comVel[0], s.comVel[1]) < STABLE_SPEED && rate < STABLE_SPEED && c.gait.bothPlanted();
      if (!standing) this.standSince = -1;
      else if (this.standSince < 0) this.standSince = t;
      else if (t - this.standSince >= STAND_HOLD_S && f.moveAt !== null) f.stableAt = this.standSince;
    }
  }

  /** The fall under way (this one if it began within 3 s and is not over), or a new one. */
  private open(t: number): ReactionFall & { down?: boolean } {
    const f = this.fall as (ReactionFall & { down?: boolean }) | null;
    if (f && t - f.t < 3 && f.stableAt === null) return f;
    const braced = this.braceAt >= 0 && t - this.braceAt < 3 ? this.braceAt : null;
    const g: ReactionFall & { down?: boolean } = { t, braceAt: braced, braceWhy: braced !== null ? this.braceWhy : '', contactAt: null, contact: [], moveAt: null, stableAt: null };
    this.fall = g;
    this.out.falls.push(g);
    return g;
  }

  result(): ReactionMetrics {
    const k = this.c.engine?.reactions.counts;
    if (k) {
      this.out.hits = k.hits;
      this.out.absorbs = k.absorbs;
      this.out.preBraces = k.preBraces;
      this.out.braces = k.braces;
      this.out.braceExits = k.braceExits;
    }
    // Only the body going down is a fall (a knee or a hand touching on the way, caught on the feet after all, is not).
    this.out.falls = this.out.falls.filter((x) => (x as { down?: boolean }).down);
    return this.out;
  }
}

/** Summary lines over many fighters' reaction metrics (fight-metrics). */
export function summarizeReactions(ms: ReactionMetrics[], perTwoMin: (n: number) => number): string[] {
  const rec = ms.flatMap((m) => m.recoveries);
  const ok = rec.filter((x) => x.ok);
  const med = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : NaN;
  };
  const stepped = ok.filter((x) => x.steps > 0);
  const falls = ms.flatMap((m) => m.falls).filter((f) => f.contactAt !== null);
  const braced = falls.filter((f) => f.braceAt !== null && f.braceAt <= f.contactAt!);
  const head = falls.filter((f) => f.contact.includes('head'));
  const cls = new Map<string, number>();
  for (const f of falls) {
    const key = [...new Set(f.contact.map(contactClass))].sort().join('+');
    cls.set(key, (cls.get(key) ?? 0) + 1);
  }
  const gu = ms.flatMap((m) => m.falls).filter((f) => f.moveAt !== null);
  const move = gu.filter((f) => f.stableAt !== null).map((f) => f.stableAt! - f.moveAt!);
  const total = gu.filter((f) => f.stableAt !== null).map((f) => f.stableAt! - f.t);
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
  const sum = (k: keyof Pick<ReactionMetrics, 'hits' | 'absorbs' | 'preBraces' | 'braces' | 'braceExits'>) => ms.reduce((a, m) => a + m[k], 0);
  return [
    `reactions (Phase 4, docs/design/balance-engine.md §6):`,
    `  blows felt ${sum('hits')} (${perTwoMin(sum('hits')).toFixed(1)} per fighter per 2 min), absorbs ${sum('absorbs')}, pre-braces ${sum('preBraces')}, braces ${sum('braces')} (${sum('braceExits')} caught on the feet after all)`,
    `  recoveries ${rec.length}: steady again ${ok.length}, braced or fell ${rec.length - ok.length}; steps median ${med(stepped.map((x) => x.steps))} over the ${stepped.length} that stepped (target <= 2), time to steady median ${med(ok.map((x) => x.s)).toFixed(2)} s (stepped: ${med(stepped.map((x) => x.s)).toFixed(2)} s; target <= 0.8)`,
    `  falls touching down ${falls.length}: brace before the first non-foot contact ${pct(braced.length, falls.length)} (target >= 90%), head first ${pct(head.length, falls.length)} (target <= 10%); first contact ${[...cls].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `  get-ups ${gu.length} started: stable standing ${move.length}, first movement to stable median ${med(move).toFixed(2)} s, fall to stable median ${med(total).toFixed(2)} s (within 5 s: ${total.filter((x) => x <= 5).length}/${ms.flatMap((m) => m.falls).length})`,
  ];
}
