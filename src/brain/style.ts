// Fight styles (docs/research/08-modern-roster.md): each design's style weights its flashy and
// opportunistic menu, supplies its signature combinations, and sets how readily it gambles.
//   FIRECRACKER  swarmer: volume, jab-cross into hooks and uppercuts, low kicks, jumping knees
//   SAVATE       kickboxer: jab, low kicks until the stance gives, then upstairs; spinning kicks
//   HAYMAKER     pressure brawler: walks forward, digs hooks and uppercuts, loads the overhand
//   PYLON        distance kicker: long front kicks, head kicks from range, spins
import type { Tactic } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import { abilityTactics } from './tactics';

export type StyleId = 'swarmer' | 'kickboxer' | 'pressure' | 'distance' | 'brawler';

export interface StyleProfile {
  id: StyleId;
  words: string; // one line Jev reads ("a swarmer: volume ...")
  /** Prior weight on moves in the opening menu and on combos that feature them (default 1). */
  weights: Partial<Record<Tactic, number>>;
  /** Signature combinations, best first (filtered by what the design can throw). */
  combos: Tactic[][];
  /** Base appetite for flashy gambles (1 = neutral). */
  gamble: number;
}

export const STYLES: Record<StyleId, StyleProfile> = {
  swarmer: {
    id: 'swarmer',
    words: 'a swarmer: get inside, throw volume, chop the lead knee',
    weights: { jab: 1.3, cross: 1.2, hook: 1.4, uppercut: 1.4, low_kick: 1.2, superman_punch: 1.5, jumping_knee: 1.4, spinning_backfist: 1.2, combo: 1.5, tornado_kick: 0.5 },
    combos: [
      ['jab', 'cross', 'hook'], ['jab', 'cross', 'hook', 'uppercut'], ['jab', 'jab', 'cross'], ['hook', 'uppercut', 'hook'],
      ['jab', 'cross', 'low_kick'], ['uppercut', 'hook', 'cross'], ['jab', 'superman_punch'], ['feint_left', 'jumping_knee'],
    ],
    gamble: 1.1,
  },
  kickboxer: {
    id: 'kickboxer',
    words: 'a kickboxer: measure with the jab, chop the legs, then go upstairs with the head kick',
    weights: { low_kick: 1.4, head_kick: 1.4, tornado_kick: 1.4, spinning_back_kick: 1.4, jump_kick: 1.2, front_kick: 1.2, combo: 1.3, uppercut: 0.8 },
    combos: [
      ['jab', 'cross', 'low_kick'], ['jab', 'cross', 'hook', 'low_kick'], ['jab', 'low_kick'], ['feint_left', 'head_kick'],
      ['jab', 'cross', 'head_kick'], ['low_kick', 'low_kick', 'head_kick'], ['jab', 'spinning_back_kick'], ['cross', 'hook', 'tornado_kick'],
    ],
    gamble: 1.2,
  },
  pressure: {
    id: 'pressure',
    words: 'a pressure brawler: walk him down behind a high guard, dig hooks and uppercuts, load the overhand',
    weights: { hook: 1.4, uppercut: 1.4, overhand: 1.4, clinch: 1.2, cage_pin: 1.3, low_kick: 1.1, superman_punch: 1.1, spinning_backfist: 1.1, combo: 1.3, tornado_kick: 0.4, jump_kick: 0.5 },
    combos: [
      ['jab', 'cross', 'hook'], ['hook', 'uppercut', 'overhand'], ['jab', 'overhand'], ['low_kick', 'cross'],
      ['uppercut', 'hook'], ['jab', 'cross', 'hook', 'overhand'], ['hook', 'spinning_backfist'], ['feint_right', 'overhand'],
    ],
    gamble: 0.8,
  },
  distance: {
    id: 'distance',
    words: 'a distance kicker: keep him on the end of long front kicks, poke the jab, kick from where he cannot reach',
    weights: { front_kick: 1.4, head_kick: 1.4, low_kick: 1.2, spinning_back_kick: 1.5, tornado_kick: 1.3, jump_kick: 1.3, spinning_backfist: 1.3, clinch: 0.4, combo: 1.1, uppercut: 0.6 },
    combos: [
      ['jab', 'front_kick'], ['jab', 'jab', 'spinning_backfist'], ['jab', 'head_kick'], ['low_kick', 'head_kick'],
      ['front_kick', 'spinning_back_kick'], ['feint_left', 'head_kick'], ['jab', 'cross', 'front_kick'], ['jab', 'tornado_kick'],
    ],
    gamble: 1.25,
  },
  brawler: {
    id: 'brawler',
    words: 'an iron-age brawler: heavy single shots',
    weights: {},
    combos: [['jab', 'cross'], ['jab', 'cross', 'hook'], ['jab', 'overhand'], ['cross', 'hook'], ['jab', 'low_kick'], ['jab', 'head_kick']],
    gamble: 0.7,
  },
};

const DESIGN_STYLE: Record<string, StyleId> = { firecracker: 'swarmer', savate: 'kickboxer', haymaker: 'pressure', pylon: 'distance' };

export function styleOf(design: RobotDesign): StyleProfile {
  return STYLES[DESIGN_STYLE[design.id] ?? 'brawler'];
}

export function styleWeight(style: StyleProfile, t: Tactic): number {
  return style.weights[t] ?? 1;
}

/** What a flashy move needs the design to be able to throw already (any one of). */
export const FLASHY_REQUIRES: Partial<Record<Tactic, Tactic[]>> = {
  tornado_kick: ['head_kick'],
  spinning_back_kick: ['front_kick', 'head_kick'],
  jump_kick: ['front_kick'],
  jumping_knee: ['front_kick', 'clinch'],
  superman_punch: ['cross'],
  spinning_backfist: ['hook', 'cross'],
};
const FEINTS = new Set<Tactic>(['feint', 'feint_left', 'feint_right']);

/** Can this design throw `t` at all (its own abilities, a flashy move it has the base for, or a feint)? */
export function canThrow(design: RobotDesign, t: Tactic): boolean {
  if (FEINTS.has(t)) return true;
  const own = abilityTactics(design);
  const needs = FLASHY_REQUIRES[t];
  return needs ? needs.some((n) => own.includes(n)) : own.includes(t);
}

export const COMBO_MIN = 4;
export const COMBO_MAX = 8;

/** Combination id as shown to Jev and the HUD: 'jab-cross-low_kick'. */
export function comboId(c: readonly Tactic[]): string {
  return c.join('-');
}

/**
 * 4-8 combinations that fit this design's style and abilities: its signature combos first, then
 * generic ones built from its own punches and kicks.
 */
export function designCombos(design: RobotDesign): Tactic[][] {
  const style = styleOf(design);
  const out: Tactic[][] = [];
  const seen = new Set<string>();
  const add = (c: Tactic[]) => {
    const id = comboId(c);
    if (out.length >= COMBO_MAX || seen.has(id) || c.length < 2 || !c.every((t) => canThrow(design, t))) return;
    seen.add(id);
    out.push(c);
  };
  for (const c of style.combos) add(c);
  const own = abilityTactics(design);
  const lead = own.includes('jab') ? 'jab' : own[0];
  const power = (['cross', 'hook', 'overhand', 'uppercut'] as Tactic[]).filter((t) => own.includes(t));
  const kicks = (['low_kick', 'front_kick', 'head_kick'] as Tactic[]).filter((t) => own.includes(t));
  for (const p of power) add([lead, p]);
  for (const k of kicks) add([lead, k]);
  for (const p of power) for (const k of kicks) add([lead, p, k]);
  if (out.length < COMBO_MIN) for (const t of own) add([t, t]);
  return out;
}
