// What the kit needs to know about a design's look beyond its part recipes: the livery palette,
// the glove colour, race number and decal font, and which limb style dresses the generic
// arm / leg / pelvis recipes. Palette and gloves come from the design (src/core/types.ts); the
// render-only details live here, keyed by design id.
import type { DesignPalette, RobotDesign } from '../../core/types';

/** Limb families: the iron-age plated styles, and one per modern electric fighter. */
export type LimbStyle = 'iron' | 'pebble' | 'blade' | 'slab' | 'hivis';

export interface DesignLook {
  palette: DesignPalette | null;
  glove: string | null; // glove / headgear colour, null = bare fists
  limbs: LimbStyle;
  number: string; // race number decal
  font: 'stencil' | 'racing' | 'block' | 'tech';
  /** Actuator housings in the livery (graphite cans, black drums). */
  mech: string;
  decal?: string; // race-number colour in the livery
  cuff: 'trim' | 'glove'; // glove cuffs in the accent (white cuffs) or the glove colour
  eyeGain: number; // optics brightness: saturated eye colours need less to stay coloured
}

interface RenderLook {
  limbs: LimbStyle;
  number: string;
  font: DesignLook['font'];
  mech: string;
  decal?: string;
  cuff?: 'trim' | 'glove';
  eyeGain?: number;
  /** Used only if the design itself carries no palette (keeps the kit working mid-integration). */
  palette: DesignPalette;
  glove?: string;
}

const MODERN: Record<string, RenderLook> = {
  firecracker: {
    limbs: 'pebble', number: '07', font: 'racing', mech: '#232220', decal: '#fff1dc', cuff: 'trim', eyeGain: 0.6,
    palette: { primary: '#f26b1d', secondary: '#2a2826', accent: '#fff1dc', finish: 'gloss' }, glove: '#b3141c',
  },
  savate: {
    limbs: 'blade', number: '21', font: 'tech', mech: '#26262a', decal: '#e9e2d0', eyeGain: 0.55,
    palette: { primary: '#3d1f4f', secondary: '#b9bcc0', accent: '#e9e2d0', finish: 'satin' },
  },
  haymaker: {
    limbs: 'slab', number: '44', font: 'stencil', mech: '#101112', decal: '#d9d4b8', eyeGain: 0.7,
    palette: { primary: '#56613a', secondary: '#141516', accent: '#ff4d1a', finish: 'matte' }, glove: '#1f3f9e',
  },
  pylon: {
    limbs: 'hivis', number: '11', font: 'block', mech: '#2b2d31', decal: '#1c1d1f', eyeGain: 0.55,
    palette: { primary: '#c6f000', secondary: '#1c1d1f', accent: '#c9ccd1', finish: 'satin' },
  },
};

/** The kit's view of a design's look. Iron-age designs get the plated styles and no palette. */
export function designLook(design: RobotDesign): DesignLook {
  const r = MODERN[design.id];
  const palette = design.palette ?? r?.palette ?? null;
  const glove = design.gloves?.color ?? r?.glove ?? null;
  return {
    palette,
    glove,
    limbs: r?.limbs ?? 'iron',
    number: r?.number ?? '',
    font: r?.font ?? 'block',
    mech: r?.mech ?? '#2a2b2e',
    decal: r?.decal,
    cuff: r?.cuff ?? 'glove',
    eyeGain: r?.eyeGain ?? 1,
  };
}

export function isModern(design: RobotDesign): boolean {
  return designLook(design).limbs !== 'iron';
}
