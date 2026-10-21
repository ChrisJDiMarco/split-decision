// What of a fighter touches the canvas (docs/design/balance-engine.md §8: "pushes past capture, to
// time the brace and see what touches first"). Scans MuJoCo's contact list for pairs of a canvas geom
// (world body) and one of the robot's own geoms, and names the parts. Feet do not count: a fall's
// first contact is the first part other than a sole to reach the canvas.
//
// Every element data.contact hands out is a heap copy that must be deleted (src/physics/control/contacts.ts).
import type { RobotRuntime, SimContext } from '../../src/physics/sim-context';

const FEET = new Set(['foot_l', 'foot_r']);

export class CanvasContacts {
  /** geom id → part id, for this robot's attached geoms. */
  private readonly partOf = new Map<number, string>();
  private readonly world: Set<number>;

  constructor(ctx: SimContext, private readonly r: RobotRuntime) {
    for (const [id, p] of r.parts) for (const g of p.geoms) this.partOf.set(g, id);
    const bodyOf = ctx.model.geom_bodyid as Int32Array;
    const n = ctx.model.ngeom as number;
    this.world = new Set<number>();
    for (let g = 0; g < n; g++) if (bodyOf[g] === 0) this.world.add(g);
  }

  /** Parts other than the feet touching the canvas now (empty: none). */
  nonFoot(ctx: SimContext): string[] {
    const data = ctx.data;
    const n = data.ncon as number;
    if (!n) return [];
    const out: string[] = [];
    const contacts = data.contact;
    try {
      for (let i = 0; i < n; i++) {
        const c = contacts.get(i);
        const g1 = c.geom1 as number, g2 = c.geom2 as number;
        c.delete();
        const mine = this.world.has(g1) ? g2 : this.world.has(g2) ? g1 : -1;
        if (mine < 0) continue;
        const part = this.partOf.get(mine);
        if (!part || FEET.has(part) || !this.r.parts.get(part)?.attached) continue;
        if (!out.includes(part)) out.push(part);
      }
    } finally {
      contacts.delete();
    }
    return out;
  }
}

/** The part class a first contact counts as (hands = fists and forearms). */
export function contactClass(part: string): 'head' | 'hand' | 'arm' | 'knee' | 'hip' | 'torso' | 'other' {
  if (part === 'head') return 'head';
  if (part.startsWith('fist') || part.startsWith('forearm') || part.startsWith('hand')) return 'hand';
  if (part.startsWith('upperarm')) return 'arm';
  if (part.startsWith('shin')) return 'knee';
  if (part.startsWith('thigh') || part === 'pelvis') return 'hip';
  if (part === 'torso') return 'torso';
  return 'other';
}
