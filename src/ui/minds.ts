// What the broadcast needs from each fighter's brain to draw the JEV MIND panel.
// Structurally compatible with the brain's BrainDecision, so the integration can pass
// decisions straight through without a mapping step.

export type MindSource = 'jev' | 'local' | 'fallback';

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
