// Per-fight memory: how this fighter's gambles have gone and what keeps landing on it, so Jev can
// read "your tornado kicks: 1 of 3 landed, fell once" and "his low kicks keep landing".
//   attempts   a flashy move, combo or kip-up the brain chose; resolved within a short window by
//              the events: a strike of ours landing hard (landed), our own fall (fell), a get-up
//   his hits   strikes of his that landed on us, by the action he was running
//   weapons    every strike of ours the body committed (past its windup: a pulled feint is no throw),
//              by the action it ran, and whether it touched him at speed (an impact of ours of at
//              least WEAPON_LANDED_NS while it ran or just after): which of my weapons land in THIS
//              fight, on THIS body, against THIS man. The House Mind weighs its strikes by it, Jev reads it.
// Built from events and physics telemetry only (never from anything the opponent's builder wrote).
import type { Intent, Tactic } from '../core/protocol';
import type { Corner } from '../core/types';
import { isStrike, skillAction, tacticWords } from './tactics';
import type { BrainFrame } from './types';

export const ATTEMPT_WINDOW_S = 1.6; // a flashy move or combo is resolved this long after the decision
export const KIP_WINDOW_S = 4; // a kip-up counts if the fighter is up within this long
export const LANDED_ENERGY_J = 8; // a strike of ours at least this hard counts as landing
export const HIS_HIT_IMPULSE_NS = 8; // a strike of his at least this hard counts as landing
const REPEAT_WORDS = 3; // "keep landing" from this many
const HIS_KEEP = 3; // his most successful actions shown
const HIT_DEBOUNCE_S = 0.3; // one strike touches with several geoms: count it once
export const WEAPON_LANDED_NS = 4; // an impact of ours this hard lands a strike (tools/fight-metrics' rule)
const WEAPON_TAIL_S = 0.1; // ...counted this long after the skill ends
const WEAPON_WORDS_MIN = 3; // a weapon goes into the words after this many throws...
const WEAPON_WORDS_MAX = 3; // ...and at most this many weapons (the most thrown)

export interface WeaponRecord { thrown: number; landed: number }

interface Attempt { move: string; time: number; landed: boolean; fell: boolean; done: boolean }

/** 'tornado kick' → 'tornado kicks', 'superman punch' → 'superman punches'. */
export function plural(words: string): string {
  return /(ch|sh|s|x)$/.test(words) ? `${words}es` : `${words}s`;
}

export interface MoveRecord { attempts: number; landed: number; fell: number }

export class FightMemory {
  private attempts: Attempt[] = [];
  private readonly record = new Map<string, MoveRecord>();
  private readonly hisHits = new Map<Tactic, number>();
  private kip: { time: number } | null = null;
  private kipThisKnockdown = false; // one kip-up attempt per knockdown, however long it lasts
  private kips = { attempts: 0, made: 0 };
  private lastOppAction: Tactic | null = null;
  private lastHisHitAt = -Infinity;
  private readonly weapons = new Map<Tactic, WeaponRecord>();
  /** The strike of ours on the go: its action, committed yet, landed yet, ended at. */
  private swing: { action: Tactic; skill: string; committed: boolean; landed: boolean; endedAt: number | null } | null = null;

  constructor(readonly corner: Corner) {}

  /** Record a decision the body will act on. Flashy moves and combos become attempts. */
  onIntent(intent: Intent, time: number, flashy: boolean, down: boolean): void {
    if (down && intent.getupStyle === 'kip_up' && !this.kipThisKnockdown) {
      this.kipThisKnockdown = true;
      this.kip = { time };
      this.kips.attempts++;
    }
    if (down) return;
    this.kipThisKnockdown = false;
    const move = intent.tactic === 'combo' && intent.combo?.length ? `combo ${intent.combo.map(tacticWords).join('-')}` : flashy ? intent.tactic : null;
    if (!move) return;
    // One live attempt per move: a repeated decision for the same move is the same attempt.
    if (this.attempts.some((a) => !a.done && a.move === move)) return;
    this.attempts = [...this.attempts, { move, time, landed: false, fell: false, done: false }];
  }

  onFrame(frame: BrainFrame): void {
    const me = this.corner;
    const opp = me === 0 ? 1 : 0;
    const oppAction = skillAction(frame.telemetry[opp].skill);
    if (oppAction) this.lastOppAction = oppAction;
    this.trackSwing(frame);
    for (const e of frame.events) {
      if (e.kind === 'impact' && e.striker === me && e.victim === opp && e.impulseNs >= WEAPON_LANDED_NS && !e.push && this.swing) this.swing.landed = true;
      if (e.kind === 'impact' && e.striker === me && e.victim === opp && e.energyJ >= LANDED_ENERGY_J) {
        for (const a of this.attempts) if (!a.done) a.landed = true;
      } else if (e.kind === 'impact' && e.striker === opp && e.victim === me && e.impulseNs >= HIS_HIT_IMPULSE_NS) {
        const action = oppAction ?? this.lastOppAction;
        // Only his strikes "land": contact while he guards or clinches is not a shot of his.
        if (!action || !isStrike(action) || frame.time - this.lastHisHitAt < HIT_DEBOUNCE_S) continue;
        this.lastHisHitAt = frame.time;
        this.hisHits.set(action, (this.hisHits.get(action) ?? 0) + 1);
      } else if (e.kind === 'fall' && e.corner === me) {
        for (const a of this.attempts) if (!a.done) a.fell = true;
      } else if (e.kind === 'getup' && e.corner === me && this.kip) {
        if (frame.time - this.kip.time <= KIP_WINDOW_S) this.kips.made++;
        this.kip = null;
      }
    }
    if (this.kip && frame.time - this.kip.time > KIP_WINDOW_S) this.kip = null;
    this.settle(frame.time);
  }

  /** Our own strike runs, from the skill in the telemetry: a new one starts, the old one closes after its tail. */
  private trackSwing(frame: BrainFrame): void {
    const me = frame.telemetry[this.corner];
    const action = me.down ? null : skillAction(me.skill);
    const strike = action && isStrike(action) ? action : null;
    const sw = this.swing;
    if (sw && sw.endedAt === null && me.skill !== sw.skill) sw.endedAt = frame.time;
    if (sw && sw.endedAt !== null && (frame.time - sw.endedAt > WEAPON_TAIL_S || (strike && me.skill !== sw.skill))) this.closeSwing();
    if (strike && (!this.swing || this.swing.skill !== me.skill)) this.swing = { action: strike, skill: me.skill, committed: false, landed: false, endedAt: null };
    // Past its windup (control's `committed`; telemetry without it counts every run).
    if (this.swing && this.swing.endedAt === null && (me.committed ?? true)) this.swing.committed = true;
  }

  private closeSwing(): void {
    const sw = this.swing;
    this.swing = null;
    if (!sw?.committed) return; // a feint, or a blow pulled in its windup: not a throw
    const r = this.weapons.get(sw.action) ?? { thrown: 0, landed: 0 };
    this.weapons.set(sw.action, { thrown: r.thrown + 1, landed: r.landed + (sw.landed ? 1 : 0) });
  }

  /** How often this weapon of ours has landed this fight (thrown and landed so far). */
  weapon(t: Tactic): WeaponRecord {
    return this.weapons.get(t) ?? { thrown: 0, landed: 0 };
  }

  /**
   * How well a weapon has been landing this fight as a weight, about 1 with no data: its landing rate
   * Laplace-smoothed toward a coin flip ((landed + 1) / (thrown + 2)) over 0.5, so 0 of 8 → 0.2 and
   * 8 of 8 → 1.8.
   */
  landingFactor(t: Tactic): number {
    const r = this.weapon(t);
    return ((r.landed + 1) / (r.thrown + 2)) / 0.5;
  }

  /** "your jabs: 9 of 11 landed; your head kicks: 0 of 6 landed" for the most thrown weapons; '' before any. */
  weaponsWords(): string {
    return [...this.weapons].filter(([, r]) => r.thrown >= WEAPON_WORDS_MIN).sort((a, b) => b[1].thrown - a[1].thrown).slice(0, WEAPON_WORDS_MAX)
      .map(([t, r]) => `your ${plural(tacticWords(t))}: ${r.landed} of ${r.thrown} landed`).join('; ');
  }

  private settle(now: number): void {
    for (const a of this.attempts) {
      if (a.done || now - a.time < ATTEMPT_WINDOW_S) continue;
      a.done = true;
      const r = this.record.get(a.move) ?? { attempts: 0, landed: 0, fell: 0 };
      this.record.set(a.move, { attempts: r.attempts + 1, landed: r.landed + (a.landed ? 1 : 0), fell: r.fell + (a.fell ? 1 : 0) });
    }
    this.attempts = this.attempts.filter((a) => !a.done);
  }

  moveRecord(move: string): MoveRecord | undefined {
    return this.record.get(move);
  }

  get kipUps(): { attempts: number; made: number } {
    return { ...this.kips };
  }

  hisLanded(action: Tactic): number {
    return this.hisHits.get(action) ?? 0;
  }

  /** "your tornado kicks: 1 of 3 landed, fell once" ...; empty when nothing has happened yet. */
  yoursWords(): string {
    const out: string[] = [];
    for (const [move, r] of this.record) {
      const name = move.startsWith('combo ') ? move : plural(tacticWords(move as Tactic));
      const fell = r.fell ? `, fell ${r.fell === 1 ? 'once' : r.fell === 2 ? 'twice' : `${r.fell} times`}` : '';
      out.push(`your ${name}: ${r.landed} of ${r.attempts} landed${fell}`);
    }
    if (this.kips.attempts) out.push(`your kip-ups: ${this.kips.made} of ${this.kips.attempts} made it up`);
    return out.join('; ');
  }

  /** "his low kicks keep landing; his hook landed twice". */
  hisWords(): string {
    return [...this.hisHits].sort((a, b) => b[1] - a[1]).slice(0, HIS_KEEP).map(([action, n]) => {
      const name = tacticWords(action);
      if (n >= REPEAT_WORDS) return `his ${plural(name)} keep landing`;
      return `his ${name} landed ${n === 1 ? 'once' : 'twice'}`;
    }).join('; ');
  }

  /** The record section of the state, or null before anything has happened. */
  words(): { yours: string; his: string } | null {
    const yours = [this.yoursWords(), this.weaponsWords()].filter(Boolean).join('; ');
    const his = this.hisWords();
    if (!yours && !his) return null;
    return { yours: yours || 'no gambles yet', his: his || 'nothing of his has landed' };
  }
}
