// The 20 s down count (URKL rule, src/physics/damage/ko.ts) across failed rises: it runs on the canvas
// and while rising, pauses once he is off the canvas, and resets only after a real get-up (up and
// steady for KO_UP_STEADY_S, or up and upright for KO_UP_ANY_S). Before, a rise that fell back
// restarted the count and one knockdown ran 34.6 s without a KO.
import { describe, expect, it } from 'vitest';
import { KO_DOWN_S } from '../../src/physics/damage/constants';
import { KO_UP_ANY_S, KO_UP_STEADY_S } from '../../src/physics/damage/ko';
import type { SimContext } from '../../src/physics/sim-context';
import { drain, makeRig, ofKind, step } from './helpers';

const LONG_SIM_TIMEOUT_MS = 60_000;

/** A stand-in controller on robot 0 (the rig runs no control): rising and steadiness set by the test. */
function rigWithBody() {
  const ctx = makeRig();
  ctx.released = true;
  const body = { rising: false, ready: true };
  const r = ctx.robots[0];
  r.mem.control = { getUp: { active: false }, get rising() { return body.rising; }, readyToStrike: () => body.ready } as unknown as typeof r.mem.control;
  return { ctx, r, body };
}

const secs = (ctx: SimContext, s: number) => step(ctx, Math.round(s / ctx.dt));
const kos = (ctx: SimContext) => ofKind(drain(ctx), 'ko').filter((e) => e.corner === 0);

describe('KO down count', () => {
  it('a failed rise that falls back does not restart the count', () => {
    const { ctx, r, body } = rigWithBody();
    r.down = true;
    secs(ctx, 12);
    r.down = false; // the get-up finished, rising out of the crouch...
    body.rising = true;
    secs(ctx, 3);
    body.rising = false; // ...and back on the canvas before he ever stood
    r.down = true;
    secs(ctx, KO_DOWN_S - 12 - 3 - 0.5);
    expect(kos(ctx)).toHaveLength(0);
    secs(ctx, 1);
    expect(kos(ctx)).toEqual([{ kind: 'ko', corner: 0, reason: 'down' }]);
  }, LONG_SIM_TIMEOUT_MS);

  it('up but not yet steady pauses the count; a fall then carries on from it', () => {
    const { ctx, r, body } = rigWithBody();
    r.down = true;
    secs(ctx, 15);
    r.down = false;
    body.ready = false; // standing, swaying, never balanced enough to strike
    secs(ctx, KO_UP_ANY_S - 0.5);
    r.down = true;
    secs(ctx, 4.5);
    expect(kos(ctx)).toHaveLength(0); // 19.5 s counted: the time on his feet did not count
    secs(ctx, 1);
    expect(kos(ctx)).toEqual([{ kind: 'ko', corner: 0, reason: 'down' }]);
  }, LONG_SIM_TIMEOUT_MS);

  it('a real get-up (up and steady) resets it: the next knockdown gets its own 20 s', () => {
    const { ctx, r } = rigWithBody();
    r.down = true;
    secs(ctx, 15);
    r.down = false;
    secs(ctx, KO_UP_STEADY_S + 0.2);
    r.down = true;
    secs(ctx, KO_DOWN_S - 0.5);
    expect(kos(ctx)).toHaveLength(0);
    secs(ctx, 1);
    expect(kos(ctx)).toEqual([{ kind: 'ko', corner: 0, reason: 'down' }]);
  }, LONG_SIM_TIMEOUT_MS);
});
