// Display metadata for skins and fighters (swatches, portraits). The robot kit owns the
// real materials; these are only the broadcast's chips and labels.
import type { RobotDesign, SkinId } from '../core/types';

export interface SkinSwatch {
  id: SkinId;
  name: string;
  base: string; // dominant paint
  accent: string; // stripe / trim / glow
}

export const SKIN_SWATCHES: Record<SkinId, SkinSwatch> = {
  factory: { id: 'factory', name: 'Factory', base: '#2c2e33', accent: '#f2c21b' },
  chrome: { id: 'chrome', name: 'Chrome', base: '#c8cdd4', accent: '#5f656e' },
  military: { id: 'military', name: 'Military', base: '#58623e', accent: '#d8d2b0' },
  racing: { id: 'racing', name: 'Racing', base: '#a3141f', accent: '#f4f1ea' },
  scrapyard: { id: 'scrapyard', name: 'Scrapyard', base: '#8a5634', accent: '#7c8a8d' },
  neon: { id: 'neon', name: 'Neon', base: '#131518', accent: '#22e6ff' },
  // The design's own paint scheme. These colours are only the fallback for designs without a palette.
  livery: { id: 'livery', name: 'Livery', base: '#3a3d44', accent: '#e8e2d4' },
};

export const SKIN_ORDER: SkinId[] = ['livery', 'factory', 'chrome', 'military', 'racing', 'scrapyard', 'neon'];

/** Chip colours for a skin on a given design: the livery chip shows that design's own palette. */
export function swatchFor(skin: SkinId, design?: RobotDesign): SkinSwatch {
  const base = SKIN_SWATCHES[skin] ?? SKIN_SWATCHES.factory;
  if (skin !== 'livery' || !design?.palette) return base;
  return { ...base, base: design.palette.primary, accent: design.palette.accent };
}

/** Concept-art portraits shipped with the broadcast module, by design id. */
const PORTRAITS = new Set(['firecracker', 'savate', 'haymaker', 'pylon', 'bruiser', 'anvil', 'jackal', 'buzzsaw', 'striker', 'goliath']);

export function portraitUrl(designId: string): string | null {
  return PORTRAITS.has(designId) ? `/assets/broadcast/portraits/${designId}.jpg` : null;
}

export const CORNER_NAMES = ['RED CORNER', 'BLUE CORNER'] as const;
