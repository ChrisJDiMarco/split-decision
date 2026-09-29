// The six paint jobs from docs/concept-art/08-skins.png, as parameters for the kit material.
// Colours are sRGB hex; the material converts them to linear.
import type { SkinId } from '../../../core/types';

/** How accent plates are decorated. */
export const ACCENT = { HAZARD: 0, RACING: 1, SOLID: 2, PATCH: 3, GLOSS: 4 } as const;

export interface SurfaceLayer {
  color: string;
  metal: number;
  rough: number;
}

export interface SkinParams {
  id: SkinId;
  name: string;
  paint: SurfaceLayer;
  paintAlt: string[]; // patchwork plate colours (scrapyard); empty = single colour
  colorVar: number; // large-scale colour variation
  clearcoat: number;
  clearcoatRough: number;
  accentMode: number;
  accentA: string;
  accentB: string;
  frame: SurfaceLayer;
  mech: SurfaceLayer;
  bare: string; // metal under chipped paint
  primer: string; // thin rim around chips
  wear: number; // edge chipping 0..1
  scratches: number;
  grime: number;
  grimeColor: string;
  dust: number; // canvas dust on the lowest parts
  dustColor: string;
  rust: number;
  carbon: number; // carbon-fibre weave strength
  neon: string; // edge light colour
  neonIntensity: number;
  decalFill: string;
  decalLine: string;
  decalOpacity: number;
  decalFont: 'stencil' | 'racing' | 'block' | 'tech';
  number: string; // big decal number
  label: string; // secondary label
}

export const SKINS: Record<SkinId, SkinParams> = {
  factory: {
    id: 'factory', name: 'Factory',
    paint: { color: '#4b5057', metal: 0.4, rough: 0.44 },
    paintAlt: [], colorVar: 0.1, clearcoat: 0, clearcoatRough: 0.3,
    accentMode: ACCENT.HAZARD, accentA: '#e8b10c', accentB: '#121212',
    frame: { color: '#1d1f22', metal: 0.8, rough: 0.46 },
    mech: { color: '#8b9096', metal: 0.95, rough: 0.34 },
    bare: '#9b9fa4', primer: '#1c1e21',
    wear: 0.55, scratches: 0.5, grime: 0.5, grimeColor: '#16130f',
    dust: 0.35, dustColor: '#6f675a',
    rust: 0, carbon: 0, neon: '#000000', neonIntensity: 0,
    decalFill: '#e8b10c', decalLine: '#111111', decalOpacity: 0.9, decalFont: 'block',
    number: 'B-01', label: 'CAUTION',
  },
  chrome: {
    id: 'chrome', name: 'Chrome',
    paint: { color: '#dfe3e8', metal: 1, rough: 0.11 },
    paintAlt: [], colorVar: 0.03, clearcoat: 0, clearcoatRough: 0.1,
    accentMode: ACCENT.SOLID, accentA: '#5b6068', accentB: '#5b6068',
    frame: { color: '#9aa1a8', metal: 1, rough: 0.2 },
    mech: { color: '#c8ccd0', metal: 1, rough: 0.16 },
    bare: '#f0f2f4', primer: '#6d7278',
    wear: 0.1, scratches: 0.45, grime: 0.18, grimeColor: '#2a2622',
    dust: 0.15, dustColor: '#8a8174',
    rust: 0, carbon: 0, neon: '#000000', neonIntensity: 0,
    decalFill: '#2b2e33', decalLine: '#2b2e33', decalOpacity: 0.55, decalFont: 'tech',
    number: 'C-7', label: 'MIRROR',
  },
  military: {
    id: 'military', name: 'Military',
    paint: { color: '#56613a', metal: 0.05, rough: 0.72 },
    paintAlt: [], colorVar: 0.12, clearcoat: 0, clearcoatRough: 0.5,
    accentMode: ACCENT.SOLID, accentA: '#4a5332', accentB: '#4a5332',
    frame: { color: '#2b2f24', metal: 0.55, rough: 0.6 },
    mech: { color: '#6f7268', metal: 0.85, rough: 0.45 },
    bare: '#9a9b94', primer: '#3a3f2a',
    wear: 0.6, scratches: 0.45, grime: 0.6, grimeColor: '#3b3326',
    dust: 0.6, dustColor: '#8c7b5c',
    rust: 0.08, carbon: 0, neon: '#000000', neonIntensity: 0,
    decalFill: '#d9d4b8', decalLine: '#d9d4b8', decalOpacity: 0.85, decalFont: 'stencil',
    number: '03', label: 'UNIT 03',
  },
  racing: {
    id: 'racing', name: 'Racing',
    paint: { color: '#8e0c14', metal: 0.35, rough: 0.28 },
    paintAlt: [], colorVar: 0.06, clearcoat: 1, clearcoatRough: 0.04,
    accentMode: ACCENT.RACING, accentA: '#f4f4f2', accentB: '#8e0c14',
    frame: { color: '#141416', metal: 0.6, rough: 0.35 },
    mech: { color: '#7c8188', metal: 0.95, rough: 0.28 },
    bare: '#c8c8c8', primer: '#e8e4dc',
    wear: 0.25, scratches: 0.3, grime: 0.22, grimeColor: '#1a1512',
    dust: 0.2, dustColor: '#6f675a',
    rust: 0, carbon: 0, neon: '#000000', neonIntensity: 0,
    decalFill: '#f4f4f2', decalLine: '#0b0b0c', decalOpacity: 1, decalFont: 'racing',
    number: '09', label: 'SPLIT·DEC',
  },
  scrapyard: {
    id: 'scrapyard', name: 'Scrapyard',
    paint: { color: '#6b4128', metal: 0.3, rough: 0.78 },
    paintAlt: ['#6f7b80', '#8a8a7e', '#4d5a58', '#7a5436'], colorVar: 0.18, clearcoat: 0, clearcoatRough: 0.5,
    accentMode: ACCENT.PATCH, accentA: '#8c8c82', accentB: '#5a6468',
    frame: { color: '#2e2622', metal: 0.6, rough: 0.72 },
    mech: { color: '#6e6660', metal: 0.8, rough: 0.55 },
    bare: '#a09a92', primer: '#5a3520',
    wear: 0.85, scratches: 0.7, grime: 0.8, grimeColor: '#231a12',
    dust: 0.7, dustColor: '#7a6348',
    rust: 0.48, carbon: 0, neon: '#000000', neonIntensity: 0,
    decalFill: '#d8cfb8', decalLine: '#d8cfb8', decalOpacity: 0.55, decalFont: 'stencil',
    number: '17', label: 'SALVAGE',
  },
  neon: {
    id: 'neon', name: 'Neon',
    paint: { color: '#101114', metal: 0.25, rough: 0.34 },
    paintAlt: [], colorVar: 0.04, clearcoat: 0.9, clearcoatRough: 0.08,
    accentMode: ACCENT.GLOSS, accentA: '#07080a', accentB: '#07080a',
    frame: { color: '#0b0c0e', metal: 0.7, rough: 0.4 },
    mech: { color: '#3a3e44', metal: 0.95, rough: 0.3 },
    bare: '#6a7078', primer: '#1a1c20',
    wear: 0.15, scratches: 0.25, grime: 0.15, grimeColor: '#050506',
    dust: 0.12, dustColor: '#4a4640',
    rust: 0, carbon: 1, neon: '#19e6ff', neonIntensity: 2.4,
    decalFill: '#19e6ff', decalLine: '#19e6ff', decalOpacity: 0.9, decalFont: 'tech',
    number: 'N-7', label: 'VOLTAGE',
  },
};

export const SKIN_IDS: readonly SkinId[] = ['factory', 'chrome', 'military', 'racing', 'scrapyard', 'neon'];

export function skinParams(id: SkinId): SkinParams {
  const s = SKINS[id];
  if (!s) throw new Error(`Unknown skin '${id}'`);
  return s;
}
