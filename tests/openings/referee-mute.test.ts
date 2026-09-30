// Openings during a referee break (src/physics/openings/index.ts refereeMute): a man down or rising
// is no target, so nothing is seen on him and 'rising' never shows; outside a break nothing changes.
import { describe, expect, it } from 'vitest';
import type { Opening } from '../../src/core/protocol';
import { refereeMute } from '../../src/physics/openings';
import type { SimContext } from '../../src/physics/sim-context';
import { newRefereeState } from '../../src/physics/systems/referee';

const SEEN: Opening[] = ['rising', 'on_cage', 'weak_left_leg', 'gyro_saturated'];

function ctxWith(active: boolean, roles: Array<'down' | 'neutral' | 'hold' | null>): SimContext {
  return { referee: { ...newRefereeState(), active, roles } } as unknown as SimContext;
}

describe('refereeMute', () => {
  it('passes openings through unchanged outside a break', () => {
    expect(refereeMute({} as SimContext, 1, SEEN)).toBe(SEEN);
    expect(refereeMute(ctxWith(false, [null, null]), 1, SEEN)).toBe(SEEN);
  });

  it('mutes every opening on a fighter who is down or rising during a break', () => {
    expect(refereeMute(ctxWith(true, ['neutral', 'down']), 1, SEEN)).toEqual([]);
  });

  it('never shows rising during a break, even on a fighter the referee already counts as up', () => {
    expect(refereeMute(ctxWith(true, ['neutral', 'hold']), 1, SEEN)).toEqual(['on_cage', 'weak_left_leg', 'gyro_saturated']);
    expect(refereeMute(ctxWith(true, ['down', 'neutral']), 1, ['turned_away'])).toEqual(['turned_away']);
  });
});
