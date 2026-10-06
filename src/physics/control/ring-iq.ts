// Ring IQ, the body's side (docs/design/ring-iq.md): distance and range from the strikes these two
// bodies actually throw. Jev decides at 2-4 Hz; the body manages range all the time.
//   my weapons    each usable strike's throw edge, lo + throwAt·(hi − lo) (where the body throws it
//                 without a step; tactics.ts walks in beyond it), COM to COM
//   his reach     the farthest his usable strikes land (their `hi`), from his own skills
//   zones         outside: beyond his reach (and beyond mine). edge: my longest weapon lands, his do
//                 not (only with the reach advantage). pocket: inside both, where the exchange is
//   standoff      the guards' touching range plus a little clearance: footwork never plans the
//                 stance inside it unless the intent is a clinch (strikes enter WITH the blow)
//   meeting       two fighters closing split the gap by their speeds (tactics.ts sharedRange), so
//                 neither plans the whole gap and they stop short of the guards together
// Refreshed at 2 Hz (ranges change only with damage); a cached read allocates nothing.
import { canUse } from './abilities';
import type { HumanoidController } from './controller';
import { isStrikeSkill, type SkillId } from './skills';

const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SD_RING_IQ;

/** Ring IQ's footwork rules on the balance engine (SD_RING_IQ=0 turns them off for A/B runs). */
export const RING_IQ = { enabled: ENV === '0' ? 0 : 1 };

/** Where in a strike's range the body throws it without a step (tactics.ts THROW_ZONE). */
export const THROW_AT = 0.85;
const GUARD_CLEARANCE_M = 0.08; // as tactics.ts GUARD_CLEARANCE_M: the stance stops this far short of the guards touching
const REFRESH_S = 0.5;

export type Zone = 'outside' | 'edge' | 'pocket';

export interface RingFacts {
  /** My longest weapon's throw edge (m, COM to COM). */
  myEdge: number;
  /** His longest reach (m): the farthest gap one of his usable strikes lands from. */
  hisReach: number;
  /** COM-to-COM range where the two guards touch, plus the clearance. */
  standoff: number;
  /** The edge zone exists: I out-reach him. */
  edge: boolean;
}

/** A controller's usable strikes: the longest throw edge, and the longest landing range. */
function weapons(c: HumanoidController): { edge: number; reach: number } {
  let edge = 0, reach = 0;
  for (const a of c.r.design.abilities) {
    const def = c.skillFor(a as SkillId);
    if (!def || !isStrikeSkill(def) || !canUse(c.r, def)) continue;
    const [lo, hi] = def.range(c.geo);
    edge = Math.max(edge, lo + (def.approach?.throwAt ?? THROW_AT) * (hi - lo));
    reach = Math.max(reach, hi);
  }
  return { edge, reach };
}

export class RingIq {
  readonly facts: RingFacts = { myEdge: 0, hisReach: 0, standoff: 0, edge: false };
  private at = -Infinity;

  constructor(private readonly c: HumanoidController) {}

  /** The facts, refreshed at most every REFRESH_S (damage can take a weapon away). */
  read(time: number): RingFacts {
    if (time - this.at < REFRESH_S) return this.facts;
    this.at = time;
    const f = this.facts;
    const me = weapons(this.c);
    const opp = this.c.opp?.robot.mem.control as HumanoidController | undefined;
    const him = opp ? weapons(opp) : { edge: 0, reach: me.reach };
    f.myEdge = me.edge;
    f.hisReach = him.reach;
    const mine = this.c.guardReach();
    f.standoff = mine + (opp?.guardReach ? opp.guardReach() : mine) + GUARD_CLEARANCE_M;
    f.edge = me.edge > him.reach + 0.02;
    return f;
  }

  /** The zone at COM-to-COM distance d. */
  static zoneAt(f: RingFacts, d: number): Zone {
    if (d <= Math.min(f.myEdge, f.hisReach)) return 'pocket';
    if (f.edge && d <= f.myEdge) return 'edge';
    return 'outside';
  }

  /**
   * Where an approach stops before the entry (COM to COM): inside the edge zone when there is one
   * (my longest weapon lands from there, his do not), else just outside his reach. Never inside the
   * guards' standoff.
   */
  static approachRange(f: RingFacts): number {
    const outside = f.hisReach + 0.05;
    const d = f.edge ? Math.min(f.myEdge - 0.02, Math.max(f.hisReach + 0.03, (f.hisReach + f.myEdge) / 2)) : outside;
    return Math.max(d, f.standoff + 0.02);
  }
}
