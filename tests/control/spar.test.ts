// Sparring: two fighters driven by sparringIntent for 60 s. The simulation must stay finite and
// the fight must be real: at least MIN_LANDED clean strikes landed between the two of them.
import { describe, expect, it } from 'vitest';
import { controllerOf, sparringIntent } from '../../src/physics/control';
import { isFinite, makeSim } from './helpers';

const SPAR_S = 60;
const MIN_LANDED = 10;
const INTENT_EVERY_S = 0.4; // how often the stand-in brain re-decides
const FINITE_CHECK_STEPS = 100;
const PAIRS: ReadonlyArray<[string, string, number]> = [['striker', 'bruiser', 1], ['goliath', 'striker', 2], ['bruiser', 'goliath', 3]];

describe('sparring', () => {
  for (const [a, b, seed] of PAIRS) {
    it(`${a} vs ${b}: ${SPAR_S} s, finite, >= ${MIN_LANDED} strikes landed`, async () => {
      const sim = await makeSim({ design: a, x: -1, y: 0, yaw: 0 }, { design: b, x: 1, y: 0, yaw: Math.PI }, { seed });
      const { ctx } = sim;
      sim.seconds(0.5);
      sim.release(0);
      sim.release(1);
      let next = 0;
      let finite = true;
      const falls = [0, 0];
      sim.seconds(SPAR_S, () => {
        if (ctx.time >= next) {
          next = ctx.time + INTENT_EVERY_S;
          for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
        }
        for (const e of ctx.events) if (e.kind === 'fall') falls[e.corner]++;
        ctx.events.length = 0;
        if (ctx.tick % FINITE_CHECK_STEPS === 0 && !isFinite(ctx)) finite = false;
      });
      const stats = ctx.robots.map((r) => controllerOf(r)!.skills.stats);
      const landed = stats[0].landed + stats[1].landed;
      console.log(`${a} vs ${b}: landed ${landed} (${stats[0].landed}/${stats[0].thrown}, ${stats[1].landed}/${stats[1].thrown}), falls ${falls.join('/')}`);
      expect(finite).toBe(true);
      expect(isFinite(ctx)).toBe(true);
      expect(landed).toBeGreaterThanOrEqual(MIN_LANDED);
      sim.dispose();
    }, 600_000);
  }
});
