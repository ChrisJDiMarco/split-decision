// Types shared inside the brain module and exposed to the HUD.
import type { GetupStyle, Opening, RobotTelemetry, SimEvent, Tactic, TargetZone } from '../core/protocol';
import type { PlanView } from './sequencer';

/** Where a decision came from. 'local' = an obvious tick settled by a code rule, no Jev call. */
export type DecisionSource = 'jev' | 'local' | 'fallback';

/**
 * Which mind a fighter runs: 'jev' (TypeSafe's cloud Jev via /api/jev), 'local' (an open-source
 * Jev-compatible model on this Mac via /api/local-jev) or 'house' (the House Mind rules, no network).
 */
export type MindSource = 'jev' | 'local' | 'house';

/** The mind link as the HUD shows it: 'offline' = the chosen model is unreachable and the House Mind fights. */
export type MindLinkKind = 'jev' | 'local' | 'house' | 'offline';

/** e.g. { kind: 'local', label: 'LOCAL · decider-4b' }, { kind: 'offline', label: 'LOCAL OFFLINE → HOUSE' }. */
export interface MindLinkStatus { kind: MindLinkKind; label: string }

/** How firmly the fighter commits, from Jev's confidence in the tactic. */
export type CommitMode = 'commit' | 'probe' | 'guard';

export type DistanceBand = 'clinch' | 'striking range' | 'just outside reach' | 'mid range' | 'far';

export type OpponentPhaseClass = 'down' | 'windup' | 'striking' | 'staggered' | 'neutral';

/** The subset of a worker frame the brain reads. */
export interface BrainFrame {
  tick: number;
  time: number; // sim seconds
  events: SimEvent[];
  telemetry: [RobotTelemetry, RobotTelemetry];
}

/** Match clock, supplied by whoever runs rounds. The brain assumes round 1 of 3 otherwise. */
export interface MatchClock {
  round: number;
  rounds: number;
  remainingS: number;
}

/** Everything the HUD needs to draw one decision. */
export interface BrainDecision {
  tick: number; // sim tick the state was captured at (the intent's issuedAtTick)
  time: number; // sim seconds at capture
  source: DecisionSource;
  mode: CommitMode;
  tactic: Tactic;
  target: TargetZone;
  aggression: number; // 0..1, after gating
  counterIfLunge: Tactic | undefined;
  confidence: number; // Jev's confidence in the tactic question (1 for local rules)
  tacticProbs: Record<string, number>; // Jev's raw distribution (or the rule's pseudo distribution)
  targetProbs: Record<string, number>;
  oppCommit: number | null; // P(opponent commits within 0.5 s)
  winning: number | null; // 0 opponent clearly .. 1 you clearly
  latencyMs: number | null; // wall ms for the Jev round trip
  reason: string; // short human-readable why (rule name, "hysteresis kept guard", ...)
  trigger: string; // 'cadence', 'stale', or the interrupt that forced the query ('big_hit', 'opp_windup', ...)
  openings: Opening[]; // what the fighter saw on its opponent when it decided
  gamble: GambleView | null; // the opening move it went for, if any
  combo: Tactic[] | null; // the combination it is running (tactic 'combo')
  getupStyle?: GetupStyle; // chosen while down
  flourish: boolean;
  /** The pre-armed opening reflex riding on this intent ({ missed_recovering: 'spinning_backfist', ... }). */
  onOpening: Partial<Record<Opening, Tactic>> | null;
  /** The setup → payoff plan running (live, step by step), or null. */
  plan?: PlanView | null;
  /** The read of his answer to this fighter's last feint, while fresh ("HE BIT: COVERED HIGH"). */
  read?: string | null;
  /** The mind link at read-out time (JEV, LOCAL · model, HOUSE, or X OFFLINE → HOUSE). */
  link?: MindLinkStatus;
  /**
   * Which mind made this decision: 'jev' (cloud), 'local' (the LOCAL model, or a rule tick while
   * LOCAL is the mind) or 'house' (the House Mind: chosen, or standing in for an offline model).
   * `source` keeps saying how it was made (a model answer 'jev', a rule tick 'local', the House Mind 'fallback').
   */
  mind?: MindSource;
}

/** An opening move (or creative gamble) the fighter went for. */
export interface GambleView {
  move: Tactic;
  opening: Opening | null; // null: a creative gamble with no opening
  p: number | null; // Jev's probability for the move (null: House Mind rule)
  risk: number | null; // its fall risk (flashy moves only)
}

export interface LatencySummary { n: number; mean: number; p50: number; p90: number; p99: number; max: number }

export interface BrainStats {
  requests: number;
  answered: number;
  errors: number;
  droppedStale: number; // coarse state changed while in flight
  droppedSuperseded: number; // a newer answer was already applied
  settledLocal: number;
  fallbackDecisions: number;
  inFlight: number;
  latency: LatencySummary;
  inputTokens: number;
  outputTokens: number;
}

export type JevStatus = 'unknown' | 'online' | 'offline';
