// Shell mechanics for physical dents (docs/design/strike-power.md §4.1-4.2). A hit loads a shell
// panel like a clamped circular plate of radius a = span/2 under a central point load:
//   stiffness        k = 16πD / a²,  D = E·h³ / 12(1 − ν²)      (Timoshenko & Woinowsky-Krieger)
//   collapse load    P_c = π·σy·h² / 2                           (plastic limit load of a point load)
//   elastic limit    E_el = P_c² / 2k                            (work it stores before it yields)
//   permanent dent   W − E_el = P_c·(δ + δ³ / 3h²)               (bending, then membrane stretching)
// Estimates, not FEA (they bracket the audit's membrane estimate); they set PROVISIONAL thresholds.
// Pure functions: deterministic, so replays and late joiners see the same dents.
import type { FailureMode, MaterialId } from '../../core/types';
import { MATERIALS } from '../../robots/catalog';
import { DAMAGE_TUNING } from './constants';

/** A surface as the damage model sees it: a shell panel, a solid striker or a cushion. */
export interface Surface {
  material: MaterialId;
  mode: FailureMode;
  /** Shell wall (m); 0 for solids and cushions. */
  thicknessM: number;
  /** Panel radius a (m) of a shell; 0 for solids. */
  radiusM: number;
  /** Local contact stiffness (N/m): how much of a hit's work this side takes in the split. */
  stiffness: number;
  /** Point-load collapse (N) and elastic work limit (J) of a shell; Infinity for solids and cushions. */
  collapseN: number;
  elasticJ: number;
  sparks: boolean;
}

/** Plate stiffness under a central point load, N/m. */
export function plateStiffness(youngsPa: number, poisson: number, h: number, a: number): number {
  const D = (youngsPa * h * h * h) / (12 * (1 - poisson * poisson));
  return (16 * Math.PI * D) / (a * a);
}

/** Point-load plastic collapse of a plate of wall h, N. */
export function collapseLoad(yieldPa: number, h: number): number {
  return (Math.PI * yieldPa * h * h) / 2;
}

/**
 * Permanent dent depth (m) for plastic work wp (J): the real root of P_c·(δ + δ³/3h²) = wp, i.e.
 * δ³ + 3h²·δ − 3h²·wp/P_c = 0 (Cardano; one real root since the linear term is positive).
 */
export function dentDepth(wp: number, collapseN: number, h: number): number {
  if (!(wp > 0) || !(collapseN > 0) || !(h > 0)) return 0;
  const p = 3 * h * h;
  const q = -(p * wp) / collapseN;
  const disc = Math.sqrt((q * q) / 4 + (p * p * p) / 27);
  return Math.cbrt(-q / 2 + disc) + Math.cbrt(-q / 2 - disc);
}

/** A shell panel of `material`, `thicknessMm` thick, spanning `spanM`. */
export function shellSurface(material: MaterialId, thicknessMm: number, spanM = DAMAGE_TUNING.panelSpanM): Surface {
  const m = MATERIALS[material];
  const mode = m.failureMode ?? 'dent';
  if (mode === 'cushion' || !(thicknessMm > 0)) return solidSurface(material);
  const h = thicknessMm / 1000;
  const a = spanM / 2;
  const stiffness = plateStiffness((m.youngsGPa ?? 70) * 1e9, m.poisson ?? 0.33, h, a);
  const collapseN = collapseLoad(m.yieldMPa * 1e6, h);
  return { material, mode, thicknessM: h, radiusM: a, stiffness, collapseN, elasticJ: (collapseN * collapseN) / (2 * stiffness), sparks: m.sparks };
}

/** A solid striker (a fist block, a knuckle plate) or a cushion (a glove, a rubber sole): it never dents. */
export function solidSurface(material: MaterialId): Surface {
  const m = MATERIALS[material];
  const mode = m.failureMode ?? 'dent';
  const t = DAMAGE_TUNING;
  const stiffness = material === 'glove' ? t.gloveStiffness : material === 'rubber' ? t.soleStiffness : t.solidStiffness;
  return { material, mode: mode === 'cushion' ? 'cushion' : mode, thicknessM: 0, radiusM: 0, stiffness, collapseN: Infinity, elasticJ: Infinity, sparks: m.sparks };
}

/** Arena surfaces: immovable, soft (mat, padding, chain link). They never take damage. */
export function worldSurface(kind: 'canvas' | 'fence' | 'post', sparks = false): Surface {
  const t = DAMAGE_TUNING;
  const stiffness = kind === 'canvas' ? t.canvasStiffness : kind === 'fence' ? t.fenceStiffness : t.postStiffness;
  return { material: 'rubber', mode: 'cushion', thicknessM: 0, radiusM: 0, stiffness, collapseN: Infinity, elasticJ: Infinity, sparks };
}

/**
 * Share of a contact's absorbed work that goes into surface `a` (the rest into `b`). Two springs in
 * series under one force store energy in inverse proportion to their stiffness, so a hard fist on a
 * soft shell puts nearly all of it into the shell, and a glove keeps most of it.
 */
export function workShare(a: Surface, b: Surface): number {
  const ca = 1 / Math.max(1, a.stiffness);
  const cb = 1 / Math.max(1, b.stiffness);
  return ca / (ca + cb);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
