// Round clock: three rounds of 2:00, counted in simulation time so slow motion and
// pauses stop the clock. Pure logic, unit-tested.

export const MATCH = {
  ROUNDS: 3,
  ROUND_S: 120,
  BREAK_S: 8, // wall seconds between rounds (demo pacing, not the 60 s of real MMA)
} as const;

export type ClockSignal = 'round_end' | 'fight_end' | null;

export class RoundClock {
  round = 1;
  elapsed = 0; // sim seconds into the current round
  running = false;

  constructor(readonly roundS: number = MATCH.ROUND_S, readonly rounds: number = MATCH.ROUNDS) {}

  reset(): void {
    this.round = 1;
    this.elapsed = 0;
    this.running = false;
  }

  remaining(): number {
    return Math.max(0, this.roundS - this.elapsed);
  }

  /** Advance by simulated seconds. Signals once when the round (or the fight) runs out. */
  advance(simDt: number): ClockSignal {
    if (!this.running || simDt <= 0) return null;
    this.elapsed += simDt;
    if (this.elapsed < this.roundS) return null;
    this.elapsed = this.roundS;
    this.running = false;
    return this.round >= this.rounds ? 'fight_end' : 'round_end';
  }

  nextRound(): void {
    if (this.round < this.rounds) this.round++;
    this.elapsed = 0;
  }

  /** '1:42' style, rounding up so 0:00 only shows when time is really out. */
  label(): string {
    return formatClock(this.remaining());
  }

  /** The brain's MatchClock shape. */
  matchClock(): { round: number; rounds: number; remainingS: number } {
    return { round: this.round, rounds: this.rounds, remainingS: this.remaining() };
  }
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
