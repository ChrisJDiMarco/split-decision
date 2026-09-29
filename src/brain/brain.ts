// One mind per fighter. Reads each telemetry frame, decides when to ask Jev (adaptive
// 1.5-4 Hz, immediate on interrupts), turns the answer's distributions into an Intent,
// and hands it to onIntent(corner, intent, issuedAtTick); the worker applies it after the
// fixed reaction delay. If Jev is unreachable the House Mind fights instead.
import type { Intent, Tactic, WorldMeta } from '../core/protocol';
import type { Corner, FighterSetup, RobotDesign } from '../core/types';
import { DESIGNS } from '../robots/designs';
import { houseMind, obviousDecision, type RuleDecision } from './house-mind';
import type { JevResult } from './jev-client';
import { JevLink } from './link';
import { FightObserver } from './observer';
import { decide, parseAnswers } from './policy';
import { buildQuestions, type QuestionSet } from './questions';
import { serializeState } from './serializer';
import { coarseKey, makeFighterContext, readSituation, type FighterContext, type Situation } from './situation';
import { BrainStatsTracker } from './stats';
import type { BrainDecision, BrainFrame, BrainStats, CommitMode, DecisionSource, DistanceBand, JevStatus, MatchClock } from './types';

export const MAX_IN_FLIGHT = 2;
export const MIN_REQUEST_GAP_S = 0.1; // sim seconds between two queries, even on interrupts
export const MIN_INTERVAL_S = 0.25; // 4 Hz
export const MAX_INTERVAL_S = 1 / 1.5; // 1.5 Hz
const HISTORY_LEN = 60;
const DEFAULT_ROUND_S = 180;
const DEFAULT_ROUNDS = 3;

export const BAND_INTERVAL_S: Record<DistanceBand, number> = {
  clinch: MIN_INTERVAL_S,
  'striking range': MIN_INTERVAL_S,
  'just outside reach': 0.33,
  'mid range': 0.5,
  far: MAX_INTERVAL_S,
};
const MODE_INTERVAL_SCALE: Record<CommitMode, number> = { commit: 1, probe: 0.7, guard: 0.6 };

export type IntentCallback = (corner: Corner, intent: Intent, issuedAtTick: number) => void;

export interface BrainOptions {
  corner: Corner;
  meta: WorldMeta;
  fighter: FighterSetup; // this fighter's own setup; the opponent's is never passed in
  seed: number;
  onIntent: IntentCallback;
  onDecision?: (d: BrainDecision) => void;
  designs?: Record<string, RobotDesign>;
  link?: JevLink; // share one link between both fighters so the request budget is global
  roundLengthS?: number;
  rounds?: number;
}

interface PendingRequest { tick: number; time: number; key: string; gen: number; trigger: string; qs: QuestionSet }

let defaultLink: JevLink | null = null;
/** The page-wide link used when a Brain is not given one. */
export function sharedJevLink(): JevLink {
  defaultLink ??= new JevLink();
  return defaultLink;
}

function resolveDesign(meta: WorldMeta, corner: Corner, designs: Record<string, RobotDesign>): RobotDesign {
  const id = meta.robots.find((r) => r.corner === corner)?.design;
  const d = id ? designs[id] : undefined;
  if (!d) throw new Error(`Brain: no design for corner ${corner} (${id ?? 'missing'})`);
  return d;
}

export class Brain {
  readonly corner: Corner;
  readonly link: JevLink;
  private readonly fc: FighterContext;
  private readonly opts: BrainOptions;
  private readonly stats = new BrainStatsTracker();
  private observer: FightObserver;
  private active = false;
  private generation = 0;
  private inFlight = 0;
  private nextDecisionAt = 0;
  private lastQueryAt = -Infinity;
  private pendingTrigger: string | null = null;
  private currentTactic: Tactic | null = null;
  private lastAppliedTick = -1;
  private situation: Situation | null = null;
  private clock: MatchClock | null = null;
  private startTime: number | null = null;
  private history: BrainDecision[] = [];

  constructor(opts: BrainOptions) {
    const designs = opts.designs ?? DESIGNS;
    this.opts = opts;
    this.corner = opts.corner;
    this.link = opts.link ?? sharedJevLink();
    const other: Corner = opts.corner === 0 ? 1 : 0;
    this.fc = makeFighterContext(opts.corner, resolveDesign(opts.meta, opts.corner, designs), resolveDesign(opts.meta, other, designs), opts.fighter);
    this.observer = new FightObserver(opts.corner);
  }

  // ------------------------------------------------------------ lifecycle

  /** Start deciding (call on release). */
  start() { this.active = true; }

  /** Stop deciding; answers still in flight are ignored. */
  stop() {
    this.active = false;
    this.generation++;
  }

  /** Forget the fight so far (new round or reset). Stays stopped until start(). */
  reset() {
    this.stop();
    this.observer = new FightObserver(this.corner);
    this.nextDecisionAt = 0;
    this.lastQueryAt = -Infinity;
    this.pendingTrigger = null;
    this.currentTactic = null;
    this.lastAppliedTick = -1;
    this.startTime = null;
    this.history = [];
  }

  // ------------------------------------------------------------ HUD read-outs

  get latest(): BrainDecision | null { return this.history[this.history.length - 1] ?? null; }
  get decisions(): readonly BrainDecision[] { return this.history; }
  get source(): DecisionSource { return this.link.offline ? 'fallback' : 'jev'; }
  get jevStatus(): JevStatus { return this.link.status; }
  get statsSnapshot(): BrainStats { return this.stats.snapshot(this.inFlight); }
  get inFlightCount(): number { return this.inFlight; }

  // ------------------------------------------------------------ frame loop

  /** Feed every telemetry frame. `clock` comes from the round keeper when there is one. */
  onFrame(frame: BrainFrame, clock?: MatchClock) {
    const interrupts = this.observer.update(frame);
    const s = readSituation(this.fc, frame);
    this.situation = s;
    if (clock) this.clock = clock;
    if (!this.active) return;
    this.startTime ??= frame.time;
    if (interrupts.length && this.pendingTrigger === null) this.pendingTrigger = interrupts[0];
    const due = this.pendingTrigger !== null || frame.time >= this.nextDecisionAt;
    if (!due || frame.time - this.lastQueryAt < MIN_REQUEST_GAP_S) return;
    this.decideNow(s);
  }

  private decideNow(s: Situation) {
    const trigger = this.pendingTrigger ?? 'cadence';
    const obvious = obviousDecision(this.fc, s);
    if (obvious && !this.link.offline) {
      this.stats.settledLocal++;
      this.emitRule(obvious, 'local', s, trigger);
      return;
    }
    // Offline, the House Mind owns every tick (obvious ones included), so the HUD shows it.
    if (this.link.offline && (obvious || !this.link.canSend())) {
      this.stats.fallbackDecisions++;
      this.emitRule(obvious ?? houseMind(this.fc, s, this.opts.seed), 'fallback', s, trigger);
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT || !this.link.canSend()) return; // stay due; retry next frame
    this.query(s, trigger);
  }

  private schedule(s: Situation, mode: CommitMode = 'commit') {
    const interval = Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, BAND_INTERVAL_S[s.band] * MODE_INTERVAL_SCALE[mode]));
    this.nextDecisionAt = s.time + interval;
    this.lastQueryAt = s.time;
    this.pendingTrigger = null;
  }

  private matchClock(s: Situation): MatchClock {
    if (this.clock) return this.clock;
    const roundS = this.opts.roundLengthS ?? DEFAULT_ROUND_S;
    return { round: 1, rounds: this.opts.rounds ?? DEFAULT_ROUNDS, remainingS: Math.max(0, roundS - (s.time - (this.startTime ?? s.time))) };
  }

  // ------------------------------------------------------------ Jev round trip

  private query(s: Situation, trigger: string) {
    const qs = buildQuestions(this.fc, s.opp);
    const state = serializeState(this.fc, s, this.observer.recentActions(s.time), this.matchClock(s), this.currentTactic);
    const req: PendingRequest = { tick: s.tick, time: s.time, key: coarseKey(s), gen: this.generation, trigger, qs };
    this.inFlight++;
    this.stats.requests++;
    this.schedule(s);
    this.link.send(state, qs.questions).then(
      (res) => this.onAnswer(req, res),
      () => this.onFailure(req),
    );
  }

  private onAnswer(req: PendingRequest, res: JevResult) {
    this.inFlight--;
    if (req.gen !== this.generation) return;
    this.stats.recordAnswer(res.latencyMs, res.inputTokens, res.outputTokens);
    const now = this.situation;
    if (req.tick <= this.lastAppliedTick) { this.stats.droppedSuperseded++; return; }
    if (!now || coarseKey(now) !== req.key) {
      this.stats.droppedStale++;
      this.pendingTrigger ??= 'stale';
      return;
    }
    let parsed;
    try {
      parsed = parseAnswers(res, req.qs);
    } catch (e) {
      this.link.markFailed(e);
      this.onFailure(req, false);
      return;
    }
    const out = decide({ parsed, situation: now, current: this.currentTactic, temperature: this.fc.setup.temperament, seed: this.opts.seed, corner: this.corner, tick: req.tick });
    const intent: Intent = { tactic: out.tactic, target: out.target, aggression: out.aggression, counterIfLunge: parsed.counter, confidence: parsed.tacticConfidence, source: 'jev' };
    this.lastAppliedTick = req.tick;
    if (out.mode !== 'commit') this.nextDecisionAt = Math.min(this.nextDecisionAt, req.time + BAND_INTERVAL_S[now.band] * MODE_INTERVAL_SCALE[out.mode]);
    this.emit(intent, req.tick, {
      tick: req.tick, time: req.time, source: 'jev', mode: out.mode, tactic: out.tactic, target: out.target,
      aggression: out.aggression, counterIfLunge: parsed.counter, confidence: parsed.tacticConfidence,
      tacticProbs: parsed.tacticProbs, targetProbs: parsed.targetProbs, oppCommit: parsed.oppCommit,
      winning: parsed.winning, latencyMs: res.latencyMs, reason: out.reason, trigger: req.trigger,
    });
  }

  /** Jev failed (the link is now offline): the House Mind takes this decision immediately. */
  private onFailure(req: PendingRequest, decrement = true) {
    if (decrement) this.inFlight--;
    if (req.gen !== this.generation) return;
    this.stats.errors++;
    const s = this.situation;
    if (!s || !this.active) return;
    this.stats.fallbackDecisions++;
    this.emitRule(houseMind(this.fc, s, this.opts.seed), 'fallback', s, req.trigger);
  }

  // ------------------------------------------------------------ output

  private emitRule(rule: RuleDecision, source: DecisionSource, s: Situation, trigger: string) {
    const intent: Intent = {
      tactic: rule.tactic, target: rule.target, aggression: rule.aggression, counterIfLunge: rule.counterIfLunge,
      confidence: 1, source: source === 'fallback' ? 'fallback' : 'jev',
      ...(source === 'local' ? { settledLocally: true } : {}),
    };
    this.schedule(s);
    this.lastAppliedTick = Math.max(this.lastAppliedTick, s.tick);
    this.emit(intent, s.tick, {
      tick: s.tick, time: s.time, source, mode: 'commit', tactic: rule.tactic, target: rule.target,
      aggression: rule.aggression, counterIfLunge: rule.counterIfLunge, confidence: 1,
      tacticProbs: { [rule.tactic]: 1 }, targetProbs: { [rule.target]: 1 }, oppCommit: null,
      winning: null, latencyMs: null, reason: rule.reason, trigger,
    });
  }

  private emit(intent: Intent, issuedAtTick: number, d: BrainDecision) {
    this.currentTactic = intent.tactic;
    this.history = [...this.history.slice(-(HISTORY_LEN - 1)), d];
    this.opts.onIntent(this.corner, intent, issuedAtTick);
    this.opts.onDecision?.(d);
  }
}
