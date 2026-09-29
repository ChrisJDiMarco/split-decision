// Fight statistics and three judges' 10-point-must cards. Each judge weighs damage,
// strikes and knockdowns differently, which is how a close fight becomes a split decision.
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner } from '../core/types';

export const SIGNIFICANT_STRIKE_J = 60;

export interface CornerStats {
  strikes: number; // significant strikes landed
  strikeEnergyJ: number;
  peakHitJ: number;
  knockdowns: number; // times this corner put the opponent down
  partsRemoved: number; // opponent parts this corner tore off
  damageDealt: number; // opponent damageTotal gained, 0..1
}

interface RoundStats {
  corners: [CornerStats, CornerStats];
  startDamage: [number, number];
}

export type DecisionKind = 'unanimous' | 'split' | 'majority' | 'draw';

export interface Decision {
  cards: Array<[number, number]>; // per judge: [red total, blue total]
  winner: Corner | null;
  kind: DecisionKind;
}

interface JudgeWeights { damage: number; strikes: number; knockdowns: number }

const JUDGES: JudgeWeights[] = [
  { damage: 1.0, strikes: 0.5, knockdowns: 1.2 },
  { damage: 0.55, strikes: 1.0, knockdowns: 0.9 },
  { damage: 0.8, strikes: 0.7, knockdowns: 2.0 },
];
const EVEN_ROUND_MARGIN = 0.02; // closer than this and a judge scores 10-10
const DOMINANT_MARGIN = 0.6; // a knockdown plus this margin is a 10-8 round

function emptyStats(): CornerStats {
  return { strikes: 0, strikeEnergyJ: 0, peakHitJ: 0, knockdowns: 0, partsRemoved: 0, damageDealt: 0 };
}

export class Scorecard {
  private rounds: RoundStats[] = [];
  private lastDamage: [number, number] = [0, 0];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.rounds = [];
    this.lastDamage = [0, 0];
    this.startRound();
  }

  startRound(): void {
    this.rounds.push({ corners: [emptyStats(), emptyStats()], startDamage: [...this.lastDamage] as [number, number] });
  }

  private get current(): RoundStats {
    return this.rounds[this.rounds.length - 1];
  }

  record(events: readonly SimEvent[], telemetry: readonly RobotTelemetry[] | null): void {
    const c = this.current.corners;
    for (const ev of events) {
      if (ev.kind === 'impact' && ev.striker !== null && ev.victim !== null && ev.striker !== ev.victim && ev.energyJ >= SIGNIFICANT_STRIKE_J) {
        const s = c[ev.striker];
        s.strikes++;
        s.strikeEnergyJ += ev.energyJ;
        s.peakHitJ = Math.max(s.peakHitJ, ev.energyJ);
      } else if (ev.kind === 'fall') {
        c[other(ev.corner)].knockdowns++;
      } else if (ev.kind === 'detach') {
        c[other(ev.corner)].partsRemoved++;
      }
    }
    if (telemetry) {
      for (const t of telemetry) this.lastDamage[t.corner] = t.damageTotal;
      const start = this.current.startDamage;
      c[0].damageDealt = Math.max(0, this.lastDamage[1] - start[1]);
      c[1].damageDealt = Math.max(0, this.lastDamage[0] - start[0]);
    }
  }

  /** Whole-fight totals per corner. */
  totals(): [CornerStats, CornerStats] {
    const out: [CornerStats, CornerStats] = [emptyStats(), emptyStats()];
    for (const r of this.rounds) {
      for (const k of [0, 1] as const) {
        const a = out[k];
        const b = r.corners[k];
        a.strikes += b.strikes;
        a.strikeEnergyJ += b.strikeEnergyJ;
        a.peakHitJ = Math.max(a.peakHitJ, b.peakHitJ);
        a.knockdowns += b.knockdowns;
        a.partsRemoved += b.partsRemoved;
        a.damageDealt += b.damageDealt;
      }
    }
    return out;
  }

  decision(): Decision {
    const cards = JUDGES.map((w) => this.card(w));
    const votes = cards.map(([r, b]) => (r > b ? 0 : b > r ? 1 : null));
    const red = votes.filter((v) => v === 0).length;
    const blue = votes.filter((v) => v === 1).length;
    const winVotes = Math.max(red, blue);
    const loseVotes = Math.min(red, blue);
    // A win needs two judges; one card and two draws is a majority draw.
    if (red === blue || winVotes < 2) return { cards, winner: null, kind: 'draw' };
    const winner: Corner = red > blue ? 0 : 1;
    const kind: DecisionKind = winVotes === 3 ? 'unanimous' : loseVotes === 1 ? 'split' : 'majority';
    return { cards, winner, kind };
  }

  private card(w: JudgeWeights): [number, number] {
    let red = 0;
    let blue = 0;
    for (const r of this.rounds) {
      const score = (s: CornerStats) => w.damage * s.damageDealt * 10 + w.strikes * s.strikeEnergyJ / 400 + w.knockdowns * s.knockdowns;
      const a = score(r.corners[0]);
      const b = score(r.corners[1]);
      const margin = Math.abs(a - b);
      if (margin < EVEN_ROUND_MARGIN) { red += 10; blue += 10; continue; }
      const winner = a > b ? 0 : 1;
      const dominant = r.corners[winner].knockdowns > 0 && margin > DOMINANT_MARGIN;
      const loser = dominant ? 8 : 9;
      if (winner === 0) { red += 10; blue += loser; } else { red += loser; blue += 10; }
    }
    return [red, blue];
  }
}

function other(c: Corner): Corner {
  return c === 0 ? 1 : 0;
}
