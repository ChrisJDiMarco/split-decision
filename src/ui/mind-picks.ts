// Which mind fights each corner: JEV (cloud), LOCAL (an open-source Jev-compatible model on this
// Mac), HOUSE (the House Mind rules) or YOU (the human player). The pick lives on the corner's
// FighterSetup (controller 'player' for YOU, `mind` otherwise); the global MINDS setting overrides
// every corner that is not YOU. Pure functions, shared by the select screen, the broadcast and main.
import type { GlobalMinds } from '../core/settings';
import type { Corner, FighterMind, FighterSetup, MatchSetup } from '../core/types';
import { PLAYER_REACTION_DELAY_S } from '../player/config';

export type CornerPick = FighterMind | 'you';
export const CORNER_PICKS: readonly CornerPick[] = ['jev', 'local', 'house', 'you'];
export const FIGHTER_MINDS: readonly FighterMind[] = ['jev', 'local', 'house'];

export const PICK_LABEL: Record<CornerPick, string> = { jev: 'JEV', local: 'LOCAL', house: 'HOUSE', you: 'YOU' };
export const PICK_DETAIL: Record<CornerPick, string> = {
  jev: 'CLOUD JEV',
  local: 'OPEN-SOURCE JEV ON THIS MAC',
  house: 'HOUSE RULES · NO MODEL',
  you: 'YOU · WASD + MOUSE',
};
/** The tale of the tape's MIND value (the select card and the walkout). */
export const MIND_TAG: Record<CornerPick, string> = { jev: 'JEV · CLOUD', local: 'LOCAL · ON THIS MAC', house: 'HOUSE · RULES', you: 'YOU · PLAYER' };
export const GLOBAL_LABEL: Record<GlobalMinds, string> = { corner: 'PER CORNER', jev: 'ALL JEV', local: 'ALL LOCAL', house: 'ALL HOUSE' };

/** Where to read about running the LOCAL model (the select screen's hint when it is not running). */
export const LOCAL_SETUP_DOC = 'docs/design/local-mind.md';

/** The corner's own pick (ignoring the global override). */
export function cornerPick(f: FighterSetup): CornerPick {
  return f.controller === 'player' ? 'you' : f.mind ?? 'jev';
}

/** The mind that actually fights this corner: YOU stays YOU, anything else follows the global override. */
export function effectiveMind(f: FighterSetup, global: GlobalMinds): CornerPick {
  if (f.controller === 'player') return 'you';
  return global === 'corner' ? f.mind ?? 'jev' : global;
}

/** Is this corner's own pick overridden by the global setting right now? */
export function isOverridden(f: FighterSetup, global: GlobalMinds): boolean {
  return f.controller !== 'player' && global !== 'corner' && global !== (f.mind ?? 'jev');
}

/** The player's corner, or -1. */
export function playerCornerOf(setup: Pick<MatchSetup, 'fighters'>): Corner | -1 {
  const i = setup.fighters.findIndex((f) => f.controller === 'player');
  return i === 0 || i === 1 ? i : -1;
}

/** Back to a mind (the given one, or the corner's previous mind): no player controller, no player delay. */
function asMind(f: FighterSetup, mind?: FighterMind): FighterSetup {
  const { controller: _controller, reactionDelayS: _delay, ...rest } = f;
  const m = mind ?? f.mind;
  return m ? { ...rest, mind: m } : rest;
}

/**
 * Pick a mind for one corner. At most one corner is YOU (one keyboard): choosing YOU in one corner
 * sends the other back to the mind it had before it was YOU. Returns new setups; inputs untouched.
 */
export function pickMind(fighters: readonly [FighterSetup, FighterSetup], corner: Corner, pick: CornerPick): [FighterSetup, FighterSetup] {
  const out: [FighterSetup, FighterSetup] = [{ ...fighters[0] }, { ...fighters[1] }];
  const other: Corner = corner === 0 ? 1 : 0;
  if (pick === 'you') {
    out[corner] = { ...out[corner], controller: 'player' };
    if (out[other].controller === 'player') out[other] = asMind(out[other]);
  } else {
    out[corner] = asMind(out[corner], pick);
  }
  return out;
}

/**
 * The setup a fight starts from: a YOU corner gets the player's reaction delay (or, in FAIR MODE,
 * none of its own, so it feels Jev's MatchSetup.reactionDelayS). A setup with no player comes back
 * as the same object, so JEV v JEV starts exactly as before.
 */
export function finalizeSetup(setup: MatchSetup, fairMode: boolean): MatchSetup {
  if (playerCornerOf(setup) === -1) return setup;
  const fix = (f: FighterSetup): FighterSetup => {
    if (f.controller !== 'player') return f;
    const { reactionDelayS: _delay, ...rest } = f;
    return fairMode ? rest : { ...rest, reactionDelayS: PLAYER_REACTION_DELAY_S };
  };
  return { ...setup, fighters: [fix(setup.fighters[0]), fix(setup.fighters[1])] };
}

/** What the LOCAL bridge's /api/local-jev/health reported (null: not probed yet). */
export interface LocalHealthView { ok: boolean; model?: string; latencyMs?: number; error?: string }

/** One status line for the LOCAL model: 'READY · decider-4b · 480 MS' or 'NOT RUNNING · MODEL NOT PULLED'. */
export function localStatusLine(h: LocalHealthView | null): { ok: boolean | null; text: string } {
  if (!h) return { ok: null, text: 'CHECKING THE LOCAL MODEL…' };
  if (h.ok) {
    const ms = typeof h.latencyMs === 'number' && Number.isFinite(h.latencyMs) ? ` · ${Math.round(h.latencyMs)} MS` : '';
    return { ok: true, text: `READY · ${h.model ?? 'LOCAL MODEL'}${ms}` };
  }
  return { ok: false, text: `NOT RUNNING · ${localReason(h.error)}` };
}

function localReason(error: string | undefined): string {
  const e = (error ?? '').toLowerCase();
  // probeLocalHealth's own failures: the dev server's bridge itself did not answer.
  if (e.startsWith('health unreachable') || e.startsWith('health http')) return 'NO LOCAL BRIDGE';
  if (e.includes('not pulled') || e.includes('not found')) return 'MODEL NOT PULLED';
  if (e.includes('refused') || e.includes('unreachable') || e.includes('fetch failed') || e.includes('econn')) return 'RUNTIME NOT RUNNING';
  return 'OFFLINE';
}
