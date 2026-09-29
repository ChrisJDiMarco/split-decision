// One source of truth for cage geometry, used by physics colliders and the renderer.
// Proportions follow a real MMA cage (docs/research/06-arena.md): ~4.3x fighter height
// across the flats, fence ~1x fighter height, vinyl-coated chain link, padded posts,
// a raised platform. SIDES is a parameter: 8 for Chris's local demo, 10 ("the Kiln")
// before anything goes public, because the octagon cage shape is a registered mark.

export const ARENA = {
  SIDES: 8,
  ACROSS_FLATS_M: 8.5, // interior, flat to flat
  FENCE_HEIGHT_M: 1.9, // canvas to top rail
  POST_RADIUS_M: 0.09,
  POST_PAD_RADIUS_M: 0.16,
  TOP_PAD_RADIUS_M: 0.08,
  PLATFORM_HEIGHT_M: 1.2, // canvas above the arena floor (render only)
  APRON_M: 1.2, // walkway outside the fence
  CANVAS_FRICTION: 0.9,
  FENCE_THICKNESS_M: 0.04,
  SPAWN_OFFSET_M: 2.1, // each robot starts this far from the center
} as const;

/** Inradius (center to the middle of a side). */
export const APOTHEM = ARENA.ACROSS_FLATS_M / 2;
/** Circumradius (center to a post). */
export const CIRCUMRADIUS = APOTHEM / Math.cos(Math.PI / ARENA.SIDES);

/** Post positions, starting on the +x axis rotated half a side so a flat faces each corner. */
export function postPositions(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 0.5) / ARENA.SIDES) * Math.PI * 2;
    out.push([Math.cos(a) * CIRCUMRADIUS, Math.sin(a) * CIRCUMRADIUS]);
  }
  return out;
}

/** Side panels: center, yaw (outward normal angle) and length. */
export function panels(): Array<{ center: [number, number]; normalAngle: number; length: number }> {
  const out: Array<{ center: [number, number]; normalAngle: number; length: number }> = [];
  const length = 2 * APOTHEM * Math.tan(Math.PI / ARENA.SIDES);
  for (let i = 0; i < ARENA.SIDES; i++) {
    const a = ((i + 1) / ARENA.SIDES) * Math.PI * 2;
    out.push({ center: [Math.cos(a) * APOTHEM, Math.sin(a) * APOTHEM], normalAngle: a, length });
  }
  return out;
}
