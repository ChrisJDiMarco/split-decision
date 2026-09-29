// Loadouts: a design plus slot choices, applied to the design before it compiles
// (docs/design/loadouts-and-workshop.md). applyLoadout is pure: it never touches the design it is
// given, and a stock loadout (or none) returns that exact design object, so every design fights
// with byte-identical MJCF unless something was actually swapped.
//
// Hands slot:
//   stock      the design as built
//   glove      padded boxing gloves over the bare hand (a cushioned striker, CUSHION_MATERIALS)
//   knuckle    bare fists behind 6 mm AR500 knuckle plates
//   dexterous  a tendon-driven five-finger hand (src/robots/hands.ts): one grip drive, ten joints
// A choice the design already wears is stock (FIRECRACKER and HAYMAKER are gloved, the others bare).
import type { GeomDef, HandsOption, Loadout, PartDef, RobotDesign, WeightClass } from '../core/types';
import { MATERIALS } from './catalog';
import { geomVolume } from './compile-mjcf';
import { digitParts, gripTendonDef, palmPart } from './hands';

export const HANDS_OPTIONS: readonly HandsOption[] = ['stock', 'glove', 'knuckle', 'dexterous'];

export const HANDS_LABEL: Record<HandsOption, string> = {
  stock: 'STOCK',
  glove: 'GLOVES',
  knuckle: 'KNUCKLE PLATES',
  dexterous: 'DEXTEROUS',
};

/** Glove sizes (the WHRG-style classes wear what their boxers would). */
const GLOVE_OZ: Record<WeightClass, number> = { bantam: 8, middle: 10, heavy: 16, open: 16 };
const OUNCE_KG = 0.02835;
/** Same as humanoid.ts: a glove is this much bigger than the bare fist block it covers. */
const GLOVE_SIZE_X_FIST = 1.18;
/** Hollow aluminium hand (solid share), as the modern shells use (humanoid.ts handFill). */
const HAND_FILL = 0.14;
const KNUCKLE_PLATE_M = 0.006;
const DEFAULT_GLOVE_COLOR = '#9e1a1f';

const SIDES = ['l', 'r'] as const;

export function stockLoadout(designId: string): Loadout {
  return { design: designId, hands: 'stock' };
}

export function isStock(loadout: Loadout | undefined): boolean {
  return !loadout || loadout.hands === 'stock';
}

/** What the design's hands are when built: 'glove' or 'knuckle' (bare AR500-faced fists). */
export function stockHands(design: RobotDesign): Exclude<HandsOption, 'stock' | 'dexterous'> {
  const fist = design.parts.find((p) => p.id === 'fist_l');
  return fist?.geoms[0]?.material === 'glove' ? 'glove' : 'knuckle';
}

/** The hands a loadout actually fits (stock resolved to what the design wears). */
export function effectiveHands(design: RobotDesign, loadout: Loadout | undefined): Exclude<HandsOption, 'stock'> {
  const h = loadout?.hands ?? 'stock';
  return h === 'stock' ? stockHands(design) : h;
}

/** Readable hands for the tale of the tape, e.g. 'GLOVES 10 OZ', 'DEXTEROUS · 5 FINGERS'. */
export function handsLabel(design: RobotDesign): string {
  const fist = design.parts.find((p) => p.id === 'fist_l');
  if (design.parts.some((p) => p.tags.includes('finger'))) return 'DEXTEROUS · 5 FINGERS';
  if (fist?.geoms[0]?.material === 'glove') return 'GLOVES';
  return 'KNUCKLE PLATES';
}

/** Half-size of the bare fist block (the glove box is 1.18× it). */
function bareFistHalf(fist: PartDef): number {
  const g = fist.geoms[0];
  if (g.shape.type !== 'box') throw new Error(`${fist.id}: fist has no box striker`);
  const h = g.shape.halfSize[0];
  return g.material === 'glove' ? h / GLOVE_SIZE_X_FIST : h;
}

const bareBlock = (h: number): GeomDef => ({ shape: { type: 'box', halfSize: [h, h * 0.9, h] }, material: 'ar500', role: 'striker' });

/** The aluminium hand inside a glove or behind a knuckle plate. */
function handKg(h: number): number {
  return geomVolume(bareBlock(h)) * MATERIALS.al7075.densityKgM3 * HAND_FILL;
}

function knucklePlateKg(h: number): number {
  return 4 * h * (h * 0.9) * KNUCKLE_PLATE_M * MATERIALS.ar500.densityKgM3;
}

function isModern(design: RobotDesign): boolean {
  return design.era === 'modern';
}

function gloveFist(design: RobotDesign, fist: PartDef): PartDef {
  const h = bareFistHalf(fist);
  const g = h * GLOVE_SIZE_X_FIST;
  const oz = GLOVE_OZ[design.weightClass ?? 'open'];
  // An iron-age hand is the builder's AR500 block as weighed; a modern one is the hollow hand.
  const hand = isModern(design) ? handKg(h) : fist.geoms[0].massKg ?? geomVolume(bareBlock(h)) * MATERIALS.ar500.densityKgM3 * HAND_FILL;
  const glove: GeomDef = { shape: { type: 'box', halfSize: [g, g * 0.9, g] }, material: 'glove', role: 'striker', massKg: hand + oz * OUNCE_KG };
  return { ...fist, geoms: [glove], visual: { kit: 'fist.glove', params: { color: gloveColor(design) } } };
}

function knuckleFist(design: RobotDesign, fist: PartDef): PartDef {
  const h = bareFistHalf(fist);
  return { ...fist, geoms: [{ ...bareBlock(h), massKg: handKg(h) + knucklePlateKg(h) }], visual: { kit: isModern(design) ? 'fist.knuckle' : 'fist.block' } };
}

export function gloveColor(design: RobotDesign): string {
  return design.gloves?.color ?? design.palette?.primary ?? DEFAULT_GLOVE_COLOR;
}

function withHands(design: RobotDesign, hands: Exclude<HandsOption, 'stock'>): RobotDesign {
  const fistIds = new Set(SIDES.map((s) => `fist_${s}`));
  const extra: PartDef[] = [];
  const parts = design.parts.map((p) => {
    if (!fistIds.has(p.id)) return p;
    if (hands === 'glove') return gloveFist(design, p);
    if (hands === 'knuckle') return knuckleFist(design, p);
    const side = p.id.endsWith('_l') ? 'l' : 'r';
    const h = bareFistHalf(p);
    extra.push(...digitParts(p.id, side, h));
    return palmPart(p, h);
  });
  const { gloves: _gloves, ...rest } = design;
  void _gloves;
  const base: RobotDesign = hands === 'glove' ? { ...design, gloves: { color: gloveColor(design) } } : rest;
  return {
    ...base,
    parts: [...parts, ...extra],
    ...(hands === 'dexterous' ? { tendons: [...(design.tendons ?? []), ...SIDES.map(gripTendonDef)] } : {}),
  };
}

/** Ancestors of the fists that detach must stay rigid (a detached part is one rigid body). */
function fistsUnderDetachable(design: RobotDesign): boolean {
  const byId = new Map(design.parts.map((p) => [p.id, p]));
  for (const s of SIDES) {
    for (let p = byId.get(`fist_${s}`); p; p = p.parent ? byId.get(p.parent) : undefined) if (p.detachable) return true;
  }
  return false;
}

/**
 * The design as this loadout builds it. Pure; stock (or no loadout, or a choice the design already
 * wears) returns `design` itself. Throws if the loadout is for another design, or if the design has
 * no humanoid fists to swap.
 */
export function applyLoadout(design: RobotDesign, loadout: Loadout | undefined): RobotDesign {
  if (!loadout) return design;
  if (loadout.design !== design.id) throw new Error(`loadout for '${loadout.design}' applied to '${design.id}'`);
  if (loadout.hands === 'stock') return design;
  const hands = loadout.hands;
  if (hands !== 'dexterous' && hands === stockHands(design)) return design;
  if (!SIDES.every((s) => design.parts.some((p) => p.id === `fist_${s}`))) throw new Error(`${design.id}: no fists for a hands loadout`);
  if (hands === 'dexterous' && fistsUnderDetachable(design)) throw new Error(`${design.id}: dexterous fingers cannot ride on a detachable limb`);
  return { ...withHands(design, hands), loadout: { ...loadout } };
}
