// Per-fight memory: how this fighter's gambles have gone and what keeps landing on it, so Jev can
// read "your tornado kicks: 1 of 3 landed, fell once" and "his low kicks keep landing".
//   attempts   a flashy move, combo or kip-up the brain chose; resolved within a short window by
//              the events: a strike of ours landing hard (landed), our own fall (fell), a get-up
//   his hits   strikes of his that landed on us, by the action he was running
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
    for (const e of frame.events) {
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
    const yours = this.yoursWords();
    const his = this.hisWords();
    if (!yours && !his) return null;
    return { yours: yours || 'no gambles yet', his: his || 'nothing of his has landed' };
  }
}
