// Display metadata for skins and fighters (swatches, portraits). The robot kit owns the
// real materials; these are only the broadcast's chips and labels.
import type { SkinId } from '../core/types';

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
};

export const SKIN_ORDER: SkinId[] = ['factory', 'chrome', 'military', 'racing', 'scrapyard', 'neon'];

/** Concept-art portraits shipped with the broadcast module, by design id. */
const PORTRAITS = new Set(['bruiser', 'anvil', 'jackal', 'buzzsaw', 'striker', 'goliath']);

export function portraitUrl(designId: string): string | null {
  return PORTRAITS.has(designId) ? `/assets/broadcast/portraits/${designId}.jpg` : null;
}

export const CORNER_NAMES = ['RED CORNER', 'BLUE CORNER'] as const;
