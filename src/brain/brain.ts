// One mind per fighter. Reads each telemetry frame, decides when to ask Jev (adaptive
// 1.5-4 Hz, immediate on interrupts), turns the answer's distributions into an Intent,
// and hands it to onIntent(corner, intent, issuedAtTick); the worker applies it after the
// fixed reaction delay. If Jev is unreachable the House Mind fights instead.
// The mind is switchable per fighter (setSource): 'jev' (cloud), 'local' (an open-source model on
// this Mac, same wire format, via /api/local-jev) or 'house' (the House Mind, no network at all).
import type { GetupStyle, Intent, Tactic, WorldMeta } from '../core/protocol';
import type { Corner, FighterSetup, RobotDesign } from '../core/types';
import { DESIGNS } from '../robots/designs';
import { creativeRoll, gambleAppetite, IMPOSSIBLE_RISK, openingMenu, reflexMenu, riskBand } from './gambles';
import { breakRole, houseGetupStyle, houseMind, kipAppetite, obviousDecision, type RuleDecision } from './house-mind';
import type { JevResult } from './jev-client';
import { readyCombos } from './limbs';
import { JevLink } from './link';
import { sharedLocalLink } from './local-link';
import { FightMemory } from './memory';
import { FightObserver } from './observer';
import { decide, decideGambles, parseAnswers, parseExtras } from './policy';
import { buildQuestions, getupQuestion, type QuestionSet } from './questions';
import { freshRead, readHud } from './scouting';
import { COMBO_SEQUENCING, ComboSequencer, staticPlanView, type PlanSpec, type SeqStep } from './sequencer';
import { serializeState } from './serializer';
import { opensSetup, planOf, setupCombos } from './setups';
import { coarseKey, makeFighterContext, readSituation, type FighterContext, type Situation } from './situation';
import { BrainStatsTracker } from './stats';
import { designCombos, styleOf } from './style';
import { isFlashy, TACTIC_INFO } from './tactics';
import type { BrainDecision, BrainFrame, BrainStats, CommitMode, DecisionSource, DistanceBand, GambleView, JevStatus, MatchClock, MindLinkStatus, MindSource } from './types';

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
  localLink?: JevLink; // the LOCAL mind's link (default: the page-wide /api/local-jev link)
  source?: MindSource; // which mind decides (default 'jev')
  roundLengthS?: number;
  rounds?: number;
}

interface PendingRequest { tick: number; time: number; key: string; gen: number; trigger: string; qs: QuestionSet; appetite: number; kipRisk: number | null }

/** Bands where an opening move (or a creative gamble) is worth asking about. */
const GAMBLE_BANDS = new Set<DistanceBand>(['clinch', 'striking range', 'just outside reach', 'mid range']);
const CREATIVE_BANDS = new Set<DistanceBand>(['striking range', 'just outside reach']);
/** Bands where he could whiff or overcommit within the next second: worth arming a reflex. */
const REFLEX_BANDS = new Set<DistanceBand>(['clinch', 'striking range', 'just outside reach']);

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
  /** The cloud Jev link. */
  readonly link: JevLink;
  /** The LOCAL mind's link (touched only while the source is 'local'). */
  readonly localLink: JevLink;
  private mind: MindSource;
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
  /** Decisions emitted so far (the history is capped at HISTORY_LEN, so its length stops changing). */
  private emitted = 0;
  private memory: FightMemory;
  private readonly combos: Tactic[][];
  private lastAggression = 0.5;
  /** This knockdown's get-up call: null until decided (asked once per knockdown). */
  private getupStyle: GetupStyle | null = null;
  private getupAsked = false;
  /** Runs a combination step by step (setup → payoff) while the body cannot (COMBO_SEQUENCING). */
  private readonly seq = new ComboSequencer();
  /** The decision that started the running plan (its steps copy it for the HUD). */
  private planOrigin: BrainDecision | null = null;
  private latestView: { key: string; d: BrainDecision } | null = null;
  /** The referee is holding the fight (a break): every tick is settled locally, no model calls. */
  private onBreak = false;

  constructor(opts: BrainOptions) {
    const designs = opts.designs ?? DESIGNS;
    this.opts = opts;
    this.corner = opts.corner;
    this.link = opts.link ?? sharedJevLink();
    this.localLink = opts.localLink ?? sharedLocalLink();
    this.mind = opts.source ?? 'jev';
    const other: Corner = opts.corner === 0 ? 1 : 0;
    this.fc = makeFighterContext(opts.corner, resolveDesign(opts.meta, opts.corner, designs), resolveDesign(opts.meta, other, designs), opts.fighter);
    this.observer = new FightObserver(opts.corner);
    this.memory = new FightMemory(opts.corner);
    this.combos = designCombos(this.fc.design);
  }

  // ------------------------------------------------------------ lifecycle

  /** Start deciding (call on release). */
  start() { this.active = true; }

  /** Stop deciding; answers still in flight are ignored. */
  stop() {
    this.active = false;
    this.generation++;
    this.inFlight = 0;
  }

  // ------------------------------------------------------------ mind source

  /** Which mind decides: 'jev', 'local' or 'house'. */
  get source(): MindSource { return this.mind; }

  /**
   * Hot swap the mind between decisions. Answers still in flight from the old mind are dropped on
   * arrival (never applied), and the new mind decides on the next frame.
   */
  setSource(s: MindSource) {
    if (s === this.mind) return;
    this.mind = s;
    this.generation++;
    this.inFlight = 0;
    if (this.getupStyle === null) this.getupAsked = false; // a get-up question the old mind never answered
    this.seq.abort(); // the old mind's combination: the new mind decides from here
    this.planOrigin = null;
    this.pendingTrigger = 'mind_swap';
  }

  /** The model link the current source uses; null for the House Mind. */
  private get line(): JevLink | null {
    return this.mind === 'jev' ? this.link : this.mind === 'local' ? this.localLink : null;
  }

  /** No model to ask: the House Mind decides (chosen, or the chosen model is unreachable). */
  private get offline(): boolean {
    const l = this.line;
    return !l || l.offline;
  }

  private canSend(): boolean {
    const l = this.line;
    return !!l && l.canSend();
  }

  /** The mind link as the HUD shows it. */
  get linkStatus(): MindLinkStatus {
    if (this.mind === 'house') return { kind: 'house', label: 'HOUSE' };
    const l = this.line as JevLink;
    const name = this.mind === 'jev' ? 'JEV' : 'LOCAL';
    if (l.offline) return { kind: 'offline', label: `${name} OFFLINE → HOUSE` };
    if (this.mind === 'jev') return { kind: 'jev', label: 'JEV' };
    return { kind: 'local', label: l.model ? `LOCAL · ${l.model}` : 'LOCAL' };
  }

  /** Forget the fight so far (new round or reset). Stays stopped until start(). */
  reset() {
    this.stop();
    this.observer = new FightObserver(this.corner);
    this.memory = new FightMemory(this.corner);
    this.lastAggression = 0.5;
    this.getupStyle = null;
    this.getupAsked = false;
    this.seq.abort();
    this.planOrigin = null;
    this.latestView = null;
    this.onBreak = false;
    this.nextDecisionAt = 0;
    this.lastQueryAt = -Infinity;
    this.pendingTrigger = null;
    this.currentTactic = null;
    this.lastAppliedTick = -1;
    this.startTime = null;
    this.history = [];
  }

  // ------------------------------------------------------------ HUD read-outs

  /** The last decision, with the live plan step and the fresh read of his last answer laid over it. */
  get latest(): BrainDecision | null {
    const d = this.history[this.history.length - 1] ?? null;
    if (!d) return null;
    const plan = this.seq.view() ?? (COMBO_SEQUENCING === 'body' ? d.plan ?? null : null);
    const s = this.situation;
    const r = s ? freshRead(s.me, s.time) : null;
    const read = r ? readHud(r) : null;
    const link = this.linkStatus;
    const key = `${this.emitted}|${plan ? `${plan.step}:${plan.read ?? ''}:${plan.payoff.join()}` : '-'}|${read ?? ''}|${link.label}`;
    if (this.latestView?.key !== key) this.latestView = { key, d: { ...d, plan, read, link } };
    return this.latestView.d;
  }
  get decisions(): readonly BrainDecision[] { return this.history; }
  /** 'fallback' while the House Mind decides (source 'house', or the chosen model offline), else 'jev'. */
  get decisionSource(): DecisionSource { return this.offline ? 'fallback' : 'jev'; }
  get jevStatus(): JevStatus { return this.link.status; }
  get statsSnapshot(): BrainStats { return this.stats.snapshot(this.inFlight); }
  get inFlightCount(): number { return this.inFlight; }
  /** Per-fight memory (gambles, kip-ups, what of his keeps landing). */
  get fightMemory(): FightMemory { return this.memory; }

  // ------------------------------------------------------------ frame loop

  /** Feed every telemetry frame. `clock` comes from the round keeper when there is one. */
  onFrame(frame: BrainFrame, clock?: MatchClock) {
    const interrupts = this.observer.update(frame);
    this.memory.onFrame(frame);
    const s = readSituation(this.fc, frame);
    this.situation = s;
    if (!s.me.down) {
      this.getupStyle = null;
      this.getupAsked = false;
    }
    if (clock) this.clock = clock;
    if (!this.active) return;
    this.line?.poll(); // an offline LOCAL link re-probes its health when due (no-op for Jev, HOUSE and online links)
    this.startTime ??= frame.time;
    if (interrupts.length && this.pendingTrigger === null) this.pendingTrigger = interrupts[0];
    const onBreak = breakRole(s) !== null;
    if (onBreak !== this.onBreak) this.refereeEdge(onBreak);
    if (this.seq.active && this.mind === 'local' && this.planOrigin?.source === 'fallback' && !this.offline) {
      // The local model is back: it takes over from the House Mind's combination (Jev keeps its old behaviour).
      this.seq.abort();
      this.planOrigin = null;
      this.pendingTrigger ??= 'mind_online';
    }
    if (this.seq.active) {
      // A combination is running: the fighter is committed to it; no cadence questions until it ends.
      const out = this.seq.update(s, interrupts, this.fc.design);
      if (out === null) return;
      if (out !== 'done' && out !== 'aborted') return this.emitStep(out, s);
      this.planOrigin = null;
      this.pendingTrigger ??= out === 'done' ? 'plan_done' : 'plan_aborted';
    }
    const due = this.pendingTrigger !== null || frame.time >= this.nextDecisionAt;
    if (!due || frame.time - this.lastQueryAt < MIN_REQUEST_GAP_S) return;
    this.decideNow(s);
  }

  /**
   * The referee stopped the fight (a knockdown) or restarted it. Stopping: a plan or an answer from
   * before the knockdown is dropped (answers still in flight are never applied), and the break is
   * settled locally from here. FIGHT: decide at once, so the first intent after it is a fresh one.
   */
  private refereeEdge(onBreak: boolean) {
    this.onBreak = onBreak;
    if (onBreak) {
      this.generation++;
      this.inFlight = 0;
      this.seq.abort();
      this.planOrigin = null;
    }
    this.pendingTrigger = onBreak ? 'referee_break' : 'referee_fight';
    this.nextDecisionAt = 0;
    this.lastQueryAt = -Infinity;
  }

  private decideNow(s: Situation) {
    const trigger = this.pendingTrigger ?? 'cadence';
    const obvious = obviousDecision(this.fc, s, this.opts.seed);
    // Down: ask Jev once per knockdown whether to try a kip-up (a one-question call).
    if (s.me.down && !this.getupAsked && !this.offline && this.kipPossible(s)) {
      if (this.inFlight >= MAX_IN_FLIGHT || !this.canSend()) return;
      this.queryGetup(s, trigger);
      // A knockdown is a referee break: while the question is out, the body must not keep the
      // pre-knockdown intent (its combo, its armed reflex). Cover up; the get-up style stays undecided.
      if (this.onBreak && obvious) this.emitRule({ ...obvious, reason: 'down: getting up' }, 'local', s, trigger);
      return;
    }
    if (obvious && !this.offline) {
      this.stats.settledLocal++;
      this.emitRule(obvious, 'local', s, trigger);
      return;
    }
    // Offline (or the House Mind chosen), the House Mind owns every tick (obvious ones included), so the HUD shows it.
    if (this.offline && (obvious || !this.canSend())) {
      this.stats.fallbackDecisions++;
      this.emitRule(obvious ?? houseMind(this.fc, s, this.opts.seed), 'fallback', s, trigger);
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT || !this.canSend()) return; // stay due; retry next frame
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

  private kipRisk(s: Situation): number | null {
    const r = s.me.moveRisk?.kip_up;
    return r !== undefined && Number.isFinite(r) ? r : null;
  }

  /** A kip-up the body could attempt (worth one Jev call); a limp or seized joint rules it out. */
  private kipPossible(s: Situation): boolean {
    const r = this.kipRisk(s);
    return r !== null && r < IMPOSSIBLE_RISK;
  }

  private appetite(): number {
    return gambleAppetite(styleOf(this.fc.design), this.fc.setup.temperament, this.lastAggression);
  }

  /**
   * The optional questions for this decision: opening_move (openings, or a creative roll), combo
   * (only combinations the body can still throw) and on_opening (the reflex to pre-arm, in range
   * with both on their feet: a downed opponent cannot whiff or overcommit, as in the House Mind).
   */
  private extras(s: Situation, appetite: number) {
    const openings = s.me.openings ?? [];
    const combos = readyCombos(s.me, this.combos);
    const setups = REFLEX_BANDS.has(s.band) || s.band === 'mid range' ? setupCombos(this.fc.design, s.me, s.opp) : [];
    const creative = !openings.length && CREATIVE_BANDS.has(s.band) && creativeRoll(appetite, this.opts.seed, this.corner, s.tick);
    const menu = GAMBLE_BANDS.has(s.band) && (openings.length || creative) && !s.me.down
      ? openingMenu(this.fc.design, s.me, openings, (t) => TACTIC_INFO[t].description, creative, combos.length > 0)
      : null;
    const reflex = REFLEX_BANDS.has(s.band) && !s.me.down && s.oppPhase !== 'down' ? reflexMenu(this.fc.design, s.me) : null;
    return { menu, combos, setups, reflex, range: s.range };
  }

  private query(s: Situation, trigger: string) {
    const appetite = this.appetite();
    const qs = buildQuestions(this.fc, s.opp, this.extras(s, appetite));
    const state = serializeState(this.fc, s, this.observer.recentActions(s.time), this.matchClock(s), this.currentTactic, this.memory.words());
    const req: PendingRequest = { tick: s.tick, time: s.time, key: coarseKey(s), gen: this.generation, trigger, qs, appetite, kipRisk: this.kipRisk(s) };
    this.inFlight++;
    this.stats.requests++;
    this.schedule(s);
    (this.line as JevLink).send(state, qs.questions).then(
      (res) => this.onAnswer(req, res),
      () => this.onFailure(req),
    );
  }

  /** Down on the canvas: one small call, "try a kip-up?". Its answer holds for this knockdown. */
  private queryGetup(s: Situation, trigger: string) {
    const kipRisk = this.kipRisk(s) as number;
    const qs: QuestionSet = { questions: { getup_style: getupQuestion(kipRisk) }, tactics: [], targets: [], counters: [], menu: [], creative: false, combos: [], setups: [], getup: true, reflex: [] };
    const state = serializeState(this.fc, s, this.observer.recentActions(s.time), this.matchClock(s), this.currentTactic, this.memory.words());
    const req: PendingRequest = { tick: s.tick, time: s.time, key: coarseKey(s), gen: this.generation, trigger, qs, appetite: kipAppetite(this.fc), kipRisk };
    this.getupAsked = true;
    this.inFlight++;
    this.stats.requests++;
    this.schedule(s);
    (this.line as JevLink).send(state, qs.questions).then(
      (res) => this.onGetupAnswer(req, res),
      () => this.onFailure(req),
    );
  }

  private onGetupAnswer(req: PendingRequest, res: JevResult) {
    if (req.gen !== this.generation) return; // stopped, reset or mind swapped since: never applied
    this.inFlight--;
    this.stats.recordAnswer(res.latencyMs, res.inputTokens, res.outputTokens);
    const now = this.situation;
    if (!now || !now.me.down) { this.stats.droppedStale++; return; }
    const g = decideGambles({ extras: parseExtras(res, req.qs), qs: req.qs, appetite: req.appetite, temperature: this.fc.setup.temperament, kipRisk: req.kipRisk, seed: this.opts.seed, corner: this.corner, tick: req.tick });
    this.getupStyle = g.getupStyle ?? 'safe';
    const kipYes = res.answers.getup_style?.type === 'noul' ? res.answers.getup_style.noul : null;
    const rule = obviousDecision(this.fc, now, this.opts.seed) ?? houseMind(this.fc, now, this.opts.seed);
    const pct = (p: number) => `${Math.round(p * 100)}%`;
    const odds = kipYes === null || g.kipP === null ? '' : ` (Jev ${pct(kipYes)}, appetite ${pct(g.kipP)})`;
    const reason = `${this.getupStyle === 'kip_up' ? 'down: going for the kip-up' : 'down: safe get-up'}${odds}`;
    this.emitRule({ ...rule, getupStyle: this.getupStyle, reason }, 'jev', now, req.trigger, res.latencyMs);
  }

  private onAnswer(req: PendingRequest, res: JevResult) {
    if (req.gen !== this.generation) return; // stopped, reset or mind swapped since: never applied
    this.inFlight--;
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
      (this.line ?? this.link).markFailed(e);
      this.onFailure(req, false);
      return;
    }
    const out = decide({ parsed, situation: now, current: this.currentTactic, temperature: this.fc.setup.temperament, seed: this.opts.seed, corner: this.corner, tick: req.tick });
    const g = decideGambles({ extras: parseExtras(res, req.qs), qs: req.qs, appetite: req.appetite, temperature: this.fc.setup.temperament, kipRisk: req.kipRisk, seed: this.opts.seed, corner: this.corner, tick: req.tick });
    // An opening move overrides the tactic: code saw the opening, Jev chose to go for it. A feint
    // (or a jab, a low kick) that opens the setup Jev picked in the combo answer runs as that setup.
    const promote = !g.move && out.tactic !== 'combo' && !!g.setup && opensSetup(out.tactic, g.setup);
    const tactic = g.move ?? (promote ? 'combo' : out.tactic);
    const target = g.move ? g.target ?? out.target : out.target;
    const combo = tactic === 'combo' ? g.combo ?? req.qs.combos[0] ?? null : null;
    const setup = combo && g.setup ? g.setup : null;
    const comboPlan = setup ? planOf(setup) : undefined;
    const flourish = g.move !== null && (isFlashy(g.move) || g.opening !== null);
    const aggression = g.move ? Math.max(out.aggression, parsed.aggression) : out.aggression;
    const intent: Intent = {
      tactic, target: comboPlan ? comboPlan.zones[0] : target, aggression, counterIfLunge: parsed.counter, confidence: parsed.tacticConfidence, source: 'jev',
      ...(combo ? { combo } : {}), ...(comboPlan ? { comboPlan } : {}), ...(flourish ? { flourish } : {}), ...(g.onOpening ? { onOpening: g.onOpening } : {}),
    };
    const gamble: GambleView | null = g.move ? { move: g.move, opening: g.opening, p: g.moveP, risk: g.risk } : null;
    const reason = g.move ? `${g.opening ? 'took the opening' : 'creative gamble'}${g.risk !== null ? `, ${riskBand(g.risk)}` : ''}` : setup ? `set him up: ${setup.why}` : out.reason;
    this.lastAppliedTick = req.tick;
    if (out.mode !== 'commit') this.nextDecisionAt = Math.min(this.nextDecisionAt, req.time + BAND_INTERVAL_S[now.band] * MODE_INTERVAL_SCALE[out.mode]);
    this.emit(intent, req.tick, {
      tick: req.tick, time: req.time, source: 'jev', mode: out.mode, tactic, target,
      aggression, counterIfLunge: parsed.counter, confidence: parsed.tacticConfidence,
      tacticProbs: parsed.tacticProbs, targetProbs: parsed.targetProbs, oppCommit: parsed.oppCommit,
      winning: parsed.winning, latencyMs: res.latencyMs, reason, trigger: req.trigger,
      openings: now.me.openings ?? [], gamble, combo, flourish, onOpening: g.onOpening,
      ...(comboPlan && combo && COMBO_SEQUENCING === 'body' ? { plan: staticPlanView({ steps: combo, ...comboPlan }, now.me) } : {}),
    }, now);
    if (combo) this.startPlan(combo, comboPlan, intent, now);
  }

  /** Sequence a combination the body cannot run by itself yet (plain ones: every strike, no setup). */
  private startPlan(combo: Tactic[], plan: Intent['comboPlan'], intent: Intent, s: Situation) {
    if (COMBO_SEQUENCING !== 'brain' || combo.length < 2 || !this.seq.canStart(s)) return;
    const spec: PlanSpec = plan
      ? { steps: combo, zones: plan.zones, setup: plan.setup, payoffZone: plan.payoffZone, ...(plan.fishing ? { fishing: plan.fishing } : {}), ...(plan.tempo ? { tempo: plan.tempo } : {}) }
      : { steps: combo, zones: combo.map(() => intent.target), setup: 0, payoffZone: intent.target };
    this.seq.start(spec, intent, s);
    this.planOrigin = this.history[this.history.length - 1] ?? null;
    // Any answer still in flight was asked before the fighter committed to this plan: drop it on
    // arrival, or it would cut into the plan's first step (Jev is often slower than the 0.25 s cadence).
    this.lastAppliedTick = Math.max(this.lastAppliedTick, s.tick);
  }

  /** The next step of the running combination goes out as its own intent (no Jev call). */
  private emitStep(step: SeqStep, s: Situation) {
    const origin = this.planOrigin;
    if (!origin) { this.seq.abort(); return; }
    const i = step.intent;
    this.lastAppliedTick = Math.max(this.lastAppliedTick, s.tick);
    this.lastQueryAt = s.time;
    this.emit(i, s.tick, {
      ...origin, tick: s.tick, time: s.time, tactic: i.tactic, target: i.target, aggression: i.aggression,
      reason: step.reason, trigger: 'plan', latencyMs: null, onOpening: i.onOpening ?? null,
      gamble: null, openings: s.me.openings ?? [],
    }, s);
  }

  /** Jev failed (the link is now offline): the House Mind takes this decision immediately. */
  private onFailure(req: PendingRequest, decrement = true) {
    if (req.gen !== this.generation) return;
    if (decrement) this.inFlight--;
    this.stats.errors++;
    const s = this.situation;
    if (!s || !this.active) return;
    this.stats.fallbackDecisions++;
    this.emitRule(houseMind(this.fc, s, this.opts.seed), 'fallback', s, req.trigger);
  }

  // ------------------------------------------------------------ output

  private emitRule(rule: RuleDecision, source: DecisionSource, s: Situation, trigger: string, latencyMs: number | null = null) {
    // Down: this knockdown's get-up call holds for every intent until up. While Jev's answer is
    // in flight it stays undecided (the body's default, a safe get-up), never the House Mind's guess.
    const pending = this.getupAsked && this.getupStyle === null && source !== 'fallback';
    const getupStyle = !s.me.down || pending ? undefined : this.getupStyle ?? rule.getupStyle ?? houseGetupStyle(this.fc, s, this.opts.seed);
    if (s.me.down && source === 'fallback' && this.getupStyle === null) this.getupStyle = getupStyle ?? 'safe';
    // The House Mind rolls its kip-up per tick; this knockdown's latched call is what the body does.
    const reason = s.me.down && source !== 'jev' && getupStyle && rule.getupStyle && getupStyle !== rule.getupStyle
      ? (getupStyle === 'kip_up' ? 'down: try a kip-up' : 'down: cover up while the body gets up')
      : rule.reason;
    const intent: Intent = {
      tactic: rule.tactic, target: rule.target, aggression: rule.aggression, counterIfLunge: rule.counterIfLunge,
      confidence: 1, source: source === 'fallback' ? 'fallback' : 'jev',
      ...(source === 'local' ? { settledLocally: true } : {}),
      ...(rule.combo ? { combo: rule.combo } : {}), ...(rule.comboPlan ? { comboPlan: rule.comboPlan } : {}),
      ...(getupStyle ? { getupStyle } : {}), ...(rule.flourish ? { flourish: true } : {}),
      ...(rule.onOpening ? { onOpening: rule.onOpening } : {}),
    };
    this.schedule(s);
    this.lastAppliedTick = Math.max(this.lastAppliedTick, s.tick);
    this.emit(intent, s.tick, {
      tick: s.tick, time: s.time, source, mode: 'commit', tactic: rule.tactic, target: rule.target,
      aggression: rule.aggression, counterIfLunge: rule.counterIfLunge, confidence: 1,
      tacticProbs: { [rule.tactic]: 1 }, targetProbs: { [rule.target]: 1 }, oppCommit: null,
      winning: null, latencyMs, reason, trigger,
      openings: s.me.openings ?? [], combo: rule.combo ?? null, flourish: !!rule.flourish, ...(getupStyle ? { getupStyle } : {}),
      onOpening: rule.onOpening ?? null,
      gamble: rule.gamble ? { ...rule.gamble, p: null } : null,
    }, s);
    if (rule.combo && rule.tactic === 'combo') this.startPlan(rule.combo, rule.comboPlan, intent, s);
  }

  private emit(intent: Intent, issuedAtTick: number, d: BrainDecision, s: Situation) {
    this.memory.onIntent(intent, s.time, isFlashy(intent.tactic), s.me.down);
    this.lastAggression = intent.aggression;
    this.currentTactic = intent.tactic;
    this.history = [...this.history.slice(-(HISTORY_LEN - 1)), d];
    this.emitted++;
    this.opts.onIntent(this.corner, intent, issuedAtTick);
    this.opts.onDecision?.(d);
  }
}
