// What the broadcast needs from each fighter's brain to draw the JEV MIND panel.
// Structurally compatible with the brain's BrainDecision, so the integration can pass
// decisions straight through without a mapping step.

export type MindSource = 'jev' | 'local' | 'fallback';

/** Which mind the fighter runs, as the badge shows it (the brain's MindLinkStatus). */
export interface MindLink {
  kind: 'jev' | 'local' | 'house' | 'offline'; // 'offline': the chosen model is unreachable, the House Mind fights
  label: string; // 'JEV', 'LOCAL · decider-4b', 'HOUSE', 'LOCAL OFFLINE → HOUSE'
}

export interface MindView {
  source: MindSource; // 'fallback' shows the JEV OFFLINE · HOUSE MIND badge
  tactic: string; // the chosen tactic
  target: string; // the chosen target zone
  aggression: number; // 0..1
  tacticProbs: Record<string, number>; // tactic → probability
  targetProbs?: Record<string, number>;
  oppCommit: number | null; // P(opponent commits), the READ meter
  latencyMs: number | null;
  confidence?: number;
  mode?: string; // 'commit' | 'probe' | 'guard'
  reason?: string;
  openings?: readonly string[]; // what the fighter saw on its opponent
  gamble?: { move: string; opening: string | null; p: number | null; risk: number | null } | null;
  combo?: readonly string[] | null; // the combination being thrown
  getupStyle?: string; // 'safe' | 'kip_up', while down
  onOpening?: Readonly<Record<string, string | undefined>> | null; // pre-armed reflex: opening → move
  plan?: MindPlan | null; // the setup → payoff combination running, step by step
  read?: string | null; // his answer to the last feint, while fresh: 'HE BIT: COVERED HIGH'
  link?: MindLink; // which mind decides (absent: JEV, or JEV OFFLINE on fallback)
}

/**
 * The latency chip: '<mind> · 265 ms', '<mind> · RULE' for a tick settled by a code rule,
 * 'HOUSE' for the House Mind. <mind> is the link label (JEV, LOCAL · decider-4b).
 */
export function mindChip(mind: MindView): string {
  const name = mind.link && mind.link.kind !== 'offline' ? mind.link.label : 'JEV';
  if (mind.source === 'fallback' || mind.link?.kind === 'house') return 'HOUSE';
  if (mind.source === 'local') return `${name} · RULE`;
  return mind.latencyMs === null ? name : `${name} · ${Math.round(mind.latencyMs)} ms`;
}

/** The offline badge text, or null when a model (or the chosen House Mind) is deciding. */
export function offlineBadge(mind: MindView): string | null {
  if (mind.link) return mind.link.kind === 'offline' ? mind.link.label : null;
  return mind.source === 'fallback' ? 'JEV OFFLINE · HOUSE MIND' : null;
}

/** A setup → payoff plan as the MIND panel shows it (the brain's PlanView). */
export interface MindPlan {
  setup: readonly string[]; // 'feint high'
  payoff: readonly string[]; // 'low kick'
  payoffZone: string;
  note: string | null; // 'left knee 40%'
  step: number;
  phase: 'setup' | 'payoff';
  read?: string | null;
}

/**
 * "SETUP: FEINT HIGH → PAYOFF: LOW KICK · LEFT KNEE 40%"; a plain combination (no setup) reads
 * "COMBO: JAB › CROSS › HOOK"; null with no plan.
 */
export function planLine(mind: MindView): string | null {
  const p = mind.plan;
  if (!p) return null;
  const up = (xs: readonly string[]) => xs.map((x) => x.toUpperCase()).join(' › ');
  if (!p.setup.length) return `COMBO: ${up(p.payoff)}`;
  const where = p.note ? p.note.toUpperCase() : tacticLabel(p.payoffZone);
  return `SETUP: ${up(p.setup)} → PAYOFF: ${up(p.payoff)} · ${where}`;
}

/** "READ · HE BIT: COVERED HIGH", or null. */
export function readLine(mind: MindView): string | null {
  const r = mind.read ?? mind.plan?.read ?? null;
  return r ? `READ · ${r}` : null;
}

/** "OPENING: TURNED AWAY → SPINNING BACK KICK 41%" (or "GAMBLE → ..." with no opening), or null. */
export function gambleLine(mind: MindView): string | null {
  const g = mind.gamble;
  if (!g) return null;
  const head = g.opening ? `OPENING: ${tacticLabel(g.opening)}` : 'GAMBLE';
  const p = g.p === null || !Number.isFinite(g.p) ? '' : ` ${Math.round(g.p * 100)}%`;
  return `${head} → ${tacticLabel(g.move)}${p}`;
}

/** "JAB › CROSS › LOW KICK", or null. */
export function comboLine(mind: MindView): string | null {
  return mind.combo?.length ? mind.combo.map(tacticLabel).join(' › ') : null;
}

/** Openings seen without a gamble taken: "SEES: LOW GUARD · ON CAGE", or null. */
export function seesLine(mind: MindView): string | null {
  if (mind.gamble || !mind.openings?.length) return null;
  return `SEES: ${mind.openings.slice(0, 3).map(tacticLabel).join(' · ')}`;
}

const REFLEX_LABEL: Record<string, string> = { missed_recovering: 'WHIFF', overcommitted: 'OVERCOMMIT' };

/**
 * The armed reflex: "ARMED: WHIFF → SPINNING BACKFIST" (one move for both a whiff and an
 * overcommit reads as a whiff), "ARMED: OVERCOMMIT → SIDESTEP COUNTER", or null.
 */
export function armedLine(mind: MindView): string | null {
  const armed = Object.entries(mind.onOpening ?? {}).filter((e): e is [string, string] => !!e[1]);
  if (!armed.length) return null;
  const moves = [...new Set(armed.map(([, m]) => m))];
  if (moves.length === 1) {
    const whiff = armed.some(([o]) => o === 'missed_recovering');
    const head = whiff ? 'WHIFF' : REFLEX_LABEL[armed[0][0]] ?? tacticLabel(armed[0][0]);
    return `ARMED: ${head} → ${tacticLabel(moves[0])}`;
  }
  return `ARMED: ${armed.map(([o, m]) => `${REFLEX_LABEL[o] ?? tacticLabel(o)} → ${tacticLabel(m)}`).join(' · ')}`;
}

/** Per-corner minds, red first. A null entry means "no decision yet". */
export type Minds = readonly [MindView | null, MindView | null];

export interface RankedTactic {
  tactic: string;
  p: number;
}

/** Top-n tactics by probability, normalised so the shown bars read as shares of the whole. */
export function topTactics(probs: Record<string, number>, n = 5): RankedTactic[] {
  const entries = Object.entries(probs).filter(([, p]) => Number.isFinite(p) && p > 0);
  const total = entries.reduce((s, [, p]) => s + p, 0);
  if (total <= 0) return [];
  return entries
    .map(([tactic, p]) => ({ tactic, p: p / total }))
    .sort((a, b) => b.p - a.p)
    .slice(0, n);
}

/** 'close_distance' → 'CLOSE DISTANCE'. */
export function tacticLabel(tactic: string): string {
  return tactic.replace(/_/g, ' ').toUpperCase();
}
